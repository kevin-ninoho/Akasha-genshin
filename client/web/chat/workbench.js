(function () {
  'use strict';
  const S = window.AkashaStore;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const uid = () => crypto.randomUUID();
  let view = 'home', active = null, ticket = 0;
  const host = () => document.getElementById('workbench');
  const flash = message => { document.getElementById('wb-notice').textContent = message; };
  function button(label, action, cls = '') { return `<button class="wb-button ${cls}" data-action="${action}">${label}</button>`; }
  function field(label, name, value = '', type = 'text') {
    return `<label class="wb-field">${label}<input name="${name}" type="${type}" value="${esc(value)}"></label>`;
  }
  function area(label, name, value = '', rows = 4) {
    return `<label class="wb-field">${label}<textarea name="${name}" rows="${rows}">${esc(value)}</textarea></label>`;
  }
  function heading(kicker, title, desc, actions = '') {
    return `<div class="wb-heading"><div><span class="eyebrow">${kicker}</span><h2>${title}</h2><p>${desc}</p></div><div class="wb-actions">${actions}</div></div>`;
  }
  const names = { home: '星图首页', chat: '知识问答', research: '考据研究', growth: '养成规划', pv: 'PV 创作', skills: '能力目录', settings: '偏好设置' };
  function shell(v) {
    view = v; ticket++; active = null;
    host().onclick=null;host().oninput=null;host().onchange=null;
    const main = document.getElementById('main');
    main.dataset.view = v;
    document.getElementById('view-skills').hidden = v !== 'skills';
    host().hidden = ['chat', 'skills'].includes(v);
    document.getElementById('log').hidden = v !== 'chat';
    document.querySelector('.composer').hidden = v !== 'chat';
    document.getElementById('title').textContent = names[v] || 'Akasha';
    document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === v));
    document.getElementById('side').classList.toggle('hide-convos', v !== 'chat');
    document.getElementById('side').classList.remove('open');
    flash('');
  }
  async function go(v) {
    if (!names[v]) v = 'home';
    shell(v);
    const t = ticket;
    if (v === 'chat') return;
    if (v === 'skills') return window.AkashaSkills.paintView();
    host().innerHTML = '<p class="wb-empty">正在读取本机工作区…</p>';
    try {
      if (v === 'home') await home(t);
      else if (v === 'settings') await settings(t);
      else await listing(v, t);
    } catch (e) { if (t === ticket) host().innerHTML = `<div class="wb-empty">${esc(e.message)}<br>${button('重新连接', 'reload')}</div>`; }
  }
  async function home(t) {
    const [research, growth, pv] = await Promise.all(['research', 'growth', 'pv'].map(k => S.list(k)));
    if (t !== ticket) return;
    const recent = [...research.map(x => ({ ...x, kind: 'research' })), ...growth.map(x => ({ ...x, kind: 'growth' })), ...pv.map(x => ({ ...x, kind: 'pv' }))].sort((a, b) => b.updated - a.updated).slice(0, 5);
    host().innerHTML = `<section class="observatory"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><span class="eyebrow">AKASHA / LOCAL ARCHIVE</span><h2>让每一次探索<br>都有迹可循。</h2><p>从一个问题出发，整理依据，规划旅程，记录灵感。</p><div class="wb-actions">${button('开始提问 ↗', 'ask', 'primary')}${button('建立研究专题', 'new-research')}</div><span class="local-seal">◈ 原神 · 本机资料 · 本机处理</span></section>
      <div class="work-cards">${[
        ['research', '01', '考据研究', '把线索连成故事', research.length + ' 个专题', '专题 · 证据 · 时间线'],
        ['growth', '02', '养成规划', '把目标变成行动', growth.length + ' 套计划', '角色 · 材料 · 每日行动'],
        ['pv', '03', 'PV 创作', '整理视频档案与创作线索', pv.length + ' 个项目', '观测枢元数据 · 本机素材可选剪辑'],
      ].map(([k,n,title,desc,count,meta]) => `<button class="work-card" data-nav="${k}"><span class="card-number">${n}</span><h3>${title}</h3><p>${desc}</p><small>${meta}</small><div class="card-bottom"><span>${count}</span><span>↗</span></div></button>`).join('')}</div>
      <section class="wb-panel"><div class="section-heading"><h3>继续探索</h3><span class="muted">所有进度保存在本机</span></div>${recent.length ? recent.map(x => `<button class="recent-row" data-open="${x.id}" data-kind="${x.kind}"><span class="recent-glyph">◇</span><span><b>${esc(x.data.title || '未命名')}</b><small>${names[x.kind]}</small></span><time>${new Date(x.updated).toLocaleDateString()}</time><span>→</span></button>`).join('') : '<p class="wb-empty">你的第一份专题、养成计划或选段项目，将从这里继续。</p>'}</section>`;
  }
  async function listing(kind, t) {
    const rows = await S.list(kind);
    if (t !== ticket) return;
    const descriptions = { research: '收集依据，记录疑问，让结论经得起回看。', growth: '按角色现状和库存计算，保存每一步进度。', pv: '检索观测枢的视频元数据并记录策划线索；本机视频可选用于预览、选段和导出。' };
    host().innerHTML = heading('WORKSPACE / ' + kind.toUpperCase(), names[kind], descriptions[kind], button('＋ 新建', 'new-' + kind, 'primary')) +
      `<div class="project-grid">${rows.map(x => `<button class="project-card" data-open="${x.id}" data-kind="${kind}"><span class="eyebrow">${new Date(x.updated).toLocaleDateString()}</span><h3>${esc(x.data.title || '未命名')}</h3><p>${esc(x.data.question || (kind === 'growth' ? (x.data.roster?.length || 0) + ' 个角色' : (x.data.clips?.length || 0) + ' 个片段'))}</p><span>打开档案 →</span></button>`).join('')}</div>` +
      (rows.length ? '' : '<div class="wb-empty">这里还没有项目。点击“新建”，开始保存你的工作。</div>');
  }
  async function create(kind, initial = {}) {
    const data = { title: kind === 'research' ? '新的研究专题' : kind === 'growth' ? '新的养成计划' : '新的 PV 项目', ...initial };
    const id = uid();
    await S.put(kind, id, data);
    await open(kind, id);
  }
  async function open(kind, id) {
    shell(kind); const t = ticket;
    const data = await S.get(kind, id);
    if (t !== ticket) return;
    if (!data) throw new Error('项目不存在');
    active = { kind, id, data };
    const renderer = window.AkashaViews[kind];
    await renderer.render(host(), data, { esc, field, area, button, heading, S, save: value => S.put(kind,id,value), flash, uid, openEvidence, isCurrent: () => t === ticket, id });
  }
  async function save(data) {
    if (!active) return;
    active.data = data;
    return S.put(active.kind, active.id, data);
  }
  async function openEvidence(answerId) {
    const drawer = document.getElementById('evidence-drawer');
    drawer.hidden = false; drawer.querySelector('.evidence-body').textContent = '正在读取本机依据…';
    document.getElementById('close-evidence').focus();
    try {
      const evidence = await S.api('/v1/evidence/' + encodeURIComponent(answerId));
      drawer.querySelector('.evidence-body').innerHTML = `<p class="wb-callout">${evidence.stale ? '资料版本已变化，请复核以下证据。' : '此处仅显示当前回答关联的资料片段。'} 资料版本：${esc(evidence.revision)}</p>
        <label class="check-row"><input type="checkbox" id="compare-evidence"> 并排对照</label>
        <div class="evidence-items">${evidence.items.map(s => `<article class="evidence-card"><span class="eyebrow">[${esc(s.ref)}] ${esc(s.authority)}</span><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p><small>${esc(s.sourceId)}</small></article>`).join('') || '<p>本回答没有可展示的资料片段。</p>'}</div>`;
      document.getElementById('compare-evidence').onchange = e => drawer.classList.toggle('compare', e.target.checked);
    } catch (e) { drawer.querySelector('.evidence-body').textContent = e.message; }
  }
  async function collect(message, kind) {
    // Editable conversion sheet; nothing is saved before the user reviews it.
    const dialog = document.getElementById('convert-dialog');
    const research = kind === 'research';
    let choices = [];
    if (research) choices = await S.list('research');
    dialog.innerHTML = `<form method="dialog"><div class="section-heading"><h3>${research ? '加入研究专题' : '转为养成计划'}</h3><button value="cancel" class="wb-button">取消</button></div>
      ${research ? `<label class="wb-field">保存到<select name="destination"><option value="">新建专题</option>${choices.map(x=>`<option value="${esc(x.id)}">${esc(x.data.title)}</option>`).join('')}</select></label>` : ''}
      ${field('标题', 'title', research ? '从回答开始的研究' : '从回答开始的养成计划')}
      ${area('回答摘记（可编辑）', 'note', message.text || '')}
      ${research ? '<p class="muted">将保留原回答的证据标识，原文仅在本机查看。</p>' : '<p class="wb-callout">回答未提供可验证的角色练度字段，请在计划中选择角色和等级；不会猜测你的账号状态。</p>'}
      <button type="submit" value="save" class="wb-button primary">确认保存</button></form>`;
    dialog.showModal();
    dialog.onclose = async () => {
      if (dialog.returnValue !== 'save') return;
      const f = new FormData(dialog.querySelector('form'));
      try {
        if(research && f.get('destination')) {
          const id=f.get('destination'), d=await S.get('research',id);
          d.notes=(d.notes||'')+'\n\n'+f.get('note');
          if(message.answerId)d.evidence=[...new Set([...(d.evidence||[]),message.answerId])];
          await S.put('research',id,d);await open('research',id);
        } else await create(kind, { title: f.get('title'), notes: f.get('note'), evidence: message.answerId ? [message.answerId] : [], roster: [] });
      } catch (e) { flash(e.message); }
    };
  }
  async function settings(t) {
    const p = await S.get('preferences', 'appearance', {});
    if (t !== ticket) return;
    host().innerHTML = heading('PERSONALIZE', '偏好设置', '营造适合长时间探索的阅读环境。') + `<section class="wb-panel settings-panel">
      <label class="wb-field">文字大小<select id="font-size"><option value="14">标准 · 14 px</option><option value="16">舒适 · 16 px</option><option value="18">大字 · 18 px</option></select></label>
      <label class="check-row"><input id="reduce-motion" type="checkbox" ${p.reduceMotion ? 'checked' : ''}> 减少动态效果</label>
      <div class="wb-callout">本机模式已启用。资料、提示词和媒体不会交给外部服务。模型不可用时可继续检索与计算。自动更新已关闭。</div>
      <p class="muted">游戏适配：原神已接入；其他游戏待配置适配器后才会出现。</p></section>`;
    document.getElementById('font-size').value = String(p.fontSize || 14);
    host().onchange = async () => {
      const next = { fontSize: Number(document.getElementById('font-size').value), reduceMotion: document.getElementById('reduce-motion').checked };
      applyAppearance(next); try { await S.put('preferences', 'appearance', next); } catch { /* visible store error */ }
    };
  }
  function applyAppearance(p) {
    document.documentElement.style.setProperty('--reading-size', (p.fontSize || 14) + 'px');
    document.documentElement.classList.toggle('reduce-motion', !!p.reduceMotion);
  }
  document.addEventListener('click', async e => {
    const nav = e.target.closest('[data-nav]');
    if (nav && !['chat', 'skills'].includes(nav.dataset.nav)) { await go(nav.dataset.nav); return; }
    const row = e.target.closest('[data-open]');
    const action = e.target.closest('[data-action]')?.dataset.action;
    try {
      if (row) await open(row.dataset.kind, row.dataset.open);
      if (action === 'reload') await go(view);
      if (action === 'ask') window.AkashaChat.showChat();
      if (action?.startsWith('new-')) await create(action.slice(4));
    } catch (err) { flash(err.message); }
  });
  window.AkashaViews = {};
  window.AkashaWorkbench = { go, shell, open, create, openEvidence, collect, flash,
    async init() {
      document.getElementById('save-state').onclick = () => S.retry().catch(e => flash(e.message));
      document.getElementById('close-evidence').onclick = () => { document.getElementById('evidence-drawer').hidden = true; document.getElementById('main').focus(); };
      document.addEventListener('keydown', e => { if(e.key === 'Escape') document.getElementById('close-evidence').click(); });
      applyAppearance(await S.get('preferences', 'appearance', {}));
      await go('home');
    },
  };
})();
