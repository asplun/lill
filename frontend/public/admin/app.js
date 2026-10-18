let user = null;
let page = 'dashboard';
let pageNum = 1;
let postStatus = '';
let commentStatus = '';

const TITLES = { dashboard: '控制台', posts: '文章', pages: '页面', categories: '分类', tags: '标签', comments: '评论', media: '附件', themes: '外观', users: '用户', settings: '设置', logs: '日志', backup: '备份', plugins: '插件' };

// 统一 API 层：由 /api.js 提供的 window.lillAPI（前台后台共用）
const api = (path, opts = {}) => window.lillAPI.request(path, opts);

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function escape(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
const jsArg = value => escape(JSON.stringify(String(value)));
function fmt(d) { if (!d) return '-'; const x = new Date(d.replace ? d.replace(' ', 'T') + 'Z' : d); if (isNaN(x)) return '-'; return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
function localDateTime(value) {
  if (!value) return '';
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  if (isNaN(date)) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
function statusLabel(s) {
  const m = { published: ['已发布', 'green'], draft: ['草稿', 'gray'], pending: ['待审核', 'orange'], trash: ['回收站', 'red'], approved: ['已通过', 'green'], spam: ['垃圾', 'red'], active: ['正常', 'green'], banned: ['禁用', 'red'] };
  const t = m[s] || [s || '-', 'gray'];
  return '<span class="tag tag-' + t[1] + '">' + t[0] + '</span>';
}
function roleLabel(r) {
  const m = { admin: '管理员', editor: '编辑', author: '作者', contributor: '投稿者', subscriber: '订阅者' };
  return m[r] || r;
}
const contentRoles = ['admin', 'editor', 'author', 'contributor'];
const managesTaxonomy = () => ['admin', 'editor'].includes(user?.role);
function canVisit(destination) {
  if (user?.role === 'admin' || destination === 'dashboard') return true;
  if (destination === 'comments') return user?.role === 'editor';
  return contentRoles.includes(user?.role) && ['posts', 'pages', 'categories', 'tags', 'media'].includes(destination);
}
function applyRoleNavigation() {
  document.querySelectorAll('.menu-item[data-page]').forEach(el => { el.hidden = !canVisit(el.dataset.page); });
  document.querySelectorAll('.menu-section').forEach(section => {
    if (section.id === 'plugin-menu-section') return;
    let item = section.nextElementSibling, visible = false;
    while (item && !item.classList.contains('menu-section')) {
      if (item.classList.contains('menu-item') && !item.hidden) visible = true;
      item = item.nextElementSibling;
    }
    section.hidden = !visible;
  });
}
function setTopbar(html) { document.getElementById('topbar-actions').innerHTML = html || ''; }

function paginate(meta) {
  if (!meta || !meta.totalPages || meta.totalPages <= 1) return '';
  let html = '<div class="pagination">';
  html += '<button ' + (meta.hasPrev ? '' : 'disabled') + ' onclick="gotoPage(' + (meta.page - 1) + ')">←</button>';
  for (let i = 1; i <= meta.totalPages; i++) {
    html += '<button class="' + (i === meta.page ? 'active' : '') + '" onclick="gotoPage(' + i + ')">' + i + '</button>';
  }
  html += '<button ' + (meta.hasNext ? '' : 'disabled') + ' onclick="gotoPage(' + (meta.page + 1) + ')">→</button>';
  return html + '</div>';
}

// ═══ 路由 ═══
let activeView = null;
function showView(key, load, reuse = false, navigation = {}) {
  if (reuse && activeView?.key === key && !activeView.signal.aborted && !activeView.failed) return activeView.promise;
  const view = { key, load, navigation, signal: window.lillAPI.newRenderScope() };
  activeView = view;
  setTopbar('');
  const c = document.getElementById('content');
  c.innerHTML = '<div class="loading" role="status"><div class="spinner"></div><span class="sr-only">正在加载</span></div>';
  view.promise = (async () => {
    try { await load(view.signal); }
    catch (e) {
      if (view.signal.aborted) return;
      view.failed = true;
      c.innerHTML = '<div class="card"><p style="color:#ef4444">加载失败：' + escape(e.message) + '</p><button class="btn btn-outline" onclick="retryView()">重试</button></div>';
    } finally { if (!view.signal.aborted) labelTableRows(); }
  })();
  return view.promise;
}
function refreshView(view) {
  // 同页写入可先后完成；刷新继承导航身份，真正切页才使旧操作失效。
  if (activeView?.navigation === view.navigation) return render(false, view.navigation);
}
window.retryView = () => showView(activeView.key, activeView.load);
function render(reuse = false, navigation) {
  const key = [page, pageNum, page === 'posts' ? postStatus : page === 'comments' ? commentStatus : ''].join(':');
  return showView(key, async () => {
    document.getElementById('page-title').textContent = TITLES[page] || '';
    switch (page) {
      case 'dashboard': return await renderDashboard();
      case 'posts': return await renderPosts();
      case 'pages': return await renderPages();
      case 'categories': return await renderCategories();
      case 'tags': return await renderTags();
      case 'comments': return await renderComments();
      case 'media': return await renderMedia();
      case 'themes': return await renderThemes();
      case 'users': return await renderUsers();
      case 'settings': return await renderSettings();
      case 'logs': return await renderLogs();
      case 'backup': return await renderBackup();
      case 'plugins': return await renderPlugins();
      default:
        if (page.startsWith('plugin-settings:')) return await renderPluginSettings(page.slice(16));
        if (page.startsWith('plugin:')) return await renderPluginMenuPanel(page.slice(7));
        document.getElementById('content').innerHTML = '<div class="empty">页面不存在</div>';
    }
  }, reuse, navigation);
}

// 小屏仍保留每个字段的名称，不依赖列在桌面上的位置。
function labelTableRows() {
  document.querySelectorAll('#content table').forEach(table => {
    const labels = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row => {
      [...row.children].forEach((cell, index) => {
        if (cell.colSpan === 1) cell.dataset.label = labels[index] || '';
      });
    });
  });
}

// ═══ 控制台 ═══
async function renderDashboard() {
  if (user?.role !== 'admin') {
    document.getElementById('content').innerHTML = '<div class="card"><h2>欢迎，' + escape(user?.nickname || user?.username) +
      '</h2><p>' + (contentRoles.includes(user?.role) ? '从内容菜单开始写作和管理。' : '当前账号没有内容管理权限，可以返回站点参与评论。') +
      '</p><a class="btn btn-outline" href="/">查看站点</a></div>';
    return;
  }
  const [stats, sys, recentPosts, drafts, comments] = await Promise.all([
    api('/admin/stats/dashboard'),
    api('/admin/stats/system'),
    api('/admin/posts/recent'),
    api('/admin/posts?status=draft&pageSize=3'),
    api('/admin/comments?status=pending&pageSize=2')
  ]);
  const o = stats.overview || {};
  const draftItems = drafts.items || [];
  const pendingItems = comments.items || [];
  const draftCount = drafts.meta?.total || 0;
  setTopbar('<button class="btn btn-primary" onclick="openPostEditor(\'post\')">+ 写文章</button>');
  let html = '<section class="dashboard-welcome"><div><h2>欢迎回来，继续你的记录。</h2><p>文章、草稿与读者的回应，都在这里。</p></div><time>' +
    new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) + '</time></section>';
  html += '<div class="stats-grid">' +
    sc(o.postCount || 0, '已发布文章', '查看文章', "navigate('posts','published')") +
    sc(draftCount, '草稿', '继续编辑', "navigate('posts','draft')") +
    sc(o.pendingCommentCount || 0, '待审评论', '前往审核', "navigate('comments','pending')") +
    sc(o.pageCount || 0, '独立页面', '管理页面', "navigate('pages')") + '</div>';
  html += '<div class="dashboard-grid"><section class="card dashboard-posts"><div class="panel-heading"><h3>最近文章</h3><button class="text-button" onclick="navigate(\'posts\')">查看全部 →</button></div>';
  if (recentPosts?.length) {
    html += '<table><thead><tr><th>标题</th><th>状态</th><th>分类</th><th>创建时间</th></tr></thead><tbody>' +
      recentPosts.map(p => '<tr><td><button class="title-button" onclick="openPostEditor(\'post\',' + jsArg(p.id) + ')">' + escape(p.title || '无标题') +
        '</button><small class="record-meta">' + escape(p.author_name || '') + '</small></td><td>' + statusLabel(p.status) +
        '</td><td>' + escape(p.category_name || '未分类') + '</td><td><time>' + fmt(p.created_at) + '</time></td></tr>').join('') + '</tbody></table>';
  } else html += '<div class="empty"><p>写下第一篇文章，让记录开始。</p><button class="btn btn-outline" onclick="openPostEditor(\'post\')">写文章</button></div>';
  html += '</section><div class="dashboard-side"><section class="card"><div class="panel-heading"><h3>待审评论</h3><span class="count-pill">' + (o.pendingCommentCount || 0) + '</span></div>';
  html += pendingItems.length ? '<div class="pending-list">' + pendingItems.map(c =>
    '<div class="pending-item"><span class="reader-avatar" aria-hidden="true">' + escape((c.author_name || c.username || '访').slice(0, 1)) +
    '</span><div><strong>' + escape(c.author_name || c.username || '访客') + '</strong><p>' + escape((c.content || '').slice(0, 90)) + '</p></div></div>').join('') + '</div>'
    : '<p class="panel-empty">评论已全部处理，可以安心写作了。</p>';
  html += '<div class="panel-footer"><button class="text-button" onclick="navigate(\'comments\',\'pending\')">前往审核 →</button></div></section>';
  html += '<section class="card"><div class="panel-heading"><h3>继续编辑</h3><span class="count-pill">' + draftCount + '</span></div>';
  html += draftItems.length ? '<div class="recent-list">' + draftItems.map(p =>
    '<div class="recent-item"><button class="title-button" onclick="openPostEditor(\'post\',' + jsArg(p.id) + ')">' + escape(p.title || '无标题') +
    '<small class="record-meta">草稿 · ' + fmt(p.updated_at || p.created_at) + '</small></button></div>').join('') + '</div>'
    : '<p class="panel-empty">暂无草稿，新的灵感随时可以开始。</p>';
  html += '<div class="panel-footer"><button class="text-button" onclick="navigate(\'posts\',\'draft\')">全部草稿 →</button></div></section></div></div>';
  html += '<details class="system-details"><summary>系统信息与关于 lill</summary><div class="card"><div class="info-grid">' +
    '<div class="info-item"><span class="info-label">lill 博客系统</span><span class="info-value">v2.0.0</span></div>' +
    '<div class="info-item"><span class="info-label">Node.js / SQLite</span><span class="info-value">' + escape(sys.nodeVersion || '-') + ' / ' + escape(sys.dbVersion || '-') + '</span></div>' +
    '<div class="info-item"><span class="info-label">运行时间</span><span class="info-value">' + Math.floor((sys.uptime || 0) / 3600) + ' 小时</span></div>' +
    '<div class="info-item"><span class="info-label">平台</span><span class="info-value">' + escape(sys.platform || '-') + '</span></div></div>' +
    '<p class="about-meta">轻量、可扩展的博客系统。主题开发规范见 <code>docs/主题开发指南.md</code>。</p></div></details>';
  document.getElementById('content').innerHTML = html;
}
function sc(val, label, hint, action) {
  return '<button class="stat-card" onclick="' + action + '"><span class="stat-value">' + val + '</span><span class="stat-copy"><span class="stat-label">' + label + '</span><span class="stat-hint">' + hint + '</span></span></button>';
}

// ═══ 文章 / 页面 ═══
// ── Markdown 编辑器工具（工具栏 / 快捷键 / 全屏 / 草稿） ──
function mdEl(id) { return document.getElementById(id); }
function mdTextarea() { return mdEl('pe-content'); }
/** 与后端一致的别名规则：保留字母（含中文）、数字与连字符 */
function mdClientSlug(title) {
  return String(title || '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
function mdSync() {
  const ta = mdTextarea(); if (!ta) return;
  const pv = mdEl('pe-preview');
  if (pv) pv.innerHTML = mdToHtml(ta.value);
  const count = mdEl('pe-count');
  if (count) count.textContent = ta.value.length + ' 字';
  if (typeof window.__lillDraftSave === 'function') window.__lillDraftSave();
}
window.mdWrap = (before, after, placeholder) => {
  const ta = mdTextarea(); if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || placeholder || '';
  ta.value = ta.value.slice(0, start) + before + selected + after + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = start + before.length;
  ta.selectionEnd = start + before.length + selected.length;
  mdSync();
};
window.mdPrefix = (prefix) => {
  const ta = mdTextarea(); if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = ta.value.indexOf('\n', end); if (lineEnd === -1) lineEnd = ta.value.length;
  const lines = ta.value.slice(lineStart, lineEnd).split('\n').map(line => line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line);
  ta.value = ta.value.slice(0, lineStart) + lines.join('\n') + ta.value.slice(lineEnd);
  ta.focus();
  mdSync();
};
window.mdInsertText = (text) => {
  const ta = mdTextarea(); if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + text.length;
  mdSync();
};
window.mdInsertInlineCode = () => { window.mdWrap('`', '`', '代码'); };
window.mdInsertCode = () => { window.mdInsertText('\n```\n在此输入代码\n```\n'); };
window.mdInsertHr = () => { window.mdInsertText('\n\n---\n\n'); };
window.mdLink = () => {
  const ta = mdTextarea(); if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || '链接文字';
  const url = prompt('链接地址（URL）', 'https://');
  if (!url) return;
  ta.value = ta.value.slice(0, start) + '[' + selected + '](' + url + ')' + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = start + 1;
  ta.selectionEnd = start + 1 + selected.length;
  mdSync();
};
window.mdImage = () => {
  const ta = mdTextarea(); if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const alt = ta.value.slice(start, end) || '图片描述';
  const url = prompt('图片地址（URL）。可先在「附件」页上传后复制地址。', 'https://');
  if (!url) return;
  ta.value = ta.value.slice(0, start) + '![' + alt + '](' + url + ')' + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + alt.length + url.length + 4;
  mdSync();
};
window.mdPickMedia = async () => {
  const ta = mdTextarea(); if (!ta) return;
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'media-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'mm-title');
  overlay.innerHTML = '<div class="media-modal-box"><div class="media-modal-head"><strong id="mm-title">从附件库选择图片</strong><span class="mm-actions"><label class="btn btn-sm btn-outline">上传图片<input type="file" id="mm-upload" accept="image/*" style="display:none"></label><button type="button" class="tb" id="mm-close" aria-label="关闭图片选择">✕</button></span></div><div class="media-modal-body" id="mm-body"><div class="loading"><div class="spinner"></div></div></div></div>';
  document.body.appendChild(overlay);
  const close = () => {
    overlay.remove();
    if (opener && opener.isConnected) opener.focus();
  };
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  overlay.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    } else if (ev.key === 'Tab') {
      const focusable = [...overlay.querySelectorAll('button:not([disabled]), input:not([disabled])')]
        .filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault(); last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault(); first.focus();
      }
    }
  });
  overlay.querySelector('#mm-close').onclick = close;
  overlay.querySelector('#mm-close').focus();
  const body = overlay.querySelector('#mm-body');
  const insert = (url) => { close(); ta.focus(); window.mdWrap('![', '](' + url + ')', '图片描述'); };
  const load = async () => {
    try {
      const r = await api('/admin/media?pageSize=48');
      const images = (r.items || []).filter(m => String(m.mime_type || '').startsWith('image/'));
      body.innerHTML = images.length
        ? '<div class="media-modal-grid">' + images.map(m => '<button type="button" class="mm-item" data-url="' + escape(m.url) + '" title="' + escape(m.name) + '"><img src="' + escape(m.url) + '" alt="' + escape(m.alt || m.name) + '" loading="lazy"><span>' + escape(m.name) + '</span></button>').join('') + '</div>'
        : '<div class="empty">附件库里还没有图片，可点右上角「上传图片」</div>';
      body.querySelectorAll('.mm-item').forEach(btn => { btn.onclick = () => insert(btn.dataset.url); });
    } catch (e) { body.innerHTML = '<div class="empty">加载失败：' + escape(e.message) + '</div>'; }
  };
  overlay.querySelector('#mm-upload').onchange = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('文件不能超过 10MB', 'error');
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api('/admin/media/upload', { method: 'POST', body: { name: file.name, data: base64, mime: file.type || 'application/octet-stream' }, timeout: 120000 });
      toast('上传成功');
      load();
    } catch (e) { toast(e.message, 'error'); }
  };
  load();
};
window.mdToggleMode = () => {
  const wrap = mdEl('pe-wrap'); if (!wrap) return;
  const modes = ['split', 'editor', 'preview'];
  const next = modes[(modes.indexOf(wrap.dataset.mode || 'split') + 1) % modes.length];
  wrap.dataset.mode = next;
  const btn = mdEl('pe-mode-btn');
  if (btn) btn.textContent = next === 'split' ? '分屏' : (next === 'editor' ? '写作' : '预览');
};
window.mdToggleFullscreen = () => {
  const card = mdEl('pe-editor-card'); if (!card) return;
  card.classList.toggle('editor-fs');
};
window.openPostEditor = (type = 'post', id) => showView('editor:' + type + ':' + (id || 'new'), signal => loadPostEditor(type, id, signal), true);
async function loadPostEditor(type, id, signal) {
  type = type || 'post';
  const isPage = type === 'page';
  // 四项互不依赖，同时读取；可选信息失败不阻止写作。
  const [post, cats, templates, options] = await Promise.all([
    id ? api('/admin/posts/' + id, { signal }) : null,
    api('/admin/categories', { signal }).catch(() => []),
    isPage ? api('/admin/page-templates', { signal }).catch(() => null) : null,
    api(user?.role === 'admin' ? '/admin/options' : '/options/public', { signal }).catch(() => null),
  ]);
  // 请求被切页或另一个编辑器取消后，不再覆盖当前页面。
  if (signal.aborted) return;
  const pageTpls = templates?.templates || [];
  const permalinkTpl = (isPage ? '/page/{slug}' : (Array.isArray(options)
    ? options.find(o => o.key === 'permalink')?.value : options?.permalink)) || '/archives/{cid}/';
  const curTpl = post ? (post.template || '') : '';
  const tplOpts = ['<option value=""' + (curTpl ? '' : ' selected') + '>默认模板（page.html）</option>']
    .concat(pageTpls.map(t => '<option value="' + escape(t.key) + '"' + (curTpl === t.key ? ' selected' : '') + '>' + escape(t.name) + '（' + escape(t.file) + '）</option>'))
    .join('');
  // 与 Typecho 一致：主题里没有 page-*.html 时不显示「页面模板」下拉
  const tplGroup = (isPage && pageTpls.length)
    ? '<div class="form-group"><label>页面模板</label><select id="pe-template">' + tplOpts + '</select></div>'
    : '';
  const catOpts = ['<option value="">无分类</option>'].concat((cats || []).map(c => '<option value="' + c.id + '"' + (post && post.category_id === c.id ? ' selected' : '') + '>' + escape(c.name) + '</option>')).join('');
  const st = post ? post.status : (user?.role === 'contributor' ? 'draft' : 'published');
  const statuses = user?.role === 'contributor' ? [['draft', '草稿']] : [['draft', '草稿'], ['published', '发布'], ['pending', '待审核']];
  const statusOpts = statuses.map(x => '<option value="' + x[0] + '"' + (st === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  const tagStr = post && post.tags ? post.tags.map(t => t.name).join(',') : '';
  const saveBtn = '<button class="btn btn-primary btn-block" onclick="savePost(\'' + type + '\',' + (id ? '\'' + id + '\'' : 'null') + ')">' + (id ? '更新' : '保存') + '</button>';
  setTopbar('<button class="btn btn-outline" onclick="navigate(\'' + (isPage ? 'pages' : 'posts') + '\')">← 返回列表</button>');
  document.getElementById('page-title').textContent = (id ? '编辑' : '新建') + (isPage ? '页面' : '文章');
  const tagBox = isPage ? '' : (`
        <div class="side-box">
          <div class="side-box-title">分类与标签</div>
          <div class="form-group"><label>分类</label><select id="pe-cat">${catOpts}</select></div>
          <div class="form-group"><label>标签（逗号分隔）</label><input id="pe-tags" value="${escape(tagStr)}" placeholder="tag1,tag2"></div>
        </div>`);
  document.getElementById('content').innerHTML = `
  <div class="card editor-card" id="pe-editor-card">
    <div class="editor-layout">
      <div class="editor-main">
        <div class="form-group"><input id="pe-title" class="editor-title" placeholder="请输入标题" value="${escape(post ? post.title : '')}"></div>
        <div class="editor-toolbar">
          <div class="tb-group">
            <button type="button" class="tb" title="二级标题" onclick="mdPrefix('## ')">H2</button>
            <button type="button" class="tb" title="三级标题" onclick="mdPrefix('### ')">H3</button>
          </div>
          <div class="tb-group">
            <button type="button" class="tb" title="粗体 (Ctrl+B)" onclick="mdWrap('**','**','粗体')"><b>B</b></button>
            <button type="button" class="tb" title="斜体 (Ctrl+I)" onclick="mdWrap('*','*','斜体')"><i>I</i></button>
            <button type="button" class="tb" title="删除线" onclick="mdWrap('~~','~~','删除线')"><s>S</s></button>
            <button type="button" class="tb" title="行内代码" onclick="mdInsertInlineCode()">&lt;/&gt;</button>
          </div>
          <div class="tb-group">
            <button type="button" class="tb" title="链接 (Ctrl+K)" onclick="mdLink()">链接</button>
            <button type="button" class="tb" title="从附件库插入图片" onclick="mdPickMedia()">图片</button>
            <button type="button" class="tb" title="通过图片地址插入" onclick="mdImage()">图片地址</button>
            <button type="button" class="tb" title="引用" onclick="mdPrefix('&gt; ')">❝ 引用</button>
            <button type="button" class="tb" title="代码块" onclick="mdInsertCode()">{ }</button>
          </div>
          <div class="tb-group">
            <button type="button" class="tb" title="无序列表" onclick="mdPrefix('- ')">• 列表</button>
            <button type="button" class="tb" title="有序列表" onclick="mdPrefix('1. ')">1. 列表</button>
            <button type="button" class="tb" title="分隔线" onclick="mdInsertHr()">— 分隔</button>
          </div>
          <div class="tb-right">
            <span id="pe-count" class="tb-count">0 字</span>
            <button type="button" class="tb" id="pe-mode-btn" title="写作 / 分屏 / 预览" onclick="mdToggleMode()">分屏</button>
            <button type="button" class="tb" title="全屏编辑（Esc 退出）" onclick="mdToggleFullscreen()">全屏</button>
          </div>
        </div>
        <div class="editor-wrap" id="pe-wrap" data-mode="split">
          <div class="editor-pane"><textarea id="pe-content" placeholder="开始写作…支持 Markdown，Ctrl/Cmd+S 保存">${escape(post ? post.content : '')}</textarea></div>
          <div class="preview-pane" id="pe-preview"></div>
        </div>
        <div class="form-group" style="margin-top:16px"><label class="check-line"><input id="pe-excerpt-auto" type="checkbox"${post?.excerpt_auto === 0 ? '' : ' checked'}> 自动生成摘要</label><textarea id="pe-excerpt" rows="2" placeholder="关闭自动摘要后可手动填写">${escape(post?.excerpt_auto === 0 ? post.excerpt : '')}</textarea><div class="hint">自动模式遵循全站摘要长度，也支持正文中的 &lt;!--more--&gt; 分割线。</div></div>
      </div>
      <aside class="editor-side">
        <div class="side-box">
          <div class="side-box-title">发布</div>
          <div class="form-group"><label>状态</label><select id="pe-status">${statusOpts}</select></div>
          <div class="form-group"><label for="pe-published-at">发布时间</label><input id="pe-published-at" type="datetime-local" step="1" value="${localDateTime(post?.published_at)}"><div class="hint">本地时间；留空在首次发布时使用当前时间，未来时间到点后自动公开。</div></div>
          <label class="check-line"><input type="checkbox" id="pe-comment-allowed"${post?.comment_allowed === 0 ? '' : ' checked'}> 允许评论</label>
          ${isPage ? '' : '<label class="check-line"><input type="checkbox" id="pe-sticky"' + (post && post.sticky ? ' checked' : '') + '> 置顶到首页</label>'}
          <div class="side-actions">${saveBtn}</div>
        </div>
        <div class="side-box">
          <div class="side-box-title">别名（URL）</div>
          <div class="form-group"><input id="pe-slug" value="${escape(post ? post.slug : '')}" placeholder="留空自动生成"><div class="hint" id="pe-slug-hint"></div></div>
        </div>
        ${tagBox}
        <div class="side-box">
          <div class="side-box-title">更多</div>
          <div class="form-group"><label>封面图（URL，可选）</label><input id="pe-cover" value="${escape(post ? (post.cover_image || '') : '')}" placeholder="https://…"></div>
          ${tplGroup}
          ${isPage ? '<div class="form-group"><label for="pe-order">页面顺序</label><input id="pe-order" type="number" step="1" value="' + (post?.order || 0) + '"><div class="hint">数字越小越靠前</div></div>' : ''}
        </div>
      </aside>
    </div>
  </div>`;
  const ta = document.getElementById('pe-content');
  const titleInput = document.getElementById('pe-title');
  const slugInput = document.getElementById('pe-slug');
  const slugHint = document.getElementById('pe-slug-hint');
  const excerptInput = document.getElementById('pe-excerpt');
  const excerptAuto = document.getElementById('pe-excerpt-auto');
  const syncExcerptMode = () => { excerptInput.disabled = excerptAuto.checked; };
  excerptAuto.addEventListener('change', syncExcerptMode);
  syncExcerptMode();
  // 别名联动：新建时跟随标题自动生成；手动改过或编辑旧文后不再自动覆盖
  let slugTouched = !!post;
  const renderSlugHint = () => {
    if (!slugHint) return;
    const current = slugInput.value.trim() || mdClientSlug(titleInput.value) || '自动生成';
    const path = permalinkTpl
      .replace('{slug}', encodeURIComponent(current))
      .replace('{cid}', id || 'ID')
      .replace('{category}', '…').replace('{year}', '…').replace('{month}', '…');
    slugHint.textContent = '预计地址：' + path + (permalinkTpl.includes('{slug}') ? '' : '（当前永久链接未使用别名，可在 设置 → 永久链接 中切换）');
  };
  titleInput.addEventListener('input', () => {
    if (!slugTouched) slugInput.value = mdClientSlug(titleInput.value);
    renderSlugHint();
  });
  slugInput.addEventListener('input', () => { slugTouched = true; renderSlugHint(); });
  ta.addEventListener('input', mdSync);
  ta.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    const key = (ev.key || '').toLowerCase();
    if (mod && key === 'b') { ev.preventDefault(); window.mdWrap('**', '**', '粗体'); return; }
    if (mod && key === 'i') { ev.preventDefault(); window.mdWrap('*', '*', '斜体'); return; }
    if (mod && key === 'k') { ev.preventDefault(); window.mdLink(); return; }
    if (mod && key === 's') { ev.preventDefault(); window.savePost(type, id || null); return; }
    if (ev.key === 'Tab') { ev.preventDefault(); window.mdInsertText('  '); return; }
    if (ev.key === 'Escape') { const card = document.getElementById('pe-editor-card'); if (card && card.classList.contains('editor-fs')) window.mdToggleFullscreen(); }
  });
  // 本地草稿：停止输入 800ms 后写入 localStorage，保存成功后清除
  const draftKey = 'lill:draft:' + type + ':' + (id || 'new');
  let draftTimer = null;
  window.__lillDraftSave = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify({ title: titleInput.value, content: ta.value, excerpt: excerptInput.value, excerptAuto: excerptAuto.checked, at: Date.now() })); } catch (e) {}
    }, 800);
  };
  try {
    const raw = localStorage.getItem(draftKey);
    if (raw) {
      const draft = JSON.parse(raw);
      const serverContent = post ? (post.content || '') : '';
      const serverTitle = post ? (post.title || '') : '';
      const draftAutomatic = typeof draft?.excerptAuto === 'boolean' ? draft.excerptAuto : !draft?.excerpt;
      const changed = draft && ((draft.content || '') !== serverContent || (draft.title || '') !== serverTitle ||
        (draft.excerpt || '') !== excerptInput.value || draftAutomatic !== excerptAuto.checked);
      if (changed && (draft.content || draft.title) && confirm('检测到未保存的草稿（' + new Date(draft.at).toLocaleString() + '），是否恢复？')) {
        titleInput.value = draft.title || titleInput.value;
        ta.value = draft.content;
        excerptInput.value = draft.excerpt || '';
        excerptAuto.checked = draftAutomatic;
        syncExcerptMode();
        if (!slugTouched && !slugInput.value) slugInput.value = mdClientSlug(titleInput.value);
      }
    }
  } catch (e) {}
  titleInput.addEventListener('input', window.__lillDraftSave);
  excerptInput.addEventListener('input', window.__lillDraftSave);
  excerptAuto.addEventListener('change', window.__lillDraftSave);
  mdSync();
  renderSlugHint();
}

