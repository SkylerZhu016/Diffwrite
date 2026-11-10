import {McpServer, StreamableHTTPServerTransport, z} from './vendor/mcp-sdk.mjs';

import {askOpinion} from './opinion-ai.mjs';
import {StoreError} from './review-store.mjs';

const id=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const offset=z.number().int().min(0).max(1000000).default(0);
const limit=z.number().int().min(1).max(100).default(30);
const readonly={readOnlyHint:true,openWorldHint:false};
const additive={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const write={readOnlyHint:false,destructiveHint:true,openWorldHint:false};

function build(store,recipient){
  const server=new McpServer({name:'diffwrite',version:'2.0.0'},{
    instructions:'本地逐句审稿。你和作者在同一份稿上协作：你写的意见和改写直接进入作者自己用的意见栏、改版栏，只多一个「AI 审稿」标记，作者可以接着改，没有待审、接受或拒绝的环节。流程：read_draft 读句块和当前 revision，再用 edit_draft 逐句写 opinion（意见）或 replacement（改写）。作者已有意见时，你的意见追加在后面，不改作者的原话。作者亲手改写过的句子默认不覆盖：改写建议会转写进意见栏，并在 keptHuman 里返回；只有作者明确要你改那一句时才传 overwriteHumanRevision:true。投递新稿用 publish_draft。作者点「保存并通知 AI」后，用 list_review_notifications 取发给本连接的待办。作者在网页关掉 MCP 模式时，只能读取，不能写入。'
  });
  const add=(name,description,inputSchema,annotations,fn)=>server.registerTool(
    name,{description,inputSchema,annotations},async args=>{
      try {
        if(!annotations.readOnlyHint&&!store.mcpMode())
          throw new StoreError('作者还没有在审稿页面开启 MCP 模式，现在只能读取。请作者在「MCP 连接」里打开 MCP 模式后再试。',409);
        const result=await fn(args);
        return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
      }catch(error){
        const message=error.status?error.message:'审稿后台暂时无法处理请求。';
        return {isError:true,content:[{type:'text',text:message}]};
      }
    });
  add('list_drafts','列出历史稿件及人工/AI 审稿状态。',z.object({offset,limit}),readonly,
    ({offset,limit})=>{const all=store.list();return {drafts:all.slice(offset,offset+limit),next:offset+limit<all.length?offset+limit:null};});
  add('read_draft','按句块读取原文 original、意见栏 opinion、改版栏 revision、是否删除和当前有效文本 effective。opinionBy / revisionBy 说明是作者（human）还是 AI 写的；human+ai 表示作者的意见后面有 AI 追加的一段（aiOpinion）。句块编号从 0 开始。',z.object({draftId:id,offset,limit}),readonly,
    ({draftId,offset,limit})=>store.readSentences(draftId,offset,limit));
  add('publish_draft','把纯文本或 Markdown 作为新稿件投递到浏览器。重试请沿用同一个 requestId。',z.object({
    requestId:id,title:z.string().min(1).max(220),text:z.string().min(1).max(1500000),
    format:z.enum(['plain','markdown','auto']).default('auto')
  }),additive,args=>store.publish(args,recipient));
  add('edit_draft','逐句写入 AI 审稿意见和改写，也可改标题；写入的内容就在作者的意见栏、改版栏里，带「AI 审稿」标记。先 read_draft，传当前 revision 和句块原文 original。opinion：给这句的意见；作者已有意见时追加在后面（以「AI：」开头），再次提交只替换你写的那段，空字符串撤回你写的那段。replacement：改写后的整句；空字符串恢复原句。deleted：true 删除本句，false 恢复。作者亲手改写过的句子（revisionBy 为 human）默认不覆盖：改写建议会写进意见栏，并在 keptHuman 里返回；作者明确要求改这一句时传 overwriteHumanRevision:true，被替换的人工改写会留给作者一键换回。不改原文快照。重试请沿用同一个 requestId。',z.strictObject({
    requestId:id,draftId:id,expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(220).optional(),
    edits:z.array(z.strictObject({sentence:z.number().int().nonnegative(),original:z.string().max(1500000),
      opinion:z.string().max(20000).optional(),replacement:z.string().max(100000).optional(),deleted:z.boolean().optional(),
      overwriteHumanRevision:z.boolean().optional()})).max(100).optional()
  }),{...write,idempotentHint:true},args=>store.editDraft(args,recipient));
  add('list_review_notifications','查看作者明确要求 AI 跟进的待办；不会自动标为已处理。',z.object({limit}),readonly,
    ({limit})=>({notifications:store.listNotices(limit,recipient)}));
  add('read_review_notification','只读取发给本连接的审稿增量：作者在你上次读写之后改动的意见、改写和删除。restored 表示恢复了原句，opinionCleared 表示意见已清空，aiOpinion / aiRevision 表示该栏仍是 AI 写的内容，gapChanges 表示段落空白的删除或恢复；可分页。',z.object({notificationId:id,offset,limit}),readonly,
    ({notificationId,offset,limit})=>store.readNotice(notificationId,offset,limit,recipient));
  add('ack_review_notification','确认已处理指定的通知。仅在完成该项跟进后调用。',z.object({notificationId:id}),additive,
    ({notificationId})=>store.ack(notificationId,recipient));
  add('list_trashed_drafts','读取回收站。',z.object({offset,limit}),readonly,({offset,limit})=>{
    const rows=store.list(true);return {drafts:rows.slice(offset,offset+limit),next:offset+limit<rows.length?offset+limit:null};
  });
  add('set_draft_trashed','把稿件移到回收站或从回收站恢复，不会彻底删除。',z.strictObject({
    draftId:id,expectedRevision:z.number().int().positive(),trashed:z.boolean()
  }),write,({draftId,expectedRevision,trashed})=>store.setTrash(draftId,expectedRevision,trashed));
  add('get_opinion_settings','读取网页自带「AI 补全」的提示词、版本和模型名。MCP 模式开启时网页补全停用，设置仍保留。',z.strictObject({}),readonly,()=>store.automationOpinion(recipient));
  add('update_opinion_settings','修改网页「AI 补全」的提示词或模型名；可用 restoreVersion 恢复旧提示词。不会改变模型地址或密钥。',z.strictObject({
    expectedRevision:id,prompt:z.string().trim().min(1).max(12000).optional(),restoreVersion:id.optional(),model:z.string().trim().min(1).max(160).optional()
  }).refine(a=>!(a.prompt&&a.restoreVersion)),write,args=>store.setAutomationOpinion(recipient,args));
  add('list_opinion_prompt_versions','列出可恢复的补全提示词历史版本。',z.object({offset,limit}),readonly,
    ({offset,limit})=>store.promptVersions(recipient,offset,limit));
  add('list_opinion_feedback','读取本机的网页补全反馈；可按稿件过滤。',z.object({draftId:id.optional(),offset,limit}),readonly,
    ({draftId,offset,limit})=>store.automationFeedback(recipient,draftId,offset,Math.min(limit,20)));
  add('preview_opinion','用网页已配置的补全模型试跑指定句，可临时传入候选提示词；会调用模型，但不写稿、不存意见、不改设置。',z.strictObject({
    draftId:id,sentence:z.number().int().nonnegative(),prefix:z.string().max(2400).optional(),prompt:z.string().trim().min(1).max(12000).optional()
  }),{readOnlyHint:true,openWorldHint:true},async args=>{
    const {config,input}=store.previewOpinion(recipient,args);
    return {suffix:await askOpinion(config,input)};
  });
  return server;
}
export async function handleMcp(req,res,body,store,recipient){
  // No server-initiated traffic or sessions: OMP's optional SSE listener may stop on 405.
  if(req.method==='GET'||req.method==='DELETE'){
    res.writeHead(405,{'Allow':'POST'});res.end();return;
  }
  const server=build(store,recipient);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.once('close',()=>{server.close().catch(()=>{});});
  await server.connect(transport);
  await transport.handleRequest(req,res,body);
}
