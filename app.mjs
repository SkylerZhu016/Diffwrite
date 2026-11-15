import {setupInlineText} from './inline-text.mjs';
import {editorLayout, textareaText, rawOffset, textEdit, sentenceAt, spliceEditorText} from './editor-text.mjs';
import {fineChanges} from './changes.mjs';
import {createDraft, restoreDraft, original, modified, revised, effectiveOpinion, mergeDraftEdits, pieces, revisedText, annotatedText, annotatedChanges, deleted, parseAnnotated, applyImportedEdits, editedOpinionMark} from './model.mjs';
import {setupOpinionUI} from './opinion-ui.mjs';
import {readDocx} from './docx.mjs';
import {saveRecord, readRecord, listRecords, listDeletedRecords, forgetPurged, recoverLegacy, migrateHistory, reviewApi, HistoryConflict} from './history.mjs';
import {markdownSpans, renderMarkdown, looksLikeMarkdown} from './markdown.mjs';

const $ = id => document.getElementById(id);
const manuscript = $('manuscript'), reading = $('reading-body'), bodyEditor=$('body-editor');
let pasteCaret=null, bodyUndo=[], bodyRedo=[], displayOffsets=new WeakMap(), displaySentences=[],renderPoints=[],ghostRanges=[];
setupInlineText(bodyEditor);
const opinion = $('opinion'), revision = $('revision'), tabs = [...document.querySelectorAll('[data-mode]')];
const legacyKey = 'diffwrite.sentence-review.v1';
let draft = null, mode = 'split', selected = null, cursor = 0, cells = new Map(), active = null;
let renderSource = false, renderTimer = 0, markdownMode = false;
let cellOffsets = new WeakMap();
let showChanges=true, changeDetail='inline';
try{
  const pref=JSON.parse(localStorage.getItem('diffwrite-changes'));
  if(typeof pref?.show==='boolean')showChanges=pref.show;
  if(['inline','full','sentence'].includes(pref?.detail))changeDetail=pref.detail;
}catch{}
let generation = 0, savedGeneration = 0, saveInFlight = null;
let timer = 0, busy = false, switching = false, paragraphPending = null;

function notice(text = '', failed = false) {
  outputStatus(text, failed);
}

function saveLabel(label, failed = false) {
  $('save-state').textContent = label;
  $('save-state').parentElement.dataset.error = failed;
  $('retry').hidden = !failed;
}
function isDirty() { return generation !== savedGeneration; }
function summarize(meta,value) {
  let opinions = 0, changes = 0;
  for (const [i,note] of Object.entries(value.notes)) {
    if (effectiveOpinion(value,Number(i)).trim()) opinions++;
    if (modified(value,Number(i))) changes++;
  }
  return {...meta, name:value.name, updatedAt:Date.now(), opinions, changes,
    preview:value.source.trimStart().slice(0,180).replace(/\s+/gu,' ').slice(0,72)};
}
function persist() {
  clearTimeout(timer);
  if (!draft || !isDirty()) return Promise.resolve(true);
  if (saveInFlight) return saveInFlight;
  const version = generation;
  saveLabel('保存中…');
  const snapshot=structuredClone(draft);
  saveInFlight = saveRecord(summarize(active,draft),snapshot)
    .then(record => {
      const next=version===generation?record.draft:mergeDraftEdits(snapshot,draft,record.draft);
      const remote=JSON.stringify([snapshot.name,snapshot.notes,snapshot.aiMarks])!==JSON.stringify([record.draft.name,record.draft.notes,record.draft.aiMarks]);
      active = record.meta;
      draft = next;
      if(remote&&!inlineEdit)paintRemoteRecord();
      savedGeneration = version;
      if (isDirty()) timer = setTimeout(persist,0);
      else saveLabel('已保存');
      if ($('history-menu').open) refreshHistory();
      return true;
    })
    .catch(error => {
      saveLabel('未保存',true);
      notice(error instanceof HistoryConflict
        ? '另一个窗口已经更新这份稿件。请先导出当前审稿备份，再刷新页面。'
        : '无法写入本地历史。可以重试，或先导出审稿备份。', true);
      return false;
    })
    .finally(() => {saveInFlight = null;});
  return saveInFlight;
}
async function flush() {
  while (isDirty()) if (!await persist()) return false;
  return true;
}
function scheduleSave() {
  generation++;
  saveLabel('保存中…');
  clearTimeout(timer);
  timer = setTimeout(persist,160);
}
$('retry').onclick = async () => {
  if (await flush()) notice();
};
document.addEventListener('visibilitychange', () => {if (document.hidden) flush();});
window.addEventListener('beforeunload', event => {
  if (!isDirty() && !paragraphPending) return;
  flush();
  event.preventDefault();
  event.returnValue = '';
});

function syncTabs() {
  for (const tab of tabs) {
    const active = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.disabled = !draft;
  }
  reading.setAttribute('aria-labelledby','tab-'+mode);
}
function isMarkdown() {
  return Boolean(draft && markdownMode);
}
const cellAt = i => cells.get(i)?.[0];
function addCell(parent,i,value,start=null) {
  if (!value && !(mode!=='source'&&draft.insertedSlots?.includes(i)&&!deleted(draft,i))) return;
  const span = document.createElement('span');
  span.className = 'sentence';
  if(!value){span.classList.add('empty-sentence');span.setAttribute('aria-label','新增段落');}
  span.dataset.index = i;
  span.dataset.changed = modified(draft,i);
  span.dataset.deleted = mode!=='source'&&deleted(draft,i);
  if (start!==null) cellOffsets.set(span,{start});
  span.dataset.selected = mode!=='source'&&i === selected;
  const ai=aiTitle(i), fresh=Boolean(draft.notes[i]?.autoOpinion||opinionUI.has(active?.id,i));
  if(ai)span.dataset.aiEdited='true';
  if(fresh)span.dataset.newOpinion='true';
  if(ai||fresh)span.title=fresh?'有新的 AI 补全意见':ai;
  if (!cells.has(i)) cells.set(i,[]);
  if (!cells.get(i).length&&mode!=='source') {
    span.setAttribute('role','button');
    span.setAttribute('aria-pressed',String(i === selected));
    span.tabIndex = -1;
    if (value && isMarkdown() && !renderSource) span.setAttribute('aria-label',original(draft,i));
  }
  cells.get(i).push(span);
  span.append(document.createTextNode(value));
  parent.append(span);
  return span.firstChild;
}
function placeEmptySentences(fragment,slots,source){
  const makeAnchor=(i,at)=>{
    const temporary=document.createDocumentFragment(),node=addCell(temporary,i,'',0);
    if(!node)return null;
    displayOffsets.set(node,{start:at,end:at});
    return node.parentElement;
  };
  const gaps=[...fragment.querySelectorAll('.md-gap')],handled=new Set();
  for(const gap of gaps){
    const from=Number(gap.dataset.start),to=Number(gap.dataset.end);
    const inside=slots.filter(([i,at])=>!handled.has(i)&&at>=from&&at<=to);
    if(!inside.length)continue;
    const out=document.createDocumentFragment();let cursor=from;
    const appendGap=(a,b)=>{
      const raw=source.slice(a,b),breaks=[...raw.matchAll(/\r\n|\r|\n/g)];
      if(breaks.length<2)return;
      const first=breaks[0],start=a+first.index+first[0].length;
      const el=document.createElement('span');el.className='md-gap';
      el.dataset.start=a;el.dataset.end=b;el.style.height=(breaks.length-1)+'lh';
      const node=document.createTextNode(source.slice(start,b));el.append(node);out.append(el);
      displayOffsets.set(node,{start,end:b});
    };
    for(const [i,at] of inside){
      appendGap(cursor,at);const anchor=makeAnchor(i,at);
      if(anchor){
        if(at===to&&gap.nextElementSibling){
          const next=gap.nextElementSibling;
          const first=next.querySelector('.sentence');
          if(first)first.before(anchor);else next.prepend(anchor);
        }else{
          const paragraph=document.createElement('p');paragraph.className='new-paragraph';
          paragraph.append(anchor);out.append(paragraph);
        }
      }
      cursor=at;handled.add(i);
    }
    appendGap(cursor,to);gap.replaceWith(out);
  }
  for(const [i,at] of slots){
    if(handled.has(i))continue;
    const anchor=makeAnchor(i,at);if(!anchor)continue;
    const walker=document.createTreeWalker(fragment,NodeFilter.SHOW_TEXT);let placed=false;
    for(let node;(node=walker.nextNode());){
      const map=displayOffsets.get(node);
      if(!map||map.atomic||map.positions||at<map.start||at>map.end)continue;
      const offset=at-map.start,parent=node.parentElement;
      if(offset===0&&parent.classList.contains('sentence'))parent.before(anchor);
      else if(offset===node.length&&parent.classList.contains('sentence'))parent.after(anchor);
      else{
        const right=node.splitText(offset);displayOffsets.set(node,{...map,end:at});displayOffsets.set(right,{...map,start:at});
        right.before(anchor);
      }
      placed=true;break;
    }
    if(!placed){const paragraph=document.createElement('p');paragraph.className='new-paragraph';paragraph.append(anchor);fragment.append(paragraph);}
  }
}
function markdownDecorator(ranges) {
  function nextRange(offset) {
    let lo=0, hi=ranges.length;
    while(lo<hi) {
      const mid=(lo+hi)>>1;
      if(ranges[mid][1]<=offset) lo=mid+1; else hi=mid;
    }
    return lo;
  }
  return (parent,value,a,b,offsets) => {
    const write = (start,end,index,basis=null,position=null) => {
      if(end<=start)return;
      const text=value.slice(start,end);
      const node=index===undefined?parent.appendChild(document.createTextNode(text)):addCell(parent,index,text,basis);
      if(position)displayOffsets.set(node,position);
    };
    let k=nextRange(a);
    if(offsets===null) {
      const index=ranges[k]?.[0]<b?ranges[k][2]:undefined;
      write(0,value.length,index,null,{start:a,end:b,atomic:true});
      return;
    }
    if(!offsets) {
      let start=a;
      while(k<ranges.length&&ranges[k][0]<b) {
        const [from,to,i]=ranges[k++], first=Math.max(start,from), last=Math.min(to,b);
        write(start-a,from-a,undefined,null,{start,end:from});
        write(first-a,last-a,i,first-from,{start:first,end:last});
        start=last;
      }
      write(start-a,b-a,undefined,null,{start,end:b});
      return;
    }
    let from=0,active;
    const mapped=(first,last,index)=>{
      if(last<=first)return;
      const start=offsets[first],end=offsets[last]??b,positions=offsets.slice(first,last);
      const contiguous=positions.every((p,i)=>p===start+i)&&end===start+positions.length;
      write(first,last,index,contiguous&&index!==undefined?start-displaySentences[index].start:null,
        contiguous?{start,end}:{start,end,positions});
    };
    for(let j=0;j<value.length;j++) {
      const offset=offsets[j];
      while(k<ranges.length&&ranges[k][1]<=offset)k++;
      const index=ranges[k]?.[0]<=offset?ranges[k][2]:undefined;
      if(index!==active){mapped(from,j,active);from=j;active=index;}
    }
    mapped(from,value.length,active);
  };
}
function decorateFineChanges(){
  if(!showChanges||changeDetail==='sentence')return;
  for(const [i,parts] of cells){
    if(!modified(draft,i)||deleted(draft,i))continue;
    const diff=fineChanges(original(draft,i),revised(draft,i));
    const mapped=parts.map(cell=>({cell,node:cell.firstChild,start:cellOffsets.get(cell)?.start}))
      .filter(p=>p.start!==undefined && p.node?.nodeType===Node.TEXT_NODE);
    const removals=new Map();
    if(changeDetail==='full'&&mapped.length)for(const removal of diff.removed){
      const at=removal.at;
      const part=mapped.find(p=>p.start<=at&&at<p.start+p.node.length)
        ?? mapped.find(p=>p.start>=at) ?? mapped.at(-1);
      const list=removals.get(part.cell)??[];
      list.push({pos:Math.max(0,Math.min(part.node.length,at-part.start)),...removal});
      removals.set(part.cell,list);
    }
    let visible=false;
    for(const {cell,node,start} of mapped){
      const value=node.data, length=value.length;
      const adds=diff.added.filter(([a,b])=>a<start+length&&b>start)
        .map(([a,b])=>[Math.max(0,a-start),Math.min(length,b-start)]);
      const drops=removals.get(cell)??[];
      if(!adds.length&&!drops.length)continue;
      visible=true;
      const cuts=[...new Set([0,length,...adds.flat(),...drops.map(x=>x.pos)])].sort((a,b)=>a-b);
      const out=document.createDocumentFragment();
      for(const [index,pos] of cuts.entries()){
        for(const drop of drops.filter(d=>d.pos===pos)){
          const ghost=document.createElement('del');
          ghost.className='diff-removed';
          ghost.contentEditable='false';
          ghost.textContent=drop.text;
          ghost.dataset.offset=drop.at;
          const at=displaySentences[i].start+drop.at;
          displayOffsets.set(ghost.firstChild,{start:at,end:at,atomic:true});
          out.append(ghost);
        }
        const next=cuts[index+1];
        if(next===undefined)continue;
        const live=document.createTextNode(value.slice(pos,next));
        const absolute=displaySentences[i].start+start;
        displayOffsets.set(live,{start:absolute+pos,end:absolute+next});
        if(adds.some(([a,b])=>pos>=a&&pos<b)){
          const add=document.createElement('ins');
          add.className='diff-added';add.append(live);out.append(add);
        }else out.append(live);
      }
      cell.replaceChildren(out);
    }
    if(!visible)for(const cell of parts)cell.dataset.changeHint='true';
  }
}
function syncChangeControls(){
  $('changes-controls').hidden=!draft;
  $('show-changes').disabled=mode!=='split';
  $('show-changes').checked=showChanges;
  $('change-options').hidden=mode!=='split'||!showChanges;
  if($('change-options').hidden)$('change-options').open=false;
  const labels={inline:'仅高亮改动',full:'显示新增和删除',sentence:'按句标记'};
  $('change-level').textContent=labels[changeDetail];
  for(const input of document.querySelectorAll('input[name="change-detail"]'))input.checked=input.value===changeDetail;
}
function saveDisplayPreference(){
  try{localStorage.setItem('diffwrite-changes',JSON.stringify({show:showChanges,detail:changeDetail}));}catch{}
}
$('show-changes').onchange=event=>{
  showChanges=event.target.checked;
  saveDisplayPreference();
  repaintAtScroll(true);
};
for(const input of document.querySelectorAll('input[name="change-detail"]'))input.onchange=()=>{
  changeDetail=input.value;
  $('change-options').open=false;
  $('change-options').querySelector('summary').focus();
  saveDisplayPreference();
  repaintAtScroll(true);
};

