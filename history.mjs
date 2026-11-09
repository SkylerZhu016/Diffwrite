const databaseName = 'diffwrite.sentence-review.history';
const drafts = 'drafts';
const entries = 'entries';
let connection;

function database() {
  if (connection) return connection;
  connection = new Promise((resolve,reject) => {
    const request = indexedDB.open(databaseName,1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(drafts,{keyPath:'id'});
      request.result.createObjectStore(entries,{keyPath:'id'});
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {db.close(); connection = null;};
      db.onclose = () => {connection = null;};
      resolve(db);
    };
  }).catch(error => {connection = null; throw error;});
  return connection;
}
function result(request) {
  return new Promise((resolve,reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction(stores,mode,run) {
  const db = await database();
  const tx = db.transaction(stores,mode);
  const complete = new Promise((resolve,reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error('审稿记录未保存。'));
  });
  try {
    const [value] = await Promise.all([run(tx),complete]);
    return value;
  } catch (error) {
    try {tx.abort();} catch {}
    throw error;
  }
}
export class HistoryConflict extends Error {}
function readLocalRecord(id) {
  return transaction([entries,drafts],'readonly',async tx => {
    const [meta,value] = await Promise.all([
      result(tx.objectStore(entries).get(id)),result(tx.objectStore(drafts).get(id))
    ]);
    return meta && value ? {meta,draft:value.draft} : null;
  });
}
async function listLocalRecords() {
  const list = await transaction(entries,'readonly',tx => result(tx.objectStore(entries).getAll()));
  return list.sort((a,b) => b.updatedAt-a.updatedAt || b.createdAt-a.createdAt || b.id.localeCompare(a.id));
}
export function recoverLegacy(meta,draft) {
  return transaction([entries,drafts],'readwrite',async tx => {
    const catalog = tx.objectStore(entries);
    if (await result(catalog.get(meta.id))) return;
    catalog.add({...meta,revision:1});
    tx.objectStore(drafts).add({id:meta.id,draft});
  });
}

export async function reviewApi(path,body) {
  const headers={'X-Diffwrite':'1'};
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers,
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  let value;
  try{value=await response.json();}
  catch{throw new Error('请关闭旧的启动窗口，重新启动审稿工具。');}
  if(!response.ok){
    if(response.status===409)throw new HistoryConflict(value.error);
    throw Object.assign(new Error(value.error ?? '审稿后台无法完成操作。'),{status:response.status});
  }
  return value;
}
export const saveRecord=(meta,draft)=>reviewApi('drafts',{meta,draft,returnDraft:true});
export const readRecord=id=>reviewApi('drafts/'+encodeURIComponent(id));
export const listRecords=()=>reviewApi('drafts');
export const listDeletedRecords=()=>reviewApi('trash');
export async function forgetPurged(ids) {
  if(!ids.length)return;
  if(ids.includes('legacy-v1'))localStorage.removeItem('diffwrite.sentence-review.v1');
  await transaction([entries,drafts],'readwrite',tx=>{
    for(const id of ids){tx.objectStore(entries).delete(id);tx.objectStore(drafts).delete(id);}
  });
}
export async function migrateHistory() {
  const [live,trash,purged]=await Promise.all([listRecords(),listDeletedRecords(),reviewApi('trash/purged')]);
  await forgetPurged(purged);
  const known=new Set([...live.map(x=>x.id),...trash.map(x=>x.id),...purged]);
  const local=await listLocalRecords();
  for(const entry of local){
    if(known.has(entry.id))continue;
    const value=await readLocalRecord(entry.id);
    if(value)await reviewApi('migrate',value);
  }
}
