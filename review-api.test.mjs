import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from './review-store.mjs';
import {makeReviewApi} from './review-api.mjs';

test('handwritten Streamable HTTP clients write opinions and rewrites straight into the draft; MCP mode gates writing',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'diffwrite-http-')),store=openStore(dir);
  const recipient=store.createConnection('OMP'),token=store.copyToken(recipient);
  store.setMcpMode(true);
  let api;
  const server=createServer((req,res)=>api(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  api=makeReviewApi(origin,store);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  let id=0;
  const post=(method,params,extra={})=>fetch(origin+'/mcp',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
  const rpc=async(method,params,extra={})=>{
    const response=await post(method,params,extra);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/^application\/json/);
    const message=await response.json();assert.equal(message.error,undefined);return message.result;
  };
  for(const name of ['omp','codex','other-standard-client']){
    const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name,version:'1'}});
    assert.equal(initialized.protocolVersion,'2025-06-18');
    const sessionHeaders={'MCP-Protocol-Version':initialized.protocolVersion,'Mcp-Session-Id':'previous-client-session'};
    const notification=await fetch(origin+'/mcp',{method:'POST',headers:{...headers,...sessionHeaders},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    assert.equal(notification.status,202);
    const tools=await rpc('tools/list',{},sessionHeaders);
    assert.equal(tools.tools.length,14);
    assert.ok(!tools.tools.some(t=>t.name==='submit_review'));
    assert.match(tools.tools.find(t=>t.name==='edit_draft').description,/意见栏/);
    assert.ok(tools.tools.some(t=>t.name==='update_opinion_settings'));
    const call=async(name,args)=>{
      const result=await rpc('tools/call',{name,arguments:args},sessionHeaders);
      assert.notEqual(result.isError,true);return result.structuredContent;
    };
    const published=await call('publish_draft',{requestId:'publish-'+name,title:'HTTP 测试 '+name,text:'练习稿.md，数值3.14。下一句。',format:'plain'});
    const read=await call('read_draft',{draftId:published.id});
    assert.deepEqual(read.sentences.map(s=>s.original),['练习稿.md，数值3.14。','下一句。']);
    const review=await call('edit_draft',{requestId:'review-'+name,draftId:published.id,expectedRevision:read.meta.revision,edits:[{sentence:0,original:read.sentences[0].original,opinion:'更清楚',replacement:'AI 改写。'}]});
    assert.deepEqual(review.changed,[0]);
    assert.deepEqual(review.keptHuman,[]);
    assert.equal((await call('read_draft',{draftId:published.id,limit:1})).sentences[0].opinionBy,'ai');
    const browserHeaders={'X-Diffwrite':'1','Sec-Fetch-Site':'same-origin'};
    const browser=async(path,body)=>fetch(origin+'/api/'+path,body===undefined?{headers:browserHeaders}:
      {method:'POST',headers:{...browserHeaders,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await browser('drafts/'+published.id+'/suggestions')).status,404);
    const record=await (await browser('drafts/'+published.id)).json();
    assert.deepEqual(record.draft.notes[0],{opinion:'更清楚',revision:'AI 改写。'});
    assert.deepEqual(record.draft.aiMarks,{0:{opinion:0,body:true}});
    const seen=await (await browser('drafts/'+published.id+'/ai-tags',{revision:review.revision,sentence:0,field:'body'})).json();
    assert.deepEqual(seen.draft.aiMarks,{0:{opinion:0}});
    assert.deepEqual(await (await browser('mcp-mode',{enabled:false})).json(),{enabled:false});
    const refused=await rpc('tools/call',{name:'edit_draft',arguments:{requestId:'off-'+name,draftId:published.id,expectedRevision:seen.meta.revision,title:'不该改'}},sessionHeaders);
    assert.equal(refused.isError,true);
    assert.match(refused.content[0].text,/MCP 模式/);
    assert.equal((await call('read_draft',{draftId:published.id,limit:1})).meta.name,'HTTP 测试 '+name);
    assert.deepEqual(await (await browser('mcp-mode')).json(),{enabled:false});
    await browser('mcp-mode',{enabled:true});
    const settings=await call('get_opinion_settings',{});
    assert.equal(typeof settings.prompt,'string');assert.equal(settings.apiKey,undefined);
    const trash=store.setTrash(published.id,seen.meta.revision,true);store.purge([{id:published.id,revision:trash.revision}]);
  }
  assert.equal((await post('ping',{}, {Accept:'application/json'})).status,406);
  assert.equal((await post('ping',{}, {'MCP-Protocol-Version':'not-supported'})).status,400);
  assert.equal((await post('ping',{}, {Authorization:'Bearer invalid'})).status,401);
  assert.equal((await post('ping',{}, {Origin:'https://untrusted.example'})).status,403);
  for(const method of ['GET','DELETE'])assert.equal((await fetch(origin+'/mcp',{method,headers})).status,405);
  const negotiated=await rpc('initialize',{protocolVersion:'unknown-future-version',capabilities:{},clientInfo:{name:'omp',version:'1'}});
  assert.notEqual(negotiated.protocolVersion,'unknown-future-version');
});