function paintReading() {
  if(inlineEdit?.composing||paragraphPending)return;
  finishInline(false);
  clearTimeout(renderTimer);
  document.body.dataset.empty = !draft;
  const md = isMarkdown();
  const rendered = md && !renderSource;
  manuscript.dataset.view = mode;
  manuscript.removeAttribute('contenteditable');
  manuscript.setAttribute('role','document');
  manuscript.dataset.detail = mode==='split'&&showChanges?changeDetail:'none';
  syncChangeControls();
  manuscript.classList.toggle('md-rendered',rendered);
  manuscript.hidden = !draft;
  $('empty').hidden = Boolean(draft);
  const changeLegend = mode === 'split' && showChanges;
  $('legend').hidden = !draft;
  $('sentence-legend').hidden = !changeLegend || changeDetail!=='sentence';
  $('inline-legend').hidden = !changeLegend || changeDetail==='sentence';
  $('removed-legend').hidden = changeDetail!=='full';
  $('foot-tip').hidden = mode !== 'split';
  $('foot-tip').textContent='点击一句编辑源码 · 拖出编辑框可跨段选中删除';
  $('draft-name').textContent = draft?.name ?? '空白稿件';
  $('draft-name').title = draft?.name ?? '';
  $('export-menu').hidden = !draft;
  $('export-backup').hidden = !draft;
  $('notify-ai').hidden = !draft;
  aiButtons();
  $('markdown-view').hidden = !draft;
  $('delete-selection').hidden = !draft || mode === 'source';
  $('undo-delete').hidden = !draft || mode === 'source';
  $('markdown-view').textContent = rendered ? '查看源码' : '渲染 Markdown';
  cells = new Map();
  cellOffsets = new WeakMap();
  displayOffsets=new WeakMap();displaySentences=[];renderPoints=[];ghostRanges=[];
  manuscript.tabIndex=draft&&mode==='split'?0:-1;
  syncTabs();
  if (!draft) {
    manuscript.replaceChildren();
    updateDeleteControls();
    return;
  }
  const fragment = document.createDocumentFragment();
  const displayPieces = function*(){
    for(const [i,value] of pieces(draft,mode!=='source',mode==='source')) {
      const showDeleted=mode!=='source'&&showChanges&&changeDetail!=='inline'&&i!==null&&deleted(draft,i);
      yield [i,showDeleted?original(draft,i):value];
    }
  };
  let displayAt=0, cleanAt=0;
  const ranges=[], text=[], emptySlots=[];
  for(const [i,value] of displayPieces()) {
    const ghost=mode==='split'&&i!==null&&deleted(draft,i);
    const part={start:displayAt,end:displayAt+value.length,cleanStart:cleanAt,ghost};
    if(i!==null)displaySentences[i]=part;
    if(ghost&&value.length)ghostRanges.push({...part,omitted:displayAt-cleanAt});
    if(rendered) {
      if(i!==null&&value.length)ranges.push([part.start,part.end,i]);
      else if(i!==null&&mode!=='source'&&draft.insertedSlots?.includes(i)&&!ghost)emptySlots.push([i,part.start]);
      text.push(value);
    } else if(value || (i!==null&&mode!=='source'&&draft.insertedSlots?.includes(i)&&!ghost)) {
      let node;
      if(i===null){const gap=document.createElement('span');gap.className='text-gap';gap.dataset.start=part.start;gap.dataset.end=part.end;gap.textContent=value;fragment.append(gap);node=gap.firstChild;}
      else node=addCell(fragment,i,value,0);
      displayOffsets.set(node,part);
    }
    displayAt=part.end;
    if(!ghost)cleanAt+=value.length;
  }
  if(rendered){
    fragment.append(renderMarkdown(text.join(''),markdownDecorator(ranges)));
    placeEmptySentences(fragment,emptySlots,text.join(''));
  }
  if(mode!=='source'){
    decorateFineChanges();
    for(const k of Object.keys(draft.aiMarks??{})){
      const i=Number(k);
      if(!deleted(draft,i)||cellAt(i))continue;
      const mark=document.createElement('span');
      mark.className='sentence ai-deletion-mark';mark.dataset.index=i;mark.dataset.aiEdited='true';
      mark.setAttribute('role','button');mark.setAttribute('aria-label',aiTitle(i));
      mark.setAttribute('aria-pressed',String(i===selected));mark.dataset.selected=String(i===selected);
      mark.tabIndex=-1;mark.title=aiTitle(i);
      const next=[...cells.keys()].filter(j=>j>i).sort((a,b)=>a-b)[0];
      if(next!==undefined)cellAt(next).before(mark);else fragment.append(mark);
      cells.set(i,[mark]);
    }
    cursor = cellAt(selected) ? selected : [...cells.keys()].sort((a,b)=>a-b)[0];
    if (cellAt(cursor)) cellAt(cursor).tabIndex = 0;
  }
  manuscript.replaceChildren(fragment);
  const walker=document.createTreeWalker(manuscript,NodeFilter.SHOW_TEXT);
  for(let node;(node=walker.nextNode());){
    const mapped=displayOffsets.get(node);
    if(!mapped||node.parentElement.closest('.diff-removed,[data-deleted=true]'))continue;
    renderPoints.push({node,mapped,start:cleanOffset(mapped.start),end:cleanOffset(mapped.end)});
  }
  updateDeleteControls();
}
function repaintAtScroll(align = false) {
  if(inlineEdit?.composing)return;
  const range=!inlineEdit&&manuscript.contains(document.activeElement)?bodyRange():null;
  const offset = reading.scrollTop;
  paintReading();
  if(range)restoreBodySelection(range);
  reading.scrollTop = offset;
  if (align) cellAt(selected)?.scrollIntoView({block:'nearest'});
}
$('markdown-view').onclick = () => {
  if (!draft || switching) return;
  if (!markdownMode) {
    markdownMode = true;
    draft.format = 'markdown';
    renderSource = false;
    scheduleSave();
  } else renderSource = !renderSource;
  repaintAtScroll(true);
};

