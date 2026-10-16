/* Akasha · 练度规划
 *
 * 两件事放在一个文件里，因为它们是同一份渲染代码的两个入口：
 *   1. render(plan) —— 画一份规划（聊天里的 plan 块、抽屉里的结果，共用）
 *   2. 抽屉「我的角色」—— 维护玩家自己的角色清单，调 POST /v1/plan
 *
 * 为什么清单存在浏览器而不是服务端：
 *   所有客户端**共用同一个 token**，服务端拿不到用户身份。要存服务端得先建
 *   用户体系，那是另一期。放本地同时也更符合预期 —— 练度是个人的东西。
 *
 * 为什么规划不经过模型：
 *   它是算出来的。同样的输入永远给同样的输出，可复现、可核对、不产生幻觉，
 *   也不烧 token。模型只负责在聊天里**解释**这份结果。
 */
(function () {
  'use strict';

  var LS_KEY = 'akasha.roster.v1';
  var MAX_ROSTER = 20;
  var LEVELS = [1, 20, 40, 50, 60, 70, 80, 90];

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- 本地清单

  function loadRoster() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return { v: 1, chars: [], targetLevel: 90, prefer: 'balanced' };
      var o = JSON.parse(raw);
      if (!o || !Array.isArray(o.chars)) return { v: 1, chars: [], targetLevel: 90, prefer: 'balanced' };
      // 上限与去重在这里兜一次，避免历史数据把请求撑爆
      var seen = {}, chars = [];
      for (var i = 0; i < o.chars.length && chars.length < MAX_ROSTER; i++) {
        var c = o.chars[i];
        if (!c || !c.charId || seen[c.charId]) continue;
        seen[c.charId] = 1;
        chars.push({ charId: Number(c.charId), name: String(c.name || ''), level: Number(c.level) || 1 });
      }
      return {
        v: 1, chars: chars,
        targetLevel: Number(o.targetLevel) || 90,
        prefer: o.prefer || 'balanced',
      };
    } catch (e) {
      return { v: 1, chars: [], targetLevel: 90, prefer: 'balanced' };
    }
  }

  function saveRoster(r) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(r)); } catch (e) { /* 存不下就算了 */ }
  }

  // ---------------------------------------------------------------- 渲染

  /** 获取途径的中文名。 */
  var KIND_LABEL = {
    WORLD_BOSS: '世界BOSS', WEEKLY: '周本', DOMAIN: '秘境', LEYLINE: '地脉',
    GATHER: '采集', CRAFT: '合成', OTHER: '其它', CURRENCY: '货币', UNKNOWN: '未知',
  };

  function resinCell(m) {
    if (m.resin == null) return '<span class="pl-none">—</span>';
    // 标出这个值是不是来自观测枢，别让用户以为都是官方数据
    var tag = m.acquisition && m.acquisition.costSource === 'external'
      ? '<span class="pl-ext" title="观测枢没有该消耗值，按通行值编码，待核对">≈</span>' : '';
    return tag + esc(m.resin);
  }

  function sourceLink(url, label, cls) {
    var u = String(url || '');
    // 白名单：只放行观测枢。后端数据异常时不会把用户带去别处。
    if (!/^https:\/\/baike\.mihoyo\.com\//.test(u)) return '';
    return '<a class="' + (cls || 'pl-go') + '" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">'
      + esc(label) + '</a>';
  }

  function render(plan) {
    if (!plan || !plan.ok) {
      var msg = plan && plan.message ? plan.message : '规划没有结果';
      return '<div class="blk-none">（' + esc(msg) + '）</div>';
    }

    var out = [];

    // ── 总览 ──
    var s = plan.summary || {};
    out.push('<div class="pl-sum">' +
      '<div class="pl-kv"><b>' + esc(s.charCount || 0) + '</b><span>个角色</span></div>' +
      '<div class="pl-kv"><b>' + esc(s.materialKinds || 0) + '</b><span>种材料</span></div>' +
      '<div class="pl-kv"><b>' + esc((s.mora || 0).toLocaleString()) + '</b><span>摩拉</span></div>' +
      '<div class="pl-kv"><b>' + (s.resinIsUpperBound ? '≤' : '') + esc(s.resin || 0) + '</b><span>树脂</span></div>' +
      '<div class="pl-kv"><b>' + esc(s.days || 0) + '</b><span>天（按每日 ' + esc(s.dailyResin || 160) + '）</span></div>' +
      '</div>');

    // ── 行动清单 ──
    if ((plan.steps || []).length) {
      out.push('<div class="pl-sec"><h4>按这个顺序练</h4>');
      out.push((plan.steps || []).map(function (st) {
        var mats = (st.materials || []).map(function (m) {
          var ico = m.icon ? '<img class="pl-ico" src="' + esc(m.icon) + '" alt="" loading="lazy">' : '';
          return '<li>' + ico + '<span class="nm">' + esc(m.name) + '</span>' +
            '<span class="am">×' + esc(m.amount) + '</span>' +
            sourceLink(m.sourceUrl, '原文↗', 'pl-go sm') + '</li>';
        }).join('');
        return '<div class="pl-step">' +
          '<div class="pl-hd"><span class="ord">' + esc(st.order) + '</span>' +
          '<span class="who">' + esc(st.charName) + '</span>' +
          '<span class="lv">' + esc(st.from) + ' → ' + esc(st.to) + '</span>' +
          sourceLink(st.sourceUrl, '观测枢↗', 'pl-go sm') + '</div>' +
          '<div class="pl-stages">' + (st.stages || []).map(function (x) {
            return '<span class="pl-tag">' + esc(x) + '</span>';
          }).join('') + '</div>' +
          '<ul class="pl-mats">' + mats + '</ul>' +
          '<div class="pl-cost">摩拉 ' + esc((st.mora || 0).toLocaleString()) +
          (st.cost ? ' · 树脂 ≤' + esc(st.cost.resin) : '') + '</div>' +
          '</div>';
      }).join(''));
      out.push('</div>');
    }

    // ── 共用材料 ──
    if ((plan.conflicts || []).length) {
      out.push('<div class="pl-sec"><h4>共用材料（已经合并计费，不会重复刷）</h4><ul class="pl-cf">' +
        plan.conflicts.map(function (c) {
          return '<li><span class="nm">' + esc(c.material) + '</span>' +
            '<span class="am">共 ×' + esc(c.total) + '</span>' +
            '<span class="by">' + esc(c.usedBy.join('、')) + '</span></li>';
        }).join('') + '</ul></div>');
    }

    // ── 全局材料表 ──
    if ((plan.materials || []).length) {
      out.push('<div class="pl-sec"><h4>要刷的材料</h4><div class="pl-tw"><table class="pl-tbl">' +
        '<thead><tr><th>材料</th><th>数量</th><th>获取途径</th><th>树脂</th><th>原文</th></tr></thead><tbody>' +
        plan.materials.map(function (m) {
          var acq = m.acquisition || {};
          var alt = (acq.alternatives || []).filter(function (a) { return a.kind; })
            .map(function (a) { return KIND_LABEL[a.kind] || a.kind; }).join('/');
          return '<tr>' +
            '<td>' + (m.icon ? '<img class="pl-ico" src="' + esc(m.icon) + '" alt="" loading="lazy">' : '') + esc(m.name) + '</td>' +
            '<td class="num">×' + esc(m.amount) + '</td>' +
            '<td>' + esc(KIND_LABEL[acq.kind] || acq.kind || '—') +
            (alt ? '<span class="pl-alt" title="其它获取途径">+' + esc(alt) + '</span>' : '') + '</td>' +
            '<td class="num">' + resinCell(m) + '</td>' +
            '<td>' + sourceLink(m.sourceUrl, '↗') + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table></div></div>');
    }

    // ── 跳过 ──
    if ((plan.skipped || []).length) {
      out.push('<div class="pl-sec"><h4>没纳入规划的</h4><ul class="pl-sk">' +
        plan.skipped.map(function (x) {
          return '<li><b>' + esc(x.name || ('#' + x.charId)) + '</b> — ' + esc(x.reason) + '</li>';
        }).join('') + '</ul></div>');
    }

    // ── 说明（把不确定性摊开讲，不要藏在代码里）──
    if ((plan.notes || []).length) {
      out.push('<div class="pl-notes">' + plan.notes.map(function (n) {
        return '<div>· ' + esc(n) + '</div>';
      }).join('') + '</div>');
    }
    if (plan.rules) {
      out.push('<div class="pl-rules" title="消耗规则版本，出问题时用它追溯">规则 ' +
        esc(plan.rules.version) + '｜每日树脂 ' + esc(plan.rules.dailyResin) +
        (plan.rules.unverified && plan.rules.unverified.length
          ? '｜待核对：' + esc(plan.rules.unverified.join('、')) : '') + '</div>');
    }

    return out.join('');
  }

  // ---------------------------------------------------------------- 抽屉

  var els = {};
  var roster = loadRoster();
  var allChars = null;

  function ensureDom() {
    if (els.panel) return;
    var wrap = document.createElement('div');
    wrap.className = 'pl-wrap';
    wrap.innerHTML =
      '<div class="pl-mask" data-close></div>' +
      '<aside class="pl-panel" role="dialog" aria-label="我的角色">' +
        '<header class="pl-ph"><h3>我的角色</h3>' +
          '<button class="pl-x" data-close title="关闭">✕</button></header>' +
        '<div class="pl-body">' +
          '<div class="pl-row">' +
            '<label>目标等级</label>' +
            '<select id="pl-target">' + LEVELS.map(function (l) {
              return '<option value="' + l + '">' + l + '</option>';
            }).join('') + '</select>' +
            '<label>优先</label>' +
            '<select id="pl-prefer">' +
              '<option value="balanced">均衡</option>' +
              '<option value="dps">主C优先</option>' +
              '<option value="support">辅助优先</option>' +
              '<option value="completion">先收尾</option>' +
            '</select>' +
          '</div>' +
          '<div class="pl-row">' +
            '<input id="pl-search" type="search" placeholder="搜角色名，回车添加…" autocomplete="off">' +
          '</div>' +
          '<div id="pl-sug" class="pl-sug" hidden></div>' +
          '<ul id="pl-list" class="pl-list"></ul>' +
          '<div class="pl-hint" id="pl-hint">清单只存在这台机器上，不会上传。</div>' +
          '<button class="pl-run" id="pl-run">生成规划</button>' +
          '<div id="pl-out" class="pl-out" hidden></div>' +
        '</div>' +
      '</aside>';
    document.body.appendChild(wrap);

    els.wrap = wrap;
    els.panel = wrap.querySelector('.pl-panel');
    els.target = wrap.querySelector('#pl-target');
    els.prefer = wrap.querySelector('#pl-prefer');
    els.search = wrap.querySelector('#pl-search');
    els.sug = wrap.querySelector('#pl-sug');
    els.list = wrap.querySelector('#pl-list');
    els.hint = wrap.querySelector('#pl-hint');
    els.run = wrap.querySelector('#pl-run');
    els.out = wrap.querySelector('#pl-out');

    wrap.addEventListener('click', function (ev) {
      if (ev.target.hasAttribute('data-close')) close();
    });
    els.target.addEventListener('change', function () {
      roster.targetLevel = Number(els.target.value) || 90; saveRoster(roster);
    });
    els.prefer.addEventListener('change', function () {
      roster.prefer = els.prefer.value; saveRoster(roster);
    });
    els.search.addEventListener('input', onSearch);
    els.search.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        var first = els.sug.querySelector('[data-add]');
        if (first) { addChar(Number(first.getAttribute('data-add')), first.getAttribute('data-name')); }
      }
    });
    els.list.addEventListener('click', function (ev) {
      var rm = ev.target.closest('[data-rm]');
      if (rm) {
        var id = Number(rm.getAttribute('data-rm'));
        roster.chars = roster.chars.filter(function (c) { return c.charId !== id; });
        saveRoster(roster); paintList();
      }
    });
    els.list.addEventListener('change', function (ev) {
      var sel = ev.target.closest('[data-lv]');
      if (!sel) return;
      var id = Number(sel.getAttribute('data-lv'));
      var c = roster.chars.filter(function (x) { return x.charId === id; })[0];
      if (c) { c.level = Number(sel.value) || 1; saveRoster(roster); }
    });
    els.run.addEventListener('click', run);

    els.target.value = String(roster.targetLevel);
    els.prefer.value = roster.prefer || 'balanced';
  }

  function open() {
    ensureDom();
    els.wrap.classList.add('on');
    paintList();
  }
  function close() {
    if (els.wrap) els.wrap.classList.remove('on');
  }

  function paintList() {
    if (!roster.chars.length) {
      els.list.innerHTML = '<li class="pl-empty">还没有角色。上面搜一个加上。</li>';
      return;
    }
    els.list.innerHTML = roster.chars.map(function (c) {
      return '<li><span class="nm">' + esc(c.name) + '</span>' +
        '<select data-lv="' + esc(c.charId) + '">' + LEVELS.map(function (l) {
          return '<option value="' + l + '"' + (Number(c.level) === l ? ' selected' : '') + '>' + l + ' 级</option>';
        }).join('') + '</select>' +
        '<button data-rm="' + esc(c.charId) + '" title="移除">✕</button></li>';
    }).join('');
  }

  function addChar(charId, name) {
    if (!charId) return;
    if (roster.chars.some(function (c) { return c.charId === charId; })) {
      flash('已经在清单里了');
      return;
    }
    if (roster.chars.length >= MAX_ROSTER) {
      flash('一次最多 ' + MAX_ROSTER + ' 个角色');
      return;
    }
    roster.chars.push({ charId: charId, name: name, level: 1 });
    saveRoster(roster);
    paintList();
    els.sug.hidden = true;
    els.search.value = '';
  }

  function flash(msg) {
    if (!els.hint) return;
    els.hint.textContent = msg;
    setTimeout(function () { els.hint.textContent = '清单只存在这台机器上，不会上传。'; }, 2200);
  }

  var searchTimer = null;
  function onSearch() {
    clearTimeout(searchTimer);
    var q = els.search.value.trim();
    if (!q) { els.sug.hidden = true; return; }
    searchTimer = setTimeout(function () {
      if (!allChars) {
        // 角色表拉一次就够（它是静态资料，不像练度会变）
        fetch('/v1/query?domain=character&limit=100')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            allChars = (j && j.items) || [];
            suggest(q);
          })
          .catch(function () { els.sug.hidden = true; });
      } else {
        suggest(q);
      }
    }, 180);
  }

  function suggest(q) {
    var hit = (allChars || []).filter(function (c) {
      return (c.name || '').indexOf(q) >= 0 || (c.pinyin || '').toLowerCase().indexOf(q.toLowerCase()) >= 0;
    }).slice(0, 8);
    if (!hit.length) { els.sug.hidden = true; return; }
    els.sug.innerHTML = hit.map(function (c) {
      return '<button data-add="' + esc(c.id) + '" data-name="' + esc(c.name) + '">' +
        esc(c.name) + '<span class="sub">' + esc(c.element || '') + ' · ' +
        (c.rarity ? esc(c.rarity) + '★' : '') + '</span></button>';
    }).join('');
    els.sug.hidden = false;
    els.sug.onclick = function (ev) {
      var b = ev.target.closest('[data-add]');
      if (b) addChar(Number(b.getAttribute('data-add')), b.getAttribute('data-name'));
    };
  }

  function run() {
    if (!roster.chars.length) { flash('先加一个角色'); return; }
    els.run.disabled = true;
    els.run.textContent = '算…';
    fetch('/v1/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roster: roster.chars.map(function (c) { return { charId: c.charId, level: c.level }; }),
        target: { level: roster.targetLevel },
        prefer: roster.prefer,
      }),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
      var plan = res.body;
      if (!res.ok) {
        // 服务端把错误放在 error.code / error.message（ApiError 的形状）
        var e = (plan && plan.error) || {};
        els.out.innerHTML = '<div class="blk-none">规划失败：' + esc(e.message || e.code || '未知错误') + '</div>';
      } else {
        els.out.innerHTML = render(plan);
      }
      els.out.hidden = false;
    }).catch(function () {
      els.out.innerHTML = '<div class="blk-none">连不上知识库。检查一下服务是否在跑。</div>';
      els.out.hidden = false;
    }).then(function () {
      els.run.disabled = false;
      els.run.textContent = '生成规划';
    });
  }

  // ---------------------------------------------------------------- 入口

  window.AkashaPlanner = {
    render: render,
    open: open,
    close: close,
    /** 给外部（比如聊天里的按钮）用：把这份清单带去问模型。 */
    rosterFor: function () {
      return roster.chars.map(function (c) { return { charId: c.charId, level: c.level }; });
    },
  };

  // 顶栏按钮注入。放在 DOMContentLoaded 之后是因为 app.js 也在同一次里跑，
  // 而顶栏节点那时才齐。
  function mountButton() {
    var top = document.querySelector('.top');
    if (!top || document.getElementById('pl-open')) return;
    var b = document.createElement('button');
    b.className = 'icon';
    b.id = 'pl-open';
    // 主入口是**在聊天框里说话**（见 lib/blocks.mjs 的 plan 意图）。
    // 这个抽屉是「维护清单」用的 —— 十几个角色逐个报等级，打字太累。
    b.title = '我的角色 · 维护练度清单（也可以直接在聊天里说「胡桃80级练到90要什么」）';
    b.setAttribute('aria-label', '我的角色');
    b.textContent = '📋';
    b.addEventListener('click', open);
    var reset = document.getElementById('reset');
    top.insertBefore(b, reset || null);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton);
  } else {
    mountButton();
  }
})();
