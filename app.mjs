import {fineChanges} from './changes.mjs';
import {createDraft, restoreDraft, original, modified, revised, effectiveOpinion, mergeDraftEdits, pieces, revisedText, annotatedText, annotatedChanges, deleted, deleteTextRanges, parseAnnotated, applyImportedEdits, editedOpinionMark} from './model.mjs';
import {setupOpinionUI} from './opinion-ui.mjs';
import {readDocx} from './docx.mjs';
import {saveRecord, readRecord, listRecords, listDeletedRecords, forgetPurged, recoverLegacy, migrateHistory, reviewApi, HistoryConflict} from './history.mjs';
import {markdownSpans, renderMarkdown, looksLikeMarkdown} from './markdown.mjs';

const $ = id => document.getElementById(id);
const manuscript = $('manuscript'), reading = $('reading-body');
const opinion = $('opinion'), revision = $('revision'), tabs = [...document.querySelectorAll('[data-mode]')];
const legacyKey = 'diffwrite.sentence-review.v1';
let draft = null, mode = 'split', selected = null, cursor = 0, cells = new Map(), active = null;
let renderSource = false, renderTimer = 0, markdownMode = false;
let cellOffsets = new WeakMap(), textOffsets = new WeakMap();
let showChanges=true, changeDetail='inline';
try{
  const pref=JSON.parse(localStorage.getItem('diffwrite-changes'));
  if(typeof pref?.show==='boolean')showChanges=pref.show;
  if(['inline','full','sentence'].includes(pref?.detail))changeDetail=pref.detail;
}catch{}
let generation = 0, savedGeneration = 0, saveInFlight = null;
let timer = 0, busy = false, switching = false;