function focusField() {
  const narrow = matchMedia('(max-width:760px)').matches;
  opinion.focus({preventScroll:!narrow});
}
function paintState() {
  const changed = modified(draft,selected);
  const removed = deleted(draft,selected);
  $('change-state').textContent = removed ? '已删除' : changed ? '已改' : '未改';
  $('delete-sentence').textContent = removed ? '恢复本句' : '删除本句';
  revision.disabled = removed;
  $('restore-sentence').disabled=!changed||switching;
  $('change-state').dataset.changed = changed;
}
function paintEditor(focus = false) {
  const active = draft && selected !== null && mode !== 'source';
  $('editor').hidden = !active;
  $('hint').hidden = Boolean(active);
  if (!active) {
    $('hint').textContent = !draft ? '导入稿件后，可以在这里写意见和改版。' :
      mode === 'source' ? '切到分句模式，就能逐句审稿。' : '点击左侧正文开始。';
    opinionUI.render();
    return;
  }
  const newParagraph=draft.insertedSlots?.includes(selected);
  $('quote-caption').textContent = newParagraph?'新增段落':isMarkdown() ? '原句 · Markdown 源码' : '原句';
  $('quote').hidden=Boolean(newParagraph);
  $('restore-sentence').textContent=newParagraph?'清空本段':'恢复原句';
  $('revision-hint').textContent = deleted(draft,selected) ? '恢复本句后可编辑' :
    newParagraph ? '本段单独保存，留空则保留空段' : isMarkdown() ? '按 Markdown 填写，留空沿用原句' : '留空则沿用原句';
  $('quote').textContent = original(draft,selected);
  const nextOpinion=draft.notes[selected]?.opinion??'', nextRevision=draft.notes[selected]?.revision??'';
  if(opinion.value!==nextOpinion)opinion.value=nextOpinion;
  if(revision.value!==nextRevision)revision.value=nextRevision;
  paintState();
  paintTags();
  opinionUI.render();
  if (focus) focusField();
}
function setMode(next) {
  if (!draft || switching || next === mode) return;
  persist();
  const offset = reading.scrollTop;
  mode = next;
  paintReading();
  reading.scrollTop = offset;
  cellAt(selected)?.scrollIntoView({block:'nearest'});
  paintEditor();
}
for (const tab of tabs) tab.onclick = () => setMode(tab.dataset.mode);
$('tab-split').parentElement.addEventListener('keydown', event => {
  const directions = {ArrowLeft:-1,ArrowRight:1};
  if (!(event.key in directions) && !['Home','End'].includes(event.key)) return;
  if (!draft) return;
  event.preventDefault();
  const i = tabs.indexOf(event.target);
  const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) :
    tabs[(i + directions[event.key] + tabs.length)%tabs.length];
  next.focus();
  setMode(next.dataset.mode);
});
function select(index,focus=true) {
  persist();
  if (cellAt(cursor)) cellAt(cursor).tabIndex = -1;
  for (const cell of cells.get(selected) ?? []) cell.dataset.selected = false;
  cellAt(selected)?.setAttribute('aria-pressed','false');
  selected = cursor = index;
  if(cellAt(index)){
    cellAt(index).tabIndex = 0;
    for (const cell of cells.get(index)) cell.dataset.selected = true;
    cellAt(index).setAttribute('aria-pressed','true');
  }
  paintEditor(focus);
}
let inlineEdit=null, pointerEdit=null, suppressClick=false;
function bodyRange(){
  if(inlineEdit)return [bodyEditor.selectionStart,bodyEditor.selectionEnd].map(at=>inlineEdit.start+rawOffset(inlineEdit.value,at));
  const selection=window.getSelection();
  if(!selection?.rangeCount)return null;
  const range=selection.getRangeAt(0);
  if(!manuscript.contains(range.startContainer)||!manuscript.contains(range.endContainer))return null;
  if(!range.collapsed)return renderedSelection(range);
  const at=domOffset(range.startContainer,range.startOffset);
  return at===undefined?null:[at,at];
}
function bodyPoint(at){
  let lo=0,hi=renderPoints.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(renderPoints[mid].end<at)lo=mid+1;else hi=mid;}
  const candidates=renderPoints.slice(Math.max(0,lo-1),lo+2);
  let best=null,distance=Infinity;
  for(const {node,mapped,start} of candidates){
    const omitted=mapped.start-start;
    const consider=i=>{
      const pos=(i===node.length?mapped.end:mapped.atomic?mapped.start:mapped.positions?.[i]??mapped.start+i)-omitted;
      const diff=Math.abs(pos-at);if(diff<distance){best=[node,i];distance=diff;}
    };
    if(mapped.atomic){consider(0);consider(node.length);}
    else if(mapped.positions){for(let i=0;i<=node.length&&distance;i++)consider(i);}
    else consider(Math.max(0,Math.min(node.length,at-start)));
  }
  return best??[manuscript,manuscript.childNodes.length];
}
function restoreBodySelection([start,end=start],focus=true){
  if(focus)manuscript.focus({preventScroll:true});
  const selection=window.getSelection();selection.setBaseAndExtent(...bodyPoint(start),...bodyPoint(end));
}
function mountSpanningEditor(parts,start,end,layout,context=false){
  const rendered=isMarkdown()&&!renderSource;
  if(!rendered&&!context)return null;
  const rootOf=cell=>{let root=cell;while(root&&root.parentElement!==manuscript)root=root.parentElement;return root;};
  const owned=new Set(parts.map(rootOf).filter(Boolean)),span=displaySentences[parts[0]?.dataset.index];
  const bounds=root=>{
    const sentence=displaySentences[root.dataset.index];
    return [root.dataset.mdStart??root.dataset.start??sentence?.start,root.dataset.mdEnd??root.dataset.end??sentence?.end].map(n=>cleanOffset(Number(n)));
  };
  const roots=[...manuscript.children].filter(root=>{
    const [a,b]=bounds(root);
    return owned.has(root)||(context?a<end&&b>start:span&&a<cleanOffset(span.end)&&b>cleanOffset(span.start));
  });
  if(!roots.length||!context&&roots.length===1&&!roots[0].classList.contains('md-gap'))return null;
  let first=roots[0],last=roots.at(-1);
  // Include the neighbouring line when the sentence begins/ends inside a gap.
  // A multiline editing host must never live inside that fixed-height spacer.
  if(first.classList.contains('md-gap')&&first.previousElementSibling)first=first.previousElementSibling;
  if(last.classList.contains('md-gap')&&last.nextElementSibling)last=last.nextElementSibling;
  const from=Math.min(start,bounds(first)[0]),to=Math.max(end,bounds(last)[1]);
  const box=document.createElement(rendered?'div':'span');box.className='inline-source-region';
  const prefix=document.createTextNode(layout.text.slice(from,start)),suffix=document.createTextNode(layout.text.slice(end,to));
  displayOffsets.set(prefix,{start:from,end:start,clean:true});
  displayOffsets.set(suffix,{start:end,end:to,clean:true});
  box.append(prefix,bodyEditor,suffix);
  const nodes=[];for(let node=first;node;node=node.nextSibling){nodes.push(node);if(node===last)break;}
  first.before(box);for(const node of nodes)node.remove();
  return {box,nodes};
}
function startInline(start,end,element,index=null,caret=start,context=false){
  if(!draft||mode!=='split'||switching)return;
  finishInline();
  const layout=editorLayout(draft),value=layout.text.slice(start,end);
  const parts=index===null?[element]:cells.get(index)??[element];
  inlineEdit={start,end,originalEnd:end,value,parts,index,kind:context?'context':index===null?'gap':'sentence',dirty:false,composing:false,eol:layout.text.includes('\r\n')?'\r\n':'\n'};
  bodyEditor.dataset.kind=inlineEdit.kind;
  bodyEditor.setAttribute('aria-label',index===null?'编辑空白行源码':'编辑当前句源码');
  bodyEditor.value=textareaText(value);bodyEditor.hidden=false;
  inlineEdit.region=mountSpanningEditor(parts,start,end,layout,context);
  if(!inlineEdit.region){if(element&&element!==manuscript)element.before(bodyEditor);else manuscript.append(bodyEditor);}
  for(const part of parts)if(part&&part!==manuscript)part.hidden=true;
  const i=index??sentenceAt(layout,start);if(i!==null)select(i,false);

  bodyEditor.focus({preventScroll:true});
  const offset=textareaText(value.slice(0,Math.max(0,caret-start))).length;
  bodyEditor.setSelectionRange(offset,offset);
  updateDeleteControls();
}
function startAt(at,index=null,gap=null){
  if(gap){startInline(gap.start,gap.end,gap.element,null,at);return;}
  const layout=editorLayout(draft),i=index??sentenceAt(layout,at),part=layout.sentences[i];
  if(part)startInline(part.start,part.end,cellAt(i)??manuscript,i,at);
  else startInline(at,at,manuscript,null,at);
}
function resumeBodyInput(at){
  if(!draft||mode!=='split'||switching)return;
  const layout=editorLayout(draft);
  at=Math.max(0,Math.min(at,layout.text.length));
  const live=layout.sentences.filter(p=>!deleted(draft,p.i));
  const part=live.find(p=>p.end>at)||live.findLast(p=>p.end===at)||live.at(-1)||layout.sentences[0];
  if(!part)return;
  const start=Math.min(at,part.start),end=Math.max(at,part.end);
  startInline(start,end,cellAt(part.i)??manuscript,part.i,at,start!==part.start||end!==part.end);
}
function commitInline(){
  const edit=inlineEdit;if(!edit||edit.composing||switching)return;
  const before=textareaText(edit.value),after=bodyEditor.value,change=textEdit(before,after,edit.hint);
  const hint=edit.hint;edit.hint=null;
  if(!change)return;
  const [a,b,value]=change,insert=edit.eol==='\r\n'?value.replaceAll('\n','\r\n'):value;
  const start=edit.start+rawOffset(edit.value,a),end=edit.start+rawOffset(edit.value,b);
  const next=edit.value.slice(0,start-edit.start)+insert+edit.value.slice(end-edit.start);
  const layout=editorLayout(draft),{updates,gaps}=spliceEditorText(draft,layout,start,end,insert,edit.kind==='context'?undefined:edit.index??undefined);
  const caret=[bodyEditor.selectionStart,bodyEditor.selectionEnd].map(p=>edit.start+rawOffset(next,p));
  const previousCaret=(hint??[a,b]).map(p=>edit.start+rawOffset(edit.value,p));
  if(applyBodyEdit(updates,gaps,previousCaret,caret)){
    bodyUndo.at(-1).inline={start:edit.start,index:edit.index,values:[edit.value,next]};
    edit.dirty=true;
  }
  edit.value=next;edit.end=edit.start+next.length;
  if(selected!==null){revision.value=draft.notes[selected]?.revision??'';paintState();}

}
function finishInline(repaint=true){
  const edit=inlineEdit;if(!edit)return;
  if(edit.composing||paragraphPending)return;
  commitInline();inlineEdit=null;
  bodyEditor.hidden=true;reading.append(bodyEditor);
  for(const part of edit.parts)if(part&&part!==manuscript)part.hidden=false;
  if(edit.region)edit.region.box.replaceWith(...edit.region.nodes);
  if(repaint&&edit.dirty)repaintAtScroll();
}
function editBodyRange(range,text){
  if(!range||!draft||switching||mode==='source')return;
  finishInline(false);
  const layout=editorLayout(draft),[a,b]=range;
  if(layout.text.includes('\r\n'))text=text.replace(/\r?\n/g,'\r\n');
  const {updates,gaps}=spliceEditorText(draft,layout,a,b,text),caret=a+text.length;
  if(applyBodyEdit(updates,gaps,[a,b],[caret,caret])){
    selected=sentenceAt(editorLayout(draft),caret);
    repaintAtScroll();paintEditor();resumeBodyInput(caret);
  }
}
const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
function adjacentRange(text,at,backward){
  const from=Math.max(0,at-64),to=Math.min(text.length,at+64);
  const segments=[...graphemes.segment(text.slice(from,to))];
  const part=backward?segments.findLast(s=>from+s.index<at):segments.find(s=>from+s.index+s.segment.length>at);
  return part?(backward?[from+part.index,at]:[at,from+part.index+part.segment.length]):null;
}
function eraseAtCaret(backward){
  if(!draft||mode!=='split'||switching||inlineEdit?.composing)return false;
  const range=bodyRange();if(!range||range[0]!==range[1])return false;
  if(inlineEdit&&!(backward?bodyEditor.selectionStart===0:bodyEditor.selectionEnd===bodyEditor.value.length))return false;
  const target=adjacentRange(editorLayout(draft).text,range[0],backward);if(!target)return false;
  editBodyRange(target,'');
  return true;
}
async function beginParagraphBreak(){
  const edit=inlineEdit;
  if(!edit||edit.index===null||paragraphPending||switching)return;
  const id=active.id;
  const pending={edit,id,prefix:textareaText(edit.value)+'\n',requestId:crypto.randomUUID()};
  pending.done=new Promise(resolve=>pending.resolve=resolve);
  paragraphPending=pending;switching=true;
  opinion.readOnly=revision.readOnly=true;updateDeleteControls();saveLabel('正在分段…');
  try{
    if(!await flush()||active?.id!==id)throw Error('请先保存当前稿件，再重试分段。');
    saveLabel('正在分段…');
    let record=await reviewApi(pathFor(id,'paragraph-break'),{
      revision:active.revision,sentence:edit.index,requestId:pending.requestId
    });
    if(edit.composing)await new Promise(resolve=>pending.compositionDone=resolve);
    const value=bodyEditor.value,caret=[bodyEditor.selectionStart,bodyEditor.selectionEnd];
    const focus=document.activeElement,keepFocus=focus===bodyEditor;
    if(!value.startsWith(pending.prefix)){
      // If the author removes the break while it is saving, keep their latest input.
      record=await reviewApi(pathFor(id,'paste-review'),{revision:record.meta.revision,token:record.token,action:'undo'});
      draft=restoreDraft(record.draft);active=record.meta;
      paragraphPending=null;switching=false;opinion.readOnly=revision.readOnly=false;
      edit.hint=null;commitInline();updateDeleteControls();
      if(!keepFocus)finishInline();
      return;
    }
    const tail=value.slice(pending.prefix.length);
    const selection=caret.map(p=>Math.max(0,p-pending.prefix.length));
    inlineEdit=null;bodyEditor.hidden=true;reading.append(bodyEditor);
    paragraphPending=null;switching=false;opinion.readOnly=revision.readOnly=false;
    draft=restoreDraft(record.draft);active=record.meta;
    pending.success=true;
    selected=record.focus;pasteCaret=record.caret;
    bodyUndo.push({token:record.token,paragraph:true});if(bodyUndo.length>100)bodyUndo.shift();bodyRedo=[];
    repaintAtScroll(true);paintEditor();saveLabel('已保存');
    startAt(record.caret,record.focus);
    const another=tail.indexOf('\n\n');
    if(another>=0&&selection[0]>=another+2){
      // Drain additional paragraph breaks typed before the previous save completed.
      bodyEditor.value=tail.slice(0,another+1);
      bodyEditor.setSelectionRange(bodyEditor.value.length,bodyEditor.value.length);
      inlineEdit.hint=[0,0];commitInline();
      bodyEditor.value=tail;bodyEditor.setSelectionRange(...selection);
      void beginParagraphBreak();
    }else{
      bodyEditor.value=tail;bodyEditor.setSelectionRange(...selection);
      inlineEdit.hint=[0,0];commitInline();
      if(!keepFocus){finishInline();focus?.focus({preventScroll:true});}
    }
    updateDeleteControls();
  }catch(error){
    paragraphPending=null;switching=false;opinion.readOnly=revision.readOnly=false;
    if(inlineEdit===edit){edit.hint=null;commitInline();}
    if(document.activeElement!==bodyEditor&&!pointerEdit)finishInline();
    updateDeleteControls();
    outputStatus('分段失败，当前输入仍保留：'+error.message,true);
  }finally{
    pending.resolve(Boolean(pending.success));
  }
}
bodyEditor.addEventListener('beforeinput',event=>{
  if(!inlineEdit)return;
  if(['historyUndo','historyRedo'].includes(event.inputType)){event.preventDefault();undoBody(event.inputType==='historyRedo');return;}
  if(!event.isComposing&&['deleteContentBackward','deleteContentForward'].includes(event.inputType)&&eraseAtCaret(event.inputType==='deleteContentBackward')){event.preventDefault();return;}
  if(!inlineEdit.composing)inlineEdit.hint=[bodyEditor.selectionStart,bodyEditor.selectionEnd];
  if(!event.isComposing&&['insertParagraph','insertLineBreak'].includes(event.inputType)){
    event.preventDefault();
    const [start,end]=inlineEdit.hint;
    const atTail=start===end&&end===bodyEditor.value.length;
    const newParagraph=!paragraphPending&&atTail&&start>0&&bodyEditor.value[start-1]==='\n';
    bodyEditor.setRangeText('\n',start,end,'end');
    if(newParagraph)void beginParagraphBreak();else commitInline();
  }
});
bodyEditor.addEventListener('input',commitInline);
bodyEditor.addEventListener('compositionstart',()=>{if(inlineEdit){inlineEdit.composing=true;inlineEdit.hint=[bodyEditor.selectionStart,bodyEditor.selectionEnd];}});
bodyEditor.addEventListener('compositionend',()=>{if(inlineEdit){inlineEdit.composing=false;commitInline();paragraphPending?.compositionDone?.();}});
bodyEditor.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(['Backspace','Delete'].includes(event.key)&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&eraseAtCaret(event.key==='Backspace')){event.preventDefault();return;}
  if(event.key==='Escape'){event.preventDefault();finishInline();manuscript.focus({preventScroll:true});}
});
bodyEditor.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement!==bodyEditor&&!pointerEdit)finishInline();void pollAi();},0));
function offsetAtPoint(x,y){
  const point=document.caretPositionFromPoint?.(x,y),range=point?null:document.caretRangeFromPoint?.(x,y);
  const node=point?.offsetNode??range?.startContainer,offset=point?.offset??range?.startOffset;
  return node?domOffset(node,offset):undefined;
}
function gapAt(element){
  const gap=element?.closest?.('.md-gap,.text-gap');
  if(!gap)return null;
  return {start:currentOffset(cleanOffset(Number(gap.dataset.start))),end:currentOffset(cleanOffset(Number(gap.dataset.end))),element:gap};
}
function gapAtPosition(element,x,y){
  const direct=gapAt(element);if(direct)return direct;
  if(!manuscript.contains(element)||element.closest?.('.sentence'))return null;
  for(const el of manuscript.querySelectorAll('.md-gap,.text-gap')){
    const rect=el.getBoundingClientRect();
    if(x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom)return gapAt(el);
  }
  return null;
}
function gapPoint(gap,x,y){
  if(!gap.element.classList.contains('md-gap')){
    const node=gap.element.firstChild;
    if(node?.nodeType===Node.TEXT_NODE){
      let closest=gap.start,distance=Infinity;
      for(const match of node.data.matchAll(/\r\n|\r|\n/g)){
        const probe=document.createRange();probe.setStart(node,match.index);probe.setEnd(node,match.index+match[0].length);
        const rect=probe.getBoundingClientRect(),d=Math.abs(y-(rect.top+rect.height/2));
        if(d<distance){closest=gap.start+match.index;distance=d;}
      }
      if(distance<Infinity)return closest;
    }
    return offsetAtPoint(x,y)??gap.start;
  }
  const rect=gap.element.getBoundingClientRect(),line=parseFloat(getComputedStyle(gap.element).lineHeight);
  const text=editorLayout(draft).text.slice(gap.start,gap.end),breaks=[...text.matchAll(/\r\n|\r|\n/g)];
  const row=Math.max(0,Math.min(breaks.length-1,Math.floor((y-rect.top)/line)));
  const match=breaks[row];
  return match?gap.start+match.index+(gap.start===0?0:match[0].length):gap.start;
}
reading.addEventListener('pointerdown',event=>{
  if(event.button!==0||!draft||mode!=='split'||switching)return;
  suppressClick=false;
  if((event.target===bodyEditor||bodyEditor.contains(event.target))){
    pointerEdit={x:event.clientX,y:event.clientY,fromEditor:true,anchor:bodyRange()?.[0]};
    const drag=pointerEdit;
    setTimeout(()=>{
      if(pointerEdit===drag&&!drag.custom&&inlineEdit)drag.anchor=bodyRange()?.[0];
    },0);return;
  }
  if(!manuscript.contains(event.target))return;
  const gap=gapAtPosition(event.target,event.clientX,event.clientY),at=gap?gapPoint(gap,event.clientX,event.clientY):offsetAtPoint(event.clientX,event.clientY),index=event.target.closest('.sentence')?.dataset.index;
  pointerEdit={x:event.clientX,y:event.clientY,anchor:at,gap,index:index===undefined?null:Number(index)};
  if(inlineEdit){
    finishInline();event.preventDefault();pointerEdit.custom=true;
    if(at!==undefined)restoreBodySelection([at,at]);
  }else if(gap){
    // Browsers do not place a caret reliably on a whitespace-only preview.
    // Own this gesture (including a following drag) instead of letting mouseup
    // discard the selection we just placed on the blank line.
    event.preventDefault();pointerEdit.custom=true;restoreBodySelection([at,at]);
  }
},true);
// A cross-editor gesture extends the selection; it must not start native text drag-and-drop.
reading.addEventListener('dragstart',event=>{
  if(pointerEdit?.custom)event.preventDefault();
});
function extendDrag(drag){
  if(pointerEdit!==drag||!drag.custom||drag.anchor===undefined)return;
  const edge=reading.getBoundingClientRect(),y=drag.yNow,x=drag.xNow;
  const speed=y<edge.top+25?-20:y>edge.bottom-25?20:0;
  if(speed)reading.scrollTop+=speed;
  const at=offsetAtPoint(x,Math.max(edge.top+2,Math.min(edge.bottom-2,y)));
  if(at!==undefined){drag.focus=at;restoreBodySelection([drag.anchor,at],false);}
  if(speed)drag.frame=requestAnimationFrame(()=>extendDrag(drag));
}
document.addEventListener('pointermove',event=>{
  const drag=pointerEdit;if(!drag||!(event.buttons&1))return;
  if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<5)return;
  suppressClick=true;
  if(drag.fromEditor&&!drag.custom){
    const inside=[...bodyEditor.getClientRects()].some(rect=>event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom);
    if(inside)return;
    const range=bodyRange();
    if(range)drag.anchor=range[bodyEditor.selectionDirection==='backward'?1:0];
    // Keep receiving pointer events when the active text run is replaced with its preview.
    reading.setPointerCapture(event.pointerId);
    finishInline();drag.custom=true;
  }
  if(!drag.custom||drag.anchor===undefined)return;
  event.preventDefault();
  drag.xNow=event.clientX;drag.yNow=event.clientY;
  cancelAnimationFrame(drag.frame);extendDrag(drag);
});
document.addEventListener('pointerup',event=>{
  const finished=pointerEdit;
  const keep=finished?.custom&&suppressClick&&finished.anchor!==undefined&&finished.focus!==undefined
    ?[finished.anchor,finished.focus]:null;
  if(keep)event.preventDefault();
  if(finished){
    cancelAnimationFrame(finished.frame);
    const activate=finished.custom&&!finished.fromEditor&&!suppressClick;
    finished.custom=false;
    if(activate){
      suppressClick=true;
      if(finished.gap)resumeBodyInput(finished.anchor);
      else if(finished.index!==null)startAt(finished.anchor,finished.index);
    }
  }
  setTimeout(()=>{
    if(pointerEdit!==finished)return;
    pointerEdit=null;
    if(keep)restoreBodySelection(keep);
  },0);
});
manuscript.addEventListener('click',event=>{
  if(mode==='source'||switching||(event.target===bodyEditor||bodyEditor.contains(event.target))||suppressClick||selectionInside())return;
  pasteCaret=null;
  const at=pointerEdit?.anchor??offsetAtPoint(event.clientX,event.clientY);
  const gap=gapAtPosition(event.target,event.clientX,event.clientY);
  if(gap){resumeBodyInput(gapPoint(gap,event.clientX,event.clientY));return;}
  const cell=event.target.closest('.sentence');
  const index=cell?Number(cell.dataset.index):pointerEdit?.index;
  if(index!==null&&index!==undefined){startAt(at??displaySentences[index].cleanStart,index);return;}
});
function updateNote(field, value) {
  if (!draft || selected === null || mode === 'source' || switching) return;
  const note = draft.notes[selected] ?? {opinion:'', revision:''};
  const before=note[field];
  if(before===value)return;
  note[field] = value;
  if(field==='revision')delete note.literalWhitespace;
  delete note.autoOpinion;
  clearAiMark(selected,field,before,value);
  setNote(selected,note);
  for (const cell of cells.get(selected) ?? []) cell.dataset.changed = modified(draft,selected);
  if (field === 'revision' && mode !== 'source') {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => repaintAtScroll(), 80);
  }
  paintState();
  scheduleSave();
  opinionUI.edited(selected,{human:field==='opinion'});
}

