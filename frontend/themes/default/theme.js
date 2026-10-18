(function () {
  'use strict';

  function safeColor(value, fallback) {
    var color = String(value || '').trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : fallback;
  }

  function safePosition(value) {
    return value === 'footer' || value === 'sidebar' ? value : 'top';
  }

  function renderAnnouncement(data) {
    if (!data || !data.enabled || !String(data.text || '').trim()) return;

    var position = safePosition(data.position);
    var targets = document.querySelectorAll('[data-lill-hello="' + position + '"]');
    Array.prototype.forEach.call(targets, function (target) {
      var banner = document.createElement('div');
      banner.className = 'lill-hello-banner';
      banner.setAttribute('role', 'status');
      banner.style.backgroundColor = safeColor(data.bg_color, '#23282b');
      banner.style.color = safeColor(data.text_color, '#ffffff');
      banner.textContent = String(data.text);
      target.appendChild(banner);
    });
  }

  function initMenu() {
    var shell = document.querySelector('.site-shell');
    if (!shell) return;
    var toggle = shell.querySelector('[data-lill-toggle="menu"]');
    var nav = shell.querySelector('#site-nav');
    if (!toggle || !nav) return;
    var mobile = window.matchMedia('(max-width: 840px)');

    function setOpen(open, restoreFocus) {
      shell.classList.toggle('menu-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
      toggle.title = open ? '关闭菜单' : '打开菜单';
      if (restoreFocus) toggle.focus();
    }

    shell.classList.add('menu-ready');
    toggle.addEventListener('click', function () {
      var open = !shell.classList.contains('menu-open');
      setOpen(open);
      if (open) {
        var firstLink = nav.querySelector('a');
        if (firstLink) firstLink.focus();
      }
    });
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('click', function (event) {
      if (!nav.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && shell.classList.contains('menu-open')) {
        setOpen(false, true);
      }
    });
    function onResize() {
      var active = document.activeElement;
      setOpen(false);
      if (mobile.matches && nav.contains(active)) toggle.focus();
      else if (!mobile.matches && active === toggle) {
        var current = nav.querySelector('[aria-current="page"]') || nav.querySelector('a');
        if (current) current.focus();
      }
    }
    if (mobile.addEventListener) mobile.addEventListener('change', onResize);
    else mobile.addListener(onResize);
  }

  function initColorScheme() {
    var root = document.documentElement;
    var toggle = document.querySelector('.site-shell [data-lill-toggle="dark"]');
    var system = window.matchMedia('(prefers-color-scheme: dark)');
    function preference() {
      try { return localStorage.getItem('lill_dark'); } catch (error) { return null; }
    }
    function updateControl() {
      if (!toggle) return;
      var dark = root.classList.contains('lill-dark');
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.setAttribute('aria-label', dark ? '切换浅色模式' : '切换深色模式');
      toggle.title = dark ? '切换浅色模式' : '切换深色模式';
    }
    function followSystem() {
      if (preference() === null) root.classList.toggle('lill-dark', system.matches);
      updateControl();
    }
    followSystem();
    // The core runtime already handles the toggle and persists its state.
    if (toggle) toggle.addEventListener('click', updateControl);
    if (system.addEventListener) system.addEventListener('change', followSystem);
    else system.addListener(followSystem);
  }

  function initPostControls() {
    var copy = document.querySelector('.site-shell .share-copy');
    if (copy) {
      copy.addEventListener('click', function () {
        var url = new URL(copy.getAttribute('data-url'), location.href).href;
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          copy.textContent = '请从地址栏复制链接';
          return;
        }
        navigator.clipboard.writeText(url).then(function () {
          copy.textContent = '已复制';
        }).catch(function () {
          copy.textContent = '请从地址栏复制链接';
        });
      });
    }
    var form = document.querySelector('.site-shell .lill-comment-form');
    if (!form) return;
    var content = form.querySelector('[name="content"]');
    var counter = form.querySelector('.comment-char-count');
    if (!content || !counter) return;
    function updateCount() { counter.textContent = content.value.length + ' / ' + content.maxLength; }
    content.addEventListener('input', updateCount);
    form.addEventListener('reset', function () { window.setTimeout(updateCount, 0); });
    updateCount();
  }

  initMenu();
  initColorScheme();
  initPostControls();
  var customCss = document.getElementById('lill-theme-custom-css');
  if (customCss) document.head.appendChild(customCss);

  fetch('/api/v1/hello', { cache: 'no-store' })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (payload) { renderAnnouncement(payload && payload.data); })
    .catch(function () {});
})();
