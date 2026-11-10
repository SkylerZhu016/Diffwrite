import {DatabaseSync} from 'node:sqlite';
import {randomUUID,randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {restoreDraft,createDraft,original,revised,modified,deleted,reviewMark,hasReviewMark,effectiveOpinion,mergeDraftEdits,
  withoutEditedAiMarks,setAiMarks,opinionParts,joinOpinion} from './model.mjs';
import {defaultOpinionPrompt,normalizeOpinionSettings} from './opinion-ai.mjs';
import {looksLikeMarkdown,markdownSpans} from './markdown.mjs';

export class StoreError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
const encode=JSON.stringify, decode=JSON.parse;
const reject=(msg,status)=>{throw new StoreError(msg,status);};
const note=(draft,i)=>draft.notes[i] ?? {opinion:'',revision:''};
const noteChanged=(before,after)=>encode(before) !== encode(after);
const humanMarks=draft=>Boolean(draft.omittedGaps?.length)||Object.entries(draft.notes).some(([i,n])=>n.opinion.trim() || modified(draft,Number(i)));
const idPattern=/^[a-zA-Z0-9_-]{1,100}$/;
const validId=id=>typeof id==='string' && idPattern.test(id);
const digest=value=>createHash('sha256').update(value).digest();
const originalConnection='original';
const blankMark={opinion:'',revision:''};
const sameBody=(a,b)=>a.revision===b.revision&&Boolean(a.deleted)===Boolean(b.deleted);
const ensureDraft=raw=>{
  try{return restoreDraft(raw);}catch{reject('稿件或分句数据无效。');}
};
const textOf=(raw,max)=>{
  if(typeof raw!=='string'||raw.length>max||!raw.trim()) reject('稿件标题或正文无效。');
  return raw;
};

export function openStore(location=process.env.DIFFWRITE_REVIEW_DATA ||
  join(process.env.LOCALAPPDATA || homedir(),'Diffwrite')) {
  mkdirSync(location,{recursive:true});
  const db=new DatabaseSync(join(location,'review.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, meta TEXT NOT NULL, draft TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review_baselines(recipient TEXT NOT NULL,draft_id TEXT NOT NULL REFERENCES drafts(id),
      snapshot TEXT NOT NULL,PRIMARY KEY(recipient,draft_id));
    CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id),
      created_at INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, notes TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS notices_by_draft ON notices(draft_id,created_at);
    CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY,name TEXT NOT NULL,
      token_hash TEXT UNIQUE,envelope TEXT,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS opinion_runs(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES drafts(id),
      sentence INTEGER NOT NULL,state TEXT NOT NULL,input TEXT NOT NULL,suffix TEXT NOT NULL,model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,created_at INTEGER NOT NULL,outcome TEXT);
    CREATE INDEX IF NOT EXISTS opinion_runs_by_draft ON opinion_runs(draft_id,sentence);
    CREATE TABLE IF NOT EXISTS opinion_prompts(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_edits(draft_id TEXT NOT NULL REFERENCES drafts(id),revision INTEGER NOT NULL,
      payload TEXT NOT NULL,PRIMARY KEY(draft_id,revision));
    CREATE TABLE IF NOT EXISTS prompt_history(id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS purged_drafts(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL);
  `);
  const q=sql=>db.prepare(sql);
  function atomic(fn){
    db.exec('BEGIN IMMEDIATE');
    try{const value=fn();db.exec('COMMIT');return value;}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  atomic(()=>{
    if(!q('PRAGMA table_info(notices)').all().some(column=>column.name==='recipient')){
      db.exec("ALTER TABLE notices ADD COLUMN recipient TEXT NOT NULL DEFAULT 'original'");
    }
    db.exec('CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices(recipient,draft_id)');
    const legacy=q("SELECT value FROM settings WHERE key='mcp-token'").get();
    if(legacy){
      const envelope=q("SELECT value FROM settings WHERE key='mcp-token-copy'").get()?.value??null;
      q('INSERT OR IGNORE INTO mcp_connections(id,name,token_hash,envelope) VALUES(?,?,?,?)')
        .run(originalConnection,'原连接',legacy.value,envelope);
      q("DELETE FROM settings WHERE key IN ('mcp-token','mcp-token-copy')").run();
    }
  });
  function read(id,includeDeleted=false){
    if(!validId(id))return null;
    const row=q('SELECT meta,draft FROM drafts WHERE id=?').get(id);
    if(!row)return null;
    const meta=decode(row.meta);
    return meta.trashedAt&&!includeDeleted?null:{meta,draft:decode(row.draft)};
  }
  const need=id=>read(id) ?? reject('找不到这份稿件。',404);
  function write(meta,draft) {
    q('INSERT INTO drafts(id,meta,draft) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta,draft=excluded.draft')
      .run(meta.id,encode(meta),encode(draft));
    return meta;
  }
  function describe(meta,draft){
    const opinions=Object.keys(draft.notes).filter(i=>effectiveOpinion(draft,Number(i)).trim()).length;
    const changes=Object.keys(draft.notes).filter(i=>modified(draft,Number(i))).length;
    return {...meta,name:draft.name,opinions,changes,sentences:draft.spans.length,
      preview:draft.source.trimStart().slice(0,180).replace(/\s+/gu,' ').slice(0,72)};
  }
  const live = "json_extract(drafts.meta,'$.trashedAt') IS NULL";
  const putMeta=meta=>q('UPDATE drafts SET meta=? WHERE id=?').run(encode(meta),meta.id);
  function list(inTrash=false){
    const condition=inTrash?"json_extract(meta,'$.trashedAt') IS NOT NULL":live;
    const order=inTrash?'trashedAt':'updatedAt';
    return q("SELECT meta FROM drafts WHERE "+condition+" ORDER BY json_extract(meta,'$."+order+"') DESC, id DESC")
      .all().map(x=>decode(x.meta));
  }
  function setTrash(id,revision,inTrash){
    return atomic(()=>{
      const record=read(id,true);
      if(!record)reject('找不到这份稿件。',404);
      const meta=record.meta;
      if(Boolean(meta.trashedAt)===inTrash) return meta;
      if(meta.revision!==revision)reject('稿件已有更新，请重新确认。',409);
      const next={...meta,revision:meta.revision+1};
      if(inTrash)next.trashedAt=Date.now();
      else delete next.trashedAt;
      putMeta(next);
      return next;
    });
  }
  const purgedIds=()=>q('SELECT id FROM purged_drafts').all().map(row=>row.id);
  function purge(entries){
    if(!Array.isArray(entries)||!entries.length||entries.some(entry=>!validId(entry?.id)||!Number.isSafeInteger(entry.revision)))
      reject('请选择要彻底删除的记录。');
    const ids=[...new Set(entries.map(entry=>entry.id))];
    if(ids.length!==entries.length)reject('删除列表有重复记录。');
    atomic(()=>{
      for(const {id,revision} of entries){
        const record=read(id,true);
        if(!record&&q('SELECT id FROM purged_drafts WHERE id=?').get(id))continue;
        if(!record?.meta.trashedAt || record.meta.revision!==revision)reject('回收站内容已变化，请重新确认。',409);
      }
      const selection=encode(ids);
      q('INSERT OR IGNORE INTO purged_drafts SELECT value FROM json_each(?)').run(selection);
      q('DELETE FROM ai_edits WHERE draft_id IN (SELECT value FROM json_each(?))').run(selection);
      if(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_suggestions'").get())
        q('DELETE FROM retired_suggestions WHERE draft_id IN (SELECT value FROM json_each(?))').run(selection);
      q('DELETE FROM review_baselines WHERE draft_id IN (SELECT value FROM json_each(?))').run(selection);
      q('DELETE FROM notices WHERE draft_id IN (SELECT value FROM json_each(?))').run(selection);
      q('DELETE FROM opinion_runs WHERE draft_id IN (SELECT value FROM json_each(?))').run(selection);
      q('DELETE FROM opinion_prompts WHERE NOT EXISTS (SELECT 1 FROM opinion_runs WHERE prompt_version=opinion_prompts.id)').run();
      q('DELETE FROM drafts WHERE id IN (SELECT value FROM json_each(?))').run(selection);
      q("UPDATE operations SET result='{"+'"purged":true'+"}',input='' WHERE coalesce(json_extract(result,'$.draftId'),json_extract(result,'$.id')) IN (SELECT value FROM json_each(?))").run(selection);
    });
    let compacted=false;
    try{
      db.exec('VACUUM');
      compacted=q('PRAGMA wal_checkpoint(TRUNCATE)').get().busy===0;
    }catch{/* records are already gone; compaction may need free disk space */}
    return {ids,compacted};
  }
  function saveBrowser(meta,raw,returnDraft=false){
    let draft=ensureDraft(raw);
    if(!validId(meta?.id)||!Number.isSafeInteger(meta.revision)||meta.revision<0)reject('稿件标识无效。');
    return atomic(()=>{
      const previous=read(meta.id,true);
      if(!previous&&q('SELECT id FROM purged_drafts WHERE id=?').get(meta.id))reject('这份稿件已彻底删除。',410);
      if(previous?.meta.trashedAt)reject('这份稿件已移入「已删除」。请恢复后再编辑。',409);
      const stale=(previous?.meta.revision??0)!==meta.revision;
      if(previous && (draft.source!==previous.draft.source || encode(draft.spans)!==encode(previous.draft.spans)))
        reject('已有稿件的原文和句块不能覆盖。',409);
      const baseline=stale&&returnDraft&&previous?aiBaseline(previous,meta.revision):previous?.draft;
      if(stale&&(!returnDraft||!baseline))reject('稿件已被其他操作更新。',409);
      const humanDraft=draft;
      // Tags are kept by the server: a browser save can only remove those of fields the author edited.
      // A newly imported backup brings its own.
      if(stale)draft=mergeDraftEdits(baseline,draft,previous.draft);
      else if(previous)setAiMarks(draft,withoutEditedAiMarks(previous.draft.aiMarks,baseline,humanDraft));
      const now=Date.now();
      if(!previous)flattenOpinionBackup(draft);
      else {
        reconcileOpinionRuns(meta.id,previous.draft,draft);
        recordOpinionFollowup(meta.id,previous.draft,draft);
      }
      const before=previous?.meta ?? {id:meta.id, kind:['paste','import','backup'].includes(meta.kind)?meta.kind:'import',
        createdAt:now, aiReview:false, humanReview:false, unread:false};
      const next=write(describe({...before,updatedAt:now,revision:(previous?.meta.revision??0)+1,
        humanReview:before.humanReview || humanMarks(humanDraft) ||
        Boolean(baseline && noteChanged(baseline.notes,humanDraft.notes))},draft),draft);
      return returnDraft?{meta:next,draft}:next;
    });
  }
  function migrate(meta,raw){
    const draft=ensureDraft(raw);
    flattenOpinionBackup(draft);
    if(!validId(meta?.id))reject('旧稿件标识无效。');
    return atomic(()=>{
      if(read(meta.id,true)||q('SELECT id FROM purged_drafts WHERE id=?').get(meta.id))return;
      const now=Date.now();
      const at=v=>Number.isSafeInteger(v)&&v>0&&v<=now?v:now;
      write(describe({id:meta.id,kind:['paste','import','backup','legacy'].includes(meta.kind)?meta.kind:'legacy',
        createdAt:at(meta.createdAt),updatedAt:at(meta.updatedAt),revision:1,
        humanReview:humanMarks(draft),aiReview:false,unread:false},draft),draft);
    });
  }
  function seen(id){
    return atomic(()=>{
      const {meta}=need(id);
      if(meta.unread) putMeta({...meta,unread:false});
    });
  }
  function repeat(key,request,fn){
    if(!validId(request.requestId))reject('requestId 必须是稳定的字母、数字、下划线或短横线标识。');
    const k=key+':'+request.requestId, input=digest(encode(request)).toString('hex');
    const prev=q('SELECT input,result FROM operations WHERE key=?').get(k);
    if(prev){
      if(decode(prev.result).purged)reject('该稿件已彻底删除。',410);
      if(prev.input!==input)reject('该 requestId 已用于不同内容。',409);
      return decode(prev.result);
    }
    const answer=fn();
    q('INSERT INTO operations VALUES(?,?,?)').run(k,input,encode(answer));
    return answer;
  }
  function publish(request,recipient=originalConnection){
    const name=textOf(request.title,220).trim(), source=textOf(request.text,1_500_000);
    const format=request.format === 'markdown' || (request.format!=='plain' && looksLikeMarkdown(source)) ? 'markdown':'plain';
    const draft=createDraft(name,source,null,[],{format,spans:format==='markdown'?markdownSpans(source):undefined});
    return atomic(()=>repeat(recipient===originalConnection?'publish':'publish:'+recipient,request,()=>{
      const now=Date.now();
      return write(describe({id:randomUUID(),kind:'ai',createdAt:now,updatedAt:now,revision:1,
        humanReview:false,aiReview:false,unread:true},draft),draft);
    }));
  }
  const humanBody=(draft,i)=>modified(draft,i)&&!draft.aiMarks?.[i]?.body;
  function knownTo(recipient,id){
    const row=q('SELECT snapshot FROM review_baselines WHERE recipient=? AND draft_id=?').get(recipient,id);
    return row?decode(row.snapshot):{notes:{},gaps:[]};
  }
  function setKnown(recipient,id,snapshot){
    q('INSERT INTO review_baselines VALUES(?,?,?) ON CONFLICT(recipient,draft_id) DO UPDATE SET snapshot=excluded.snapshot')
      .run(recipient,id,encode(snapshot));
  }
  // AI writes land in the same opinion and revision fields the author uses, tagged AI 审稿.
  // The author's opinion text is never altered, and a revision the author wrote is only replaced on request.
  function editDraft(request,recipient){
    needConnection(recipient);
    return atomic(()=>repeat('edit:'+recipient,request,()=>{
      const {meta,draft}=need(request.draftId);
      if(meta.revision!==request.expectedRevision)reject('稿件已有更新，请重新读取后再编辑。',409);
      const changes=[], seen=new Set(), keptHuman=[], priorName=draft.name, marks={...draft.aiMarks};
      for(const edit of request.edits??[]){
        const i=edit.sentence;
        if(!validSentence(draft,i)||seen.has(i))reject('句块不存在或重复。');
        seen.add(i);
        const source=original(draft,i);
        if(edit.original!==source)reject('句块原文与当前稿件不匹配。',409);
        if(edit.opinion===undefined&&edit.replacement===undefined&&edit.deleted===undefined)reject('请选择要修改的内容。');
        if(edit.deleted===true&&edit.replacement!==undefined)reject('删除与改写不能同时提交。');
        const old=draft.notes[i], next={...note(draft,i)}, mark={...marks[i]}, body={revision:next.revision};
        if(next.deleted)body.deleted=true;
        if(edit.replacement!==undefined){body.revision=edit.replacement===source?'':edit.replacement;delete body.deleted;}
        if(edit.deleted===true)body.deleted=true;
        if(edit.deleted===false)delete body.deleted;
        let aside='';
        if(!sameBody(next,body)){
          if(humanBody(draft,i)&&edit.overwriteHumanRevision!==true){
            aside=edit.deleted===true?'建议删除本句。':edit.replacement&&body.revision?'建议改为：'+edit.replacement:
              edit.replacement===undefined?'建议恢复本句。':'建议恢复原句。';
            keptHuman.push({sentence:i,humanRevision:deleted(draft,i)?null:revised(draft,i),
              note:'这句有作者的人工改写，未覆盖；改写建议已写进意见栏。'});
          }else{
            if(humanBody(draft,i))mark.replaced={revision:next.revision,...(next.deleted?{deleted:true}:{})};
            next.revision=body.revision;
            if(body.deleted)next.deleted=true;else delete next.deleted;
            // Undoing its own change on an untouched sentence leaves nothing to tag.
            if(next.deleted||(next.revision.trim()&&next.revision!==source)||mark.replaced)mark.body=true;
            else delete mark.body;
          }
        }
        if(edit.opinion!==undefined||aside){
          const parts=opinionParts(next,mark), said=edit.opinion?.trim()??parts.ai;
          const [opinion,from]=joinOpinion(parts.human,said.endsWith(aside)?said:[said,aside].filter(Boolean).join('\n'));
          next.opinion=opinion;
          if(from===undefined)delete mark.opinion;else mark.opinion=from;
        }
        if(!noteChanged(note(draft,i),next))continue;
        delete next.autoOpinion;
        changes.push([i,old??null,next]);
        if(Object.keys(mark).length)marks[i]=mark;else delete marks[i];
        if(next.opinion||next.revision||next.deleted)draft.notes[i]=next;else delete draft.notes[i];
      }
      if(request.title!==undefined)draft.name=textOf(request.title,220).trim();
      if(!changes.length&&draft.name===priorName)return {draftId:meta.id,revision:meta.revision,changed:[],keptHuman};
      const revision=meta.revision+1;
      setAiMarks(draft,marks);
      reconcileOpinionRuns(meta.id,draft,draft);
      q('INSERT INTO ai_edits VALUES(?,?,?)').run(meta.id,revision,encode({priorName,changes,actor:recipient}));
      write(describe({...meta,revision,updatedAt:Date.now(),aiReview:true},draft),draft);
      // The writer already knows its own edits; later notices report only what the author did to them.
      const known=knownTo(recipient,meta.id);
      for(const [i] of changes){
        const mark=reviewMark(draft,i);
        if(hasReviewMark(mark))known.notes[i]=mark;else delete known.notes[i];
      }
      setKnown(recipient,meta.id,known);
      return {draftId:meta.id,revision,changed:changes.map(x=>x[0]),keptHuman};
    }));
  }
  // The author has read an AI-written field and keeps it as is: drop its tag without editing.
  function dismissAiTags(id,request){
    return atomic(()=>{
      const {meta,draft}=need(id);
      if(request?.revision!==meta.revision)reject('稿件已有更新，请重新打开。',409);
      const {sentence,field}=request, marks={...draft.aiMarks};
      if(sentence!==undefined){
        if(!validSentence(draft,sentence)||!['opinion','body'].includes(field))reject('无效的标记。');
        const mark={...marks[sentence]};
        if(field==='opinion')delete mark.opinion;
        else{delete mark.body;delete mark.replaced;}
        if(Object.keys(mark).length)marks[sentence]=mark;else delete marks[sentence];
      }else for(const [i,mark] of Object.entries(marks)){
        // Marking everything read must not silently drop a rewrite the author can still switch back to.
        if(mark.replaced)marks[i]={body:true,replaced:mark.replaced};else delete marks[i];
      }
      if(!noteChanged(marks,draft.aiMarks??{}))return {meta,draft};
      setAiMarks(draft,marks);
      const revision=meta.revision+1;
      q('INSERT INTO ai_edits VALUES(?,?,?)').run(id,revision,encode({priorName:draft.name,changes:[],actor:'author'}));
      const next=write(describe({...meta,revision,updatedAt:Date.now(),humanReview:true},draft),draft);
      return {meta:next,draft};
    });
  }
  function aiBaseline(previous,from){
    const rows=q('SELECT revision,payload FROM ai_edits WHERE draft_id=? AND revision>? ORDER BY revision DESC').all(previous.meta.id,from);
    if(!rows.length||rows.length!==previous.meta.revision-from||
      rows.some((row,i)=>row.revision!==previous.meta.revision-i))return null;
    const base={...previous.draft,notes:{...previous.draft.notes}};
    for(const {payload} of rows){
      const {priorName,changes}=decode(payload);
      base.name=priorName;
      for(const [i,old] of changes)if(old)base.notes[i]=old;else delete base.notes[i];
    }
    return base;
  }
  function notify(id,expectedRevision,recipient){
    return atomic(()=>{
      const connection=needConnection(recipient);
      const {meta,draft}=need(id);
      if(expectedRevision!==meta.revision)reject('稿件已有更新，请先重新打开。',409);
      const snapshot=knownTo(recipient,id), old=snapshot.notes;
      const marks=Object.fromEntries(Object.keys(draft.notes).map(i=>[i,reviewMark(draft,Number(i))]));
      const changes=[];
      const candidates=[...new Set([...Object.keys(old).map(Number),...Object.keys(marks).map(Number)])].sort((a,b)=>a-b);
      for(const i of candidates){
        const before=old[i]??blankMark, after=marks[i]??blankMark;
        // Legacy snapshots stored raw input, including drafts that never changed the effective sentence.
        const normalized={opinion:before.opinion?.trim()?before.opinion:'',
          revision:!before.deleted&&before.revision?.trim()&&before.revision!==original(draft,i)?before.revision:'',
          ...(before.deleted?{deleted:true}:{})};
        if(!noteChanged(normalized,after))continue;
        const restored=Boolean((normalized.deleted||normalized.revision)&&!after.deleted&&!after.revision);
        const tag=draft.aiMarks?.[i];
        changes.push({sentence:i,original:original(draft,i),...after,effective:revised(draft,i),
          ...(tag?.opinion!==undefined?{aiOpinion:true}:{}),...(tag?.body?{aiRevision:true}:{}),
          ...(restored?{restored:true}:{}),...(normalized.opinion&&!after.opinion?{opinionCleared:true}:{})});
      }
      const gaps=draft.omittedGaps??[], oldGaps=snapshot.gaps??[];
      const gapChanges=[];
      for(const [before,after,action] of [[oldGaps,gaps,'deleted'],[gaps,oldGaps,'restored']]){
        const covered=new Set(before.map(([a,b])=>a+':'+b));
        for(const [start,end] of after)if(!covered.has(start+':'+end))
          gapChanges.push({start,end,action});
      }
      // Apply restorations first if a single deleted whitespace range was shortened.
      gapChanges.sort((a,b)=>Number(b.action==='restored')-Number(a.action==='restored')||a.start-b.start);
      const payload={draftId:id,title:meta.name,revision:meta.revision,recipient:connection.name,
        changeCount:changes.length+gapChanges.length};
      if(!payload.changeCount)return {...payload,queued:false};
      Object.assign(payload,{id:randomUUID(),createdAt:Date.now()});
      q('INSERT INTO notices(id,draft_id,created_at,payload,notes,recipient) VALUES(?,?,?,?,?,?)')
        .run(payload.id,id,payload.createdAt,encode({...payload,changes,...(gapChanges.length?{gapChanges}:{})}),'{}',recipient);
      setKnown(recipient,id,{notes:marks,gaps});
      return {...payload,queued:true};
    });
  }
  function listNotices(limit,recipient){
    return q('SELECT notices.payload FROM notices JOIN drafts ON drafts.id=notices.draft_id WHERE notices.recipient=? AND notices.acknowledged=0 AND '+live+' ORDER BY notices.rowid LIMIT ?').all(recipient,limit)
      .map(({payload})=>{const {changes,gapChanges,...summary}=decode(payload);return summary;});
  }
  function readNotice(id,offset,limit,recipient){
    const row=q('SELECT notices.payload,notices.acknowledged FROM notices JOIN drafts ON drafts.id=notices.draft_id WHERE notices.id=? AND notices.recipient=? AND '+live).get(id,recipient);
    if(!row)reject('找不到通知。',404);
    const {changes,gapChanges,...summary}=decode(row.payload);
    // Keep the existing sentence payload and page structural changes within the same limit.
    const end=offset+limit, gaps=gapChanges??[];
    return {...summary,acknowledged:Boolean(row.acknowledged),changes:changes.slice(offset,end),
      ...(gaps.length&&end>changes.length?{gapChanges:gaps.slice(Math.max(0,offset-changes.length),end-changes.length)}:{}),
      next:end<changes.length+gaps.length?end:null};
  }
  function ack(id,recipient){
    const changed=q('UPDATE notices SET acknowledged=1 WHERE id=? AND recipient=? AND EXISTS (SELECT 1 FROM drafts WHERE drafts.id=notices.draft_id AND '+live+')').run(id,recipient).changes;
    if(!changed)reject('找不到通知。',404);
    return {id,acknowledged:true};
  }
  function readSentences(id,offset,limit){
    const {meta,draft}=need(id);
    return {meta,format:draft.format??null,total:draft.spans.length,omittedGaps:draft.omittedGaps??[],
      sentences:draft.spans.slice(offset,offset+limit).map(([start,end],k)=>{
        const i=offset+k, n=note(draft,i), tag=draft.aiMarks?.[i];
        return {sentence:i,start,end,separatorBefore:draft.source.slice(draft.spans[i-1]?.[1]??0,start),
          original:original(draft,i),opinion:n.opinion,
          ...(n.opinion?{opinionBy:tag?.opinion===undefined?'human':tag.opinion?'human+ai':'ai'}:{}),
          ...(tag?.opinion?{aiOpinion:opinionParts(n,tag).ai}:{}),
          ...(n.autoOpinion?{effectiveOpinion:effectiveOpinion(draft,i)}:{}),
          revision:n.revision,deleted:deleted(draft,i),effective:revised(draft,i),
          ...(modified(draft,i)?{revisionBy:tag?.body?'ai':'human'}:{}),
          ...(tag?.replaced?{overwrittenHumanRevision:tag.replaced.deleted?null:tag.replaced.revision}:{})};
      }),next:offset+limit<draft.spans.length?offset+limit:null,
      ...(offset+limit>=draft.spans.length ? {tail:draft.source.slice(draft.spans.at(-1)[1])} : {})};
  }
  function flattenOpinionBackup(draft){
    for(const [i,n] of Object.entries(draft.notes))if(n.autoOpinion){
      n.opinion=effectiveOpinion(draft,Number(i));delete n.autoOpinion;
    }
  }
  const completionSettingsKey='opinion-settings';
  function opinionConfig(){
    const raw=q('SELECT value FROM settings WHERE key=?').get(completionSettingsKey)?.value;
    const value=raw?decode(raw):{baseUrl:'',model:'',prompt:defaultOpinionPrompt,promptVersion:'initial-v1',key:null};
    return value;
  }
  function opinionSettings(){
    const {baseUrl,model,prompt,key}=opinionConfig();
    return {baseUrl,model,prompt,hasKey:Boolean(key),defaultPrompt:defaultOpinionPrompt,settingsRevision:opinionConfig().settingsRevision??'initial'};
  }
  function saveOpinionSettings(raw){
    const next=normalizeOpinionSettings(raw), previous=opinionConfig();
    checkSettingsRevision(previous,raw?.expectedRevision);
    const key=next.clearKey?null:next.apiKey?seal(next.apiKey):
      next.baseUrl===previous.baseUrl?previous.key:null;
    writeOpinionConfig(previous,{baseUrl:next.baseUrl,model:next.model,prompt:next.prompt,key});
    return opinionSettings();
  }
  function checkSettingsRevision(previous,expected){
    if(expected!==undefined&&expected!==(previous.settingsRevision??'initial'))
      reject('补全设置已更新，请重新读取后再保存。',409);
  }
  function writeOpinionConfig(previous,next){
    if(['baseUrl','model','prompt','key'].every(k=>previous[k]===next[k]))return;
    const value={...next,settingsRevision:randomUUID(),
      promptVersion:next.prompt===previous.prompt?previous.promptVersion:randomUUID()};
    atomic(()=>{
      if(next.prompt!==previous.prompt){
        const save=q('INSERT OR IGNORE INTO prompt_history VALUES(?,?,?)');
        save.run(previous.promptVersion,previous.prompt,Date.now());
        save.run(value.promptVersion,value.prompt,Date.now());
      }
      q('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(completionSettingsKey,encode(value));
    });
  }
  function automationOpinion(recipient){
    needConnection(recipient);
    const {model,prompt,promptVersion,settingsRevision}=opinionConfig();
    return {model,prompt,promptVersion,settingsRevision:settingsRevision??'initial'};
  }
  function setAutomationOpinion(recipient,request){
    needConnection(recipient);
    const previous=opinionConfig();
    checkSettingsRevision(previous,request.expectedRevision);
    const restored=request.restoreVersion?q('SELECT body FROM prompt_history WHERE id=?').get(request.restoreVersion):null;
    if(request.restoreVersion&&!restored)reject('找不到这个提示词版本。',404);
    const prompt=restored?.body??request.prompt?.trim()??previous.prompt;
    if(!prompt)reject('提示词不能为空。');
    const model=request.model?.trim()??previous.model;
    if(!model&&request.model!==undefined)reject('模型名称不能为空。');
    if(request.model!==undefined&&!previous.baseUrl)reject('请先在页面配置模型服务地址。');
    writeOpinionConfig(previous,{baseUrl:previous.baseUrl,key:previous.key,prompt,model});
    return automationOpinion(recipient);
  }
  function promptVersions(recipient,offset,limit){
    needConnection(recipient);
    const rows=q('SELECT id,body,created_at AS createdAt FROM prompt_history ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit+1,offset);
    return {versions:rows.slice(0,limit).map(({id,createdAt,body})=>({id,createdAt,preview:body.slice(0,120)})),
      next:rows.length>limit?offset+limit:null};
  }
  function previewOpinion(recipient,request){
    needConnection(recipient);
    const {draft}=need(request.draftId), i=request.sentence;
    if(!validSentence(draft,i))reject('找不到要试跑的句子。');
    const config=opinionConfig();
    if(!config.baseUrl||!config.model)reject('请先在页面配置模型服务。',409);
    const input=opinionInput(draft,i);
    if(request.prefix!==undefined)input.prefix=request.prefix;
    if(input.prefix.length>2400)reject('意见前缀太长。');
    let apiKey='';
    if(config.key){try{apiKey=unseal(config.key);}catch{reject('无法读取模型密钥，请在页面重新填写。',409);}}
    return {input,config:{...config,apiKey,prompt:request.prompt?.trim()||config.prompt}};
  }
  function automationFeedback(recipient,draftId,offset,limit){
    needConnection(recipient);
    if(draftId)need(draftId);
    const rows=q('SELECT r.* FROM opinion_runs r JOIN drafts ON drafts.id=r.draft_id WHERE '+live+
      (draftId?' AND r.draft_id=?':'')+' ORDER BY r.rowid DESC LIMIT ? OFFSET ?')
      .all(...(draftId?[draftId]:[]),limit+1,offset);
    return {examples:rows.slice(0,limit).map(r=>({draftId:r.draft_id,sentence:r.sentence,state:r.state,
      input:decode(r.input),suffix:r.suffix,model:r.model,promptVersion:r.prompt_version,
      ...(r.outcome?{outcome:decode(r.outcome)}:{})})),next:rows.length>limit?offset+limit:null};
  }
  function opinionInput(draft,i){
    const prefix=note(draft,i).opinion;
    const around=j=>j<0||j>=draft.spans.length?'':original(draft,j);
    return {original:around(i).slice(0,2200),revision:deleted(draft,i)?null:modified(draft,i)?revised(draft,i).slice(0,1600):'',
      before:[around(i-2).slice(-140),around(i-1).slice(-280)].filter(Boolean),
      after:[around(i+1).slice(0,280),around(i+2).slice(0,140)].filter(Boolean),prefix};
  }
  const validSentence=(draft,i)=>Number.isSafeInteger(i)&&i>=0&&i<draft.spans.length;
  function prepareOpinion(id,request){
    const {meta,draft}=need(id), i=request?.sentence;
    if(!validSentence(draft,i))reject('找不到要补全的句子。');
    if(mcpMode())reject('MCP 模式已开启，网页的 AI 补全已停用。',409);
    const input=opinionInput(draft,i), manual=request.manual===true;
    if(meta.revision!==request.revision||input.prefix!==request.prefix)reject('意见已更新，请继续编辑或重新请求。',409);
    if(!manual&&!input.prefix.trim())return null;
    if(input.prefix.length>2400)reject('当前意见较长，请缩短后再生成补全。');
    const config=opinionConfig();
    if(!config.baseUrl||!config.model)reject('请先在「补全设置」填写模型地址和名称。',409);
    const prev=q('SELECT state,input,model,prompt_version FROM opinion_runs WHERE draft_id=? AND sentence=? ORDER BY rowid DESC LIMIT 1').get(id,i);
    if(prev&&(['pending','auto'].includes(prev.state)||(!manual&&prev.input===encode(input)&&prev.model===config.model&&prev.prompt_version===config.promptVersion)))return null;
    let apiKey='';
    if(config.key){
      try{apiKey=unseal(config.key);}catch{reject('无法读取已保存的模型密钥，请重新填写。',409);}
    }
    return {input,config:{...config,apiKey}};
  }
  function finishOpinion(id,i,prepared,suffix){
    return atomic(()=>{
      const rec=read(id,true);
      if(!rec)return {run:null};
      const same=!rec.meta.trashedAt&&encode(prepared.input)===encode(opinionInput(rec.draft,i));
      const state=same?(suffix?'pending':'empty'):'superseded';
      const runId=randomUUID(), createdAt=Date.now(), {input,config}=prepared;
      q('INSERT OR IGNORE INTO opinion_prompts VALUES(?,?)').run(config.promptVersion,config.prompt);
      q('INSERT INTO opinion_runs(id,draft_id,sentence,state,input,suffix,model,prompt_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(runId,id,i,state,encode(input),suffix,config.model,config.promptVersion,createdAt);
      if(!same||!suffix)return {run:null,empty:same&&!suffix};
      return {run:{id:runId,sentence:i,state,suffix,prefix:input.prefix}};
    });
  }
  function currentOpinions(id){
    need(id);
    return q("SELECT id,sentence,state,suffix,input FROM opinion_runs WHERE draft_id=? AND state IN ('pending','auto') ORDER BY rowid").all(id)
      .map(({input,...row})=>({...row,prefix:decode(input).prefix}));
  }
  function updateOpinionRun(row,state,draft,finalOpinion){
    const human=note(draft,row.sentence).opinion;
    const outcome={at:Date.now(),humanAtDecision:human,finalOpinion:finalOpinion??human};
    q('UPDATE opinion_runs SET state=?,outcome=? WHERE id=?').run(state,encode(outcome),row.id);
  }
  function reconcileOpinionRuns(id,before,after){
    const rows=q("SELECT id,sentence,state,input FROM opinion_runs WHERE draft_id=? AND state IN ('pending','auto')").all(id);
    const auto=new Map();
    for(const row of rows){
      const i=row.sentence, n=after.notes[i];
      if(encode(opinionInput(after,i))!==row.input||(row.state==='auto'&&before!==after&&before?.notes[i]?.autoOpinion&&!n?.autoOpinion)){
        updateOpinionRun(row,'superseded',after);
        if(n)delete n.autoOpinion;
      }else if(row.state==='auto'&&before?.notes[i]?.autoOpinion){
        auto.set(String(i),before.notes[i].autoOpinion);
      }
    }
    for(const [i,n] of Object.entries(after.notes)){
      if(auto.has(i))n.autoOpinion=auto.get(i);
      else delete n.autoOpinion;
    }
    for(const [i,v] of auto){
      after.notes[i]??={...blankMark};
      after.notes[i].autoOpinion=v;
    }
  }
  function recordOpinionFollowup(id,before,after){
    const candidates=new Set([...Object.keys(before.notes),...Object.keys(after.notes)]);
    for(const key of candidates){
      const i=Number(key), current=note(after,i).opinion;
      if(note(before,i).opinion===current)continue;
      const row=q('SELECT id,state,outcome FROM opinion_runs WHERE draft_id=? AND sentence=? ORDER BY rowid DESC LIMIT 1').get(id,i);
      if(!row||!['rejected','accepted','superseded'].includes(row.state))continue;
      const outcome=row.outcome?decode(row.outcome):{};
      if((outcome.afterUserEdit??outcome.finalOpinion)===current)continue;
      q('UPDATE opinion_runs SET outcome=? WHERE id=?').run(encode({...outcome,afterUserEdit:current,editedAt:Date.now()}),row.id);
    }
  }
  function decideOpinion(id,request){
    return atomic(()=>{
      const {meta,draft}=need(id);
      if(request?.revision!==meta.revision)reject('稿件已有更新，请重新打开。',409);
      const action=request?.action;
      if(!['auto','accept','reject'].includes(action)||!validId(request?.runId))reject('无效的补全操作。');
      const row=q("SELECT * FROM opinion_runs WHERE id=? AND draft_id=? AND state IN ('pending','auto')").get(request.runId,id);
      if(!row)reject('这条补全已经处理。',409);
      const i=row.sentence, n={...note(draft,i)};
      const same=encode(opinionInput(draft,i))===row.input;
      if(action!=='reject'&&!same)reject('意见已更新，不能用旧补全覆盖。',409);
      if(action==='auto'&&row.state==='auto')return {meta,draft};
      delete n.autoOpinion;
      if(action==='auto')n.autoOpinion={id:row.id,suffix:row.suffix};
      const applied=action==='accept'?n.opinion+row.suffix:n.opinion;
      const outcome=action==='auto'?'auto':action==='accept'?'accepted':'rejected';
      updateOpinionRun(row,outcome,draft,action==='auto'?n.opinion+row.suffix:applied);
      if(action==='accept')n.opinion=applied;
      if(n.opinion||n.revision||n.deleted||n.autoOpinion)draft.notes[i]=n;
      else delete draft.notes[i];
      const changed=action!=='reject'||row.state==='auto';
      if(!changed)return {meta,draft};
      const next=write(describe({...meta,revision:meta.revision+1,updatedAt:Date.now(),
        aiReview:meta.aiReview||action==='accept',humanReview:meta.humanReview||action==='accept'},draft),draft);
      return {meta:next,draft};
    });
  }
  function opinionFeedback(){
    const rows=q('SELECT r.*,json_extract(drafts.meta,\'$.name\') AS title FROM opinion_runs r JOIN drafts ON drafts.id=r.draft_id WHERE '+live+' ORDER BY r.rowid').all();
    const versions=new Map();
    const examples=rows.map(({id,draft_id,sentence,state,input,suffix,model,prompt_version,created_at,outcome,title})=>{
      if(!versions.has(prompt_version))versions.set(prompt_version,q('SELECT body FROM opinion_prompts WHERE id=?').get(prompt_version)?.body);
      return {id,draftId:draft_id,title,sentence,state,input:decode(input),suffix,model,promptVersion:prompt_version,createdAt:created_at,
        ...(outcome?{outcome:decode(outcome)}:{})};
    });
    return {version:1,prompts:Object.fromEntries(versions),examples};
  }
  const tokenKeyFile=join(location,'mcp-credential.key');
  function keyBytes(create){
    let key;
    try{key=readFileSync(tokenKeyFile);}
    catch(error){
      if(error.code!=='ENOENT'||!create)throw error;
      try{writeFileSync(tokenKeyFile,randomBytes(32),{flag:'wx',mode:0o600});}
      catch(writeError){if(writeError.code!=='EEXIST')throw writeError;}
      key=readFileSync(tokenKeyFile);
    }
    if(key.length!==32)throw new Error('Invalid local credential key');
    return key;
  }
  const mask=token=>token.slice(0,3)+'*'.repeat(token.length-6)+token.slice(-3);
  function needConnection(id){
    const row=validId(id)&&q('SELECT * FROM mcp_connections WHERE id=? AND revoked=0').get(id);
    if(!row)reject('找不到这位收件人，请重新选择。',404);
    return row;
  }
  function unseal(envelope){
      const {nonce,tag,ciphertext}=decode(envelope);
      const cipher=createDecipheriv('aes-256-gcm',keyBytes(false),Buffer.from(nonce,'base64url'));
      cipher.setAuthTag(Buffer.from(tag,'base64url'));
      return Buffer.concat([cipher.update(Buffer.from(ciphertext,'base64url')),cipher.final()]).toString('utf8');
  }
  function readToken(row){
    if(!row.envelope)return null;
    try{
      const token=unseal(row.envelope);
      return authorized('Bearer '+token)===row.id?token:null;
    }catch{return null;}
  }
  function seal(secret){
    const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',keyBytes(true),nonce);
    const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
    const envelope={nonce:nonce.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),
      ciphertext:ciphertext.toString('base64url')};
    return encode(envelope);
  }
  function issueToken(){
    const token=randomBytes(32).toString('base64url');
    return [digest(token).toString('hex'),seal(token)];
  }
  function createConnection(raw){
    const name=textOf(raw,64).trim();
    return atomic(()=>{
      if(q('SELECT 1 FROM mcp_connections WHERE name=? COLLATE NOCASE AND revoked=0').get(name))
        reject('已有同名连接，请换一个名称。',409);
      // An installation with old unassigned notices lets its first connection inherit them.
      const hasLegacyNotices=q('SELECT 1 FROM notices WHERE recipient=? LIMIT 1').get(originalConnection);
      const hasLegacyConnection=q('SELECT 1 FROM mcp_connections WHERE id=?').get(originalConnection);
      const id=hasLegacyNotices&&!hasLegacyConnection?originalConnection:randomUUID();
      q('INSERT INTO mcp_connections(id,name,token_hash,envelope) VALUES(?,?,?,?)').run(id,name,...issueToken());
      return id;
    });
  }
  function rotate(id){
    return atomic(()=>{
      needConnection(id);
      q('UPDATE mcp_connections SET token_hash=?,envelope=? WHERE id=?').run(...issueToken(),id);
    });
  }
  function revoke(id){
    return atomic(()=>{
      needConnection(id);
      q('UPDATE mcp_connections SET token_hash=NULL,envelope=NULL,revoked=1 WHERE id=?').run(id);
    });
  }
  function authorized(header){
    const token=typeof header==='string' && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)?.[1];
    if(!token)return null;
    return q('SELECT id FROM mcp_connections WHERE token_hash=? AND revoked=0').get(digest(token).toString('hex'))?.id??null;
  }
  function connections(withMasks=false){
    return q('SELECT * FROM mcp_connections WHERE revoked=0 ORDER BY rowid').all().map(row=>{
      const {id,name}=row;
      if(!withMasks)return {id,name};
      const token=readToken(row);
      return {id,name,masked:token?mask(token):null};
    });
  }
  function copyToken(id){
    const token=readToken(needConnection(id));
    if(!token)reject('当前连接码不可复制，请先重刷。',409);
    return token;
  }
  const mcpMode=()=>q("SELECT value FROM settings WHERE key='mcp-mode'").get()?.value==='on';
  function setMcpMode(enabled){
    if(typeof enabled!=='boolean')reject('无效的 MCP 模式。');
    q("INSERT INTO settings VALUES('mcp-mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(enabled?'on':'off');
    return {enabled};
  }
  // One-time move from separate suggestion records to AI 审稿 tags on ordinary opinions and revisions.
  function upgrade(){
    if(q('PRAGMA user_version').get().user_version>=1)return;
    atomic(()=>{
      const legacy=Boolean(q("SELECT 1 FROM sqlite_master WHERE type='table' AND name='suggestions'").get());
      const known=new Map();
      const knownBy=(recipient,id)=>{
        const key=recipient+'\n'+id;
        if(!known.has(key))known.set(key,{recipient,id,notes:{},gaps:[]});
        return known.get(key);
      };
      // Each recipient's last notice is what it has already been told.
      for(const {recipient,draft_id,notes} of q('SELECT recipient,draft_id,notes FROM notices n WHERE rowid=(SELECT max(rowid) FROM notices WHERE recipient=n.recipient AND draft_id=n.draft_id)').all()){
        const snapshot=decode(notes), entry=knownBy(recipient,draft_id);
        entry.notes=snapshot.notes??snapshot;
        entry.gaps=snapshot.gaps??[];
        for(const mark of Object.values(entry.notes))delete mark.acceptedOpinions;
      }
      for(const row of q('SELECT id,meta,draft FROM drafts').all()){
        const meta=decode(row.meta), draft=decode(row.draft), marks={}, changes=[];
        // A tag used to be one revision number per sentence; the edit log tells which field the AI wrote.
        for(const [i,revision] of Object.entries(draft.aiMarks??{})){
          const logged=q('SELECT payload FROM ai_edits WHERE draft_id=? AND revision=?').get(row.id,revision);
          const change=logged&&decode(logged.payload).changes.find(c=>String(c[0])===i);
          const now=note(draft,i), before=change?.[1]??blankMark, after=change?.[2], mark={};
          if(modified(draft,Number(i))&&(!after||(!sameBody(before,after)&&sameBody(after,now))))mark.body=true;
          if(after&&now.opinion&&after.opinion!==before.opinion&&after.opinion===now.opinion)mark.opinion=0;
          if(Object.keys(mark).length)marks[i]=mark;
        }
        if(legacy){
          // The newest applied suggestion's opinion becomes the sentence's opinion if its change still stands and
          // the author has written none. Pending, declined and superseded ones only remain in retired_suggestions.
          const applied=new Map();
          for(const s of q("SELECT sentence,payload FROM suggestions WHERE draft_id=? AND state='accepted' ORDER BY rowid").all(row.id))
            applied.set(s.sentence,decode(s.payload));
          for(const [i,s] of applied){
            const now=note(draft,i), opinion=s.opinion?.trim();
            const stands=s.remove?marks[i]?.body&&Boolean(now.deleted):
              s.replacement===undefined||(marks[i]?.body&&!now.deleted&&now.revision===s.replacement);
            if(!opinion||now.opinion.trim()||!stands)continue;
            const next={...now,opinion};
            changes.push([i,draft.notes[i]??null,next]);
            draft.notes[i]=next;
            (marks[i]??={}).opinion=0;
            knownBy(s.author??originalConnection,row.id).notes[i]=reviewMark(draft,i);
          }
        }
        if(!changes.length&&!noteChanged(marks,draft.aiMarks??{}))continue;
        setAiMarks(draft,marks);
        const revision=meta.revision+1;
        q('INSERT INTO ai_edits VALUES(?,?,?)').run(row.id,revision,encode({priorName:draft.name,changes,actor:'upgrade'}));
        write(describe({...meta,revision},draft),draft);
      }
      for(const {recipient,id,notes,gaps} of known.values())setKnown(recipient,id,{notes,gaps});
      if(legacy){
        db.exec('ALTER TABLE suggestions RENAME TO retired_suggestions');
        q("DELETE FROM operations WHERE key LIKE 'review:%'").run();
      }
      // Installations that already connect AI tools keep writing through MCP.
      if(q('SELECT 1 FROM mcp_connections WHERE revoked=0').get())
        q("INSERT OR IGNORE INTO settings VALUES('mcp-mode','on')").run();
      db.exec('PRAGMA user_version=1');
    });
  }
  upgrade();
  return {list,read,setTrash,purge,purgedIds,saveBrowser,migrate,seen,publish,notify,listNotices,dismissAiTags,mcpMode,setMcpMode,
    readNotice,ack,readSentences,createConnection,connections,rotate,revoke,authorized,copyToken,editDraft,automationOpinion,setAutomationOpinion,promptVersions,previewOpinion,automationFeedback,opinionSettings,saveOpinionSettings,prepareOpinion,finishOpinion,currentOpinions,decideOpinion,opinionFeedback,close:()=>db.close()};
}
