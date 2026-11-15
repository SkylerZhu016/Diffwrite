import fs from 'node:fs';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {revisedText} from '../model.mjs';
// Run with: node browser-tests/rendered-editor.mjs
// Uses an isolated data directory and invisible Chrome; never touches daily data.
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=fs.mkdtempSync(join(os.tmpdir(),'diffwrite-rich-'));
const socket=createServer();
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port=socket.address().port;
await new Promise(resolve=>socket.close(resolve));
const chromePath=process.env.DIFFWRITE_CHROME||join(process.env.ProgramFiles||'C:/Program Files','Google/Chrome/Application/chrome.exe');
if(!fs.existsSync(chromePath))throw new Error('Set DIFFWRITE_CHROME to an installed Chrome executable.');
const packaged=process.env.DIFFWRITE_TEST_EXE;
const server=spawn(packaged||process.execPath,packaged?['--no-browser']:[root+'/server.mjs'],{cwd:root,env:{...process.env,DIFFWRITE_REVIEW_PORT:String(port),DIFFWRITE_REVIEW_DATA:dir+'/data',DIFFWRITE_REVIEW_RUNTIME:dir+'/runtime'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let serverLogs='';server.stdout.on('data',x=>serverLogs+=x);server.stderr.on('data',x=>serverLogs+=x);
const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0','--user-data-dir='+dir+'/chrome','--no-first-run','--no-default-browser-check','--window-size=1450,1000','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let chromeLogs='';chrome.stderr.on('data',x=>chromeLogs+=x);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws;const results=[];
try{
  let debugPort;
  for(let i=0;i<100;i++){
    try{debugPort=Number(fs.readFileSync(dir+'/chrome/DevToolsActivePort','utf8').split('\n')[0]);if(debugPort && (await fetch('http://127.0.0.1:'+port+'/health')).ok)break;}catch{}await sleep(100);
  }
  if(!debugPort)throw Error('chrome startup '+chromeLogs);
  const target=(await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(x=>x.type==='page');
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  let n=0;const pending=new Map(), errors=[];
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(m.error):r(m.result)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description)};
  const send=(method,params={})=>new Promise((r,j)=>{const id=++n;pending.set(id,[r,j]);ws.send(JSON.stringify({id,method,params}))});
  const ev=async(expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value};
  async function wait(fn){for(let i=0;i<100;i++){if(await fn())return;await sleep(40)}throw Error('timeout '+JSON.stringify(errors)+' '+await ev("[document.querySelector('#notice')?.textContent,document.querySelector('#save-state')?.textContent,document.querySelector('#manuscript')?.innerText]"))}
  const key=async(key,modifiers=0)=>{const windowsVirtualKeyCode={Delete:46,Backspace:8,Escape:27,z:90,y:89,a:65,ArrowRight:39,Enter:13}[key]??key.toUpperCase().charCodeAt(0);for(const type of ['keyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key,modifiers,windowsVirtualKeyCode,...(key==='Enter'&&type==='keyDown'?{text:String.fromCharCode(13)}:{})})};
  await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:'+port});
  await wait(()=>ev("document.body.dataset.empty==='true' && document.readyState==='complete'"));
  const load=async(text,markdown)=>{await ev('document.querySelector("#paste").click();document.querySelector("#paste-text").value='+JSON.stringify(text)+';'+(markdown===undefined?'':'document.querySelector("#paste-markdown").checked='+markdown+';document.querySelector("#paste-markdown").dispatchEvent(new Event("change"));')+'document.querySelector("#paste-form").requestSubmit()');await wait(()=>ev('!document.querySelector("#paste-dialog").open&&document.querySelector("#save-state").textContent==="已保存"'));};
  const select=async(selector,offset,endSelector=selector,end=offset)=>ev(`(()=>{const text=selector=>{const root=document.querySelector(selector);return document.createTreeWalker(root,NodeFilter.SHOW_TEXT).nextNode()};const a=text(${JSON.stringify(selector)}),b=text(${JSON.stringify(endSelector)}),r=document.createRange();document.querySelector('#manuscript').focus({preventScroll:true});r.setStart(a,${offset});r.setEnd(b,${end});getSelection().removeAllRanges();getSelection().addRange(r)})()`);
  const current=async()=>{await wait(()=>ev('document.querySelector("#save-state").textContent==="已保存"'));return ev('(async()=>{const rows=await fetch("/api/drafts",{headers:{"X-Diffwrite":"1"}}).then(r=>r.json());return fetch("/api/drafts/"+rows[0].id,{headers:{"X-Diffwrite":"1"}}).then(r=>r.json())})()')};
  const actual=async()=>{const rec=await current();return {source:rec.draft.source,notes:rec.draft.notes,text:await ev('document.querySelector("#manuscript").innerText'),caret:await ev('({text:getSelection().anchorNode?.textContent,offset:getSelection().anchorOffset,focus:getSelection().focusOffset})')}};
  const check=async(name,fn)=>{if(process.argv.some(x=>x.startsWith('--focus=')&&!name.includes(x.slice(8))))return;try{await fn();results.push({name,ok:true});console.log('PASS',name)}catch(e){results.push({name,ok:false,error:e.message,state:await actual()});console.log('FAIL',name,e.message)}};
  const click=async(selector,rx=.45,ry=.45)=>{
    const [x,y]=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return [r.left+r.width*${rx},r.top+r.height*${ry}]})()`);
    for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
  };
  const editor=()=>ev('document.querySelector("#body-editor").value');
  const boxSelect=(a,b=a)=>ev(`document.querySelector('#body-editor').focus();document.querySelector('#body-editor').setSelectionRange(${a},${b})`);
  const finish=async()=>{await key('Escape');await sleep(30);};
  const point=async(selector,offset)=>ev(`(()=>{const n=document.createTreeWalker(document.querySelector(${JSON.stringify(selector)}),NodeFilter.SHOW_TEXT).nextNode(),r=document.createRange();r.setStart(n,${offset});r.setEnd(n,${offset+1});const b=r.getBoundingClientRect();return [b.x+1,b.y+b.height/2]})()`);
  const drag=async(a,b)=>{await send('Input.dispatchMouseEvent',{type:'mousePressed',x:a[0],y:a[1],button:'left',clickCount:1});await sleep(20);for(let i=1;i<=8;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:a[0]+(b[0]-a[0])*i/8,y:a[1]+(b[1]-a[1])*i/8,button:'left',buttons:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:b[0],y:b[1],button:'left',clickCount:1});await sleep(20);};
  const space=async()=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '});await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});};
  const readyInput=()=>ev('document.activeElement===document.querySelector("#body-editor")&&document.activeElement.isContentEditable');
  await check('history puts the most recently edited draft first without promoting a read-only visit',async()=>{
    await load('较早创建的稿件。',false);const older=(await current()).meta.id;
    await sleep(20);await load('较晚创建的稿件。',false);const newer=(await current()).meta.id;
    const first=()=>ev('document.querySelector("#history-list .history-row")?.dataset.record');
    const openHistory=async()=>{await ev('document.querySelector("#history-menu").open=true');await wait(()=>ev('document.querySelectorAll("#history-list .history-row").length>=2'));};
    await openHistory();assert.equal(await first(),newer);
    await click('#history-list [data-record="'+older+'"]');
    await wait(()=>ev('document.querySelector("#manuscript").textContent.includes("较早创建")'));
    await openHistory();assert.equal(await first(),newer,'opening a draft is not an edit');
    await ev('document.querySelector("#history-menu").open=false');
    await click('#manuscript .sentence');await finish();
    await click('#opinion');await send('Input.insertText',{text:'只写意见也应置顶。'});
    await wait(async()=>{const rec=await current();return rec.meta.id===older&&rec.draft.notes[0]?.opinion==='只写意见也应置顶。'});
    await openHistory();await wait(async()=>await first()===older);
    {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/history-edited-first.png',Buffer.from(shot.data,'base64'));}
    await send('Page.reload');await wait(()=>ev('document.readyState==="complete"&&document.querySelector("#history-menu")'));
    await openHistory();await wait(async()=>await first()===older);
    await ev('document.querySelector("#history-menu").open=false');
  });
  await check('deleting a cross-sentence selection immediately accepts spaces and Chinese IME without another click',async()=>{
    for(const markdown of [false,true]){
      await load('第一句。第二句。第三句。\n\n尾段。',markdown);
      await select('#manuscript .sentence[data-index="0"]',2,'#manuscript .sentence[data-index="1"]',2);
      await key('Delete');assert.equal(await readyInput(),true);
      const scroll=await ev('document.querySelector("#reading-body").scrollTop');
      await space();await send('Input.imeSetComposition',{text:'xin',selectionStart:3,selectionEnd:3});await send('Input.insertText',{text:'新'});
      assert.equal(revisedText((await current()).draft),'第一 新句。第三句。\n\n尾段。');
      assert.equal(await readyInput(),true);assert.equal(await ev('document.querySelector("#reading-body").scrollTop'),scroll);
      await finish();
    }
  });
  await check('blank-line deletion keeps a real input focus and can continue typing or start IME',async()=>{
    for(const markdown of [false,true]){
      await load('前句。\n\n\n后句。',markdown);await click('#manuscript .sentence[data-index="1"]');await boxSelect(0);
      await key('Backspace');assert.equal(await readyInput(),true);
      await space();await send('Input.insertText',{text:'接着写'});
      assert.equal(revisedText((await current()).draft),'前句。\n\n 接着写后句。');
      await finish();
      await click(markdown?'#manuscript .md-gap':'#manuscript .text-gap',.05,.5);
      assert.equal(await readyInput(),true);
      await send('Input.imeSetComposition',{text:'kong',selectionStart:4,selectionEnd:4});await send('Input.insertText',{text:'空行输入'});
      assert.ok(revisedText((await current()).draft).includes('空行输入'));
    }
  });
  await check('deleting all text leaves an editable caret and preserves the original on new input',async()=>{
    const original='整段原文。\n\n第二段。';await load(original,true);
    await ev('document.querySelector("#manuscript").focus()');await key('a',2);await key('Delete');
    assert.equal(await readyInput(),true);assert.equal(revisedText((await current()).draft),'');
    await space();await send('Input.insertText',{text:'重新开始。'});
    const rec=await current();assert.equal(revisedText(rec.draft),' 重新开始。');assert.equal(rec.draft.source,original);
  });
  await check('multiblock revision with leading blank lines and a dash never edits inside a fixed spacer',async()=>{
    const base='前段的最后一句。原来的短句。\n\n后段保持正常排版。\n\n尾段。';
    await load(base,true);await click('#manuscript .sentence[data-index="1"]');await finish();
    const revision='\r\n\r\n改过的整句仍然在这里。\r\n\r\n——\r\n';
    await ev('document.querySelector("#revision").value='+JSON.stringify(revision)+';document.querySelector("#revision").dispatchEvent(new Event("input"))');
    await current();await sleep(100);
    await ev('window.beforeEdit=document.querySelector("#manuscript").innerText');
    const selector='#manuscript p .sentence[data-index="1"]';
    await click(selector);
    assert.equal(await ev('Boolean(document.querySelector("#body-editor").closest(".md-gap"))'),false);
    assert.equal(await editor(),revision.replaceAll('\r\n','\n'));
    const layout=await ev('(()=>{const e=document.querySelector("#body-editor"),next=document.querySelector("#manuscript .sentence[data-index=\\"2\\"]");const r=e.getBoundingClientRect();const node=[...document.querySelector(".inline-source-region").childNodes].at(-1);const range=document.createRange();range.selectNodeContents(node);const following=range.getBoundingClientRect();return {editor:r.toJSON(),following:following.toJSON()}})()');
    assert.ok(layout.following.bottom>layout.editor.bottom,JSON.stringify(layout));
    assert.ok(await ev('document.querySelector(".inline-source-region").getBoundingClientRect().bottom>=document.querySelector("#body-editor").getBoundingClientRect().bottom'));
    {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/multiblock-inline.png',Buffer.from(shot.data,'base64'));}
    await finish();assert.equal(await ev('document.querySelector("#manuscript").innerText===window.beforeEdit'),true);
    const record=await current();assert.equal(record.draft.source,base);
    assert.equal(record.draft.notes[1].revision,revision.replaceAll('\r\n','\n'));
  });
  await check('blank lines delete at sentence boundaries and by clicking whitespace in source and Markdown views',async()=>{
    for(const markdown of [false,true]){
      const source='前句。\n\n\n后句。';await load(source,markdown);
      await click('#manuscript .sentence[data-index="1"]');await boxSelect(0);
      await key('Backspace');await key('Backspace');await key('Backspace');
      await current();
      const effective=()=>ev('(async()=>{const {revisedText}=await import("/model.mjs");const rows=await fetch("/api/drafts",{headers:{"X-Diffwrite":"1"}}).then(r=>r.json());const rec=await fetch("/api/drafts/"+rows[0].id,{headers:{"X-Diffwrite":"1"}}).then(r=>r.json());return revisedText(rec.draft)})()');
      assert.equal(await effective(),'前句。后句。');
      await key('z',2);await key('z',2);await key('z',2);await current();assert.equal(await effective(),source);
      await finish();await click('#manuscript .sentence[data-index="0"]');await boxSelect((await editor()).length);
      await key('Delete');await key('Delete');await key('Delete');await current();assert.equal(await effective(),'前句。后句。');
      await key('z',2);await key('z',2);await key('z',2);await current();await finish();
      const selector=markdown?'#manuscript .md-gap':'#manuscript .text-gap';
      await click(selector,.05,.5);
      assert.equal(await readyInput(),true);
      const clicked=await ev('(()=>{const s=getSelection(),e=document.activeElement;return {active:e.id,anchor:s.anchorNode?.nodeName,anchorParent:s.anchorNode?.parentElement?.className,offset:s.anchorOffset,text:s.anchorNode?.textContent}})()');
      await key('Backspace');await current();
      assert.equal((await effective()).match(/\n/g).length,2,JSON.stringify({markdown,clicked}));
      assert.equal(await readyInput(),true);
      {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/blank-line-caret-'+markdown+'.png',Buffer.from(shot.data,'base64'));}
      await key('z',2);await current();assert.equal(await effective(),source);
      assert.equal((await current()).draft.source,source);
    }
  });
  await check('MCP new drafts appear in history and a top-right toast without interrupting the current draft',async()=>{
    await load('正在审核的原稿。',true);await click('#manuscript .sentence');await finish();
    await ev('document.querySelector("#opinion").focus()');const name=await ev('document.querySelector("#draft-name").textContent');
    await ev(`(async()=>{const api=async(path,body)=>fetch('/api/'+path,{method:'POST',headers:{'X-Diffwrite':'1','Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
      const {id}=await api('mcp-connections',{name:'投稿测试'}),{token}=await api('mcp-connections/'+id+'/copy',{});await api('mcp-mode',{enabled:true});
      for(let i=1;i<=3;i++){const response=await fetch('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:i,method:'tools/call',params:{name:'publish_draft',arguments:{requestId:'arrival-'+i,title:'后续0'+i+'验收稿',text:'# 后续0'+i+'\\n\\n测试正文。',format:'markdown'}}})}).then(r=>r.json());if(response.result.isError)throw Error(response.result.content[0].text)}})()`);
    await wait(()=>ev('!document.querySelector("#ai-arrival").hidden&&document.querySelector("#ai-arrival-names").children.length===3'));
    assert.equal(await ev('document.querySelector("#draft-name").textContent'),name);
    assert.equal(await ev('document.activeElement.id'),'opinion');
    assert.ok(await ev('document.querySelector("#ai-arrival").getBoundingClientRect().left>innerWidth/2'));
    {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/ai-arrival.png',Buffer.from(shot.data,'base64'));}
    await click('#ai-arrival-open');
    await wait(()=>ev('document.querySelector("#history-menu").open&&[1,2,3].every(i=>document.querySelector("#history-list").textContent.includes("后续0"+i+"验收稿"))'));
  });
  await check('MCP file import and annotated paste are silent notifications without losing pending human edits',async()=>{
    await ev(`(async()=>{const api=async(path,body)=>fetch('/api/'+path,{method:body?'POST':'GET',headers:{'X-Diffwrite':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}).then(r=>r.json());
      const {id}=await api('mcp-connections',{name:'验收接收人'}),{token}=await api('mcp-connections/'+id+'/copy',{});window.testRecipient=id;let seq=0;
      window.testMcp=async(name,args={})=>{const msg=await fetch('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}})}).then(r=>r.json());const result=msg.result;if(result.isError)throw Error(result.content[0].text);return result.structuredContent};})()`);
    const imported=Array.from({length:330},(_,i)=>`旧稿第${i}句。 <意见：旧意见${i}>`).join('\n');
    const filename=dir+'/annotated-import.md';fs.writeFileSync(filename,imported);
    const doc=await send('DOM.getDocument');const input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file'});
    await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[filename]});
    await wait(()=>ev('document.querySelector("#save-state").textContent==="已保存"&&document.querySelector("#draft-name").textContent==="annotated-import.md"'));
    const notify=async()=>{await ev('document.querySelector("#notify-ai").click()');await wait(()=>ev('!document.querySelector("#notify-send").disabled&&document.querySelector("#notify-recipient").options.length>0'));await ev('document.querySelector("#notify-recipient").value=window.testRecipient;document.querySelector("#notify-form").requestSubmit()');await wait(()=>ev('!document.querySelector("#notify-dialog").open'));return ev('document.querySelector("#output-state").textContent');};
    assert.match(await notify(),/没有.*新改动/);
    assert.deepEqual(await ev('window.testMcp("list_review_notifications",{limit:100})'),{notifications:[]});
    await click('#manuscript .sentence[data-index="0"]');await finish();
    await ev('document.querySelector("#opinion").focus();document.querySelector("#opinion").value="导入后尚未通知的人工意见";document.querySelector("#opinion").dispatchEvent(new Event("input"))');
    await current();
    await click('#manuscript .sentence[data-index="1"]');await boxSelect(0,(await editor()).length);
    const pasted='粘贴旧句甲。 <意见：粘贴旧意见> <改为：粘贴旧改写。>\n<del>粘贴旧句乙。</del>\n<del>\n</del>粘贴旧句丙。';
    await ev('(()=>{const data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(pasted)+');document.querySelector("#body-editor").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');
    await wait(()=>ev('document.querySelector("#output-state").textContent==="已插入当前稿件，还原意见与改动。"'));
    assert.match(await notify(),/1 处更新/);
    const notices=await ev('window.testMcp("list_review_notifications",{limit:100})');assert.equal(notices.notifications.length,1);
    assert.equal(notices.notifications[0].changeCount,1);
    const detail=await ev('window.testMcp("read_review_notification",{notificationId:'+JSON.stringify(notices.notifications[0].id)+',offset:0,limit:100})');
    assert.equal(detail.changes[0].opinion,'导入后尚未通知的人工意见');assert.equal(detail.structureChanged,undefined);
    assert.match(await notify(),/没有.*新改动/);
    const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/import-notification.png',Buffer.from(shot.data,'base64'));
  });
  await check('import feedback floats without moving the manuscript and disappears automatically',async()=>{
    await load('普通稿件。',false);
    const top=await ev('document.querySelector("#reading-body").getBoundingClientRect().top');
    await load('带注稿件。 <意见：保留意见>',false);
    assert.equal(await ev('document.querySelector("#notice")'),null);
    assert.equal(await ev('getComputedStyle(document.querySelector("#output-state")).position'),'fixed');
    assert.match(await ev('document.querySelector("#output-state").textContent'),/识别审稿痕迹/);
    assert.equal(await ev('document.querySelector("#output-state").hidden'),false);
    assert.equal(await ev('document.querySelector("#reading-body").getBoundingClientRect().top'),top);
    {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/import-toast.png',Buffer.from(shot.data,'base64'));}
    await wait(()=>ev('document.querySelector("#output-state").hidden'));
    assert.equal(await ev('document.querySelector("#reading-body").getBoundingClientRect().top'),top);
  });
  await check('selection does not add a green tint or mask the existing diff color',async()=>{
    await load('原句。 <改为：改句。>下一句。',false);
    const before=await ev('getComputedStyle(document.querySelector("#manuscript .sentence")).backgroundColor');
    const added=await ev('getComputedStyle(document.querySelector("#manuscript .diff-added")).backgroundColor');
    await click('#manuscript .sentence');await finish();
    assert.equal(await ev('getComputedStyle(document.querySelector("#manuscript .sentence[data-selected=true]")).backgroundColor'),before);
    assert.equal(await ev('getComputedStyle(document.querySelector("#manuscript .diff-added")).backgroundColor'),added);
  });
  await check('click opens only the current sentence source box; typing does not repaint the document',async()=>{
    await load('# 标题\n\n**粗体文字。**\n\n尾段。',true);await click('#manuscript strong .sentence');
    assert.equal(await editor(),'**粗体文字。**');
    assert.equal(await ev('document.querySelector("#manuscript").isContentEditable'),false);
    await ev('window.firstBlock=document.querySelector("#manuscript").firstChild');
    await boxSelect(4);await send('Input.insertText',{text:'新'});
    assert.equal(await editor(),'**粗体新文字。**');
    assert.equal(await ev('window.firstBlock===document.querySelector("#manuscript").firstChild'),true);
    {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/local-source-box.png',Buffer.from(shot.data,'base64'));}
    await finish();assert.equal(await ev('document.querySelector("#manuscript strong").textContent'),'粗体新文字。');
    assert.equal((await current()).draft.source,'# 标题\n\n**粗体文字。**\n\n尾段。');
  });
  await check('clicking the next sentence commits the first and opens the next local box',async()=>{
    await load(['第一句。','第二句。'].join(String.fromCharCode(10,10)),true);await click('#manuscript p:first-of-type .sentence');await boxSelect(1);await send('Input.insertText',{text:'新'});
    await click('#manuscript p:last-of-type .sentence');assert.equal(await editor(),'第二句。');assert.equal(await ev('document.querySelector("#body-editor").hidden'),false);
  });
  await check('native IME commit cancellation undo redo stay in local source box',async()=>{
    await load('**第一句。**\n\n尾段。',true);await click('#manuscript strong .sentence');await boxSelect(3,4);
    await send('Input.imeSetComposition',{text:'er',selectionStart:2,selectionEnd:2});await send('Input.insertText',{text:'二'});
    assert.equal(await editor(),'**第二句。**');await key('z',2);assert.equal(await editor(),'**第一句。**');await key('y',2);assert.equal(await editor(),'**第二句。**');
    await boxSelect(4);await send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});await send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
    await send('Input.insertText',{text:'新'});assert.equal(await editor(),'**第二新句。**');
  });
  await check('blank-line clicks do not open empty editor boxes or change the draft',async()=>{
    await load('她想起来了。\n......\n\n\n\n下一段。',true);
    const before=(await current()).draft;
    for(const gap of await ev('[...document.querySelectorAll(".md-gap")].map((_,i)=>i)')){
      await click('.md-gap:nth-of-type('+(gap+1)+')');
      assert.equal(await readyInput(),true);assert.ok((await editor()).trim().length>0);
      const after=(await current()).draft;
      assert.equal(after.source,before.source);
      assert.deepEqual(after.notes,before.notes);
      await finish();
    }
    assert.ok(await ev('document.querySelector("#manuscript").innerText.includes("......")'));
  });
  await check('short sentence editor matches the old compact inline style',async()=>{
    await load('前句。中句。后句。\n\n尾段。',true);
    await click('#manuscript p:first-of-type .sentence:nth-of-type(2)');
    const box=await ev('(()=>{const e=document.querySelector("#body-editor"),r=e.getBoundingClientRect();return {hidden:e.hidden,width:r.width,parent:e.parentElement.getBoundingClientRect().width,height:r.height,display:getComputedStyle(e).display,minHeight:getComputedStyle(e).minHeight}})()');
    assert.equal(box.hidden,false);
    assert.ok(box.height<=40,'inline editor height should be compact: '+JSON.stringify(box));
    assert.ok(box.width<box.parent/2,'short editor should not span the paragraph: '+JSON.stringify(box));
    assert.equal(box.minHeight,'0px');
    {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/compact-inline.png',Buffer.from(shot.data,'base64'));}
    assert.equal(await ev('document.querySelector("#manuscript p:first-of-type").getBoundingClientRect().height<80'),true);
    await finish();
  });
  await check('Enter in a sentence editor creates a visible line break and Backspace removes it',async()=>{
    await load('她想起来了。\n......\n\n\n\n下一段。',true);
    await click('#manuscript p:nth-of-type(2) .sentence');
    const before=await editor();
    await boxSelect(before.length);
    await key('Enter');
    assert.equal((await editor()).length,before.length+1);
    await finish();
    const split=await ev('(()=>{const nodes=[...document.querySelectorAll("#manuscript p:nth-of-type(2) .sentence")];return {text:document.querySelector("#manuscript").innerText, rects:nodes.flatMap(e=>[...e.getClientRects()].map(r=>r.y))}})()');
    assert.ok(split.rects.length>1||split.text.includes("......\n"),JSON.stringify(split));
    await click('#manuscript p:nth-of-type(2) .sentence');
    await boxSelect((await editor()).length-1,(await editor()).length);
    await key('Backspace');
    await finish();
    const after=await current();
    assert.equal(after.draft.source,'她想起来了。\n......\n\n\n\n下一段。');
    assert.ok(await ev('document.querySelector("#manuscript").innerText.includes("......")'));
  });
  await check('raw source blank spaces stay blank unless the author types within a sentence',async()=>{
    await load('前句。\n\n\n\n后句。',true);await ev('document.querySelector("#markdown-view").click()');
    await click('#manuscript .text-gap');
    assert.equal(await readyInput(),true);
    assert.ok(await ev('document.querySelector("#manuscript").innerText.includes("后句。")'));
  });
  await check('dragging from outside an open editor crosses paragraphs and Delete is undoable',async()=>{
    await load('第一段开始。\n\n第二段中间。\n\n第三段结尾。',true);await click('#manuscript p:nth-of-type(2) .sentence');
    const a=await point('#manuscript p:first-of-type',2),b=await point('#manuscript p:last-of-type',2);await drag(a,b);
    assert.ok(await ev('getSelection().toString().includes("第二段中间")'));
    await key('Delete');assert.equal(revisedText((await current()).draft),'第一段结尾。');
    await key('z',2);assert.ok(await ev('getSelection().toString().includes("第二段中间")'));
  });
  await check('dragging out of the local textarea continues selection into later paragraphs',async()=>{
    await load('第一段开始。\n\n第二段中间。\n\n第三段结尾。',true);await click('#manuscript p:first-of-type .sentence');
    const a=await ev('(()=>{const r=document.querySelector("#body-editor").getBoundingClientRect();return [r.x+12,r.y+20]})()'),b=await point('#manuscript p:last-of-type',2);await drag(a,b);
    assert.equal(await ev('document.querySelector("#body-editor").hidden'),true);assert.ok(await ev('getSelection().toString().includes("第二段中间")'));
    await key('Delete');assert.ok((await current()).draft.notes[1].deleted);await key('z',2);assert.ok(await ev('document.querySelector("#manuscript").textContent.includes("第二段中间")'));
  });
  await check('dragging beyond the editor auto-scrolls and deletes a large multi-paragraph selection',async()=>{
    const source=Array.from({length:80},(_,i)=>`第${i}段开始，这里有一段可选择的文字。`).join('\n\n');
    await load(source,true);await click('#manuscript p:first-of-type .sentence');
    const a=await ev('(()=>{const r=document.querySelector("#body-editor").getBoundingClientRect();return [r.x+12,r.y+20]})()');
    const b=await ev('(()=>{const r=document.querySelector("#reading-body").getBoundingClientRect();return [r.x+200,r.bottom-3]})()');
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:a[0],y:a[1],button:'left',clickCount:1});await sleep(30);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:b[0],y:b[1],button:'left',buttons:1});await sleep(400);
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:b[0],y:b[1],button:'left',clickCount:1});
    assert.ok(await ev('document.querySelector("#reading-body").scrollTop')>100);
    assert.ok((await ev('getSelection().toString()')).length>150);
    await key('Delete');const record=await current();assert.ok(Object.values(record.draft.notes).filter(n=>n.deleted).length>5);assert.equal(record.draft.source,source);
    await key('z',2);assert.equal(Object.keys((await current()).draft.notes).length,0);
  });
  await check('annotated paste inside a local sentence box keeps separate opinions',async()=>{
    await load('第一句。\n\n尾句。',true);await click('#manuscript .sentence');assert.equal(await ev('document.querySelector("#body-editor").hidden'),false);await boxSelect(0,4);
    const annotated=['新甲。 <意见：意见甲> <改为：改甲。>','新乙。 <意见：意见乙> <改为：改乙。>'].join(String.fromCharCode(10));
    await ev('(()=>{const data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(annotated)+');document.querySelector("#body-editor").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');
    await sleep(200);const record=await current();assert.equal(Object.values(record.draft.notes).filter(x=>x.opinion).length,2);
  });
  await check('editing keeps every wrapped line and the surrounding paragraph in place',async()=>{
    const cases=[
      {prefix:'前面的文字。',target:'正在编辑的这一句会沿着段落自然跨行，不应该挤成一个孤立的矩形。'},
      {prefix:'行'.repeat(36)+'。',target:'嗯。'},
      {prefix:'前文'.repeat(14)+'。',target:'这是一句用于测试自然排版的长句'+ '，后面的文字应继续使用下一行的完整宽度'.repeat(6)+'。'}
    ];
    const rects=selector=>ev('(()=>{const e=document.querySelector('+JSON.stringify(selector)+'),r=document.createRange();r.selectNodeContents(e);return [...r.getClientRects()].map(x=>[x.x,x.y,x.width,x.height])})()');
    for(const [index,item] of cases.entries()){
      await load('# 原段落排版\n\n'+item.prefix+item.target+'后文依旧接在这里。\n\n下一段保持原位。',true);
      const selector='#manuscript .sentence[data-index="2"]';
      const before=await rects(selector);
      const paragraph=await ev('document.querySelector("#manuscript p").getBoundingClientRect().height');
      const tail=await rects('#manuscript .sentence[data-index="3"]');
      const [x,y]=await point(selector,0);
      for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
      assert.equal(await editor(),item.target);
      const after=await rects('#body-editor');
      assert.equal(after.length,before.length);
      before.forEach((row,i)=>row.forEach((v,j)=>assert.ok(Math.abs(v-after[i][j])<.5,JSON.stringify({index,before,after}))));
      assert.equal(await ev('document.querySelector("#manuscript p").getBoundingClientRect().height'),paragraph);
      assert.deepEqual(await rects('#manuscript .sentence[data-index="3"]'),tail);
      assert.equal(await ev('document.querySelector("#body-editor").tagName'),'SPAN');
      assert.equal(await ev('getComputedStyle(document.querySelector("#body-editor")).display'),'inline');
      if(index===2){assert.ok(after.length>2);const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/natural-wrapping.png',Buffer.from(shot.data,'base64'));}
      results.push({measurement:'same paragraph geometry before and during editing',case:index,lines:after.length,maximumDrift:Math.max(...before.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-after[i][j]))))});
      await finish();
    }
  });
  await check('paragraph alignment fills middle lines without stretching the last line or adding spaces',async()=>{
    const source='这是一段中英文混排的正文，包含 Markdown、编辑标记与标点；完整的中间行应沿着左右边界排列。'.repeat(4)+'最后。';
    await load(source,true);
    const lines=await ev(`(()=>{const p=document.querySelector('#manuscript p'),bounds=p.getBoundingClientRect(),walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),rows=new Map();for(let n;n=walker.nextNode();)for(let i=0;i<n.length;i++){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);const b=r.getBoundingClientRect(),row=rows.get(b.y)||[b.left,b.right];row[0]=Math.min(row[0],b.left);row[1]=Math.max(row[1],b.right);rows.set(b.y,row)}return {left:bounds.left,right:bounds.right,rows:[...rows.values()],text:p.textContent}})()`);
    assert.equal(lines.text,source);
    assert.ok(lines.rows.length>3);
    for(const row of lines.rows.slice(1,-1)){assert.ok(Math.abs(row[0]-lines.left)<1);assert.ok(Math.abs(row[1]-lines.right)<2,JSON.stringify(lines));}
    assert.ok(lines.rows.at(-1)[1]<lines.right-15);
    {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/justified-paragraph.png',Buffer.from(shot.data,'base64'));}
  });
  await check('two Enters create an independent paragraph and preserve rapid input and old opinions',async()=>{
    await load('原段最后一句。 <意见：原段意见>\n\n后面原有段落。',true);
    const before=(await current()).draft;
    await click('#manuscript p:first-of-type .sentence');await boxSelect((await editor()).length);
    await key('Enter');assert.equal((await current()).draft.spans.length,before.spans.length);
    await ev(`window.normalFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/paragraph-break'))await new Promise(r=>setTimeout(r,350));return window.normalFetch(...args)}`);
    await key('Enter');await send('Input.insertText',{text:'这是新增的一段。'});
    await wait(()=>ev('document.querySelector("#quote-caption").textContent==="新增段落"&&document.querySelector("#body-editor").value==="这是新增的一段。"&&document.querySelector("#save-state").textContent==="已保存"'));
    await ev('window.fetch=window.normalFetch');
    const rec=await current();assert.equal(rec.draft.spans.length,before.spans.length+1);assert.deepEqual(rec.draft.insertedSlots,[1]);
    assert.equal(rec.draft.notes[0].opinion,'原段意见');assert.equal(rec.draft.notes[0].revision,'');assert.equal(rec.draft.notes[1].revision,'这是新增的一段。');
    assert.equal(await ev('document.querySelector("#opinion").value'),'');
    const newBox=await ev('(()=>{const e=document.querySelector("#body-editor"),n=[...document.querySelectorAll("#manuscript .sentence")].find(x=>x.dataset.index==="2");return {box:e.getBoundingClientRect().toJSON(),next:n.getBoundingClientRect().toJSON()}})()');
    assert.ok(newBox.next.top>newBox.box.bottom);
    {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/new-independent-paragraph.png',Buffer.from(shot.data,'base64'));}
    await ev('document.querySelector("#opinion").value="新增段意见";document.querySelector("#opinion").dispatchEvent(new Event("input"))');
    await finish();assert.equal((await current()).draft.notes[1].opinion,'新增段意见');
    await click('#manuscript .sentence[data-index="0"]');assert.equal(await ev('document.querySelector("#opinion").value'),'原段意见');
    await finish();await ev('document.querySelector("#tab-source").click()');
    await ev('document.querySelector("#markdown-view").click()');
    assert.equal(await ev('document.querySelector("#manuscript").textContent'),before.source);
    await ev('document.querySelector("#tab-split").click()');
    await ev('document.querySelector("#markdown-view").click()');
  });
  await check('empty new paragraphs can be undone redone reopened and split again at EOF',async()=>{
    await load('末尾原句。',true);await click('#manuscript .sentence');await boxSelect((await editor()).length);
    await key('Enter');await key('Enter');
    await wait(()=>ev('document.querySelector("#quote-caption").textContent==="新增段落"&&document.querySelector("#save-state").textContent==="已保存"'));
    assert.equal(await editor(),'');assert.equal(await ev('document.activeElement.id'),'body-editor');assert.deepEqual((await current()).draft.insertedSlots,[1]);
    await key('z',2);await wait(()=>ev('document.querySelector("#output-state").textContent==="已撤销分段。"'));assert.equal((await current()).draft.insertedSlots,undefined);
    await key('y',2);await wait(()=>ev('document.querySelector("#quote-caption").textContent==="新增段落"&&document.activeElement.id==="body-editor"'));assert.equal(await editor(),'');
    await key('Enter');await key('Enter');
    await wait(async()=>{const rec=await current();return rec.draft.insertedSlots?.length===2});
    await send('Input.insertText',{text:'第三段。'});await finish();
    const rec=await current();assert.equal(rec.draft.notes[2].revision,'第三段。');assert.ok(!rec.draft.notes[1]?.revision);
    await click('#manuscript .empty-sentence');assert.equal(await editor(),'');await send('Input.insertText',{text:'第二段。'});await finish();
    assert.equal((await current()).draft.notes[1].revision,'第二段。');
  });
  await check('rapid consecutive paragraph breaks keep input in separate plain-text slots',async()=>{
    await load('原句。',false);await click('#manuscript .sentence');await boxSelect((await editor()).length);
    await ev(`window.normalFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/paragraph-break'))await new Promise(r=>setTimeout(r,250));return window.normalFetch(...args)}`);
    await key('Enter');await key('Enter');await send('Input.insertText',{text:'第二段。'});await key('Enter');await key('Enter');await send('Input.insertText',{text:'第三段。'});
    await wait(()=>ev('document.querySelector("#body-editor").value==="第三段。"&&document.querySelector("#save-state").textContent==="已保存"'));
    await ev('window.fetch=window.normalFetch');
    const rec=await current();assert.deepEqual(rec.draft.insertedSlots,[1,2]);assert.equal(rec.draft.notes[1].revision,'第二段。');assert.equal(rec.draft.notes[2].revision,'第三段。');
    await key('z',2);assert.equal(await editor(),'');await key('z',2);
    await wait(()=>ev('document.querySelector("#output-state").textContent==="已撤销分段。"'));
    assert.deepEqual((await current()).draft.insertedSlots,[1]);
    assert.equal(await editor(),'第二段。\n');
    await key('y',2);await wait(()=>ev('document.querySelector("#quote-caption").textContent==="新增段落"&&document.querySelector("#body-editor").value===""'));
    await key('y',2);assert.equal(await editor(),'第三段。');
  });
  await check('new paragraph supports IME and stays editable when its text is cleared',async()=>{
    await load('原句。\n\n后句。',true);await click('#manuscript .sentence');await boxSelect((await editor()).length);
    await ev(`window.normalFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/paragraph-break'))await new Promise(r=>setTimeout(r,200));return window.normalFetch(...args)}`);
    await key('Enter');await key('Enter');await send('Input.imeSetComposition',{text:'xin',selectionStart:3,selectionEnd:3});
    await sleep(300);await send('Input.insertText',{text:'新段'});
    await wait(()=>ev('document.querySelector("#body-editor").value==="新段"&&document.querySelector("#save-state").textContent==="已保存"'));
    await ev('window.fetch=window.normalFetch');await boxSelect(0,2);await key('Backspace');await finish();
    assert.equal((await current()).draft.notes[1]?.deleted,undefined);
    await click('#manuscript .empty-sentence');assert.equal(await editor(),'');await send('Input.insertText',{text:'重新写。'});await finish();
    assert.equal((await current()).draft.notes[1].revision,'重新写。');
    const a=await point('#manuscript p:first-of-type',1),b=await point('#manuscript p:last-of-type',1);await drag(a,b);await key('Delete');
    assert.equal((await current()).draft.notes[1].deleted,true);
    await key('z',2);assert.equal((await current()).draft.notes[1].revision,'重新写。');
  });
  await check('annotated paste while a paragraph split is pending still restores opinions',async()=>{
    await load('原句。\n\n后句。',true);await click('#manuscript .sentence');await boxSelect((await editor()).length);
    await ev(`window.normalFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/paragraph-break'))await new Promise(r=>setTimeout(r,250));return window.normalFetch(...args)}`);
    await key('Enter');await key('Enter');
    const text='来稿甲。 <意见：第一条意见> <改为：改稿甲。>\n来稿乙。 <意见：第二条意见>';
    await ev('(()=>{const data=new DataTransfer();data.setData("text/plain",'+JSON.stringify(text)+');document.querySelector("#body-editor").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}))})()');
    await send('Input.insertText',{text:'后续输入。'});
    await wait(()=>ev('document.querySelector("#output-state").textContent==="已插入当前稿件，还原意见与改动。"'));
    await ev('window.fetch=window.normalFetch');
    const rec=await current(),opinions=Object.values(rec.draft.notes).map(n=>n.opinion).filter(Boolean);
    assert.deepEqual(opinions,['第一条意见','第二条意见']);
    assert.equal(await ev('document.querySelector("#manuscript").textContent.includes("<意见")'),false);
    assert.equal(await ev('document.querySelector("#manuscript").textContent.includes("后续输入。")'),true);
  });
  await check('3500 sentence manuscript has fast late-page clicks and no input repaint',async()=>{
    const base=Array.from({length:500},(_,p)=>Array.from({length:7},(_,i)=>`第${p}段第${i}句含有**粗体文字**和一些内容。`).join('')).join('\n\n');
    const text=base+String.fromCharCode(10,10)+['她想起来了。','......','','','','下一段。'].join(String.fromCharCode(10));
    await load(text,true);const selector='#manuscript p:nth-of-type(490) .sentence';
    await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    const samples=[];
    for(let i=0;i<8;i++){
      await ev('window.clickStart=performance.now();window.clickFrame=0;document.querySelector("#manuscript").addEventListener("click",()=>requestAnimationFrame(()=>window.clickFrame=performance.now()-window.clickStart),{once:true})');
      await click(selector);await wait(()=>ev('window.clickFrame>0'));samples.push(await ev('window.clickFrame'));
      assert.ok((await editor()).length<150);await finish();
    }
    const max=Math.max(...samples);results.push({measurement:'late-page click to rendered frame ms',samples,max,characters:text.length,sentences:(await current()).draft.spans.length});assert.ok(max<500,JSON.stringify(samples));
    await click(selector);await ev('window.firstBlock=document.querySelector("#manuscript").firstChild');const scroll=await ev('document.querySelector("#reading-body").scrollTop');
    await boxSelect(3);await send('Input.insertText',{text:'新'});await key('Enter');await key('Backspace');
    assert.equal(await ev('window.firstBlock===document.querySelector("#manuscript").firstChild'),true);
    assert.ok(Math.abs(await ev('document.querySelector("#reading-body").scrollTop')-scroll)<2);
    await finish();
    await click('#manuscript p:last-of-type .sentence');assert.equal(await editor(),'下一段。');
    await boxSelect((await editor()).length);
    await key('Enter');await key('Enter');
    const started=Date.now();
    await wait(()=>ev('document.querySelector("#quote-caption").textContent==="新增段落"&&document.activeElement.id==="body-editor"'));
    assert.equal(await editor(),'');
    await send('Input.insertText',{text:'新的末尾段。'});await finish();
    assert.ok((await current()).draft.insertedSlots?.length===1);
    assert.equal(await ev('document.querySelector("#manuscript p:last-of-type").textContent'),'新的末尾段。');
    results.push({measurement:'late-page independent paragraph split and input ms',elapsed:Date.now()-started});
  });
  assert.deepEqual(errors,[]);
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(dir+'/rendered.png',Buffer.from(shot.data,'base64'));
}catch(error){results.push({fatal:error.stack});}
finally{fs.writeFileSync(dir+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify({dir,results},null,2));ws?.close();chrome.kill();server.kill();if(results.some(x=>x.fatal||x.ok===false))process.exitCode=1;}
