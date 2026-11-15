import {original,revised,modified,revisedText} from './model.mjs';

// Visible text is projected from immutable source spans and their review notes.
export function editorLayout(draft) {
  const parts=[], sentences=[];
  let offset=0, sourceEnd=0, omitted=0;
  const gaps=draft.omittedGaps??[];
  function append(text,props) {
    const part={...props,text,start:offset,end:offset+text.length};
    parts.push(part);offset=part.end;
    return part;
  }
  function gap(from,to) {
    while(omitted<gaps.length&&gaps[omitted][1]<=from)omitted++;
    let cursor=from;
    while(omitted<gaps.length) {
      const [a,b]=gaps[omitted];
      if(a>=to)break;
      if(a>cursor){
        const end=Math.min(a,to);
        append(draft.source.slice(cursor,end),{sourceStart:cursor});
        cursor=end;
      }
      if(b<=to){cursor=Math.max(cursor,b);omitted++;continue;}
      // This omitted range crosses a sentence/slot boundary. Keep it active
      // so the next source-gap segment also omits its remaining suffix.
      cursor=to;
      break;
    }
    if(cursor<to)append(draft.source.slice(cursor,to),{sourceStart:cursor});
  }
  for(const [i,[a,b]] of draft.spans.entries()) {
    gap(sourceEnd,a);
    sentences.push(append(revised(draft,i),{i}));
    sourceEnd=b;
  }
  gap(sourceEnd,draft.source.length);
  return {parts,sentences,text:parts.map(x=>x.text).join('')};
}

export const textareaText=text=>text.replace(/\r\n?/g,'\n');

export function rawOffset(text,at) {
  let raw=0;
  for(let i=0;i<at&&raw<text.length;i++,raw++)if(text[raw]==='\r'&&text[raw+1]==='\n')raw++;
  return raw;
}

export function textEdit(before,after,hint) {
  if(before===after)return null;
  if(hint) {
    const [start,end]=hint, size=after.length-before.length+end-start;
    if(size>=0&&before.slice(0,start)===after.slice(0,start)&&before.slice(end)===after.slice(start+size))
      return [start,end,after.slice(start,start+size)];
  }
  let a=0,b=before.length,c=after.length;
  while(a<b&&a<c&&before[a]===after[a])a++;
  while(b>a&&c>a&&before[b-1]===after[c-1]){b--;c--;}
  return [a,b,after.slice(a,c)];
}

export function sentenceAt(layout,offset) {
  return (layout.sentences.find(p=>p.end>offset)??layout.sentences.at(-1))?.i??null;
}

export function spliceEditorText(draft,layout,start,end,insert,preferredIndex) {
  const {sentences,parts,text}=layout;
  const updates=new Map(), ranges=[...(draft.omittedGaps??[])];
  if(start===end&&!insert)return {updates,gaps:ranges};
  let owner;
  if(insert) {
    if(preferredIndex!==undefined){
      owner=sentences.find(p=>p.i===preferredIndex);
      if(!owner)throw new RangeError('编辑的句块已变化。');
    }else{
      const touched=sentences.find(p=>p.start<end&&p.end>start&&p.text);
      const right=sentences.find(p=>p.end>start&&p.text);
      const left=sentences.findLast(p=>p.start<start&&p.text);
      owner=touched??(left?.end===start?left:right)??left??sentences[0];
      if(owner.end<start) {
        insert=text.slice(owner.end,start)+insert;start=owner.end;
      } else if(owner.start>end) {
        insert+=text.slice(end,owner.start);end=owner.start;
      }
    }
  }
  for(const p of parts) {
    const a=Math.max(start,p.start), b=Math.min(end,p.end);
    if(p!==owner&&a>=b)continue;
    if(p.i===undefined) {
      ranges.push([p.sourceStart+a-p.start,p.sourceStart+b-p.start]);continue;
    }
    const left=Math.min(p.text.length,Math.max(0,a-p.start));
    const right=Math.min(p.text.length,Math.max(0,b-p.start));
    const value=p.text.slice(0,left)+(p===owner?insert:'')+p.text.slice(right);
    if(value===p.text)continue;
    const note={opinion:'',revision:'',...draft.notes[p.i]};
    delete note.autoOpinion;
    if(value.length) {
      delete note.deleted;
      note.revision=value===original(draft,p.i)?'':value;
      // Empty revision means original, but whitespace from a range edit is real text.
      if(!value.trim())note.literalWhitespace=true;else delete note.literalWhitespace;
    } else {
      const keepEmptySlot=draft.insertedSlots?.includes(p.i)&&p.i===preferredIndex&&
        start>=p.start&&end<=p.end;
      if(keepEmptySlot){note.revision='';delete note.deleted;delete note.literalWhitespace;}
      else{
        if(modified(draft,p.i)&&!p.text.trim()) {note.revision='';delete note.literalWhitespace;}
        note.deleted=true;
      }
    }
    updates.set(p.i,note);
  }
  ranges.sort((a,b)=>a[0]-b[0]);
  const gaps=[];
  for(const [a,b] of ranges) {
    const last=gaps.at(-1);
    if(last&&a<=last[1])last[1]=Math.max(last[1],b);else gaps.push([a,b]);
  }
  return {updates,gaps};
}


