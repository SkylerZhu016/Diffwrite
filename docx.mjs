// Extract the main story only. Nothing is uploaded or fetched by the parser.
const maxXml = 24 * 1024 * 1024;
const nameOf = new TextDecoder();
const wordNS = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main'
]);

function directory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = p => view.getUint16(p,true);
  const u32 = p => view.getUint32(p,true);
  const bad = () => {throw new Error('无法读取这个 Word 文件。请另存为普通 .docx 后重试。');};
  let pos = bytes.length - 22;
  for (;pos >= Math.max(0, bytes.length - 65557);pos--) {
    if (u32(pos) === 0x06054b50 && pos + 22 + u16(pos+20) === bytes.length) break;
  }
  if (pos < Math.max(0, bytes.length - 65557) || u16(pos+4) || u16(pos+6) ||
      u16(pos+8) !== u16(pos+10)) bad();
  const count = u16(pos+10), end = u32(pos+16) + u32(pos+12);
  let cursor = u32(pos+16);
  if (end > pos || count === 65535) bad();
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (cursor+46 > end || u32(cursor) !== 0x02014b50) bad();
    const n = u16(cursor+28), next = cursor + 46 + n + u16(cursor+30) + u16(cursor+32);
    if (next > end) bad();
    const name = nameOf.decode(bytes.subarray(cursor+46,cursor+46+n));
    entries.set(name,{flag:u16(cursor+8), method:u16(cursor+10), length:u32(cursor+20),
      size:u32(cursor+24), offset:u32(cursor+42)});
    cursor = next;
  }
  return {entries, async read(name) {
    const e = entries.get(name);
    if (!e || e.flag & 1 || e.size > maxXml || e.offset+30 > bytes.length ||
        u32(e.offset) !== 0x04034b50) bad();
    const start = e.offset+30+u16(e.offset+26)+u16(e.offset+28);
    if (start+e.length > bytes.length) bad();
    const data = bytes.subarray(start,start+e.length);
    if (e.method === 0 && data.length === e.size) return data;
    if (e.method !== 8) bad();
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const out = new Uint8Array(e.size);
    let written = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (written+chunk.value.length > out.length) bad();
        out.set(chunk.value,written);
        written += chunk.value.length;
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (written !== out.length) bad();
    return out;
  }};
}

export async function readDocx(buffer) {
  const zip = directory(new Uint8Array(buffer));
  const bytes = await zip.read('word/document.xml');
  const utf16le = bytes[0] === 255 && bytes[1] === 254 || bytes[0] === 60 && bytes[1] === 0;
  const utf16be = bytes[0] === 254 && bytes[1] === 255 || bytes[0] === 0 && bytes[1] === 60;
  const xml = new TextDecoder(utf16le ? 'utf-16le' : utf16be ? 'utf-16be' : 'utf-8',{fatal:true}).decode(bytes);
  if (/<!DOCTYPE/i.test(xml)) throw new Error('这个 Word 文件含有无法安全读取的结构。');
  const doc = new DOMParser().parseFromString(xml,'application/xml');
  const ns = doc.documentElement.namespaceURI;
  const body = doc.getElementsByTagNameNS(ns,'body')[0];
  if (!wordNS.has(ns) || !body) throw new Error('这个 Word 文件没有可识别的正文。');
  const rows = [], omitted = new Set();
  const extras = {tbl:'表格', drawing:'图片或绘图', pict:'图片或绘图', object:'嵌入对象',
    txbxContent:'文本框', footnoteReference:'脚注或尾注', endnoteReference:'脚注或尾注',
    altChunk:'嵌入内容', sym:'特殊符号', oMath:'公式', oMathPara:'公式'};
  function skip(el) {
    const type = extras[el.localName];
    if (type) { omitted.add(type); return true; }
    return el.namespaceURI === ns && ['del','moveFrom'].includes(el.localName);
  }
  function inline(el, parts) {
    if (skip(el)) return;
    if (el.namespaceURI === ns) {
      switch (el.localName) {
        case 't': parts.push(el.textContent); return;
        case 'tab': case 'ptab': parts.push('\t'); return;
        case 'br': if (['page','column'].includes(el.getAttributeNS(ns,'type'))) return;
        // falls through
        case 'cr': parts.push('\n'); return;
        case 'noBreakHyphen': parts.push('\u2011'); return;
        case 'softHyphen': parts.push('\u00ad'); return;
        case 'pPr': case 'rPr': case 'instrText': return;
      }
    }
    for (const child of el.children) inline(child,parts);
  }
  function blocks(el) {
    if (skip(el)) return;
    if (el.namespaceURI === ns && el.localName === 'p') {
      const parts = [];
      for (const child of el.children) inline(child,parts);
      rows.push(parts.join(''));
      return;
    }
    for (const child of el.children) blocks(child);
  }
  blocks(body);
  if ([...zip.entries.keys()].some(k => /^word\/(?:header|footer)\d*\.xml$/.test(k))) omitted.add('页眉或页脚');
  const paragraphBreaks = [];
  let offset = 0;
  for (const row of rows.slice(0,-1)) { offset += row.length; paragraphBreaks.push(offset++); }
  return {source:rows.join('\n'), paragraphBreaks,
    notices: omitted.size ? ['已导入正文；未导入：'+[...omitted].join('、')+'。'] : []};
}
