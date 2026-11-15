import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDraft,parseAnnotated,applyImportedEdits,annotatedText,restoreDraft,revisedText,mergeDraftEdits,pieces} from './model.mjs';
import {looksLikeMarkdown,markdownSpans} from './markdown.mjs';
import {editorLayout,textareaText,rawOffset,textEdit,spliceEditorText,insertReview} from './editor-text.mjs';

function apply(draft,a,b,value) {
  const {updates,gaps}=spliceEditorText(draft,editorLayout(draft),a,b,value);
  return {...draft,notes:{...draft.notes,...Object.fromEntries(updates)},omittedGaps:gaps};
}
test('each range can be deleted or replaced exactly without changing source or opinions',()=>{
  const source='  甲。甲。\r\n\r\n  第二段！ 尾巴。  ';
  const draft=createDraft('review',source);
  draft.notes[1]={opinion:'保留这条意见',revision:'有改动。'};
  const base=editorLayout(draft).text;
  assert.equal(base,revisedText(draft));
  for(let a=0;a<=base.length;a++)for(let b=a;b<=base.length;b++)for(const insert of ['', '换', ' \n ']){
    const changed=restoreDraft(apply(draft,a,b,insert));
    assert.equal(changed.source,source);
    assert.equal(changed.notes[1].opinion,'保留这条意见');
    assert.equal(revisedText(changed),base.slice(0,a)+insert+base.slice(b),JSON.stringify([a,b,insert]));
  }
});
test('preferred sentence ownership directs first text into an empty slot at an equal-offset boundary',()=>{
  const draft=restoreDraft({version:1,name:'空槽',source:'甲句。\n\n乙句。',spans:[[0,3],[5,5],[5,8]],
    insertedSlots:[1],notes:{},notices:[]});
  const layout=editorLayout(draft),slot=layout.sentences[1];
  assert.equal(slot.start,layout.sentences[2].start);
  const {updates}=spliceEditorText(draft,layout,slot.start,slot.end,'新字',1);
  assert.equal(updates.get(1).revision,'新字');
  assert.equal(updates.has(2),false);
  assert.throws(()=>spliceEditorText(draft,layout,slot.start,slot.end,'新字',99),/句块已变化/);
  // Existing callers without a preferred index keep the legacy nearest-sentence rule.
  const legacy=spliceEditorText(draft,layout,slot.start,slot.end,'新字');
  assert.equal(legacy.updates.get(2).revision,'新字乙句。');
});
test('clearing a locally edited slot keeps its anchor and opinion; cross-sentence and ordinary deletions still delete',()=>{
  const draft=restoreDraft({version:1,name:'空槽',source:'甲句。\n\n乙句。',spans:[[0,3],[5,5],[5,8]],
    insertedSlots:[1],notes:{1:{opinion:'保留这个判断',revision:'新段正文。'}},notices:[]});
  const layout=editorLayout(draft),slot=layout.sentences[1];
  const local=spliceEditorText(draft,layout,slot.start,slot.end,'',1).updates.get(1);
  assert.equal(local.opinion,'保留这个判断');
  assert.equal(local.revision,'');
  assert.equal(local.deleted,undefined);
  assert.equal(local.literalWhitespace,undefined);
  const across=spliceEditorText(draft,layout,0,slot.end,'',1).updates.get(1);
  assert.equal(across.deleted,true);

  const ordinary=createDraft('普通句','末字。'),normalLayout=editorLayout(ordinary),normal=normalLayout.sentences[0];
  assert.equal(spliceEditorText(ordinary,normalLayout,normal.start,normal.end,'',0).updates.get(0).deleted,true);
});
test('a completely deleted document can be typed into again',()=>{
  const draft=createDraft('review','甲。\n\n乙。');
  const empty=apply(draft,0,draft.source.length,'');
  assert.equal(revisedText(empty),'');
  assert.equal(revisedText(apply(empty,0,0,'新的内容')),'新的内容');
});
test('textarea offsets preserve CRLF and a selection identifies repeated text',()=>{
  const source='甲甲\r\n甲甲';
  assert.equal(textareaText(source),'甲甲\n甲甲');
  assert.deepEqual([0,1,2,3,4,5].map(i=>rawOffset(source,i)),[0,1,2,4,5,6]);
  assert.deepEqual(textEdit('甲甲甲','甲甲',[1,2]),[1,2,'']);
});
test('annotated Markdown restores heading comments and retains the continuation on round trip',()=>{
  const input='# 雾港 <意见：开头再轻一点。>\n\n<del>旧句。</del> 仍在。 <改为：留下。>\n\n**新的一段。**';
  const load=raw=>{
    const edits=parseAnnotated(raw);
    assert.equal(looksLikeMarkdown(edits.source),true);
    return applyImportedEdits(createDraft('test.md',edits.source,null,[],{format:'markdown',spans:markdownSpans(edits.source)}),edits);
  };
  const draft=load(input);
  assert.equal(draft.notes[0].opinion,'开头再轻一点。');
  assert.equal(draft.notes[1].deleted,true);
  assert.equal(draft.notes[2].revision,'留下。');
  assert.equal(draft.source.includes('<意见：'),false);
  assert.deepEqual(load(annotatedText(draft)).notes,draft.notes);
  assert.match(revisedText(draft),/\*\*新的一段。\*\*/);
});
test('an explicit whitespace replacement round-trips and survives a concurrent opinion',()=>{
  const draft=createDraft('test','甲。 乙。');
  const changed=apply(draft,0,2,' \n');
  const remote={...draft,notes:{0:{opinion:'别丢',revision:''}}};
  const merged=mergeDraftEdits(draft,changed,remote);
  assert.equal(revisedText(merged),' \n 乙。');
  assert.equal(merged.notes[0].opinion,'别丢');
  const parsed=parseAnnotated(annotatedText(merged));
  assert.equal(revisedText(applyImportedEdits(createDraft('test',parsed.source),parsed)),revisedText(merged));
});

