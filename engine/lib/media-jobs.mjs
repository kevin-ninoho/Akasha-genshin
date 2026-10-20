import { AsyncLocalStorage } from 'node:async_hooks';
const jobContext = new AsyncLocalStorage();
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {Readable} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {atomicJson as atomic} from './atomic-file.mjs';

export function videoSources(page) {
  const urls=new Set();
  function walk(v){
    if(typeof v==='string'){
      for(const m of v.matchAll(/(?:data-video-url|src)\s*=\s*["']([^"']+)["']/gi)){
        const u=m[1].replaceAll('&amp;','&');if(/^https?:\/\//.test(u)&&/\.mp4(?:[?#]|$)/i.test(u))urls.add(u);
      }
      if(v.trim().startsWith('{')||v.trim().startsWith('['))try{walk(JSON.parse(v))}catch{}
    }else if(v&&typeof v==='object')for(const x of Object.values(v))walk(x);
  }walk(page);return [...urls];
}
// Turn local OBC rows into a bounded, body-free catalogue. Source URLs are
// inspected only to count indexed video records and are never returned.
export function videoCatalog(rows) {
  const items=[];
  for(const row of rows||[]){
    let page;try{page=JSON.parse(row.raw_json)}catch{continue}
    videoSources(page).forEach((_,videoIndex)=>items.push({entryId:Number(row.id),videoIndex,title:String(row.name||'视频资料'),kind:String(row.kind||''),source:'米游社观测枢',availability:'metadata-only'}));
  }
  return items.slice(0,100);
}
const digest=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,24);
export function sceneBoundaries(cuts,duration){
 const internal=[...new Set(cuts)].filter(t=>t>0&&t<duration).sort((a,b)=>a-b);
 const step=Math.max(1,Math.ceil(internal.length/249));
 return [0,...internal.filter((_,i)=>i%step===0),duration];
}
function tool(exe,args,timeout=600000){return new Promise((resolve,reject)=>{
  const signal=jobContext.getStore();signal?.throwIfAborted();
  const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],signal});let stdout='',stderr='';
  child.stdout.on('data',d=>{stdout+=d;if(stdout.length>4e6)stdout=stdout.slice(-4e6)});child.stderr.on('data',d=>{stderr+=d;if(stderr.length>4e6)stderr=stderr.slice(-4e6)});
  const timer=setTimeout(()=>child.kill(),timeout);child.on('error',e=>{clearTimeout(timer);reject(Object.assign(new Error('未找到视频处理依赖，请安装 ffmpeg/ffprobe 或设置 FFMPEG_PATH/FFPROBE_PATH。'), { userMessage: true }))});child.on('exit',code=>{clearTimeout(timer);if(code!==0)reject(Object.assign(new Error('视频处理失败，请重试。'),{diagnostics:stderr,exitCode:code}));else resolve({stdout,stderr})});
 });}
