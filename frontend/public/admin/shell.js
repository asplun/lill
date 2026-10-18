// 仅管理后台导航的展开、键盘焦点和小屏行为，不参与内容或主题渲染。
(() => {
  const sidebar = document.getElementById('admin-sidebar');
  const toggle = document.getElementById('menu-toggle');
  const close = document.getElementById('sidebar-close');
  const scrim = document.getElementById('sidebar-scrim');
  const main = document.querySelector('main');
  const mobile = window.matchMedia('(max-width: 860px)');
  let opened = false;

  function setOpened(value, restoreFocus = true) {
    opened = mobile.matches && value;
    document.body.classList.toggle('nav-open', opened);
    toggle.setAttribute('aria-expanded', String(opened));
    sidebar.inert = mobile.matches && !opened;
    main.inert = opened;
    scrim.hidden = !opened;
    if (opened) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      close.focus();
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
      if (restoreFocus && mobile.matches) toggle.focus();
    }
  }

  toggle.addEventListener('click', () => setOpened(!opened));
  close.addEventListener('click', () => setOpened(false));
  scrim.addEventListener('click', () => setOpened(false));
  sidebar.addEventListener('click', event => {
    if (event.target.closest('.menu-item')) {
      const wasOpened = opened;
      setOpened(false, false);
      if (wasOpened) document.getElementById('content').focus();
    }
  });
  document.addEventListener('keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpened(false);
    } else if (event.key === 'Tab') {
      const focusable = [...sidebar.querySelectorAll('a[href], button:not([disabled]), input:not([disabled])')]
        .filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  });
  mobile.addEventListener('change', () => setOpened(false, false));
  setOpened(false, false);
})();
