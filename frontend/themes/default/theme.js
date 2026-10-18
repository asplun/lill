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
    var parent = form.querySelector('[name="parentId"]');
    var target = form.querySelector('.comment-reply-target');
    var section = form.closest('.comments');
    function cancelReply() {
      if (parent) parent.value = '';
      if (target) target.hidden = true;
    }
    if (parent && target && section) {
      section.addEventListener('click', function (event) {
        var reply = event.target.closest('.comment-reply-btn');
        if (!reply || !section.contains(reply)) return;
        parent.value = reply.getAttribute('data-comment-id') || '';
        target.querySelector('span').textContent = '正在回复 ' + reply.getAttribute('data-comment-author');
        target.hidden = false;
        content.focus();
      });
      target.querySelector('.comment-cancel-reply').addEventListener('click', function () {
        cancelReply();
        content.focus();
      });
    }
    form.addEventListener('reset', function () {
      cancelReply();
      window.setTimeout(updateCount, 0);
    });
    form.addEventListener('lill:comment:submitted', function (event) {
      var result = event.detail;
      if (!result || result.status !== 'approved' || !result.comment || !section) return;
      var comment = result.comment;
      var list = section.querySelector('.comment-list');
      var item = document.createElement('div');
      item.className = 'comment-item';
      item.id = 'comment-' + comment.id;
      item.setAttribute('data-created-at', comment.created_at || '');
      // Build from text so author names and comment content never become HTML.
      var body = document.createElement('div');
      body.className = 'comment-body';
      var head = document.createElement('div');
      head.className = 'comment-head';
      var author = document.createElement('strong');
      author.textContent = comment.author;
      head.appendChild(author);
      var text = document.createElement('div');
      text.className = 'comment-text';
      text.style.whiteSpace = 'pre-wrap';
      text.textContent = comment.content;
      body.appendChild(head);
      body.appendChild(text);
      var reply = document.createElement('button');
      reply.type = 'button';
      reply.className = 'comment-reply-btn';
      reply.textContent = '回复';
      reply.setAttribute('data-comment-id', comment.id);
      reply.setAttribute('data-comment-author', comment.author);
      body.appendChild(reply);
      item.appendChild(body);
      function insertSorted(container) {
        var ascending = (window.__LILL_SCOPE__ || {}).commentSort === 'asc';
        var key = (comment.created_at || '') + '/' + comment.id;
        var next = Array.prototype.slice.call(container.children).find(function (child) {
          if (!child.classList.contains('comment-item')) return false;
          var other = (child.getAttribute('data-created-at') || '') + '/' + child.id.slice(8);
          return ascending ? key < other : key > other;
        });
        container.insertBefore(item, next || null);
      }
      var parentItem = comment.parent_id && document.getElementById('comment-' + comment.parent_id);
      if (parentItem && list.contains(parentItem)) {
        var replies = parentItem.nextElementSibling;
        if (!replies || !replies.classList.contains('comment-replies')) {
          replies = document.createElement('div');
          replies.className = 'comment-replies';
          parentItem.after(replies);
        }
        insertSorted(replies);
      } else insertSorted(list);
      var empty = list.querySelector('.comment-empty');
      if (empty) empty.remove();
      var total = section.querySelector('.comments-title span');
      if (total) total.textContent = String((parseInt(total.textContent, 10) || 0) + 1);
    });
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
