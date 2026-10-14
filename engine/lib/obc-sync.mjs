import fs from 'node:fs';import path from 'node:path';import {DatabaseSync}from'node:sqlite';
import{OBC_MENU_TO_KIND}from'./obc-kinds.mjs';
import{entryText}from'./obc-modules.mjs';
import{indexTokens}from'./tokenize.mjs';
import{atomicJson as atomic}from'./atomic-file.mjs';
export const DEFAULT_RANGES=[[1,9000],[500000,512000]];
function ensureObcSchema(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS obc_entries(id INTEGER PRIMARY KEY,menu_id INTEGER,menu_label TEXT,kind TEXT,name TEXT,license TEXT,module_count INTEGER,text_len INTEGER,updated_at TEXT,raw_json TEXT);
 CREATE VIRTUAL TABLE IF NOT EXISTS obc_fts USING fts5(name,grams,kind UNINDEXED,entry_id UNINDEXED);
 CREATE INDEX IF NOT EXISTS idx_obc_kind ON obc_entries(kind);`);
}
const API='https://api-takumi-static.mihoyo.com/hoyowiki/genshin';
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return d}};
export function mergeDiscovery(previous,rows){const next={...previous};for(const e of rows){const id=Number(e.id||e.entry_page_id);if(!Number.isSafeInteger(id)||id<1)continue;const old=next[id]||{};if(e.status==='Offline'){if(next[id]?.name)next[id]={...old,status:'Offline'};continue}if(!e.name)continue;const menu=Number(e.menus?.[0]?.id||e.menu_id||old.menu_id||0);next[id]={...old,name:e.name,status:'Online',menu_id:menu,menus:e.menus?.length?e.menus:old.menus||[],version:Number(old.version)||0};}return next}
export function newIds(entries,local){return Object.entries(entries).filter(([id,e])=>e.status!=='Offline'&&!local.has(Number(id))).map(([id])=>Number(id))}
export async function fetchPublic(suffix){let error;for(let i=0;i<3;i++){try{const r=await fetch(API+suffix,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.retcode!==0)throw Error('API error '+j.retcode);return j}catch(e){error=e;await new Promise(r=>setTimeout(r,400*(i+1)))}}throw error}
function localFiles(src){const out=new Map();for(const d of fs.readdirSync(src,{withFileTypes:true})){if(!d.isDirectory()||!/^\d+$/.test(d.name))continue;for(const f of fs.readdirSync(path.join(src,d.name)))if(/^\d+\.json$/.test(f))out.set(Number(f.slice(0,-5)),path.join(src,d.name,f));}return out}
export function applyPages(db,pages,offline){
 const up=db.prepare(`INSERT INTO obc_entries(id,menu_id,menu_label,kind,name,license,module_count,text_len,updated_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET menu_id=excluded.menu_id,menu_label=excluded.menu_label,kind=excluded.kind,name=excluded.name,module_count=excluded.module_count,text_len=excluded.text_len,updated_at=excluded.updated_at,raw_json=excluded.raw_json`),del=db.prepare('DELETE FROM obc_fts WHERE entry_id=?'),ins=db.prepare('INSERT INTO obc_fts(name,grams,kind,entry_id) VALUES(?,?,?,?)');
 db.exec('BEGIN IMMEDIATE');try{for(const{id,page}of pages){const menu=Number(page.menus?.[0]?.id||page.menu_id||0),kind=OBC_MENU_TO_KIND[menu]||`menu${menu}`,text=entryText(page),v=Number(page.version)||0;up.run(id,menu,page.menus?.[0]?.name||page.menu_name||'',kind,page.name||'','数据来源：米游社观测枢',(page.modules||[]).length,text.length,v?new Date(v*1000).toISOString():'',JSON.stringify(page));del.run(id);ins.run(page.name||'',indexTokens((page.name||'')+'\n'+text),kind,id)}for(const id of offline){del.run(id);db.prepare('DELETE FROM obc_entries WHERE id=?').run(id);for(const table of ['obc_recommend','obc_refs'])try{db.prepare(`DELETE FROM ${table} WHERE src_id=?`).run(id)}catch{}}db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
}
export async function syncObc({src=process.env.OBC_SRC || path.join(process.env.AKASHA_ROOT || process.cwd(), 'data-src', 'hoyowiki'),dbPath=path.join(process.env.KB_DATA_DIR || 'data', 'kb-workspace.sqlite'),mode='daily',ranges=DEFAULT_RANGES,fetchJson=fetchPublic,log=console.log,importChanged=true,afterImport=async()=>{}}={}){
 fs.mkdirSync(src,{recursive:true});const lock=path.join(src,'.sync.lock');let handle;
 try{handle=fs.openSync(lock,'wx')}catch(e){if(e.code!=='EEXIST')throw e;const old=read(lock,{});let live=true;if(Number.isSafeInteger(old.pid)&&old.pid>0){try{process.kill(old.pid,0)}catch{live=false}}else live=Date.now()-fs.statSync(lock).mtimeMs<600000;if(live){log('SYNC skipped: another sync is running');return{skipped:true}}fs.rmSync(lock,{force:true});handle=fs.openSync(lock,'wx')}
 fs.writeFileSync(handle,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));fs.closeSync(handle);
 const indexFile=path.join(src,'_index.json'),stateFile=path.join(src,`.sync-state-${mode}.json`),reportFile=path.join(src,'_last-sync.json');
 const report={mode,startedAt:new Date().toISOString(),ranges,added:0,changed:0,offline:0,failures:0,discovered:0,fetched:0,processed:0,errors:[]};let db;
 try{
  const local=localFiles(src),idx=read(indexFile,{entries:{}});idx.entries||={};
  if(importChanged){fs.mkdirSync(path.dirname(dbPath),{recursive:true});db=new DatabaseSync(dbPath);db.exec('PRAGMA busy_timeout=10000');ensureObcSchema(db);for(const r of db.prepare('SELECT id,name,menu_id,kind,updated_at FROM obc_entries').all())if(!idx.entries[r.id])idx.entries[r.id]={name:r.name,menu_id:r.menu_id,kind:r.kind,status:'Online',version:r.updated_at?Math.floor(Date.parse(r.updated_at)/1000):0}}
  for (const [id,e] of Object.entries(idx.entries)) if (!e.name && e.status==='Offline') delete idx.entries[id];
  const existingIds=new Set(db ? db.prepare('SELECT id FROM obc_entries').all().map(r=>Number(r.id)) : local.keys());
  report.batchesAttempted=0;report.idsAttempted=0;report.knownIdsIncluded=Object.keys(idx.entries).length;
  const initial=new Set(Object.keys(idx.entries)),signature=JSON.stringify({mode,ranges});let state=read(stateFile,null);
  if(!state||state.complete||state.signature!==signature)state={signature,complete:false,pendingDiscovery:[],pendingDetails:null};
  if(['daily','full','discover'].includes(mode)){
   if(!state.pendingDiscovery.length&&!state.discoveryComplete){const ids=new Set(Object.keys(idx.entries).map(Number));for(const[a,b]of ranges){if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<1||b<a||b-a>200000)throw Error('Invalid scan range');for(let id=a;id<=b;id++)ids.add(id)}const sorted=[...ids].sort((a,b)=>a-b);for(let i=0;i<sorted.length;i+=50)state.pendingDiscovery.push(sorted.slice(i,i+50))}
   const pending=[...state.pendingDiscovery],failed=[];let done=0;
   await Promise.all(Array.from({length:6},async()=>{while(pending.length){const batch=pending.shift();report.batchesAttempted++;report.idsAttempted+=batch.length;try{const j=await fetchJson('/wapi/entry_pages?str_entry_page_ids='+batch.join(','));if(!Array.isArray(j?.data?.entry_pages))throw Error('Invalid batch response');idx.entries=mergeDiscovery(idx.entries,j.data.entry_pages);report.discovered+=j.data.entry_pages.filter(e=>e.name&&e.status!=='Offline').length;idx.at=new Date().toISOString();atomic(indexFile,idx);state.pendingDiscovery=state.pendingDiscovery.filter(b=>b!==batch);atomic(stateFile,state)}catch(e){failed.push(batch);report.failures++;if(report.errors.length<10)report.errors.push('discovery: '+e.message)}done++;if(done%50===0)log(`SYNC discovery ${done} batches; failures=${report.failures}`)}}));state.pendingDiscovery=failed;state.discoveryComplete=failed.length===0;atomic(stateFile,state);
  }
  const offlineIds=Object.entries(idx.entries).filter(([,e])=>e.status==='Offline').map(([id])=>Number(id));report.offline=offlineIds.filter(id=>existingIds.has(id)||local.has(id)).length;
  if(!['discover','report'].includes(mode)){
   const ids=state.pendingDetails || (['full','fetch-all'].includes(mode)?[...new Set([...local.keys(),...Object.keys(idx.entries).map(Number)])].filter(id=>idx.entries[id]?.status!=='Offline'):newIds(idx.entries,local));state.pendingDetails=[...ids];atomic(stateFile,state);const queue=[...ids],failed=[];
   await Promise.all(Array.from({length:6},async()=>{while(queue.length){const id=queue.shift();try{const j=await fetchJson('/wapi/entry_page?entry_page_id='+id),page=j?.data?.page;if(!page?.name||!Array.isArray(page.modules))throw Error('Invalid detail response');if(page.status==='Offline'){idx.entries[id]={...idx.entries[id],status:'Offline'};if(!offlineIds.includes(id))offlineIds.push(id)}else{
    const menu=Number(page.menus?.[0]?.id||page.menu_id||idx.entries[id]?.menu_id||0),old=local.get(id)?read(local.get(id),null)?.page:null;
    if(!old||JSON.stringify(old)!==JSON.stringify(page)){state.pendingImport=[...new Set([...(state.pendingImport||[]),id])];atomic(stateFile,state);const dir=path.join(src,String(menu));fs.mkdirSync(dir,{recursive:true});atomic(path.join(dir,id+'.json'),{menu_id:menu,menu_label:page.menus?.[0]?.name||'',listed_name:page.name,page});if(!old)report.added++;else report.changed++}
    idx.entries[id]={...idx.entries[id],name:page.name,menu_id:menu,status:'Online',version:Number(page.version)||0,fetched_at:new Date().toISOString()};report.fetched++;
   }idx.at=new Date().toISOString();atomic(indexFile,idx);state.pendingImport=[...new Set([...(state.pendingImport||[]),id])];state.pendingDetails=state.pendingDetails.filter(n=>n!==id);atomic(stateFile,state)}catch(e){failed.push(id);report.failures++;if(report.errors.length<10)report.errors.push('detail '+id+': '+e.message)}report.processed++;if(report.processed%100===0)log(`SYNC detail ${report.processed}/${ids.length}; changes=${report.changed}; failures=${report.failures}`)}}));state.pendingDetails=failed;report.offline=offlineIds.length;
   const recovered=[];if(db)for(const id of [...new Set([...ids,...(state.pendingImport||[])])]){if(failed.includes(id))continue;const file=path.join(src,String(idx.entries[id]?.menu_id||0),id+'.json'),page=read(file,null)?.page;if(!page||idx.entries[id]?.status==='Offline')continue;const old=db.prepare('SELECT raw_json FROM obc_entries WHERE id=?').get(id);if(!old||old.raw_json!==JSON.stringify(page))recovered.push({id,page})}
   if(db&&(recovered.length||offlineIds.length||state.associationsPending)){state.associationsPending=true;atomic(stateFile,state);applyPages(db,recovered,offlineIds);await afterImport(recovered.map(p=>p.id));atomic(path.join(path.dirname(dbPath),'obc-sync-revision.json'),{at:Date.now(),changed:recovered.length,offline:offlineIds.length});state.associationsPending=false;state.pendingImport=[];atomic(stateFile,state)}
   for(const id of offlineIds){const file=local.get(id);if(file&&fs.existsSync(file)){const archive=path.join(src,'_offline',path.basename(path.dirname(file)));fs.mkdirSync(archive,{recursive:true});const dest=path.join(archive,path.basename(file));if(!fs.existsSync(dest))fs.renameSync(file,dest)}}
  }
  if(mode==='report')report.missing=newIds(idx.entries,local).length;report.newlyDiscovered=Object.keys(idx.entries).filter(id=>!initial.has(id)).length;
  state.complete=report.failures===0;atomic(stateFile,state);idx.at=new Date().toISOString();atomic(indexFile,idx);report.finishedAt=new Date().toISOString();atomic(reportFile,report);log('SYNC '+JSON.stringify(report));return report;
 }finally{db?.close();fs.rmSync(lock,{force:true})}
}
