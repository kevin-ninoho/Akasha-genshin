(function () {
  window.AkashaViews.research = {
    async render(host, data, ui) {
      const { esc, field, area, button, heading, save, flash, openEvidence } = ui;
      data.evidence ||= []; data.timeline ||= []; data.relations ||= [];
      host.innerHTML = heading('RESEARCH / ARCHIVE', '研究档案', '原文依据与个人判断分开记录。', button('保存档案', 'research-save', 'primary')) +
        `<div class="editor-grid"><form id="research-form" class="wb-panel">
        ${field('专题标题', 'title', data.title)}${area('研究问题', 'question', data.question, 2)}
        ${area('个人笔记', 'notes', data.notes, 7)}${area('待核实事项', 'questions', data.questions, 3)}
        ${area('当前结论', 'conclusion', data.conclusion, 4)}
        </form><div><section class="wb-panel"><h3>依据收集</h3><p class="muted">在回答下点击“加入研究”，保留该回答的证据标识。</p>
        ${data.evidence.map((id,i) => `<button class="evidence-entry" data-evidence="${esc(id)}">◇ 依据组 ${i+1} <span>查看 / 对照 →</span></button>`).join('') || '<p class="wb-empty">尚未收集依据</p>'}
        <p class="wb-callout">剧透提示：当前资料缺少可靠的章节标注，尚未过滤剧透。</p></section>
        <section class="wb-panel"><h3>标注约定</h3><p>明确时间：资料直接给出。<br>相对先后：只确定顺序。<br>推测：需要进一步核实。</p><p class="muted">关系与时间线是你的研究整理，不会自动被视为官方结论。</p></section></div></div>
        <section class="wb-panel"><div class="section-heading"><h3>时间线</h3>${button('＋ 添加事件', 'add-event')}</div><div id="timeline-editor"></div></section>
        <section class="wb-panel"><div class="section-heading"><h3>关系记录</h3>${button('＋ 添加关系', 'add-relation')}</div><div id="relations-editor"></div></section>`;
      const persist = () => save(data).catch(e => flash(e.message));
      host.querySelector('#research-form').oninput = e => { if(e.target.name){ data[e.target.name]=e.target.value; persist(); } };
      function evidenceOptions(value) {
        return `<option value="">未关联依据</option>${data.evidence.map((id,i)=>`<option value="${esc(id)}" ${id===value?'selected':''}>依据组 ${i+1}</option>`).join('')}`;
      }
      function draw() {
        host.querySelector('#timeline-editor').innerHTML = data.timeline.map((x,i)=>`<div class="timeline-row ${x.certainty==='inferred'?'inferred':''}" data-event="${i}">
          <span class="timeline-dot"></span>${field('时间 / 顺序','when',x.when)}${field('事件','text',x.text)}
          <label class="wb-field">确定程度<select name="certainty">${[['explicit','明确时间'],['relative','相对先后'],['inferred','推测']].map(([v,l])=>`<option value="${v}" ${v===x.certainty?'selected':''}>${l}</option>`).join('')}</select></label>
          <label class="wb-field">依据<select name="evidence">${evidenceOptions(x.evidence)}</select></label><button class="wb-button" data-remove-event="${i}" aria-label="移除事件">×</button></div>`).join('') || '<p class="wb-empty">从有依据的事件开始整理。</p>';
        host.querySelector('#relations-editor').innerHTML = data.relations.map((x,i)=>`<div class="relation-row ${x.inferred?'inferred':''}" data-relation="${i}">
          ${field('实体 A','from',x.from)}<span class="relation-arrow">⟶</span>${field('关系','label',x.label)}${field('实体 B','to',x.to)}
          <label class="wb-field">依据<select name="evidence">${evidenceOptions(x.evidence)}</select></label>
          <label class="check-row"><input name="inferred" type="checkbox" ${x.inferred?'checked':''}> 推断</label><button class="wb-button" data-remove-relation="${i}" aria-label="移除关系">×</button></div>`).join('') || '<p class="wb-empty">为每一条关系保留依据，推断关系使用虚线标识。</p>';
      }
      host.oninput = e => {
        const event=e.target.closest('[data-event]'), relation=e.target.closest('[data-relation]');
        const item=event?data.timeline[Number(event.dataset.event)]:relation?data.relations[Number(relation.dataset.relation)]:null;
        if(item&&e.target.name){item[e.target.name]=e.target.type==='checkbox'?e.target.checked:e.target.value;persist();}
      };
      host.onchange = e => {
        const row=e.target.closest('[data-relation],[data-event]');
        if(row)row.classList.toggle('inferred', row.hasAttribute('data-relation')?data.relations[Number(row.dataset.relation)].inferred:data.timeline[Number(row.dataset.event)].certainty==='inferred');
      };
      host.onclick = e => {
        const action=e.target.closest('[data-action]')?.dataset.action;
        if(action==='research-save')persist();
        if(action==='add-event'){data.timeline.push({when:'',text:'',certainty:'explicit',evidence:''});draw();persist();}
        if(action==='add-relation'){data.relations.push({from:'',to:'',label:'',inferred:false,evidence:''});draw();persist();}
        const re=e.target.closest('[data-remove-event]'),rr=e.target.closest('[data-remove-relation]'),ev=e.target.closest('[data-evidence]');
        if(re){data.timeline.splice(Number(re.dataset.removeEvent),1);draw();persist();}
        if(rr){data.relations.splice(Number(rr.dataset.removeRelation),1);draw();persist();}
        if(ev)openEvidence(ev.dataset.evidence);
      };
      draw();
    },
  };
})();