function notice(text = '') {
  $('notice').textContent = text;
  $('notice').hidden = !text;
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
        : '无法写入本地历史。可以重试，或先导出审稿备份。');
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
  if (await flush()) notice(draft?.notices.join(' ') ?? '');
};
document.addEventListener('visibilitychange', () => {if (document.hidden) flush();});
window.addEventListener('beforeunload', event => {
  if (!isDirty()) return;
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
  if (!value) return;
  const span = document.createElement('span');
  span.className = 'sentence';
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
    if (isMarkdown() && !renderSource) span.setAttribute('aria-label',original(draft,i));
  }
  cells.get(i).push(span);
  span.textContent = value;
  if(start!==null)textOffsets.set(span.firstChild,start);
  parent.append(span);
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
    const write = (start,end,index,basis=null) => {
      if(end<=start) return;
      if(index===undefined) parent.append(document.createTextNode(value.slice(start,end)));
      else addCell(parent,index,value.slice(start,end),basis);
    };
    let k = nextRange(a);
    if (offsets === null) {
      write(0,value.length,ranges[k]?.[0]<b ? ranges[k][2] : undefined);
      return;
    }
    if (!offsets) {
      let start=a;
      while(k<ranges.length && ranges[k][0]<b) {
        const [from,to,i]=ranges[k++];
        write(start-a,from-a);
        write(Math.max(start,from)-a,Math.min(to,b)-a,i,Math.max(start,from)-from);
        start=Math.min(to,b);
      }
      write(start-a,b-a);
      return;
    }
    let from=0, active;
    for(let j=0;j<offsets.length;j++) {
      const offset=offsets[j];
      while(k<ranges.length && ranges[k][1]<=offset) k++;
      const index=ranges[k]?.[0]<=offset ? ranges[k][2] : undefined;
      if(index!==active) {write(from,j,active);from=j;active=index;}
    }
    write(from,value.length,active);
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
          ghost.textContent=drop.text;
          ghost.dataset.offset=drop.at;
          out.append(ghost);
        }
        const next=cuts[index+1];
        if(next===undefined)continue;
        const live=document.createTextNode(value.slice(pos,next));
        textOffsets.set(live,start+pos);
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
  clearTimeout(renderTimer);
  finishInline(false);
  document.body.dataset.empty = !draft;
  const md = isMarkdown();
  const rendered = md && !renderSource;
  manuscript.dataset.view = mode;
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
  textOffsets = new WeakMap();
  syncTabs();
  if (!draft) {
    manuscript.replaceChildren();
    updateDeleteControls();
    return;
  }
  const fragment = document.createDocumentFragment();
  const displayPieces = function*(){
    for(const [i,value] of pieces(draft,mode!=='source')) {
      const showDeleted=mode!=='source'&&showChanges&&changeDetail!=='inline'&&i!==null&&deleted(draft,i);
      yield [i,showDeleted?original(draft,i):value];
    }
  };
  if (rendered) {
    const ranges=[], text=[];
    let offset=0;
    for (const [i,value] of displayPieces()) {
      if (i!==null&&value.length) ranges.push([offset,offset+value.length,i]);
      offset+=value.length;
      text.push(value);
    }
    fragment.append(renderMarkdown(text.join(''),markdownDecorator(ranges)));
  } else {
    for (const [i,value] of displayPieces()) {
      if (i===null) fragment.append(document.createTextNode(value));
      else addCell(fragment,i,value,0);
    }
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
  updateDeleteControls();
}
function repaintAtScroll(align = false) {
  const offset = reading.scrollTop;
  paintReading();
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
  $('quote-caption').textContent = isMarkdown() ? '原句 · Markdown 源码' : '原句';
  $('revision-hint').textContent = deleted(draft,selected) ? '恢复本句后可编辑' :
    isMarkdown() ? '按 Markdown 填写，留空沿用原句' : '留空则沿用原句';
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
  if (!draft || next === mode) return;
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
manuscript.addEventListener('click', event => {
  if(mode==='source')return;
  const cell = event.target.closest('.sentence');
  if (!cell || selectionInside()) return;
  const i=Number(cell.dataset.index),at=caretOffset(event,cell);
  if(inlineEdit&&inlineEdit.i!==i)finishInline();
  if(!cellAt(i))return;
  select(i,false);
  if(deleted(draft,i))opinion.focus({preventScroll:true});else startInline(i,cellAt(i),at);
});
manuscript.addEventListener('keydown', event => {
  if(mode==='source')return;
  const cell = event.target.closest('.sentence');
  if (!cell) return;
  const i = Number(cell.dataset.index);
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();select(i,false);
    if(deleted(draft,i))opinion.focus({preventScroll:true});else startInline(i,cell,undefined);
  }
  if (['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    event.preventDefault();
    const order = [...cells.keys()].sort((a,b)=>a-b);
    const step = ['ArrowRight','ArrowDown'].includes(event.key) ? 1 : -1;
    const next = event.key === 'Home' ? order[0] : event.key === 'End' ? order.at(-1) : order[order.indexOf(i)+step];
    if (cellAt(next)) {
      if(cellAt(cursor))cellAt(cursor).tabIndex = -1;
      cursor = next;
      cellAt(next).tabIndex = 0;
      cellAt(next).focus();
    }
  }
});
function updateNote(field, value) {
  if (!draft || selected === null || mode === 'source' || switching) return;
  if (undoDeletion?.some(([i])=>i===selected)) {undoDeletion = null;updateDeleteControls();}
  const note = draft.notes[selected] ?? {opinion:'', revision:''};
  const before=note[field];
  if(before===value)return;
  note[field] = value;
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
let undoDeletion = null;

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
  if(inlineEdit)finishInline();
  const next={...noteAt(selected),revision:''};delete next.deleted;
  clearAiMark(selected,'revision');setNote(selected,next);
  undoDeletion=null;updateDeleteControls();repaintAtScroll();paintEditor();scheduleSave();
  outputStatus('已恢复原句，保留意见。');
};
function selectionInside() {
  if (!draft || mode === 'source' || switching) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return manuscript.contains(range.startContainer) && manuscript.contains(range.endContainer) ? range : null;
}
function updateDeleteControls() {
  $('delete-selection').disabled = !selectionInside();
  $('undo-delete').hidden = !draft || mode === 'source' || !undoDeletion;
  $('undo-delete').disabled = switching;
}
function applyDeletion(updates, message, remember = true) {
  undoDeletion = remember ? [...updates.keys()].map(i => [i,draft.notes[i] ? {...draft.notes[i]} : null]) : null;
  for (const [i,note] of updates) {
    if(note)delete note.autoOpinion;
    clearAiMark(i,'revision');
    setNote(i,note);
    opinionUI.edited(i);
  }
  selected = updates.keys().next().value;
  window.getSelection()?.removeAllRanges();
  repaintAtScroll();
  paintEditor();
  scheduleSave();
  outputStatus(message);
}
function deleteSelection(range) {
  if (!range) return;
  try {
    const useRevision = true, groups = new Map(), selectedLengths = new Map();
    for (const cell of manuscript.querySelectorAll('.sentence')) {
      const i=Number(cell.dataset.index);
      if(deleted(draft,i))continue;
      const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);
      for(let node; (node=walker.nextNode());){
        if(node.parentElement.closest('.diff-removed') || !range.intersectsNode(node))continue;
        const a=range.startContainer===node?range.startOffset:0;
        const b=range.endContainer===node?range.endOffset:node.length;
        if(b<=a)continue;
        const start=textOffsets.get(node);
        if(start===undefined)throw new Error('选区含转换过的 Markdown 字符。请切到「查看源码」后再删。');
        if(revised(draft,i).slice(start+a,start+b)!==node.data.slice(a,b))throw new Error('改稿已更新，请重新选中要删除的文字。');
        if(!groups.has(i))groups.set(i,[]);
        groups.get(i).push([start+a,start+b]);
        selectedLengths.set(i,(selectedLengths.get(i)??0)+b-a);
      }
    }
    if (!groups.size) return;
    const updates = new Map();
    for (const [i,ranges] of groups) {
      if (deleted(draft,i)) continue;
      const source = useRevision ? revised(draft,i) : original(draft,i);
      const entireSource = ranges[0][0]===0 && ranges.at(-1)[1]===source.length &&
        ranges.every(([a],n)=>n===0 || !source.slice(ranges[n-1][1],a).trim());
      const entireMarkdownCell = isMarkdown() && !renderSource &&
        selectedLengths.get(i) === cells.get(i).reduce((total,cell)=>total+[...cell.childNodes].reduce((n,child)=>n+(child.nodeType===Node.ELEMENT_NODE&&child.classList.contains('diff-removed')?0:child.textContent.length),0),0);
      const full = entireSource || entireMarkdownCell;
      if (full) {updates.set(i,{...noteAt(i),deleted:true});continue;}
      if (isMarkdown() && !renderSource && ranges.some(([a],n)=>n>0 && source.slice(ranges[n-1][1],a).trim())) {
        throw new Error('选区跨过 Markdown 标记，请切到「查看源码」后再删。');
      }
      updates.set(i,deleteTextRanges(draft,i,ranges,useRevision));
    }
    if (updates.size) applyDeletion(updates,'已从修改版删除，原文保留。');
  } catch (error) { outputStatus(error.message,true); }
}
$('delete-selection').addEventListener('mousedown',event=>event.preventDefault());
$('delete-selection').onclick = () => deleteSelection(selectionInside());
document.addEventListener('selectionchange',updateDeleteControls);
document.addEventListener('keydown',event=>{
  if (!['Delete','Backspace'].includes(event.key) || event.target.closest?.('textarea,input,dialog')) return;
  const range = selectionInside();
  if (range) {event.preventDefault();deleteSelection(range);}
});
$('delete-sentence').onclick = () => {
  if (!draft || selected===null || mode==='source' || switching) return;
  const wasDeleted = deleted(draft,selected);
  const next = {...noteAt(selected)};
  if (wasDeleted) delete next.deleted;
  else next.deleted = true;
  applyDeletion(new Map([[selected,next]]),wasDeleted?'已恢复原句或此前的改版。':'已删除本句，原文保留。',!wasDeleted);
};
$('undo-delete').onclick = () => {
  if (!undoDeletion || switching) return;
  for (const [i,note] of undoDeletion) setNote(i,note);
  undoDeletion = null;
  repaintAtScroll();
  paintEditor();
  scheduleSave();
  outputStatus('已撤销上次删除操作。');
};

