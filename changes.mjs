const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const tokens=text=>Array.from(graphemes.segment(text),part=>part.segment);

// Return insertion ranges in the new string, plus deleted text at new-string offsets.
export function fineChanges(before,after){
  if(before===after)return {added:[],removed:[]};
  const old=tokens(before), next=tokens(after);
  let prefix=0,oldEnd=old.length,newEnd=next.length;
  while(prefix<oldEnd&&prefix<newEnd&&old[prefix]===next[prefix])prefix++;
  while(oldEnd>prefix&&newEnd>prefix&&old[oldEnd-1]===next[newEnd-1]){oldEnd--;newEnd--;}
  let at=next.slice(0,prefix).join('').length;
  const a=old.slice(prefix,oldEnd), b=next.slice(prefix,newEnd);
  const added=[],removed=[];
  const put=(text)=>{
    const end=at+text.length;
    if(added.at(-1)?.[1]===at)added.at(-1)[1]=end;else added.push([at,end]);
    at=end;
  };
  const drop=text=>{
    if(removed.at(-1)?.at===at)removed.at(-1).text+=text;
    else removed.push({at,text});
  };
  // Keep pathological pasted passages bounded; the common prefix/suffix are still exact.
  if(!a.length || !b.length || a.length*b.length>350000){
    if(a.length)drop(a.join(''));
    if(b.length)put(b.join(''));
    return {added,removed};
  }
  const width=b.length+1;
  const lcs=new Uint32Array((a.length+1)*width);
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--){
    const p=i*width+j;
    lcs[p]=a[i]===b[j]?1+lcs[p+width+1]:Math.max(lcs[p+width],lcs[p+1]);
  }
  let i=0,j=0;
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i]===b[j]){at+=b[j++].length;i++;}
    else if(i<a.length&&(j===b.length||lcs[(i+1)*width+j]>=lcs[i*width+j+1]))drop(a[i++]);
    else put(b[j++]);
  }
  return {added,removed};
}
