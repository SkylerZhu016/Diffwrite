import {fromMarkdown, gfm, gfmFromMarkdown, decodeNamedCharacterReference} from './vendor/markdown-parser.mjs';
import {splitSentences} from './model.mjs';

const options = {extensions:[gfm()], mdastExtensions:[gfmFromMarkdown()]};
const range = node => [node.position.start.offset,node.position.end.offset];
const parse = source => fromMarkdown(source,options);
export function looksLikeMarkdown(source) {
  if (!/[#*`_>~|\[\]!-]/u.test(source)) return false;
  const explicit = new Set(['heading','list','blockquote','table','code','inlineCode','emphasis','strong','delete','thematicBreak','image','footnoteDefinition']);
  function check(node) {
    return explicit.has(node.type) || (node.type === 'link' && source[node.position.start.offset] === '[') || Boolean(node.children?.some(check));
  }
  return check(parse(source));
}
const atomic = new Set(['link','linkReference','image','imageReference',
  'inlineCode','footnoteReference','definition','html','code','thematicBreak']);
const block = new Set(['paragraph','heading','code','html','thematicBreak','definition','table','tableRow','listItem','footnoteDefinition']);

function tail(node) {
  if (node.type === 'text') return node.value.trimEnd().at(-1) ?? '';
  if (['inlineCode','image','imageReference','html'].includes(node.type)) return '';
  return node.children?.length ? tail(node.children.at(-1)) : '';
}

export function markdownSpans(source) {
  const tree = parse(source), probe = source.split(''), paragraphEnds = new Set();
  function breakBefore(offset) {
    let i = offset-1;
    while (i >= 0 && source[i] !== '\n' && source[i] !== '\r') i--;
    if (i >= 0) paragraphEnds.add(i);
  }
  function mask(a,b,endMark = '') {
    for (let i=a;i<b;i++) if (source[i] !== '\r' && source[i] !== '\n') probe[i] = 'x';
    if (endMark && b>a) probe[b-1] = endMark;
  }
  function scan(node) {
    if (node.type === 'root') {for (const child of node.children) scan(child); return;}
    const [a,b] = range(node);
    if (block.has(node.type)) breakBefore(a);
    if (node.type === 'listItem' && node.children[0]) mask(a,range(node.children[0])[0]);
    if (['emphasis','strong','delete'].includes(node.type)) {
      for (const child of node.children) scan(child);
      let last=b-1;
      while(last>a && /[*_~ \t]/.test(probe[last])) last--;
      if (last<b-1 && /[。！？.!?．…]/u.test(probe[last])) {probe[b-1]=probe[last]; probe[last]='x';}
      return;
    }
    if (node.type === 'heading' && node.children.length) {
      for (const child of node.children) scan(child);
      const contentEnd=range(node.children.at(-1))[1];
      if (contentEnd<b && /[。！？.!?．…]/u.test(probe[contentEnd-1])) {
        probe[b-1]=probe[contentEnd-1]; probe[contentEnd-1]='x';
      }
      return;
    }
    if (atomic.has(node.type)) {
      const last = tail(node);
      mask(a,b,/[。！？.!?．…]/u.test(last) ? last : '');
      return;
    }
    for (const child of node.children ?? []) scan(child);
  }
  scan(tree);
  // CRLF is a single separator: the CR left before the LF is trimmed as whitespace.
  return splitSentences(probe.join(''),[...paragraphEnds].sort((a,b)=>a-b));
}

const escapable = /^[!-/:-@\[-\x60{-~]$/u;
function sourceOffsets(value,raw,start) {
  // A normalized text leaf may contain CRLF, escapes, entities, or stripped line prefixes.
  const chars = [], offsets = [];
  const add = (s,i) => {for (let j=0;j<s.length;j++) {chars.push(s[j]); offsets.push(start+i);}};
  for(let i=0;i<raw.length;i++) {
    if(raw[i] === '\r') {add('\n',i); if(raw[i+1]==='\n') i++; continue;}
    if(raw[i] === '\\' && escapable.test(raw[i+1] ?? '')) {add(raw[i+1],i++);continue;}
    if(raw[i] === '&') {
      const m = /^&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/i.exec(raw.slice(i,i+40));
      if(m) {
        const n = m[1];
        let decoded;
        if(n[0] === '#') {
          const hex = /^#x/i.test(n), cp = Number.parseInt(n.slice(hex ? 2 : 1),hex ? 16 : 10);
          decoded = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
        } else decoded = decodeNamedCharacterReference(n);
        if(decoded) {add(decoded,i); i += m[0].length-1; continue;}
      }
    }
    add(raw[i],i);
  }
  if(chars.join('') === value) return offsets;
  const aligned = [];
  let i=0;
  for(let j=0;j<value.length;j++) {
    if(j===0 || value[j-1]==='\n') {
      while(i<chars.length && chars[i]!==value[j] && /[ \t>]/.test(chars[i])) i++;
    }
    if(chars[i]!==value[j]) return null;
    aligned.push(offsets[i++]);
  }
  return aligned;
}

export function renderMarkdown(source, decorate) {
  const out = document.createDocumentFragment();
  const text = (parent,value,start,end,offsets) => {
    if (value) decorate(parent,value,start,end,offsets);
  };
  function leaf(parent,node,display = node.value) {
    const [a,b] = range(node);
    text(parent,display,a,b,source.slice(a,b) === display ? undefined : sourceOffsets(display,source.slice(a,b),a));
  }
  const tags = {paragraph:'p', emphasis:'em', strong:'strong', delete:'del', blockquote:'blockquote',
    listItem:'li',tableCell:'td',tableRow:'tr',footnoteDefinition:'aside'};
  function visit(parent,node,customTag) {
    const add = tag => {const el = document.createElement(tag);parent.append(el);return el;};
    const children = el => {for (const child of node.children ?? []) visit(el,child);};
    switch(node.type) {
      case 'root': children(parent); return;
      case 'text': leaf(parent,node); return;
      case 'heading': children(add('h'+node.depth)); return;
      case 'break': add('br'); return;
      case 'thematicBreak': add('hr'); return;
      case 'list': {
        const el=add(node.ordered?'ol':'ul');
        if(node.ordered && node.start !== null) el.start=node.start;
        children(el); return;
      }
      case 'table': {
        const table=add('table'), head=table.createTHead(), body=table.createTBody();
        for(const [i,row] of node.children.entries()) {
          const line=(i?body:head).insertRow();
          for(const [j,cell] of row.children.entries()) {
            visit(line,cell,i?'td':'th');
            if(node.align[j]) line.lastElementChild.classList.add('align-'+node.align[j]);
          }
        }
        return;
      }
      case 'inlineCode': leaf(add('code'),node); return;
      case 'code': leaf(add('pre').appendChild(document.createElement('code')),node); return;
      case 'html': leaf(add('code'),node); return;
      case 'link': case 'linkReference': {
        const el=add('span'); el.className='md-link';
        if(node.url) el.title=node.url;
        children(el); return;
      }
      case 'image': case 'imageReference': {
        const el=add('span'); el.className='md-image';
        leaf(el,node,'[图片'+(node.alt?'：'+node.alt:'')+']'); return;
      }
      case 'footnoteReference': leaf(add('sup'),node,'['+node.label+']'); return;
      case 'definition': return;
      default: {
        const el = add(customTag ?? tags[node.type] ?? 'span');
        if(node.type==='footnoteDefinition') {
          el.className='md-footnote';
          el.append('['+node.label+'] ');
        }
        children(el);
        if(node.type==='listItem' && typeof node.checked==='boolean') {
          el.classList.add('md-task-item');
          const mark=document.createElement('span');
          mark.className='md-task';
          mark.textContent=node.checked?'☑ ':'☐ ';
          mark.setAttribute('aria-label',node.checked?'已完成':'未完成');
          (el.firstElementChild?.tagName==='P' ? el.firstElementChild : el).prepend(mark);
        }
      }
    }
  }
  visit(out,parse(source));
  return out;
}
