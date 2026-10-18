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
    if (copy && !copy.hasAttribute('data-copy-ready')) {
      copy.setAttribute('data-copy-ready', '');
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
      // Re-read the page so flat/threaded layout, counts and page boundaries stay consistent.
      loadCommentPage(new URL(location.href)).catch(function () {
        var message = form.querySelector('.lill-comment-msg');
        if (message) message.textContent = '评论已提交，请刷新查看最新分页';
      });
    });
    updateCount();
  }

  var commentTemplate;
  var commentRequest = 0;
  function loadCommentPage(url, updateHistory) {
    var scope = window.__LILL_SCOPE__ || {};
    var section = document.getElementById('comments');
    if (!scope.post || !section || !window.lillAPI || !window.LillEngine) return Promise.resolve();
    var page = Math.max(1, parseInt(url.searchParams.get('commentPage'), 10) || 1);
    var sort = url.searchParams.get('commentSort') || scope.commentSort || 'desc';
    var request = ++commentRequest;
    if (!commentTemplate) {
      commentTemplate = fetch('/themes/default/comments.html', { cache: 'no-cache' }).then(function (response) {
        if (!response.ok) throw new Error('评论模板加载失败');
        return response.text();
      }).catch(function (error) { commentTemplate = null; throw error; });
    }
    return Promise.all([
      window.lillAPI.get('/comments?postId=' + encodeURIComponent(scope.post.id) + '&page=' + page + '&sort=' + encodeURIComponent(sort)),
      commentTemplate
    ]).then(function (results) {
      if (request !== commentRequest) return;
      var comments = results[0];
      scope.comments = comments.items;
      scope.commentFlat = comments.commentFlat || comments.items;
      scope.commentMeta = comments.meta;
      scope.commentDisplay = comments.display;
      scope.commentSort = comments.sort;
      var fragment = document.createElement('div');
      fragment.innerHTML = window.LillEngine.render(results[1], {}, scope);
      // Keep the original form: the shared runtime owns its submit listener.
      section.querySelector('.comment-list').innerHTML = fragment.querySelector('.comment-list').innerHTML;
      section.querySelector('.comments-title span').textContent = String(comments.meta.total);
      section.setAttribute('data-comment-display', comments.display);
      var previous = section.querySelector('.comment-pagination');
      var pagination = fragment.querySelector('.comment-pagination');
      if (previous) {
        if (pagination) previous.replaceWith(pagination);
        else previous.remove();
      } else if (pagination) section.querySelector('.comment-list').after(pagination);
      if (updateHistory) history.pushState(null, '', url.href);
    });
  }

  function initCommentPagination() {
    var scope = window.__LILL_SCOPE__ || {};
    if (!scope.post || !document.getElementById('comments')) return;
    document.addEventListener('click', function (event) {
      var link = event.target.closest('a[data-comment-page]');
      if (!link || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var url = new URL(location.href);
      url.searchParams.set('commentPage', link.getAttribute('data-comment-page'));
      url.searchParams.set('commentSort', (window.__LILL_SCOPE__ || {}).commentSort || 'desc');
      url.hash = 'comments';
      event.preventDefault();
      loadCommentPage(url, true).catch(function () { location.href = url.href; });
    });
    window.addEventListener('popstate', function () {
      loadCommentPage(new URL(location.href)).catch(function () {});
    });
    // Older shared runtimes do not forward commentPage; this theme completes its own entry path.
    var url = new URL(location.href);
    var requestedPage = Math.max(1, parseInt(url.searchParams.get('commentPage'), 10) || 1);
    var requestedSort = url.searchParams.get('commentSort') || scope.commentSort || 'desc';
    if ((url.searchParams.has('commentPage') || url.searchParams.has('commentSort')) &&
        (!scope.commentMeta || scope.commentMeta.page !== Math.min(requestedPage, scope.commentMeta.totalPages || 1) ||
         scope.commentSort !== requestedSort)) {
      loadCommentPage(url).catch(function () {});
    }
  }

  initMenu();
  initColorScheme();
  initPostControls();
  initCommentPagination();
  var customCss = document.getElementById('lill-theme-custom-css');
  if (customCss) document.head.appendChild(customCss);

  fetch('/api/v1/hello', { cache: 'no-store' })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (payload) { renderAnnouncement(payload && payload.data); })
    .catch(function () {});
})();
