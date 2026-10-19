/* Akasha · 主题切换（深色 / 浅色）
 *
 * 和主流 AI 工具一致：默认跟系统走，用户可以手动覆盖，选择记在本地。
 *
 * 为什么单独一个文件：主题要在**首帧之前**就定下来，否则会闪一下白/黑。
 * 所以 index.html 里把它放在 <body> 之前同步执行（不做成 defer）。
 * 逻辑也很小，不值得塞进 app.js（那个已经 1000 行了）。
 */
(function () {
  'use strict';

  var KEY = 'akasha.theme';           // 'dark' | 'light' | ''(跟系统)
  var root = document.documentElement;

  /** 系统当前偏好。 */
  function systemTheme() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  /** 实际生效的主题：本地设置优先，否则跟系统。 */
  function effective() {
    var saved = '';
    try { saved = localStorage.getItem(KEY) || ''; } catch (e) { /* 隐私模式 */ }
    return saved === 'light' || saved === 'dark' ? saved : systemTheme();
  }

  /** 应用主题（改 data-theme + color-scheme，两者都要，
   *  否则滚动条、原生表单控件、输入法候选框还是旧配色）。 */
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? 'light dark' : 'dark light');
    var btn = document.getElementById('theme');
    if (btn) {
      var isLight = theme === 'light';
      btn.textContent = isLight ? '☀' : '🌙';
      btn.title = isLight ? '当前浅色（点击切换深色）' : '当前深色（点击切换浅色）';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
    }
  }

  /** 首帧前先定下来，避免闪。 */
  apply(effective());

  /** 用户点击：在明暗之间切换，并记住。 */
  function toggle() {
    var next = effective() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) { /* 存不下也能切 */ }
    apply(next);
  }

  /** 系统主题变化时，只在用户没手动选过的情况下跟随。 */
  try {
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function () {
        var saved = '';
        try { saved = localStorage.getItem(KEY) || ''; } catch (e) { /* ignore */ }
        if (!saved) apply(systemTheme());
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (e) { /* ignore */ }

  window.AkashaTheme = { toggle: toggle, effective: effective, apply: apply };

  /** 按钮是 app.js 之后才在 DOM 里的 —— 用 DOMContentLoaded 挂上。 */
  function mount() {
    var btn = document.getElementById('theme');
    if (!btn) return;
    btn.addEventListener('click', toggle);
    apply(effective());          // 把图标/提示刷成当前状态
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
