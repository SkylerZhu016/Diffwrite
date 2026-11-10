import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createCipheriv,randomBytes} from 'node:crypto';
import {openStore} from './review-store.mjs';
import {createDraft,annotatedChanges} from './model.mjs';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'diffwrite-store-test-')), store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return store;
}
const edit=(s,recipient,id,requestId,edits)=>s.editDraft({requestId,draftId:id,expectedRevision:s.read(id).meta.revision,edits},recipient);
test('AI opinions and rewrites land in the author\'s own fields with a tag; an edited field becomes the author\'s',t=>{
  const s=setup(t), ai=s.createConnection('审稿 AI');
  const input={requestId:'incoming',title:'测试稿',text:'原句。下一句。',format:'plain'};
  const meta=s.publish(input);
  assert.equal(s.publish(input).id,meta.id);
  assert.throws(()=>s.publish({...input,text:'另一篇。'}),/不同内容/);
  assert.equal(meta.aiReview,false);
  assert.equal(meta.humanReview,false);
  const first={requestId:'review',draftId:meta.id,expectedRevision:1,
    edits:[{sentence:0,original:'原句。',opinion:'AI 看法',replacement:'建议。'}]};
  const written=s.editDraft(first,ai);
  assert.deepEqual(s.editDraft(first,ai),written);
  assert.deepEqual(written.changed,[0]);
  let record=s.read(meta.id);
  assert.equal(record.meta.aiReview,true);
  assert.deepEqual(record.draft.notes[0],{opinion:'AI 看法',revision:'建议。'});
  assert.deepEqual(record.draft.aiMarks,{0:{opinion:0,body:true}});
  let read=s.readSentences(meta.id,0,1).sentences[0];
  assert.deepEqual([read.effective,read.opinionBy,read.revisionBy],['建议。','ai','ai']);
  assert.equal(annotatedChanges(record.draft),'原句。 <意见：AI：AI 看法> <改为：建议。>');
  // The author rewrites the sentence: only the rewrite stops being AI's.
  record.draft.notes[0]={opinion:'AI 看法',revision:'人工改动。'};
  let saved=s.saveBrowser(record.meta,record.draft,true);
  assert.equal(saved.meta.humanReview,true);
  assert.deepEqual(saved.draft.aiMarks,{0:{opinion:0}});
  // A later AI rewrite does not replace the author's; it becomes a note in the same opinion box.
  const kept=edit(s,ai,meta.id,'again',[{sentence:0,original:'原句。',opinion:'再看',replacement:'另一版。'}]);
  assert.deepEqual(kept.keptHuman.map(k=>[k.sentence,k.humanRevision]),[[0,'人工改动。']]);
  record=s.read(meta.id);
  assert.deepEqual(record.draft.notes[0],{opinion:'再看\n建议改为：另一版。',revision:'人工改动。'});
  assert.deepEqual(record.draft.aiMarks,{0:{opinion:0}});
  record.draft.notes[0].opinion='人工意见';
  saved=s.saveBrowser(record.meta,record.draft,true);
  assert.equal(saved.draft.aiMarks,undefined);
  // The author's opinion is never altered: AI text follows it and only that part can be rewritten or withdrawn.
  edit(s,ai,meta.id,'append',[{sentence:0,original:'原句。',opinion:'补一句'}]);
  record=s.read(meta.id);
  assert.equal(record.draft.notes[0].opinion,'人工意见\n\nAI：补一句');
  assert.deepEqual(record.draft.aiMarks,{0:{opinion:4}});
  read=s.readSentences(meta.id,0,1).sentences[0];
  assert.deepEqual([read.opinionBy,read.aiOpinion,read.revisionBy],['human+ai','补一句','human']);
  assert.equal(annotatedChanges(record.draft),'原句。 <意见：人工意见\n\nAI：补一句> <改为：人工改动。>');
  // Rewording one's own words ahead of the AI part keeps that part tagged; touching the AI part takes it over.
  record.draft.notes[0].opinion='人工意见，改了措辞\n\nAI：补一句';
  saved=s.saveBrowser(record.meta,record.draft,true);
  assert.deepEqual(saved.draft.aiMarks,{0:{opinion:9}});
  assert.equal(s.readSentences(meta.id,0,1).sentences[0].aiOpinion,'补一句');
  saved.draft.notes[0].opinion='人工意见\n\nAI：补一句，我接着写';
  assert.equal(s.saveBrowser(saved.meta,saved.draft,true).draft.aiMarks,undefined);
  saved.draft.notes[0].opinion='人工意见';
  s.saveBrowser(s.read(meta.id).meta,saved.draft,true);
  edit(s,ai,meta.id,'append-again',[{sentence:0,original:'原句。',opinion:'补一句'}]);
  edit(s,ai,meta.id,'reword',[{sentence:0,original:'原句。',opinion:'换个说法'}]);
  assert.equal(s.read(meta.id).draft.notes[0].opinion,'人工意见\n\nAI：换个说法');
  edit(s,ai,meta.id,'withdraw',[{sentence:0,original:'原句。',opinion:''}]);
  record=s.read(meta.id);
  assert.deepEqual(record.draft.notes[0],{opinion:'人工意见',revision:'人工改动。'});
  assert.equal(record.draft.aiMarks,undefined);
  // The writer already knows what it wrote; a notice only carries what the author did afterwards.
  assert.equal(s.notify(meta.id,record.meta.revision,ai).queued,false);
  record.draft.notes[1]={opinion:'这句也看看',revision:''};
  saved=s.saveBrowser(record.meta,record.draft,true);
  const n=s.notify(meta.id,saved.meta.revision,ai);
  assert.deepEqual(s.readNotice(n.id,0,30,ai).changes.map(c=>[c.sentence,c.opinion]),[[1,'这句也看看']]);
  s.ack(n.id,ai);
  assert.deepEqual(s.listNotices(30,ai),[]);
  assert.equal(s.notify(meta.id,saved.meta.revision,ai).changeCount,0);
});
test('an author\'s rewrite is replaced only on request and stays one step away',t=>{
  const s=setup(t), ai=s.createConnection('AI');
  const meta=s.publish({requestId:'d',title:'稿',text:'她看清了。下句。尾句。'});
  const record=s.read(meta.id);
  record.draft.notes[0]={opinion:'得加个反应',revision:'她【】这才看清。'};
  record.draft.notes[1]={opinion:'',revision:'',deleted:true};
  const saved=s.saveBrowser(record.meta,record.draft,true);
  const result=s.editDraft({requestId:'fill',draftId:meta.id,expectedRevision:saved.meta.revision,edits:[
    {sentence:0,original:'她看清了。',replacement:'她一愣，这才看清。',overwriteHumanRevision:true},
    {sentence:1,original:'下句。',deleted:false},
    {sentence:2,original:'尾句。',replacement:'新尾句。'}]},ai);
  assert.deepEqual(result.changed,[0,1,2]);
  assert.deepEqual(result.keptHuman.map(k=>[k.sentence,k.humanRevision]),[[1,null]]);
  let now=s.read(meta.id);
  assert.deepEqual(now.draft.notes[0],{opinion:'得加个反应',revision:'她一愣，这才看清。'});
  assert.deepEqual(now.draft.notes[1],{opinion:'建议恢复本句。',revision:'',deleted:true});
  assert.deepEqual(now.draft.aiMarks,{0:{body:true,replaced:{revision:'她【】这才看清。'}},1:{opinion:0},2:{body:true}});
  assert.equal(s.readSentences(meta.id,0,1).sentences[0].overwrittenHumanRevision,'她【】这才看清。');
  // Writing the same text again changes nothing, and an AI undoing its own rewrite leaves no tag behind.
  assert.deepEqual(edit(s,ai,meta.id,'same',[{sentence:2,original:'尾句。',replacement:'新尾句。'}]).changed,[]);
  edit(s,ai,meta.id,'undo',[{sentence:2,original:'尾句。',replacement:''}]);
  assert.equal(s.read(meta.id).draft.aiMarks[2],undefined);
  assert.equal(s.read(meta.id).draft.notes[2],undefined);
  // Marking everything read keeps the one tag that still holds the author's replaced rewrite.
  now=s.read(meta.id);
  assert.throws(()=>s.dismissAiTags(meta.id,{revision:now.meta.revision-1}),/已有更新/);
  const seen=s.dismissAiTags(meta.id,{revision:now.meta.revision});
  assert.deepEqual(seen.draft.aiMarks,{0:{body:true,replaced:{revision:'她【】这才看清。'}}});
  assert.equal(seen.draft.notes[1].opinion,'建议恢复本句。');
  // A browser tab that has not caught up still saves across the dismissal.
  now.draft.notes[2]={opinion:'人工后写',revision:''};
  const merged=s.saveBrowser(now.meta,now.draft,true);
  assert.equal(merged.draft.notes[2].opinion,'人工后写');
  assert.deepEqual(merged.draft.aiMarks,seen.draft.aiMarks);
  // Switching back is an ordinary edit by the author.
  merged.draft.notes[0].revision='她【】这才看清。';
  const back=s.saveBrowser(merged.meta,merged.draft,true);
  assert.equal(back.draft.aiMarks,undefined);
  edit(s,ai,meta.id,'retag',[{sentence:2,original:'尾句。',opinion:'再提一条'}]);
  now=s.read(meta.id);
  assert.equal(now.draft.notes[2].opinion,'人工后写\n\nAI：再提一条');
  assert.equal(s.dismissAiTags(meta.id,{revision:now.meta.revision,sentence:2,field:'opinion'}).draft.aiMarks,undefined);
});
test('AI edits merge with simultaneous human typing; a field both touched keeps the author\'s input',t=>{
  const s=setup(t), ai=s.createConnection('AI'), meta=s.publish({requestId:'merge',title:'稿',text:'原句。下句。'}), before=s.read(meta.id);
  edit(s,ai,meta.id,'review',[{sentence:0,original:'原句。',opinion:'AI 意见',replacement:'AI 改稿。'},{sentence:1,original:'下句。',deleted:true}]);
  before.draft.notes[0]={opinion:'',revision:'我的改稿。'};
  const merged=s.saveBrowser(before.meta,before.draft,true);
  assert.deepEqual(merged.draft.notes[0],{opinion:'AI 意见',revision:'我的改稿。'});
  assert.deepEqual(merged.draft.aiMarks,{0:{opinion:0},1:{body:true}});
  assert.equal(merged.draft.notes[1].deleted,true);
  // Both wrote in the same opinion box: the AI part follows the author's newer text instead of being lost.
  edit(s,ai,meta.id,'more',[{sentence:1,original:'下句。',opinion:'AI 后写'}]);
  merged.draft.notes[1].opinion='我先想到的';
  const both=s.saveBrowser(merged.meta,merged.draft,true);
  assert.equal(both.draft.notes[1].opinion,'我先想到的\n\nAI：AI 后写');
  assert.deepEqual(both.draft.aiMarks,{0:{opinion:0},1:{body:true,opinion:5}});
  // A backup of this draft imported as a new record keeps its tags.
  const copy=s.saveBrowser({id:'backup-copy',revision:0,kind:'backup'},both.draft,true);
  assert.deepEqual(copy.draft.aiMarks,both.draft.aiMarks);
});
test('retired suggestion records: applied AI opinions move into the opinion box, pending ones are never applied',t=>{
  const dir=mkdtempSync(join(tmpdir(),'diffwrite-store-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=openStore(dir), ai=first.createConnection('OMP');
  const meta=first.publish({requestId:'old',title:'旧稿',text:'一。二。三。四。'});
  const rec=first.read(meta.id);
  rec.draft.notes[1]={opinion:'人工意见',revision:'人工二。'};
  rec.draft.notes[2]={opinion:'',revision:'AI 三。'};
  rec.draft.notes[3]={opinion:'',revision:'AI 四，又被人改。'};
  const saved=first.saveBrowser(rec.meta,rec.draft);
  first.close();
  const raw=new DatabaseSync(join(dir,'review.sqlite'));
  raw.exec(`PRAGMA user_version=0; DELETE FROM settings;
    CREATE TABLE suggestions(id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id),
      sentence INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);`);
  const stored=JSON.parse(raw.prepare('SELECT draft FROM drafts').get().draft);
  stored.aiMarks={2:saved.revision,3:saved.revision};
  raw.prepare('UPDATE drafts SET draft=?').run(JSON.stringify(stored));
  raw.prepare('INSERT INTO ai_edits VALUES(?,?,?)').run(meta.id,saved.revision,JSON.stringify({priorName:'旧稿',actor:'submit_review',
    changes:[[2,null,{opinion:'',revision:'AI 三。'}],[3,null,{opinion:'',revision:'AI 四。'}]]}));
  const suggest=raw.prepare('INSERT INTO suggestions VALUES(?,?,?,?,?)');
  for(const [n,sentence,state,payload] of [
    [1,0,'rejected',{opinion:'不要的意见'}],
    [2,0,'accepted',{opinion:'只是意见'}],
    [3,1,'pending',{opinion:'待审意见',replacement:'待审二。',blockedReason:'已有人工改写或原句已变化，未覆盖。'}],
    [4,2,'accepted',{opinion:'旧理由',replacement:'旧三。',autoAccepted:true}],
    [5,2,'accepted',{opinion:'新理由',replacement:'AI 三。',autoAccepted:true}],
    [6,3,'accepted',{opinion:'四的理由',replacement:'AI 四。',autoAccepted:true}]
  ])suggest.run('s'+n,meta.id,sentence,state,JSON.stringify({author:ai,...payload}));
  raw.prepare('INSERT INTO notices(id,draft_id,created_at,acknowledged,payload,notes,recipient) VALUES(?,?,?,1,?,?,?)').run('told',meta.id,100,'{}',
    JSON.stringify({notes:{1:{opinion:'人工意见',revision:'人工二。'},2:{opinion:'',revision:'AI 三。',acceptedOpinions:['新理由']},
      3:{opinion:'',revision:'AI 四，又被人改。'}},gaps:[],handled:['s2']}),ai);
  raw.prepare('INSERT INTO operations VALUES(?,?,?)').run('review:'+ai+':old-request','x','{}');
  raw.close();
  const s=openStore(dir);
  try{
    const now=s.read(meta.id);
    assert.equal(now.meta.revision,saved.revision+1);
    assert.deepEqual(now.draft.notes,{0:{opinion:'只是意见',revision:''},1:{opinion:'人工意见',revision:'人工二。'},
      2:{opinion:'新理由',revision:'AI 三。'},3:{opinion:'',revision:'AI 四，又被人改。'}});
    assert.deepEqual(now.draft.aiMarks,{0:{opinion:0},2:{body:true,opinion:0}});
    assert.equal(now.meta.opinions,3);
    assert.equal(s.mcpMode(),true);
    assert.equal(s.notify(meta.id,now.meta.revision,ai).queued,false);
    // A tab opened before the upgrade keeps typing and merges over it.
    rec.draft.notes[1].opinion='人工意见，续写';
    const merged=s.saveBrowser(saved,rec.draft,true);
    assert.equal(merged.draft.notes[0].opinion,'只是意见');
    assert.equal(merged.draft.notes[1].opinion,'人工意见，续写');
    assert.deepEqual(merged.draft.aiMarks,now.draft.aiMarks);
    s.close();
    const check=new DatabaseSync(join(dir,'review.sqlite'));
    assert.equal(check.prepare('SELECT count(*) AS n FROM retired_suggestions').get().n,6);
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='suggestions'").get().n,0);
    assert.equal(check.prepare("SELECT count(*) AS n FROM operations WHERE key LIKE 'review:%'").get().n,0);
    check.close();
    const again=openStore(dir);
    try{
      assert.equal(again.read(meta.id).meta.revision,merged.meta.revision);
      const trash=again.setTrash(meta.id,merged.meta.revision,true);
      assert.deepEqual(again.purge([{id:meta.id,revision:trash.revision}]).ids,[meta.id]);
    }finally{again.close();}
  }finally{try{s.close();}catch{}}
});
test('the page\'s own completion stops while MCP mode hands AI writing to connected tools',t=>{
  const s=setup(t), meta=s.publish({requestId:'mode',title:'稿',text:'原句。'});
  s.saveOpinionSettings({baseUrl:'http://127.0.0.1:1234/v1',model:'fixture'});
  assert.equal(s.mcpMode(),false);
  const request={sentence:0,prefix:'',revision:meta.revision,manual:true};
  assert.ok(s.prepareOpinion(meta.id,request));
  assert.deepEqual(s.setMcpMode(true),{enabled:true});
  assert.throws(()=>s.prepareOpinion(meta.id,request),/MCP 模式/);
  s.setMcpMode(false);
  assert.ok(s.prepareOpinion(meta.id,request));
  assert.throws(()=>s.setMcpMode('on'),/无效/);
});
test('migration is idempotent and preserves latest work; rotation invalidates the old token',t=>{
  const s=setup(t);
  const draft=createDraft('旧稿','旧句。');
  const meta={id:'legacy-v1',kind:'legacy',revision:1};
  s.migrate(meta,draft);
  draft.notes[0]={opinion:'继续审',revision:''};
  s.saveBrowser(s.read(meta.id).meta,draft);
  s.migrate(meta,createDraft('旧稿','旧句。'));
  assert.equal(s.read(meta.id).draft.notes[0].opinion,'继续审');
  assert.equal(s.list().length,1);
});

test('named keys stay masked after reopening; rotation and revocation are independent',t=>{
  const dir=mkdtempSync(join(tmpdir(),'diffwrite-store-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=openStore(dir);
  const a=first.createConnection('Codex'),b=first.createConnection('OMP');
  assert.throws(()=>first.createConnection('codex'),/同名/);
  const old=first.copyToken(a), other=first.copyToken(b);
  assert.deepEqual(first.connections(true)[0],{id:a,name:'Codex',masked:old.slice(0,3)+'*'.repeat(37)+old.slice(-3)});
  first.close();
  const s=openStore(dir);
  try{
    assert.equal(s.copyToken(a),old);
    assert.equal(s.authorized('Bearer '+old),a);
    s.rotate(a);
    assert.equal(s.authorized('Bearer '+old),null);
    assert.equal(s.authorized('Bearer '+s.copyToken(a)),a);
    assert.equal(s.authorized('Bearer '+other),b);
    s.revoke(a);
    assert.deepEqual(s.connections(),[{id:b,name:'OMP'}]);
    assert.throws(()=>s.copyToken(a),/找不到/);
    assert.equal(s.authorized('Bearer '+other),b);
  }finally{s.close();}
});

test('old saved key and notification migrate together without changing the client config',t=>{
  const dir=mkdtempSync(join(tmpdir(),'diffwrite-store-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const first=openStore(dir);
  const meta=first.publish({requestId:'old-notice',title:'旧稿',text:'原句。'});
  const rec=first.read(meta.id);
  rec.draft.notes[0]={opinion:'先前意见',revision:''};
  const saved=first.saveBrowser(rec.meta,rec.draft);
  first.close();
  const old=randomBytes(32).toString('base64url'),key=randomBytes(32),nonce=randomBytes(12);
  writeFileSync(join(dir,'mcp-credential.key'),key);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  const ciphertext=Buffer.concat([cipher.update(old,'utf8'),cipher.final()]);
  const envelope=JSON.stringify({nonce:nonce.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')});
  const raw=new DatabaseSync(join(dir,'review.sqlite'));
  raw.exec('PRAGMA user_version=0; DROP INDEX notices_by_recipient; ALTER TABLE notices DROP COLUMN recipient;');
  const insert=raw.prepare('INSERT INTO settings VALUES(?,?)');
  insert.run('mcp-token',createHash('sha256').update(old).digest('hex'));
  insert.run('mcp-token-copy',envelope);
  raw.prepare('INSERT INTO notices VALUES(?,?,?,0,?,?)').run('old-notice',meta.id,100,JSON.stringify({id:'old-notice',changes:[{sentence:0,opinion:'先前意见'}]}),JSON.stringify({notes:rec.draft.notes,handled:[]}));
  raw.close();
  const s=openStore(dir);
  try{
    const recipient=s.authorized('Bearer '+old);
    assert.equal(recipient,'original');
    assert.equal(s.connections()[0].name,'原连接');
    assert.equal(s.copyToken(recipient),old);
    assert.equal(s.listNotices(10,recipient)[0].id,'old-notice');
    assert.equal(s.notify(meta.id,saved.revision,recipient).queued,false);
    const other=s.createConnection('另一个');
    assert.deepEqual(s.listNotices(10,other),[]);
    assert.throws(()=>s.readNotice('old-notice',0,10,other),/找不到/);
  }finally{s.close();}
});

test('each recipient gets only its own delta, including undo and opinion removal',t=>{
  const s=setup(t),a=s.createConnection('Codex'),b=s.createConnection('OMP');
  const meta=s.publish({requestId:'draft',title:'测试稿',text:'原句。下一句。不变。'});
  const record=s.read(meta.id), d=record.draft;
  assert.equal(s.notify(meta.id,meta.revision,a).queued,false);
  d.notes[0]={opinion:'这里有伏笔',revision:'',deleted:true};
  d.notes[1]={opinion:'',revision:'下一句。'};
  const first=s.saveBrowser(meta,d);
  const one=s.notify(meta.id,first.revision,a);
  assert.equal(one.changeCount,1);
  assert.equal(s.notify(meta.id,first.revision,a).queued,false);
  assert.deepEqual(s.listNotices(10,b),[]);
  assert.throws(()=>s.readNotice(one.id,0,10,b),/找不到/);
  assert.throws(()=>s.ack(one.id,b),/找不到/);
  const two=s.notify(meta.id,first.revision,b);
  assert.equal(two.changeCount,1);
  s.ack(one.id,a);
  assert.equal(s.listNotices(10,b)[0].id,two.id);
  delete d.notes[0];
  const next=s.saveBrowser(first,d);
  const three=s.notify(meta.id,next.revision,a);
  assert.deepEqual(s.readNotice(three.id,0,10,a).changes,[{sentence:0,original:'原句。',opinion:'',revision:'',effective:'原句。',restored:true,opinionCleared:true}]);
  s.rotate(b);
  assert.equal(s.listNotices(10,b)[0].id,two.id);
  assert.equal(s.notify(meta.id,next.revision,b).changeCount,1);
  const c=s.createConnection('新人');
  assert.equal(s.notify(meta.id,next.revision,c).queued,false);
  s.revoke(b);
  assert.throws(()=>s.notify(meta.id,next.revision,b),/找不到/);
});

test('a writer is not told about its own edits, only what the author did to them; whitespace deltas are paginated',t=>{
  const s=setup(t),a=s.createConnection('Codex'),b=s.createConnection('OMP');
  const meta=s.publish({requestId:'draft',title:'测试稿',text:'原句。\n\n下一句。'});
  edit(s,a,meta.id,'same',[{sentence:0,original:'原句。',opinion:'可删'}]);
  const record=s.read(meta.id);
  record.draft.omittedGaps=[[3,5]];
  const saved=s.saveBrowser(record.meta,record.draft);
  const one=s.notify(meta.id,saved.revision,a);
  const two=s.notify(meta.id,saved.revision,b);
  assert.equal(one.changeCount,1);
  assert.deepEqual(s.readNotice(one.id,0,10,a).changes,[]);
  const other=s.readNotice(two.id,0,1,b);
  assert.deepEqual(other.changes,[{sentence:0,original:'原句。',opinion:'可删',revision:'',effective:'原句。',aiOpinion:true}]);
  assert.equal(other.next,1);
  assert.deepEqual(s.readNotice(two.id,1,1,b).gapChanges,[{start:3,end:5,action:'deleted'}]);
  delete record.draft.omittedGaps;
  delete record.draft.notes[0];
  const restored=s.saveBrowser(saved,record.draft);
  const n=s.notify(meta.id,restored.revision,a), delta=s.readNotice(n.id,0,10,a);
  assert.deepEqual(delta.changes,[{sentence:0,original:'原句。',opinion:'',revision:'',effective:'原句。',opinionCleared:true}]);
  assert.deepEqual(delta.gapChanges,[{start:3,end:5,action:'restored'}]);
});

test('deleted history stays hidden from AI and migration until restored',t=>{
  const store=setup(t);
  const meta=store.publish({requestId:'delete-test',title:'待删',text:'原句。',format:'plain'});
  const current=store.read(meta.id);
  current.draft.notes[0]={opinion:'保留意见',revision:'改稿。'};
  const saved=store.saveBrowser(current.meta,current.draft);
  const recipient=store.createConnection("AI");
  const notice=store.notify(meta.id,saved.revision,recipient);
  assert.throws(()=>store.setTrash(meta.id,current.meta.revision,true),/重新确认/);
  const deleted=store.setTrash(meta.id,saved.revision,true);
  assert.ok(deleted.trashedAt);
  assert.equal(store.read(meta.id),null);
  assert.deepEqual(store.list(),[]);
  assert.deepEqual(store.listNotices(10,recipient),[]);
  assert.throws(()=>store.readNotice(notice.id,0,30,recipient),/找不到/);
  assert.throws(()=>store.ack(notice.id,recipient),/找不到/);
  assert.throws(()=>store.readSentences(meta.id,0,1),/找不到/);
  assert.throws(()=>store.editDraft({requestId:'trashed-edit',draftId:meta.id,expectedRevision:deleted.revision,
    edits:[{sentence:0,original:'原句。',opinion:'AI 建议'}]},recipient),/找不到/);
  assert.throws(()=>store.saveBrowser(saved,current.draft),/已删除/);
  store.migrate(saved,current.draft);
  assert.equal(store.list(true).length,1);
  const restored=store.setTrash(meta.id,deleted.revision,false);
  assert.equal(restored.trashedAt,undefined);
  assert.equal(store.list(true).length,0);
  assert.deepEqual(store.read(meta.id).draft.notes,current.draft.notes);
  assert.equal(store.readNotice(notice.id,0,30,recipient).changes[0].effective,'改稿。');
});

test('permanent purge removes data, compacts the database, and prevents replay',t=>{
  const dir=mkdtempSync(join(tmpdir(),'diffwrite-store-test-')),s=openStore(dir);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const original={requestId:'purge-test',title:'大稿',text:'甲'.repeat(100000)+'。',format:'plain'};
  const big=s.publish(original);
  const keep=s.publish({requestId:'keep-test',title:'保留',text:'保留。',format:'plain'});
  const recipient=s.createConnection("AI");
  const review={requestId:'purge-review',draftId:big.id,expectedRevision:big.revision,edits:[{sentence:0,original:original.text,opinion:'AI 意见'}]};
  s.editDraft(review,recipient);
  const record=s.read(big.id);
  record.draft.notes[0]={opinion:'测试意见',revision:''};
  const saved=s.saveBrowser(record.meta,record.draft);
  const notice=s.notify(big.id,saved.revision,recipient);
  const inspector=new DatabaseSync(join(dir,'review.sqlite'));
  inspector.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  inspector.close();
  const before=statSync(join(dir,'review.sqlite')).size;
  assert.throws(()=>s.purge([{id:big.id,revision:saved.revision}]),/回收站/);
  const deleted=s.setTrash(big.id,saved.revision,true);
  assert.throws(()=>s.purge([{id:big.id,revision:deleted.revision},{id:keep.id,revision:keep.revision}]),/回收站/);
  assert.equal(s.list(true).length,1);
  const {ids,compacted}=s.purge([{id:big.id,revision:deleted.revision}]);
  assert.deepEqual(ids,[big.id]);assert.equal(compacted,true);
  assert.ok(statSync(join(dir,'review.sqlite')).size<before);
  assert.equal(s.read(big.id,true),null);
  assert.equal(s.list(true).length,0);
  assert.throws(()=>s.readNotice(notice.id,0,30,recipient),/找不到/);
  assert.throws(()=>s.publish(original),/已彻底删除/);
  assert.throws(()=>s.editDraft(review,recipient),/已彻底删除/);
  s.migrate(big,createDraft('旧稿','不能复活。'));
  assert.equal(s.read(big.id,true),null);
  assert.deepEqual(s.list().map(x=>x.id),[keep.id]);
});

test('opinion auto-apply is effective, reversible and preserves both feedback sides',t=>{
  const s=setup(t),recipient=s.createConnection('审稿 AI');
  const meta=s.publish({requestId:'feedback-draft',title:'补全',text:'第一句。可它们走得不对。最后一句。'});
  let record=s.read(meta.id);
  record.draft.notes[1]={opinion:'不需要拟人',revision:''};
  let saved=s.saveBrowser(record.meta,record.draft);
  const settings=s.saveOpinionSettings({baseUrl:'http://127.0.0.1:1234/v1',model:'fixture',apiKey:'fixture-secret',prompt:'判断要具体'});
  assert.equal(settings.hasKey,true);
  assert.equal(settings.apiKey,undefined);
  const ask=()=>s.prepareOpinion(meta.id,{sentence:1,prefix:'不需要拟人',revision:saved.revision});
  const input=ask();
  assert.deepEqual(input.input.before,['第一句。']);
  assert.deepEqual(input.input.after,['最后一句。']);
  assert.equal(input.config.apiKey,'fixture-secret');
  const {run}=s.finishOpinion(meta.id,1,input,'，直接说方向。');
  assert.equal(s.prepareOpinion(meta.id,{sentence:1,prefix:'不需要拟人',revision:saved.revision}),null);
  record=s.decideOpinion(meta.id,{runId:run.id,action:'auto',revision:saved.revision});
  assert.equal(record.draft.notes[1].opinion,'不需要拟人');
  assert.equal(annotatedChanges(record.draft),'可它们走得不对。 <意见：不需要拟人，直接说方向。>');
  assert.equal(s.readSentences(meta.id,1,1).sentences[0].effectiveOpinion,'不需要拟人，直接说方向。');
  const first=s.notify(meta.id,record.meta.revision,recipient);
  assert.equal(s.readNotice(first.id,0,10,recipient).changes[0].opinion,'不需要拟人，直接说方向。');
  record=s.decideOpinion(meta.id,{runId:run.id,action:'reject',revision:record.meta.revision});
  assert.deepEqual(record.draft.notes[1],{opinion:'不需要拟人',revision:''});
  const second=s.notify(meta.id,record.meta.revision,recipient);
  assert.equal(s.readNotice(second.id,0,10,recipient).changes[0].opinion,'不需要拟人');
  const data=s.opinionFeedback(), sample=data.examples[0];
  assert.equal(sample.state,'rejected');
  assert.equal(sample.input.prefix,'不需要拟人');
  assert.equal(sample.suffix,'，直接说方向。');
  assert.equal(sample.outcome.finalOpinion,'不需要拟人');
  assert.equal(data.prompts[sample.promptVersion],'判断要具体');
  assert.doesNotMatch(JSON.stringify(data),/fixture-secret/);
  record.draft.notes[1].opinion='不需要拟人，方向改得更具体。';
  const edited=s.saveBrowser(record.meta,record.draft);
  assert.equal(s.opinionFeedback().examples[0].outcome.afterUserEdit,'不需要拟人，方向改得更具体。');
  assert.equal(s.opinionFeedback().examples[0].outcome.humanAtDecision,'不需要拟人');
  const trash=s.setTrash(meta.id,edited.revision,true);
  s.purge([{id:meta.id,revision:trash.revision}]);
  assert.deepEqual(s.opinionFeedback().examples,[]);
});

test('stale completion cannot replace newer input; keeping the current model key is host-bound',t=>{
  const s=setup(t);
  const meta=s.publish({requestId:'stale-opinion',title:'草稿',text:'她看着天。'});
  s.saveOpinionSettings({baseUrl:'http://127.0.0.1:1234/v1',model:'fixture',apiKey:'fixture-secret'});
  const req={sentence:0,prefix:'',revision:meta.revision,manual:true};
  const prepared=s.prepareOpinion(meta.id,req);
  const {run}=s.finishOpinion(meta.id,0,prepared,'先说她看见什么。');
  const draft=s.read(meta.id).draft;
  draft.notes[0]={opinion:'这里看天不重复',revision:''};
  const saved=s.saveBrowser(meta,draft);
  assert.deepEqual(s.currentOpinions(meta.id),[]);
  assert.throws(()=>s.decideOpinion(meta.id,{runId:run.id,action:'accept',revision:saved.revision}),/已经处理/);
  assert.equal(s.opinionFeedback().examples[0].state,'superseded');
  assert.equal(s.opinionFeedback().examples[0].outcome.finalOpinion,'这里看天不重复');
  assert.equal(s.finishOpinion(meta.id,0,prepared,'另一条迟到的建议').run,null);
  assert.equal(s.read(meta.id).draft.notes[0].opinion,'这里看天不重复');
  const updated=s.saveOpinionSettings({baseUrl:'http://127.0.0.1:4321/v1',model:'fixture'});
  assert.equal(updated.hasKey,false);
});

test('valid connections can edit directly while preserving originals and simultaneous human typing',t=>{
  const s=setup(t), a=s.createConnection('写作'), b=s.createConnection('普通');
  const meta=s.publish({requestId:'auto-original',title:'原稿',text:'原句。下句。'});
  const old=s.read(meta.id);
  const request={requestId:'auto-edit',draftId:meta.id,expectedRevision:meta.revision,title:'新标题',
    edits:[{sentence:0,original:'原句。',replacement:'AI 改写。',opinion:'AI 意见'},{sentence:1,original:'下句。',deleted:true}]};
  assert.throws(()=>s.editDraft(request,'unknown-connection'),/找不到/);
  assert.equal(typeof s.automationOpinion(b).prompt,'string');
  const patched=s.editDraft(request,a);
  assert.deepEqual(s.editDraft(request,a),patched);
  assert.equal(s.read(meta.id).draft.source,'原句。下句。');
  assert.deepEqual(s.read(meta.id).draft.aiMarks,{0:{opinion:0,body:true},1:{body:true}});
  old.draft.notes[0]={opinion:'我的意见',revision:''};
  const combined=s.saveBrowser(old.meta,old.draft,true);
  assert.equal(combined.draft.name,'新标题');
  assert.deepEqual(combined.draft.notes[0],{opinion:'我的意见\n\nAI：AI 意见',revision:'AI 改写。'});
  assert.equal(combined.draft.notes[1].deleted,true);
  assert.deepEqual(combined.draft.aiMarks,{0:{body:true,opinion:4},1:{body:true}});
  assert.ok(combined.meta.aiReview&&combined.meta.humanReview);
  assert.throws(()=>s.editDraft({...request,requestId:'stale'},a),/已有更新/);
  combined.draft.notes[0].revision='人工继续改写。';
  const human=s.saveBrowser(combined.meta,combined.draft,true);
  const conflict=s.editDraft({...request,requestId:'human-conflict',expectedRevision:human.meta.revision,
    edits:[{sentence:0,original:'原句。',replacement:'不要覆盖人工。'}]},a);
  assert.equal(conflict.keptHuman.length,1);
  assert.deepEqual(s.read(meta.id).draft.notes[0],{opinion:'我的意见\n\nAI：AI 意见\n建议改为：不要覆盖人工。',revision:'人工继续改写。'});
  s.revoke(a);
  assert.throws(()=>s.editDraft(request,a),/找不到/);
});

test('automation settings can apply and restore prompts without touching the credential',t=>{
  const s=setup(t), a=s.createConnection('调试');
  const before=s.saveOpinionSettings({baseUrl:'http://127.0.0.1:1234/v1',model:'fixture',apiKey:'private-key',prompt:'原提示词'});
  assert.equal(typeof s.automationOpinion(a).prompt,'string');
  const initial=s.automationOpinion(a);
  assert.equal(initial.apiKey,undefined);
  assert.equal(initial.baseUrl,undefined);
  const applied=s.setAutomationOpinion(a,{expectedRevision:initial.settingsRevision,prompt:'改版提示词'});
  assert.equal(s.opinionSettings().prompt,'改版提示词');
  assert.throws(()=>s.saveOpinionSettings({...before,expectedRevision:initial.settingsRevision}),/已更新/);
  assert.deepEqual(s.promptVersions(a,0,10).versions.slice(0,2).map(x=>x.preview),['改版提示词','原提示词']);
  const restored=s.setAutomationOpinion(a,{expectedRevision:applied.settingsRevision,restoreVersion:initial.promptVersion});
  assert.equal(restored.prompt,'原提示词');
  const draft=s.publish({requestId:'preview-draft',title:'试稿',text:'原句。'});
  const preview=s.previewOpinion(a,{draftId:draft.id,sentence:0,prompt:'仅试跑'});
  assert.equal(preview.config.apiKey,'private-key');
  assert.equal(preview.config.prompt,'仅试跑');
  assert.equal(s.automationOpinion(a).prompt,'原提示词');
});
