/* Akasha · 技能
 *
 * 解决的是「界面太干净，用户不知道这东西能干嘛」。
 *
 * **技能是侧栏的一级导航**（与「对话」并列），点开在主区占一整屏 —— 照豆包的排版：
 * 左边分类、右边卡片、点卡片就选中它。不是浮层，也不是藏在图标后面的按钮。
 *
 * 数据来自 GET /v1/skills。
 *
 * 状态三档必须区分清楚：可用 / 测试中 / 计划中。
 * 把没做的技能画成能点的，是骗人；但完全不画，用户就不知道这东西要往哪长。
 *
 * ⚠ 这里曾经还有一片「空白页技能条」（renderStrip/paintStrip），已删除：
 *   左侧已经是一级导航，再在首屏铺十几个 chip 是重复且拥挤的。
 */
(function () {
  'use strict';

  var CACHE = null;        // 目录只拉一次
  var inflight = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var STATUS = {
    ready: { mark: '●', label: '可用', cls: 'sk-ready' },
    beta: { mark: '◐', label: '测试中', cls: 'sk-beta' },
    planned: { mark: '○', label: '计划中', cls: 'sk-planned' },
  };

  function load() {
    if (CACHE) return Promise.resolve(CACHE);
    if (inflight) return inflight;
    inflight = fetch('/v1/skills')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        CACHE = j;
        inflight = null;
        // 侧栏导航上挂个数量，让人知道这里有多少东西
        var badge = document.getElementById('nav-skill-count');
        if (badge && j && j.counts) badge.textContent = String(j.counts.ready + j.counts.beta);
        return j;
      })
      .catch(function () { inflight = null; return null; });
    return inflight;
  }

  function flat(cat) {
    return (cat && cat.categories ? cat.categories : []).reduce(function (a, c) {
      return a.concat((c.skills || []).map(function (s) {
        return Object.assign({ category: c.label, categoryIcon: c.icon }, s);
      }));
    }, []);
  }

  /**
   * 选一个技能：**不发消息**，只是把它挂到输入框上方当模式。
   *
   * 这是整个交互的关键。技能是「用什么工具」不是「问什么问题」——
   * 用户点了「角色档案」，接下来要打的是「钟离是谁」，不是替他把「胡桃是谁」发出去。
   * 早先的实现点一下就发写死的例子，于是永远只能看到胡桃。
   *
   * 走 app.js 的 setSkill()：输入框、placeholder、取消按钮都在那边管，
   * 这里只管把「用户点了哪个」转过去。
   */
  function pick(skillId) {
    if (!skillId) return;
    var s = CACHE ? flat(CACHE).find(function (x) { return x.id === skillId; }) : null;
    var payload = {
      id: skillId,
      label: s ? s.label : skillId,
      icon: s ? s.icon : '✦',
      example: (s && s.examples && s.examples[0]) || '',
    };
    if (window.AkashaChat && window.AkashaChat.setSkill) {
      window.AkashaChat.setSkill(payload);
      if (window.AkashaChat.showChat) window.AkashaChat.showChat();
    } else {
      // 兜底：把例子填进输入框，至少不让点击没反应
      var input = document.getElementById('input');
      if (payload.example && input) { input.value = payload.example; input.focus(); }
    }
  }

  /** 兼容旧调用名（之前是 run(text) 直接发）。 */
  function run(text) {
    if (!text) return;
    if (window.AkashaChat && window.AkashaChat.ask) {
      if (window.AkashaChat.showChat) window.AkashaChat.showChat();
      window.AkashaChat.ask(text);
    } else {
      var input = document.getElementById('input');
      if (input) { input.value = text; input.focus(); }
    }
  }

  // ---------------------------------------------------------------- 技能视图（主区整屏）

  /** 左边分类锚点 + 右边卡片。窄屏时分类横排。 */
  function paintView() {
    var host = document.getElementById('view-skills');
    if (!host) return;
    load().then(function (cat) {
      host = document.getElementById('view-skills');
      if (!host) return;
      if (!cat) {
        host.innerHTML = '<div class="sk-view-pad"><div class="sk-loading">技能清单拿不到，检查服务是否在跑。</div></div>';
        return;
      }
      var cats = (cat.categories || []).filter(function (c) { return c.skills && c.skills.length; });
      host.innerHTML =
        '<div class="sk-view">' +
          '<aside class="sk-rail">' +
            '<div class="sk-rail-t">技能</div>' +
            '<div class="sk-rail-n">已就绪 ' + cat.counts.ready +
              ' · 测试中 ' + cat.counts.beta + ' · 计划中 ' + cat.counts.planned + '</div>' +
            cats.map(function (c, i) {
              var ready = c.skills.filter(function (s) { return s.status === 'ready'; }).length;
              return '<button class="sk-rail-i' + (i === 0 ? ' on' : '') + '" data-cat="' + esc(c.id) + '">' +
                '<span class="ri">' + esc(c.icon) + '</span>' + esc(c.label) +
                '<span class="rn">' + ready + '</span></button>';
            }).join('') +
          '</aside>' +
          '<div class="sk-cards" id="sk-cards">' +
            cats.map(function (c) {
              return '<section class="sk-sec" id="sk-sec-' + esc(c.id) + '">' +
                '<div class="sk-sec-h"><h4><span class="sk-cico">' + esc(c.icon) + '</span>' + esc(c.label) + '</h4>' +
                '<span class="sk-sec-d">' + esc(c.desc || '') + '</span></div>' +
                '<div class="sk-grid">' +
                c.skills.map(function (s) {
                  var st = STATUS[s.status] || STATUS.ready;
                  var clickable = s.status !== 'planned';
                  var ex = (s.examples || [])[0] || '';
                  return '<button class="sk-card ' + st.cls + (clickable ? '' : ' sk-off') + '"' +
                    (clickable ? ' data-skill="' + esc(s.id) + '"' : ' disabled') + '>' +
                    '<div class="sk-card-h">' +
                      '<span class="sk-ico2">' + esc(s.icon) + '</span>' +
                      '<span class="sk-lb">' + esc(s.label) + '</span>' +
                      '<span class="sk-badge ' + st.cls + '">' + st.mark + ' ' + st.label + '</span>' +
                    '</div>' +
                    '<div class="sk-ds">' + esc(s.description) + '</div>' +
                    (ex ? '<div class="sk-eg">' + esc(ex) + '</div>' : '') +
                    (s.external ? '<div class="sk-ext">需要外部算力，可接入自己的</div>' : '') +
                    '</button>';
                }).join('') +
                '</div></section>';
            }).join('') +
          '</div>' +
        '</div>';

      // 点卡片就跑
      host.addEventListener('click', onViewClick);
      // 左栏分类：滚到对应段落
      var rail = host.querySelector('.sk-rail');
      if (rail) {
        rail.addEventListener('click', function (ev) {
          var b = ev.target.closest('[data-cat]');
          if (!b) return;
          var sec = document.getElementById('sk-sec-' + b.getAttribute('data-cat'));
          if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
          Array.prototype.forEach.call(rail.querySelectorAll('[data-cat]'), function (x) {
            x.classList.toggle('on', x === b);
          });
        });
      }
    });
  }

  function onViewClick(ev) {
    var card = ev.target.closest('[data-skill]');
    if (card) { pick(card.getAttribute('data-skill')); }
  }

  // ---------------------------------------------------------------- 入口

  window.AkashaSkills = {
    paintView: paintView,
    pick: pick,
    run: run,
    /** 有目录缓存时按 id 取技能元数据（app.js 画 chip 时用）。 */
    info: function (id) {
      if (!CACHE) return null;
      return flat(CACHE).find(function (s) { return s.id === id; }) || null;
    },
  };

  // 点技能（技能视图的卡）→ **只挂模式，不发消息**。
  // 之所以不交给 app.js 的全局 [data-say] 处理器：那个是直接 ask()，
  // 会把写死的例子发出去（于是永远只能看到胡桃）。技能不是快捷问题。
  document.addEventListener('click', function (ev) {
    var s = ev.target.closest('[data-skill]');
    if (s) { pick(s.getAttribute('data-skill')); }
  });
})();
