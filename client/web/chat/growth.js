(function () {
  window.AkashaViews.growth = {
    async render(host, data, ui) {
      const { esc, field, area, button, heading, S, save, flash, isCurrent } = ui;
      data.roster ||= []; data.target ||= {level:90}; data.inventory ||= {}; data.checked ||= {};
      host.innerHTML=heading('GROWTH / JOURNEY','养成计划','先填写角色现状，再根据实际资料计算。',button('计算需求','calculate','primary'))+
        `<div class="editor-grid"><section class="wb-panel">${field('计划名称','title',data.title)}
        <div class="form-row">${field('目标等级','target',data.target.level,'number')}${field('每日树脂预算（用于缺口估算）','daily',data.daily||160,'number')}</div>
        <div class="search-row"><input id="character-search" placeholder="搜索角色名称" aria-label="搜索角色名称">${button('查找角色','search-character')}</div><div id="character-results"></div>
        <div id="roster-editor"></div>${area('计划备注','notes',data.notes,3)}</section>
        <section class="wb-panel"><span class="eyebrow">CALCULATION</span><h3>可核对的规划</h3><p>材料需求由程序计算；缺失资料单独列出，不猜测。</p><p class="wb-callout">当前计算覆盖已接入的角色突破材料。经验消耗、武器与天赋需求未纳入时，不会被视为完整养成总成本。</p><div id="growth-summary"></div></section></div>
        <section class="wb-panel"><div class="section-heading"><h3>材料缺口与每日行动</h3><span class="muted">库存与勾选进度自动保存</span></div><div id="materials-table"></div></section>`;
      const persist=()=>save(data).catch(e=>flash(e.message));
      function roster(){
        host.querySelector('#roster-editor').innerHTML=data.roster.map((c,i)=>`<div class="roster-row">${c.charId!=null?`<img class="roster-portrait" src="/v1/asset/character/${encodeURIComponent(c.charId)}?size=display" alt="${esc(c.name)}立绘" loading="lazy" decoding="async">`:'<span class="roster-portrait-placeholder" aria-hidden="true">✧</span>'}<div class="roster-details"><strong>${esc(c.name)}</strong><label>当前等级 <input data-level="${i}" type="number" min="1" max="90" value="${c.level}"></label></div><button class="wb-button" data-remove="${i}" aria-label="移除 ${esc(c.name)}">×</button></div>`).join('')||'<p class="wb-empty">搜索并加入你想培养的角色。</p>';
      }
      function result(){
        const r=data.result;
        if(!r){host.querySelector('#materials-table').innerHTML='<p class="wb-empty">加入角色后点击“计算需求”。</p>';return;}
        const materials=r.materials||[];
        let resin=0,unknown=false;
        for(const m of materials){const missing=Math.max(0,m.amount-(data.inventory[m.name]||0));if(missing&&m.resin==null)unknown=true;else resin+=m.amount?Math.ceil((m.resin||0)*missing/m.amount):0;}
        host.querySelector('#growth-summary').innerHTML=`<div class="metric-row"><div><b>${r.summary.charCount}</b><span>已纳入角色</span></div><div><b>${materials.length}</b><span>材料种类</span></div><div><b>${Math.ceil(resin/(data.daily||160))}${unknown?'+':''}</b><span>估算天数</span></div></div><p class="muted">按库存比例估算树脂 ${resin}；${unknown?'部分材料来源或成本未知，天数不完整。':'实际掉落可能不同。'}</p>${(r.skipped||[]).map(x=>`<p class="wb-callout">未纳入：${esc(x.name||x.charId)} · ${esc(x.reason||'资料不完整')}</p>`).join('')}<details><summary>计算参数与资料限制</summary><pre>${esc(JSON.stringify({notes:r.notes,rules:r.rules},null,2))}</pre></details>`;
        host.querySelector('#materials-table').innerHTML=`<div class="table-scroll"><table class="wb-table"><thead><tr><th>完成</th><th>材料</th><th>总需求</th><th>已有</th><th>缺口</th><th>行动 / 依据</th></tr></thead><tbody>${materials.map((m,i)=>`<tr><td><input type="checkbox" data-check="${i}" ${data.checked[m.name]?'checked':''} aria-label="完成 ${esc(m.name)}"></td><td>${esc(m.name)}</td><td>${m.amount}</td><td><input type="number" min="0" data-inventory="${i}" value="${data.inventory[m.name]||0}" aria-label="${esc(m.name)} 库存"></td><td class="material-gap">${Math.max(0,m.amount-(data.inventory[m.name]||0))}</td><td>${esc(m.acquisition?.note||'获取途径未配置')}<small>${m.acquisition?.costSource==='external'?'消耗值为规则估计，待核实':'按现有资料计算'}</small></td></tr>`).join('')}</tbody></table></div>`;
      }
      host.oninput=e=>{
        const el=e.target;
        if(el.name==='title'||el.name==='notes'){data[el.name]=el.value;persist();}
        if(el.name==='target'){data.target.level=Math.min(90,Math.max(1,Number(el.value)||1));data.result=null;result();persist();}
        if(el.name==='daily'){data.daily=Math.max(1,Number(el.value)||160);result();persist();}
        if(el.hasAttribute('data-level')){data.roster[Number(el.dataset.level)].level=Math.min(90,Math.max(1,Number(el.value)||1));data.result=null;result();persist();}
      };
      host.onchange=e=>{
        const el=e.target;
        if(el.hasAttribute('data-inventory')){data.inventory[data.result.materials[Number(el.dataset.inventory)].name]=Math.max(0,Number(el.value)||0);result();persist();}
        if(el.hasAttribute('data-check')){data.checked[data.result.materials[Number(el.dataset.check)].name]=el.checked;persist();}
      };
      host.onclick=async e=>{
        const action=e.target.closest('[data-action]')?.dataset.action,remove=e.target.closest('[data-remove]'),add=e.target.closest('[data-add-character]');
        try {
          if(remove){data.roster.splice(Number(remove.dataset.remove),1);data.result=null;roster();result();await persist();}
          if(add){if(data.roster.length>=20)throw Error('每套计划最多 20 个角色');const c=JSON.parse(add.dataset.addCharacter);if(!data.roster.some(x=>x.charId===c.id)){data.roster.push({charId:c.id,name:c.name,level:1});data.result=null;roster();result();await persist();}}
          if(action==='search-character'){
            const q=host.querySelector('#character-search').value.trim();if(!q)return;
            const j=await S.api('/v1/query?domain=character&limit=12&q='+encodeURIComponent(q));if(!isCurrent())return;
            host.querySelector('#character-results').innerHTML=(j.items||[]).map(c=>`<button class="character-choice" data-add-character="${esc(JSON.stringify({id:c.id,name:c.name}))}"><img src="/v1/asset/character/${encodeURIComponent(c.id)}?size=display" alt="" loading="lazy" decoding="async"><span>＋ ${esc(c.name)}</span></button>`).join('')||'<p>没有找到角色，请检查名称或资料库。</p>';
          }
          if(action==='calculate'){
            const b=e.target.closest('button');b.disabled=true;flash('正在按本机资料计算…');
            try{data.result=await S.api('/v1/plan',{roster:data.roster,target:data.target});await save(data);if(isCurrent()){result();flash('计算完成，计划已保存。');}}finally{b.disabled=false;}
          }
        }catch(err){flash(err.message);}
      };
      roster();result();
    },
  };
})();
