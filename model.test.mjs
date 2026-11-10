import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitSentences,createDraft,restoreDraft,original,modified,revisedText,annotatedText,annotatedChanges,pieces,deleteTextRanges,parseAnnotated,applyImportedEdits,mergeDraftEdits} from './model.mjs';

const cut = (source, breaks) => splitSentences(source,breaks).map(([a,b])=>source.slice(a,b));

test('keeps dialogue and nested quotes intact, with original whitespace preserved', () => {
  const source = '\t　她低声说：“别回头。听见『等灯灭。』了吗？”她握紧钥匙。 \r\n\r\n　“走吧。”她低声说。\r\n';
  const draft = createDraft('test',source);
  assert.deepEqual(draft.spans.map((_,i)=>original(draft,i)),[
    '她低声说：“别回头。听见『等灯灭。』了吗？”','她握紧钥匙。','“走吧。”她低声说。'
  ]);
  assert.equal(Array.from(pieces(draft),p=>p[1]).join(''),source);
  assert.equal(revisedText(draft),source);
});
test('adjacent quotes, ASCII quotes and unpaired quotes', () => {
  assert.deepEqual(cut('“走。” 「不。」\n"Stop. Wait." Then leave.\n“没合上。后半句。\n新段。'),[
    '“走。”','「不。」','"Stop. Wait."','Then leave.','“没合上。','后半句。','新段。'
  ]);
});
test('keeps decimals and nonterminal punctuation; Word manual break is not a paragraph', () => {
  assert.deepEqual(cut('3.14 米，够了；别动？！好。'),['3.14 米，够了；别动？！','好。']);
  const source='上半行\n下半行\n新段。';
  assert.deepEqual(cut(source,[source.lastIndexOf('\n')]),['上半行\n下半行','新段。']);
});
test('dots before ASCII letters or digits stay inside filenames and tokens',()=>{
  assert.deepEqual(cut('练习稿.md；03_角色/示例角色.MD，数值3.14，e.g. 示例。下一句。'),[
    '练习稿.md；03_角色/示例角色.MD，数值3.14，e.g. 示例。','下一句。'
  ]);
});
test('restoring an existing draft retains its stored sentence numbering and manual notes',()=>{
  const source='练习稿.md。下一句。', draft={version:1,name:'旧稿',source,
    spans:[[0,4],[4,7],[7,11]],notes:{1:{opinion:'旧句块意见',revision:''}},notices:[]};
  const restored=restoreDraft(draft);
  assert.deepEqual(restored.spans,draft.spans);
  assert.equal(original(restored,1),'md。');
  assert.equal(restored.notes[1].opinion,'旧句块意见');
  assert.equal(createDraft('新稿',source).spans.length,2);
});
test('updates duplicate sentences separately, only nonempty differing revisions count', () => {
  const d=createDraft('重复','　同一句。\r\n\r\n\t同一句。  ');
  d.notes[0]={opinion:'留意见',revision:' \n '};
  d.notes[1]={opinion:'另一处',revision:'新句。再添一句。'};
  assert.equal(modified(d,0),false);
  assert.equal(modified(d,1),true);
  assert.equal(revisedText(d),'　同一句。\r\n\r\n\t新句。再添一句。  ');
  d.notes[1].revision='同一句。';
  assert.equal(modified(d,1),false);
  const restored=restoreDraft(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(restored,d);
  assert.equal(revisedText(restored),d.source);
});
test('rejects invalid backups without silently dropping text or notes', () => {
  const d=createDraft('test','第一句。第二句。');
  assert.throws(()=>restoreDraft({...d,spans:d.spans.slice(0,1)}),/备份/);
  assert.throws(()=>restoreDraft({...d,notes:{2:{opinion:'wrong index',revision:''}}}),/备份/);
  assert.throws(()=>createDraft('empty','　\r\n '),/正文/);
});

test('mixed Chinese and English treats abbreviations, initials, domains and numbers as internal', () => {
  assert.deepEqual(cut('Dr. Lin 到了。J. R. R. Tolkien wrote it.Stop.Go. Visit example.com. Then email a.b@example.org!再说。'),[
    'Dr. Lin 到了。','J. R. R. Tolkien wrote it.Stop.Go.','Visit example.com.','Then email a.b@example.org!','再说。'
  ]);
  assert.deepEqual(cut('U.S. policy changed. It started at 3.14 p.m. Then they left. 看 https://example.com/a?b=1.2。好了。'),[
    'U.S. policy changed.','It started at 3.14 p.m.','Then they left.','看 https://example.com/a?b=1.2。','好了。'
  ]);
});
test('keeps both styles of dialogue and speech tags without confusing apostrophes for quotes', () => {
  assert.deepEqual(cut('她写下“魂”“翼”两个字。Don’t ask O\'Neill. ‘Wait. Please.’ She left. "Go!" he said. "No." said Tom. “走吧！”——她喊道。'),[
    '她写下“魂”“翼”两个字。','Don’t ask O\'Neill.','‘Wait. Please.’','She left.','"Go!" he said.','"No." said Tom.','“走吧！”——她喊道。'
  ]);
});
test('ellipsis is normally a pause; clear English restart or terminal punctuation can end it', () => {
  assert.deepEqual(cut('他想了想……还是走了。Wait... then go. Wait... Then go. 走吗……？！当然。'),[
    '他想了想……还是走了。','Wait... then go.','Wait...','Then go.','走吗……？！','当然。'
  ]);
});
test('annotated output retains the original and only attaches actual notes and revisions', () => {
  const d=createDraft('test','　原句。第二句。\r\n\r\n\t第三句。  ');
  d.notes[0]={opinion:'留意见',revision:'更短。'};
  d.notes[1]={opinion:'  ',revision:'第二句。'};
  d.notes[2]={opinion:'只评论',revision:''};
  assert.equal(revisedText(d),'　更短。第二句。\r\n\r\n\t第三句。  ');
  assert.equal(annotatedText(d),'　原句。 <意见：留意见> <改为：更短。>第二句。\r\n\r\n\t第三句。 <意见：只评论>  ');
});

test('keeps a closing quote with the preceding dialogue even without a separating space', () => {
  assert.deepEqual(cut('"Stop. Wait."Then leave. Ready.2 doors opened.'),['"Stop. Wait."','Then leave.','Ready.2 doors opened.']);
});

test('selected characters become a revision while a whole deletion retains the prior note', () => {
  const d=createDraft('test','　甲要删乙。\n\n保留这句。');
  d.notes[0]={opinion:'保留上下文',revision:''};
  d.notes[0]=deleteTextRanges(d,0,[[1,3]],false);
  assert.equal(original(d,0),'甲要删乙。');
  assert.equal(revisedText(d),'　甲乙。\n\n保留这句。');
  d.notes[0]=deleteTextRanges(d,0,[[0,3]],true);
  assert.equal(d.notes[0].revision,'甲乙。');
  assert.equal(modified(d,0),true);
  assert.equal(revisedText(d),'　\n\n保留这句。');
  assert.equal(annotatedText(d),'　<del>甲要删乙。</del> <意见：保留上下文>\n\n保留这句。');
  const restored=restoreDraft(JSON.parse(JSON.stringify(d)));
  assert.equal(restored.notes[0].deleted,true);
  delete restored.notes[0].deleted;
  assert.equal(revisedText(restored),'　甲乙。\n\n保留这句。');
});
test('disjoint partial selections preserve the unselected text', () => {
  const d=createDraft('test','ABCDEFG。');
  d.notes[0]=deleteTextRanges(d,0,[[4,6],[1,3]],false);
  assert.equal(revisedText(d),'ADG。');
  assert.throws(()=>deleteTextRanges(d,0,[[0,3],[2,4]],true),RangeError);
});

test('new annotations round-trip text, opinions, replacements and partial deletes',()=>{
  const d=createDraft('annotated','雨停了。甲删乙。\r\n门开了。');
  d.notes[0]={opinion:'包含 < > &',revision:'雨终于停了。'};
  d.notes[1]={opinion:'',revision:'甲乙。'};
  d.notes[2]={opinion:'不需要',revision:'',deleted:true};
  const tagged=annotatedText(d);
  assert.equal(tagged,'雨停了。 <意见：包含 &lt; &gt; &amp;> <改为：雨终于停了。>甲<del>删</del>乙。\r\n<del>门开了。</del> <意见：不需要>');
  const decoded=parseAnnotated(tagged);
  const restored=applyImportedEdits(createDraft('again',decoded.source),decoded);
  assert.equal(restored.source,d.source);
  assert.equal(revisedText(restored),revisedText(d));
  assert.deepEqual(restored.notes,d.notes);
});
test('del crossing sentence and paragraph boundaries also removes its enclosed whitespace',()=>{
  const raw='保留。<del>第一句。\n\n第二句。 </del>结尾。';
  const edits=parseAnnotated(raw);
  const restored=applyImportedEdits(createDraft('del',edits.source),edits);
  assert.equal(revisedText(restored),'保留。结尾。');
  assert.deepEqual(restoreDraft(JSON.parse(JSON.stringify(restored))),restored);
  assert.equal(revisedText(applyImportedEdits(createDraft('del',edits.source),parseAnnotated(annotatedText(restored)))),'保留。结尾。');
});
test('previous exported tags still import',()=>{
  const edits=parseAnnotated('原句。【意见：短一点】【改版：新句。】另句。【删除】');
  const draft=applyImportedEdits(createDraft('old',edits.source),edits);
  assert.equal(revisedText(draft),'新句。');
  assert.equal(draft.notes[0].opinion,'短一点');
});

test('changes-only copy preserves review markup and leaves out untouched text',()=>{
  const d=createDraft('测试','不复制。意见句。删一字。\n\n整句删除。仅 AI 建议。无变化。');
  d.notes[1]={opinion:'<重点>',revision:''};
  d.notes[2]={opinion:'',revision:'删字。'};
  d.notes[3]={opinion:'整句意见',revision:'',deleted:true};
  d.notes[4]={opinion:'留这条',revision:''};
  d.notes[5]={opinion:'   ',revision:'无变化。'};
  d.aiMarks={4:{opinion:0}};
  d.omittedGaps=[[12,13]];
  assert.equal(annotatedChanges(d),
    '意见句。 <意见：&lt;重点&gt;>\n删<del>一</del>字。\n<del>\n</del>\n<del>整句删除。</del> <意见：整句意见>\n仅 AI 建议。 <意见：AI：留这条>');
  assert.equal(annotatedChanges(createDraft('空','原句。')),'');
});
test('AI tags are kept only where they still describe a field; a merged human edit takes that field over',()=>{
  const d=createDraft('标记','一。二。三。');
  d.notes[0]={opinion:'人工\n\nAI：补充',revision:'改一。'};
  d.notes[1]={opinion:'AI 意见',revision:''};
  const stored={...d,aiMarks:{0:{opinion:2,body:true,replaced:{revision:'旧一。'}},1:{opinion:0,replaced:{revision:'无改写标记'}},
    2:{opinion:0},7:{body:true}}};
  const restored=restoreDraft(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(restored.aiMarks,{0:{opinion:2,body:true,replaced:{revision:'旧一。'}},1:{opinion:0}});
  assert.equal(restoreDraft({...d,aiMarks:{0:12}}).aiMarks,undefined);
  const local=structuredClone(restored);
  local.notes[0].revision='人工再改。';
  assert.deepEqual(mergeDraftEdits(restored,local,restored).aiMarks,{0:{opinion:2},1:{opinion:0}});
  local.notes[0].opinion='人工';
  local.notes[1].opinion='我改了';
  assert.equal(mergeDraftEdits(restored,local,restored).aiMarks,undefined);
});