// AI 审稿 tags mark fields an AI wrote; a field the author edits is the author's from then on.
function aiTitle(i){
  const mark=draft?.aiMarks?.[i];
  if(!mark)return '';
  const body=!mark.body?'':deleted(draft,i)?'删除本句':modified(draft,i)?'改写':'恢复原句';
  return 'AI 审稿：'+[mark.opinion!==undefined&&'意见',body].filter(Boolean).join('、');
}
function paintCellMarks(i,fresh=opinionUI.has(active?.id,i)||Boolean(draft?.notes[i]?.autoOpinion)){
  const ai=aiTitle(i);
  for(const cell of cells.get(i)??[]){
    cell.dataset.aiEdited=Boolean(ai);
    cell.dataset.newOpinion=fresh;
    if(ai||fresh)cell.title=fresh?'有新的 AI 补全意见':ai;
    else cell.removeAttribute('title');
  }
}
function paintTags(){
  const mark=draft?.aiMarks?.[selected], saved=mark?.replaced;
  $('opinion-ai-tag').hidden=mark?.opinion===undefined;
  $('opinion-ai-tag').title=mark?.opinion?'AI 在你的意见后面追加了一段，可以直接修改':'这条意见是 AI 写的，可以直接修改';
  $('revision-ai-tag').hidden=!mark?.body;
  $('revision-ai-tag').title='这句的改写出自 AI，可以直接修改';
  $('revision-swap').hidden=!saved;
  $('revision-swap').title=!saved?'':saved.deleted?'AI 改写前，你删除了这句':'AI 改写前你的版本：'+(saved.revision||original(draft,selected));
}
function clearAiMark(i,field,before,after){
  const mark=draft.aiMarks?.[i];
  if(!mark)return;
  if(field==='opinion'){
    const from=editedOpinionMark(mark.opinion,before,after);
    if(from===undefined)delete mark.opinion;else mark.opinion=from;
  }else{delete mark.body;delete mark.replaced;}
  if(!Object.keys(mark).length)delete draft.aiMarks[i];
  if(!Object.keys(draft.aiMarks).length)delete draft.aiMarks;
  paintCellMarks(i);
  if(i===selected)paintTags();
  aiButtons();
}
function noteAt(i) { return draft.notes[i] ?? {opinion:'',revision:''}; }
function setNote(i,note) {
  if (note && (note.opinion || note.revision || note.deleted || note.autoOpinion)) draft.notes[i] = note;
  else delete draft.notes[i];
}
$('restore-sentence').onclick=()=>{
  if(!draft||selected===null||mode==='source'||switching)return;
  const next={...noteAt(selected),revision:''};delete next.deleted;delete next.literalWhitespace;
  applyBodyEdit(new Map([[selected,next]]));
  repaintAtScroll();paintEditor();outputStatus('已恢复原句，保留意见。');
};
function selectionInside() {
  if (!draft || mode === 'source' || switching) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return manuscript.contains(range.startContainer) && manuscript.contains(range.endContainer) ? range : null;
}
function cleanOffset(at){
  let lo=0,hi=ghostRanges.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(ghostRanges[mid].start<at)lo=mid+1;else hi=mid;}
  const ghost=ghostRanges[lo-1];
  return ghost?at-ghost.omitted-Math.min(at,ghost.end)+ghost.start:at;
}
function currentOffset(at){
  return inlineEdit&&at>=inlineEdit.originalEnd?at+inlineEdit.end-inlineEdit.originalEnd:at;
}
function domOffset(node,offset,isEnd=false,details=false) {
  if(!node||!manuscript.contains(node))return;
  let mapped=displayOffsets.get(node);
  if(!mapped){
    const point=document.createRange();point.setStart(node,offset);point.collapse(true);
    const walker=document.createTreeWalker(manuscript,NodeFilter.SHOW_TEXT);
    let previous;
    for(let t;(t=walker.nextNode());){
      if(!displayOffsets.has(t))continue;
      if(point.comparePoint(t,0)>=0){
        node=isEnd&&previous?previous:t;offset=node===t?0:node.length;
        break;
      }
      previous=t;
    }
    if(!displayOffsets.has(node)&&previous){node=previous;offset=node.length;}
    mapped=displayOffsets.get(node);
  }
  if(!mapped)return details?undefined:editorLayout(draft).text.length;
  const at=offset===node.length?mapped.end:mapped.atomic?mapped.start:mapped.positions?.[offset]??mapped.start+offset;
  const i=node.parentElement.closest('.sentence')?.dataset.index;
  return details?{at,clean:mapped.clean, i:i===undefined?null:Number(i), node,offset}:currentOffset(mapped.clean?at:cleanOffset(at));
}
function renderedSelection(range){
  if(!range)return null;
  if(range.startContainer===manuscript&&range.endContainer===manuscript&&range.startOffset===0&&range.endOffset===manuscript.childNodes.length)
    return [0,editorLayout(draft).text.length];
  const left=domOffset(range.startContainer,range.startOffset,false,true);
  const right=domOffset(range.endContainer,range.endOffset,true,true);
  if(!left||!right)return null;
  let a=left.at,b=right.at;
  const first=left.i===null?null:cells.get(left.i)?.[0];
  const last=right.i===null?null:cells.get(right.i)?.at(-1);
  const edge=(cell,end)=>{
    const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);
    let result;
    for(let t;(t=walker.nextNode());)if(!t.parentElement.closest('.diff-removed')){result=t;if(!end)break;}
    return result;
  };
  const atFirst=first&&left.offset===0&&edge(first,false)===left.node;
  const atLast=last&&right.offset===right.node.length&&edge(last,true)===right.node;
  if(atFirst&&(left.i!==right.i||atLast))a=displaySentences[left.i].start;
  if(atLast&&(left.i!==right.i||atFirst))b=displaySentences[right.i].end;
  a=currentOffset(left.clean?a:cleanOffset(a));b=currentOffset(right.clean?b:cleanOffset(b));
  return a<b?[a,b]:null;
}
const bodyState=note=>[note?.revision??'',Boolean(note?.deleted),Boolean(note?.literalWhitespace)];
const equalBody=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function applyBodyState(i,state){
  const n={...noteAt(i),revision:state[0]};
  if(state[1])n.deleted=true;else delete n.deleted;
  if(state[2])n.literalWhitespace=true;else delete n.literalWhitespace;
  delete n.autoOpinion;
  clearAiMark(i,'revision');
  setNote(i,n);
  opinionUI.edited(i);
}
function setGaps(gaps){
  if(gaps.length)draft.omittedGaps=gaps;else delete draft.omittedGaps;
}
function applyBodyEdit(updates,gaps=draft.omittedGaps??[],beforeCaret=null,afterCaret=null){
  const rows=[];
  for(const [i,note] of updates){
    const before=bodyState(draft.notes[i]),after=bodyState(note);
    if(!equalBody(before,after)){rows.push([i,before,after]);applyBodyState(i,after);}
  }
  const previous=draft.omittedGaps??[], changeGaps=!equalBody(previous,gaps);
  if(!rows.length&&!changeGaps)return false;
  if(changeGaps)setGaps(gaps);
  bodyUndo.push({rows,gaps:changeGaps?[previous,gaps]:null,carets:[beforeCaret,afterCaret]});
  if(bodyUndo.length>100)bodyUndo.shift();
  bodyRedo=[];
  scheduleSave();updateDeleteControls();
  return true;
}
function undoBody(redo=false) {
  if(!draft||mode==='source'||switching)return;
  const from=redo?bodyRedo:bodyUndo, to=redo?bodyUndo:bodyRedo;
  const step=from.pop();
  if(!step)return;
  if(step.token){
    void changePastedReview({token:step.token,action:redo?'redo':'undo',paragraph:step.paragraph===true}).then(ok=>(ok?to:from).push(step)).finally(updateDeleteControls);
    return;
  }
  const a=redo?1:2,b=redo?2:1;
  const kept=step.rows.filter(row=>equalBody(bodyState(draft.notes[row[0]]),row[a]));
  for(const row of kept)applyBodyState(row[0],row[b]);
  const gaps=step.gaps&&equalBody(draft.omittedGaps??[],step.gaps[a-1])?step.gaps:null;
  if(gaps)setGaps(gaps[b-1]);
  if(kept.length||gaps){
    to.push({...step,rows:kept,gaps});
    const caret=step.carets[b-1],scroll=reading.scrollTop;
    if(inlineEdit&&step.inline?.start===inlineEdit.start&&step.inline.index===inlineEdit.index){
      const value=step.inline.values[b-1];
      inlineEdit.value=value;inlineEdit.end=inlineEdit.start+value.length;inlineEdit.dirty=true;
      bodyEditor.value=textareaText(value);
      if(caret)bodyEditor.setSelectionRange(...caret.map(p=>textareaText(value.slice(0,Math.max(0,p-inlineEdit.start))).length));
      paintEditor();
    }else{
      finishInline(false);
      if(caret)selected=sentenceAt(editorLayout(draft),caret[0]);
      repaintAtScroll();paintEditor();
      if(caret)restoreBodySelection(caret);
    }
    reading.scrollTop=scroll;
    scheduleSave();
    outputStatus(redo?'已重做正文编辑。':'已撤销正文编辑。');
  }else outputStatus('对应正文已被更新，未覆盖新的改动。',true);
  updateDeleteControls();
}
function updateDeleteControls() {
  $('delete-selection').disabled = switching || (inlineEdit?bodyEditor.selectionStart===bodyEditor.selectionEnd:!selectionInside());
  $('undo-delete').hidden = !draft || mode === 'source' || !bodyUndo.length;
  $('undo-delete').disabled = switching;
  bodyEditor.readOnly=switching&&!paragraphPending;
}
function deleteSelection(){
  if(!draft||mode==='source'||switching)return;
  if(inlineEdit){inlineEdit.hint=[bodyEditor.selectionStart,bodyEditor.selectionEnd];bodyEditor.setRangeText('',...inlineEdit.hint,'end');commitInline();return;}
  const layout=editorLayout(draft),range=renderedSelection(selectionInside());
  if(!range||range[0]===range[1])return;
  const [a,b]=range,{updates,gaps}=spliceEditorText(draft,layout,a,b,'');
  if(!applyBodyEdit(updates,gaps,range,[a,a]))return;
  selected=sentenceAt(editorLayout(draft),a);
  const scroll=reading.scrollTop;
  repaintAtScroll();paintEditor();resumeBodyInput(a);reading.scrollTop=scroll;
  outputStatus('已从修改版删除，原文保留。');
}
for(const id of ['delete-selection','undo-delete'])$(id).addEventListener('mousedown',event=>event.preventDefault());
$('delete-selection').onclick=deleteSelection;
$('undo-delete').onclick=()=>undoBody();
document.addEventListener('selectionchange',updateDeleteControls);
document.addEventListener('keydown',event=>{
  if(event.target.closest?.('input,dialog')||event.target.closest?.('textarea')&&event.target!==bodyEditor)return;
  if(!draft||mode==='source'||switching||event.isComposing)return;
  const inside=manuscript.contains(event.target)||selectionInside()||event.target===document.body;
  if((event.ctrlKey||event.metaKey)&&!event.altKey&&['z','y'].includes(event.key.toLowerCase())&&inside){
    event.preventDefault();undoBody(event.shiftKey||event.key.toLowerCase()==='y');return;
  }
  if((event.target===bodyEditor||bodyEditor.contains(event.target)))return;
  if(['Delete','Backspace'].includes(event.key)&&inside&&eraseAtCaret(event.key==='Backspace')){event.preventDefault();return;}
  if(['ArrowLeft','ArrowRight'].includes(event.key)&&document.activeElement===manuscript){
    const at=bodyRange();
    if(at&&at[0]===at[1]){
      const step=adjacentRange(editorLayout(draft).text,at[0],event.key==='ArrowLeft');
      if(step){event.preventDefault();restoreBodySelection([event.key==='ArrowLeft'?step[0]:step[1]]);return;}
    }
  }
  const range=selectionInside();
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'&&(range||manuscript.contains(event.target))){
    event.preventDefault();
    const all=document.createRange();all.selectNodeContents(manuscript);
    window.getSelection().removeAllRanges();window.getSelection().addRange(all);
  }else if(['Delete','Backspace'].includes(event.key)&&range){
    event.preventDefault();deleteSelection();
  }else if(range&&event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
    const span=renderedSelection(range);
    if(!span)return;
    event.preventDefault();editBodyRange(span,event.key);
  }
});
$('delete-sentence').onclick=()=>{
  if(!draft||selected===null||mode==='source'||switching)return;
  const wasDeleted=deleted(draft,selected), next={...noteAt(selected)};
  if(wasDeleted)delete next.deleted;else next.deleted=true;
  applyBodyEdit(new Map([[selected,next]]));
  repaintAtScroll();paintEditor();
  outputStatus(wasDeleted?'已恢复原句或此前的改版。':'已删除本句，原文保留。');
};

