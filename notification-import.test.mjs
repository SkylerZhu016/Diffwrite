import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from './review-store.mjs';
import {createDraft,applyImportedEdits,parseAnnotated,revisedText,original} from './model.mjs';
import {editorLayout,spliceEditorText} from './editor-text.mjs';

function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'diffwrite-import-notice-'));let store=openStore(dir);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,get s(){return store},reopen(){store.close();store=openStore(dir);}};
}
const fromText=text=>{const edits=parseAnnotated(text);return applyImportedEdits(createDraft('合成稿',edits.source),edits);};
const publish=s=>s.publish({requestId:'draft',title:'合成稿',text:'甲句。\n\n乙句。\n\n丙句。'});
const notify=(s,id,ai)=>s.notify(id,s.read(id).meta.revision,ai);
const paste=(s,id,text,start=0,end=start)=>s.pasteReview(id,{revision:s.read(id).meta.revision,text,start,end});
const undo=(s,id,p,action='undo')=>s.pasteReview(id,{revision:s.read(id).meta.revision,token:p.token,action});
const change=(s,id,fn)=>{const r=s.read(id);fn(r.draft);return s.saveBrowser(r.meta,r.draft,true);};
const old='旧甲。 <意见：旧意见> <改为：旧改稿。>\n<del>旧乙。</del>\n<del>\n</del>旧丙。 <意见：另一条旧意见>';