window.savePost = async (type, id) => {
  const view = activeView;
  const titleEl = document.getElementById('pe-title');
  if (!titleEl) return;
  const title = titleEl.value.trim();
  if (!title) return toast('请填写标题', 'error');
  const content = document.getElementById('pe-content').value;
  const body = {
    title, content, type,
    slug: document.getElementById('pe-slug').value.trim(),
    status: document.getElementById('pe-status').value,
    excerpt: document.getElementById('pe-excerpt').value || null,
    excerptAuto: document.getElementById('pe-excerpt-auto').checked,
    commentAllowed: document.getElementById('pe-comment-allowed').checked,
  };
  const published = document.getElementById('pe-published-at');
  if (published.value !== published.defaultValue) body.publishedAt = published.value ? new Date(published.value).toISOString() : null;
  const order = document.getElementById('pe-order');
  if (order) body.order = Number(order.value);
  const catEl = document.getElementById('pe-cat');
  if (catEl) body.categoryId = catEl.value || null;
  const tagEl = document.getElementById('pe-tags');
  if (tagEl) body.tagNames = tagEl.value.split(',').map(s => s.trim()).filter(Boolean);
  const coverEl = document.getElementById('pe-cover');
  if (coverEl) body.coverImage = coverEl.value.trim() || null;
  const stickyEl = document.getElementById('pe-sticky');
  if (stickyEl) body.sticky = stickyEl.checked;
  // 仅当页面模板下拉存在时才提交 template，避免误清空已有设置
  if (type === 'page') { const tsel = document.getElementById('pe-template'); if (tsel) body.template = tsel.value; }
  try {
    if (id) await api('/admin/posts/' + id, { method: 'PUT', body });
    else await api('/admin/posts', { method: 'POST', body });
    try { localStorage.removeItem('lill:draft:' + type + ':' + (id || 'new')); } catch (e) {}
    toast(id ? '已更新' : '已保存');
    if (activeView === view) return window.navigate(type === 'page' ? 'pages' : 'posts');
  } catch (e) { toast(e.message, 'error'); }
};