opinion.oninput = () => updateNote('opinion',opinion.value);
revision.oninput = () => updateNote('revision',revision.value);

function importedText(name,input,markdown,edits=parseAnnotated(input)) {
  const source=edits.source;
  const format=markdown?'markdown':'plain';
  const value=createDraft(name,source,null,[],{format,spans:markdown?markdownSpans(source):undefined});
  if(edits.markers.length||edits.removed.length)value.notices.push('已识别审稿痕迹，保留原文并还原意见与改动。');
  return applyImportedEdits(value,edits);
}
function showWorkspace(record) {
  window.getSelection()?.removeAllRanges();pointerEdit=null;suppressClick=false;
  draft = record?.draft ?? null;
  bodyUndo=[];bodyRedo=[];pasteCaret=null;
  markdownMode = Boolean(draft && (draft.format === 'markdown' || (!draft.format && (/\.md$/i.test(draft.name) ||
    (draft.name === '粘贴的稿件' && looksLikeMarkdown(draft.source))))));
  active = record?.meta ?? null;
  generation = savedGeneration = 0;
  mode = 'split'; selected = null; renderSource = false;
  notice(draft?.notices.join(' ') ?? '');
  paintReading(); paintEditor();
  reading.scrollTop = 0;
  document.querySelector('.review-body').scrollTop = 0;
  saveLabel(draft ? '已保存' : '');
}
async function switchWorkspace(load) {
  if (switching) return false;
  switching = true;
  opinion.readOnly = revision.readOnly = true;
  updateDeleteControls();
  try {
    if (!await flush()) return false;
    const record = await load();
    showWorkspace(record);
    $('history-menu').open = false;
    if (record?.meta.kind === 'ai' && record.meta.unread) await acknowledgeDraft(record.meta.id);
    if (record?.meta.revision === 0) {
      generation++;
      await persist();
    }
    if (record) void opinionUI.refresh(record.meta.id);
    return true;
  } catch {
    outputStatus('无法打开稿件。当前内容未更改。',true);
    return false;
  } finally {
    switching = false;
    opinion.readOnly = revision.readOnly = false;
    updateDeleteControls();
  }
}
function addDraft(value,kind) {
  return switchWorkspace(() => ({
    draft:value, meta:{id:crypto.randomUUID(), kind, revision:0, createdAt:Date.now()}
  }));
}

