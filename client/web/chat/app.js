/* 类 GPT 前端 · 逻辑
 *
 * 把知识库内置的 AI 抽出来独立使用：
 *   浏览器 → POST /kb/api/chat (SSE) → 知识库服务 → 检索增强 + deepseek-flash
 * 前端只做四件事：解析事件流、渲染带引用的回答、把 [n] 变成可跳转链接、本地存会话。
 */
(function () {
  'use strict';

  var LS_CONVOS = 'dsh-chat-front/conversations/v1';
  var LS_THINK = 'dsh-chat-front/think';

  var STARTERS = [
    '胡桃是谁',
    '钟离和往生堂是什么关系',
    '雷电将军的语音',
    '往生堂是什么样的地方',
    '采药相关的书籍记载',
    '芙宁娜的角色故事',
  ];

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    side: $('side'), menu: $('menu'), new: $('new'), convos: $('convos'),
    model: $('model'), dot: $('dot'),
    title: $('title'), provider: $('provider'), reset: $('reset'),
    log: $('log'), input: $('input'), send: $('send'), think: $('think'), hint: $('hint'),
    main: $('main'), nav: $('side-nav'), viewSkills: $('view-skills'),
    picked: $('picked'), pickedIco: $('picked-ico'), pickedName: $('picked-name'), pickedX: $('picked-x'),
  };

  // ⚠ 这里**曾经**有一个 cfg = { kbLink: ... }，以及基于它拼地址的 kbUrl()。
  //   两个都已删除 —— 客户端里不再保留任何"知识库地址"的概念。
  //
  //   删掉的理由：kbLink 曾经是「引用 chip 能不能点」的开关，而它的值来自服务端
  //   /config.json（本地模式会填成 http://127.0.0.1:5178/）。也就是说，
  //   一个**配置文件就能把这个客户端变回"能打开知识库本体"**。
  //   一个改配置就破的约束不叫约束，所以现在连这个概念都不存在了：
  //   引用恒为不可点的标签，要看原文用浏览器开 5178。
  var state = {
    convos: [],
    curId: null,
    streaming: false,
    abort: null,
    think: false,
    botEl: null,
    botMsg: null,
    // 已选技能（点技能卡来的）。只作用于**下一次**提问，发完就清 ——
    // 否则用户会以为它一直生效，问别的也被这个技能接管。
    skill: '',
    skillLabel: '',
    paintQueued: false,
  };

  // ------------------------------------------------------------------ 工具

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 观测枢原文外链。
   *
   * 为什么要有：本产品的资料取自米游社观测枢（米哈游自营）。如果只吸收、不把用户
   * 送回官方来源，形态上就是「替代官方来源」—— 米哈游诉「游创工坊」一案的判决书
   * 正是以「导致《原神》用户流量有所减少」「产生了一定的替代效果」作为认定理由之一。
   * 所以每个能定位到官方词条的地方都要给出回链。
   *
   * 域名做白名单：只放行观测枢。后端数据异常时不会把用户带去别处。
   * 与「引用 chip 不可点」的既有约定不冲突 —— 那是禁止暴露本机知识库界面，
   * 这里是官方外链，性质相反。
   */
  function obsSourceLink(url, label) {
    var u = String(url || '');
    if (!/^https:\/\/baike\.mihoyo\.com\//.test(u)) return '';
    return '<a class="src-go" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer"' +
      ' title="在米游社观测枢查看该条目原文">' + esc(label || '观测枢原文↗') + '</a>';
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  var toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove('on'); }, 2200);
  }

  // ------------------------------------------------------------------ 渲染：Markdown

  /** 行内：先转义，再支持 **粗体**、`代码`、[n] 引用。 */
  function inline(raw) {
    return esc(raw)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(\d{1,2})\]/g, '<span class="cite" data-ref="$1">[$1]</span>');
  }

  /** 块级：``` 代码块、### 标题、有序/无序列表、> 引用、段落。 */
  function rich(text) {
    var lines = String(text || '').split(/\r?\n/);
    var out = [];
    var list = null;
    var code = null;

    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    function closeCode() {
      if (code !== null) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = line.trim();

      if (/^```/.test(t)) { if (code === null) { closeList(); code = []; } else { closeCode(); } continue; }
      if (code !== null) { code.push(line); continue; }

      if (!t) { closeList(); continue; }

      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) {
        closeList();
        var lv = Math.min(6, h[1].length + 2);
        out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
        continue;
      }
      if (/^[-*]\s+/.test(t)) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>');
        continue;
      }
      var om = /^\d+[.)]\s+(.*)$/.exec(t);
      if (om) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(om[1]) + '</li>');
        continue;
      }
      if (/^>\s?/.test(t)) { closeList(); out.push('<blockquote>' + inline(t.replace(/^>\s?/, '')) + '</blockquote>'); continue; }

      closeList();
      out.push('<p>' + inline(t) + '</p>');
    }
    closeCode(); closeList();
    return out.join('');
  }

  // ------------------------------------------------------------------ 存储

  async function loadConvos() {
    state.convos=await window.AkashaStore.loadConversations();
    state.convos.forEach(c=>(c.messages||[]).forEach(m=>{if(m.streaming){m.streaming=false;m.aborted=true;m.error='上次生成已中断，可重试。';}}));
    try{state.think=localStorage.getItem(LS_THINK)==='1';}catch{}
  }
  function saveConvos() {
    window.AkashaStore.saveConversations(state.convos).catch(()=>{});
  }

  function cur() {
    for (var i = 0; i < state.convos.length; i++) if (state.convos[i].id === state.curId) return state.convos[i];
    return null;
  }

  function newConvo(activate) {
    var c = { id: uid(), title: '新对话', at: Date.now(), messages: [] };
    state.convos.unshift(c);
    if (activate !== false) state.curId = c.id;
    saveConvos();
    renderSidebar();
    if (activate !== false) renderLog();
    return c;
  }

  // ------------------------------------------------------------------ 渲染：侧栏

  function renderSidebar() {
    if (!state.convos.length) {
      els.convos.innerHTML = '<div class="empty-list">还没有对话。<br>点上面「新对话」开始。</div>';
      return;
    }
    els.convos.innerHTML = state.convos.map(function (c) {
      return '<div class="convo' + (c.id === state.curId ? ' on' : '') + '" data-id="' + c.id + '">' +
        '<span class="t">' + esc(c.title) + '</span>' +
        '<button class="del" data-del="' + c.id + '" title="删除">✕</button></div>';
    }).join('');
  }

  // ------------------------------------------------------------------ 渲染：消息

  // ------------------------------------------------------------------ 渲染：结构化答案块
  //
  // 六种块的渲染器。块是纯数据（见 kb-viz/lib/blocks.mjs），这里只负责画。
  // 全部走 esc()，块里的文本来自知识库，不信任。

  function blockBody(b) {
    switch (b.kind) {
      case 'image': return blockImage(b);
      case 'voice-list': return blockVoice(b);
      case 'relation-graph': return blockRelation(b);
      case 'stat-table': return blockStat(b);
      case 'list': return blockList(b);
      case 'timeline': return blockTimeline(b);
      case 'talent': return blockTalent(b);
      case 'constellation': return blockConstellation(b);
      case 'ascension': return blockAscension(b);
      case 'video-scenes': return window.AkashaMedia ? window.AkashaMedia.render(b) : '';
      // 练度规划：渲染器与「我的角色」抽屉放在 planner.js 里（照 AkashaMedia 的挂法），
      // 这样抽屉和聊天两处**共用同一份渲染代码**，样式不会走偏。
      case 'plan': return window.AkashaPlanner ? window.AkashaPlanner.render(b) : '';
      default: return '<div class="blk-none">（未支持的结果类型：' + esc(b.kind) + '）</div>';
    }
  }

  /** 天赋：可折叠，倍率表横向滚动。 */
  function blockTalent(b) {
    return (b.items || []).map(function (t) {
      var mul = '';
      if (t.multipliers) {
        mul = '<div class="blk-tw blk-mul">' + '<table class="blk-tbl"><thead><tr>' +
          t.multipliers.header.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + t.multipliers.rows.map(function (r) {
            return '<tr>' + r.map(function (c, i) {
              return i === 0 ? '<th class="rowh">' + esc(c) + '</th>' : '<td>' + esc(c) + '</td>';
            }).join('') + '</tr>';
          }).join('') + '</tbody></table>' +
          (t.multipliers.truncated ? '<div class="blk-hint">倍率表已截断，完整表请在知识库查看</div>' : '') + '</div>';
      }
      return '<details class="blk-vg"' + (t.multipliers ? ' open' : '') + '>' +
        '<summary>' + esc(t.title || t.tab) + '<span class="cnt">' + esc(t.tab) + '</span></summary>' +
        '<div class="blk-line blk-desc">' + esc(t.desc || '') + '</div>' + mul + '</details>';
    }).join('');
  }

  /** 命之座：序号 + 名称 + 描述。 */
  function blockConstellation(b) {
    var note = b.incomplete
      ? '<div class="blk-warn">' + esc(b.note || '') + '</div>' : '';
    var list = (b.items || []).map(function (c) {
      return '<div class="blk-cons">' +
        '<div class="hd"><span class="idx">' + c.index + '</span>' +
        (c.icon ? '<img class="ico" src="' + esc(c.icon) + '" alt="" loading="lazy">' : '') +
        '<span class="nm">' + esc(c.name) + '</span></div>' +
        (c.desc ? '<div class="ds">' + esc(c.desc) + '</div>' : '<div class="ds muted">（观测枢未填写描述）</div>') +
        '</div>';
    }).join('');
    return note + list;
  }

  /** 培养材料：分阶段，材料带图标与数量。 */
  function blockAscension(b) {
    return (b.items || []).map(function (s) {
      return '<div class="blk-stage"><h4>' + esc(s.stage) + '</h4>' +
        '<div class="blk-mats">' + (s.materials || []).map(function (m) {
          return '<figure title="' + esc(m.name) + '">' +
            (m.icon ? '<img src="' + esc(m.icon) + '" alt="" loading="lazy">' : '<span class="noimg"></span>') +
            '<figcaption>' + esc(m.name) + ' ×' + m.amount + '</figcaption></figure>';
        }).join('') + '</div></div>';
    }).join('') + (b.truncated ? '<div class="blk-hint">还有更多阶段未显示</div>' : '');
  }

  function blockImage(b) {
    if (!b.items || !b.items.length) return '';
    // compact：问到某个角色时附的视觉锚点，不该占掉整屏
    return '<div class="blk-imgs' + (b.compact ? ' compact' : '') + '">' + b.items.map(function (i) {
      return '<figure><img src="' + esc(i.url) + '" alt="' + esc(i.label) + '" loading="lazy">' +
        (b.compact ? '' : '<figcaption>' + esc(i.label) + '</figcaption>') + '</figure>';
    }).join('') + '</div>';
  }

  function blockVoice(b) {
    return (b.groups || []).map(function (g) {
      return '<details class="blk-vg"><summary>' + esc(g.name) +
        '<span class="cnt">· ' + g.count + ' 条</span></summary>' +
        (g.lines || []).map(function (l) {
          return '<div class="blk-line"><b>' + esc(l.name) + '</b><span>' + esc(l.text) + '</span></div>';
        }).join('') + '</details>';
    }).join('');
  }

  function blockRelation(b) {
    var nodes = b.nodes || [], edges = b.edges || [];
    if (!nodes.length) return '';
    var others = nodes.filter(function (n) { return !n.self; });
    var W = 720, H = Math.max(300, others.length * 26);
    var cx = W / 2, cy = H / 2, rad = Math.min(W, H) / 2 - 48;
    var pos = {};
    pos[nodes[0].id] = [cx, cy];
    others.forEach(function (n, i) {
      var a = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
      pos[n.id] = [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad * 0.92];
    });
    var svg = edges.map(function (e) {
      var p = pos[e.from], q = pos[e.to];
      if (!p || !q) return '';
      return '<line class="blk-edge" x1="' + p[0].toFixed(1) + '" y1="' + p[1].toFixed(1) +
        '" x2="' + q[0].toFixed(1) + '" y2="' + q[1].toFixed(1) + '">' +
        '<title>' + esc(e.quote || '') + '</title></line>';
    }).join('');
    svg += nodes.map(function (n) {
      var p = pos[n.id];
      if (!p) return '';
      var cls = n.self ? 'blk-ns' : (n.kind === 'character' ? 'blk-nc' : 'blk-nx');
      var anchor = n.self ? 'middle' : (p[0] < cx - 8 ? 'end' : p[0] > cx + 8 ? 'start' : 'middle');
      var dx = n.self ? 0 : (p[0] < cx - 8 ? -12 : p[0] > cx + 8 ? 12 : 0);
      var dy = n.self ? 5 : (Math.abs(p[0] - cx) <= 8 ? (p[1] < cy ? -12 : 18) : 5);
      return '<circle class="' + cls + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) +
        '" r="' + (n.self ? 11 : 7) + '"/>' +
        '<text x="' + (p[0] + dx).toFixed(1) + '" y="' + (p[1] + dy).toFixed(1) +
        '" text-anchor="' + anchor + '">' + esc(n.name) + '</text>';
    }).join('');
    return '<svg class="blk-graph" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
      svg + '</svg><div class="blk-hint">悬停连线看原话 · 蓝=库内角色，黄=概念/物品</div>';
  }

  function blockStat(b) {
    var kv = (b.profile || []).map(function (p) {
      return '<div><b>' + esc(p.k) + '</b><span>' + esc(p.v) + '</span></div>';
    }).join('');
    // 档案不完整时如实说明。观测枢只收「可玩角色」页，所以派蒙、戴因斯雷布、
    // 愚人众执行官这些剧情角色**源头就没有角色档案** —— 端一张空表会让用户
    // 以为是我们没做全（考据党尤其在意「派蒙怎么没有档案」）。
    var warn = b.incomplete && b.note
      ? '<div class="blk-warn">' + esc(b.note) + '</div>' : '';
    var tables = (b.tables || []).map(function (t) {
      return '<div class="blk-slot"><h4>' + esc(t.slot) +
        '<span class="cnt">共 ' + t.total + ' 条' + (t.truncated ? '，此处前 ' + t.rows.length + ' 条' : '') + '</span></h4>' +
        tableHtml(t.columns, t.rows) + '</div>';
    }).join('');
    return warn + (kv ? '<div class="blk-kv">' + kv + '</div>' : '') + tables +
      obsSourceLink(b.sourceUrl, '该角色在观测枢的原条目↗');
  }

  function blockList(b) {
    return tableHtml(b.columns, b.rows) +
      (b.truncated ? '<div class="blk-hint">共 ' + b.total + ' 条，此处只显示前 ' + b.rows.length + ' 条</div>' : '');
  }

  function blockTimeline(b) {
    return '<div class="blk-tl">' + (b.items || []).map(function (i) {
      return '<div class="blk-ti"><div class="hd"><span class="t">' + esc(i.title) + '</span>' +
        '<span class="p">' + esc(i.page || '') + (i.era ? ' · ' + esc(i.era) : '') + '</span></div>' +
        '<div class="e">' + esc(i.excerpt) + '</div></div>';
    }).join('') + '</div>';
  }

  function tableHtml(columns, rows) {
    if (!columns || !rows || !rows.length) return '';
    // 单元格可以是字符串，也可以是 { text, icon } ——
    // 推荐表里「护摩之杖」这类条目要带缩略图（用户要的是"武器信息 + 武器图片"）。
    // 认不出对象就退化成纯文字，不会因为少了图就渲染不出来。
    function cell(c) {
      if (c && typeof c === 'object') {
        var img = c.icon
          ? '<img class="blk-ico" src="' + esc(c.icon) + '" alt="" loading="lazy">'
          : '';
        return '<td>' + img + '<span>' + esc(c.text == null ? '' : c.text) + '</span></td>';
      }
      return '<td>' + esc(c) + '</td>';
    }
    return '<div class="blk-tw"><table class="blk-tbl"><thead><tr>' +
      columns.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(function (r) {
        return '<tr>' + r.map(cell).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function blocksHtml(m) {
    if (!m.blocks || !m.blocks.length) {
      return m.blocksDropped
        ? '<div class="blk-none">（这条结果的结构化内容已因本地存储空间不足被清理，可在提问里重发一次）</div>'
        : '';
    }
    return '<div class="blocks">' + m.blocks.map(function (b) {
      return '<section class="blk blk-' + esc(b.kind) + '">' +
        '<header><h3>' + esc(b.title) + '</h3>' +
        (b.subtitle ? '<span class="sub">' + esc(b.subtitle) + '</span>' : '') + '</header>' +
        blockBody(b) +
        (b.source ? '<footer>来源：' + esc(b.source) + '</footer>' : '') +
        '</section>';
    }).join('') + '</div>';
  }

  /** 依据强度 + 引用审计：让用户一眼看出这段话可不可信。 */
  function trustHtml(m) {
    var bits = [];
    var g = m.grounding;
    if (g) {
      var lv = g.level;
      bits.push('<span class="tb ' + (lv === 'ok' ? 'ok' : lv === 'weak' ? 'warn' : 'bad') + '">' +
        (lv === 'ok' ? '依据充分' : lv === 'weak' ? '依据较弱' : '无检索结果') + '</span>');
      if (g.refused) bits.push('<span class="tb bad">已拒答 · 未调用模型</span>');
      else if (g.anchors && g.anchors.length) {
        bits.push('<span class="tb">命中 ' + g.anchors.map(function (a) { return esc(a.name); }).join('、') + '</span>');
      }
    }
    var a = m.audit;
    if (a) {
      var cls = a.verdict === 'pass' ? 'ok' : a.verdict === 'warn' ? 'warn' : 'bad';
      var label = a.verdict === 'pass' ? '引用审计通过' : a.verdict === 'warn' ? '部分句子无引用' : '存在无据内容';
      bits.push('<span class="tb ' + cls + '" title="' + esc(a.note || '') + '">' +
        label + ' · ' + a.cited + '/' + a.claims + ' 句有据</span>');
    }
    if (!bits.length) return '';
    return '<div class="trust">' + bits.join('') + '</div>';
  }

  function msgHtml(m, i) {
    if (m.role === 'user') {
      return '<div class="wrap"><div class="msg user" data-mi="' + i + '">' +
        '<div class="who"><span class="ava">你</span>你</div>' +
        '<div class="body">' + esc(m.text) + '</div></div></div>';
    }

    // 深度思考：生成中显示进度条，生成完保留可展开的「思考过程」。
    // 两者不冲突 —— 进度是「正在做什么」，思考内容是「想了什么」。
    var think = '';
    if (m.streaming) {
      think += '<div class="answer-progress">' + esc(m.phase || '正在检索资料') + '</div>';
    }
    if (m.thinking) {
      think += '<details class="think"><summary>思考过程 · ' + m.thinking.length + ' 字</summary>' +
        '<div class="tbody">' + esc(m.thinking) + '</div></details>';
    }
    var body = m.text ? rich(m.text)
      : (m.error ? '' : '<span class="cursor"></span>');

    var sources = '';
    if (m.sources && m.sources.length) {
      // 引用 chip **一律是标签，不是链接**，无条件。
      //
      // 这里以前按「本机有没有知识库浏览器界面」分叉：有值就渲染成 <a target="_blank">，
      // 没有就渲染成 span。问题是"有值"这件事可以被配置改出来 ——
      // 于是本地模式下引用变成可点链接，一点就打开知识库本体（5178），
      // 而桌面端旧的回环白名单还恰好允许它开新窗。
      //
      // 现在把这个分支整个删掉：客户端里不再存在"能渲染出知识库链接"的代码。
      // 原文本来就在 chip 的悬停提示里（tip），要看整条用浏览器开 5178。
      //
      // ── 例外：观测枢原文外链 ──────────────────────────────────────────
      // 这是**官方来源的外链**，和上面删掉的「知识库本体链接」不是一回事：
      // 它不暴露任何本机服务，而且「把用户送回官方来源」正是我们要的形态 ——
      // 只吸收、不送回，会被读成替代官方来源（见 engine/lib/obc.mjs 顶部的判例说明）。
      // 域名做白名单：只放行观测枢，后端数据异常时不会把用户带去别处。
      sources = '<div class="sources"><span class="lbl">引用</span>' + m.sources.map(function (s) {
        var tip = String(s.text || '').replace(/\s+/g, ' ').slice(0, 160);
        var inner = '<em>[' + esc(s.ref) + ']</em><span>' + esc(s.title) + '</span>';
        var chip = '<span class="src src-plain" title="' + esc(tip) + '">' + inner + '</span>';
        return chip + obsSourceLink(s.sourceUrl, '原文↗');
      }).join('') + '</div>';
    }

    var note = '';
    if (m.provider === 'extractive') {
      note = '<div class="note warn">检索模式 · 未接入生成模型，返回知识库原文摘录</div>';
    } else if (m.provider) {
      // 只显示耗时。
      // 以前这里写的是「openai · koboldcpp/qwen2.5-7b-instruct-q4_k_m-00001-of-00002 · 2.5s」——
      // 那是**运维视角**，不该出现在客户的界面上：
      //   客户不关心后面接的是哪家模型、更不该看到 "koboldcpp" 这种自建服务的名字。
      // 模型名保留在 title 里，需要排查时鼠标悬停能看到。
      note = '<div class="note"' +
        (m.model ? ' title="' + esc((m.provider || '') + (m.model ? ' · ' + m.model : '')) + '"' : '') + '>' +
        (m.elapsedMs ? (m.elapsedMs / 1000).toFixed(1) + 's' : '') + '</div>';
    }

    var err = m.error ? '<div class="err">' + esc(m.error) + '</div>' : '';

    var acts = '<div class="acts">' +
      (m.answerId ? '<button data-evidence-id="'+esc(m.answerId)+'">查看依据</button>' : '') +
      '<button data-collect="'+i+'">加入研究</button><button data-to-plan="'+i+'">转为计划</button>' +
      '<button data-copy="' + i + '">复制</button>' +
      (m.error ? '<button data-retry="' + i + '">重试</button>'
               : (m.streaming ? '' : '<button data-regen="' + i + '">重新生成</button>')) +
      '</div>';

    return '<div class="wrap"><div class="msg bot" data-mi="' + i + '">' +
      '<div class="who"><span class="ava">AI</span>Akasha</div>' +
      think + '<div class="answer-basis">'+(m.grounding?.refused ? '尚无足够依据' : m.provider==='extractive' ? '资料摘录 · 直接记载' : '模型归纳 / 推断 · 请核对依据')+'</div>'+ (m.migrationNote?'<p class="note warn">'+esc(m.migrationNote)+'</p>':'') + trustHtml(m) +
      // 块排在文字**前面**：模型在有块时会回「上面就是全部」，
      // 所以必须先有「上面」，否则那句话指不到东西。
      blocksHtml(m) +
      '<div class="body">' + body + '</div>' + sources + err + note + acts + '</div></div>';
  }

  function emptyHtml() {
    return '<div class="hero">' +
      '<div class="big">💬</div>' +
      '<h2>Akasha</h2>' +
      // 首屏这句话是定位，不是功能列表。
      // 早先写「检索知识库作答」—— 那是把它当搜索框。它的价值在
      // 「把散落在官方原典里的东西变成能直接用的结论」，且**每条可回溯**。
      '<p>二游垂直 AI 工作台 · 事实取自官方原典，结论逐条可回溯</p>' +
      '<div class="starters">' + STARTERS.map(function (s) {
        return '<button class="starter" data-say="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('') + '</div></div>' +
      // 这里曾经有一片「能做这些」技能条。去掉了 ——
      // 左侧「技能」已经是一级导航，再在首屏铺十几个 chip 是重复且拥挤的，
      // 用户会自己点。首屏只留最能让人开口的那几个例子。
      '';
  }

  var modelCache = '';
  function modelName() { return modelCache; }

  /**
   * 切主区视图：'chat' | 'skills'。
   *
   * 技能是**一级导航**（侧栏与「对话」并列），不是浮层 ——
   * 用户第一次打开就该看见「这东西能干什么」。
   * 切换靠 data-view 属性 + CSS 控制显隐，不重排 DOM（重排会丢滚动位置和焦点）。
   */
  function setView(view) {
    if(window.AkashaWorkbench) window.AkashaWorkbench.shell(view);
    var v = view === 'skills' ? 'skills' : 'chat';
    if (els.main) els.main.dataset.view = v;
    if (els.nav) {
      Array.prototype.forEach.call(els.nav.querySelectorAll('[data-nav]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-nav') === v);
      });
    }
    // 技能视图下会话列表没意义，收掉它，把侧栏的空间让给导航
    if (els.side) els.side.classList.toggle('hide-convos', v === 'skills');
    if (els.viewSkills) els.viewSkills.hidden = v !== 'skills';
    if (v === 'skills' && window.AkashaSkills) window.AkashaSkills.paintView();
    if (v === 'chat' && els.input) els.input.focus();
  }

  /** 会话列表只在对话视图里出现（技能视图下点会话没意义）。 */
  function activeView() {
    return els.main && els.main.dataset.view === 'skills' ? 'skills' : 'chat';
  }

  // ---------------------------------------------------------------- 已选技能

  var HINT_DEFAULT = '结论逐条可回溯官方原文 · 试试「胡桃80级练到90要什么」';

  /**
   * 挂上一个技能（点技能卡来的）。**不发消息** —— 用户接下来自己说要问什么。
   *
   * 技能是「用什么工具」不是「问什么问题」。早先点卡片直接发一条写死的例子，
   * 于是永远只能看到胡桃 —— 那是把工具当成了快捷回复。
   *
   * @param {{id:string,label:string,icon:string,example:string}} s
   */
  function setSkill(s) {
    if (!s || !s.id) return clearSkill();
    state.skill = s.id;
    state.skillLabel = s.label || s.id;
    if (els.picked) {
      if (els.pickedIco) els.pickedIco.textContent = s.icon || '✦';
      if (els.pickedName) els.pickedName.textContent = s.label || s.id;
      els.picked.hidden = false;
    }
    // placeholder 直接把「你可以这么问」摆出来 —— 比只说「已选某技能」有用
    if (els.input) {
      els.input.placeholder = s.example
        ? '用「' + (s.label || s.id) + '」问点什么…比如「' + s.example + '」'
        : '用「' + (s.label || s.id) + '」问点什么…';
      els.input.focus();
    }
    if (els.hint) els.hint.textContent = '已选技能：' + (s.label || s.id) + ' · 它只管这一次提问';
  }

  function clearSkill() {
    state.skill = '';
    state.skillLabel = '';
    if (els.picked) els.picked.hidden = true;
    if (els.input) els.input.placeholder = '问点什么…（Enter 发送，Shift + Enter 换行）';
    if (els.hint) els.hint.textContent = HINT_DEFAULT;
  }

  function renderLog() {
    var c = cur();
    els.title.textContent = c ? c.title : '新对话';
    if (!c || !c.messages.length) {
      els.log.innerHTML = emptyHtml();
      state.botEl = null;
      return;
    }
    els.log.innerHTML = c.messages.map(msgHtml).join('');
    state.botEl = null;
  }

  function nearBottom() {
    return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 120;
  }
  function scrollDown(force) {
    if (force || nearBottom()) els.log.scrollTop = els.log.scrollHeight;
  }

  // ------------------------------------------------------------------ 流式问答

  function schedulePaint() {
    if (state.paintQueued) return;
    state.paintQueued = true;
    requestAnimationFrame(function () {
      state.paintQueued = false;
      var m = state.botMsg;
      var box = state.botEl;
      if (!m || !box) return;
      var body = box.querySelector('.body');
      if (body) body.innerHTML = rich(m.text) + (m.streaming ? '<span class="cursor"></span>' : '');
      var think = box.querySelector('.think');
      if (!think && m.thinking) {
        // 思考过程是后到的，插到 body 前面
        var d = document.createElement('details');
        d.className = 'think';
        d.innerHTML = '<summary>思考过程 · ' + m.thinking.length + ' 字</summary>' +
          '<div class="tbody">' + esc(m.thinking) + '</div>';
        box.insertBefore(d, body);
      } else if (think && m.thinking) {
        think.querySelector('.tbody').textContent = m.thinking;
        think.querySelector('summary').textContent = '思考过程 · ' + m.thinking.length + ' 字';
      }
      scrollDown(false);
    });
  }

  async function ask(text) {
    var c = cur() || newConvo();
    var wasFirst = c.messages.length === 0;

    c.messages.push({ role: 'user', text: text, at: Date.now() });
    if (wasFirst) {
      c.title = text.replace(/\s+/g, ' ').slice(0, 22) || '新对话';
      els.title.textContent = c.title;
      renderSidebar();
    }

    var bot = {
      role: 'bot', text: '', sources: [], thinking: '',
      provider: '', model: '', streaming: true, at: Date.now(),
      // 结构化块与两个护栏结论。块要持久化：模型在有块时会回「上面就是全部」，
      // 刷新后如果把块丢了，那句话就指不到任何东西。
      blocks: [], grounding: null, audit: null,
    };
    c.messages.push(bot);
    saveConvos();

    // 全量重画后抓住这条 bot 的 DOM 引用，后续只局部更新
    els.log.innerHTML = c.messages.map(msgHtml).join('');
    var idx = c.messages.length - 1;
    state.botMsg = bot;
    state.botEl = els.log.querySelector('.msg.bot[data-mi="' + idx + '"]');
    state.botWrap = state.botEl ? state.botEl.parentNode : null;   // .wrap，收尾替换要用它
    scrollDown(true);

    setStreaming(true);
    state.abort = new AbortController();
    var t0 = Date.now();

    try {
      // 带上「我的角色」清单：规划那类问题要按这个号算，而清单只存在本地
      // （服务端拿不到用户身份 —— 所有客户端共用同一个 token）。
      // 没有清单时传空数组，服务端会退回「只按问题里点名的角色」算。
      var roster = (window.AkashaPlanner && window.AkashaPlanner.rosterFor)
        ? window.AkashaPlanner.rosterFor() : [];
      // skill：用户在界面上明确选的技能。服务端会把它排在路由结果之前 ——
      // 他点了「角色档案」才来问「钟离是谁」，不该再靠正则猜。
      var skillId = state.skill || '';
      clearSkill();   // 只作用于这一次
      var res = await fetch('/v1/chat?gameId='+window.AkashaStore.gameId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: text, sessionId: 'web-' + c.id, think: state.think, roster: roster, skill: skillId }),
        signal: state.abort.signal,
      });
      if (!res.ok) {
        var t = await res.text().catch(function () { return ''; });
        var msg = 'HTTP ' + res.status;
        try { var j = JSON.parse(t); if (j.error) msg = j.error.message || msg; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }

      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var done = false;

      while (!done) {
        var r = await reader.read();
        if (r.done) break;
        if(!bot.lastSaved || Date.now()-bot.lastSaved>1200){bot.lastSaved=Date.now();saveConvos();}
        buf += dec.decode(r.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          var payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          var ev;
          try { ev = JSON.parse(payload); } catch (e) { continue; }
          if (ev.type === 'delta') { bot.text += ev.text || ''; schedulePaint(); }
          else if (ev.type === 'evidence') { bot.answerId=ev.answerId;bot.corpusRevision=ev.revision; }
          else if(ev.type === 'progress'){bot.phase=ev.label;schedulePaint();}
          else if (ev.type === 'sources') { bot.sources = ev.sources || []; schedulePaint(); }
          else if (ev.type === 'thinking') { bot.thinking = (bot.thinking || '') + (ev.text || ''); schedulePaint(); }
          // 依据强度（ok / weak / none）与硬拒答标记
          else if (ev.type === 'grounding') { bot.grounding = ev; schedulePaint(); }
          // 结构化答案块：图片 / 语音 / 关系图 / 数据表 / 列表 / 时间轴
          else if (ev.type === 'blocks') { bot.blocks = ev.blocks || []; schedulePaint(); }
          // 引用审计：逐句核对 [n] 是否指向真实来源
          else if (ev.type === 'audit') { bot.audit = ev; }
          else if (ev.type === 'error') { bot.error = ev.message || '生成失败，请重试。'; schedulePaint(); }
          else if (ev.type === 'provider') {
            bot.provider = ev.provider;
            bot.model = ev.model;
            // 以实际使用的 provider 为准更新状态栏（extractive = 模型没派上用场）
            if (ev.provider === 'extractive') {
              degraded = ev.reason || '未接入生成模型';
            } else if (ev.provider) {
              degraded = null;
              // 真的生成过一次回答 = 链路确实通。
              // 必须记这一笔，不能只靠 /kb/api/chat/status 判断 ——
              // 客户端模式下知识库在服务端，那个**内部**接口不对外暴露，
              // 探测必然失败。结果就是：回答、立绘、引用全都正常出来了，
              // 左下角却写着「未连接」（笔记本实测遇到过）。
              servedOnce = true;
            }
            paintStatus();
          }
          else if (ev.type === 'done') {
            bot.failed = ev.failed === true;
            if (bot.failed && !bot.error) bot.error = '回答未完成，请重试。';
            bot.elapsedMs = ev.elapsedMs;
            if (ev.answer) bot.text = ev.answer;
            if (ev.grounding) bot.grounding = ev.grounding;
            if (ev.audit) bot.audit = ev.audit;
          }
        }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        bot.error = null;
        bot.aborted = true;
        if (!bot.text) bot.text = '（已停止）';
      } else {
        bot.error = (err && err.message) || String(err);
      }
    } finally {
      bot.streaming = false;
      bot.elapsedMs = bot.elapsedMs || (Date.now() - t0);
      setStreaming(false);
      state.abort = null;
      saveConvos();
      // 收尾重画这一条（补上引用/元信息/操作按钮）。
      // 注意：替换的是外层 .wrap，不是 .msg.bot —— 否则会把新 .wrap 嵌进旧 .wrap 里。
      var html = msgHtml(bot, idx);
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      if (state.botWrap && state.botWrap.parentNode) {
        state.botWrap.parentNode.replaceChild(tmp.firstChild, state.botWrap);
      }
      state.botEl = els.log.querySelector('.msg.bot[data-mi="' + idx + '"]');
      state.botWrap = null;
      state.botMsg = null;
      scrollDown(false);
    }
  }

  function setStreaming(on) {
    state.streaming = on;
    els.send.classList.toggle('stop', on);
    els.send.title = on ? '停止生成' : '发送';
    els.send.disabled = false;
    els.send.innerHTML = on
      ? '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 12l15-7-6.2 15-2.1-6.1L4 12z" fill="currentColor"/></svg>';
    // 客户端模式连的是远端知识库，写「本地」是错的
    els.hint.textContent = on ? '生成中…（点右侧按钮可停止）' : '回答基于知识库检索，带 [n] 引用';
  }

  // ------------------------------------------------------------------ 服务端状态

  // /api/chat/status 只报告「配置」——即使端点根本连不上，它照样说 provider=openai。
  // 所以真实可用性以**生成时实际用的 provider** 为准：一旦降级过就记住，
  // 直到下一次真的用上模型为止。否则状态栏会在模型挂掉时显示绿灯，误导人。
  var degraded = null;   // null = 未知/正常；字符串 = 降级原因

  // 真的生成过一次回答吗。
  // 为什么需要它：状态探测打的是 /kb/api/chat/status —— 知识库的**内部**接口。
  // 客户端模式下知识库在服务端，那个接口不对外暴露（只放行了 /v1），
  // 探测必然失败，于是回答/立绘/引用全都正常出来了，左下角却写着「未连接」。
  // 用户看到这个只会以为坏了。生成成功是**最强的证据**，用它兜底。
  var servedOnce = false;

  /**
   * 左下角状态 + 顶栏那个小药丸。
   *
   * 原则：**这里给客户看的是「能不能用」，不是「后面接了什么」。**
   * 以前直接把 provider 和 model 名贴上去，结果界面上写着
   *   openai · koboldcpp/qwen2.5-7b-instruct-q4_k_m-00001-of-00002
   * ——自建服务名、量化档位、分片序号全暴露了，客户既看不懂也不该看。
   * 换成三档人话：在线 / 检索模式 / 未连接。技术细节留在 title 里（悬停可见），
   * 排查问题时够用，正常使用时看不见。
   */
  function paintStatus() {
    const detail = [(statusProvider || ''), (statusModel || '')].filter(Boolean).join(' · ');
    const pill = els.provider;

    if (degraded !== null) {
      var localMode = statusCorpusConfigured && statusProvider === 'extractive';
      els.dot.className = 'dot ' + (localMode ? 'local' : 'bad');
      els.model.textContent = localMode ? '本机检索' : '检索模式';
      els.model.title = degraded || '生成模型不可用，已降级为原文摘录';
      pill.hidden = false;
      pill.textContent = localMode ? '本机模式' : '检索模式';
      pill.title = degraded || '';
      return;
    }

    // statusReady 是「配置探测」，servedOnce 是「实际跑通过」。
    // 后者更可信，两者满足其一就算在线。
    const ready = statusReady || servedOnce;
    els.dot.className = 'dot ' + (ready ? 'ok' : 'bad');
    els.model.textContent = !statusCorpusConfigured ? '未配置资料库' : ready ? '在线' : '未连接';
    els.model.title = (detail ? detail + '\n' : '') + (statusReason || '');
    pill.hidden = !ready;
    pill.textContent = '在线';
    pill.title = detail;
  }

  var statusCorpusConfigured = true;
  var statusReady = false;
  var statusProvider = '';
  var statusModel = '';
  var statusReason = '';

  function refreshStatus() {
    fetch('/v1/status').then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error && body.error.message || body.message || '连接不上服务端');
        return body;
      });
    }).then(function (j) {
      statusProvider = j.provider || '';
      statusModel = j.model || '';
      statusReason = j.reason || '';
      modelCache = j.model || '';
      statusReady = !!j.ready;
      if (j.capabilities && j.capabilities.corpus === false) {
        servedOnce = false; degraded = null; statusCorpusConfigured = false;
      } else {
        statusCorpusConfigured = true;
        degraded = j.provider === 'extractive' ? (j.reason || '生成模型不可用，已降级为摘录') : null;
      }
      paintStatus();
    }).catch(function (error) {
      statusReady = false; statusReason = error.message; paintStatus();
    });
  }

  // ------------------------------------------------------------------ 事件绑定

  els.new.addEventListener('click', function () {
    newConvo();
    setView('chat');          // 从技能视图点「新对话」要回到对话
    els.input.focus();
    if (window.innerWidth <= 720) els.side.classList.remove('open');
  });

  // 一级导航：对话 / 技能
  if (els.nav) {
    els.nav.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-nav]');
      if (b && ['chat','skills'].includes(b.getAttribute('data-nav'))) { setView(b.getAttribute('data-nav')); if (window.innerWidth <= 720) els.side.classList.remove('open'); }
    });
  }

  els.convos.addEventListener('click', function (ev) {
    var del = ev.target.closest('[data-del]');
    if (del) {
      ev.stopPropagation();
      var id = del.getAttribute('data-del');
      state.convos = state.convos.filter(function (c) { return c.id !== id; });
      window.AkashaStore.removeConversation(id).catch(e=>toast(e.message));
      if (state.curId === id) state.curId = state.convos.length ? state.convos[0].id : null;
      saveConvos(); renderSidebar(); renderLog();
      return;
    }
    var row = ev.target.closest('.convo');
    if (row) {
      state.curId = row.getAttribute('data-id');
      renderSidebar(); renderLog();
      setView('chat');        // 点会话 = 要看那条对话
      if (window.innerWidth <= 720) els.side.classList.remove('open');
    }
  });

  els.menu.addEventListener('click', function () { els.side.classList.toggle('open'); });

  // 取消已选技能
  if (els.pickedX) els.pickedX.addEventListener('click', clearSkill);

  // ⚠ 这里原本绑了一个「打开知识库」按钮的点击（window.open(kbUrl('#/'))）。
  //   按钮和事件都已删除：客户端不该有任何通往知识库本体的入口。
  //   桌面端也同步把 setWindowOpenHandler 改成一律 deny —— 两层都堵上，
  //   免得将来谁又加回一个链接就重新打开这条通道。

  els.reset.addEventListener('click', function () {
    var c = cur();
    if (!c) return;
    fetch('/v1/chat/reset?gameId='+window.AkashaStore.gameId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'web-' + c.id }),
    }).then(function (r) { if(!r.ok)throw Error('reset failed'); toast('已清空该会话的服务端上下文（本地记录保留）'); })
      .catch(function () { toast('重置失败'); });
  });

  els.think.addEventListener('click', function () {
    state.think = !state.think;
    try { localStorage.setItem(LS_THINK, state.think ? '1' : '0'); } catch (e) { /* ignore */ }
    els.think.classList.toggle('on', state.think);
    els.think.textContent = state.think ? '🧠 深度思考 · 开' : '💡 深度思考 · 关';
    els.think.title = state.think ? '深度思考：开（模型先推理再作答，较慢但更强）' : '深度思考：关（快速作答）';
  });

  // 输入框：自适应高度 + Enter 发送
  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(200, els.input.scrollHeight) + 'px';
  }
  els.input.addEventListener('input', autoGrow);
  els.input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submit();
    }
  });

  els.send.addEventListener('click', function () {
    if (state.streaming) { if (state.abort) state.abort.abort(); return; }
    submit();
  });

  function submit() {
    if (state.streaming) return;
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = '';
    autoGrow();
    ask(text);
  }

  // 起始提示 / 引用跳转 / 复制 / 重生成
  els.log.addEventListener('click', function (ev) {
    var evidence=ev.target.closest('[data-evidence-id]'),collect=ev.target.closest('[data-collect]'),plan=ev.target.closest('[data-to-plan]');
    if(evidence){window.AkashaWorkbench.openEvidence(evidence.dataset.evidenceId);return;}
    if(collect||plan){var mi=Number(collect?collect.dataset.collect:plan.dataset.toPlan);window.AkashaWorkbench.collect(cur().messages[mi],collect?'research':'growth').catch(e=>toast(e.message));return;}
    var st = ev.target.closest('[data-say]');
    if (st) { ask(st.getAttribute('data-say')); return; }

    var cite = ev.target.closest('.cite');
    if (cite) {
      var ref = Number(cite.getAttribute('data-ref'));
      var msgEl = cite.closest('.msg');
      var mi = msgEl ? Number(msgEl.getAttribute('data-mi')) : -1;
      var cc0 = cur();
      var m0 = cc0 && cc0.messages[mi];
      var list = (m0 && m0.sources) || [];
      var hit = null;
      for (var i = 0; i < list.length; i++) if (Number(list[i].ref) === ref) hit = list[i];
      // ⚠ 以前这里 window.open 到知识库原文 —— 那是通往知识库本体的路径，已删除。
      //   引用内容本来就在本轮对话里（下方「引用」的 chip 带悬停提示），
      //   提示一下即可，不需要跳出客户端。
      if (hit) toast('[' + ref + '] ' + (hit.title || '') + ' · 原文见下方「引用」');
      else toast('引用 [' + ref + '] 在下方「引用」里有原文');
      return;
    }

    var cp = ev.target.closest('[data-copy]');
    if (cp) {
      var idx = Number(cp.getAttribute('data-copy'));
      var cc = cur();
      var mm = cc && cc.messages[idx];
      if (mm) {
        var txt = mm.text || '';
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast('已复制'); });
        else toast('当前环境不支持剪贴板');
      }
      return;
    }

    var rg = ev.target.closest('[data-regen]');
    if (rg) {
      var ri = Number(rg.getAttribute('data-regen'));
      var rc = cur();
      if (!rc) return;
      for (var k = ri - 1; k >= 0; k--) {
        if (rc.messages[k].role === 'user') {
          var q = rc.messages[k].text;      // 先取文本，再连同这一轮的 bot 回答一起砍掉
          rc.messages.splice(k);
          saveConvos();
          ask(q);
          return;
        }
      }
      return;
    }

    var rt = ev.target.closest('[data-retry]');
    if (rt) {
      var ti = Number(rt.getAttribute('data-retry'));
      var tc = cur();
      if (!tc) return;
      var q = null;
      for (var j = ti - 1; j >= 0; j--) if (tc.messages[j].role === 'user') { q = tc.messages[j].text; break; }
      if (q) { tc.messages.splice(ti, 1); saveConvos(); ask(q); }
    }
  });

  // ------------------------------------------------------------------ 启动

  async function boot() {
    try { await window.AkashaStore.init(); } catch(e) { document.getElementById("save-state").textContent="连接失败 · 点击重新加载"; document.getElementById("save-state").onclick=()=>location.reload(); els.send.disabled=true;document.getElementById("wb-notice").textContent=e.message;return; }
    await loadConvos();

    els.think.classList.toggle('on', state.think);
    els.think.textContent = state.think ? '🧠 深度思考 · 开' : '💡 深度思考 · 关';

    // 这里原本 fetch('/config.json') 取 kbLink（决定引用 chip 能不能点）。
    // 那个概念已整个删除，所以这次请求也没必要了 —— 界面不再依赖任何
    // 来自服务端的"知识库地址"。直接渲染。
    renderLog();

    if (state.convos.length) {
      state.curId = state.convos[0].id;
    } else {
      newConvo();
    }
    renderSidebar();
    renderLog();
    refreshStatus();
    setInterval(refreshStatus, 20000);
    autoGrow();
    await window.AkashaWorkbench.init();
  }

  // 对外暴露的最小接口。
  //
  // 为什么需要：技能面板在侧栏是**一级导航**，点一个技能要能真的跑起来 ——
  // 而 ask() 在 app.js 的闭包里（它管会话状态、流式渲染、引用）。让 skills.js
  // 自己再造一套发送逻辑，就是两份实现、两处 bug。
  // 只暴露 ask 一个函数，不给别的 —— 暴露面越小越不容易被绕过。
  window.AkashaChat = {
    ask: ask,
    /** 切到对话视图（技能卡点完要回到对话看结果）。 */
    showChat: function () { setView('chat'); },
    /** 切到技能视图（空白页的「还有 N 个在路上」要能跳过来）。 */
    showSkills: function () { setView('skills'); },
    /** 挂上一个技能（点技能卡来的）。只作用于下一次提问。 */
    setSkill: setSkill,
    clearSkill: clearSkill,
  };

  boot();
})();