// A structured paste inserts new sentence slots. Existing original text is never
// overwritten; only its effective revision is split if the caret is inside it.
export function insertReview(draft,fragment,start,end) {
  const layout=editorLayout(draft);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>layout.text.length)
    throw new RangeError('粘贴位置已改变，请重新选中。');
  const position=layout.parts.find(p=>p.start<=start&&p.end>start);
  const {updates,gaps}=spliceEditorText(draft,layout,start,end,'');
  let anchor=draft.source.length, suffix='';
  if(position?.sourceStart!==undefined)anchor=position.sourceStart+start-position.start;
  if(position?.i!==undefined){
    const i=position.i,[a,b]=draft.spans[i];
    anchor=start===position.start?a:b;
    if(start>position.start){
      const effective=updates.has(i)?revised({...draft,notes:{[i]:updates.get(i)}},i):position.text;
      const offset=start-position.start, prefix=effective.slice(0,offset);
      suffix=effective.slice(offset);
      if(suffix){
        const n={opinion:'',revision:'',...draft.notes[i],...updates.get(i),revision:prefix};
        delete n.deleted;delete n.autoOpinion;
        if(!prefix.trim())n.literalWhitespace=true;else delete n.literalWhitespace;
        updates.set(i,n);
      }
    }
  }
  const index=draft.spans.findIndex(([a])=>a>=anchor);
  const at=index<0?draft.spans.length:index;
  const text=fragment.source+suffix, length=text.length;
  const added=[...fragment.spans];
  if(suffix.trim()){
    const a=fragment.source.length+suffix.length-suffix.trimStart().length;
    added.push([a,fragment.source.length+suffix.trimEnd().length]);
  }
  const count=added.length;
  const remap=i=>i<at?i:i+count;
  const shift=([a,b])=>[a+anchor,b+anchor];
  const notes={},marks={};
  for(const [i,n] of Object.entries(draft.notes))notes[remap(+i)]=n;
  for(const [i,n] of updates)notes[remap(i)]=n;
  for(const [i,n] of Object.entries(fragment.notes))notes[at+Number(i)]=n;
  for(const [i,mark] of Object.entries(draft.aiMarks??{})){
    if(!updates.has(+i)){marks[remap(+i)]=mark;continue;}
    if(mark.opinion!==undefined)marks[remap(+i)]={opinion:mark.opinion};
  }
  const next={...draft,source:draft.source.slice(0,anchor)+text+draft.source.slice(anchor),notes,
    spans:[...draft.spans.slice(0,at),...added.map(shift),...draft.spans.slice(at).map(([a,b])=>[a+length,b+length])],
    insertedSlots:[...(draft.insertedSlots??[]).map(remap),...(fragment.insertedSlots??[]).map(i=>at+i)].sort((a,b)=>a-b),
    omittedGaps:[...shiftReviewRanges(gaps,anchor,length),...(fragment.omittedGaps??[]).map(shift)].sort((a,b)=>a[0]-b[0]),
    insertions:[...shiftReviewRanges(draft.insertions??[],anchor,length),[anchor,anchor+length]].sort((a,b)=>a[0]-b[0])};
  if(fragment.format==='markdown')next.format='markdown';
  if(Object.keys(marks).length)next.aiMarks=marks;else delete next.aiMarks;
  return {draft:next,at,count,anchor,length,insertedText:revisedText(fragment).length};
}

// Move source-indexed whitespace intervals without deleting the pasted text.
export function shiftReviewRanges(ranges,anchor,length,reverse=false){
  const tail=anchor+length;
  return ranges.flatMap(([a,b])=>{
    if(b<=anchor)return [[a,b]];
    if(reverse){
      if(a>=tail)return [[a-length,b-length]];
      return [...(a<anchor?[[a,anchor]]:[]),...(b>tail?[[anchor,b-length]]:[])];
    }
    if(a>=anchor)return [[a+length,b+length]];
    return [[a,anchor],[tail,b+length]];
  });
}
