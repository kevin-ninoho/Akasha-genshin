(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  // 视频条目按钮：**能取到本体就开「选择片段」，取不到就标成元数据**。
  //
  // 块里带 availability 字段（'metadata-only' 表示这条只有观测枢元数据）。
  // 早先这里一律画成不可点的 span —— 结果是「视频分段导出」整个从界面上消失了，
  // 而下面的选段弹窗、场景网格、起止时间、生成片段、下载那些代码其实一行都没删。
  window.AkashaMedia = {
    render: function (b) {
      return '<div class="video-choices">' + (b.items || []).map(function (v) {
        var onlyMeta = v.availability === 'metadata-only' || b.availability === 'metadata-only';
        if (onlyMeta) {
          return '<span class="video-open metadata-only">' + esc(v.title) + ' · 观测枢元数据（本体不在本地）</span>';
        }
        return '<button class="video-open" data-video-open="' + v.entryId + '" data-video-index="' + v.videoIndex + '">' +
          esc(v.title) + ' · 选择片段</button>';
      }).join('') + '</div>';
    },
  };
  var panel, generation = 0, current;
  async function api(url, body) {
    var r = await fetch(url, body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    var j = await r.json(); if (!r.ok) throw new Error(j.error && j.error.message || j.message || '请求失败，请重试。'); return j;
  }
  async function job(url, body, ticket) {
    var j = await api(url, body);
    while (j.state === 'queued' || j.state === 'running') {
      if (ticket !== generation) throw new Error('已关闭');
      panel.querySelector('.media-status').textContent = (j.state === 'queued' ? '等待处理' : '正在处理') + ' · ' + (j.progress || 0) + '%';
      await new Promise(function (r) { setTimeout(r, 2500); }); j = await api('/v1/media/jobs/' + j.id);
    }
    if (j.state !== 'completed') throw new Error(j.error || '处理失败，请重试。'); return j.result;
  }
  function error(e, ticket) { if (ticket === generation && panel) panel.querySelector('.media-status').textContent = e.message; }
  function close() { generation++; if (panel) panel.remove(); panel = null; current = null; }
  async function open(id, index) {
    close(); var ticket = generation;
    panel = document.createElement('section'); panel.className = 'media-dialog'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','PV 片段选择');
    panel.innerHTML = '<div class="media-content"><button class="media-close" aria-label="关闭">✕</button><h3>选择 PV 片段</h3><p class="media-status">建立镜头索引…</p><div class="scene-grid"></div><div class="clip-controls" hidden><label>开始（秒）<input class="clip-start" type="number" min="0" step="0.01"></label><label>结束（秒）<input class="clip-end" type="number" min="0" step="0.01"></label><button class="clip-create">生成片段</button><span>最长 60 秒 · 保留原声</span></div><div class="clip-result"></div><button class="media-retry" hidden>重试</button></div>';
    document.body.appendChild(panel); panel.querySelector('.media-close').onclick = close;
    panel.querySelector('.media-retry').onclick = function () { open(id,index); };
    try {
      var data = await job('/v1/videos/' + id + '/scenes?index=' + index, {}, ticket); if (ticket !== generation) return;
      current = { id:id,index:index,data:data,first:null,last:null };
      panel.querySelector('h3').textContent = data.title;
      panel.querySelector('.media-status').textContent = '依次选择开始镜头和结束镜头；也可微调时间。';
      panel.querySelector('.scene-grid').innerHTML = data.scenes.map(function (s) { return '<button class="scene-choice" data-scene="' + s.index + '"><img loading="lazy" src="' + esc(s.thumbnail) + '" alt="镜头 ' + (s.index+1) + '"><span>' + s.start.toFixed(2) + ' – ' + s.end.toFixed(2) + ' 秒</span></button>'; }).join('');
      panel.querySelector('.clip-controls').hidden = false;
      panel.querySelector('.clip-start').value = 0; panel.querySelector('.clip-end').value = Math.min(60, data.scenes[0].end, data.duration - 0.05).toFixed(2);
      panel.querySelector('.scene-grid').onclick = function (e) {
        var b = e.target.closest('[data-scene]'); if (!b) return; var n = Number(b.dataset.scene);
        if (current.first === null || current.last !== null) { current.first = n; current.last = null; } else current.last = n;
        var first = Math.min(current.first,current.last === null ? current.first : current.last), last = Math.max(current.first,current.last === null ? current.first : current.last);
        panel.querySelector('.clip-start').value = data.scenes[first].start.toFixed(2); panel.querySelector('.clip-end').value = data.scenes[last].end.toFixed(2);
        panel.querySelectorAll('[data-scene]').forEach(function (el) { el.classList.toggle('selected', Number(el.dataset.scene)>=first && Number(el.dataset.scene)<=last); });
      };
      panel.querySelector('.clip-create').onclick = async function () {
        var button = this; button.disabled = true;
        try {
          var start = Number(panel.querySelector('.clip-start').value), end = Number(panel.querySelector('.clip-end').value);
          if (end <= start || end-start>60 || start<0 || end>data.duration) throw new Error('请选择视频范围内不超过 60 秒的片段。');
          if (start<0.01 && end>=data.duration-0.01) throw new Error('请选择片段，不能导出整段视频。');
          var clip = await job('/v1/videos/' + id + '/clips?index=' + index,{start:start,end:end},ticket); if (ticket !== generation) return;
          panel.querySelector('.media-status').textContent = '片段已生成 · ' + clip.duration.toFixed(2) + ' 秒';
          panel.querySelector('.clip-result').innerHTML = '<video controls preload="metadata" src="' + esc(clip.url) + '"></video><button class="clip-download">下载片段</button>';
          panel.querySelector('.clip-download').onclick = async function () {
            try { var r = await fetch(clip.url); if(!r.ok)throw new Error('片段下载失败'); var blob = await r.blob();var u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=clip.filename;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},1000); }catch(e){error(e,ticket)}
          };
        } catch(e) { error(e,ticket); } finally { button.disabled=false; }
      };
    } catch(e) { error(e,ticket); if(ticket === generation)panel.querySelector('.media-retry').hidden=false; }
  }
  document.addEventListener('click',function(e){var b=e.target.closest('[data-video-open]');if(b)open(Number(b.dataset.videoOpen),Number(b.dataset.videoIndex));});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&panel)close();});
})();
