import {McpServer, StreamableHTTPServerTransport, z} from './vendor/mcp-sdk.mjs';

import {askOpinion} from './opinion-ai.mjs';

const id=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const offset=z.number().int().min(0).max(1000000).default(0);
const limit=z.number().int().min(1).max(100).default(30);
const readonly={readOnlyHint:true,openWorldHint:false};
const additive={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};

function build(store,recipient){
  const server=new McpServer({name:'diffwrite',version:'1.0.0'},{
    instructions:'本地逐句审稿。投递新稿用 publish_draft；审已有稿先 read_draft，再用原文和 revision 提交建议。建议不会覆盖人工稿。获授权的连接可以直接编辑稿件和补全提示词。作者点「保存并通知 AI」后可用 list_review_notifications 获取发给本连接的待处理通知。'
  });
  const add=(name,description,inputSchema,annotations,fn)=>server.registerTool(
    name,{description,inputSchema,annotations},async args=>{
      try {
        const result=await fn(args);
        return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
      }catch(error){
        const message=error.status?error.message:'审稿后台暂时无法处理请求。';
        return {isError:true,content:[{type:'text',text:message}]};
      }
    });
  add('list_drafts','列出历史稿件及人工/AI 审稿状态。',z.object({offset,limit}),readonly,
    ({offset,limit})=>{const all=store.list();return {drafts:all.slice(offset,offset+limit),next:offset+limit<all.length?offset+limit:null};});
  add('read_draft','按句块读取原文、人工意见、改写、删除和当前修改版。句块编号从 0 开始。',z.object({draftId:id,offset,limit}),readonly,
    ({draftId,offset,limit})=>store.readSentences(draftId,offset,limit));
  add('publish_draft','把纯文本或 Markdown 作为新稿件投递到浏览器。重试请沿用同一个 requestId。',z.object({
    requestId:id,title:z.string().min(1).max(220),text:z.string().min(1).max(1500000),
    format:z.enum(['plain','markdown','auto']).default('auto')
  }),additive,args=>store.publish(args,recipient));
  add('submit_review','按当前稿件版本提交独立的逐句建议。original 必须是 read_draft 返回的完整原句；不会直接改人工稿。',z.object({
    requestId:id,draftId:id,expectedRevision:z.number().int().positive(),suggestions:z.array(z.object({
      sentence:z.number().int().nonnegative(),original:z.string().max(1500000),opinion:z.string().max(20000).optional(),
      replacement:z.string().max(100000).optional(),remove:z.boolean().optional()
    })).min(1).max(100)
  }),additive,args=>store.review(args,recipient));
  add('list_review_notifications','查看作者明确要求 AI 跟进的待办；不会自动标为已处理。',z.object({limit}),readonly,
    ({limit})=>({notifications:store.listNotices(limit,recipient)}));
  add('read_review_notification','只读取发给本连接的审稿增量；restored 表示恢复原句，opinionCleared 表示已撤回意见，gapChanges 表示段落空白的删除或恢复；可分页。',z.object({notificationId:id,offset,limit}),readonly,
    ({notificationId,offset,limit})=>store.readNotice(notificationId,offset,limit,recipient));
  add('ack_review_notification','确认已处理指定的通知。仅在完成该项跟进后调用。',z.object({notificationId:id}),additive,
    ({notificationId})=>store.ack(notificationId,recipient));
  if(store.canAutomate(recipient)){
    const write={readOnlyHint:false,destructiveHint:true,openWorldHint:false};
    add('edit_draft','直接修改稿件标题、逐句意见、改版、删除或恢复；不改原文快照。先 read_draft，并传当前 revision 与原句。空 opinion 清意见，空 replacement 清改版。',z.strictObject({
      requestId:id,draftId:id,expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(220).optional(),
      edits:z.array(z.strictObject({sentence:z.number().int().nonnegative(),original:z.string().max(1500000),
        opinion:z.string().max(20000).optional(),replacement:z.string().max(100000).optional(),deleted:z.boolean().optional()})).max(100).optional()
    }),{...write,idempotentHint:true},args=>store.editDraft(args,recipient));
    add('list_trashed_drafts','读取回收站。',z.object({offset,limit}),readonly,({offset,limit})=>{
      if(!store.canAutomate(recipient))return {drafts:[],next:null};
      const rows=store.list(true);return {drafts:rows.slice(offset,offset+limit),next:offset+limit<rows.length?offset+limit:null};
    });
    add('set_draft_trashed','把稿件移到回收站或从回收站恢复，不会彻底删除。',z.strictObject({
      draftId:id,expectedRevision:z.number().int().positive(),trashed:z.boolean()
    }),write,({draftId,expectedRevision,trashed})=>{
      if(!store.canAutomate(recipient))return {applied:false};
      return store.setTrash(draftId,expectedRevision,trashed);
    });
    add('get_opinion_settings','读取正在生效的补全提示词、版本和模型名。',z.strictObject({}),readonly,()=>store.automationOpinion(recipient));
    add('update_opinion_settings','立即应用提示词或模型名；可用 restoreVersion 恢复旧提示词。不会改变模型地址或密钥。',z.strictObject({
      expectedRevision:id,prompt:z.string().trim().min(1).max(12000).optional(),restoreVersion:id.optional(),model:z.string().trim().min(1).max(160).optional()
    }).refine(a=>!(a.prompt&&a.restoreVersion)),write,args=>store.setAutomationOpinion(recipient,args));
    add('list_opinion_prompt_versions','列出可恢复的提示词历史版本。',z.object({offset,limit}),readonly,
      ({offset,limit})=>store.promptVersions(recipient,offset,limit));
    add('list_opinion_feedback','读取本机的补全反馈；可按稿件过滤。',z.object({draftId:id.optional(),offset,limit}),readonly,
      ({draftId,offset,limit})=>store.automationFeedback(recipient,draftId,offset,Math.min(limit,20)));
    add('preview_opinion','用已配置的模型试跑指定句，可临时传入候选提示词；会调用模型，但不写稿、不存意见、不改设置。',z.strictObject({
      draftId:id,sentence:z.number().int().nonnegative(),prefix:z.string().max(2400).optional(),prompt:z.string().trim().min(1).max(12000).optional()
    }),{readOnlyHint:true,openWorldHint:true},async args=>{
      const {config,input}=store.previewOpinion(recipient,args);
      return {suffix:await askOpinion(config,input)};
    });
  }
  return server;
}
export async function handleMcp(req,res,body,store,recipient){
  const server=build(store,recipient);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.once('close',()=>{server.close().catch(()=>{});});
  await server.connect(transport);
  await transport.handleRequest(req,res,body);
}
