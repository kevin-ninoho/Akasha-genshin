(function () {
  window.AkashaViews.pv = {
    async render(host, data, ui) {
      const { esc, field, button, heading, S, save, flash, isCurrent }=ui;
      data.clips ||= []; data.jobs ||= []; data.references ||= [];
      host.innerHTML=heading('CREATE / FRAME','PV 创作','观测枢元数据整理 · 本机视频可选剪辑',button('＋ 添加本地视频','import-video','primary'))+
        `<section class="wb-panel">${field('项目名称','title',data.title)}<h3>观测枢视频档案</h3><p class="wb-callout">这里只整理米游社观测枢中的视频条目元数据。视频本体不在本地，不会自动下载；可加入策划清单并记录时间点。需要预览、裁切或导出时，请另行添加本机视频。</p><div class="search-row"><input id="catalog-search" placeholder="搜索角色或视频标题" aria-label="搜索观测枢视频元数据">${button('搜索档案','search-catalog')}</div><div id="catalog-library"></div><div id="pv-references"></div></section>
        <section class="wb-panel"><h3>本机剪辑素材</h3><p>只有本机视频可建立镜头索引、预览和导出；片段最长 60 秒。</p><div class="search-row"><input id="video-search" placeholder="搜索本地素材标题" aria-label="搜索本地素材">${button('搜索素材','search-video')}</div><div id="video-library"></div></section>
        <section class="wb-panel"><div class="section-heading"><h3 id="pv-source-title">镜头工作台</h3><span id="pv-stage" class="muted"></span></div><div id="pv-scenes"><p class="wb-empty">选择一份本地视频，建立镜头索引。</p></div>
        <div id="pv-range" hidden><div class="form-row">${field('开始（秒）','start',0,'number')}${field('结束（秒）','end',8,'number')}${button('加入片段清单','add-clip')}${button('生成预览 / 导出','export-clip','primary')}</div></div><div id="pv-preview"></div></section>
        <section class="wb-panel"><h3>片段清单</h3><div id="pv-clips"></div></section><section class="wb-panel"><h3>处理队列</h3><div id="pv-jobs"></div></section>`;
      let source=data.source||null, index=data.index||null, first=null;
      const persist=()=>save(data).catch(e=>flash(e.message));
      function references(){
        host.querySelector('#pv-references').innerHTML=data.references.map((r,i)=>`<div class="recent-row"><span>◇</span><span><b>${esc(r.title)}</b><small>米游社观测枢 · 元数据索引 #${r.entryId}:${r.videoIndex} · 本体不在本地</small><div class="form-row"><label class="wb-field">时间点（秒）<input type="number" min="0" step="0.1" data-reference-time="${i}" value="${esc(r.time??'')}"></label><label class="wb-field">策划备注<input data-reference-note="${i}" value="${esc(r.note||'')}" placeholder="记录希望呈现的内容"></label></div></span><button class="wb-button" data-delete-reference="${i}">移除</button></div>`).join('')||'<p class="wb-empty">加入的观测枢视频元数据会保存在当前 PV 项目中。</p>';
      }
      async function catalog(){
        try{const q=host.querySelector('#catalog-search').value;const j=await S.api('/v1/videos/catalog?q='+encodeURIComponent(q));if(!isCurrent())return;
          host.querySelector('#catalog-library').innerHTML=j.items.map(s=>`<button class="library-video" data-catalog="${esc(JSON.stringify(s))}"><span>＋</span>${esc(s.title)} <small>观测枢 · 元数据</small></button>`).join('')||'<p class="wb-empty">没有匹配的视频元数据条目。</p>';
        }catch{if(isCurrent())host.querySelector('#catalog-library').textContent='观测枢视频元数据暂不可用。';}
      }
      function clips(){
        host.querySelector('#pv-clips').innerHTML=data.clips.map((c,i)=>`<div class="recent-row"><span>◇</span><span><b>${esc(c.title)}</b><small>${Number(c.start).toFixed(2)} — ${Number(c.end).toFixed(2)} 秒</small></span><button class="wb-button" data-use-clip="${i}">继续编辑</button><button class="wb-button" data-delete-clip="${i}">移除</button></div>`).join('')||'<p class="wb-empty">片段清单会随项目保存。</p>';
      }
      async function library(){
        try{const q=host.querySelector('#video-search').value;const j=await S.api('/v1/videos?q='+encodeURIComponent(q));if(!isCurrent())return;
          host.querySelector('#video-library').innerHTML=j.items.map(s=>`<button class="library-video" data-source="${esc(JSON.stringify(s))}"><span>▷</span>${esc(s.title)}</button>`).join('')||'<p class="wb-empty">尚无匹配的本地视频。可用“添加本地视频”导入。</p>';
        }catch(e){if(isCurrent())host.querySelector('#video-library').textContent='未配置本地素材。请添加本地视频。';}
      }
      function showIndex(){
        if(!index)return;
        host.querySelector('#pv-source-title').textContent=index.title;
        host.querySelector('#pv-range').hidden=false;
        host.querySelector('[name=start]').step='0.01';host.querySelector('[name=end]').step='0.01';
        host.querySelector('[name=start]').value=data.start??0;host.querySelector('[name=end]').value=data.end??Math.min(8,index.duration-0.05);
        host.querySelector('#pv-scenes').innerHTML=`<div class="pv-scene-grid">${index.scenes.map(s=>`<button class="pv-scene" data-scene="${s.index}"><img src="${esc(s.thumbnail)}" alt="镜头 ${s.index+1}" loading="lazy"><span>${s.start.toFixed(2)} – ${s.end.toFixed(2)}</span></button>`).join('')}</div>`;
      }
      async function submitJob(type, body={}){
        const j=await S.api('/v1/videos/'+source.entryId+'/'+type+'?index='+source.videoIndex,body);
        data.jobs.unshift({id:j.id,type,body,source:{...source},state:j.state});
        await save(data);await poll();
      }
      async function poll(){
        if(!isCurrent())return;
        let pending=false;
        for(const item of data.jobs){
          if(!['queued','running'].includes(item.state))continue;
          try{
            const j=await S.api('/v1/media/jobs/'+item.id);
            Object.assign(item,{state:j.state,progress:j.progress,error:j.error,result:j.result});
            if(j.state==='completed'&&item.type==='scenes'&&source?.entryId===item.source.entryId){index=j.result;data.index=index;showIndex();}
          }catch{item.state='interrupted';item.error='任务不可用或连接中断，可重新尝试。';}
          pending ||= ['queued','running'].includes(item.state);
        }
        if(!isCurrent())return;
        const labels={queued:'排队中',running:'处理中',completed:'完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
        host.querySelector('#pv-jobs').innerHTML=data.jobs.map((j,i)=>`<div class="job-row"><span><b>${j.type==='scenes'?'镜头索引':'片段导出'} · ${esc(j.source.title)}</b><small>${labels[j.state]||j.state} · ${j.progress||0}% ${esc(j.error||'')}</small></span>${['queued','running'].includes(j.state)?`<button class="wb-button" data-cancel-job="${i}">取消</button>`:['failed','interrupted','cancelled'].includes(j.state)?`<button class="wb-button" data-retry-job="${i}">重试</button>`:j.type==='clips'?`<button class="wb-button" data-preview-job="${i}">预览 / 保存</button>`:''}</div>`).join('')||'<p class="wb-empty">目前没有处理任务。</p>';
        await persist();
        if(pending)setTimeout(poll,1500);
      }
      function selection(){
        if(!source||!index)throw Error('请先选择素材并建立镜头索引');
        const start=Number(host.querySelector('[name=start]').value),end=Number(host.querySelector('[name=end]').value);
        if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>index.duration||end<=start||end-start>60)throw Error('请选择有效且不超过 60 秒的时间范围');
        if(start<.01&&end>=index.duration-.01)throw Error('请选择片段，不能导出整段视频');
        data.start=start;data.end=end;return{start,end};
      }
      host.oninput=e=>{if(e.target.name==='title'){data.title=e.target.value;persist();}else if(['start','end'].includes(e.target.name)){data[e.target.name]=Number(e.target.value);persist();}else if(e.target.matches('[data-reference-time]')){data.references[Number(e.target.dataset.referenceTime)].time=e.target.value;persist();}else if(e.target.matches('[data-reference-note]')){data.references[Number(e.target.dataset.referenceNote)].note=e.target.value;persist();}};
      host.onchange=null;
      host.onclick=async e=>{
        try{
          const action=e.target.closest('[data-action]')?.dataset.action,src=e.target.closest('[data-source]'),scene=e.target.closest('[data-scene]');
          if(action==='import-video'){
            if(!window.akashaLocal)throw Error('请在桌面客户端使用本地文件选择器');
            const imported=await window.akashaLocal.importVideos();if(imported.error)throw Error(imported.error);await library();
          }
          if(action==='search-video')await library();
          if(action==='search-catalog')await catalog();
          const metadata=e.target.closest('[data-catalog]');
          if(metadata){const item=JSON.parse(metadata.dataset.catalog);if(!data.references.some(r=>r.entryId===item.entryId&&r.videoIndex===item.videoIndex))data.references.unshift({...item,time:'',note:''});references();await persist();}
          if(src){source=JSON.parse(src.dataset.source);data.source=source;data.index=null;index=null;first=null;host.querySelector('#pv-stage').textContent='正在建立镜头索引…';await submitJob('scenes');}
          if(scene){const n=Number(scene.dataset.scene);const s=index.scenes[n];if(first===null){first=n;data.start=s.start;data.end=s.end;}else{data.start=index.scenes[Math.min(first,n)].start;data.end=index.scenes[Math.max(first,n)].end;first=null;}showIndex();await persist();}
          if(action==='add-clip'){data.clips.push({...source,...selection()});clips();await persist();}
          if(action==='export-clip')await submitJob('clips',selection());
          const use=e.target.closest('[data-use-clip]'),del=e.target.closest('[data-delete-clip]'),cancel=e.target.closest('[data-cancel-job]'),retry=e.target.closest('[data-retry-job]'),preview=e.target.closest('[data-preview-job]');
          if(del){data.clips.splice(Number(del.dataset.deleteClip),1);clips();await persist();}
          const removeReference=e.target.closest('[data-delete-reference]');if(removeReference){data.references.splice(Number(removeReference.dataset.deleteReference),1);references();await persist();}
          if(use){const c=data.clips[Number(use.dataset.useClip)];source={entryId:c.entryId,videoIndex:c.videoIndex,title:c.title};data.source=source;data.start=c.start;data.end=c.end;await submitJob('scenes');}
          if(cancel){const j=data.jobs[Number(cancel.dataset.cancelJob)];await S.api('/v1/media/jobs/'+j.id+'/cancel',{});await poll();}
          if(retry){const j=data.jobs[Number(retry.dataset.retryJob)];source=j.source;data.source=source;await submitJob(j.type,j.body);}
          if(preview){
            const j=data.jobs[Number(preview.dataset.previewJob)],r=j.result;
            host.querySelector('#pv-preview').innerHTML=`<video controls preload="metadata" src="${esc(r.url)}"></video><button class="wb-button primary" id="save-clip">保存片段到本机</button>`;
            host.querySelector('#save-clip').onclick=async()=>{try{const response=await fetch(r.url);if(!response.ok)throw Error('缓存片段已失效，请重新生成');const blob=await response.blob(),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=r.filename;a.click();setTimeout(()=>URL.revokeObjectURL(u),2000);}catch(err){flash(err.message);}};
          }
        }catch(err){flash(err.message);}
      };
      clips();references();showIndex();await catalog();await library();await poll();
    },
  };
})();
