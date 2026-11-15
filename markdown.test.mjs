import {test} from 'node:test';
import assert from 'node:assert/strict';
import {markdownSpans, looksLikeMarkdown} from './markdown.mjs';
import {createDraft, restoreDraft, original, revisedText} from './model.mjs';

test('Markdown syntax stays attached, rather than splitting link targets, code or list numbers', () => {
  const text = '## 标题。 ##\r\n\r\n1. **第一句。第二句。** 下一句。\r\n2. Visit [our site](https://example.org/a?b=2). Then run '+
    '\x60x.y()\x60.\r\n\r\n> “别回头。\r\n> 继续走。”她转身。';
  const d = createDraft('test.md',text,null,[],{format:'markdown',spans:markdownSpans(text)});
  assert.deepEqual(d.spans.map((_,i)=>original(d,i)),[
    '## 标题。 ##','1. **第一句。','第二句。**','下一句。',
    '2. Visit [our site](https://example.org/a?b=2).','Then run \x60x.y()\x60.',
    '> “别回头。\r\n> 继续走。”','她转身。'
  ]);
  assert.equal(revisedText(d),text);
  assert.deepEqual(restoreDraft(JSON.parse(JSON.stringify(d))),d);
});
test('Markdown recognition distinguishes formatted paste from plain prose with URLs', () => {
  assert.equal(looksLikeMarkdown('# 章名\n\n正文。'),true);
  assert.equal(looksLikeMarkdown('她指着 **钥匙**。'),true);
  assert.equal(looksLikeMarkdown('访问 https://example.org 然后回来。'),false);
  assert.equal(looksLikeMarkdown('她说：“走吧！”'),false);
});

test('rendered code maps carets into content rather than backticks or indentation', async () => {
  const {renderMarkdown}=await import('./markdown.mjs');
  const previous=globalThis.document;
  const element=tag=>({tag,dataset:{},style:{},children:[],append(...items){this.children.push(...items);},appendChild(item){this.append(item);return item;}});
  globalThis.document={createElement:element,createDocumentFragment:()=>element('fragment')};
  try {
    for(const [source,value,positions] of [
      ['请用 `hello`。','hello',[4,5,6,7,8,9]],
      ['`` a`b ``','a`b',[3,4,5,6]],
      ['`a\r\nb`','a\r\nb',[1,2,3,4,5]],
      ['```js\nhello\nworld\n```','hello\nworld',[6,7,8,9,10,11,12,13,14,15,16,17]],
      ['```\r\none\r\ntwo\r\n```','one\r\ntwo',[5,6,7,8,9,10,11,12,13]],
      ['    one\n    two','one\ntwo',[4,5,6,7,12,13,14,15]],
      ['> ```\n> one\n> two\n> ```','one\ntwo',[8,9,10,11,14,15,16,17]],
    ]) {
      let actual;
      renderMarkdown(source,(parent,text,a,b,offsets)=>{if(parent.tag==='code')actual={text,offsets};});
      assert.deepEqual(actual,{text:value,offsets:positions},source);
    }
  } finally {
    if(previous===undefined)delete globalThis.document;else globalThis.document=previous;
  }
});

test('manuscript Markdown keeps soft line breaks and the exact number of blank lines', async () => {
  const {renderMarkdown}=await import('./markdown.mjs');
  const previous=globalThis.document;
  const element=tag=>({tag,dataset:{},style:{},children:[],append(...items){this.children.push(...items);},appendChild(item){this.append(item);return item;}});
  globalThis.document={createElement:element,createDocumentFragment:()=>element('fragment')};
  try {
    const source='她想起来了。\n......\n\n\n\n下一段。';
    const leaves=[];
    const output=renderMarkdown(source,(parent,value,start,end)=>{leaves.push({parent,value,start,end});});
    assert.equal(leaves[0].value,'她想起来了。\n......');
    const gap=output.children.find(node=>node.className==='md-gap');
    assert.equal(gap.style.height,'3lh');
    assert.equal(source.slice(gap.dataset.start,gap.dataset.end),'\n\n\n\n');
    assert.equal(leaves.find(leaf=>leaf.parent===gap).value,'\n\n\n');
    for(const count of [2,3,5]) {
      const result=renderMarkdown('前句。'+'\n'.repeat(count)+'后句。',()=>{});
      assert.equal(result.children.find(node=>node.className==='md-gap').style.height,(count-1)+'lh');
    }
  } finally {
    if(previous===undefined)delete globalThis.document;else globalThis.document=previous;
  }
});
