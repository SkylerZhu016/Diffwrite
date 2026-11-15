import {readFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';

// Machine-local preferences are external to the source tree and packaged EXE.
export function launchConfig(env=process.env){
  const directory=join(env.LOCALAPPDATA||homedir(),'Diffwrite');
  let config={};
  if(!env.DIFFWRITE_REVIEW_DATA||!env.DIFFWRITE_REVIEW_PORT){
    try{config=JSON.parse(readFileSync(join(directory,'launch.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw new Error('无法读取本机启动配置 launch.json：'+error.message);}
    if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('本机启动配置无效。');
  }
  const data=env.DIFFWRITE_REVIEW_DATA||config.dataDirectory||directory;
  const port=Number(env.DIFFWRITE_REVIEW_PORT||config.port||41732);
  if(typeof data!=='string'||(!env.DIFFWRITE_REVIEW_DATA&&!isAbsolute(data)))throw new Error('本机数据目录必须是绝对路径。');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('本机审稿端口无效。');
  return {data,port};
}
