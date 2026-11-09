import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile,mkdir,mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

if(process.platform!=='win32'||process.arch!=='x64'||!process.version.startsWith('v24.'))
  throw new Error('Build with Windows x64 Node.js 24.');
const here=dirname(fileURLToPath(import.meta.url)), project=dirname(here);
const target=resolve(process.argv[2]||join(project,'dist','Diffwrite.exe'));
const seven=process.env.DIFFWRITE_7ZIP||join(process.env.ProgramFiles||'C:/Program Files','7-Zip','7z.exe');
const go=process.env.DIFFWRITE_GO||'go.exe';
const tar=join(process.env.SystemRoot||'C:/Windows','System32','tar.exe');
const run=promisify(execFile);
const work=await mkdtemp(join(tmpdir(),'diffwrite-pack-'));
const payload=join(work,'payload');
const files=['index.html','style.css','server.mjs','app.mjs','model.mjs','docx.mjs','markdown.mjs',
  'changes.mjs','history.mjs','review-api.mjs','review-store.mjs','review-mcp.mjs','opinion-ai.mjs','opinion-ui.mjs','opinion-prompt.txt',
  'vendor/markdown-parser.mjs','vendor/mcp-sdk.mjs'];
const buildId=process.version+'-'+Date.now().toString(36);
const opts={cwd:work,windowsHide:true,maxBuffer:4*1024*1024};
try{
  await mkdir(payload);
  await mkdir(join(work,'icon-resource'));
  await copyFile(join(here,'icon-resource','main.go'),join(work,'icon-resource','main.go'));
  for(const name of ['main.go','tray.go','go.mod','go.sum'])await copyFile(join(here,name),join(work,name));
  for(const name of files){
    const dest=join(payload,name);
    await mkdir(dirname(dest),{recursive:true});
    await copyFile(join(project,name),dest);
  }
  await copyFile(process.execPath,join(payload,'node.exe'));
  const nodeLicense=await fetch('https://raw.githubusercontent.com/nodejs/node/'+process.version+'/LICENSE',
    {signal:AbortSignal.timeout(15000)});
  if(!nodeLicense.ok)throw new Error('Cannot retrieve the Node.js redistribution notices.');
  const {stdout:deps}=await run(go,['mod','download','-json','github.com/ulikunitz/xz'],opts);
  const {Dir:xzDir}=JSON.parse(deps);
  const {stdout:goRoot}=await run(go,['env','GOROOT'],opts);
  const licenses=[['Diffwrite',await readFile(join(project,'LICENSE'),'utf8')],
    ['Node.js '+process.version,await nodeLicense.text()],
    ['Go runtime',await readFile(join(goRoot.trim(),'LICENSE'),'utf8')],
    ['Go XZ decoder',await readFile(join(xzDir,'LICENSE'),'utf8')],
    ['Markdown dependencies',await readFile(join(project,'vendor/markdown-licenses.txt'),'utf8')],
    ['MCP dependencies',await readFile(join(project,'vendor/mcp-licenses.txt'),'utf8')]];
  await writeFile(join(payload,'THIRD_PARTY_NOTICES.txt'),licenses.map(([name,value])=>name+'\n\n'+value).join('\n\n----\n\n'));
  await run(tar,['-cf',join(work,'app.tar'),'-C',payload,'node.exe',...files,'THIRD_PARTY_NOTICES.txt'],opts);
  console.log('Compressing application and runtime...');
  await run(seven,['a','-txz','app.tar.xz','app.tar','-mx=9','-m0=LZMA2:d=32m','-mmt=2'],opts);
  console.log('Building the single Windows executable...');
  const exe=join(work,'Diffwrite.exe');
  await run(go,['build','-trimpath','-buildvcs=false','-ldflags','-s -w -H=windowsgui -X main.buildID='+buildId,'-o',exe,'.'],
    {...opts,env:{...process.env,GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0'}});
  await run(go,['run','./icon-resource',exe,join(here,'icon.ico')],opts);
  await mkdir(dirname(target),{recursive:true});
  const pending=join(dirname(target),'.diffwrite-'+buildId+'.exe');
  await copyFile(exe,pending);
  try{await rename(pending,target);}catch(error){await rm(pending,{force:true});throw error;}
  console.log(target+' · '+(await stat(target)).size+' bytes');
}finally{
  const rel=relative(tmpdir(),work);
  if(isAbsolute(work)&&!rel.includes(sep)&&rel.startsWith('diffwrite-pack-'))
    await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