test('annotated paste at every caret or selection preserves existing source and its review notes',()=>{
  let draft=createDraft('review','  甲句。\r\n\r\n乙句。  ');
  draft.notes[0]={opinion:'原来的意见',revision:'甲句原有改版。'};
  draft=apply(draft,9,10,'');
  const raw='段落。 <意见：插入的意见> <改为：留下。><del>要删。</del>';
  const edits=parseAnnotated(raw), fragment=applyImportedEdits(createDraft('',edits.source),edits);
  const initial=revisedText(draft), pasted=revisedText(fragment);
  for(let a=0;a<=initial.length;a++)for(let b=a;b<=initial.length;b++){
    const inserted=insertReview(draft,fragment,a,b), d=restoreDraft(inserted.draft);
    assert.equal(revisedText(d),initial.slice(0,a)+pasted+initial.slice(b),JSON.stringify([a,b]));
    assert.equal([...pieces(d,false,true)].map(x=>x[1]).join(''),draft.source);
    assert.equal(d.notes[inserted.at].opinion,'插入的意见');
    assert.ok(Object.values(d.notes).some(n=>n.opinion==='原来的意见'));
    const tag=parseAnnotated(annotatedText(d));
    const reloaded=applyImportedEdits(createDraft('',tag.source),tag);
    assert.equal(revisedText(reloaded),revisedText(d));
    assert.equal(reloaded.notes[inserted.at].opinion,'插入的意见');
  }
});
test('subsequent inserts inside earlier pasted text still preserve the original snapshot',()=>{
  const draft=createDraft('review','甲。 乙。');
  const pasted=createDraft('','丙。 丁。');
  const one=restoreDraft(insertReview(draft,pasted,3,3).draft);
  const two=restoreDraft(insertReview(one,pasted,4,4).draft);
  assert.equal([...pieces(two,false,true)].map(x=>x[1]).join(''),draft.source);
  assert.equal(revisedText(two),revisedText(one).slice(0,4)+pasted.source+revisedText(one).slice(4));
});
test('structured paste remaps empty-slot identity and keeps its note separate',()=>{
  const draft=createDraft('原稿','甲句。乙句。');
  const fragment=restoreDraft({version:1,name:'粘贴片段',source:'丙句。',spans:[[0,0],[0,3]],insertedSlots:[0],
    notes:{0:{opinion:'新段落意见',revision:'补写。'}},notices:[]});
  const pasted=restoreDraft(insertReview(draft,fragment,3,3).draft);
  assert.deepEqual(pasted.insertedSlots,[1]);
  assert.equal(pasted.notes[1].opinion,'新段落意见');
  assert.equal(pasted.notes[1].revision,'补写。');
  assert.equal([...pieces(pasted,false,true)].map(x=>x[1]).join(''),draft.source);
  assert.equal(revisedText(pasted),'甲句。补写。丙句。乙句。');
});

test('a tagged Markdown sentence keeps its closing delimiters before the adjacent deletion',()=>{
  const edits=parseAnnotated('**续写。** <意见：新意见> <改为：**改稿。**><del>删掉。</del>');
  const draft=applyImportedEdits(createDraft('',edits.source,null,[],{spans:markdownSpans(edits.source)}),edits);
  assert.equal(draft.notes[0].opinion,'新意见');
  assert.equal(draft.notes[1].deleted,true);
  assert.equal(revisedText(draft),'**改稿。**');
});

test('blank lines remain editable after repeated inserts, deletes and restore',()=>{
  const source='\n\n开头。\n\n\n结尾。\n\n';
  let d=createDraft('blank lines',source), value=source;
  const change=(a,b,text)=>{
    d=restoreDraft(apply(d,a,b,text));
    value=value.slice(0,a)+text+value.slice(b);
    assert.equal(revisedText(d),value);
    assert.equal(editorLayout(d).text,value);
    assert.equal(d.source,source);
  };
  change(1,1,'\n');
  const middle=value.indexOf('结尾');
  change(middle-1,middle-1,'空行输入。\n');
  change(0,3,'\n');
  change(value.length,value.length,'\n尾部输入。\n\n');
  const cut=value.indexOf('空行输入');
  change(cut,cut+'空行输入。'.length,'');
  assert.equal(revisedText(restoreDraft(JSON.parse(JSON.stringify(d)))),value);
});
