(function () {
  window.AkashaViews.research = {
    async render(host, data, ui) {
      const { esc, field, area, button, heading, save, flash, openEvidence, S, isCurrent } = ui;
      data.evidence ||= [];     // 从对话回答收进来的证据标识（workbench 那套）
      data.sources ||= [];      // 本页自己检索出来、被「加入依据」的原始来源
      data.timeline ||= []; data.relations ||= []; data.found ||= null;

      host.innerHTML = heading('RESEARCH / ARCHIVE', '考据研究', '原文依据与个人判断分开记录',
        button('保存档案', 'research-save', 'primary')) +
        // ── 检索区：这页最重要的一块，放在最上面 ────────────────────────
        `<section class="wb-panel">
          <h3>从知识库取依据</h3>
          <p class="muted">输入一个话题，系统会在原典档案、角色故事、观测枢词条里检索，把带<strong>官方原文链接</strong>的条目列出来。点「加入依据」收进档案。</p>
          <div class="search-row">
            <input id="research-query" placeholder="例如：胡桃的身世 / 往生堂的规矩 / 钟离与胡桃的关系" aria-label="考据检索词" value="${esc(data.lastQuery || '')}">
            ${button('检索','research-search','primary')}
          </div>
          <div id="research-coverage" class="wb-hits-meta"></div>
          <div id="research-hits"></div>
        </section>

        <div class="editor-grid">
          <form id="research-form" class="wb-panel">
            ${field('专题标题', 'title', data.title)}
            ${area('研究问题', 'question', data.question, 2)}
            ${area('个人笔记', 'notes', data.notes, 7)}
            ${area('待核实事项', 'questions', data.questions, 3)}
            ${area('当前结论', 'conclusion', data.conclusion, 4)}
          </form>
          <div>
            <section class="wb-panel">
              <h3>已收集依据</h3>
              <p class="muted">每条都保留官方原文链接，可随时回到观测枢核对。</p>
              <div id="research-sources"></div>
            </section>
            <section class="wb-panel">
              <h3>对话证据</h3>
              <p class="muted">在对话页的回答下点「加入研究」，会在这里留下证据标识。</p>
              ${data.evidence.map((id, i) => `<button class="evidence-entry" data-evidence="${esc(id)}">◇ 证据组 ${i + 1} <span>查看 / 对照 →</span></button>`).join('') || '<p class="wb-empty">尚无对话证据</p>'}
            </section>
            <section class="wb-panel">
              <h3>标注约定</h3>
              <p>明确时间：资料直接给出。<br>相对先后：只确定顺序。<br>推测：需要进一步核实。</p>
              <p class="muted">关系与时间线是你的研究整理，不会被自动视为官方结论。</p>
            </section>
          </div>
        </div>

        <section class="wb-panel"><div class="section-heading"><h3>时间线</h3>${button('＋ 添加事件', 'add-event')}</div><div id="timeline-editor"></div></section>
        <section class="wb-panel"><div class="section-heading"><h3>关系记录</h3>${button('＋ 添加关系', 'add-relation')}</div><div id="relations-editor"></div></section>`;

      const persist = () => save(data).catch(e => flash(e.message));

      // 来源去重键：同一条原文可能被不同的检索命中
      const keyOf = (s) => `${s.title || ''}｜${s.heading || ''}｜${s.sourceUrl || ''}`;
      const collected = new Set(data.sources.map(keyOf));

      function drawSources() {
        host.querySelector('#research-sources').innerHTML = data.sources.map((s, i) => `
          <div class="source-card">
            <div class="source-line">
              <span class="source-type">${esc(s.type || '来源')}</span>
              <b>${esc(s.title || '')}</b>
              <button class="wb-button" data-drop-source="${i}" aria-label="移除依据">×</button>
            </div>
            <p class="source-text">${esc(String(s.text || '').slice(0, 260))}${String(s.text || '').length > 260 ? '…' : ''}</p>
            ${s.sourceUrl ? `<a class="source-link" href="${esc(s.sourceUrl)}" target="_blank" rel="noreferrer">原文 ↗</a>` : '<span class="muted">（该条无官方原文链接）</span>'}
          </div>`).join('') || '<p class="wb-empty">还没有收集依据。用上面的检索把原文找出来。</p>';
      }

      // 把 /v1/retrieve 的结果画成可点的卡片
      function drawHits(found) {
        const box = host.querySelector('#research-hits');
        const meta = host.querySelector('#research-coverage');
        if (!found) { box.innerHTML = ''; meta.textContent = ''; return; }
        const sources = found.sources || [];
        if (!sources.length) {
          box.innerHTML = '<p class="wb-empty">这个话题在知识库里没有检索到原文。换个更具体的说法试试，例如直接写角色名或物品名。</p>';
          meta.textContent = '';
          return;
        }
        const withUrl = sources.filter((s) => s.sourceUrl).length;
        const entities = (found.entities || []).map((e) => e.name).filter(Boolean);
        meta.textContent = [
          entities.length ? `识别到：${entities.join('、')}` : '',
          `取到 ${sources.length} 条依据`,
          withUrl === sources.length ? '全部带官方原文链接' : `${withUrl}/${sources.length} 条带官方原文链接`,
        ].filter(Boolean).join(' · ');
        box.innerHTML = sources.map((s) => {
          const has = collected.has(keyOf(s));
          return `<div class="source-card${has ? ' collected' : ''}">
            <div class="source-line">
              <span class="source-type">${esc(s.type || '来源')}</span>
              <b>${esc(s.title || '')}</b>
              <button class="wb-button${has ? '' : ' primary'}" data-add-source="${esc(JSON.stringify(s))}" ${has ? 'disabled' : ''}>${has ? '已收集' : '加入依据'}</button>
            </div>
            <p class="source-text">${esc(String(s.text || '').slice(0, 220))}${String(s.text || '').length > 220 ? '…' : ''}</p>
            ${s.sourceUrl ? `<a class="source-link" href="${esc(s.sourceUrl)}" target="_blank" rel="noreferrer">原文 ↗</a>` : ''}
          </div>`;
        }).join('');
      }

      async function search() {
        const q = host.querySelector('#research-query').value.trim();
        if (!q) { flash('先输入要考据的话题'); return; }
        data.lastQuery = q; persist();
        const box = host.querySelector('#research-hits');
        box.innerHTML = '<p class="wb-empty">正在检索原典档案…</p>';
        try {
          const r = await S.api('/v1/retrieve', { question: q });
          if (!isCurrent()) return;
          data.found = r; drawHits(r);
        } catch (e) {
          if (isCurrent()) box.innerHTML = `<p class="wb-empty">检索失败：${esc(e.message || '')}</p>`;
        }
      }

      // ── 时间线 / 关系（沿用原来的编辑器）──────────────────────────
      function evidenceOptions(value) {
        const opts = data.sources.map((s, i) => `<option value="src:${i}" ${`src:${i}` === value ? 'selected' : ''}>依据：${esc(String(s.title || '').slice(0, 22))}</option>`);
        const chat = data.evidence.map((id, i) => `<option value="ev:${esc(id)}" ${`ev:${id}` === value ? 'selected' : ''}>证据组 ${i + 1}</option>`);
        return `<option value="">未关联依据</option>${opts.join('')}${chat.join('')}`;
      }
      function draw() {
        host.querySelector('#timeline-editor').innerHTML = data.timeline.map((x, i) => `<div class="timeline-row ${x.certainty === 'inferred' ? 'inferred' : ''}" data-event="${i}">
          <span class="timeline-dot"></span>${field('时间 / 顺序', 'when', x.when)}${field('事件', 'text', x.text)}
          <label class="wb-field">确定程度<select name="certainty">${[['explicit', '明确时间'], ['relative', '相对先后'], ['inferred', '推测']].map(([v, l]) => `<option value="${v}" ${v === x.certainty ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="wb-field">依据<select name="evidence">${evidenceOptions(x.evidence)}</select></label><button class="wb-button" data-remove-event="${i}" aria-label="移除事件">×</button></div>`).join('') || '<p class="wb-empty">从有依据的事件开始整理。</p>';
        host.querySelector('#relations-editor').innerHTML = data.relations.map((x, i) => `<div class="relation-row ${x.inferred ? 'inferred' : ''}" data-relation="${i}">
          ${field('实体 A', 'from', x.from)}<span class="relation-arrow">⇄</span>${field('关系', 'label', x.label)}${field('实体 B', 'to', x.to)}
          <label class="wb-field">依据<select name="evidence">${evidenceOptions(x.evidence)}</select></label>
          <label class="check-row"><input name="inferred" type="checkbox" ${x.inferred ? 'checked' : ''}> 推断</label><button class="wb-button" data-remove-relation="${i}" aria-label="移除关系">×</button></div>`).join('') || '<p class="wb-empty">为每一条关系保留依据。推断关系用虚线标识。</p>';
      }

      host.querySelector('#research-form').oninput = (e) => { if (e.target.name) { data[e.target.name] = e.target.value; persist(); } };
      host.oninput = (e) => {
        const eventRow = e.target.closest('[data-event]'), relationRow = e.target.closest('[data-relation]');
        const item = eventRow ? data.timeline[Number(eventRow.dataset.event)]
          : relationRow ? data.relations[Number(relationRow.dataset.relation)] : null;
        if (item && e.target.name) { item[e.target.name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; persist(); }
      };
      host.onchange = (e) => {
        const row = e.target.closest('[data-relation],[data-event]');
        if (row) row.classList.toggle('inferred', row.hasAttribute('data-relation') ? data.relations[Number(row.dataset.relation)].inferred : data.timeline[Number(row.dataset.event)].certainty === 'inferred');
      };
      host.onclick = async (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'research-save') persist();
        if (action === 'research-search') await search();
        if (action === 'add-event') { data.timeline.push({ when: '', text: '', certainty: 'explicit', evidence: '' }); draw(); persist(); }
        if (action === 'add-relation') { data.relations.push({ from: '', to: '', label: '', inferred: false, evidence: '' }); draw(); persist(); }

        const addSource = e.target.closest('[data-add-source]');
        if (addSource) {
          const src = JSON.parse(addSource.dataset.addSource);
          if (!collected.has(keyOf(src))) {
            data.sources.unshift({ type: src.type || '', title: src.title || '', heading: src.heading || '', text: src.text || '', sourceUrl: src.sourceUrl || '', characterName: src.characterName || '', ref: src.ref ?? null });
            collected.add(keyOf(src));
            drawSources(); drawHits(data.found); draw(); await persist();
          }
          return;
        }
        const drop = e.target.closest('[data-drop-source]');
        if (drop) {
          data.sources.splice(Number(drop.dataset.dropSource), 1);
          collected.clear(); data.sources.forEach((s) => collected.add(keyOf(s)));
          drawSources(); drawHits(data.found); draw(); await persist();
          return;
        }

        const re = e.target.closest('[data-remove-event]'), rr = e.target.closest('[data-remove-relation]'), ev = e.target.closest('[data-evidence]');
        if (re) { data.timeline.splice(Number(re.dataset.removeEvent), 1); draw(); persist(); }
        if (rr) { data.relations.splice(Number(rr.dataset.removeRelation), 1); draw(); persist(); }
        if (ev) openEvidence(ev.dataset.evidence);
      };

      drawSources(); drawHits(data.found); draw();
      if (!data.found) host.querySelector('#research-hits').innerHTML = '<p class="wb-empty">输入话题后点「检索」，这里会列出知识库里的原文依据。</p>';
    },
  };
})();
