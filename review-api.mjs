import {openStore} from './review-store.mjs';
import {askOpinion} from './opinion-ai.mjs';
import {handleMcp} from './review-mcp.mjs';

const maxBody=8*1024*1024;
class RequestError extends Error {constructor(message,status){super(message);this.status=status;}}
async function jsonBody(req){
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new RequestError('请发送 JSON 请求体。',415);
  if(Number(req.headers['content-length'])>maxBody)throw new RequestError('请求正文过大。',413);
  let size=0, chunks=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size<=maxBody)chunks.push(chunk);
  }
  if(size>maxBody)throw new RequestError('请求正文过大。',413);
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new RequestError('JSON 格式无效。',400);}
}
export function makeReviewApi(origin) {
  const store=openStore(), inFlightOpinions=new Set();
  const send=(res,status,value,headers={})=>{
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff',...headers});
    res.end(JSON.stringify(value));
  };
  const browserAllowed=req=>!req.headers.authorization && req.headers['x-diffwrite']==='1' &&
    (!req.headers.origin || req.headers.origin===origin) &&
    req.headers['sec-fetch-site']==='same-origin';
  return async function api(req,res){
    const path=req.url?.split('?')[0] ?? '';
    if(path!=='/mcp'&&!path.startsWith('/api/'))return false;
    try {
      if(path==='/mcp'){
        if(req.headers.origin&&req.headers.origin!==origin) {
          send(res,403,{error:'Origin not allowed'});return true;
        }
        const recipient=store.authorized(req.headers.authorization);
        if(!recipient){
          send(res,401,{error:'需要有效的 MCP 连接码。'},{'WWW-Authenticate':'Bearer realm="diffwrite"'});return true;
        }
        await handleMcp(req,res,req.method==='POST'?await jsonBody(req):undefined,store,recipient);
        return true;
      }
      if(!browserAllowed(req)){send(res,403,{error:'只允许本机审稿页面访问。'});return true;}
      const get=req.method==='GET', post=req.method==='POST';
      const match=/^\/api\/drafts\/([a-zA-Z0-9_-]{1,100})(?:\/(suggestions|decision|notify|seen|trash|restore|opinion-runs|opinion-generate|opinion-decision))?$/.exec(path);
      const connection=/^\/api\/mcp-connections\/([a-zA-Z0-9_-]{1,100})\/(copy|rotate|revoke|automation)$/.exec(path);
      let result;
      if(get&&path==='/api/drafts') result=store.list();
      else if(get&&path==='/api/trash') result=store.list(true);
      else if(get&&path==='/api/trash/purged') result=store.purgedIds();
      else if(post&&path==='/api/trash/purge'){const p=await jsonBody(req);result=store.purge(p?.entries);}
      else if(post&&path==='/api/drafts'){const p=await jsonBody(req);result=store.saveBrowser(p?.meta,p?.draft,p?.returnDraft===true);}
      else if(post&&path==='/api/migrate'){const p=await jsonBody(req);store.migrate(p?.meta,p?.draft);}
      else if(get&&path==='/api/opinion-settings') result=store.opinionSettings();
      else if(post&&path==='/api/opinion-settings')result=store.saveOpinionSettings(await jsonBody(req));
      else if(get&&path==='/api/opinion-feedback')result=store.opinionFeedback();
      else if(get&&path==='/api/mcp-connections')result={connections:store.connections(true),url:origin+'/mcp'};
      else if(get&&path==='/api/mcp-recipients')result=store.connections();
      else if(post&&path==='/api/mcp-connections'){const p=await jsonBody(req);result={id:store.createConnection(p?.name)};}
      else if(post&&connection){
        const [,id,action]=connection;
        if(action==='copy')result={token:store.copyToken(id),url:origin+'/mcp'};
        else if(action==='rotate')store.rotate(id);
        else if(action==='revoke')store.revoke(id);
        else {const p=await jsonBody(req);store.setAutomation(id,p?.enabled);}
      }
      else if(match){
        const [,id,action]=match;
        if(get&&!action){result=store.read(id);if(!result)throw new RequestError('找不到稿件。',404);}
        else if(get&&action==='opinion-runs')result=store.currentOpinions(id);
        else if(post&&action==='opinion-decision')result=store.decideOpinion(id,await jsonBody(req));
        else if(post&&action==='opinion-generate'){
          const p=await jsonBody(req), prepared=store.prepareOpinion(id,p);
          const key=id+':'+p?.sentence;
          if(!prepared||inFlightOpinions.has(key))result={run:null};
          else{
            inFlightOpinions.add(key);
            try{result=store.finishOpinion(id,p.sentence,prepared,await askOpinion(prepared.config,prepared.input));}
            finally{inFlightOpinions.delete(key);}
          }
        }
        else if(get&&action==='suggestions')result=store.proposals(id);
        else if(post&&action==='seen')store.seen(id);
        else if(post&&['trash','restore'].includes(action)){const p=await jsonBody(req);result=store.setTrash(id,p?.revision,action==='trash');}
        else if(post&&action==='decision'){const p=await jsonBody(req);result=store.decide(id,p?.suggestionId,p?.decision,p?.revision);}
        else if(post&&action==='notify'){const p=await jsonBody(req);result=store.notify(id,p?.revision,p?.recipient);}
        else throw new RequestError('请求方式不支持。',405);
      }else throw new RequestError('未找到接口。',404);
      send(res,200,result??{ok:true});
    }catch(error){
      if(!res.headersSent)send(res,error.status??500,{error:error.status?error.message:'本地审稿后台暂时无法完成操作。'});
      else if(!res.writableEnded)res.end();
      if(!error.status)console.error('Review backend failure:',error.code??error.name);
    }
    return true;
  };
}