async function localAcquire(file,target) {
  if(!path.isAbsolute(file)||file.startsWith('\\\\')||/^[a-z]+:\/\//i.test(file))throw Error('请通过本地文件选择器添加素材');
  if(!/\.(mp4|mov|mkv|webm)$/i.test(file)||!fs.statSync(file).isFile())throw Error('本地视频不存在');
  await fs.promises.copyFile(file,target);
}
// 远程视频抓取：观测枢给的是米哈游 CDN 的直链。
//
// 这条路径和上面的 localAcquire 是**并存**的，不是二选一：
//   · 本机导入的素材走 localAcquire（直接复制，不联网）
//   · 观测枢的条目走 download（HTTPS 收流，只允许官方域名）
// 早先它被整段删掉、只留本地导入 —— 结果是「视频分段导出」对库里的 PV 全部失效，
// 而下游的 scenes/clip/缩略图/下载那些代码其实都还在。
function allowed(url){const u=new URL(url);return u.protocol==='https:' && ['mihoyo.com','miyoushe.com','hoyoverse.com','hoyolab.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h));}
// 这里的错都要带 userMessage —— 否则 enqueue() 会把它替换成
// 「视频处理失败，请检查本地素材与处理工具」，用户根本不知道是来源被拒。
// 只有「来源不合法 / 下载失败 / 文件过大」这类**用户能理解并采取行动**的原因才值得直接显示。
const userErr = (msg) => Object.assign(new Error(msg), { userMessage: true });
async function download(url,file){
  let current=url,response;
  for(let i=0;i<6;i++){
    if(!allowed(current))throw userErr('视频来源不可用（只支持米哈游官方图床）');
    response=await fetch(current,{redirect:'manual',headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(180000)});
    if(response.status>=300&&response.status<400){const target=response.headers.get('location');await response.body?.cancel();if(!target)throw userErr('视频来源不可用');current=new URL(target,current).href;continue;}break;
  }
  if(!response?.ok||!response.body)throw userErr('视频下载失败，请重试。');
  if(Number(response.headers.get('content-length'))>512*1024*1024){await response.body.cancel();throw userErr('视频过大，暂不支持处理。')}
  let bytes=0;const input=Readable.fromWeb(response.body);input.on('data',d=>{bytes+=d.length;if(bytes>512*1024*1024)input.destroy(userErr('视频过大'))});
  await pipeline(input,fs.createWriteStream(file));
}

export class MediaJobs {
  constructor({root,getSource,ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe',acquire=download,limit=2*1024**3}){
    Object.assign(this,{root,getSource,ffmpeg,ffprobe,acquire,limit});this.controllers=new Map();this.jobs=new Map();this.active=0;this.queue=[];this.inflight=new Map();this.indexing=new Map();
    fs.mkdirSync(root,{recursive:true});fs.mkdirSync(path.join(root,'jobs'),{recursive:true});
    for(const f of fs.readdirSync(path.join(root,'jobs')))if(f.endsWith('.json'))try{const j=JSON.parse(fs.readFileSync(path.join(root,'jobs',f),'utf8'));if(['queued','running'].includes(j.state)){j.state='failed';j.error='服务已重启，请重试。';atomic(path.join(root,'jobs',f),j)}this.jobs.set(j.id,j)}catch{}
    for(const d of fs.readdirSync(root,{withFileTypes:true}))if(d.isDirectory()&&/^[a-f0-9]{24}$/.test(d.name))for(const f of fs.readdirSync(path.join(root,d.name)))if(/^source-.*\.mp4$|\.partial\.mp4$|\.tmp$/.test(f))fs.rmSync(path.join(root,d.name,f),{force:true});
    this.evict();
  }
  descriptor(id,index=0){
    if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(index)||index<0)throw Error('视频编号无效');
    const s=this.getSource(id,index);
    // 两种来源都可用：本机素材（localPath）或观测枢直链（url）
    if(!s?.localPath && !s?.url)throw Error(s?.error || '该条目没有可用视频');
    const source=s.localPath||s.url;let stamp='';try{const st=fs.statSync(source);stamp=st.size+':'+st.mtimeMs}catch{}const key=digest(id+':'+index+':'+source+stamp);return {...s,id,index,key,dir:path.join(this.root,key)};
  }
  cached(s){try{const r=JSON.parse(fs.readFileSync(path.join(s.dir,'index.json'),'utf8'));if(r.indexVersion!==2||!Number.isFinite(r.threshold))return null;fs.utimesSync(path.join(s.dir,'index.json'),new Date(),new Date());return r}catch{return null}}
  metadata(id,index){const s=this.descriptor(id,index),c=this.cached(s);return {entryId:id,videoIndex:index,title:s.title,...(c?{duration:c.duration,width:c.width,height:c.height,hasAudio:c.hasAudio}:{}),indexed:!!c};}
  publicJob(j){return {id:j.id,type:j.type,state:j.state,progress:j.progress,error:j.error,result:j.result};}
  list(owner){return [...this.jobs.values()].filter(j=>j.owner===owner).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(j=>this.publicJob(j))}
  cancel(id,owner){const j=this.jobs.get(id);if(!j||j.owner!==owner)throw Error('没有该任务');if(['queued','running'].includes(j.state)){j.state='cancelled';j.error='已取消';this.controllers.get(id)?.abort();this.save(j)}return this.publicJob(j)}
  get(id,owner){const j=this.jobs.get(id);if(!j||j.owner!==owner)return null;return this.publicJob(j)}
  save(j){atomic(path.join(this.root,'jobs',j.id+'.json'),j)}
  enqueue(type,owner,identity,work){
    const existing=this.inflight.get(owner+':'+identity);if(existing)return this.publicJob(this.jobs.get(existing));
    if(this.queue.length>=30)throw Error('处理队列已满，请稍后重试。');
    const j={id:crypto.randomUUID(),owner,type,state:'queued',progress:0,createdAt:Date.now()};this.jobs.set(j.id,j);this.save(j);this.inflight.set(owner+':'+identity,j.id);
    const controller=new AbortController();this.controllers.set(j.id,controller);
    this.queue.push(async()=>{try{if(j.state==='cancelled')return;j.state='running';this.save(j);
      j.result=await jobContext.run(controller.signal,()=>work(p=>{controller.signal.throwIfAborted();j.progress=p;this.save(j)}));
      if(j.state!=='cancelled'){j.state='completed';j.progress=100;}
    }catch(e){if(j.state!=='cancelled'){j.state='failed';j.error=e.userMessage?e.message:'视频处理失败，请检查本地素材与处理工具。';}}
    finally{this.save(j);this.controllers.delete(j.id);this.inflight.delete(owner+':'+identity);this.evict()}});this.pump();return this.publicJob(j);
  }
  pump(){while(this.active<2&&this.queue.length){const task=this.queue.shift();this.active++;task().finally(()=>{this.active--;this.pump()})}}
  scenes(id,index,owner){const s=this.descriptor(id,index);return this.enqueue('scenes',owner,'scenes:'+s.key,p=>this.index(s,p))}
  async source(s,fn){fs.mkdirSync(s.dir,{recursive:true});const temp=path.join(s.dir,'source-'+crypto.randomUUID()+'.mp4');try{
    // 本机素材直接复制，观测枢直链走 download —— 两条路并存
    if(s.localPath)await localAcquire(s.localPath,temp);else await this.acquire(s.url,temp);
    return await fn(temp)}finally{fs.rmSync(temp,{force:true})}}
  async index(s,progress){
    const c=this.cached(s);if(c)return c;
    return await this.source(s,async file=>{
      progress(20);const probe=JSON.parse((await tool(this.ffprobe,['-v','error','-show_format','-show_streams','-of','json','-protocol_whitelist','file,pipe',file])).stdout);const video=probe.streams.find(s=>s.codec_type==='video');const duration=Number(probe.format.duration);
      if(!video||!Number.isFinite(duration)||duration<=0||duration>1200)throw Error('视频时长不可用');
      let cuts=[],threshold=0.30;
      for(const candidate of [0.30,0.15,0.08]){
        threshold=candidate;const output=await tool(this.ffmpeg,['-threads','2','-filter_threads','1','-hide_banner','-protocol_whitelist','file,pipe','-i',file,'-vf',`scale=320:-2,select=gt(scene\\,${candidate}),showinfo`,'-an','-f','null','-']);
        const raw=[...output.stderr.matchAll(/pts_time:\s*([\d.e+-]+)/g)].map(m=>Number(m[1])).filter(t=>t>0.15&&t<duration-0.15).sort((a,b)=>a-b);
        const transitions=[];for(const t of raw){const last=transitions.at(-1);if(last&&t-last.at(-1)<0.4)last.push(t);else transitions.push([t]);}
        cuts=transitions.map(group=>group[Math.floor(group.length/2)]);if(cuts.length>=2)break;
      }
      const boundaries=sceneBoundaries(cuts,duration);
      const scenes=[];fs.mkdirSync(path.join(s.dir,'thumbs'),{recursive:true});
      for(let i=0;i<boundaries.length-1;i++){
        const start=boundaries[i],end=boundaries[i+1];const n=scenes.length;const thumb=path.join(s.dir,'thumbs',n+'.jpg');
        await tool(this.ffmpeg,['-threads','2','-filter_threads','1','-hide_banner','-loglevel','error','-ss',String((start+end)/2),'-protocol_whitelist','file,pipe','-i',file,'-frames:v','1','-vf','scale=320:-2','-y',thumb],30000);
        scenes.push({index:n,start,end,thumbnail:`/v1/media/assets/${s.key}/thumb/${n}`});progress(35+Math.round(60*(i+1)/(boundaries.length-1)));
      }
      const result={indexVersion:2,entryId:s.id,videoIndex:s.index,title:s.title,duration,width:video.width,height:video.height,hasAudio:probe.streams.some(s=>s.codec_type==='audio'),threshold,scenes};atomic(path.join(s.dir,'index.json'),result);return result;
    });
  }
  clip(id,index,start,end,owner){
    const s=this.descriptor(id,index),c=this.cached(s);
    if(!c)throw Error('请先建立镜头索引');
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>c.duration+0.001||end<=start||end-start>60.001)throw Error('请选择视频范围内不超过 60 秒的片段');
    if(start<0.01&&end>=c.duration-0.01)throw Error('请选择片段，不能导出整段视频');
    const recipe=digest(owner+':'+s.key+':'+start.toFixed(3)+':'+end.toFixed(3));
    return this.enqueue('clip',owner,'clip:'+s.key+':'+recipe,async progress=>{
      const out=path.join(s.dir,recipe+'.mp4');
      if(!fs.existsSync(out))await this.source(s,async file=>{progress(30);const temp=path.join(s.dir,recipe+'.partial.mp4');try{await tool(this.ffmpeg,['-threads','2','-filter_threads','1','-hide_banner','-loglevel','error','-ss',String(start),'-protocol_whitelist','file,pipe','-i',file,'-t',String(end-start),'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-threads','2','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-y',temp]);fs.renameSync(temp,out)}finally{fs.rmSync(temp,{force:true})}});
      return {entryId:id,videoIndex:index,start,end,duration:end-start,url:`/v1/media/assets/${s.key}/clip/${recipe}`,filename:`Akasha-${id}-${start.toFixed(1)}-${end.toFixed(1)}.mp4`};
    });
  }
  asset(key,kind,id,owner){
    if(!/^[a-f0-9]{24}$/.test(key))return null;let file;
    if(kind==='thumb'&&/^\d+$/.test(id))file=path.join(this.root,key,'thumbs',id+'.jpg');
    else if(kind==='clip'&&/^[a-f0-9]{24}$/.test(id)){
      const url=`/v1/media/assets/${key}/clip/${id}`;if(![...this.jobs.values()].some(j=>j.owner===owner&&j.state==='completed'&&j.result?.url===url))return null;file=path.join(this.root,key,id+'.mp4');
    }else return null;
    if(!fs.existsSync(file))return null;fs.utimesSync(file,new Date(),new Date());return {file,type:kind==='clip'?'video/mp4':'image/jpeg'};
  }
  evict(){
    const dirs=fs.readdirSync(this.root,{withFileTypes:true}).filter(d=>d.isDirectory()&&/^[a-f0-9]{24}$/.test(d.name));let total=0;
    const entries=dirs.map(d=>{const dir=path.join(this.root,d.name);let bytes=0,at=0;function scan(p){for(const f of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,f.name);if(f.isDirectory())scan(q);else{const s=fs.statSync(q);bytes+=s.size;at=Math.max(at,s.mtimeMs)}}}scan(dir);total+=bytes;return{dir,bytes,at,key:d.name}}).sort((a,b)=>a.at-b.at);
    for(const e of entries){if(total<=this.limit)break;if([...this.inflight.keys()].some(k=>k.includes(e.key)))continue;fs.rmSync(e.dir,{recursive:true,force:true});total-=e.bytes;}
  }
}
