const openers = new Map([['“','”'], ['‘','’'], ['「','」'], ['『','』'], ['"','"'], ["'","'"]]);
const closers = new Set(openers.values());
const strongEnds = new Set('。！？!?');
const dots = new Set('.．');
const ellipsis = new Set('…⋯');
const right = new Set('）)]】〕》〉］｝}');
const white = /\s/u;
const western = /[\p{Script=Latin}\p{Nd}]/u;
const digit = /\p{Nd}/u;
const continuation = /^[，、；：,;:。！？.!?．…⋯）)\]】〕》〉］｝}]/u;
const chineseTag = /^(?:[—–-]{1,3}\s*)?[\p{Script=Han}]{0,8}(?:说道|问道|答道|喊道|叫道|说|问|答|喊|叫|补充|提醒|低语|嘀咕)(?=[。！？，、；：!?.,;:]|$)/u;
const verbs = '(?:said|asked|answered|replied|whispered|murmured|shouted|added|cried|called|muttered|yelled|screamed|insisted|continued|said softly)';
const englishTag = new RegExp('^(?:(?:[\\p{L}]+\\s+){1,3}'+verbs+'\\b|'+verbs+'\\s+[\\p{L}])','iu');
const clearEnglishStart = /^(?:I|He|She|They|We|It|You|Then|Now|But|The|This|That|Next|However|Afterward|Later|Meanwhile)\b/u;
const title = /(?:^|[^\p{L}])(?:mr|mrs|ms|mx|dr|prof|rev|sr|jr|st|gen|capt|lt|sgt|hon|sen|rep|gov|pres|mt)\.$/iu;
const shortAbbr = /(?:^|[^\p{L}])(?:e\.g|i\.e|vs|cf|et al|approx|dept|fig|vol|ch|ref|pp)\.$/iu;
const variableAbbr = /(?:^|[^\p{L}])(?:etc|a\.m|p\.m|(?:[A-Z]\.){1,}[A-Z])\.$/u;
const netToken = /(?:\b(?:https?:\/\/|ftp:\/\/|www\.)[A-Z0-9._~:/?#@!$&()*+,;=%-]+|\b[\w.!#$%&*+/=?^{}|~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+|\b(?:[A-Z0-9-]+\.)+(?:com|org|net|edu|gov|io|cn|co|uk|sg|jp|dev|app|info|me|ai|xyz|online|museum)(?![A-Z0-9-]))/giu;

function escaped(text,index,start) {
  let n=0;
  while(index>start && text[--index]==='\\') n++;
  return n%2===1;
}
function quotePairs(text,start,end) {
  const stack=[], pairs=new Map();
  for(let i=start;i<end;i++) {
    const c=text[i];
    if(!openers.has(c) && !closers.has(c)) continue;
    if(escaped(text,i,start)) continue;
    const prev=i>start ? text[i-1] : '', next=i+1<end ? text[i+1] : '';
    const symmetric=c==='"' || c==="'";
    if ((c==="'" || c==='’') && western.test(prev) && western.test(next)) continue;
    if (closers.has(c)) {
      const k=stack.findLastIndex(q=>q.close===c);
      const afterStop = strongEnds.has(prev) || dots.has(prev) || ellipsis.has(prev) || right.has(prev);
      if (k!==-1 && (!symmetric || (prev && !white.test(prev) && (!western.test(next) || afterStop)))) {
        pairs.set(stack[k].pos,i);
        stack.length=k;
        continue;
      }
    }
    if (openers.has(c) && (!symmetric || (!western.test(prev) && next && !white.test(next)))) {
      stack.push({pos:i,close:openers.get(c)});
    }
  }
  return pairs;
}
function networkMarks(text,start,end) {
  const marked=new Set();
  for (const m of text.slice(start,end).matchAll(netToken)) {
    // Sentence punctuation at the very end of a URL is not part of its protected token.
    const body=m[0].replace(/[.,!?;:)\]]+$/u,'');
    for(let i=0;i<body.length;i++) if (dots.has(body[i]) || strongEnds.has(body[i])) marked.add(start+m.index+i);
  }
  return marked;
}
function nextWord(text,i,end) {
  while(i<end && white.test(text[i])) i++;
  return i;
}
function spokenTag(tail) {
  const clean = tail.replace(/^[—–-]{1,3}\s*/u,'');
  return chineseTag.test(tail) || englishTag.test(clean);
}
function interiorDot(text,i,start,end,next) {
  const before=i>start ? text[i-1] : '', after=i+1<end ? text[i+1] : '';
  if (digit.test(after) && (digit.test(before) || !before || white.test(before) || /[(（+\-]/u.test(before))) return true;
  const left=text.slice(Math.max(start,i-32),i+1).replaceAll('．','.');
  const tail=text.slice(next,Math.min(end,next+48));
  if (!tail) return false;
  if (title.test(left) || shortAbbr.test(left)) return true;
  if (/(?:^|[^\p{L}])nos?\.$/iu.test(left) && digit.test(text[next])) return true;
  if (variableAbbr.test(left)) return !clearEnglishStart.test(tail);
  // A spaced initial normally introduces a name: J. R. Tolkien.
  if (/(?:^|[^\p{L}])[A-Z]\.$/u.test(left) && /^\p{Lu}/u.test(tail) && !clearEnglishStart.test(tail)) return true;
  return western.test(before) && /\p{Ll}/u.test(after);
}
function terminalWithinQuote(text,from,close) {
  let i=close-1;
  while(i>from && (white.test(text[i]) || right.has(text[i]) || closers.has(text[i]))) i--;
  return strongEnds.has(text[i]) || dots.has(text[i]) || ellipsis.has(text[i]);
}

export function splitSentences(text, paragraphBreaks = null) {
  const spans = [];
  function para(start,end) {
    if (start>=end) return;
    const pairs=quotePairs(text,start,end), network=networkMarks(text,start,end);
    let from=start;
    const push=to=>{
      while(from<to && white.test(text[from])) from++;
      let stop=to;
      while(stop>from && white.test(text[stop-1])) stop--;
      if(from<stop) spans.push([from,stop]);
      from=to;
    };
    for(let i=start;i<end;i++) {
      const close=pairs.get(i);
      if(close!==undefined) {
        const terminal=terminalWithinQuote(text,i,close);
        i=close;
        const next=nextWord(text,i+1,end);
        const tail=text.slice(next,Math.min(next+64,end));
        if (terminal && !continuation.test(tail) && !spokenTag(tail)) push(i+1);
        continue;
      }
      const c=text[i];
      if(network.has(i) || (!strongEnds.has(c) && !dots.has(c) && !ellipsis.has(c))) continue;
      let stop=i+1, strong=strongEnds.has(c), runEllipsis=ellipsis.has(c);
      while(stop<end && !network.has(stop) && (strongEnds.has(text[stop]) || dots.has(text[stop]) || ellipsis.has(text[stop]))) {
        strong ||= strongEnds.has(text[stop]);
        runEllipsis ||= ellipsis.has(text[stop]);
        stop++;
      }
      runEllipsis ||= stop>i+1 && !strong;
      const next=nextWord(text,stop,end);
      if (!strong) {
        if (runEllipsis && next<end && !right.has(text[stop]) && !pairs.has(next) && !clearEnglishStart.test(text.slice(next,next+24))) {
          i=stop-1;
          continue;
        }
        if (!runEllipsis && interiorDot(text,i,start,end,next)) continue;
      }
      while(stop<end && right.has(text[stop])) stop++;
      push(stop);
      i=stop-1;
    }
    push(end);
  }
  let start=0;
  if(paragraphBreaks) {
    for(const end of paragraphBreaks) {para(start,end); start=end+1;}
  } else {
    for(const m of text.matchAll(/\r\n|[\r\n\u2028\u2029]/gu)) {
      para(start,m.index);
      start=m.index+m[0].length;
    }
  }
  para(start,text.length);
  return spans;
}

export function createDraft(name, source, paragraphBreaks = null, notices = [], options = {}) {
  if (!source.trim()) throw new Error('没有读到可审的正文。');
  return {version:1, name, source, spans:options.spans ?? splitSentences(source, paragraphBreaks), notes:{}, notices,
    ...(['markdown','plain'].includes(options.format) ? {format:options.format} : {})};
}

export function restoreDraft(raw) {
  const bad = () => {throw new Error('这不是有效的逐句审稿备份。');};
  if (!raw || raw.version !== 1 || typeof raw.name !== 'string' || typeof raw.source !== 'string' ||
      !raw.source.trim() || !Array.isArray(raw.spans) || !raw.spans.length ||
      !raw.notes || typeof raw.notes !== 'object' || Array.isArray(raw.notes)) bad();
  let last = 0;
  for (const span of raw.spans) {
    if (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isSafeInteger)) bad();
    const [a,b] = span;
    if (a < last || b <= a || b > raw.source.length || raw.source.slice(last,a).trim() ||
        !raw.source.slice(a,b).trim()) bad();
    last = b;
  }
  if (raw.source.slice(last).trim()) bad();
  const notes = {};
  for (const [key, value] of Object.entries(raw.notes)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || +key >= raw.spans.length || !value ||
        typeof value.opinion !== 'string' || typeof value.revision !== 'string') bad();
    const auto=value.autoOpinion;
    notes[key] = {opinion:value.opinion, revision:value.revision, ...(value.deleted === true ? {deleted:true} : {}),
      ...(auto&&typeof auto.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(auto.id)&&typeof auto.suffix==='string'&&auto.suffix.trim()&&auto.suffix.length<=600
        ?{autoOpinion:{id:auto.id,suffix:auto.suffix}}:{})};
  }
  const omittedGaps=[];
  if(raw.omittedGaps!==undefined){
    if(!Array.isArray(raw.omittedGaps))bad();
    let end=0,index=0;
    for(const gap of raw.omittedGaps){
      if(!Array.isArray(gap)||gap.length!==2||!gap.every(Number.isSafeInteger))bad();
      const [a,b]=gap;
      if(a<end||a>=b||b>raw.source.length||raw.source.slice(a,b).trim())bad();
      while(index<raw.spans.length&&raw.spans[index][1]<=a)index++;
      if(raw.spans[index]?.[0]<b)bad();
      omittedGaps.push([a,b]);end=b;
    }
  }
  const aiMarks={};
  for(const [i,rev] of Object.entries(raw.aiMarks??{}))if(/^(0|[1-9]\d*)$/.test(i)&&Number(i)<raw.spans.length&&Number.isSafeInteger(rev)&&rev>0)aiMarks[i]=rev;
  const notices = Array.isArray(raw.notices) ? raw.notices.filter(x => typeof x === 'string') : [];
  return {version:1, name:raw.name, source:raw.source, spans:raw.spans, notes, notices,
    ...(omittedGaps.length?{omittedGaps}:{}),
    ...(Object.keys(aiMarks).length?{aiMarks}:{}),
    ...(['markdown','plain'].includes(raw.format) ? {format:raw.format} : {})};
}

