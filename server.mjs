import {createServer, get} from 'node:http';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {makeReviewApi} from './review-api.mjs';

const host = '127.0.0.1', port = Number(process.env.DIFFWRITE_REVIEW_PORT || 41732), url = 'http://'+host+':'+port+'/';
const open = process.argv.includes('--open'), managed = process.argv.includes('--managed');
const types = new Map([
  ['/','text/html; charset=utf-8'], ['/style.css','text/css; charset=utf-8'],
  ...['app','model','docx','markdown','history','changes','opinion-ui','vendor/markdown-parser'].map(name => ['/'+name+'.mjs','text/javascript; charset=utf-8'])
]);
const signature = 'diffwrite-v8';
const reviewApi = makeReviewApi(url.slice(0,-1));
const server = createServer(async (req,res) => {
  const send = (status, type, content) => {
    res.writeHead(status, {
      'Content-Type':type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'self'",
      'Referrer-Policy':'no-referrer'
    });
    res.end(content);
  };
  if (req.headers.host !== host+':'+port) return send(403,'text/plain','Forbidden');
  if (await reviewApi(req,res)) return;
  if (!['GET','HEAD'].includes(req.method)) return send(405,'text/plain','Method not allowed');
  if (req.url === '/health') return send(200,'text/plain',signature);
  const type = types.get(req.url);
  if (!type) return send(404,'text/plain','Not found');
  try {
    const content = await readFile(new URL(req.url === '/' ? 'index.html' : req.url.slice(1),import.meta.url));
    send(200,type,req.method === 'HEAD' ? undefined : content);
  } catch {send(500,'text/plain','Cannot open application file.');}
});
function openBrowser() {
  if (!open || process.platform !== 'win32') return;
  const child = spawn(process.env.ComSpec || 'cmd.exe',['/d','/c','start','',url],{windowsHide:true,stdio:'ignore'});
  child.on('error',() => {});
  child.unref();
}
server.on('error',error => {
  const fail = () => {console.error('Cannot start the review tool: '+error.message); process.exitCode = 1;};
  if (managed || error.code !== 'EADDRINUSE') return fail();
  const request = get(url+'health',res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data',chunk => {body += chunk; if (body.length > 100) request.destroy();});
    res.on('end',() => {
      if (res.statusCode === 200 && body === signature) {
        console.log('Already running: '+url); openBrowser();
      } else if (res.statusCode === 200 && /^diffwrite-v\d+$/.test(body)) {
        console.error('Close the previous Diffwrite window, then start again.');
        process.exitCode = 1;
      } else fail();
    });
  });
  request.setTimeout(2000,() => request.destroy());
  request.on('error',fail);
});
server.listen(port,host,() => {
  if(managed){
    // The launcher closes this pipe on tray exit. Finish active requests before stopping.
    process.stdin.once('end',()=>server.close(()=>{process.exitCode=0;}));
    process.stdin.resume();
    console.log('DIFFWRITE_READY');
  }else{console.log('Wings manuscript review: '+url);openBrowser();}
});