test('file, clipboard and backup imports start with zero, including for later connections and after reopening',t=>{
 const env=setup(t);let s=env.s;const ai=s.createConnection('先连接');
 const text=Array.from({length:330},(_,i)=>`旧句${i}。 <意见：旧意见${i}>`).join('\n')+'\n'+old;
 for(const kind of ['import','paste','backup']){
  s.saveBrowser({id:kind,revision:0,kind},fromText(text));
  assert.equal(notify(s,kind,ai).changeCount,0);
 }
 env.reopen();s=env.s;const later=s.createConnection('后连接');
 for(const kind of ['import','paste','backup']){
  assert.equal(notify(s,kind,later).queued,false);
  change(s,kind,d=>d.notes[0].opinion='导入后新意见');
  for(const who of [ai,later]){
   const n=notify(s,kind,who);assert.equal(n.changeCount,1);
   assert.equal(s.readNotice(n.id,0,100,who).changes[0].opinion,'导入后新意见');
   assert.equal(notify(s,kind,who).changeCount,0);
  }
 }
});
test('annotated paste preserves prior unsent comments, rewrites and deleted whitespace per recipient',t=>{
 const {s}=setup(t),a=s.createConnection('A'),b=s.createConnection('B'),{id}=publish(s);
 change(s,id,d=>{d.notes[0]={opinion:'待发意见',revision:''};d.notes[2]={opinion:'',revision:'待发改写。'};d.omittedGaps=[[4,5]];});
 assert.equal(notify(s,id,a).changeCount,3);
 change(s,id,d=>{d.notes[0].opinion='新的待发意见';});
 paste(s,id,old,5);
 const late=s.createConnection('粘贴后连接');
 for(const [ai,count] of [[a,1],[b,3],[late,3]]){
  const n=notify(s,id,ai);assert.equal(n.changeCount,count);
  const details=s.readNotice(n.id,0,100,ai);
  assert.equal(details.structureChanged,undefined);
  assert.ok(details.changes.every(x=>!x.original.includes('旧')));
  assert.ok(details.changes.some(x=>x.opinion==='新的待发意见'));
  assert.equal(notify(s,id,ai).queued,false);
 }
});
test('replacement import is silent but cannot acknowledge an older pending opinion on that sentence',t=>{
 for(const pending of [false,true]){
  const {s}=setup(t),ai=s.createConnection('A'),{id}=publish(s);
  if(pending)change(s,id,d=>d.notes[0]={opinion:'尚未通知',revision:''});
  paste(s,id,old,0,3);
  const n=notify(s,id,ai);assert.equal(n.changeCount,pending?1:0);
  if(pending)assert.equal(s.readNotice(n.id,0,100,ai).changes[0].opinion,'尚未通知');
 }
});
test('undo and redo import do not requeue old annotations or revive already notified edits',t=>{
 const {s}=setup(t),a=s.createConnection('A'),b=s.createConnection('B'),{id}=publish(s);
 change(s,id,d=>d.notes[2]={opinion:'真正的新意见',revision:''});
 const p=paste(s,id,old,0,3);
 assert.equal(notify(s,id,a).changeCount,1);
 undo(s,id,p);assert.equal(notify(s,id,a).queued,false);
 undo(s,id,p,'redo');assert.equal(notify(s,id,a).queued,false);
 assert.equal(notify(s,id,b).changeCount,1);
 const c=s.createConnection('后来连接');assert.equal(notify(s,id,c).changeCount,1);
 undo(s,id,p);assert.equal(notify(s,id,c).queued,false);
 undo(s,id,p,'redo');assert.equal(notify(s,id,c).queued,false);
});
test('editing imported notes and ordinary text paste still notify; old wait-list is untouched',t=>{
 const {s}=setup(t),ai=s.createConnection('A'),{id}=publish(s);
 change(s,id,d=>d.notes[2]={opinion:'待办',revision:''});const first=notify(s,id,ai);
 paste(s,id,old,0);
 assert.equal(notify(s,id,ai).queued,false);
 change(s,id,d=>{const i=d.spans.findIndex((_,i)=>original(d,i)==='旧甲。');d.notes[i].opinion='新改意见';});
 const second=notify(s,id,ai);assert.equal(second.changeCount,1);
 assert.deepEqual(s.listNotices(100,ai).map(n=>n.id),[first.id,second.id]);
 change(s,id,d=>{const layout=editorLayout(d),{updates,gaps}=spliceEditorText(d,layout,layout.text.length,layout.text.length,'普通新文字');for(const [i,n]of updates)d.notes[i]=n;d.omittedGaps=gaps;});
 assert.equal(notify(s,id,ai).changeCount,1);
});
test('ordinary paragraph insertion stays pending across a later import',t=>{
 const {s}=setup(t),ai=s.createConnection('A'),{id}=publish(s);
 change(s,id,d=>d.notes[0]={opinion:'',revision:'甲句。\n'});
 s.paragraphBreak(id,{revision:s.read(id).meta.revision,sentence:0,requestId:'break'});
 paste(s,id,old,revisedText(s.read(id).draft).length);
 assert.equal(notify(s,id,ai).structureChanged,true);
});
test('pending opinion removal, restoration and deletion survive a subsequent import',t=>{
 const {s}=setup(t),ai=s.createConnection('A'),{id}=publish(s);
 change(s,id,d=>{d.notes[0]={opinion:'之前意见',revision:''};d.notes[1]={opinion:'',revision:'之前改写。'};});
 notify(s,id,ai);
 change(s,id,d=>{d.notes[0].opinion='';d.notes[1].revision='';d.notes[2]={opinion:'',revision:'',deleted:true};});
 paste(s,id,old,0);
 const n=notify(s,id,ai),changes=s.readNotice(n.id,0,100,ai).changes;
 assert.equal(n.changeCount,3);assert.ok(changes.some(c=>c.opinionCleared));
 assert.ok(changes.some(c=>c.restored));assert.ok(changes.some(c=>c.deleted));
});
test('empty paragraph and literal whitespace backup has no spurious initial notification',t=>{
 const {s}=setup(t),ai=s.createConnection('A');
 const d=createDraft('空段备份','原句。\n\n');d.spans.push([5,5]);d.insertedSlots=[1];d.insertions=[[3,5]];
 d.notes[1]={opinion:'空段意见',revision:'\n',literalWhitespace:true};
 s.saveBrowser({id:'whitespace-backup',revision:0,kind:'backup'},d);
 assert.equal(notify(s,'whitespace-backup',ai).changeCount,0);
});
test('older recipient baselines also suppress whitespace carried in an annotated paste',t=>{
 const {s,dir}=setup(t),ai=s.createConnection('A'),{id}=publish(s);
 change(s,id,d=>d.notes[0]={opinion:'已经通知的意见',revision:''});notify(s,id,ai);
 const db=new DatabaseSync(join(dir,'review.sqlite'));
 db.prepare("UPDATE review_baselines SET snapshot=json_remove(snapshot,'$.effective') WHERE recipient=?").run(ai);db.close();
 paste(s,id,'旧句。\n\n<!--diffwrite:slot--> <改为：\n>',0);
 assert.equal(notify(s,id,ai).changeCount,0);
});
