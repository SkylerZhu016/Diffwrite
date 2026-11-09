import {reviewApi} from './history.mjs';

export const opinionIdleMs=60_000;
export function setupOpinionUI({current,pathFor,flush,commit,paintMarks,download}){
  const $=id=>document.getElementById(id), box=$('opinion'), toggle=$('opinion-enabled'),
    card=$('opinion-card'), suggest=$('opinion-suggest'), accept=$('opinion-accept'), reject=$('opinion-reject'),
    status=$('opinion-status'), dialog=$('opinion-settings-dialog'), save=$('opinion-settings-save');
  toggle.checked=false;
  let runs=new Map(), draftId=null, editorKey=null, composing=false, timer=0, request=null, committing=false;
  let statusFor=null, refreshGeneration=0, defaultPrompt='', settingsGeneration=0;
  let settingsRevision=null, settingsDirty=false, syncingSettings=false;
  const key=c=>c.id&&c.i!==null?c.id+':'+c.i:null;
  const end=()=>box.selectionStart===box.value.length&&box.selectionEnd===box.value.length;
  const focused=c=>c.i!==null&&document.hasFocus()&&document.activeElement===box;
  const cancel=()=>{clearTimeout(timer);timer=0;};
  const context=c=>JSON.stringify([c.opinion,c.text,c.deleted]);
  function setStatus(c,text,failed=false){
    statusFor={key:key(c),text,failed};
    render();
  }
  function render(){
    const c=current();
    if(draftId!==c.id){
      draftId=c.id;runs=new Map();refreshGeneration++;
    }
    const nextKey=key(c);
    if(nextKey!==editorKey){cancel();composing=false;editorKey=nextKey;}
    const item=c.i===null?null:runs.get(c.i);
    card.hidden=!item;
    if(item){
      $('opinion-card-label').textContent=item.state==='auto'?'已自动计入意见 · 可撤回':'AI 补全 · 按 Tab 接受';
      const preview=$('opinion-preview');
      preview.replaceChildren();
      if(item.prefix){
        const prefix=document.createElement('span');
        prefix.className='opinion-prefix';
        prefix.textContent=item.prefix;preview.append(prefix);
      }
      preview.append(item.suffix);
      accept.disabled=reject.disabled=committing||c.blocked;
    }
    const info=statusFor?.key===nextKey?statusFor:null;
    const working=request&&request.key===nextKey;
    const message=working?'正在生成…':timer?'停笔 1 分钟后补全':info?.text??'';
    status.hidden=!message;
    if(status.textContent!==message)status.textContent=message;
    status.classList.toggle('error',Boolean(!working&&info?.failed));
    suggest.hidden=!toggle.checked||Boolean(item)||Boolean(c.opinion?.trim());
    suggest.disabled=!nextKey||Boolean(request)||c.blocked;
    paintMarks(runs);
  }
  async function refresh(id=current().id){
    if(!id)return;
    const sequence=++refreshGeneration;
    try{
      const result=await reviewApi(pathFor(id,'opinion-runs'));
      const c=current();
      if(c.id!==id||c.dirty||sequence!==refreshGeneration)return;
      runs=new Map(result.map(row=>[row.sentence,row]));
      render();
    }catch{/* Requests and decisions show their own errors. */}
  }
  function edited(i,{human=false}={}){
    const c=current();
    if(c.i===i||human)cancel();
    if(runs.delete(i))refreshGeneration++;
    statusFor=null;
    render();
    if(human)arm();
  }
  function arm(){
    const c=current();
    cancel();
    if(!toggle.checked||!key(c)||c.blocked||composing||!c.opinion.trim()||!end()||runs.has(c.i))return;
    const expected={key:key(c),context:context(c)};
    timer=setTimeout(()=>{
      timer=0;const now=current();
      if(key(now)===expected.key&&context(now)===expected.context&&(!focused(now)||end()))void generate(false);
      else render();
    },opinionIdleMs);
    render();
  }
  async function generate(manual){
    const c=current();
    if(!toggle.checked||!key(c)||c.blocked||request||composing||runs.has(c.i)||(!manual&&!c.opinion.trim()))return;
    cancel();
    const owner={key:key(c),context:context(c)};
    request=owner;statusFor=null;render();
    try{
      if(!await flush())return;
      const now=current();
      if(!toggle.checked||key(now)!==owner.key||now.blocked||context(now)!==owner.context)return;
      const result=await reviewApi(pathFor(c.id,'opinion-generate'),
        {sentence:c.i,prefix:c.opinion,revision:now.revision,manual});
      const after=current(), same=after.id===c.id;
      if(!same)return;
      if(result.run){
        // An unchanged earlier sentence can receive its own result after selection moves elsewhere.
        const fresh=after.sentenceAt(c.i);
        if(!fresh||context(fresh)!==owner.context)return;
        refreshGeneration++;
        runs.set(c.i,result.run);render();
        if(toggle.checked&&!after.blocked&&!composing&&!(after.i===c.i&&focused(after)))await decide(result.run,'auto');
      }else if(result.empty&&key(after)===owner.key){
        setStatus(c,'这句没有需要补的意见。');
      }
    }catch(error){
      if(key(current())===owner.key)setStatus(c,error.message,true);
    }finally{request=null;render();}
  }
  async function decide(item,action){
    const c=current();
    if(!item||!c.id||committing||c.blocked)return;
    committing=true;render();
    try{
      if(!await commit(c.id,item,action))return;
      refreshGeneration++;
      if(action==='auto')runs.set(item.sentence,{...item,state:'auto'});
      else runs.delete(item.sentence);
      if(current().i===item.sentence)statusFor=null;
    }catch(error){
      if(current().i===item.sentence)setStatus(c,error.message,true);
    }finally{committing=false;render();void refresh(c.id);}
  }
  toggle.onchange=()=>{
    cancel();statusFor=null;render();
    if(toggle.checked)void refresh();
  };
  box.addEventListener('compositionstart',()=>{composing=true;cancel();render();});
  box.addEventListener('compositionend',()=>{composing=false;arm();});
  box.addEventListener('keydown',event=>{
    const c=current(), item=runs.get(c.i);
    if(!item||committing||c.blocked||composing||event.isComposing||event.keyCode===229)return;
    if(event.key==='Tab'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&end()){
      event.preventDefault();void decide(item,'accept');
    }else if(event.key==='Escape'){
      event.preventDefault();void decide(item,'reject');
    }
  });
  suggest.onclick=()=>void generate(true);
  accept.onclick=()=>void decide(runs.get(current().i),'accept');
  reject.onclick=()=>void decide(runs.get(current().i),'reject');

  function settingsStatus(text='',failed=false){
    const node=$('opinion-settings-status');
    node.hidden=!text;node.textContent=text;node.classList.toggle('error',failed);
  }
  function fillSettings(value){
    defaultPrompt=value.defaultPrompt;settingsRevision=value.settingsRevision;settingsDirty=false;
    $('opinion-url').value=value.baseUrl;
    $('opinion-model').value=value.model;
    $('opinion-prompt').value=value.prompt;
    $('opinion-key').value='';
    $('opinion-key-state').textContent=value.hasKey?'· 已保存':'';
    $('opinion-clear-key').checked=false;
    $('opinion-clear-key-row').hidden=!value.hasKey;
  }
  function settingsBusy(busy){
    for(const id of ['opinion-url','opinion-model','opinion-key','opinion-clear-key','opinion-prompt',
      'opinion-prompt-reset','opinion-prompt-copy','opinion-feedback-export','opinion-settings-save'])$(id).disabled=busy;
  }
  $('opinion-settings-open').onclick=async()=>{
    const version=++settingsGeneration;
    settingsRevision=null;settingsDirty=false;
    $('opinion-key').value='';
    settingsStatus('正在读取…');settingsBusy(true);dialog.showModal();
    try{
      const result=await reviewApi('opinion-settings');
      if(dialog.open&&version===settingsGeneration){fillSettings(result);settingsStatus();settingsBusy(false);}
    }catch(error){if(dialog.open&&version===settingsGeneration)settingsStatus(error.message,true);}
  };
  dialog.addEventListener('close',()=>{if(!dialog.open){settingsGeneration++;$('opinion-key').value='';}});
  $('opinion-settings-form').onsubmit=async event=>{
    event.preventDefault();
    if(save.disabled)return;
    const version=settingsGeneration;
    const input={baseUrl:$('opinion-url').value,model:$('opinion-model').value,prompt:$('opinion-prompt').value,
      apiKey:$('opinion-key').value,clearKey:$('opinion-clear-key').checked,expectedRevision:settingsRevision};
    settingsBusy(true);
    try{
      const result=await reviewApi('opinion-settings',input);
      if(dialog.open&&version===settingsGeneration){fillSettings(result);settingsStatus('设置已保存。');}
    }catch(error){if(dialog.open&&version===settingsGeneration)settingsStatus(error.message,true);}
    finally{if(dialog.open&&version===settingsGeneration)settingsBusy(false);}
  };
  $('opinion-settings-form').addEventListener('input',()=>{settingsDirty=true;});
  $('opinion-prompt-reset').onclick=()=>{
    settingsDirty=true;
    $('opinion-prompt').value=defaultPrompt;settingsStatus('已恢复默认提示词，保存设置后生效。');
  };
  $('opinion-prompt-copy').onclick=async()=>{
    try{await navigator.clipboard.writeText($('opinion-prompt').value);settingsStatus('已复制提示词。');}
    catch{settingsStatus('无法写入剪贴板，可以选中文字手动复制。',true);}
  };
  $('opinion-feedback-export').onclick=async()=>{
    try{
      const data=await reviewApi('opinion-feedback');
      if(!dialog.open)return;
      if(!data.examples.length){settingsStatus('还没有补全反馈可以导出。');return;}
      download(JSON.stringify(data,null,2),'逐句审稿 · 补全反馈.json','application/json');
      settingsStatus('已导出 '+data.examples.length+' 条。反馈包含稿件片段，分享前请先检查。');
    }catch(error){if(dialog.open)settingsStatus(error.message,true);}
  };
  async function syncSettings(){
    if(!dialog.open||!settingsRevision||syncingSettings||save.disabled)return;
    const generation=settingsGeneration;
    syncingSettings=true;
    try{
      const next=await reviewApi('opinion-settings');
      if(!dialog.open||generation!==settingsGeneration||save.disabled||next.settingsRevision===settingsRevision)return;
      if(settingsDirty){
        settingsStatus('后台已更新补全设置；你正在编辑的内容已保留。关闭再打开可读取最新版。');
      }else{
        const prompt=$('opinion-prompt'), focused=document.activeElement===prompt;
        const selection=[prompt.selectionStart,prompt.selectionEnd,prompt.selectionDirection];
        const scroll=prompt.scrollTop;
        fillSettings(next);
        if(focused)prompt.setSelectionRange(...selection);
        prompt.scrollTop=scroll;
        settingsStatus('已同步后台的补全设置。');
      }
    }catch{}finally{syncingSettings=false;}
  }
  return {render,refresh,edited,syncSettings,has:(id,i)=>draftId===id&&runs.has(i)};
}