const kindLabels = {paste:'粘贴',import:'导入',backup:'备份导入',legacy:'旧版记录',ai:'AI 来稿'};
const dates = new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'medium'});
let historyRequest = 0, historyFilter = 'live', historyTrashRecords=[];
function setHistoryFilter(next){
  historyFilter=next;
  $('history-live').setAttribute('aria-pressed',String(next==='live'));
  $('history-trash').setAttribute('aria-pressed',String(next==='trash'));
  refreshHistory();
}
$('history-live').onclick=()=>setHistoryFilter('live');
$('history-trash').onclick=()=>setHistoryFilter('trash');
async function refreshHistory() {
  const token = ++historyRequest, inTrash=historyFilter==='trash';
  const list = $('history-list'), state = $('history-state');
  state.hidden = false;
  state.textContent = '正在读取…';
  $('history-empty-trash').hidden = true;
  try {
    await migration;
    const records = await (inTrash?listDeletedRecords():listRecords());
    if (token !== historyRequest) return;
    list.replaceChildren();
    if(!inTrash)showAiInbox(records);
    else {historyTrashRecords=records;$('history-empty-trash').hidden=!records.length;}
    state.textContent = inTrash?'没有已删除的稿件。':'还没有历史稿件。导入或粘贴一份稿件后会自动保存。';
    state.hidden = records.length > 0;
    for (const meta of records) {
      const li = document.createElement('li'), row = document.createElement('button');
      const title = document.createElement('strong'), detail = document.createElement('small');
      row.type = 'button';
      row.className = 'history-row';
      row.dataset.record = meta.id;
      const current = meta.id === active?.id;
      if (current) row.setAttribute('aria-current','true');
      title.textContent = meta.name;
      row.append(title);
      if (meta.preview) {
        const preview = document.createElement('span');
        preview.className = 'history-preview';
        preview.textContent = meta.preview;
        row.append(preview);
      }
      detail.textContent = (current ? '当前 · ' : '') + (kindLabels[meta.kind] ?? '稿件') +
        ' · '+ dates.format(meta.updatedAt) +
        ' · '+meta.opinions+' 条意见 · '+meta.changes+' 处改写';
      row.append(detail);
      if (meta.aiReview || meta.humanReview || meta.unread) {
        const tags=document.createElement('span');tags.className='history-tags';
        for(const label of [meta.unread&&'新稿',meta.aiReview&&'AI 审稿',meta.humanReview&&'人工审稿'].filter(Boolean)){
          const tag=document.createElement('span');tag.textContent=label;tags.append(tag);
        }
        row.append(tags);
      }
      row.onclick = async () => {
        if (meta.id === active?.id) { $('history-menu').open = false; return; }
        await switchWorkspace(async () => {
          const record = await readRecord(meta.id);
          if (!record) throw new Error('找不到历史稿件。');
          record.draft = restoreDraft(record.draft);
          return record;
        });
      };
      if(inTrash){
        row.disabled=true;
        row.removeAttribute('aria-current');
      }
      const action=document.createElement('button');
      action.type='button';action.className='history-item-action';
      action.textContent=inTrash?'恢复':'删除';
      action.setAttribute('aria-label',(inTrash?'恢复 ':'删除 ')+meta.name);
      action.onclick=()=>inTrash?restoreHistory(meta,action):askDeleteHistory(meta);
      const actions=document.createElement('span');actions.className='history-item-actions';actions.append(action);
      if(inTrash){
        const purge=document.createElement('button');purge.type='button';purge.className='history-item-action';
        purge.textContent='彻底删除';purge.setAttribute('aria-label','彻底删除 '+meta.name);
        purge.onclick=()=>askPurgeHistory([meta],false);actions.append(purge);
      }
      li.append(row,actions);
      list.append(li);
    }
  } catch {
    if (token !== historyRequest) return;
    list.replaceChildren();
    state.textContent = '无法读取本地历史。请关闭菜单后重试。';
  }
}
$('history-menu').addEventListener('toggle', () => {
  if ($('history-menu').open) refreshHistory();
  else historyRequest++;
});
$('new-draft').onclick = () => switchWorkspace(() => null);
const historyDeleteDialog=$('history-delete-dialog');
let historyTarget=null,historyPurge=null,historyMutation=false;
function askDeleteHistory(meta){
  if(historyMutation)return;
  historyTarget=meta;historyPurge=null;
  $('history-delete-title').textContent='删除历史记录？';
  $('history-delete-description').textContent='「'+meta.name+'」会移到「已删除」。正文、意见和改版都可以恢复。';
  $('history-delete-confirm').textContent='删除记录';
  $('history-delete-error').hidden=true;
  historyDeleteDialog.showModal();
  $('history-delete-cancel').focus();
}
function askPurgeHistory(records,bulk){
  if(historyMutation||!records.length)return;
  historyTarget=null;
  historyPurge=records.map(({id,revision})=>({id,revision}));
  $('history-delete-title').textContent=bulk?'清空回收站？':'彻底删除这份稿件？';
  $('history-delete-description').textContent=(bulk?'将彻底删除回收站里的 '+records.length+' 份稿件。':'将彻底删除「'+records[0].name+'」。')+
    '相关正文、改版、意见和审稿记录都不能恢复。原文件和单独导出的备份不会被删除。';
  $('history-delete-confirm').textContent=bulk?'清空回收站':'彻底删除';
  $('history-delete-error').hidden=true;
  historyDeleteDialog.showModal();
  $('history-delete-cancel').focus();
}
$('history-empty-trash').onclick=()=>askPurgeHistory(historyTrashRecords,true);
historyDeleteDialog.addEventListener('cancel',event=>{if(historyMutation)event.preventDefault();});
historyDeleteDialog.addEventListener('close',()=>{if(!historyDeleteDialog.open)historyTarget=historyPurge=null;});
$('history-delete-cancel').onclick=()=>historyDeleteDialog.close();
$('history-delete-confirm').onclick=async()=>{
  const meta=historyTarget,purge=historyPurge;
  if((!meta&&!purge)||historyMutation||switching)return;
  historyMutation=switching=true;
  $('history-delete-confirm').disabled=$('history-delete-cancel').disabled=true;
  opinion.readOnly=revision.readOnly=true;
  updateDeleteControls();
  try{
    if(purge){
      const {ids,compacted}=await reviewApi('trash/purge',{entries:purge});
      let browserClean=true;
      try{await forgetPurged(ids);}catch{browserClean=false;}
      historyDeleteDialog.close();$('history-menu').open=true;refreshHistory();
      const message='已彻底删除 '+ids.length+' 份稿件。'+(compacted?'已整理本地库空间。':'空间整理暂未完成。')+(browserClean?'':'旧浏览器副本会在下次打开时重试清理。');
      outputStatus(message,!compacted||!browserClean);
      return;
    }
    const isCurrent=active?.id===meta.id;
    if(isCurrent&&!await flush())throw new Error('这份稿件尚未保存。请先保存或备份再删除。');
    await reviewApi(pathFor(meta.id,'trash'),{revision:isCurrent?active.revision:meta.revision});
    if(isCurrent)showWorkspace(null);
    historyDeleteDialog.close();
    $('history-menu').open=true;
    refreshHistory();
    outputStatus('已移到「已删除」，可以恢复。');
    pollAi();
  }catch(error){
    const detail=$('history-delete-error');
    detail.textContent=error.message||'无法删除这份稿件。';
    detail.hidden=false;
  }finally{
    historyMutation=switching=false;
    $('history-delete-confirm').disabled=$('history-delete-cancel').disabled=false;
    opinion.readOnly=revision.readOnly=false;
    updateDeleteControls();
  }
};
async function restoreHistory(meta,button){
  if(historyMutation)return;
  historyMutation=true;button.disabled=true;
  try{
    await reviewApi(pathFor(meta.id,'restore'),{revision:meta.revision});
    outputStatus('已恢复到历史记录。');
    refreshHistory();pollAi();
  }catch(error){
    outputStatus(error.message||'无法恢复这份稿件。',true);
    button.disabled=false;
  }finally{historyMutation=false;}
}