window.delPost = async (id) => { if (!confirm('确定删除？')) return; const view = activeView; try { await api('/admin/posts/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

// ═══ 文章列表 ═══
async function renderPosts() {
  const r = await api('/admin/posts?page=' + pageNum + '&pageSize=20' + (postStatus ? '&status=' + postStatus : ''));
  const rows = (r.items || []).map(p => '<tr><td><input type="checkbox" class="post-check" value="' + p.id + '"></td><td><strong>' + escape(p.title) + '</strong><br><small style="color:#64748b">' + escape(p.slug) + '</small></td><td>' + escape(p.category_name || '-') + '</td><td>' + statusLabel(p.status) + '</td><td>' + (p.comment_count || 0) + '</td><td>' + (p.view_count || 0) + '</td><td>' + fmt(p.created_at) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openPostEditor(\'post\',' + jsArg(p.id) + ')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delPost(\'' + p.id + '\')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openPostEditor(\'post\')">+ 写文章</button>');
  const filters = (user?.role === 'contributor' ? [['', '全部'], ['draft', '草稿']] : [['', '全部'], ['published', '已发布'], ['draft', '草稿'], ['pending', '待审核'], ['trash', '回收站']]).map(([value, label]) =>
    '<button class="filter-tab' + (postStatus === value ? ' active' : '') + '" aria-pressed="' + (postStatus === value) + '" onclick="filterPosts(\'' + value + '\')">' + label + '</button>').join('');
  document.getElementById('content').innerHTML = '<div class="toolbar"><div class="filter-tabs" aria-label="文章状态">' + filters + '</div><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllPosts(this.checked)"> 选择本页文章</label></div><div class="table-container"><table><thead><tr><th><input aria-label="选择本页文章" type="checkbox" onchange="toggleAllPosts(this.checked)"></th><th>标题</th><th>分类</th><th>状态</th><th>评论</th><th>浏览</th><th>日期</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8"><div class="empty">该状态下暂无文章</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
}

window.filterPosts = status => { postStatus = ['', 'published', 'draft', 'pending', 'trash'].includes(status) ? status : ''; pageNum = 1; return render(); };
window.toggleAllPosts = (checked) => { document.querySelectorAll('.post-check').forEach(c => c.checked = checked); };
window.batchPosts = async (action) => {
  const view = activeView;
  const ids = Array.from(document.querySelectorAll('.post-check:checked')).map(c => c.value);
  if (!ids.length) return toast('请先选择文章', 'error');
  if (action === 'delete' && !confirm('确定删除选中的文章？')) return;
  try {
    await api('/admin/posts/batch', { method: 'POST', body: { ids, action } });
    toast('操作完成'); refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

// ═══ 页面列表 ═══
async function renderPages() {
  const r = await api('/admin/pages?page=' + pageNum + '&pageSize=20');
  const rows = (r.items || []).map(p => '<tr><td><strong>' + escape(p.title) + '</strong><br><small style="color:#64748b">' + escape(p.slug) + '</small></td><td>' + statusLabel(p.status) + '</td><td>' + (p.view_count || 0) + '</td><td>' + fmt(p.created_at) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openPostEditor(\'page\',\'' + p.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delPost(\'' + p.id + '\')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openPostEditor(\'page\')">+ 新建页面</button>');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>标题</th><th>状态</th><th>浏览</th><th>日期</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5"><div class="empty">暂无页面</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
}

// ═══ 操作日志 ═══
async function renderLogs() {
  const r = await api('/admin/logs?page=' + pageNum + '&pageSize=20');
  const rows = (r.items || []).map(l => '<tr><td>' + fmt(l.created_at) + '</td><td>' + escape(l.username || '-') + '</td><td><code>' + escape(l.action) + '</code></td><td>' + escape(l.detail || '-') + '</td><td>' + escape(l.ip || '-') + '</td></tr>').join('');
  setTopbar('<button class="btn btn-danger" onclick="clearLogs()">清空日志</button>');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th><th>IP</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5"><div class="empty">暂无日志</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
}

window.clearLogs = async () => {
  if (!confirm('确定清空所有日志？')) return;
  const view = activeView;
  try { await api('/admin/logs', { method: 'DELETE' }); toast('已清空'); refreshView(view); } catch (e) { toast(e.message, 'error'); }
};

// ═══ 备份 ═══
async function renderBackup() {
  const backups = await api('/admin/backup/list');
  setTopbar('<button class="btn btn-primary" onclick="createBackup()">+ 创建备份</button>');
  const rows = backups.map(b => '<tr><td>' + escape(b.name) + '</td><td>' +
    (b.size / 1024).toFixed(1) + ' KB</td><td>' + escape(new Date(b.created_at).toLocaleString('zh-CN')) +
    '</td><td><button class="btn btn-sm btn-outline" onclick="downloadBackup(' + jsArg(b.name) + ')">下载</button></td></tr>').join('');
  document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">站点备份</h3>' +
    '<p>数据库和附件分别打包。数据库包含账号及配置，请将下载的备份妥善保存。</p></div>' +
    '<div class="table-container"><table><thead><tr><th>文件</th><th>大小</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="4"><div class="empty">暂无备份，点击创建备份</div></td></tr>') + '</tbody></table></div>';
}

window.createBackup = async () => {
  const view = activeView;
  const buttons = [...document.querySelectorAll('button[onclick="createBackup()"]')];
  if (buttons.some(button => button.disabled)) return;
  buttons.forEach(button => { button.disabled = true; button.textContent = '备份中…'; });
  try {
    await api('/admin/backup', { method: 'POST', timeout: 180000 });
    toast('备份已创建，可以下载'); refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
  finally { buttons.forEach(button => { button.disabled = false; button.textContent = '+ 创建备份'; }); }
};
window.downloadBackup = async name => {
  try {
    const response = await fetch('/api/v1/admin/backup/' + encodeURIComponent(name) + '/download', {
      headers: { Authorization: 'Bearer ' + window.lillAPI.getToken() },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.message || '下载失败，请重试');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast(e.message, 'error'); }
};

// ═══ 分类 ═══
async function renderCategories() {
  const r = await api('/admin/categories');
  const rows = (r || []).map(c => '<tr><td><strong>' + escape(c.name) + '</strong></td><td><code>' + escape(c.slug) + '</code></td><td>' + escape(c.description || '-') + '</td><td>' + (c.parent_name ? escape(c.parent_name) : '-') + '</td><td>' + (c.post_count || 0) + '</td><td class="actions">' + (managesTaxonomy() ? '<button class="btn btn-sm btn-outline" onclick="openCatEditor(\'' + c.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delCat(\'' + c.id + '\')">删除</button>' : '只读') + '</td></tr>').join('');
  setTopbar(managesTaxonomy() ? '<button class="btn btn-primary" onclick="openCatEditor()">+ 新建分类</button>' : '');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>名称</th><th>别名</th><th>描述</th><th>父级</th><th>文章数</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6"><div class="empty">暂无分类</div></td></tr>') + '</tbody></table></div>';
  labelTableRows();
}

window.openCatEditor = id => showView('category-editor:' + (id || 'new'), signal => loadCatEditor(id, signal), true);
async function loadCatEditor(id, signal) {
  let cat = null, cats = [];
  cats = await api('/admin/categories', { signal });
  if (signal.aborted) return;
  if (id) cat = (cats || []).find(c => c.id === id);
  const parentOpts = ['<option value="">无父级</option>'].concat((cats || []).filter(c => c.id !== id).map(c => '<option value="' + c.id + '"' + (cat && cat.parent_id === c.id ? ' selected' : '') + '>' + escape(c.name) + '</option>')).join('');
  document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">' + (id ? '编辑分类' : '新建分类') + '</h3>' +
    '<div class="form-group"><label>名称</label><input id="ce-name" value="' + escape(cat ? cat.name : '') + '"></div>' +
    '<div class="form-group"><label>别名（留空自动生成）</label><input id="ce-slug" value="' + escape(cat ? cat.slug : '') + '"></div>' +
    '<div class="form-group"><label>描述</label><textarea id="ce-desc" rows="2">' + escape(cat ? cat.description : '') + '</textarea></div>' +
    '<div class="form-group"><label>父级分类</label><select id="ce-parent">' + parentOpts + '</select></div>' +
    '<div class="form-group"><label>排序</label><input id="ce-sort" type="number" value="' + (cat ? cat.sort_order : 0) + '"></div>' +
    '<button class="btn btn-primary" onclick="saveCat(' + (id ? '\'' + id + '\'' : 'null') + ')">保存</button> <button class="btn btn-outline" onclick="navigate(\'categories\')">取消</button></div>';
}

window.saveCat = async (id) => {
  const view = activeView;
  const name = document.getElementById('ce-name').value.trim();
  if (!name) return toast('请填写名称', 'error');
  const body = { name, slug: document.getElementById('ce-slug').value.trim() || undefined, description: document.getElementById('ce-desc').value, parentId: document.getElementById('ce-parent').value || null, sortOrder: parseInt(document.getElementById('ce-sort').value) || 0 };
  try {
    if (id) await api('/admin/categories/' + id, { method: 'PUT', body });
    else await api('/admin/categories', { method: 'POST', body });
    toast('已保存'); refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

window.delCat = async (id) => { if (!confirm('确定删除？该分类下的文章将变为未分类')) return; const view = activeView; try { await api('/admin/categories/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

// ═══ 标签 ═══
async function renderTags() {
  const r = await api('/admin/tags?pageSize=100&page=' + pageNum);
  const rows = (r.items || []).map(t => '<tr><td><strong>' + escape(t.name) + '</strong></td><td><code>' + escape(t.slug) + '</code></td><td>' + (t.post_count || 0) + '</td><td class="actions">' + (managesTaxonomy() ? '<button class="btn btn-sm btn-outline" onclick="openTagEditor(' + jsArg(t.id) + ',' + jsArg(t.name) + ')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delTag(\'' + t.id + '\')">删除</button>' : '只读') + '</td></tr>').join('');
  setTopbar(managesTaxonomy() ? '<button class="btn btn-primary" onclick="openTagEditor()">+ 新建标签</button>' : '');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>名称</th><th>别名</th><th>文章数</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="4"><div class="empty">暂无标签</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
}
window.openTagEditor = (id, name) => {
  const view = activeView;
  const n = prompt('标签名称：', name || '');
  if (!n) return;
  (async () => {
    try {
      if (id) await api('/admin/tags/' + id, { method: 'PUT', body: { name: n } });
      else await api('/admin/tags', { method: 'POST', body: { name: n } });
      toast('已保存'); refreshView(view);
    } catch (e) { toast(e.message, 'error'); }
  })();
};
window.delTag = async (id) => { if (!confirm('确定删除？')) return; const view = activeView; try { await api('/admin/tags/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

// ═══ 评论 ═══
let selectedComments = new Set();
let commentRows = new Map();

async function renderComments() {
  const status = commentStatus;
  const r = await api('/admin/comments?page=' + pageNum + '&pageSize=20' + (status ? '&status=' + status : ''));
  commentRows = new Map((r.items || []).map(c => [c.id, c]));
  const rows = (r.items || []).map(c => '<tr><td><input type="checkbox" aria-label="选择评论" class="cmt-check" value="' + c.id + '" ' + (selectedComments.has(c.id) ? 'checked' : '') + ' onchange="toggleCmtCheck(\'' + c.id + '\', this.checked)"></td><td>' + escape((c.content || '').substring(0, 50)) + '</td><td>' + escape(c.post_title || '-') + '</td><td>' + escape(c.author_name || c.username || '匿名') + '</td><td>' + statusLabel(c.status) + '</td><td>' + fmt(c.created_at) + '</td><td class="actions">' +
    (c.status !== 'approved' ? '<button class="btn btn-sm btn-outline" onclick="setCmt(\'' + c.id + '\',\'approved\')">通过</button> ' : '') +
    (c.status !== 'spam' ? '<button class="btn btn-sm btn-outline" onclick="setCmt(\'' + c.id + '\',\'spam\')">垃圾</button> ' : '') +
    '<button class="btn btn-sm btn-outline" onclick="replyCmt(\'' + c.id + '\')">回复</button> ' +
    '<button class="btn btn-sm btn-outline" onclick="editCmt(\'' + c.id + '\')">编辑</button> ' +
    '<button class="btn btn-sm btn-danger" onclick="delCmt(\'' + c.id + '\')">删除</button></td></tr>').join('');
  
  setTopbar('');
  document.getElementById('content').innerHTML =
    '<div class="toolbar"><label for="cf-status">评论状态</label><select id="cf-status" onchange="filterComments(this.value)">' +
    ['', 'pending', 'approved', 'spam'].map(v => '<option value="' + v + '"' + (status === v ? ' selected' : '') + '>' + ({ '': '所有状态', pending: '待审核', approved: '已通过', spam: '垃圾' }[v]) + '</option>').join('') +
    '</select><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllCmts(this.checked)"' +
    ((r.items || []).length && r.items.every(c => selectedComments.has(c.id)) ? ' checked' : '') + '> 选择本页评论</label></div><div id="comment-selection"></div>' +
    '<div class="table-container"><table><thead><tr><th><input aria-label="选择本页评论" type="checkbox" onchange="toggleAllCmts(this.checked)"></th><th>内容</th><th>文章</th><th>作者</th><th>状态</th><th>日期</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty">该状态下暂无评论</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
  updateCommentSelection();
}
function updateCommentSelection() {
  const bar = document.getElementById('comment-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.cmt-check')];
  checks.forEach(el => { el.checked = selectedComments.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllCmts(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  bar.innerHTML = selectedComments.size ? '<div class="batch-bar"><span>已选 ' + selectedComments.size + ' 项</span><button class="btn btn-sm btn-outline" onclick="batchCmtStatus(\'approved\')">批量通过</button><button class="btn btn-sm btn-outline" onclick="batchCmtStatus(\'spam\')">批量垃圾</button><button class="btn btn-sm btn-danger" onclick="batchCmtDelete()">批量删除</button><button class="btn btn-sm btn-outline" onclick="clearCmtSelection()">取消选择</button></div>' : '';
}
window.filterComments = status => { commentStatus = ['', 'pending', 'approved', 'spam'].includes(status) ? status : ''; selectedComments.clear(); pageNum = 1; return render(); };
window.setCmt = async (id, status) => { const view = activeView; try { await api('/admin/comments/' + id + '/status', { method: 'PATCH', body: { status } }); toast('已更新'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };
window.delCmt = async (id) => { if (!confirm('确定删除？')) return; const view = activeView; try { await api('/admin/comments/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };
window.toggleCmtCheck = (id, checked) => { if (checked) selectedComments.add(id); else selectedComments.delete(id); updateCommentSelection(); };
window.toggleAllCmts = (checked) => { 
  if (checked) { document.querySelectorAll('.cmt-check').forEach(el => selectedComments.add(el.value)); }
  else { selectedComments.clear(); }
  updateCommentSelection();
};
window.clearCmtSelection = () => { selectedComments.clear(); updateCommentSelection(); };
window.batchCmtStatus = async (status) => {
  if (!selectedComments.size) return;
  const view = activeView;
  const ids = Array.from(selectedComments);
  try {
    await api('/admin/comments/batch-status', { method: 'PATCH', body: { ids, status } });
    toast('操作完成');
    if (activeView?.navigation === view.navigation) { selectedComments.clear(); refreshView(view); }
  } catch (e) { toast(e.message, 'error'); }
};
window.batchCmtDelete = async () => {
  if (!selectedComments.size) return;
  if (!confirm('确定删除选中的 ' + selectedComments.size + ' 条评论？')) return;
  const view = activeView;
  const ids = Array.from(selectedComments);
  try {
    for (const id of ids) { await api('/admin/comments/' + id, { method: 'DELETE' }); }
    toast('已删除');
    if (activeView?.navigation === view.navigation) { selectedComments.clear(); refreshView(view); }
  } catch (e) { toast(e.message, 'error'); }
};
window.replyCmt = async (id) => {
  const view = activeView;
  try {
    const c = commentRows.get(id);
    if (!c) return toast('评论不存在', 'error');
    const content = prompt('回复 ' + (c.author_name || '匿名') + '：', '');
    if (!content) return;
    await api('/admin/comments/' + id + '/reply', { method: 'POST', body: { content } });
    toast('已回复'); refreshView(view);
  } catch (e) { if (e.message !== '请求已取消') toast(e.message, 'error'); }
};
window.editCmt = async (id) => {
  const view = activeView;
  try {
    const c = commentRows.get(id);
    if (!c) return toast('评论不存在', 'error');
    const content = prompt('编辑评论：', c.content || '');
    if (!content) return;
    await api('/admin/comments/' + id, { method: 'PUT', body: { content } });
    toast('已更新'); refreshView(view);
  } catch (e) { if (e.message !== '请求已取消') toast(e.message, 'error'); }
};

// ═══ 附件 ═══
async function renderMedia() {
  const r = await api('/admin/media?pageSize=24&page=' + pageNum);
  const grid = (r.items || []).map(m => '<div class="media-card"><div class="mp">' + (String(m.mime_type || '').startsWith('image/') ? '<img src="' + escape(m.url) + '" alt="' + escape(m.alt || m.name) + '">' : '<div class="mfi">📎</div>') + '</div><div class="mi2"><div class="mn" title="' + escape(m.name) + '">' + escape(m.name) + '</div><div class="mm">' + (m.size / 1024).toFixed(1) + ' KB · ' + fmt(m.created_at) + '</div></div><div class="ma"><button class="btn btn-sm btn-danger" onclick="delMedia(\'' + m.id + '\')">删除</button></div></div>').join('');
  setTopbar('<button class="btn btn-primary" onclick="uploadMedia()">+ 上传附件</button>');
  document.getElementById('content').innerHTML = '<div class="card"><input type="file" id="media-file-input" accept="image/*,.pdf,.txt,.md,.zip" style="display:none"><div class="media-grid">' + (grid || '<div class="empty">暂无附件，点击右上角上传</div>') + '</div></div>' + paginate(r.meta);
  const fi = document.getElementById('media-file-input');
  if (fi) fi.onchange = handleMediaFile;
}
async function handleMediaFile(ev) {
  const view = activeView;
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return toast('文件不能超过 10MB', 'error');
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  try {
    await api('/admin/media/upload', { method: 'POST', body: { name: file.name, data: base64, mime: file.type || 'application/octet-stream' }, timeout: 120000 });
    toast('上传成功');
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
}
window.uploadMedia = () => {
  const el = document.getElementById('media-file-input');
  if (el) el.click();
};
window.delMedia = async (id) => { if (!confirm('确定删除？')) return; const view = activeView; try { await api('/admin/media/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

// ═══ 外观（Typecho 模式：主题列表 → 选主题 → 专属设置页） ═══
let currentThemeId = null;

async function renderThemes() {
  currentThemeId = null;
  const themes = await api('/admin/themes');
  let html = '<div class="card"><h3 class="card-title">主题</h3><div class="theme-grid">';
  if (themes.length) themes.forEach(t => {
    var screenshot = t.screenshot ? '<img src="' + escape(t.screenshot) + '" alt="" loading="lazy">' : '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M3 4h18v16H3z M3 8h18 M8 8v12"/></svg>';
    html += '<div class="theme-card' + (t.active ? ' active' : '') + '">' +
      '<div class="thumb">' + screenshot + (t.active ? '<span class="theme-badge">使用中</span>' : '') + '</div>' +
      '<div class="tv"><h3>' + escape(t.name) + '</h3>' +
      '<p>' + escape(t.description || '暂无描述') + '</p>' +
      '<div class="theme-meta"><span class="theme-version">v' + escape(t.version) + '</span>' +
      (t.author ? '<span class="theme-author">作者：' + escape(t.author) + '</span>' : '') + '</div>' +
      '<div class="actions">' +
      (t.active ? '<span class="tag tag-green">当前主题</span>' : '<button class="btn btn-sm btn-primary" onclick="activateTheme(\'' + escape(t.theme_id) + '\')">启用</button>') +
      (t.hasSettings ? '<button class="btn btn-sm btn-outline" onclick="openThemeSettings(\'' + escape(t.theme_id) + '\')">设置</button>' : '') +
      '</div></div></div>';
  });
  else html += '<div class="empty">暂无主题</div>';
  html += '</div></div>';
  html += '<div class="card" style="margin-top:20px"><h3 class="card-title">安装主题</h3>' +
    '<p style="color:var(--text-light);font-size:13px;margin-bottom:12px">上传主题 ZIP 压缩包即可安装（包内需含 <code>theme.json</code>）。安装后不会自动启用，可先预览再切换。</p>' +
    '<input type="file" id="themeZip" accept=".zip" style="display:none" onchange="uploadTheme(this)">' +
    '<button class="btn btn-primary" onclick="document.getElementById(\'themeZip\').click()">+ 上传主题包 (.zip)</button>' +
    '<span id="themeInstallMsg" style="margin-left:12px;font-size:13px;color:var(--text-light)"></span></div>';
  setTopbar('');
  document.getElementById('content').innerHTML = html;
}
window.renderThemes = renderThemes;

window.uploadTheme = async (input) => {
  const view = activeView;
  const file = input.files && input.files[0];
  if (!file) return;
  const msg = document.getElementById('themeInstallMsg');
  if (!/\.zip$/i.test(file.name)) { toast('请选择 .zip 主题包', 'error'); input.value = ''; return; }
  if (file.size > 30 * 1024 * 1024) { toast('主题包不能超过 30MB', 'error'); input.value = ''; return; }
  if (msg) msg.textContent = '正在上传并解压…';
  try {
    const data = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
    const r = await api('/admin/themes/install', { method: 'POST', body: { name: file.name, data } });
    toast('主题「' + (r.name || r.themeId) + '」安装成功');
    refreshView(view);
  } catch (e) {
    if (msg) msg.textContent = '';
    toast(e.message || '安装失败', 'error');
    input.value = '';
  }
};

window.activateTheme = async (themeId) => { const view = activeView; try { await api('/admin/themes/' + encodeURIComponent(themeId) + '/activate', { method: 'POST' }); toast('已切换主题'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

// ═══ 通用设置表单（主题设置 / 插件设置共用）═══
// schema 来自 theme.json 的 settings 或 plugin.json 的 settings，结构一致
// keyAttr：写到每个控件上的属性名，保存时按它回读表单值
function settingsFormHTML(schema, values, keyAttr) {
  const groups = [], groupMap = {};
  schema.forEach(f => {
    const g = f.group || '常规';
    if (!groupMap[g]) { groupMap[g] = []; groups.push(g); }
    groupMap[g].push(f);
  });
  let html = '';
  groups.forEach(g => {
    html += '<div class="settings-group"><h4 class="settings-group-title">' + escape(g) + '</h4>';
    groupMap[g].forEach(f => {
      const raw = values[f.key] !== undefined ? values[f.key] : (f.default !== undefined ? f.default : '');
      const v = (raw === null || raw === undefined) ? '' : String(raw);
      const id = escape(keyAttr + '_' + f.key);
      const attr = ' ' + keyAttr + '="' + escape(f.key) + '"';
      html += '<div class="form-group">' + (f.type === 'navigation' ? '' : '<label for="' + id + '">' + escape(f.label || f.key) + '</label>');
      if (f.type === 'navigation') {
        const selected = [...new Set(Array.isArray(raw) ? raw.filter(key => typeof key === 'string') : [])];
        const choices = new Map((f.options || []).map(option => [option.value, option]));
        const order = selected.concat([...choices.keys()].filter(key => !selected.includes(key)));
        html += '<fieldset id="' + id + '" class="navigation-editor" data-setting-type="navigation"' + attr + ' aria-describedby="' + id + '_hint"><legend>' + escape(f.label || f.key) + '</legend><div class="navigation-items">';
        order.forEach(key => {
          const option = choices.get(key);
          const checked = selected.includes(key);
          const index = selected.indexOf(key);
          html += '<div class="navigation-item' + (option ? '' : ' navigation-unavailable') + '">' +
            '<label class="navigation-choice"><input type="checkbox" value="' + escape(key) + '"' + (checked ? ' checked' : '') + ' onchange="updateNavigationSelection(this)">' +
            '<span><span class="navigation-name">' + escape(option ? option.label : '已删除或未公开的项目') + '</span><small>' + escape(option ? option.url : '暂不在前台显示，可取消勾选移除') + '</small></span></label>' +
            '<div class="navigation-actions"><button type="button" class="btn btn-sm btn-outline" aria-label="上移" title="上移"' + (!checked || index === 0 ? ' disabled' : '') + ' onclick="moveNavigationItem(this,-1)">↑</button>' +
            '<button type="button" class="btn btn-sm btn-outline" aria-label="下移" title="下移"' + (!checked || index === selected.length - 1 ? ' disabled' : '') + ' onclick="moveNavigationItem(this,1)">↓</button></div></div>';
        });
        html += '</div><span class="sr-only navigation-status" role="status"></span></fieldset>';
      } else if (f.type === 'color') {
        html += '<input type="color" id="' + id + '" value="' + escape(v) + '"' + attr + '>';
      } else if (f.type === 'select') {
        html += '<select id="' + id + '"' + attr + '>' + (f.options || []).map(o => '<option value="' + escape(o.value) + '"' + (v === String(o.value) ? ' selected' : '') + '>' + escape(o.label) + '</option>').join('') + '</select>';
      } else if (f.type === 'textarea') {
        html += '<textarea id="' + id + '" rows="3"' + attr + '>' + escape(v) + '</textarea>';
      } else if (f.type === 'checkbox') {
        html += '<label style="display:flex;align-items:center;gap:8px;font-weight:normal"><input type="checkbox" id="' + id + '" style="width:auto"' + (v === 'true' ? ' checked' : '') + attr + '> 启用</label>';
      } else if (f.type === 'number') {
        html += '<input type="number" id="' + id + '" value="' + escape(v) + '"' + attr + '>';
      } else {
        html += '<input type="text" id="' + id + '" value="' + escape(v) + '"' + attr + '>';
      }
      if (f.description) html += '<p class="form-hint" id="' + id + '_hint">' + escape(f.description) + '</p>';
      html += '</div>';
    });
    html += '</div>';
  });
  return html;
}

function updateNavigationButtons(editor) {
  const rows = [...editor.querySelectorAll('.navigation-item')];
  const selected = rows.filter(row => row.querySelector('input').checked);
  rows.forEach(row => {
    const index = selected.indexOf(row);
    const buttons = row.querySelectorAll('button');
    buttons[0].disabled = index <= 0;
    buttons[1].disabled = index < 0 || index === selected.length - 1;
  });
}
window.updateNavigationSelection = input => {
  const editor = input.closest('.navigation-editor');
  const list = editor.querySelector('.navigation-items');
  [...list.children].sort((a, b) => Number(b.querySelector('input').checked) - Number(a.querySelector('input').checked))
    .forEach(row => list.appendChild(row));
  updateNavigationButtons(editor);
  input.focus();
};
window.moveNavigationItem = (button, direction) => {
  const editor = button.closest('.navigation-editor');
  const row = button.closest('.navigation-item');
  const selected = [...editor.querySelectorAll('.navigation-item')].filter(item => item.querySelector('input').checked);
  const sibling = selected[selected.indexOf(row) + direction];
  if (!sibling) return;
  if (direction < 0) sibling.before(row);
  else sibling.after(row);
  updateNavigationButtons(editor);
  // Moving the first/last item disables its button. Keep keyboard focus in the row.
  if (button.disabled) row.querySelector('input').focus();
  else button.focus();
  editor.querySelector('.navigation-status').textContent = row.querySelector('.navigation-name').textContent + (direction < 0 ? '已上移' : '已下移');
};

// 按 keyAttr 从 DOM 回读表单值
function readSettingsForm(keyAttr) {
  const body = {};
  document.querySelectorAll('[' + keyAttr + ']').forEach(el => {
    const key = el.getAttribute(keyAttr);
    if (el.dataset.settingType === 'navigation') body[key] = [...el.querySelectorAll('input:checked')].map(input => input.value);
    else if (el.type === 'checkbox') body[key] = el.checked ? 'true' : 'false';
    else body[key] = el.value;
  });
  return body;
}

window.openThemeSettings = themeId => showView('theme-settings:' + themeId, signal => loadThemeSettings(themeId, signal), true);
async function loadThemeSettings(themeId, signal) {
  currentThemeId = themeId;
  const r = await api('/admin/themes/' + encodeURIComponent(themeId) + '/settings', { signal });
  if (signal.aborted) return;
  if (r.settingsUrl) {
    const target = new URL(r.settingsUrl, location.origin);
    const prefix = '/themes/' + encodeURIComponent(themeId) + '/';
    if (target.origin !== location.origin || !target.pathname.startsWith(prefix) ||
        !/\.html?$/i.test(target.pathname) || target.search || target.hash) {
      throw new Error('主题设置页地址无效');
    }
    location.assign(target.href);
    return;
  }
  const theme = r.theme || {};
  const schema = r.schema || [];
  const values = r.values || {};

  let html = '<div class="card"><h3 class="card-title">主题设置 — ' + escape(theme.name || themeId) + '</h3>';
  if (!schema.length) {
    html += '<div class="empty">该主题没有可配置的选项</div>';
  } else {
    // 按 group 分组渲染（对标 Typecho / WP 的主题设置面板）
    html += settingsFormHTML(schema, values, 'data-ts-key');
    html += '<button class="btn btn-primary" onclick="saveThemeSettings(\'' + escape(themeId) + '\')">保存设置</button>';
  }
  html += '<div style="margin-top:12px"><button class="btn btn-outline" onclick="navigate(\'themes\')">← 返回主题列表</button></div></div>';
  setTopbar('');
  document.getElementById('content').innerHTML = html;
}

window.saveThemeSettings = async (themeId) => {
  // 直接从 DOM 读取已渲染的字段（避免重复 GET 请求）
  const body = readSettingsForm('data-ts-key');
  try {
    await api('/admin/themes/' + encodeURIComponent(themeId) + '/settings', { method: 'PUT', body });
    toast('已保存');
  } catch (e) { toast(e.message, 'error'); }
};

// ═══ 用户 ═══
async function renderUsers() {
  const r = await api('/admin/users?pageSize=20&page=' + pageNum);
  const rows = (r.items || []).map(u => '<tr><td><strong>' + escape(u.username) + '</strong></td><td>' + escape(u.nickname || '-') + '</td><td>' + escape(u.email) + '</td><td><span class="tag tag-blue">' + roleLabel(u.role) + '</span></td><td>' + statusLabel(u.status) + '</td><td>' + (u.post_count || 0) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openUserEditor(\'' + u.id + '\')">编辑</button> ' + (u.id === (user && user.id) ? '' : '<button class="btn btn-sm btn-danger" onclick="delUser(\'' + u.id + '\')">删除</button>') + '</td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openUserEditor()">+ 新建用户</button>');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>用户名</th><th>昵称</th><th>邮箱</th><th>角色</th><th>状态</th><th>文章</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty">暂无用户</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
}
window.openUserEditor = id => showView('user-editor:' + (id || 'new'), signal => loadUserEditor(id, signal), true);
async function loadUserEditor(id, signal) {
  let u = null;
  if (id) { const r = await api('/admin/users?pageSize=100', { signal }); u = (r.items || []).find(x => x.id === id); }
  if (signal.aborted) return;
  const roleOpts = [['admin', '管理员'], ['editor', '编辑'], ['author', '作者'], ['contributor', '投稿者'], ['subscriber', '订阅者']].map(x => '<option value="' + x[0] + '"' + (u && u.role === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  const statusOpts = [['active', '正常'], ['banned', '禁用']].map(x => '<option value="' + x[0] + '"' + (u && u.status === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  setTopbar('<button class="btn btn-outline" onclick="navigate(\'users\')">← 返回</button>');
  document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">' + (id ? '编辑用户' : '新建用户') + '</h3>' +
    '<div class="form-group"><label>用户名</label><input id="ue-name" value="' + escape(u ? u.username : '') + '"' + (id ? ' disabled' : '') + '></div>' +
    '<div class="form-group"><label>昵称</label><input id="ue-nick" value="' + escape(u ? u.nickname : '') + '"></div>' +
    '<div class="form-group"><label>邮箱</label><input id="ue-email" value="' + escape(u ? u.email : '') + '"></div>' +
    '<div class="form-group"><label>密码' + (id ? '（留空不修改）' : '') + '</label><input id="ue-pass" type="password" placeholder="' + (id ? '留空保持不变' : '至少 6 位') + '"></div>' +
    '<div class="form-group"><label>角色</label><select id="ue-role">' + roleOpts + '</select></div>' +
    '<div class="form-group"><label>状态</label><select id="ue-status">' + statusOpts + '</select></div>' +
    '<button class="btn btn-primary" onclick="saveUser(' + (id ? '\'' + id + '\'' : 'null') + ')">保存</button></div>';
}
window.saveUser = async (id) => {
  const view = activeView;
  const body = { username: document.getElementById('ue-name').value.trim(), nickname: document.getElementById('ue-nick').value.trim(), email: document.getElementById('ue-email').value.trim(), role: document.getElementById('ue-role').value, status: document.getElementById('ue-status').value };
  const pass = document.getElementById('ue-pass').value;
  if (pass) body.password = pass;
  if (!body.username && !id) return toast('请填写用户名', 'error');
  try {
    if (id) await api('/admin/users/' + id, { method: 'PUT', body });
    else await api('/admin/users', { method: 'POST', body });
    toast('已保存'); if (activeView?.navigation === view.navigation) { pageNum = 1; refreshView(view); }
  } catch (e) { toast(e.message, 'error'); }
};
window.delUser = async (id) => { if (!confirm('确定删除该用户？')) return; const view = activeView; try { await api('/admin/users/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

// ═══ 设置 ═══
async function renderSettings() {
  const r = await api('/admin/options');
  const o = {}; (r || []).forEach(x => o[x.key] = x.value);
  
  let html = '<div class="settings-tabs">' +
    '<button class="settings-tab active" onclick="switchSettingsTab(\'basic\',this)">基本</button>' +
    '<button class="settings-tab" onclick="switchSettingsTab(\'comment\',this)">评论</button>' +
    '<button class="settings-tab" onclick="switchSettingsTab(\'reading\',this)">阅读</button>' +
    '<button class="settings-tab" onclick="switchSettingsTab(\'permalink\',this)">永久链接</button>' +
    '</div>';
  
  // 基本设置
  html += '<div id="settings-basic" class="settings-panel"><div class="card"><h3 class="card-title">基本设置</h3>' +
    '<div class="form-group"><label>站点名称</label><input id="s1" value="' + escape(o.site_name || '') + '"></div>' +
    '<div class="form-group"><label>站点描述</label><input id="s2" value="' + escape(o.site_description || '') + '"></div>' +
    '<div class="form-group"><label>站点 URL</label><input id="s3" value="' + escape(o.site_url || '') + '"></div>' +
    '<div class="form-group"><label>每页文章数</label><input id="s4" type="number" value="' + escape(o.posts_per_page || '10') + '"></div>' +
    '<div class="form-group"><label>开放注册</label><select id="s6"><option value="false"' + (o.allow_register !== 'true' ? ' selected' : '') + '>关闭</option><option value="true"' + (o.allow_register === 'true' ? ' selected' : '') + '>开放</option></select></div>' +
    '<button class="btn btn-primary" onclick="saveSettings()">保存设置</button></div></div>';
  
  // 评论设置
  html += '<div id="settings-comment" class="settings-panel" style="display:none"><div class="card"><h3 class="card-title">评论设置</h3>' +
    '<div class="form-group"><label>评论审核</label><select id="s7"><option value="true"' + (o.comment_moderation !== 'false' ? ' selected' : '') + '>需要审核</option><option value="false"' + (o.comment_moderation === 'false' ? ' selected' : '') + '>无需审核</option></select></div>' +
    '<div class="form-group"><label>评论显示方式</label><select id="s9"><option value="threaded"' + (o.comment_display !== 'flat' ? ' selected' : '') + '>嵌套显示</option><option value="flat"' + (o.comment_display === 'flat' ? ' selected' : '') + '>平铺显示</option></select></div>' +
    '<div class="form-group"><label>评论关闭</label><select id="s10"><option value="false"' + (o.comments_disabled !== 'true' ? ' selected' : '') + '>开启评论</option><option value="true"' + (o.comments_disabled === 'true' ? ' selected' : '') + '>关闭评论</option></select></div>' +
    '<div class="form-group"><label>评论每页数量</label><input id="s11" type="number" value="' + escape(o.comments_per_page || '20') + '"></div>' +
    '<button class="btn btn-primary" onclick="saveSettings()">保存设置</button></div></div>';
  
  // 阅读设置
  html += '<div id="settings-reading" class="settings-panel" style="display:none"><div class="card"><h3 class="card-title">阅读设置</h3>' +
    '<div class="form-group"><label>摘要长度</label><input id="s12" type="number" value="' + escape(o.excerpt_length || '200') + '"></div>' +
    '<div class="form-group"><label>摘要截取方式</label><select id="s13"><option value="text"' + (o.excerpt_type !== 'html' ? ' selected' : '') + '>纯文本</option><option value="html"' + (o.excerpt_type === 'html' ? ' selected' : '') + '>HTML</option></select></div>' +
    '<div class="form-group"><label>文章列表排序</label><select id="s14"><option value="date"' + (o.posts_order !== 'title' ? ' selected' : '') + '>按日期</option><option value="title"' + (o.posts_order === 'title' ? ' selected' : '') + '>按标题</option></select></div>' +
    '<button class="btn btn-primary" onclick="saveSettings()">保存设置</button></div></div>';
  
  // 永久链接设置（Typecho 风格：预设下拉 + 自定义）
  const plPatterns = [
    ['/archives/{cid}/', '默认 — /archives/{cid}/'],
    ['/archives/{slug}/', '文章别名 — /archives/{slug}/'],
    ['/{category}/{slug}/', '分类+别名 — /{category}/{slug}/'],
    ['/{year}/{month}/{slug}/', '日期+别名 — /{year}/{month}/{slug}/'],
  ];
  const plCurrent = o.permalink || '/archives/{cid}/';
  const plIsPreset = plPatterns.some(x => x[0] === plCurrent);
  let plOpts = plPatterns.map(x => '<option value="' + x[0] + '"' + (plCurrent === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  plOpts += '<option value="__custom__"' + (!plIsPreset ? ' selected' : '') + '>自定义</option>';

  const catPatterns = [
    ['/category/{slug}/', '分类别名 — /category/{slug}/'],
    ['/category/{mid}/', '分类 ID — /category/{mid}/'],
  ];
  const catCurrent = o.category_prefix || '/category/{slug}/';
  const catIsPreset = catPatterns.some(x => x[0] === catCurrent);
  let catOpts = catPatterns.map(x => '<option value="' + x[0] + '"' + (catCurrent === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  catOpts += '<option value="__custom__"' + (!catIsPreset ? ' selected' : '') + '>自定义</option>';

  const tagPatterns = [
    ['/tag/{slug}/', '标签别名 — /tag/{slug}/'],
    ['/tag/{mid}/', '标签 ID — /tag/{mid}/'],
  ];
  const tagCurrent = o.tag_prefix || '/tag/{slug}/';
  const tagIsPreset = tagPatterns.some(x => x[0] === tagCurrent);
  let tagOpts = tagPatterns.map(x => '<option value="' + x[0] + '"' + (tagCurrent === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  tagOpts += '<option value="__custom__"' + (!tagIsPreset ? ' selected' : '') + '>自定义</option>';

  html += '<div id="settings-permalink" class="settings-panel" style="display:none"><div class="card"><h3 class="card-title">永久链接设置</h3>' +
    '<div class="form-group"><label>文章路径</label><select id="s8" onchange="togglePermalinkCustom(\'post\', this.value)">' + plOpts + '</select></div>' +
    '<div class="form-group" id="s8-custom-wrap" style="display:' + (plIsPreset ? 'none' : 'block') + '"><label>自定义文章路径</label><input id="s8-custom" value="' + escape(plIsPreset ? '' : plCurrent) + '" placeholder="/archives/{slug}/"></div>' +
    '<div class="form-group"><label>分类路径</label><select id="s15" onchange="togglePermalinkCustom(\'cat\', this.value)">' + catOpts + '</select></div>' +
    '<div class="form-group" id="s15-custom-wrap" style="display:' + (catIsPreset ? 'none' : 'block') + '"><label>自定义分类路径</label><input id="s15-custom" value="' + escape(catIsPreset ? '' : catCurrent) + '" placeholder="/category/{slug}/"></div>' +
    '<div class="form-group"><label>标签路径</label><select id="s16" onchange="togglePermalinkCustom(\'tag\', this.value)">' + tagOpts + '</select></div>' +
    '<div class="form-group" id="s16-custom-wrap" style="display:' + (tagIsPreset ? 'none' : 'block') + '"><label>自定义标签路径</label><input id="s16-custom" value="' + escape(tagIsPreset ? '' : tagCurrent) + '" placeholder="/tag/{slug}/"></div>' +
    '<div class="form-hint">可用变量：{cid} 文章 ID · {slug} 别名 · {category} 分类别名 · {year} 年份 · {month} 月份 · {mid} 分类/标签 ID</div>' +
    '<button class="btn btn-primary" onclick="saveSettings()">保存设置</button></div></div>';
  
  document.getElementById('content').innerHTML = html;
  setTopbar('');
}
window.switchSettingsTab = (tab, button) => {
  document.querySelectorAll('.settings-tab').forEach(el => el.classList.remove('active'));
  if (button) button.classList.add('active');
  document.querySelectorAll('.settings-panel').forEach(el => el.style.display = 'none');
  document.getElementById('settings-' + tab).style.display = 'block';
};
function permalinkValue(selectId, customId) {
  const sel = document.getElementById(selectId);
  if (!sel) return '';
  if (sel.value === '__custom__') {
    const c = document.getElementById(customId);
    return c ? c.value.trim() : '';
  }
  return sel.value;
}
window.togglePermalinkCustom = (type, value) => {
  const map = { post: 's8', cat: 's15', tag: 's16' };
  const wrap = document.getElementById(map[type] + '-custom-wrap');
  if (wrap) wrap.style.display = value === '__custom__' ? 'block' : 'none';
};
window.saveSettings = async () => {
  const items = [
    { key: 'site_name', value: document.getElementById('s1') ? document.getElementById('s1').value : '' },
    { key: 'site_description', value: document.getElementById('s2') ? document.getElementById('s2').value : '' },
    { key: 'site_url', value: document.getElementById('s3') ? document.getElementById('s3').value : '' },
    { key: 'posts_per_page', value: document.getElementById('s4') ? document.getElementById('s4').value : '' },
    { key: 'allow_register', value: document.getElementById('s6') ? document.getElementById('s6').value : '' },
    { key: 'comment_moderation', value: document.getElementById('s7') ? document.getElementById('s7').value : '' },
    { key: 'permalink', value: permalinkValue('s8', 's8-custom') },
    { key: 'comment_display', value: document.getElementById('s9') ? document.getElementById('s9').value : '' },
    { key: 'comments_disabled', value: document.getElementById('s10') ? document.getElementById('s10').value : '' },
    { key: 'comments_per_page', value: document.getElementById('s11') ? document.getElementById('s11').value : '' },
    { key: 'excerpt_length', value: document.getElementById('s12') ? document.getElementById('s12').value : '' },
    { key: 'excerpt_type', value: document.getElementById('s13') ? document.getElementById('s13').value : '' },
    { key: 'posts_order', value: document.getElementById('s14') ? document.getElementById('s14').value : '' },
    { key: 'category_prefix', value: permalinkValue('s15', 's15-custom') },
    { key: 'tag_prefix', value: permalinkValue('s16', 's16-custom') },
  ];
  try { await api('/admin/options', { method: 'PUT', body: items }); toast('已保存'); } catch (e) { toast(e.message, 'error'); }
};

/** 后台预览用的轻量 Markdown 渲染：与后端 renderMD 的常用语法保持一致 */
function mdToHtml(md) {
  if (!md) return '<p class="preview-empty">预览会显示在这里</p>';
  const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttribute = value => escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const emphasis = value => value.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 私有占位符不能由输入伪造；代码与已生成的标签不再经过其他 Markdown 正则。
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const tokens = [];
  const tokenPattern = new RegExp('\\x00(?:CODE|INLINE)' + nonce + '(\\d+)\\x00', 'g');
  const stash = (value, text, block = false) => {
    const index = tokens.push({ html: value, text }) - 1;
    return '\x00' + (block ? 'CODE' : 'INLINE') + nonce + index + '\x00';
  };
  const restore = value => value.replace(tokenPattern, (_, index) => tokens[Number(index)].html);
  const literal = value => value.replace(tokenPattern, (_, index) => tokens[Number(index)].text);

  // 1. 在转义之前隔离代码，但其输出内容只作为纯文本转义一次。
  const source = String(md);
  const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  let html = '', cursor = 0, fence;
  while ((fence = fences.exec(source))) {
    // 短 fence 不能提前结束长 fence；编辑中未闭合的代码也保护到文末。
    const closing = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}[ \\t]*(?=\\r?$)', 'gm');
    closing.lastIndex = fences.lastIndex;
    const end = closing.exec(source);
    const text = source.slice(fences.lastIndex, end ? end.index : source.length).replace(/\r?\n$/, '');
    const lang = fence[2].trim() || 'text';
    html += source.slice(cursor, fence.index) + stash('<pre><code class="language-' +
      escapeAttribute(lang) + '">' + escapeText(text) + '</code></pre>', text, true);
    cursor = end ? closing.lastIndex : source.length;
    fences.lastIndex = cursor;
  }
  html += source.slice(cursor);
  html = html.replace(/(?<!`)(`+)(?!`)([^\n]+?)\1(?!`)/g, (_, ticks, code) =>
    stash('<code>' + escapeText(code) + '</code>', code));
  // 摘要边界不是正文；代码示例已隔离，实体形式的示例仍作为文字显示。
  html = html.replace(/<!--\s*more\s*-->/gi, '');

  const safeUrl = (url, image) => {
    // 不通过删除/trim 控制字符来“修复”危险协议，也不解码 HTML 实体后再输出。
    if (!url || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(url)) return false;
    if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(url)) return false;
    if (/&#(?:x[0-9a-f]+|\d+);?|&(?:colon|tab|newline);/i.test(url)) return false;
    if (url.startsWith('//')) return false;
    try {
      const protocol = new URL(url, 'https://markdown.invalid/').protocol;
      return protocol === 'http:' || protocol === 'https:' || (!image && protocol === 'mailto:');
    } catch { return false; }
  };

  // 只扫描链接目标的配对括号及可选引号标题，不引入完整 Markdown 解析器。
  const readTarget = (source, start) => {
    let depth = 0, quote = '';
    for (let end = start; end < source.length; end++) {
      const char = source[end];
      if (char === '\\') { end++; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if ((char === '"' || char === "'") && /[ \t]/.test(source[end - 1] || '')) {
        quote = char;
        continue;
      }
      if (char === '(') depth++;
      if (char !== ')') continue;
      if (depth) { depth--; continue; }
      const target = source.slice(start, end);
      const titled = /^(.+?)[ \t]+(["'])([\s\S]*)\2[ \t]*$/.exec(target);
      const unescape = value => value.replace(/\\([\\()[\]"'])/g, '$1');
      return {
        end: end + 1,
        url: unescape(titled ? titled[1] : target),
        title: titled ? unescape(titled[3]) : null,
      };
    }
    return null;
  };
  const replaceLinks = (source, image) => {
    // 一层嵌套方括号用于图片 alt 中的文字链接；先处理图片，再处理外层链接。
    const pattern = new RegExp((image ? '!' : '') + '\\[((?:\\\\.|[^\\[\\]\\\\\\n]|\\[(?:\\\\.|[^\\[\\]\\\\\\n])*\\])*)\\]\\(', 'g');
    let output = '', cursor = 0, match;
    while ((match = pattern.exec(source))) {
      const target = readTarget(source, pattern.lastIndex);
      if (!target) continue;
      output += source.slice(cursor, match.index);
      const label = literal(match[1]);
      if (!safeUrl(target.url, image)) {
        output += stash(escapeText(label), label);
      } else {
        const title = target.title === null ? '' : ' title="' + escapeAttribute(literal(target.title)) + '"';
        const destination = escapeAttribute(target.url);
        const value = image
          ? '<img src="' + destination + '" alt="' + escapeAttribute(label) + '"' + title + ' loading="lazy">'
          : '<a href="' + destination + '"' + title + ' target="_blank" rel="noopener">' + restore(emphasis(escapeText(match[1]))) + '</a>';
        output += stash(value, label);
      }
      cursor = target.end;
      pattern.lastIndex = cursor;
    }
    return output + source.slice(cursor);
  };
  html = replaceLinks(html, true);
  html = replaceLinks(html, false);
  // 原始 HTML 始终是文本；只有上述受控生成的标签在最后一步还原。
  html = escapeText(html);

  // 预览保留原有星号列表与分割线；先隔离，避免被强调语法二次转换。
  html = html.replace(/^\* (.+)$/gm, '- $1')
    .replace(/^\*\*\*$/gm, () => stash('<hr>', '', true));

  // 3. 标题（标题内容已经按文本转义）
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 4. 粗体、斜体、删除线
  html = emphasis(html);

  // 5. 分割线
  html = html.replace(/^---+$/gm, '<hr>');

  // 6. 引用
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // 7. 表格
  html = html.replace(/((?:^\|.+\|\n)+)/gm, (match) => {
    const rows = match.trim().split('\n');
    if (rows.length < 2) return match;
    const header = rows[0].split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(s => s.trim());
    const body = rows.slice(2).map(r => r.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(s => s.trim()));
    let t = '<table><thead><tr>';
    for (const h of header) t += '<th>' + h + '</th>';
    t += '</tr></thead><tbody>';
    for (const row of body) {
      t += '<tr>';
      for (const c of row) t += '<td>' + c + '</td>';
      t += '</tr>';
    }
    t += '</tbody></table>';
    return t;
  });

  // 8. 无序列表
  html = html.replace(/(^|\n)((?:- .+\n?)+)/g, (_, prefix, list) => {
    const items = list.trim().split('\n').map(s => '<li>' + s.replace(/^- /, '') + '</li>').join('');
    return prefix + '<ul>' + items + '</ul>';
  });

  // 9. 有序列表
  html = html.replace(/(^|\n)((?:\d+\. .+\n?)+)/g, (_, prefix, list) => {
    const items = list.trim().split('\n').map(s => '<li>' + s.replace(/^\d+\. /, '') + '</li>').join('');
    return prefix + '<ol>' + items + '</ol>';
  });

  // 11. 段落：按空行分块；块级标签与代码块占位符不再被 <p> 包裹
  const BLOCK = /^(<(h[1-6]|ul|ol|pre|blockquote|table|hr|div)\b)/i;
  html = html.split(/\n{2,}/).map((block) => {
    const t = block.trim();
    if (!t) return '';
    if (BLOCK.test(t) || t.startsWith('\x00CODE' + nonce)) return t;
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).filter(Boolean).join('\n');

  // 12. 还原隔离片段，不再进行链接/图片转换或 HTML 实体解码。
  return restore(html);
}

// ═══ 导航（事件委托，兼容插件动态注入的菜单项）═══
window.gotoPage = (p) => { pageNum = p; render(); };
window.navigate = (next, status = '') => {
  if (!canVisit(next)) return toast('当前账号没有此功能的管理权限', 'error');
  const key = [next, 1, next === 'posts' || next === 'comments' ? status : ''].join(':');
  if (activeView?.key === key && !activeView.signal.aborted && !activeView.failed) return activeView.promise;
  page = next; pageNum = 1;
  if (next === 'posts') postStatus = status;
  if (next === 'comments') { commentStatus = status; selectedComments.clear(); }
  document.querySelectorAll('.menu-item').forEach(el => {
    const active = el.dataset.page === next;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  return render(true);
};
document.querySelector('.sidebar-menu').addEventListener('click', (ev) => {
  const el = ev.target.closest('.menu-item');
  if (!el) return;
  // 插件菜单若给了 url，则直接跳转，不当作内部页面
  if (el.dataset.url) { ev.preventDefault(); location.href = el.dataset.url; return; }
  if (!el.dataset.page) return;
  ev.preventDefault();
  window.navigate(el.dataset.page);
});

// 拉取插件注册的后台菜单，注入到侧边栏「插件」分组
async function loadPluginMenus() {
  try {
    const menus = await api('/admin/plugin-menus', { timeout: 8000 });
    const box = document.getElementById('plugin-menus');
    const section = document.getElementById('plugin-menu-section');
    if (!box || !Array.isArray(menus) || !menus.length) return;
    box.innerHTML = menus.map(m => {
      const icon = m.icon || '🔌';
      const url = m.url ? ' data-url="' + escape(m.url) + '"' : '';
      const pageAttr = m.url ? '' : ' data-page="' + escape(m.page || ('plugin:' + m.id)) + '"';
      return '<a href="#" class="menu-item"' + url + pageAttr + '><span aria-hidden="true">' + escape(icon) + '</span><span>' + escape(m.title || m.id) + '</span></a>';
    }).join('');
    if (section) section.style.display = '';
  } catch (e) { /* 插件菜单加载失败不影响后台 */ }
}
document.getElementById('logout-btn').onclick = () => { localStorage.removeItem('lill_token'); location.href = '/admin/login'; };

// 未登录直接跳登录页：没有 token 时连 /auth/me 都不发，认证失败也不发起任何后台请求，
// 避免后台控制台刷一堆 401（对标 Typecho 后台的干净加载）
let authed = false;
if (!localStorage.getItem('lill_token')) {
  authed = false;
} else {
  try {
    user = await api('/auth/me', { timeout: 8000 });
    authed = !!user;
    if (user) {
      document.getElementById('user-name').textContent = user.nickname || user.username;
      const avatar = document.getElementById('user-avatar');
      if (avatar) avatar.textContent = (user.nickname || user.username || 'L').slice(0, 1).toUpperCase();
    }
  } catch (e) { authed = false; }
}
if (!authed) {
  document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div><p style="margin-top:12px;color:#64748b">登录已过期，正在跳转登录页…</p></div>';
  location.href = '/admin/login';
} else {
  applyRoleNavigation();
  if (user.role === 'admin') loadPluginMenus();
  window.navigate(user.role === 'admin' || !contentRoles.includes(user.role) ? 'dashboard' : 'posts');
}


// ═══ 暴露给 HTML onclick（module 作用域限制） ═══
window.render = render;
window.renderDashboard = renderDashboard;
window.renderPosts = renderPosts;
window.renderPages = renderPages;
window.renderLogs = renderLogs;
window.renderBackup = renderBackup;
window.renderPages = renderPages;
window.renderCategories = renderCategories;
window.renderTags = renderTags;
window.renderComments = renderComments;
window.renderMedia = renderMedia;
window.renderUsers = renderUsers;
window.renderSettings = renderSettings;

// ═══ 插件 ═══
async function renderPlugins() {
  const r = await api('/admin/plugins');
  const plugins = r || [];
  setTopbar('<input type="file" id="plugin-install-input" accept=".zip" style="display:none">'
    + '<button class="btn btn-primary" onclick="document.getElementById(\'plugin-install-input\').click()">+ 上传插件</button>');
  const fi = document.getElementById('plugin-install-input');
  if (fi) fi.onchange = (e) => uploadPlugin(e.target);

  const rows = plugins.map(p => {
    const settingsBtn = p.hasSettings
      ? '<button class="btn btn-sm btn-primary" onclick="openPluginSettings(\'' + escape(p.dir) + '\')">设置</button> '
      : '';
    const actions = settingsBtn
      + '<button class="btn btn-sm btn-outline" onclick="togglePlugin(\'' + escape(p.dir) + '\')">' + (p.active ? '禁用' : '启用') + '</button>'
      + ' <button class="btn btn-sm btn-outline" style="color:#dc2626;border-color:#fca5a5" onclick="uninstallPlugin(\'' + escape(p.dir) + '\',\'' + escape(p.name || p.dir) + '\')">卸载</button>';
    return '<tr><td><strong>' + escape(p.name || p.dir) + '</strong><br><small style="color:#64748b">' + escape(p.dir) + '</small></td>'
      + '<td>' + escape(p.version || '-') + '</td>'
      + '<td>' + escape(p.description || '-') + (p.author ? '<br><small style="color:#94a3b8">作者：' + escape(p.author) + '</small>' : '') + '</td>'
      + '<td><span class="badge ' + (p.active ? 'badge-success' : 'badge-secondary') + '">' + (p.active ? '已启用' : '未启用') + '</span></td>'
      + '<td class="actions">' + actions + '</td></tr>';
  }).join('');

  const hint = '<div class="card" style="margin-bottom:16px"><p style="margin:0;color:#64748b;font-size:13px">'
    + '插件包为 ZIP，内部结构为 <code>&lt;插件目录&gt;/plugin.json</code> + <code>&lt;插件目录&gt;/index.js</code>，'
    + '入口需导出 <code>activate(ctx)</code> 与 <code>deactivate(ctx)</code>。详见 <code>docs/插件开发指南.md</code>。</p></div>';

  document.getElementById('content').innerHTML = hint
    + '<div class="table-container"><table><thead><tr><th>名称</th><th>版本</th><th>描述</th><th>状态</th><th>操作</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="5"><div class="empty">暂无插件，点击右上角上传安装</div></td></tr>')
    + '</tbody></table></div>';
  labelTableRows();
}
window.renderPlugins = renderPlugins;
window.renderPluginMenuPanel = renderPluginMenuPanel;

// 插件注册的后台菜单：优先按 page 打开插件自己的页面；
// 未指定 page 时，若插件声明了 settings 就打开设置页，否则给出明确提示（不再是死胡同）。
async function renderPluginMenuPanel(id) {
  setTopbar('');
  const c = document.getElementById('content');
  c.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  let plugins = [];
  plugins = (await api('/admin/plugins')) || [];
  const p = plugins.find(x => x.dir === id);
  if (p && p.hasSettings) return renderPluginSettings(id);
  c.innerHTML = '<div class="card"><h3 class="card-title">插件页面</h3>'
    + '<p style="color:#64748b">插件「' + escape(p ? (p.name || id) : id) + '」注册了后台菜单，但没有可打开的后台页面。</p>'
    + '<p style="color:#64748b">插件可以：① 在 <code>plugin.json</code> 里写 <code>settings</code>，后台会自动生成设置页；'
    + '② 在 <code>ctx.addAdminMenu({ ..., page: \'plugin-settings:&lt;目录名&gt;\' })</code> 中指向设置页；'
    + '③ 用 <code>url</code> 指向插件自带的页面。</p>'
    + '<button class="btn btn-outline" onclick="navigate(\'plugins\')">前往插件管理</button></div>';
}

// ═══ 插件设置页（对标 Typecho 插件配置面板 / WP 插件设置页）═══
async function renderPluginSettings(dir) {
  setTopbar('');
  const c = document.getElementById('content');
  c.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  const r = await api('/admin/plugins/' + encodeURIComponent(dir) + '/config');

  const schema = r.schema || [];
  const values = r.values || {};
  let html = '<div class="card"><h3 class="card-title">插件设置 — ' + escape(r.name || dir) + '</h3>';
  if (!schema.length) {
    html += '<div class="empty">该插件没有声明可配置项（<code>plugin.json</code> 的 <code>settings</code> 为空）</div>';
  } else {
    html += '<p style="color:#64748b;font-size:13px;margin-top:-4px">这些字段来自插件目录下的 <code>plugin.json</code>，保存后插件通过 <code>ctx.getConfig()</code> 读取。</p>';
    html += settingsFormHTML(schema, values, 'data-ps-key');
    html += '<button class="btn btn-primary" onclick="savePluginSettings(\'' + escape(dir) + '\')">保存设置</button>';
  }
  html += '<div style="margin-top:12px"><button class="btn btn-outline" onclick="navigate(\'plugins\')">← 返回插件列表</button></div></div>';
  c.innerHTML = html;
}
window.openPluginSettings = dir => showView('plugin-settings:' + dir, () => renderPluginSettings(dir), true);

window.savePluginSettings = async (dir) => {
  const body = readSettingsForm('data-ps-key');
  try {
    await api('/admin/plugins/' + encodeURIComponent(dir) + '/config', { method: 'PUT', body });
    toast('设置已保存');
  } catch (e) { toast(e.message, 'error'); }
};

window.togglePlugin = async (dir) => {
  const view = activeView;
  try {
    const r = await api('/admin/plugins/toggle', { method: 'POST', body: { dir } });
    if (r && r.hot && r.hot !== 'ok') toast('状态已保存，但热加载失败：' + r.hot, 'error');
    else toast(r && r.active ? '插件已启用' : '插件已禁用');
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

window.uninstallPlugin = async (dir, name) => {
  if (!confirm('确定卸载插件「' + name + '」？目录会移动到回收区，可手动恢复。')) return;
  const view = activeView;
  try {
    await api('/admin/plugins/' + encodeURIComponent(dir), { method: 'DELETE' });
    toast('插件已卸载');
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

window.uploadPlugin = async (input) => {
  const view = activeView;
  const file = input.files && input.files[0];
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) { toast('请选择 .zip 插件包', 'error'); input.value = ''; return; }
  if (file.size > 30 * 1024 * 1024) { toast('插件包不能超过 30MB', 'error'); input.value = ''; return; }
  try {
    const data = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
    const r = await api('/admin/plugins/install', { method: 'POST', body: { name: file.name, data }, timeout: 120000 });
    toast('插件「' + (r.name || r.dir) + '」安装成功，请在列表中启用');
    refreshView(view);
  } catch (e) {
    toast(e.message || '安装失败', 'error');
    input.value = '';
  }
};
