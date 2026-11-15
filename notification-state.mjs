import {reviewMark,original} from './model.mjs';
import {shiftReviewRanges} from './editor-text.mjs';

const empty={opinion:'',revision:''};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const body=n=>({revision:n?.revision??'',...(n?.deleted?{deleted:true}:{})});
export function unionRanges(ranges){
  const out=[];
  for(const [a,b] of [...ranges].sort((x,y)=>x[0]-y[0])){
    const last=out.at(-1);
    if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);
  }
  return out;
}
export function subtractRanges(left,right){
  const out=[],cuts=unionRanges(right);
  for(const [a,b] of unionRanges(left)){
    let cursor=a;
    for(const [x,y] of cuts){if(y<=cursor)continue;if(x>=b)break;
      if(x>cursor)out.push([cursor,x]);cursor=Math.max(cursor,y);if(cursor>=b)break;}
    if(cursor<b)out.push([cursor,b]);
  }
  return out;
}
export const reviewSnapshot=d=>({
  effective:true,
  notes:Object.fromEntries(Object.keys(d.notes).map(i=>[i,reviewMark(d,Number(i))])),
  gaps:d.omittedGaps??[],insertions:d.insertions??[],insertedSlots:d.insertedSlots??[]
});
export function effectiveSnapshot(known,draft){
  if(known.effective)return known;
  return {...known,effective:true,notes:Object.fromEntries(Object.entries(known.notes).map(([i,n])=>[i,{
    opinion:n.opinion?.trim()?n.opinion:'',
    revision:!n.deleted&&(n.revision?.trim()||n.literalWhitespace)&&n.revision!==original(draft,+i)?n.revision:'',
    ...(n.deleted?{deleted:true}:{})
  }]))};
}
export function shiftSnapshot(known,step,reverse){
  const {at,count,anchor,length}=step,from=at+(reverse?count:0),delta=reverse?-count:count;
  const remap=i=>reverse&&i>=at&&i<from?null:i>=from?i+delta:i;
  return {...known,
    notes:Object.fromEntries(Object.entries(known.notes).flatMap(([i,n])=>remap(+i)===null?[]:[[remap(+i),n]])),
    gaps:shiftReviewRanges(known.gaps??[],anchor,length,reverse),
    insertions:shiftReviewRanges(known.insertions??[],anchor,length,reverse),
    insertedSlots:(known.insertedSlots??[]).map(remap).filter(i=>i!==null)};
}
// Suppress this import operation only, not unrelated, still-unsent author edits.
export function importNotificationPatch(before,after,step,oldKnown){
  const mapped=shiftSnapshot(effectiveSnapshot(oldKnown,before),step,false),next=structuredClone(mapped);
  const {at,count,anchor,length}=step;
  for(let i=0;i<before.spans.length;i++){
    const j=i<at?i:i+count,old=reviewMark(before,i),now=reviewMark(after,j);
    const known=next.notes[j]??empty,n={...known};
    if(old.opinion!==now.opinion&&known.opinion===old.opinion)n.opinion=now.opinion;
    if(!same(body(old),body(now))&&same(body(known),body(old))){
      n.revision=now.revision;if(now.deleted)n.deleted=true;else delete n.deleted;
    }
    if(!same(n,known))next.notes[j]=n;
  }
  for(let i=at;i<at+count;i++)next.notes[i]=reviewMark(after,i);
  const oldGaps=shiftReviewRanges(before.omittedGaps??[],anchor,length);
  next.gaps=unionRanges([...subtractRanges(next.gaps,subtractRanges(oldGaps,after.omittedGaps??[])),
    ...subtractRanges(after.omittedGaps??[],oldGaps)]);
  next.insertions=unionRanges([...next.insertions,[anchor,anchor+length]]);
  next.insertedSlots=[...new Set([...next.insertedSlots,...(after.insertedSlots??[]).filter(i=>i>=at&&i<at+count)])].sort((a,b)=>a-b);
  const fields=[];
  for(const i of new Set([...Object.keys(mapped.notes),...Object.keys(next.notes)])){
    const a=mapped.notes[i]??empty,b=next.notes[i]??empty;
    if(a.opinion!==b.opinion)fields.push({i:+i,field:'opinion',before:a.opinion,after:b.opinion});
    if(!same(body(a),body(b)))fields.push({i:+i,field:'body',before:body(a),after:body(b)});
  }
  const ranges={};
  for(const key of ['gaps','insertions'])ranges[key]={added:subtractRanges(next[key],mapped[key]),removed:subtractRanges(mapped[key],next[key])};
  return {fields,ranges,slots:next.insertedSlots.filter(i=>!mapped.insertedSlots.includes(i))};
}
// Replay only the import's baseline patch. Notifications sent since the paste
// may advance other fields; undo must not restore a whole stale snapshot.
export function applyImportPatch(known,patch,reverse=false){
  const next=structuredClone(known);
  for(const p of patch.fields){
    const expected=reverse?p.after:p.before,value=reverse?p.before:p.after,n={...(next.notes[p.i]??empty)};
    if(p.field==='opinion'){if(n.opinion!==expected)continue;n.opinion=value;}
    else{if(!same(body(n),expected))continue;n.revision=value.revision;if(value.deleted)n.deleted=true;else delete n.deleted;}
    next.notes[p.i]=n;
  }
  for(const [key,p] of Object.entries(patch.ranges))next[key]=unionRanges([
    ...subtractRanges(next[key]??[],reverse?p.added:p.removed),...(reverse?p.removed:p.added)]);
  next.insertedSlots=reverse?(next.insertedSlots??[]).filter(i=>!patch.slots.includes(i)):
    [...new Set([...(next.insertedSlots??[]),...patch.slots])].sort((a,b)=>a-b);
  return next;
}