let pasteFormatTouched = false, detectTimer = 0;
const pasteFormat = $('paste-markdown');
pasteFormat.onchange = () => {pasteFormatTouched = true; clearTimeout(detectTimer);};
$('paste-text').oninput = () => {
  clearTimeout(detectTimer);
  if (!pasteFormatTouched) detectTimer = setTimeout(() => {pasteFormat.checked = looksLikeMarkdown(parseAnnotated($('paste-text').value).source);},150);
};
$('paste').onclick = () => {
  $('paste-error').hidden = true;
  $('paste-dialog').showModal();
  $('paste-text').focus();
};
for (const control of document.querySelectorAll('[data-close]')) control.onclick = () => $(control.dataset.close).close();
$('paste-form').onsubmit = async event => {
  event.preventDefault();
  const submit = $('paste-submit');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const source = $('paste-text').value;
    const markdown = pasteFormatTouched ? pasteFormat.checked : looksLikeMarkdown(parseAnnotated(source).source);
    const next = importedText(markdown?'粘贴的稿件.md':'粘贴的稿件',source,markdown);
    if (!await addDraft(next,'paste')) throw new Error('当前稿件还没保存，已保留这次粘贴的文字。');
    $('paste-dialog').close();
    $('paste-text').value = '';
    clearTimeout(detectTimer);
    pasteFormatTouched = pasteFormat.checked = false;
  } catch (error) {
    $('paste-error').textContent = error.message;
    $('paste-error').hidden = false;
  } finally {submit.disabled = false;}
};
$('import').onclick = () => $('file').click();
function readText(buffer) {
  const bytes = new Uint8Array(buffer);
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' :
    bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  try {return new TextDecoder(encoding,{fatal:true}).decode(bytes);}
  catch {throw new Error('文本编码无法读取。请将文件另存为 UTF-8 后重试。');}
}
async function importFile(file) {
  if (!file || busy) return;
  busy = true;
  $('import').disabled = $('paste').disabled = $('drop-file').disabled = true;
  try {
    const ext = file.name.split('.').at(-1).toLowerCase();
    if (!['txt','md','docx','json'].includes(ext)) throw new Error('请选择 TXT、Markdown、Word 或审稿备份。');
    const buffer = await file.arrayBuffer();
    let next;
    if (ext === 'docx') {
      const {source, paragraphBreaks, notices} = await readDocx(buffer);
      next = createDraft(file.name,source,paragraphBreaks,notices);
    } else {
      const text = readText(buffer);
      if (ext === 'json') {
        let value;
        try {value = JSON.parse(text);} catch {throw new Error('这不是有效的逐句审稿备份。');}
        next = restoreDraft(value);
      } else {
        const edits=parseAnnotated(text);
        next=importedText(file.name,text,ext==='md'||looksLikeMarkdown(edits.source),edits);
      }
    }
    await addDraft(next,ext === 'json' ? 'backup' : 'import');
  } catch (error) {
    notice('导入失败：'+(error.message || '没有读到正文。'), true);
  } finally {
    busy = false;
    $('import').disabled = $('paste').disabled = $('drop-file').disabled = false;
  }
}
const dropButton=$('drop-file');
dropButton.onclick=()=> $('file').click();
$('file').onchange=()=>{
  const file=$('file').files[0];
  $('file').value='';
  importFile(file);
};
const carriesFiles=event=>Array.from(event.dataTransfer?.types??[]).includes('Files');
const canDrop=event=>!draft&&!busy&&!document.querySelector('dialog[open]')&&reading.contains(event.target);
document.addEventListener('dragover',event=>{
  if(!carriesFiles(event))return;
  event.preventDefault();
  const accepts=canDrop(event);
  event.dataTransfer.dropEffect=accepts?'copy':'none';
  dropButton.dataset.dragging=accepts;
});
reading.addEventListener('dragleave',event=>{
  if(!reading.contains(event.relatedTarget))dropButton.dataset.dragging=false;
});
document.addEventListener('dragend',()=>{dropButton.dataset.dragging=false;});
document.addEventListener('drop',event=>{
  if(!carriesFiles(event))return;
  event.preventDefault();
  dropButton.dataset.dragging=false;
  if(!canDrop(event))return;
  const files=event.dataTransfer.files;
  if(files.length!==1){notice('请一次拖入一个文件。');return;}
  importFile(files[0]);
});
function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
let toastTimer = 0;
function outputStatus(message, failed = false) {
  const toast = $('output-state');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.error = failed;
  toast.hidden = !message;
  if (message) toastTimer = setTimeout(() => {toast.hidden = true;},failed ? 6500 : 3000);
}
async function outputDraft(kind, copy = false) {
  if (!draft) return;
  if(paragraphPending){outputStatus('正在保存新段落，请稍后再导出。');return;}
  persist();
  const base = draft.name.replace(/\.(?:txt|md|docx)$/i,'').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');
  $('export-menu').open = false;
  if (kind === 'backup') {
    const backup=structuredClone(draft);
    for(const [i,n] of Object.entries(backup.notes))if(n.autoOpinion){
      n.opinion=effectiveOpinion(backup,Number(i));delete n.autoOpinion;
    }
    download(JSON.stringify(backup,null,2),base+' · 审稿备份.json','application/json');
    return;
  }
  const clean = kind === 'clean';
  const changes = kind === 'changes';
  const content = clean ? revisedText(draft) : changes ? annotatedChanges(draft) : annotatedText(draft,isMarkdown()&&draft.insertions?.length?markdownSpans(draft.source):undefined);
  if(changes&&!content){outputStatus('还没有改动或意见可以复制。');return;}
  if (copy) {
    try {
      await navigator.clipboard.writeText(content);
      outputStatus(clean ? '已复制修改版' : changes ? '已复制改动与意见' : '已复制带注原文');
    } catch {
      outputStatus('无法写入剪贴板，可以改用导出文件。',true);
    }
    return;
  }
  const suffix = clean ? ' · 修改版.'+(isMarkdown() ? 'md' : 'txt') : ' · 带注原文.txt';
  download(content,base+suffix,'text/plain;charset=utf-8');
}
$('export-text').onclick = () => outputDraft('clean');
$('copy-text').onclick = () => outputDraft('clean',true);
$('export-diff').onclick = () => outputDraft('diff');
$('copy-diff').onclick = () => outputDraft('diff',true);
$('copy-changes').onclick = () => outputDraft('changes',true);
$('export-backup').onclick = () => outputDraft('backup');
const dropdowns = [$('export-menu'),$('history-menu'),$('change-options')];
document.addEventListener('click', event => {
  if(event.target.closest?.('#history-delete-dialog'))return;
  // 「AI 来稿」 opens the history list from outside it; that same click must not close it again.
  const opener = event.target.closest?.('#ai-inbox,#ai-arrival-open') ? $('history-menu') : null;
  for (const menu of dropdowns) if (menu.open && menu !== opener && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  for (const menu of dropdowns) {
    if (!menu.open) continue;
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});
const splitter = $('splitter');
const workspace = document.querySelector('.workspace');
const splitKey = 'diffwrite.sentence-review.split-ratio';
let splitRatio = 0.6, dragPointer = null, dragOffset = 0;
try {
  const saved = Number(localStorage.getItem(splitKey));
  if (saved >= 0.2 && saved <= 0.82) splitRatio = saved;
} catch {}
function splitBounds() {
  const width = Math.max(1,workspace.getBoundingClientRect().width-12);
  return [Math.max(0.2,248/width),Math.min(0.82,1-270/width)];
}
function applySplit(value = splitRatio, save = false) {
  const [min,max] = splitBounds();
  const actual = min <= max ? Math.min(max,Math.max(min,value)) : 0.6;
  if (save) {
    splitRatio = actual;
    try {localStorage.setItem(splitKey,String(actual));} catch {}
  }
  workspace.style.setProperty('--left-ratio',String(actual));
  splitter.setAttribute('aria-valuemin',String(Math.round(min*100)));
  splitter.setAttribute('aria-valuemax',String(Math.round(max*100)));
  splitter.setAttribute('aria-valuenow',String(Math.round(actual*100)));
  splitter.setAttribute('aria-valuetext','左侧 '+Math.round(actual*100)+'%');
}
splitter.addEventListener('pointerdown',event=>{
  if (event.button!==0 || dragPointer!==null) return;
  event.preventDefault();
  splitter.focus({preventScroll:true});
  dragPointer = event.pointerId;
  dragOffset = event.clientX - (splitter.getBoundingClientRect().left+6);
  splitter.setPointerCapture(event.pointerId);
  workspace.classList.add('is-resizing');
});
splitter.addEventListener('pointermove',event=>{
  if (event.pointerId!==dragPointer) return;
  const box = workspace.getBoundingClientRect();
  applySplit((event.clientX-box.left-dragOffset-6)/(box.width-12));
});
splitter.addEventListener('lostpointercapture',()=>{
  dragPointer = null;
  workspace.classList.remove('is-resizing');
  applySplit(Number(workspace.style.getPropertyValue('--left-ratio')),true);
});
splitter.addEventListener('dblclick',()=>applySplit(0.6,true));
splitter.addEventListener('keydown',event=>{
  const actions = {ArrowLeft:-0.02,ArrowRight:0.02,Home:-1,End:1};
  if (!Object.hasOwn(actions,event.key)) return;
  event.preventDefault();
  applySplit(Number(workspace.style.getPropertyValue('--left-ratio'))+actions[event.key],true);
});
window.addEventListener('resize',()=>{if (dragPointer===null) applySplit();});
applySplit();

const openedAt = Date.now();
let catalogSnapshot = '', refreshingAi = false;
const pathFor = (id,action='')=>'drafts/'+encodeURIComponent(id)+(action?'/'+action:'');
const aiTagged=()=>Object.keys(draft?.aiMarks??{}).map(Number).sort((a,b)=>a-b);
function aiButtons() {
  const count=aiTagged().length;
  $('ai-next').hidden=!count;
  $('ai-next').textContent='AI 审稿 '+count;
  $('ai-legend').hidden=!count;
}
function paintRemoteRecord(){
  const focused=document.activeElement;
  const textFocus=focused===opinion||focused===revision;
  const previousValue=textFocus?focused.value:null;
  const caret=textFocus?[focused.selectionStart,focused.selectionEnd,focused.selectionDirection]:null;
  const body=document.querySelector('.review-body'), scroll=body.scrollTop;
  const focusedIndex=focused?.classList?.contains('sentence')?Number(focused.dataset.index):null;
  repaintAtScroll();
  paintEditor();
  body.scrollTop=scroll;
  // Text appended after the caret (an AI part following the author's opinion) leaves the caret where it was.
  if(textFocus&&focused.value.slice(0,caret[1])===previousValue.slice(0,caret[1]))focused.setSelectionRange(...caret);
  if(focusedIndex!==null)cellAt(focusedIndex)?.focus({preventScroll:true});
}
function focusedFieldWouldChange(next){
  if(selected===null||mode==='source')return false;
  const target=document.activeElement;
  if(manuscript.contains(target))return editorLayout(next).text!==editorLayout(draft).text;
  if(target!==opinion&&target!==revision)return false;
  const value=next.notes[selected]?.[target===opinion?'opinion':'revision']??'';
  // An AI part appended after what the author sees can be shown at once; any other change waits for blur.
  if(target===opinion)return !value.startsWith(target.value);
  return target.value!==value||deleted(draft,selected)!==deleted(next,selected);
}
for(const field of [opinion,revision])field.addEventListener('blur',()=>setTimeout(pollAi,0));
function loadSameRecord(record){
  draft=restoreDraft(record.draft);
  active=record.meta;
  repaintAtScroll(true);
  paintEditor();
  saveLabel('已保存');
}
async function dismissTags(target){
  if(!active||switching)return;
  const id=active.id;
  switching=true;opinion.readOnly=revision.readOnly=true;updateDeleteControls();
  try{
    if(!await flush())return;
    const record=await reviewApi(pathFor(id,'ai-tags'),{...target,revision:active.revision});
    if(active?.id!==id)return;
    loadSameRecord(record);
    if(target.sentence===undefined){
      const left=aiTagged().length;
      outputStatus(left?'已去掉标记。还有 '+left+' 句留着你被 AI 替换前的改写，请逐句确认。':'已去掉全部 AI 审稿标记，内容不变。');
    }
  }catch(error){
    outputStatus(error.message||'无法更新标记。',true);
  }finally{
    switching=false;opinion.readOnly=revision.readOnly=false;updateDeleteControls();
  }
}
$('opinion-ai-seen').onclick=()=>dismissTags({sentence:selected,field:'opinion'});
$('revision-ai-seen').onclick=()=>dismissTags({sentence:selected,field:'body'});
$('ai-seen-all').onclick=()=>dismissTags({});
$('revision-swap').onclick=()=>{
  const saved=draft?.aiMarks?.[selected]?.replaced;
  if(!saved||mode==='source'||switching)return;
  const next={...noteAt(selected),revision:saved.revision};
  if(saved.deleted)next.deleted=true;else delete next.deleted;
  clearAiMark(selected,'revision');setNote(selected,next);
  updateDeleteControls();repaintAtScroll();paintEditor();scheduleSave();
  opinionUI.edited(selected);
  outputStatus('已换回你自己的改写。');
};
$('ai-next').onclick=()=>{
  const indices=aiTagged();
  const i=indices.find(i=>i>(selected??-1)) ?? indices[0];
  if(i===undefined)return;
  if(mode==='source'||!cellAt(i))setMode('split');
  if(!cellAt(i)&&isMarkdown()&&!renderSource){renderSource=true;repaintAtScroll();}
  select(i);cellAt(i)?.scrollIntoView({block:'center'});
};
const notifyDialog=$('notify-dialog'), notifyRecipient=$('notify-recipient');
const notifySend=$('notify-send'), notifyTarget=$('notify-target'), notifyManage=$('notify-manage');
const notifyPreference='diffwrite-recipient';
let notifyDraft=null,notifyView=0,notifying=false;
function notifyStatus(text='',failed=false){
  const status=$('notify-status');
  status.textContent=text;status.hidden=!text;status.classList.toggle('error',failed);
}
async function loadRecipients(){
  const view=++notifyView;
  notifySend.disabled=true;notifyTarget.hidden=true;notifyManage.hidden=true;
  notifyStatus('正在读取收件人…');
  try{
    const recipients=await reviewApi('mcp-recipients');
    if(!notifyDialog.open||view!==notifyView)return;
    let previous;
    try{previous=localStorage.getItem(notifyPreference);}catch{}
    notifyRecipient.replaceChildren(...recipients.map(({id,name})=>new Option(name,id)));
    if(recipients.some(r=>r.id===previous))notifyRecipient.value=previous;
    notifyTarget.hidden=!recipients.length;notifySend.hidden=!recipients.length;
    notifyManage.hidden=Boolean(recipients.length);
    notifySend.disabled=!recipients.length;
    notifyStatus(recipients.length?'':'请先为收件人生成一条 MCP 连接。');
    (recipients.length?notifyRecipient:notifyManage).focus();
  }catch(error){
    if(notifyDialog.open&&view===notifyView){notifyStatus(error.message,true);notifyManage.hidden=false;}
  }
}
$('notify-ai').onclick=()=>{
  if(!active?.id||switching||notifying)return;
  notifyDraft=active.id;
  notifyDialog.showModal();
  void loadRecipients();
};
notifyManage.onclick=()=>{notifyDialog.close();$('mcp-open').click();};
notifyDialog.addEventListener('cancel',event=>{if(notifying)event.preventDefault();});
$('notify-form').onsubmit=async event=>{
  event.preventDefault();
  const id=notifyDraft,recipient=notifyRecipient.value;
  if(notifying||!id||active?.id!==id||switching||!recipient)return;
  notifying=true;notifySend.disabled=notifyRecipient.disabled=$('notify-cancel').disabled=true;
  notifyStatus('正在保存…');
  try{
    if(!await flush()||active?.id!==id){notifyStatus('稿件还没保存，未发送通知。',true);return;}
    const result=await reviewApi(pathFor(id,'notify'),{revision:active.revision,recipient});
    try{localStorage.setItem(notifyPreference,recipient);}catch{}
    notifyDialog.close();
    outputStatus(result.queued?'已留给 '+result.recipient+' · '+result.changeCount+' 处更新':'没有要发给 '+result.recipient+' 的新改动');
  }catch(error){
    if(error.status===404)await loadRecipients();
    notifyStatus(error.message||'无法通知 AI。',true);
  }finally{
    notifying=false;notifyRecipient.disabled=$('notify-cancel').disabled=false;
    notifySend.disabled=notifyTarget.hidden;
  }
};
function showAiInbox(records){
  const unread=records.filter(x=>x.kind==='ai'&&x.unread);
  const button=$('ai-inbox');
  button.hidden=!unread.length;
  button.textContent='AI 来稿 '+unread.length;
  return unread;
}
const announcedDrafts=new Set();let arrivalTimer;
function announceIncoming(records){
  const fresh=records.filter(x=>x.createdAt>=openedAt&&!announcedDrafts.has(x.id));
  if(!fresh.length)return;
  for(const item of fresh)announcedDrafts.add(item.id);
  $('ai-arrival-title').textContent=fresh.length===1?'收到 AI 新稿':'收到 '+fresh.length+' 份 AI 新稿';
  $('ai-arrival-names').replaceChildren(...fresh.map(item=>{const li=document.createElement('li');li.textContent=item.name;li.title=item.name;return li;}));
  $('ai-arrival').style.top=document.querySelector('.toolbar').getBoundingClientRect().bottom+12+'px';
  $('ai-arrival').hidden=false;clearTimeout(arrivalTimer);
  arrivalTimer=setTimeout(()=>$('ai-arrival').hidden=true,10000);
}
$('ai-arrival-close').onclick=()=>{$('ai-arrival').hidden=true;clearTimeout(arrivalTimer);};
$('ai-arrival-open').onclick=()=>{$('ai-arrival').hidden=true;setHistoryFilter('live');$('history-menu').open=true;void refreshHistory();};
$('ai-inbox').onclick=()=>{setHistoryFilter('live');$('history-menu').open=true;};
async function acknowledgeDraft(id){
  try {await reviewApi(pathFor(id,'seen'),{});}catch{}
}
async function pollAi(){
  if(refreshingAi || document.hidden)return;
  refreshingAi=true;
  try{
    await migration;
    const records=await listRecords();
    const signature=JSON.stringify(records);
    if(signature!==catalogSnapshot){
      catalogSnapshot=signature;
      if($('history-menu').open)refreshHistory();
    }
    const unread=showAiInbox(records);
    announceIncoming(unread);
    const fresh=unread.find(x=>x.createdAt>=openedAt);
    if(fresh && !draft && !switching && !busy && !document.querySelector('dialog[open]') && !$('history-menu').open){
      await switchWorkspace(async()=>{
        const record=await readRecord(fresh.id);
        record.draft=restoreDraft(record.draft);
        return record;
      });
    }
    void opinionUI.syncSettings();
    void syncMcpMode();
    if(active && !switching){
      const item=records.find(x=>x.id===active.id);
      if(item && item.revision>active.revision && !isDirty()&&!saveInFlight&&!inlineEdit){
        const id=active.id;
        const record=await readRecord(id);
        if(active?.id===id&&!isDirty()&&!switching&&!inlineEdit&&record.meta.revision>active.revision){
          if(focusedFieldWouldChange(record.draft)){
            // The focused box is left alone until the author leaves it; only flag what an AI just wrote.
            for(const i of Object.keys(record.draft.aiMarks??{})){
              if(JSON.stringify(draft.notes[i])===JSON.stringify(record.draft.notes[i]))continue;
              for(const cell of cells.get(Number(i))??[]){cell.dataset.aiEdited='true';cell.title='AI 刚写了这句，离开输入框后显示';}
            }
          }else{
            if(record.draft.source!==draft.source){
              bodyUndo=[];bodyRedo=[];selected=null;pasteCaret=null;markdownMode=record.draft.format==='markdown';
            }
          draft=restoreDraft(record.draft);active=record.meta;
            paintRemoteRecord();
          }
        }
      }
      if(!isDirty())void opinionUI.refresh();
    }
  }catch{/* explicit controls show API errors; polling keeps the current work intact */}
  finally{refreshingAi=false;}
}

const tokenDialog=$('mcp-dialog'), connectionList=$('mcp-connections'), connectionForm=$('mcp-create');
const connectionName=$('mcp-name');
let connectionRows=[], connectionBusy=false, confirmConnection=null, connectionView=0;
function connectionStatus(text='',failed=false){
  const status=$('mcp-state');
  status.textContent=text;status.hidden=!text;status.classList.toggle('error',failed);
}
function connectionAction(text,action,style=''){
  const button=document.createElement('button');
  button.type='button';button.textContent=text;button.className=style;button.onclick=action;
  button.disabled=connectionBusy;
  return button;
}
function paintConnections(){
  connectionList.replaceChildren(...connectionRows.map(({id,name,masked})=>{
    const row=document.createElement('li'),details=document.createElement('div'),title=document.createElement('strong');
    const code=document.createElement('code'),actions=document.createElement('div');
    title.textContent=name;
    code.textContent=masked??'旧连接码可用，重刷后可复制';
    details.append(title,code);
    actions.className='connection-actions';
    if(confirmConnection?.id===id){
      const action=confirmConnection.action;
      actions.append(connectionAction('取消',()=>{confirmConnection=null;paintConnections();connectionStatus();}),
        connectionAction(action==='revoke'?'确认撤销':'确认重刷',()=>changeConnection(id,action,true),'danger'));
    }else{
      const copy=connectionAction('复制连接信息',()=>copyMcpConnection(id,name));
      copy.disabled||=!masked;
      const confirm=action=>{
        confirmConnection={id,action};paintConnections();
        connectionStatus(action==='revoke'?'撤销后「'+name+'」的旧码失效，其待办不会转给其他连接。':'重刷只作废「'+name+'」的旧码，待办保留。');
        rowButton(id)?.focus();
      };
      actions.append(copy,connectionAction('重刷',()=>confirm('rotate')),connectionAction('撤销',()=>confirm('revoke')));
    }
    row.dataset.connection=id;row.append(details,actions);
    return row;
  }));
  for(const el of connectionForm.elements)el.disabled=connectionBusy;
}
const rowButton=id=>connectionList.querySelector('[data-connection="'+id+'"] button:not(:disabled)');
let mcpMode=null, mcpModeBusy=false;
function paintMcpMode(enabled){
  if(enabled===mcpMode)return;
  mcpMode=enabled;
  $('mcp-open').dataset.on=enabled;
  $('mcp-open').textContent=enabled?'MCP 已开启':'MCP 连接';
  $('mcp-mode').checked=enabled;
  $('mcp-mode-note').textContent=enabled
    ?'已开启：连接的 AI 可以直接写意见和改写，写进去的内容带「AI 审稿」标记。网页自带的 AI 补全已停用，避免两个 AI 同时写。'
    :'未开启：连接的 AI 只能读稿，不能写入；网页自带的 AI 补全可以使用。';
  opinionUI.setAllowed(!enabled);
}
async function syncMcpMode(){
  if(mcpModeBusy)return;
  try{
    const {enabled}=await reviewApi('mcp-mode');
    if(!mcpModeBusy)paintMcpMode(enabled);
  }catch{/* the dialog reports errors when the author changes the mode */}
}
$('mcp-mode').onchange=async event=>{
  const enabled=event.target.checked;
  mcpModeBusy=true;event.target.disabled=true;
  try{
    paintMcpMode((await reviewApi('mcp-mode',{enabled})).enabled);
    connectionStatus(enabled?'MCP 模式已开启。':'MCP 模式已关闭，连接的 AI 现在只能读取。');
  }catch(error){
    event.target.checked=!enabled;
    connectionStatus(error.message,true);
  }finally{mcpModeBusy=false;event.target.disabled=false;}
};
async function loadConnections(){
  const result=await reviewApi('mcp-connections');
  connectionRows=result.connections;
  $('mcp-address').textContent=result.url;
}
$('mcp-open').onclick=async()=>{
  if(tokenDialog.open||connectionBusy)return;
  const view=++connectionView;
  connectionBusy=true;confirmConnection=null;connectionRows=[];
  $('mcp-address').textContent=location.origin+'/mcp';
  connectionStatus('正在读取连接…');paintConnections();
  tokenDialog.showModal();
  try{
    await loadConnections();
    if(view===connectionView)connectionStatus(connectionRows.length?'':'还没有连接。生成后可复制 JSON 给 AI 工具。');
  }catch(error){if(view===connectionView)connectionStatus(error.message,true);}
  finally{connectionBusy=false;if(tokenDialog.open)paintConnections();}
};
tokenDialog.addEventListener('close',()=>{if(!tokenDialog.open){connectionView++;confirmConnection=null;connectionName.value='';}});
async function changeConnection(id,action,name){
  if(connectionBusy)return;
  const view=connectionView;
  connectionBusy=true;paintConnections();
  let created;
  try{
    if(action==='create'){
      ({id:created}=await reviewApi('mcp-connections',{name}));
      connectionName.value='';
    }else await reviewApi('mcp-connections/'+id+'/'+action,{});
    confirmConnection=null;
    await loadConnections();
    if(view===connectionView)connectionStatus(action==='create'?'已生成连接码，可以复制连接信息。':
      action==='rotate'?'连接码已重刷，原有待办仍在。':'连接已撤销。');
  }catch(error){if(view===connectionView)connectionStatus(error.message,true);}
  finally{
    connectionBusy=false;
    if(tokenDialog.open){paintConnections();(rowButton(created??id)??connectionName).focus();}
  }
}
connectionForm.onsubmit=event=>{
  event.preventDefault();
  void changeConnection(null,'create',connectionName.value);
};
async function copyMcpConnection(id,name){
  if(connectionBusy)return;
  const view=connectionView;
  connectionBusy=true;paintConnections();
  try{
    const {token,url}=await reviewApi('mcp-connections/'+id+'/copy',{});
    if(!tokenDialog.open||view!==connectionView)return;
    const server=id==='original'?'diffwrite':'diffwrite_'+id.replaceAll('-','_');
    const config=JSON.stringify({mcpServers:{[server]:{type:'http',url,headers:{Authorization:'Bearer '+token}}}},null,2);
    await navigator.clipboard.writeText(config);
    connectionStatus('已复制「'+name+'」的连接 JSON，内含完整连接码。');
  }catch(error){
    if(view===connectionView)connectionStatus(error.name==='NotAllowedError'?'浏览器没有允许写入剪贴板，请授权后重试。':error.message,true);
  }finally{
    connectionBusy=false;
    if(tokenDialog.open){paintConnections();rowButton(id)?.focus();}
  }
}

async function changePastedReview(request){
  if(!draft||switching)return null;
  const id=active.id;
  switching=true;opinion.readOnly=revision.readOnly=true;updateDeleteControls();
  try{
    if(!await flush()||active?.id!==id)return null;
    finishInline(false);
    const record=await reviewApi(pathFor(id,'paste-review'),{...request,revision:active.revision});
    draft=restoreDraft(record.draft);active=record.meta;
    markdownMode=draft.format==='markdown';
    if(!request.paragraph)renderSource=false;
    selected=record.focus??sentenceAt(editorLayout(draft),record.caret);
    pasteCaret=record.caret;
    window.getSelection()?.removeAllRanges();
    repaintAtScroll(true);paintEditor();
    restoreBodySelection([record.caret,record.caret]);
    saveLabel('已保存');
    outputStatus(request.paragraph?(request.action==='undo'?'已撤销分段。':'已重做分段。'):
      request.action==='undo'?'已撤销带注粘贴。':request.action==='redo'?'已重做带注粘贴。':'已插入当前稿件，还原意见与改动。');
    void opinionUI.refresh();
    return record;
  }catch(error){
    outputStatus(error.message||'粘贴失败，当前稿件未更改。',true);
    return null;
  }finally{
    switching=false;opinion.readOnly=revision.readOnly=false;updateDeleteControls();
    if(request.paragraph&&draft.insertedSlots?.includes(selected)&&!deleted(draft,selected))startAt(pasteCaret,selected);
  }
}
let pendingPasteWork=Promise.resolve();
function pasteAfterParagraph(pending,text){
  const value=bodyEditor.value,positions=[bodyEditor.selectionStart,bodyEditor.selectionEnd];
  const range=positions.map(p=>pending.edit.start+rawOffset(
    pending.edit.eol==='\r\n'?value.replaceAll('\n','\r\n'):value,p));
  const expected=value.slice(...positions).replaceAll('\r\n','\n');
  pendingPasteWork=pendingPasteWork.then(async()=>{
    if(!await pending.done)throw Error('新段落未建立，请重新粘贴；当前输入仍保留。');
    while(paragraphPending)if(!await paragraphPending.done)throw Error('分段未完成，请重新粘贴。');
    if(active?.id!==pending.id||switching||mode!=='split')throw Error('编辑位置已切换，请在目标位置重新粘贴。');
    const delta=pending.pasteDelta??0,[start,end]=range.map(p=>p+delta);
    if(editorLayout(draft).text.slice(start,end).replaceAll('\r\n','\n')!==expected)
      throw Error('选区内容已变化，请重新粘贴；没有覆盖后续输入。');
    const record=await changePastedReview({text,start,end});
    if(record){
      pending.pasteDelta=delta+record.caret-end;
      bodyUndo.push({token:record.token});if(bodyUndo.length>100)bodyUndo.shift();bodyRedo=[];updateDeleteControls();
    }
  }).catch(error=>outputStatus(error.message,true));
}
document.addEventListener('paste',event=>{
  if(paragraphPending&&!event.defaultPrevented&&(event.target===bodyEditor||bodyEditor.contains(event.target))){
    const text=event.clipboardData?.getData('text/plain');if(!text)return;
    event.preventDefault();
    const edits=parseAnnotated(text);
    if(edits.markers.length||edits.removed.length||edits.boundaries?.length||edits.slots?.length)
      pasteAfterParagraph(paragraphPending,text);
    else bodyEditor.setRangeText(text,bodyEditor.selectionStart,bodyEditor.selectionEnd,'end');
    return;
  }
  if(event.defaultPrevented||switching||busy||document.querySelector('dialog[open]'))return;
  const target=event.target;
  if(!manuscript.contains(target)&&target.closest?.('textarea,input,[contenteditable=true]'))return;
  const atPreview=mode==='split'&&(manuscript.contains(target)||Boolean(selectionInside()));
  const empty=!draft&&!target.closest?.('textarea,input,[contenteditable=true]');
  if(!atPreview&&!empty)return;
  const text=event.clipboardData?.getData('text/plain');
  if(!text?.trim()&&!atPreview)return;
  if(!text)return;
  const edits=parseAnnotated(text), annotated=edits.markers.length||edits.removed.length||edits.boundaries?.length||edits.slots?.length;
  if(empty){
    event.preventDefault();
    const md=looksLikeMarkdown(edits.source);
    try{void addDraft(importedText(md?'粘贴的稿件.md':'粘贴的稿件',text,md,edits),'paste');}
    catch(error){outputStatus(error.message,true);}
    return;
  }
  if(annotated){
    event.preventDefault();
    const layout=editorLayout(draft);
    const span=bodyRange()??[pasteCaret??layout.text.length,pasteCaret??layout.text.length];
    void changePastedReview({text,start:span[0],end:span[1]}).then(record=>{
      if(record){bodyUndo.push({token:record.token});if(bodyUndo.length>100)bodyUndo.shift();bodyRedo=[];updateDeleteControls();}
    });
    return;
  }
  event.preventDefault();
  if(inlineEdit){inlineEdit.hint=[bodyEditor.selectionStart,bodyEditor.selectionEnd];bodyEditor.setRangeText(text,...inlineEdit.hint,'end');commitInline();}
  else editBodyRange(bodyRange()??[pasteCaret??editorLayout(draft).text.length,pasteCaret??editorLayout(draft).text.length],text);
},true);

const migration = (async () => {
  try {
    let raw;
    try {raw = localStorage.getItem(legacyKey);} catch {}
    if (raw) {
      try {
        const value = restoreDraft(JSON.parse(raw));
        const meta = summarize({id:'legacy-v1',kind:'legacy',createdAt:Date.now()},value);
        await recoverLegacy(meta,value);
      } catch {
        outputStatus('有一份旧版记录暂未迁入历史，原记录仍保留。',true);
      }
    }
    await migrateHistory();
  } catch(error) {
    outputStatus(error.message || '旧历史暂未迁入，原记录仍保留。',true);
  }
})();
function opinionSentence(i){
  if(!draft||i===null||!draft.spans[i])return null;
  return {opinion:draft.notes[i]?.opinion??'',text:revised(draft,i),deleted:deleted(draft,i)};
}
let markedOpinionCells=new Set();
const opinionUI=setupOpinionUI({
  current:()=>{
    const i=mode==='source'?null:selected;
    return {id:active?.id??null,i,revision:active?.revision,dirty:isDirty(),blocked:switching||!active?.revision,
      ...opinionSentence(i),sentenceAt:opinionSentence};
  },
  pathFor,flush,download,
  paintMarks:runs=>{
    const candidates=new Set([...markedOpinionCells,...runs.keys()]);
    markedOpinionCells=new Set(runs.keys());
    for(const i of candidates)paintCellMarks(i,runs.has(i)||Boolean(draft?.notes[i]?.autoOpinion));
  },
  commit:async(id,item,action)=>{
    if(active?.id!==id||switching)return false;
    const keepFocus=document.activeElement===opinion;
    const start=opinion.selectionStart,end=opinion.selectionEnd;
    switching=true;opinion.readOnly=revision.readOnly=true;updateDeleteControls();
    try{
      if(!await flush()||active?.id!==id)return false;
      const record=await reviewApi(pathFor(id,'opinion-decision'),{runId:item.id,action,revision:active.revision});
      if(active?.id!==id)return false;
      loadSameRecord(record);
      if(keepFocus&&selected!==null){
        opinion.focus({preventScroll:true});
        if(action==='accept'&&selected===item.sentence)opinion.setSelectionRange(opinion.value.length,opinion.value.length);
        else opinion.setSelectionRange(start,end);
      }
      return true;
    }finally{
      switching=false;opinion.readOnly=revision.readOnly=false;updateDeleteControls();
    }
  }
});
showWorkspace(null);
pollAi();
setInterval(pollAi,1600);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollAi();});
