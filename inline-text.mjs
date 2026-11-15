// The current sentence is a normal inline text run, not an atomic textarea box.
// Keep the editing controller's text/selection contract while using DOM ranges.
export function setupInlineText(element){
  let caret=[0,0,'none'],readonly=false;
  const contains=node=>node===element||element.contains(node);
  const point=at=>{
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    let last=null;
    for(let node;(node=walker.nextNode());){
      last=node;
      if(at<=node.length)return [node,at];
      at-=node.length;
    }
    if(last)return [last,last.length];
    const node=document.createTextNode('');element.prepend(node);return [node,0];
  };
  const offset=(node,at)=>{
    const range=document.createRange();range.selectNodeContents(element);range.setEnd(node,at);
    return range.toString().length;
  };
  const selection=()=>{
    const s=window.getSelection();
    if(s?.rangeCount&&contains(s.anchorNode)&&contains(s.focusNode)){
      const a=offset(s.anchorNode,s.anchorOffset),b=offset(s.focusNode,s.focusOffset);
      caret=[Math.min(a,b),Math.max(a,b),a>b?'backward':a<b?'forward':'none'];
    }
    return caret;
  };
  const setRange=(a,b=a,direction='none')=>{
    const length=element.textContent.length;
    a=Math.max(0,Math.min(a,length));b=Math.max(a,Math.min(b,length));
    caret=[a,b,direction];
    const from=point(direction==='backward'?b:a),to=point(direction==='backward'?a:b);
    window.getSelection().setBaseAndExtent(...from,...to);
  };
  const sentinel=()=>{
    const mark=element.querySelector('[data-caret-end]');
    if(element.textContent===''||element.textContent.endsWith('\n')){
      if(!mark){const br=document.createElement('br');br.dataset.caretEnd='';element.append(br);}
    }else mark?.remove();
  };
  Object.defineProperties(element,{
    value:{get:()=>element.textContent,set:value=>{
      element.replaceChildren(document.createTextNode(value.replace(/\r\n?/g,'\n')));
      caret=caret.map((v,i)=>i<2?Math.min(v,element.textContent.length):v);sentinel();
    }},
    selectionStart:{get:()=>selection()[0]},
    selectionEnd:{get:()=>selection()[1]},
    selectionDirection:{get:()=>selection()[2]},
    readOnly:{get:()=>readonly,set:value=>{
      const next=Boolean(value),mode=next?'false':'plaintext-only';
      if(readonly===next&&element.contentEditable===mode)return;
      readonly=next;element.contentEditable=mode;
      element.setAttribute('aria-readonly',String(readonly));
    }}
  });
  element.setSelectionRange=setRange;
  element.setRangeText=(text,a=selection()[0],b=selection()[1],mode='preserve')=>{
    const old=element.textContent,previous=selection().slice(),end=a+text.length;
    element.value=old.slice(0,a)+text+old.slice(b);
    if(mode==='end')setRange(end);
    else if(mode==='start')setRange(a);
    else if(mode==='select')setRange(a,end);
    else setRange(previous[0]<=a?previous[0]:end,previous[1]<=a?previous[1]:end,previous[2]);
  };
  element.readOnly=false;
  element.addEventListener('beforeinput',event=>{
    if(readonly){event.preventDefault();return;}
  });
  element.addEventListener('input',()=>{sentinel();selection();});
  document.addEventListener('selectionchange',()=>{if(document.activeElement===element)selection();});
}
