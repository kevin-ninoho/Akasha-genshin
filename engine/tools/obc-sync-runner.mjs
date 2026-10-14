import{syncObc}from'../lib/obc-sync.mjs';import{spawn}from'node:child_process';import path from 'node:path';import{fileURLToPath}from'node:url';
const args=process.argv.slice(2),has=f=>args.includes(f),value=f=>args[args.indexOf(f)+1];
const mode=has('--report')?'report':has('--discover')?'discover':has('--fetch')?(has('--all')?'fetch-all':'fetch-new'):has('--full')?'full':'daily';
const suite=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function script(name,env){await new Promise((resolve,reject)=>{const c=spawn(process.execPath,[path.join(suite,'tools',name)],{cwd:suite,env:{...process.env,...env},windowsHide:true,stdio:['ignore','ignore','pipe']});let err='';c.stderr.on('data',d=>{err+=d;if(err.length>2000)err=err.slice(-2000)});c.on('exit',code=>code===0?resolve():reject(Error(name+' failed: '+err)))})}
const dbPath=process.env.OBC_DB||path.join(process.env.KB_DATA_DIR || 'data', 'kb-workspace.sqlite');
const options={mode,src:process.env.OBC_SRC||(process.env.OBC_SRC || path.join(process.env.AKASHA_ROOT || process.cwd(), 'data-src', 'hoyowiki')),dbPath,afterImport:async()=>{await script('obc-recommend.mjs',{OBC_DB:dbPath});await script('obc-refs.mjs',{OBC_DB:dbPath})}};
if(has('--ranges'))options.ranges=value('--ranges').split(',').map(s=>s.split(':').map(Number));
try{const r=await syncObc(options);if(r.failures)process.exitCode=1}catch(e){console.error('SYNC failed: '+e.message);process.exitCode=1}