export const original = (d,i) => d.source.slice(...d.spans[i]);
export const deleted = (d,i) => d.notes[i]?.deleted === true;
export const modified = (d,i) => {
  if (deleted(d,i)) return true;
  const rev = d.notes[i]?.revision;
  return Boolean(rev?.trim() && rev !== original(d,i));
};
export const revised = (d,i) => deleted(d,i) ? '' : modified(d,i) ? d.notes[i].revision : original(d,i);

export function* pieces(d, useRevisions = false) {
  let end = 0;
  for (const [i,[a,b]] of d.spans.entries()) {
    if (a > end) {const gap=d.source.slice(end,a);yield [null,useRevisions?deletedGap(gap,end,d,false):gap];}
    yield [i, useRevisions ? revised(d,i) : original(d,i)];
    end = b;
  }
  if (end < d.source.length) {const gap=d.source.slice(end);yield [null,useRevisions?deletedGap(gap,end,d,false):gap];}
}

export const revisedText = d => Array.from(pieces(d,true), p => p[1]).join('');

const escapedMarkup = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const decodedMarkup = value => value.replace(/&(amp|lt|gt);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>'})[entity]);

function deletionOnly(source,value) {
  if (source===value || !value) return null;
  const target=Array.from(value), chunks=[];
  let index=0, run='';
  for(const char of source){
    if(char===target[index]){
      if(run) {chunks.push('<del>'+run+'</del>');run='';}
      chunks.push(char);index++;
    }else run+=char;
  }
  if(index!==target.length)return null;
  if(run)chunks.push('<del>'+run+'</del>');
  return chunks.join('');
}
function deletedGap(text,offset,draft,tagged){
  let out='', pos=0;
  for(const [a,b] of draft.omittedGaps??[]){
    if(b<=offset)continue;
    if(a>=offset+text.length)break;
    const from=Math.max(a-offset,0),to=Math.min(b-offset,text.length);
    out+=text.slice(pos,from)+(tagged?'<del>'+text.slice(from,to)+'</del>':'');
    pos=to;
  }
  return out+text.slice(pos);
}
export const effectiveOpinion=(d,i)=>(d.notes[i]?.opinion??'')+(d.notes[i]?.autoOpinion?.suffix??'');
export function reviewMark(d,i){
  const n=d.notes[i];
  const combined=effectiveOpinion(d,i),opinion=combined.trim()?combined:'';
  return deleted(d,i)?{opinion,revision:'',deleted:true}:
    {opinion,revision:modified(d,i)?n.revision:''};
}
export const hasReviewMark=n=>Boolean(n.opinion || n.revision || n.deleted);
function annotatedSentence(text,mark,opinions){
  const comment=opinions.length?' <意见：'+escapedMarkup(opinions.join('\n'))+'>':'';
  if(mark.deleted)return '<del>'+text+'</del>'+comment;
  if(!mark.revision)return text+comment;
  const inline=deletionOnly(text,mark.revision);
  return inline!==null?inline+comment:text+comment+' <改为：'+escapedMarkup(mark.revision)+'>';
}
function* annotatedPieces(d,suggestions,onlyChanges=false){
  const accepted=new Map();
  for(const s of suggestions)if(s.state==='accepted'&&s.opinion?.trim()){
    const list=accepted.get(s.sentence)??[];
    list.push('AI：'+s.opinion);accepted.set(s.sentence,list);
  }
  let offset=0;
  for(const [i,text] of pieces(d)){
    const at=offset;offset+=text.length;
    if(i===null){yield onlyChanges?{gap:[at,offset]}:{text:deletedGap(text,at,d,true)};continue;}
    const mark=reviewMark(d,i), opinions=[...(mark.opinion?[mark.opinion]:[]),...(accepted.get(i)??[])];
    const changed=hasReviewMark(mark)||opinions.length;
    if(!onlyChanges||changed)yield {text:annotatedSentence(text,mark,opinions)};
  }
}
export function annotatedText(d,suggestions=[]){
  return Array.from(annotatedPieces(d,suggestions),p=>p.text).join('');
}
export function annotatedChanges(d,suggestions=[]){
  const changed=[], gaps=d.omittedGaps??[];
  let k=0;
  for(const piece of annotatedPieces(d,suggestions,true)){
    if(piece.text!==undefined)changed.push(piece.text);
    if(!piece.gap)continue;
    const [start,end]=piece.gap;
    while(k<gaps.length&&gaps[k][0]<end){
      const [a,b]=gaps[k++];
      if(a>=start)changed.push('<del>'+d.source.slice(a,b)+'</del>');
    }
  }
  return changed.join('\n');
}
export function parseAnnotated(input){
  const matches=[...input.matchAll(/<del>|<\/del>|[ \t]?<(意见|改为)[：:]([^>]*)>|【(意见|改版)[：:]([^】]*)】|【删除】/gu)];
  if(!matches.length)return {source:input,markers:[],removed:[]};
  const valid=new Set(),stack=[];
  for(const m of matches){
    if(m[0]==='<del>')stack.push(m.index);
    else if(m[0]==='</del>'&&stack.length){valid.add(stack.pop());valid.add(m.index);}
  }
  let source='',last=0,depth=0,start=0;
  const markers=[],removed=[];
  for(const m of matches){
    const token=m[0];
    if((token==='<del>'||token==='</del>')&&!valid.has(m.index))continue;
    source+=input.slice(last,m.index);
    last=m.index+token.length;
    if(token==='<del>'){if(depth++===0)start=source.length;}
    else if(token==='</del>'){if(--depth===0&&start<source.length)removed.push([start,source.length]);}
    else if(token==='【删除】')markers.push({at:source.length,key:'deleted',value:true});
    else markers.push({at:source.length,key:(m[1]??m[3])==='意见'?'opinion':'revision',
      value:m[1]?decodedMarkup(m[2]):m[4]});
  }
  return {source:source+input.slice(last),markers,removed};
}
export function applyImportedEdits(d,edits){
  if(!edits.markers.length&&!edits.removed.length)return d;
  function set(i,key,value){
    const n=d.notes[i]??={opinion:'',revision:''};
    if(key==='opinion'&&n.opinion) n.opinion+='\n'+value;
    else n[key]=value;
  }
  const gaps=[];
  for(const [from,to] of edits.removed){
    let cursor=from;
    for(const [i,[a,b]] of d.spans.entries()){
      if(b<=from)continue;
      if(a>=to)break;
      if(cursor<Math.min(a,to))gaps.push([cursor,Math.min(a,to)]);
      cursor=Math.min(b,to);
    }
    if(cursor<to)gaps.push([cursor,to]);
  }
  if(gaps.length)d.omittedGaps=gaps;
  for(const [i,[a,b]] of d.spans.entries()){
    const ranges=edits.removed.filter(([from,to])=>to>a&&from<b).map(([from,to])=>[Math.max(a,from)-a,Math.min(b,to)-a]);
    if(ranges.length)d.notes[i]=deleteTextRanges(d,i,ranges,false);
  }
  for(const marker of edits.markers){
    const index=d.spans.findLastIndex(([a])=>a<marker.at);
    if(index>=0)set(index,marker.key,marker.value);
  }
  return d;
}

export function deleteTextRanges(d,i,ranges,useRevision) {
  const source = useRevision ? revised(d,i) : original(d,i);
  const existing = d.notes[i] ?? {opinion:'',revision:''};
  if (!source || !ranges.length) return existing;
  const ordered = [...ranges].sort((a,b)=>a[0]-b[0]);
  let end = 0, result = '';
  for (const [a,b] of ordered) {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a<end || b<=a || b>source.length) throw new RangeError('删除范围已改变。');
    result += source.slice(end,a);
    end = b;
  }
  result += source.slice(end);
  return result.trim() ? {...existing,revision:result} : {...existing,deleted:true};
}

// Replay edits made against base over the latest record. The caller determines when
// this is safe; overlapping fields take the local author's value.
export function mergeDraftEdits(base,local,latest){
  const result={...latest,notes:{...latest.notes}};
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  for(const key of ['name','format','notices','omittedGaps']){
    if(!equal(base[key],local[key])){
      if(local[key]===undefined)delete result[key];else result[key]=local[key];
    }
  }
  for(const i of new Set([...Object.keys(base.notes),...Object.keys(local.notes)])){
    const a=base.notes[i]??{}, b=local.notes[i]??{}, c={opinion:'',revision:'',...latest.notes[i]};
    if((a.opinion??'')!==(b.opinion??''))c.opinion=b.opinion??'';
    if((a.revision??'')!==(b.revision??'')||Boolean(a.deleted)!==Boolean(b.deleted)){
      c.revision=b.revision??'';
      if(b.deleted)c.deleted=true;else delete c.deleted;
    }
    if(!equal(a.autoOpinion,b.autoOpinion)){
      if(b.autoOpinion)c.autoOpinion=b.autoOpinion;else delete c.autoOpinion;
    }
    if(c.opinion||c.revision||c.deleted||c.autoOpinion)result.notes[i]=c;else delete result.notes[i];
  }
  return result;
}
