/**
 * lill 默认主题运行时
 * 职责：应用主题设置、渲染导航、渲染侧边栏 Widget、提供文章卡片等公共方法
 * 配置来源：window.__LILL_THEME__（构建时注入）或运行时 /api/v1/options/public
 */
window.lillTheme = (function () {
  const API = window.lillAPI;
  const cfg = window.__LILL_THEME__ || {};
  const opts = window.__LILL_OPTIONS__ || {};
  let _resolveReady;
  const ready = new Promise(r => { _resolveReady = r; });

  // ─────────── 工具 ───────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(d) {
    if (!d) return '';
    const x = new Date(String(d).replace(' ', 'T') + (String(d).includes('Z') ? '' : 'Z'));
    return isNaN(x) ? '' : x.toLocaleDateString('zh-CN');
  }
  function val(key, fallback) {
    const v = cfg[key];
    return (v === undefined || v === null || v === '') ? (fallback !== undefined ? fallback : '') : v;
  }
  function on(key, fallback) {
    const v = val(key, fallback === false ? 'false' : 'true');
    return v === 'true' || v === true;
  }

  // ─────────── 文章卡片 ───────────
  function postCard(p) {
    const full = val('home_mode', 'excerpt') === 'full' && p.html_content;
    const thumb = on('show_thumb', true) && p.cover_image;
    const link = p.route || p.url || '/post/' + p.slug;
    let meta = '<span>📅 ' + fmtDate(p.published_at) + '</span>';
    if (on('show_author', true) && p.author_nickname) meta += '<span>✍️ ' + esc(p.author_nickname) + '</span>';
    if (on('show_category', true) && p.category_name) meta += '<span>📁 <a href="' + esc(p.category_slug ? '/category/' + p.category_slug : '#') + '">' + esc(p.category_name) + '</a></span>';
    if (on('show_views', true)) meta += '<span>👁️ ' + (p.view_count || 0) + '</span>';
    const sticky = on('show_sticky', true) && p.sticky ? '<span class="sticky-badge">置顶</span>' : '';
    return '<article class="post-card' + (thumb ? ' has-thumb' : '') + '">' +
      (thumb ? '<a class="post-thumb" href="' + esc(link) + '"><img src="' + esc(p.cover_image) + '" alt="' + esc(p.title) + '" loading="lazy"></a>' : '') +
      '<div class="post-card-body">' +
        '<h2 class="post-title">' + sticky + '<a href="' + esc(link) + '">' + esc(p.title) + '</a></h2>' +
        '<div class="post-meta">' + meta + '</div>' +
        (full
          ? '<div class="post-content">' + p.html_content + '</div>'
          : '<div class="post-excerpt">' + esc(p.excerpt || '') + '</div><a class="read-more" href="' + esc(link) + '">阅读全文 →</a>') +
      '</div></article>';
  }

  // ─────────── 导航 ───────────
  async function renderNav() {
    const nav = document.getElementById('site-nav');
    if (!nav) return;
    let html = '<a href="/">首页</a>';
    try {
      const [cats, pages] = await Promise.all([API.get('/categories'), API.get('/pages')]);
      (cats || []).forEach(c => { html += '<a href="' + esc(c.route || c.url || '/category/' + c.slug) + '">' + esc(c.name) + '</a>'; });
      (pages || []).forEach(p => { html += '<a href="/page/' + esc(p.slug) + '">' + esc(p.title) + '</a>'; });
    } catch (e) {}
    html += '<a href="/archive">归档</a>';
    nav.innerHTML = html;
    const path = location.pathname;
    nav.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href');
      if (href === path || (href !== '/' && path.startsWith(href))) a.classList.add('active');
    });
  }

  // ─────────── 侧边栏 Widget ───────────
  function widget(title, body) {
    return '<div class="widget"><h3 class="widget-title">' + esc(title) + '</h3><div class="widget-body">' + body + '</div></div>';
  }
  function wSearch() {
    const q = new URLSearchParams(location.search).get('q') || '';
    return widget('搜索', '<form class="widget-search" role="search"><input type="search" name="q" placeholder="输入关键词…" value="' + esc(q) + '"><button type="submit">搜索</button></form>');
  }
  async function wRecentPosts() {
    const d = await API.get('/posts?pageSize=5');
    const list = (d && d.items) || [];
    if (!list.length) return '';
    return widget('最新文章', '<ul class="widget-list">' + list.map(p =>
      '<li><a href="' + esc(p.route || p.url || '/post/' + p.slug) + '">' + esc(p.title) + '</a><span class="widget-meta">' + fmtDate(p.published_at) + '</span></li>').join('') + '</ul>');
  }
  async function wRecentComments() {
    const list = await API.get('/comments/recent?limit=5');
    if (!list || !list.length) return '';
    return widget('最新评论', '<ul class="widget-list widget-comments">' + list.map(c =>
      '<li><a href="' + esc(c.post_route || c.post_url || '/post/' + c.post_slug) + '#comment-' + esc(c.id) + '"><strong>' + esc(c.nickname || c.author_name || '匿名') + '</strong>：' + esc(String(c.content || '').substring(0, 40)) + '</a><span class="widget-meta">' + esc(c.post_title || '') + '</span></li>').join('') + '</ul>');
  }
  async function wCategories() {
    const list = await API.get('/categories');
    if (!list || !list.length) return '';
    return widget('分类目录', '<ul class="widget-list">' + list.map(c =>
      '<li><a href="' + esc(c.route || c.url || '/category/' + c.slug) + '">' + esc(c.name) + '</a><span class="widget-count">' + (c.post_count || 0) + '</span></li>').join('') + '</ul>');
  }
  async function wTags() {
    const list = await API.get('/tags');
    if (!list || !list.length) return '';
    return widget('标签云', '<div class="tag-cloud">' + list.map(t =>
      '<a href="' + esc(t.route || t.url || '/tag/' + t.slug) + '">' + esc(t.name) + '</a>').join('') + '</div>');
  }
  async function wArchives() {
    const list = await API.get('/archives');
    if (!list || !list.length) return '';
    return widget('文章归档', '<ul class="widget-list">' + list.map(a =>
      '<li><a href="/archive?month=' + esc(a.ym) + '">' + esc(a.ym) + '</a><span class="widget-count">' + a.count + '</span></li>').join('') + '</ul>');
  }
  function wMeta() {
    return widget('站点信息', '<ul class="widget-list">' +
      '<li><a href="/archive">文章归档</a></li>' +
      '<li><a href="/feed.xml">RSS 订阅</a></li>' +
      '<li><a href="/admin/">管理登录</a></li>' +
      '</ul>');
  }

  const WIDGETS = [
    { key: 'sidebar_search', render: wSearch },
    { key: 'sidebar_recent_posts', render: wRecentPosts },
    { key: 'sidebar_recent_comments', render: wRecentComments },
    { key: 'sidebar_categories', render: wCategories },
    { key: 'sidebar_tags', render: wTags },
    { key: 'sidebar_archives', render: wArchives },
    { key: 'sidebar_meta', render: wMeta },
  ];

  async function renderSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const active = WIDGETS.filter(w => on(w.key, true));
    if (!active.length) { sidebar.style.display = 'none'; return; }
    for (const w of active) {
      const slot = document.createElement('div');
      slot.className = 'widget-slot';
      sidebar.appendChild(slot);
      try {
        const html = await w.render();
        if (html) slot.innerHTML = html; else slot.remove();
      } catch (e) { slot.remove(); }
    }
    sidebar.querySelectorAll('form.widget-search').forEach(f => {
      f.addEventListener('submit', e => {
        e.preventDefault();
        const q = f.querySelector('input').value.trim();
        if (q) location.href = '/search?q=' + encodeURIComponent(q);
      });
    });
  }

  // ─────────── 应用主题设置 ───────────
  function applyConfig() {
    const root = document.documentElement;
    root.style.setProperty('--primary', val('color', '#4f46e5'));
    document.body.classList.add('layout-' + val('layout', 'sidebar-right'));
    document.body.classList.add('width-' + val('content_width', 'normal'));
    const css = val('custom_css', '');
    if (css) {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
    const footer = document.getElementById('footer-text');
    if (footer) footer.innerHTML = val('footer_text', 'Powered by lill') + ' &copy; ' + new Date().getFullYear();
  }

  async function init() {
    // 始终拉取最新配置，保证后台改主题设置后前台立即生效
    try {
      const o = await API.get('/options/public');
      Object.assign(opts, o || {});
      Object.assign(cfg, (o && o.theme_config) || {});
      try { localStorage.setItem('lill_theme_cache', JSON.stringify(cfg)); } catch (e) {}
    } catch (e) {}
    // 应用全局站点配置
    if (opts.site_name) document.title = opts.site_name;
    if (opts.site_description) { const meta = document.querySelector('meta[name="description"]'); if (meta) meta.content = opts.site_description; }
    applyConfig();
    renderNav();
    renderSidebar();
    _resolveReady();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { esc, fmtDate, val, on, postCard, cfg, opts, ready, renderNav, renderSidebar, applyConfig };
})();
