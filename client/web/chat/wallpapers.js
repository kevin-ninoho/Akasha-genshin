(function () {
  'use strict';

  const S = window.AkashaStore;
  const options = [
    { id: 'venti', name: '温迪', element: '风', icon: '❋' },
    { id: 'zhongli', name: '钟离', element: '岩', icon: '◈' },
    { id: 'raiden', name: '雷电将军', element: '雷', icon: 'ϟ' },
    { id: 'nahida', name: '纳西妲', element: '草', icon: '❀' },
    { id: 'focalors', name: '芙卡洛斯', element: '水', icon: '≈' },
    { id: 'mavuika', name: '玛薇卡', element: '火', icon: '✹' },
    { id: 'tsaritsa', name: '冰之女皇', element: '冰', icon: '❄' },
  ];
  const byId = new Map(options.map(option => [option.id, option]));
  let selected = 'venti';
  const root = document.documentElement;

  function apply(id) {
    const option = byId.get(id) || options[0];
    selected = option.id;
    root.style.setProperty('--akasha-wallpaper', `url('/assets/archons/${option.id}.webp')`);
    const trigger = document.getElementById('wallpaper-picker');
    if (trigger) trigger.title = `当前背景：${option.name} · ${option.element}元素，点击更换`;
    document.querySelectorAll('[data-wallpaper]').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.wallpaper === selected ? 'true' : 'false');
    });
  }

  function mount() {
    const trigger = document.getElementById('wallpaper-picker');
    const menu = document.getElementById('wallpaper-menu');
    if (!trigger || !menu) return;
    menu.innerHTML = '<div class="wallpaper-heading"><b>七神 · 元素画境</b><small>随明暗主题适配</small></div>' + options.map(option => `<button class="wallpaper-option" type="button" data-wallpaper="${option.id}" aria-pressed="false" aria-label="${option.element}元素背景：${option.name}">
      <span class="wallpaper-thumb"><img src="/assets/archons/${option.id}.webp" alt="" loading="lazy"><span class="wallpaper-symbol" aria-hidden="true">${option.icon}</span></span>
      <span class="wallpaper-option-label"><b>${option.name}</b><small>${option.element}元素</small></span><span class="wallpaper-check" aria-hidden="true">✓</span>
    </button>`).join('');

    function close(restoreFocus = false) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }
    trigger.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      trigger.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
      if (!menu.hidden) menu.querySelector(`[data-wallpaper="${selected}"]`)?.focus();
    });
    menu.addEventListener('click', async event => {
      const button = event.target.closest('[data-wallpaper]');
      if (!button) return;
      const requested = button.dataset.wallpaper;
      apply(requested);
      close(true);
      try {
        const prefs = S.peek('preferences', 'appearance') ?? await S.get('preferences', 'appearance', {});
        await S.put('preferences', 'appearance', { ...prefs, wallpaper: requested });
      } catch (error) {
        if (selected === requested) document.getElementById('wb-notice').textContent = `背景已切换，但尚未保存：${error.message}。请点击顶部保存状态重试。`;
      }
    });
    document.addEventListener('click', event => {
      if (!menu.hidden && !event.target.closest('#wallpaper-control')) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !menu.hidden) close(true);
    });
    apply(selected);
  }

  window.AkashaWallpapers = { apply, options };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
