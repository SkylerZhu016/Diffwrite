import {readFileSync} from 'node:fs';

export const defaultOpinionPrompt=readFileSync(new URL('./opinion-prompt.txt',import.meta.url),'utf8').trim();
export class OpinionError extends Error{
  constructor(message,status=400){super(message);this.status=status;}
}
export function normalizeOpinionSettings(raw){
  const {baseUrl='',model='',prompt='',apiKey='',clearKey=false}=raw??{};
  if([baseUrl,model,prompt,apiKey].some(s=>typeof s!=='string')||baseUrl.length>500||model.length>160||prompt.length>12000||apiKey.length>4096||!/^[\x21-\x7E]*$/.test(apiKey.trim()))
    throw new OpinionError('请检查模型名称、服务地址、提示词和密钥。');
  let base=baseUrl.trim().replace(/\/+$/u,'');
  if(base){
    let url;
    try{url=new URL(base);}catch{throw new OpinionError('请输入完整的模型服务地址，例如 http://127.0.0.1:1234/v1。');}
    const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash)
      throw new OpinionError('模型服务请使用 HTTPS；本机服务也可以用 HTTP。');
    base=url.href.replace(/\/+$/u,'').replace(/\/chat\/completions$/u,'');
  }
  if(Boolean(base)!==Boolean(model.trim()))throw new OpinionError('请同时填写模型服务地址和模型名称。');
  return {baseUrl:base,model:model.trim(),prompt:prompt.trim()||defaultOpinionPrompt,apiKey:apiKey.trim(),clearKey:clearKey===true};
}
export async function askOpinion(config,input){
  let response;
  try{
    response=await fetch(config.baseUrl+'/chat/completions',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),
      headers:{'Content-Type':'application/json',...(config.apiKey?{Authorization:'Bearer '+config.apiKey}:{})},
      body:JSON.stringify({model:config.model,max_tokens:220,messages:[
        {role:'system',content:config.prompt},{role:'user',content:JSON.stringify(input)}
      ]})
    });
  }catch{throw new OpinionError('无法连接模型服务或请求超时。',502);}
  if(!response.ok){
    await response.body?.cancel().catch(()=>{});
    const message=response.status===401||response.status===403?'模型服务拒绝了密钥，请检查设置。':
      response.status===429?'模型服务限流，请稍后再试。':'模型服务返回错误（'+response.status+'），请检查地址和模型。';
    throw new OpinionError(message,502);
  }
  try{
    const content=(await response.json()).choices?.[0]?.message?.content;
    if(typeof content!=='string'||content.length>3500)throw new Error();
    const result=JSON.parse(content.trim().replace(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/iu,'$1'));
    if(typeof result?.suffix!=='string'||result.suffix.length>600)throw new Error();
    const suffix=result.suffix.trimEnd();
    if(!suffix.trim()||(input.prefix.trim()&&suffix.trimStart().startsWith(input.prefix.trim())))return '';
    return suffix;
  }catch{throw new OpinionError('模型没有返回可用的补全文字。请检查模型或提示词。',502);}
}
