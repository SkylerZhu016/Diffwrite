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