opinion.oninput = () => updateNote('opinion',opinion.value);
revision.oninput = () => updateNote('revision',revision.value);

function importedText(name,input,markdown) {
  const edits=parseAnnotated(input), source=edits.source;
  const format=markdown?'markdown':'plain';
  const value=createDraft(name,source,null,[],{format,spans:markdown?markdownSpans(source):undefined});
  if(edits.markers.length||edits.removed.length)value.notices.push('已识别审稿痕迹，保留原文并还原意见与改动。');
  return applyImportedEdits(value,edits);
}
function showWorkspace(record) {
  draft = record?.draft ?? null;
  undoDeletion = null;
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
        next=importedText(file.name,text,ext==='md'||Boolean((edits.markers.length||edits.removed.length)&&looksLikeMarkdown(edits.source)));
      }
    }
    await addDraft(next,ext === 'json' ? 'backup' : 'import');
  } catch (error) {
    notice('导入失败：'+(error.message || '没有读到正文。'));
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
  toast.hidden = false;
  toastTimer = setTimeout(() => {toast.hidden = true;},failed ? 6500 : 3000);
}
async function outputDraft(kind, copy = false) {
  if (!draft) return;
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
  const content = clean ? revisedText(draft) : changes ? annotatedChanges(draft) : annotatedText(draft);
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
  const opener = event.target.closest?.('#ai-inbox') ? $('history-menu') : null;
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
  undoDeletion=null;
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
  if(inlineEdit)finishInline();
  const next={...noteAt(selected),revision:saved.revision};
  if(saved.deleted)next.deleted=true;else delete next.deleted;
  clearAiMark(selected,'revision');setNote(selected,next);
  undoDeletion=null;updateDeleteControls();repaintAtScroll();paintEditor();scheduleSave();
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
  finishInline();
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
            draft=restoreDraft(record.draft);active=record.meta;undoDeletion=null;
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

let inlineEdit = null, insidePointer = false;
manuscript.addEventListener('pointerdown',()=>{insidePointer=true;},true);
for(const event of ['pointerup','pointercancel']){
  document.addEventListener(event,()=>{
    insidePointer=false;
    setTimeout(()=>{if(inlineEdit && document.activeElement!==inlineEdit.input)finishInline();},0);
  });
}
function finishInline(repaint=true){
  if(!inlineEdit)return;
  const edit=inlineEdit;inlineEdit=null;
  if(repaint)repaintAtScroll();
  else {
    edit.input.remove();
    for(const cell of cells.get(edit.i)??[])cell.hidden=false;
  }
}
function startInline(i,cell,offset){
  if(mode==='source'||switching||deleted(draft,i))return;
  if(inlineEdit?.i===i)return;
  if(inlineEdit){finishInline();cell=cellAt(i);}
  if(!cellAt(i))return;
  const input=document.createElement('textarea');
  input.className='inline-edit';
  input.rows=1;
  input.spellcheck=false;
  input.setAttribute('aria-label','编辑当前句块');
  input.value=revised(draft,i);
  const first=cellAt(i);
  first.before(input);
  for(const part of cells.get(i))part.hidden=true;
  inlineEdit={i,input};
  input.focus({preventScroll:true});
  const at=Math.max(0,Math.min(offset??input.value.length,input.value.length));
  input.setSelectionRange(at,at);
  input.oninput=()=>{
    if(inlineEdit?.input!==input||selected!==i||switching)return;
    const n={...noteAt(i)};
    delete n.autoOpinion;
    clearAiMark(i,'revision');
    if(input.value.trim()){n.revision=input.value;delete n.deleted;}
    else n.deleted=true;
    setNote(i,n);
    if(undoDeletion?.some(([index])=>index===i))undoDeletion=null;
    revision.value=input.value;
    opinionUI.edited(i);
    paintState();
    $('revision-hint').textContent=n.deleted?'恢复本句后可编辑':isMarkdown()?'按 Markdown 填写，留空沿用原句':'留空则沿用原句';
    updateDeleteControls();
    scheduleSave();
  };
  input.onblur=()=>{if(inlineEdit?.input===input&&!insidePointer)finishInline();};
  input.onkeydown=event=>{
    if(event.key==='Escape'||(event.key==='Enter'&&(event.ctrlKey||event.metaKey))){
      event.preventDefault();finishInline();
      cellAt(i)?.focus({preventScroll:true});
    }
  };
}
function caretOffset(event,cell){
  const ghost=event.target.closest('.diff-removed');
  if(ghost)return Number(ghost.dataset.offset);
  const caret=document.caretPositionFromPoint?.(event.clientX,event.clientY) ??
    document.caretRangeFromPoint?.(event.clientX,event.clientY);
  const target=caret?.offsetNode ?? caret?.startContainer;
  const offset=caret?.offset ?? caret?.startOffset;
  if(target?.nodeType!==Node.TEXT_NODE || !cell.contains(target) || typeof offset!=='number')return undefined;
  const start=textOffsets.get(target);
  if(start!==undefined)return start+offset;
  const i=Number(cell.dataset.index),value=revised(draft,i),visible=target.data;
  const at=value.indexOf(visible);
  return at!==-1&&value.lastIndexOf(visible)===at?at+offset:undefined;
}

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
