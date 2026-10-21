let user = null;
let page = 'dashboard';
let pageNum = 1;
let postStatus = '';
let postKeyword = '';
let postCategoryId = '';
let commentStatus = '';
let commentPostId = '';
let pageKeyword = '';
let pageCategoryId = '';
let commentKeyword = '';
let mediaKeyword = '';
let userKeyword = '';
let selectedPosts = new Set();
let selectedPages = new Set();
let selectedCategories = new Set();
let selectedUsers = new Set();
let selectedTags = new Set();
let selectedMedia = new Set();
let mediaRowsCache = [];
let selectedLogs = new Set();
let selectedBackups = new Set();
let selectedPlugins = new Set();
let selectedThemes = new Set();
let selectedWidgets = new Set();
let postCategoriesCache = [];
let currentEditorThemeFields = null;
let currentEditorPluginManifest = null;
let currentEditorRuntime = null;
let systemPollTimer = null;
let backupProgressTimer = null;

const TITLES = { dashboard: '控制台', posts: '文章', pages: '页面', categories: '分类', tags: '标签', comments: '评论', media: '附件', themes: '外观', users: '用户', settings: '设置', logs: '日志', backup: '备份', plugins: '插件', widgets: '小工具', system: '系统' };

// 统一 API 层：由 /api.js 提供的 window.lillAPI（前台后台共用）
const api = (path, opts = {}) => window.lillAPI.request(path, opts);

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', 'polite');
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
function stopSystemPolling() {
  if (systemPollTimer) clearInterval(systemPollTimer);
  systemPollTimer = null;
}

function paginate(meta) {
  if (!meta || !meta.totalPages || meta.totalPages <= 1) return '';
  const total = Math.max(1, Number(meta.totalPages) || 1);
  const current = Math.min(total, Math.max(1, Number(meta.page) || 1));
  const pages = new Set([1, current, total]);
  for (let i = current - 2; i <= current + 2; i++) if (i >= 1 && i <= total) pages.add(i);
  const ordered = [...pages].sort((a, b) => a - b);
  let html = '<div class="pagination">';
  html += '<button ' + (current > 1 ? '' : 'disabled') + ' onclick="gotoPage(' + (current - 1) + ')">←</button>';
  let previous = 0;
  for (const i of ordered) {
    if (previous && i - previous > 1) html += '<span class="pagination-gap" aria-hidden="true">…</span>';
    html += '<button class="' + (i === current ? 'active' : '') + '"' + (i === current ? ' aria-current="page"' : '') + ' onclick="gotoPage(' + i + ')">' + i + '</button>';
    previous = i;
  }
  html += '<button ' + (current < total ? '' : 'disabled') + ' onclick="gotoPage(' + (current + 1) + ')">→</button>';
  return html + '</div>';
}

// ═══ 路由 ═══
let activeView = null;
function showView(key, load, reuse = false, navigation = {}) {
  if (reuse && activeView?.key === key && !activeView.signal.aborted && !activeView.failed) return activeView.promise;
  if (activeView?.key !== key) stopSystemPolling();
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
      case 'widgets': return await renderWidgets();
      case 'system': return await renderSystem();
      default:
        if (page.startsWith('plugin-settings:')) return await renderPluginSettings(page.slice(16));
        if (page.startsWith('plugin:')) return await renderPluginMenuPanel(page.slice(7));
        document.getElementById('content').innerHTML = '<div class="empty">页面不存在</div>';
    }
  }, reuse, navigation);
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return (days ? days + '天 ' : '') + hours + '小时 ' + minutes + '分 ' + remainder + '秒';
}
function formatBytesGB(value) {
  const bytes = Number(value);
  return Number.isFinite(bytes) ? (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB' : '-';
}
function systemMetric(label, value) {
  return '<div><dt>' + escape(label) + '</dt><dd>' + escape(value == null || value === '' ? '-' : value) + '</dd></div>';
}
async function renderSystem() {
  stopSystemPolling();
  const [version, sites] = await Promise.all([api('/admin/system/version'), api('/admin/sites')]);
  const content = document.getElementById('content');
  content.innerHTML = '<div class="dashboard-grid"><section class="card"><h2 class="card-title">运行状态</h2><dl id="system-monitor"></dl></section>' +
    '<section class="card"><h2 class="card-title">健康检查</h2><dl id="system-health"></dl></section>' +
    '<section class="card"><h2 class="card-title">版本与站点</h2><dl id="system-version"></dl><div id="system-sites"></div></section></div>';
  document.getElementById('system-version').innerHTML = systemMetric('版本', version.version) + systemMetric('Node.js', version.node) + systemMetric('平台', version.platform);
  document.getElementById('system-sites').innerHTML = '<h3>站点</h3>' + ((sites || []).length ? '<ul>' + sites.map(site => '<li>' + escape(site.name) + ' · ' + escape(site.domain) + '</li>').join('') + '</ul>' : '<p>暂无站点</p>');
  const update = async () => {
    if (page !== 'system' || activeView?.signal.aborted) return stopSystemPolling();
    const [monitor, health] = await Promise.all([api('/admin/system/monitor'), api('/admin/system/health')]);
    if (page !== 'system' || activeView?.signal.aborted) return stopSystemPolling();
    const memory = monitor.memory || {};
    const cpu = monitor.cpu || {};
    document.getElementById('system-monitor').innerHTML = systemMetric('运行时间', formatUptime(monitor.uptime)) + systemMetric('内存 used / total', (memory.used || '-') + ' / ' + (memory.total || '-')) + systemMetric('RSS', memory.rss) + systemMetric('CPU 用户 / 系统', (Number(cpu.user) || 0) + ' / ' + (Number(cpu.system) || 0));
    const disk = health.disk || {};
    document.getElementById('system-health').innerHTML = systemMetric('状态', health.status) + systemMetric('数据库', health.database) + systemMetric('磁盘可用', formatBytesGB(disk.free)) + systemMetric('磁盘总量', formatBytesGB(disk.total));
  };
  await update();
  if (page === 'system' && !activeView?.signal.aborted) systemPollTimer = setInterval(() => update().catch(error => toast('系统状态更新失败：' + error.message, 'error')), 10000);
}

async function renderWidgets() {
  const widgets = await api('/admin/widgets');
  const rows = (widgets || []).map(widget => '<tr><td><input type="checkbox" class="widget-checkbox" value="' + escape(widget.id) + '" aria-label="选择小工具 ' + escape(widget.name) + '" ' + (selectedWidgets.has(widget.id) ? 'checked' : '') + ' onchange="toggleWidgetCheck(' + jsArg(widget.id) + ',this.checked)"></td><td><strong>' + escape(widget.name) + '</strong></td><td>' + escape(widget.type) + '</td><td>' + escape(widget.position) + '</td><td class="sort-cell"><button class="btn btn-sm btn-outline" title="上移" aria-label="上移" onclick="moveWidget(' + jsArg(widget.id) + ',-1)">↑</button> <span>' + Number(widget.sort_order || 0) + '</span> <button class="btn btn-sm btn-outline" title="下移" aria-label="下移" onclick="moveWidget(' + jsArg(widget.id) + ',1)">↓</button></td><td><button class="btn btn-sm btn-outline" onclick="toggleWidget(' + jsArg(widget.id) + ')">' + (Number(widget.enabled) ? '已启用' : '已停用') + '</button></td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openWidgetEditor(' + jsArg(widget.id) + ')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delWidget(' + jsArg(widget.id) + ')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openWidgetEditor()">+ 新建组件</button>');
  document.getElementById('content').innerHTML = '<div id="widget-selection"></div><div class="table-container"><table><thead><tr><th scope="col"><input type="checkbox" aria-label="选择本页小工具" onchange="toggleAllWidgets(this.checked)"' + ((widgets || []).length && widgets.every(widget => selectedWidgets.has(widget.id)) ? ' checked' : '') + '></th><th scope="col">名称</th><th scope="col">类型</th><th scope="col">位置</th><th scope="col">排序</th><th scope="col">启用</th><th scope="col">操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty">暂无小工具</div></td></tr>') + '</tbody></table></div>';
  updateWidgetBatchBar();
}
function updateWidgetBatchBar() {
  const bar = document.getElementById('widget-selection');
  if (!bar) return;
  bar.innerHTML = selectedWidgets.size ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedWidgets.size + ' 项</span><button class="btn btn-sm btn-outline" onclick="batchWidgets(\'enable\')">启用</button><button class="btn btn-sm btn-outline" onclick="batchWidgets(\'disable\')">停用</button><button class="btn btn-sm btn-danger" onclick="batchWidgets(\'delete\')">删除</button><button class="btn btn-sm btn-outline" onclick="clearWidgetSelection()">取消</button></div>' : '';
}
window.toggleWidgetCheck = (id, checked) => { if (checked) selectedWidgets.add(id); else selectedWidgets.delete(id); updateWidgetBatchBar(); };
window.toggleAllWidgets = checked => {
  if (checked) document.querySelectorAll('.widget-checkbox').forEach(el => selectedWidgets.add(el.value));
  else selectedWidgets.clear();
  document.querySelectorAll('.widget-checkbox').forEach(el => { el.checked = selectedWidgets.has(el.value); });
  updateWidgetBatchBar();
};
window.clearWidgetSelection = () => { selectedWidgets.clear(); document.querySelectorAll('.widget-checkbox, #content thead input[type="checkbox"]').forEach(el => { el.checked = false; }); updateWidgetBatchBar(); };
window.batchWidgets = async action => {
  if (!selectedWidgets.size) return;
  if (action === 'delete' && !confirm('确定删除选中的 ' + selectedWidgets.size + ' 个小工具？')) return;
  const view = activeView;
  try {
    await api('/admin/widgets/batch', { method: 'POST', body: { action, ids: Array.from(selectedWidgets) } });
    selectedWidgets.clear();
    toast('批量操作完成');
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.openWidgetEditor = async id => {
  try {
    const widgets = await api('/admin/widgets');
    const widget = id ? (widgets || []).find(item => String(item.id) === String(id)) : null;
    if (id && !widget) throw new Error('小工具不存在');
    const positions = [['sidebar', '侧栏'], ['left', '左侧'], ['right', '右侧'], ['footer', '页脚']];
    document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">' + (widget ? '编辑小工具' : '新建小工具') + '</h3>' +
      '<div class="form-group"><label for="we-name">名称</label><input id="we-name" maxlength="100" value="' + escape(widget?.name || '') + '"></div>' +
      '<div class="form-group"><label for="we-type">类型</label><input id="we-type" maxlength="50" value="' + escape(widget?.type || '') + '"></div>' +
      '<div class="form-group"><label for="we-position">位置</label><select id="we-position">' + positions.map(([value, label]) => '<option value="' + value + '"' + ((widget?.position || 'sidebar') === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></div>' +
      '<div class="form-group"><label for="we-sort">排序</label><input id="we-sort" type="number" step="1" value="' + Number(widget?.sort_order || 0) + '"></div>' +
      '<div class="form-group"><label for="we-content">内容</label><textarea id="we-content" rows="8">' + escape(widget?.content || '') + '</textarea></div>' +
      '<label class="form-group"><input id="we-enabled" type="checkbox"' + (widget ? (Number(widget.enabled) ? ' checked' : '') : ' checked') + '> 启用</label>' +
      '<button class="btn btn-primary" onclick="saveWidget(' + (widget ? jsArg(widget.id) : 'null') + ')">保存</button> <button class="btn btn-outline" onclick="navigate(\'widgets\')">取消</button></div>';
  } catch (e) { toast(e.message, 'error'); }
};
window.saveWidget = async id => {
  const view = activeView;
  const name = document.getElementById('we-name').value.trim();
  const type = document.getElementById('we-type').value.trim();
  const sortOrder = Number(document.getElementById('we-sort').value);
  if (!name || !type) return toast('请填写名称和类型', 'error');
  if (!Number.isSafeInteger(sortOrder)) return toast('排序必须是整数', 'error');
  const body = { name, type, position: document.getElementById('we-position').value, sort_order: sortOrder, content: document.getElementById('we-content').value, enabled: document.getElementById('we-enabled').checked ? 1 : 0 };
  try {
    await api(id ? '/admin/widgets/' + encodeURIComponent(id) : '/admin/widgets', { method: id ? 'PUT' : 'POST', body });
    toast('已保存');
    if (view?.navigation === activeView?.navigation) refreshView(view);
    else navigate('widgets');
  } catch (e) { toast(e.message, 'error'); }
};
window.toggleWidget = async id => {
  const view = activeView;
  try {
    const widgets = await api('/admin/widgets');
    const widget = (widgets || []).find(item => String(item.id) === String(id));
    if (!widget) throw new Error('小工具不存在');
    await api('/admin/widgets/' + encodeURIComponent(id), { method: 'PUT', body: { name: widget.name, type: widget.type, content: widget.content || '', position: widget.position || 'sidebar', sort_order: Number(widget.sort_order) || 0, enabled: Number(widget.enabled) ? 0 : 1 } });
    toast('状态已更新');
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.moveWidget = async (id, delta) => {
  const view = activeView;
  try {
    const widgets = (await api('/admin/widgets') || []).slice();
    const index = widgets.findIndex(item => String(item.id) === String(id));
    const target = index + delta;
    if (index < 0) throw new Error('小工具不存在');
    if (target < 0 || target >= widgets.length) return toast('已经在边界', 'error');
    [widgets[index], widgets[target]] = [widgets[target], widgets[index]];
    await Promise.all(widgets.map((widget, sort_order) => api('/admin/widgets/' + encodeURIComponent(widget.id), { method: 'PUT', body: { name: widget.name, type: widget.type, content: widget.content || '', position: widget.position || 'sidebar', sort_order, enabled: Number(widget.enabled) ? 1 : 0 } })));
    toast('顺序已更新');
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.delWidget = async id => {
  if (!confirm('确定删除这个小工具？')) return;
  const view = activeView;
  try { await api('/admin/widgets/' + encodeURIComponent(id), { method: 'DELETE' }); toast('已删除'); refreshView(view); }
  catch (e) { toast(e.message, 'error'); }
};

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
    html += '<table><thead><tr><th scope="col">标题</th><th scope="col">状态</th><th scope="col">分类</th><th scope="col">创建时间</th></tr></thead><tbody>' +
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

const EDITOR_EVENTS = new Set(['content:change', 'save:before', 'save:after']);
function createEditorBridge({ post = {}, type = 'post', pluginDir = '', fieldSchema = [], textarea, request = api } = {}) {
  if (!textarea || typeof textarea !== 'object') throw new TypeError('编辑器桥接需要 textarea');
  const schema = new Map((Array.isArray(fieldSchema) ? fieldSchema : [])
    .filter(field => field && typeof field.key === 'string')
    .map(field => [field.key, field]));
  const saved = post?.pluginFields?.[pluginDir];
  const pluginFields = {};
  for (const field of schema.values()) {
    const value = saved && Object.hasOwn(saved, field.key)
      ? saved[field.key]
      : (field.default ?? (field.type === 'checkbox' ? false : field.type === 'number' ? 0 : field.type === 'select' ? field.options?.[0]?.value ?? '' : ''));
    pluginFields[field.key] = value;
  }
  const listeners = new Map([...EDITOR_EVENTS].map(event => [event, []]));
  const notifyContentChange = () => {
    try { mdSync(); } catch {}
    for (const handler of listeners.get('content:change')) handler(getDocument());
  };
  const selection = () => ({
    start: Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length,
    end: Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : textarea.value.length,
  });
  const applyText = (text, replace = true) => {
    const range = replace ? selection() : { start: textarea.value.length, end: textarea.value.length };
    textarea.value = textarea.value.slice(0, range.start) + text + textarea.value.slice(range.end);
    const caret = range.start + text.length;
    if (typeof textarea.setSelectionRange === 'function') textarea.setSelectionRange(caret, caret);
    notifyContentChange();
    return textarea.value;
  };
  function getDocument() {
    return { content: String(textarea.value || ''), pluginFields: { ...pluginFields }, type, postId: post?.id || null };
  }
  const bridge = {
    getDocument,
    getContent: () => String(textarea.value || ''),
    replaceContent: text => { textarea.value = String(text ?? ''); if (typeof textarea.setSelectionRange === 'function') textarea.setSelectionRange(0, textarea.value.length); notifyContentChange(); },
    insertText: text => applyText(String(text ?? ''), true),
    replaceSelection: text => applyText(String(text ?? ''), true),
    getPluginFields: () => ({ ...pluginFields }),
    setPluginField: (key, value) => {
      if (!schema.has(key)) throw new Error('未知插件字段：' + key);
      pluginFields[key] = value;
      const input = pluginDir ? document.getElementById('pe-plugin-field-' + pluginDir + '-' + key) : null;
      if (input) {
        if (input.type === 'checkbox') input.checked = value === true;
        else input.value = value;
      }
      for (const handler of listeners.get('content:change')) handler(getDocument());
    },
    on: (event, handler) => {
      if (!EDITOR_EVENTS.has(event)) throw new Error('不支持的编辑器事件：' + event);
      if (typeof handler !== 'function') throw new TypeError('编辑器事件监听器必须是函数');
      listeners.get(event).push(handler);
      return () => {
        const list = listeners.get(event);
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    request: (method, path, options = {}) => typeof request === 'function'
      ? (request === api || request.length < 3
        ? request(path, { ...options, method })
        : request(method, path, options))
      : Promise.reject(new Error('编辑器请求客户端不可用')),
    async runSaveBefore(input = {}) {
      let state = {
        content: input.content === undefined ? String(textarea.value || '') : String(input.content),
        pluginFields: { ...pluginFields },
        type,
        postId: post?.id || null,
      };
      for (const handler of [...listeners.get('save:before')]) {
        const result = await handler(state);
        if (result && typeof result === 'object' && Object.hasOwn(result, 'content')) {
          if (typeof result.content !== 'string') throw new Error('save:before 必须返回字符串 content');
          state = { ...state, content: result.content };
        }
      }
      return state;
    },
    emitSaveAfter: (state = getDocument()) => {
      for (const handler of [...listeners.get('save:after')]) {
        try { handler(state); } catch {}
      }
    },
  };
  return bridge;
}

function createEditorSlots(root = {}) {
  const mounted = { toolbar: [], sidebar: [] };
  const slotRoot = (name) => {
    if (root && root[name]) return root[name];
    if (!root || typeof root.appendChild !== 'function') throw new TypeError('编辑器 slot 根节点无效');
    const element = document.createElement('div');
    element.className = 'editor-extension-slot editor-extension-slot-' + name;
    root.appendChild(element);
    return element;
  };
  const createSlot = name => ({
    mount(render) {
      if (typeof render !== 'function') throw new TypeError('slot mount 需要渲染函数');
      const container = document.createElement('div');
      container.className = 'editor-extension-mount editor-extension-mount-' + name;
      slotRoot(name).appendChild(container);
      render(container);
      mounted[name].push(container);
      let active = true;
      return {
        unmount() {
          if (!active) return;
          active = false;
          const index = mounted[name].indexOf(container);
          if (index >= 0) mounted[name].splice(index, 1);
          container.remove?.();
        },
      };
    },
  });
  return {
    toolbar: createSlot('toolbar'),
    sidebar: createSlot('sidebar'),
    clear() {
      for (const name of ['toolbar', 'sidebar']) {
        for (const container of mounted[name].splice(0)) container.remove?.();
      }
    },
  };
}

async function loadEditorExtensions(manifest, context = {}) {
  const errors = [];
  const cleanups = [];
  const styles = [];
  const request = context.request || api;
  const slots = context.slots || createEditorSlots(context.root);
  const extensions = Array.isArray(manifest?.extensions) ? manifest.extensions : [];
  for (const plugin of extensions) {
    const editor = context.editors?.get(plugin.plugin) || context.editor;
    for (const module of (plugin.modules || [])) {
      try {
        for (const stylePath of module.styles || []) {
          const response = await request(stylePath);
          if (!response || typeof response.content !== 'string') throw new Error('样式资源格式无效');
          const style = document.createElement('style');
          style.dataset.plugin = plugin.plugin;
          style.dataset.extension = module.id;
          style.textContent = response.content;
          (document.head || document.body).appendChild(style);
          styles.push(style);
        }
        const response = await request(module.entry);
        if (!response || typeof response.content !== 'string') throw new Error('扩展模块格式无效');
        if (typeof URL?.createObjectURL !== 'function' || typeof Blob !== 'function') {
          throw new Error('当前浏览器不支持插件扩展模块');
        }
        const url = URL.createObjectURL(new Blob([response.content], { type: 'text/javascript' }));
        const loaded = await import(url);
        const activate = loaded?.activate;
        if (typeof activate !== 'function') throw new Error('扩展模块未导出 activate');
        const cleanup = await activate({
          editor,
          slots,
          plugin: { dir: plugin.plugin, extension: module },
        });
        if (typeof cleanup === 'function') cleanups.push(cleanup);
        cleanups.push(() => URL.revokeObjectURL(url));
      } catch (error) {
        errors.push({ plugin: plugin.plugin, extension: module.id, error });
      }
    }
  }
  return {
    errors,
    cleanups,
    unload() {
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { cleanup(); } catch {}
      }
      for (const style of styles.splice(0)) style.remove?.();
      slots.clear?.();
    },
  };
}

function renderPluginEditorFields(manifest, values) {
  const entries = Array.isArray(manifest?.extensions) ? manifest.extensions : [];
  const saved = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  return entries.flatMap(entry => {
    const fields = Array.isArray(entry.fields) ? entry.fields : [];
    if (!fields.length) return [];
    const groups = new Map();
    for (const field of fields) {
      const group = typeof field.group === 'string' && field.group.trim() ? field.group : entry.plugin;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(field);
    }
    return [...groups].map(([group, groupFields]) => {
      const controls = groupFields.map(field => {
        const id = 'pe-plugin-field-' + entry.plugin + '-' + field.key;
        const current = saved[entry.plugin] || {};
        const value = Object.hasOwn(current, field.key)
          ? current[field.key]
          : (field.default ?? (field.type === 'checkbox' ? false : field.type === 'number' ? 0 : field.type === 'select' ? field.options?.[0]?.value ?? '' : ''));
        const description = field.description ? '<div class="hint theme-editor-description">' + escape(field.description) + '</div>' : '';
        if (field.type === 'checkbox') {
          return '<div class="theme-editor-field"><label class="check-line theme-editor-checkbox" for="' + escape(id) +
            '"><input id="' + escape(id) + '" type="checkbox"' + (value === true ? ' checked' : '') + '><span>' + escape(field.label) + '</span></label>' + description + '</div>';
        }
        let control;
        if (field.type === 'textarea') control = '<textarea id="' + escape(id) + '">' + escape(value) + '</textarea>';
        else if (field.type === 'select') control = '<select id="' + escape(id) + '">' + (field.options || []).map(option =>
          '<option value="' + escape(option.value) + '"' + (String(option.value) === String(value) ? ' selected' : '') + '>' + escape(option.label) + '</option>').join('') + '</select>';
        else {
          const type = ['number', 'url'].includes(field.type) ? field.type : 'text';
          control = '<input id="' + escape(id) + '" type="' + type + '"' + (type === 'number' ? ' step="any"' : '') + ' value="' + escape(value) + '">';
        }
        return '<div class="form-group theme-editor-field"><label for="' + escape(id) + '">' + escape(field.label) + '</label>' + control + description + '</div>';
      }).join('');
      return '<section class="side-box theme-editor-group plugin-editor-group" aria-label="' + escape(group) + '">' +
        '<div class="side-box-title">' + escape(group) + '</div>' + controls + '</section>';
    });
  }).join('');
}

function renderPluginEditorActions(manifest) {
  const entries = Array.isArray(manifest?.extensions) ? manifest.extensions : [];
  return entries.map(entry => {
    const actions = (entry.actions || []).filter(action => action.placement === 'toolbar');
    if (!actions.length) return '';
    return '<span class="plugin-editor-actions" id="pe-plugin-actions-' + escape(entry.plugin) + '">' +
      actions.map(action => '<button type="button" class="tb plugin-editor-action" data-plugin="' + escape(entry.plugin) +
        '" data-action="' + escape(action.id) + '" onclick="runEditorAction(' + jsArg(entry.plugin) + ',' + jsArg(action.id) + ')">' + escape(action.label) + '</button>').join('') +
      '</span>';
  }).join('');
}

function renderPluginSidebarActions(manifest) {
  const entries = Array.isArray(manifest?.extensions) ? manifest.extensions : [];
  return entries.map(entry => {
    const actions = (entry.actions || []).filter(action => action.placement === 'sidebar');
    if (!actions.length) return '';
    return '<div class="plugin-editor-sidebar-actions" data-plugin="' + escape(entry.plugin) + '">' +
      actions.map(action => '<button type="button" class="btn btn-outline plugin-editor-action" data-plugin="' + escape(entry.plugin) +
        '" data-action="' + escape(action.id) + '" onclick="runEditorAction(' + jsArg(entry.plugin) + ',' + jsArg(action.id) + ')">' + escape(action.label) + '</button>').join('') +
      '</div>';
  }).join('');
}

function cleanupEditorRuntime() {
  if (!currentEditorRuntime) return;
  try { currentEditorRuntime.extensionRuntime?.unload?.(); } catch {}
  try { currentEditorRuntime.slots?.clear?.(); } catch {}
  currentEditorRuntime = null;
}

function syncPluginEditorFields(runtime) {
  if (!runtime?.manifest?.extensions) return;
  for (const entry of runtime.manifest.extensions) {
    const bridge = runtime.editors.get(entry.plugin);
    for (const field of entry.fields || []) {
      const input = document.getElementById('pe-plugin-field-' + entry.plugin + '-' + field.key);
      if (!input || !bridge) continue;
      const value = field.type === 'checkbox'
        ? input.checked
        : field.type === 'number'
          ? (input.value.trim() === '' ? Number(field.default ?? 0) : Number(input.value))
          : input.value;
      try { bridge.setPluginField(field.key, value); } catch {}
    }
  }
}

window.runEditorAction = async (plugin, action) => {
  const runtime = currentEditorRuntime;
  const textarea = mdTextarea();
  if (!runtime || !textarea) return;
  const bridge = runtime.editors.get(plugin) || runtime.editor;
  try {
    const result = await api('/admin/editor-actions/' + encodeURIComponent(plugin) + '/' + encodeURIComponent(action), {
      method: 'POST',
      body: { postId: runtime.postId || null, contentType: runtime.type, selection: textarea.value.slice(textarea.selectionStart || 0, textarea.selectionEnd || 0) },
    });
    if (result.insertText !== undefined) bridge.insertText(result.insertText);
    else if (result.replaceSelection !== undefined) bridge.replaceSelection(result.replaceSelection);
    else if (result.setPluginField) bridge.setPluginField(result.setPluginField.key, result.setPluginField.value);
  } catch (error) { toast(error.message, 'error'); }
};
function renderThemeEditorFields(fields, values) {
  if (!Array.isArray(fields) || fields.length === 0) return '';
  const saved = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const groups = new Map();
  for (const field of fields) {
    if (!field || typeof field.key !== 'string') continue;
    const group = typeof field.group === 'string' && field.group.trim() ? field.group : '主题字段';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(field);
  }
  return [...groups].map(([group, groupFields]) => {
    const controls = groupFields.map(field => {
      const id = 'pe-theme-field-' + field.key;
      const value = Object.hasOwn(saved, field.key)
        ? saved[field.key]
        : (field.default ?? (field.type === 'checkbox' ? false : field.type === 'number' ? 0 : field.type === 'select' ? field.options?.[0]?.value ?? '' : ''));
      const description = field.description
        ? '<div class="hint theme-editor-description">' + escape(field.description) + '</div>'
        : '';
      if (field.type === 'checkbox') {
        return '<div class="theme-editor-field"><label class="check-line theme-editor-checkbox" for="' + escape(id) +
          '"><input id="' + escape(id) + '" type="checkbox"' + (value === true ? ' checked' : '') + '><span>' +
          escape(field.label) + '</span></label>' + description + '</div>';
      }
      let control;
      if (field.type === 'textarea') {
        control = '<textarea id="' + escape(id) + '">' + escape(value) + '</textarea>';
      } else if (field.type === 'select') {
        const options = (Array.isArray(field.options) ? field.options : []).map(option =>
          '<option value="' + escape(option.value) + '"' + (String(option.value) === String(value) ? ' selected' : '') +
          '>' + escape(option.label) + '</option>').join('');
        control = '<select id="' + escape(id) + '">' + options + '</select>';
      } else {
        const type = ['number', 'url'].includes(field.type) ? field.type : 'text';
        const step = type === 'number' ? ' step="any"' : '';
        control = '<input id="' + escape(id) + '" type="' + type + '"' + step + ' value="' + escape(value) + '">';
      }
      return '<div class="form-group theme-editor-field"><label for="' + escape(id) + '">' + escape(field.label) +
        '</label>' + control + description + '</div>';
    }).join('');
    if (!controls) return '';
    return '<section class="side-box theme-editor-group" aria-label="' + escape(group) + '"><div class="side-box-title">' +
      escape(group) + '</div>' + controls + '</section>';
  }).join('');
}
async function loadPostEditor(type, id, signal) {
  type = type || 'post';
  const isPage = type === 'page';
  cleanupEditorRuntime();
  // 各项互不依赖，同时读取；可选信息失败不阻止写作。
  const [post, cats, templates, options, editorFieldResponse, editorPluginResponse, pageList] = await Promise.all([
    id ? api('/admin/posts/' + id, { signal }) : null,
    api('/admin/categories', { signal }).catch(() => []),
    isPage ? api('/admin/page-templates', { signal }).catch(() => null) : null,
    api(user?.role === 'admin' ? '/admin/options' : '/options/public', { signal }).catch(() => null),
    api('/admin/editor-fields?type=' + (isPage ? 'page' : 'post'), { signal }).catch(error => ({ error })),
    api('/admin/editor-extensions?type=' + (isPage ? 'page' : 'post'), { signal }).catch(error => ({ error })),
    isPage ? api('/admin/pages?page=1&pageSize=100', { signal }).catch(() => null) : null,
  ]);
  // 请求被切页或另一个编辑器取消后，不再覆盖当前页面。
  if (signal.aborted) return;
  currentEditorThemeFields = Array.isArray(editorFieldResponse?.fields) ? editorFieldResponse.fields : null;
  currentEditorPluginManifest = Array.isArray(editorPluginResponse?.extensions) ? editorPluginResponse : null;
  const themeFieldsMarkup = currentEditorThemeFields === null
    ? '<div class="side-box theme-editor-warning" role="status">主题字段加载失败，核心编辑器仍可使用；保存不会清除已保存的主题字段。</div>'
    : renderThemeEditorFields(currentEditorThemeFields, post?.themeFields);
  const pluginFieldsMarkup = currentEditorPluginManifest
    ? renderPluginEditorFields(currentEditorPluginManifest, post?.pluginFields)
    : '<div class="side-box theme-editor-warning plugin-editor-warning" role="status">插件编辑扩展加载失败，核心编辑器仍可使用。</div>';
  const pluginActionsMarkup = currentEditorPluginManifest ? renderPluginEditorActions(currentEditorPluginManifest) : '';
  const pluginSidebarActionsMarkup = currentEditorPluginManifest ? renderPluginSidebarActions(currentEditorPluginManifest) : '';
  const pageTpls = templates?.templates || [];
  const optionValue = key => Array.isArray(options)
    ? options.find(o => o.key === key)?.value : options?.[key];
  const permalinkTpl = (isPage ? optionValue('page_pattern') : optionValue('permalink')) || (isPage ? '/page/{slug}' : '/archives/{cid}/');
  const curTpl = post ? (post.template || '') : '';
  const tplOpts = ['<option value=""' + (curTpl ? '' : ' selected') + '>默认模板（page.html）</option>']
    .concat(pageTpls.map(t => '<option value="' + escape(t.key) + '"' + (curTpl === t.key ? ' selected' : '') + '>' + escape(t.name) + '（' + escape(t.file) + '）</option>'))
    .join('');
  // 与 Typecho 一致：主题里没有 page-*.html 时不显示「页面模板」下拉
  const tplGroup = (isPage && pageTpls.length)
    ? '<div class="form-group"><label>页面模板</label><select id="pe-template">' + tplOpts + '</select></div>'
    : '';
  // 页面层级：父级下拉排除自身与自己的后代，服务端仍会再校验一次环
  const pageItems = Array.isArray(pageList?.items) ? pageList.items : [];
  const descendantIds = new Set();
  if (isPage && id) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of pageItems) {
        if (item.id === id || descendantIds.has(item.id) || !item.parent_id) continue;
        if (item.parent_id === id || descendantIds.has(item.parent_id)) { descendantIds.add(item.id); grew = true; }
      }
    }
  }
  const parentOptions = ['<option value="">顶层页面</option>'].concat(pageItems
    .filter(item => item.id !== id && !descendantIds.has(item.id))
    .map(item => '<option value="' + escape(item.id) + '"' + (post && post.parent_id === item.id ? ' selected' : '') + '>' + escape(item.title || item.slug) + '</option>')).join('');
  const parentBox = isPage
    ? '<div class="side-box" id="pe-parent-box"><div class="side-box-title">页面层级</div>' +
      '<div class="form-group"><label for="pe-parent">父级页面</label><select id="pe-parent">' + parentOptions + '</select>' +
      '<div class="hint">有父级时公开路径按目录拼接，例如 /父页面/子页面；父级页面不能是自己或自己的子页面。</div></div></div>'
    : '';
  // 多分类：主分类走下拉（写入 category_id，供 {category} 永久链接），其余用复选框。
  const postCategoryIds = Array.isArray(post?.categoryIds) ? post.categoryIds
    : (Array.isArray(post?.categories) ? post.categories.map(item => item.id) : (post?.category_id ? [post.category_id] : []));
  const primaryCategory = postCategoryIds[0] || '';
  const catOpts = ['<option value="">无分类</option>'].concat((cats || []).map(c => '<option value="' + c.id + '"' + (primaryCategory === c.id ? ' selected' : '') + '>' + escape(c.name) + '</option>')).join('');
  const catExtras = (cats || []).filter(c => c.id !== primaryCategory).map(c =>
    '<label class="cat-extra"><input type="checkbox" name="pe-cat-extra" value="' + escape(c.id) + '"' + (postCategoryIds.includes(c.id) ? ' checked' : '') + '> ' + escape(c.name) + '</label>').join('');
  const st = post ? post.status : (user?.role === 'contributor' ? 'draft' : 'published');
  const statuses = user?.role === 'contributor' ? [['draft', '草稿']] : [['draft', '草稿'], ['published', '发布'], ['pending', '待审核']];
  const statusOpts = statuses.map(x => '<option value="' + x[0] + '"' + (st === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  // 可见性只对文章开放：私密与密码保护是公开阅读路径的两种受限模式。
  const postVisibility = post?.visibility || 'public';
  const visibilityOpts = [['public', '公开'], ['private', '私密'], ['password', '密码保护']]
    .map(x => '<option value="' + x[0] + '"' + (postVisibility === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  const visibilityBox = isPage ? '' : `
          <div class="form-group"><label for="pe-visibility">可见性</label><select id="pe-visibility" onchange="togglePostPassword()">${visibilityOpts}</select>
            <div class="hint">私密文章仅作者与管理员/编辑可见；密码保护文章需访客输入密码后阅读。</div></div>
          <div class="form-group" id="pe-post-password-box"${postVisibility === 'password' ? '' : ' hidden'}><label for="pe-post-password">访问密码</label><input id="pe-post-password" type="password" autocomplete="new-password" placeholder="4-100 位；留空表示不修改"><div class="hint">只保存哈希，不回填明文；编辑已有密码文章时留空即可保持原密码；解锁后访客 7 天内免再次输入。</div></div>`;
  const tagStr = post && post.tags ? post.tags.map(t => t.name).join(',') : '';
  const saveBtn = '<button class="btn btn-primary btn-block" onclick="savePost(\'' + type + '\',' + (id ? '\'' + id + '\'' : 'null') + ')">' + (id ? '更新' : '保存') + '</button>';
  setTopbar('<button class="btn btn-outline" onclick="navigate(\'' + (isPage ? 'pages' : 'posts') + '\')">← 返回列表</button>');
  document.getElementById('page-title').textContent = (id ? '编辑' : '新建') + (isPage ? '页面' : '文章');
  const catExtrasBlock = catExtras
    ? '<div class="cat-extras">' + catExtras + '</div>'
    : '<div class="hint">暂无其他分类可附加。</div>';
  const tagBox = isPage ? '' : (`
        <div class="side-box">
          <div class="side-box-title">分类与标签</div>
          <div class="form-group"><label for="pe-cat">主分类</label><select id="pe-cat">${catOpts}</select>
            <div class="hint">主分类用于分类永久链接；一篇文章可以再勾选多个附加分类。</div></div>
          <div class="form-group"><label>附加分类</label>${catExtrasBlock}</div>
          <div class="form-group"><label>标签（逗号分隔）</label><input id="pe-tags" value="${escape(tagStr)}" placeholder="tag1,tag2"></div>
        </div>`);
  const genericFields = (() => {
    try {
      const parsed = typeof post?.fields === 'string' ? JSON.parse(post.fields) : (post?.fields || {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
        !key.startsWith('_lill') && ['string', 'number', 'boolean'].includes(typeof value)));
    } catch { return {}; }
  })();
  const genericRows = Object.entries(genericFields).map(([key, value]) =>
    '<div class="generic-field-row"><input class="gf-key" aria-label="字段名" value="' + escape(key) + '" placeholder="字段名">' +
    '<input class="gf-value" aria-label="字段值" value="' + escape(String(value)) + '" placeholder="字段值">' +
    '<button type="button" class="btn btn-sm btn-ghost" onclick="removeGenericField(this)">删除</button></div>').join('');
  const genericFieldsBox = '<div class="side-box" id="pe-generic-box"><div class="side-box-title">自定义字段</div>' +
    '<div class="hint">键值对，供主题模板从 post.fields 读取；字段名仅限字母、数字与下划线。</div>' +
    '<div id="pe-generic-rows">' + genericRows + '</div>' +
    '<button type="button" class="btn btn-sm btn-outline" onclick="addGenericField()">+ 添加字段</button></div>';
  // 修订历史区块只在编辑已有文章时出现：新建文章还没有任何版本可回退。
  const versionsBoxMarkup = id
    ? '<div class="side-box" id="pe-versions"><div class="side-box-title">修订历史</div><div class="hint" id="pe-versions-list">加载中…</div></div>'
    : '';
  document.getElementById('content').innerHTML = `
  <div class="card editor-card" id="pe-editor-card">
    <div class="editor-layout">
      <div class="editor-main">
        <div id="pe-draft-banner" class="side-box" hidden style="border-color:#f59e0b;background:#fffbeb">
          <span id="pe-draft-banner-text"></span>
          <button type="button" class="btn btn-sm btn-primary" onclick="restoreServerDraft()">恢复草稿</button>
        </div>
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
          <div id="pe-plugin-toolbar-slot" class="plugin-editor-toolbar-slot">${pluginActionsMarkup}</div>
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
          ${visibilityBox}
          <div class="form-group"><label for="pe-published-at">发布时间</label><input id="pe-published-at" type="datetime-local" step="1" value="${localDateTime(post?.published_at)}"><div class="hint">本地时间；留空在首次发布时使用当前时间，未来时间到点后自动公开。</div></div>
          <label class="check-line"><input type="checkbox" id="pe-comment-allowed"${post?.comment_allowed === 0 ? '' : ' checked'}> 允许评论</label>
          <label class="check-line"><input type="checkbox" id="pe-allow-ping"${post?.allow_ping === 0 ? '' : ' checked'}> 允许引用</label>
          <label class="check-line"><input type="checkbox" id="pe-allow-feed"${post?.allow_feed === 0 ? '' : ' checked'}> 输出到 Feed</label>
          ${isPage ? '' : '<label class="check-line"><input type="checkbox" id="pe-sticky"' + (post && post.sticky ? ' checked' : '') + '> 置顶到首页</label>'}
          <div class="side-actions">${saveBtn}</div>
        </div>
        <div class="side-box">
          <div class="side-box-title">别名（URL）</div>
          <div class="form-group"><input id="pe-slug" value="${escape(post ? post.slug : '')}" placeholder="留空自动生成"><div class="hint" id="pe-slug-hint"></div></div>
        </div>
        ${versionsBoxMarkup}
        ${tagBox}
        ${genericFieldsBox}
        ${parentBox}
        <div class="side-box">
          <div class="side-box-title">更多</div>
          <div class="form-group"><label>封面图（URL，可选）</label><input id="pe-cover" value="${escape(post ? (post.cover_image || '') : '')}" placeholder="https://…"></div>
          ${tplGroup}
          ${isPage ? '<div class="form-group"><label for="pe-order">页面顺序</label><input id="pe-order" type="number" step="1" value="' + (post?.order || 0) + '"><div class="hint">数字越小越靠前</div></div>' : ''}
        </div>
        ${themeFieldsMarkup}
          ${pluginFieldsMarkup}
          <div id="pe-plugin-sidebar-slot" class="plugin-editor-sidebar-slot">${pluginSidebarActionsMarkup}</div>
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
  const pluginEntries = currentEditorPluginManifest?.extensions || [];
  const pluginEditors = new Map(pluginEntries.map(entry => [entry.plugin, createEditorBridge({
    post: post || {}, type, pluginDir: entry.plugin, fieldSchema: entry.fields, textarea: ta,
  })]));
  const baseEditor = createEditorBridge({ post: post || {}, type, pluginDir: '', fieldSchema: [], textarea: ta });
  const slots = createEditorSlots({
    toolbar: document.getElementById('pe-plugin-toolbar-slot'),
    sidebar: document.getElementById('pe-plugin-sidebar-slot'),
  });
  const runtime = {
    type, postId: id || null, editor: baseEditor, editors: pluginEditors, slots, extensionRuntime: null,
    manifest: currentEditorPluginManifest,
    async runSaveBefore(content) {
      let state = { content };
      for (const bridge of pluginEditors.values()) state = await bridge.runSaveBefore(state);
      return state;
    },
    emitSaveAfter(state) {
      for (const bridge of pluginEditors.values()) bridge.emitSaveAfter(state);
    },
  };
  currentEditorRuntime = runtime;
  loadEditorExtensions(currentEditorPluginManifest, {
    editor: baseEditor, editors: pluginEditors, slots,
  }).then(extensionRuntime => {
    if (currentEditorRuntime === runtime) runtime.extensionRuntime = extensionRuntime;
    else extensionRuntime.unload?.();
  }).catch(() => {});
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
  let serverDraftTimer = null;
  window.__lillDraftSave = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify({ title: titleInput.value, content: ta.value, excerpt: excerptInput.value, excerptAuto: excerptAuto.checked, at: Date.now() })); } catch (e) {}
    }, 800);
    // 已有文章额外把草稿推到服务器：换浏览器/清缓存也能找回；失败静默，不打断写作
    if (!id) return;
    clearTimeout(serverDraftTimer);
    serverDraftTimer = setTimeout(() => {
      api('/admin/posts/' + id + '/autosave', {
        method: 'POST',
        body: { title: titleInput.value, content: ta.value, excerpt: excerptInput.value },
      }).catch(() => {});
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
  // 服务器草稿：跨设备/清缓存也能找回；修订历史：一篇文章的版本快照
  const serverTimeText = value => {
    const raw = String(value || '');
    if (!raw) return '';
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
  };
  let serverDraft = null;
  const loadServerDraft = () => {
    if (!id) return;
    api('/admin/posts/' + id + '/autosave').then(res => {
      const draft = res && res.draft;
      if (!draft || typeof draft.post_id !== 'string') return;
      const title = typeof draft.title === 'string' ? draft.title : '';
      const content = typeof draft.content === 'string' ? draft.content : '';
      if (!title && !content) return;
      // 与服务器上的现值一致就不用打扰作者
      if (title === (post ? (post.title || '') : '') && content === (post ? (post.content || '') : '')) return;
      serverDraft = draft;
      const banner = document.getElementById('pe-draft-banner');
      const text = document.getElementById('pe-draft-banner-text');
      if (!banner || !text) return;
      text.textContent = '有服务器草稿（' + (serverTimeText(draft.updated_at) || '未知时间') + '），点击恢复。';
      banner.hidden = false;
    }).catch(() => {});
  };
  window.restoreServerDraft = () => {
    if (!serverDraft) return;
    if (typeof serverDraft.title === 'string' && serverDraft.title) titleInput.value = serverDraft.title;
    if (typeof serverDraft.content === 'string') ta.value = serverDraft.content;
    if (typeof serverDraft.excerpt === 'string' && serverDraft.excerpt) {
      excerptInput.value = serverDraft.excerpt;
      excerptAuto.checked = false;
      syncExcerptMode();
    }
    if (!slugTouched && !slugInput.value) slugInput.value = mdClientSlug(titleInput.value);
    serverDraft = null;
    const banner = document.getElementById('pe-draft-banner');
    if (banner) banner.hidden = true;
    mdSync();
    toast('已载入服务器草稿');
  };
  const loadVersions = () => {
    if (!id) return;
    const box = document.getElementById('pe-versions-list');
    if (!box) return;
    api('/admin/posts/' + id + '/versions').then(res => {
      const items = res && Array.isArray(res.items) ? res.items : [];
      if (!items.length) { box.textContent = '暂无修订记录'; return; }
      box.innerHTML = items.slice(0, 10).map(v => '<div class="version-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #e2e8f0"><div class="version-meta" style="min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escape(v.title || '（无标题）') + '</div><div class="hint">' + escape(serverTimeText(v.created_at)) + ' · ' + statusLabel(v.status) + '</div></div><button type="button" class="btn btn-sm btn-outline" onclick="restorePostVersion(' + jsArg(v.id) + ')">恢复</button></div>').join('');
    }).catch(() => { box.textContent = '修订记录加载失败'; });
  };
  loadServerDraft();
  loadVersions();
  titleInput.addEventListener('input', window.__lillDraftSave);
  excerptInput.addEventListener('input', window.__lillDraftSave);
  excerptAuto.addEventListener('change', window.__lillDraftSave);
  mdSync();
  renderSlugHint();
}

window.addGenericField = () => {
  const rows = document.getElementById('pe-generic-rows');
  if (!rows) return;
  if (rows.children.length >= 50) return toast('自定义字段最多 50 个', 'error');
  const row = document.createElement('div');
  row.className = 'generic-field-row';
  row.innerHTML = '<input class="gf-key" aria-label="字段名" placeholder="字段名">' +
    '<input class="gf-value" aria-label="字段值" placeholder="字段值">' +
    '<button type="button" class="btn btn-sm btn-ghost" onclick="removeGenericField(this)">删除</button>';
  rows.appendChild(row);
  row.querySelector('.gf-key').focus();
};
window.removeGenericField = button => {
  const row = button.closest('.generic-field-row');
  if (row) row.remove();
};
function collectGenericFields() {
  const rows = [...document.querySelectorAll('#pe-generic-rows .generic-field-row')];
  const result = {};
  const seen = new Set();
  for (const row of rows) {
    const key = row.querySelector('.gf-key').value.trim();
    const value = row.querySelector('.gf-value').value;
    if (!key) {
      if (value.trim()) throw new Error('请先填写自定义字段名');
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error('自定义字段名「' + key + '」无效：只能使用字母、数字和下划线，且不能以下划线开头');
    if (seen.has(key)) throw new Error('自定义字段名「' + key + '」重复');
    seen.add(key);
    result[key] = value;
  }
  return result;
}
window.togglePostPassword = () => {
  const select = document.getElementById('pe-visibility');
  const box = document.getElementById('pe-post-password-box');
  if (!select || !box) return;
  box.hidden = select.value !== 'password';
};

window.savePost = async (type, id) => {
  const view = activeView;
  const titleEl = document.getElementById('pe-title');
  if (!titleEl) return;
  const title = titleEl.value.trim();
  if (!title) return toast('请填写标题', 'error');
  let content = document.getElementById('pe-content').value;
  const runtime = currentEditorRuntime;
  try {
    if (runtime && runtime.type === type) {
      syncPluginEditorFields(runtime);
      const before = await runtime.runSaveBefore(content);
      content = before.content;
      if (content !== document.getElementById('pe-content').value) runtime.editor.replaceContent(content);
    }
  } catch (e) { return toast(e.message || '保存前处理失败', 'error'); }
  const body = {
    title, content, type,
    slug: document.getElementById('pe-slug').value.trim(),
    status: document.getElementById('pe-status').value,
    excerpt: document.getElementById('pe-excerpt').value || null,
    excerptAuto: document.getElementById('pe-excerpt-auto').checked,
    commentAllowed: document.getElementById('pe-comment-allowed').checked,
    allowPing: document.getElementById('pe-allow-ping').checked,
    allowFeed: document.getElementById('pe-allow-feed').checked,
  };
  const visibilityEl = document.getElementById('pe-visibility');
  if (visibilityEl) {
    body.visibility = visibilityEl.value;
    const passwordEl = document.getElementById('pe-post-password');
    const postPassword = passwordEl ? passwordEl.value : '';
    if (body.visibility === 'password') {
      // 与后端一致：密码只收 4-100 位字符串；留空表示保持原密码，编辑已有密码文章不必重填。
      if (postPassword !== '') {
        if (postPassword.length < 4 || postPassword.length > 100) return toast('密码保护需要 4-100 位密码', 'error');
        body.password = postPassword;
      } else if (!id) {
        // 新建密码文章必须给出密码，否则后端会以同样文案拒绝。
        return toast('密码保护需要 4-100 位密码', 'error');
      }
    } else {
      body.password = '';
    }
  }
  if (Array.isArray(currentEditorThemeFields) && currentEditorThemeFields.length) {
    body.themeFields = Object.fromEntries(currentEditorThemeFields.flatMap(field => {
      const input = document.getElementById('pe-theme-field-' + field.key);
      if (!input) return [];
      const value = field.type === 'checkbox'
        ? input.checked
        : field.type === 'number'
          ? (input.value.trim() === '' ? Number(field.default ?? 0) : Number(input.value))
          : input.value;
      return [[field.key, value]];
    }));
  }
  if (currentEditorPluginManifest && Array.isArray(currentEditorPluginManifest.extensions)) {
    const pluginFields = {};
    for (const entry of currentEditorPluginManifest.extensions) {
      const fields = Array.isArray(entry.fields) ? entry.fields : [];
      if (!fields.length) continue;
      const values = {};
      for (const field of fields) {
        const input = document.getElementById('pe-plugin-field-' + entry.plugin + '-' + field.key);
        const bridgeValue = runtime?.editors.get(entry.plugin)?.getPluginFields?.()[field.key];
        if (!input && bridgeValue === undefined) continue;
        values[field.key] = input
          ? field.type === 'checkbox'
            ? input.checked
            : field.type === 'number'
              ? (input.value.trim() === '' ? Number(field.default ?? 0) : Number(input.value))
              : input.value
          : bridgeValue;
      }
      if (Object.keys(values).length) pluginFields[entry.plugin] = values;
    }
    if (Object.keys(pluginFields).length) body.pluginFields = pluginFields;
  }
  const published = document.getElementById('pe-published-at');
  if (published.value !== published.defaultValue) body.publishedAt = published.value ? new Date(published.value).toISOString() : null;
  const order = document.getElementById('pe-order');
  if (order) body.order = Number(order.value);
  const parentEl = document.getElementById('pe-parent');
  if (parentEl) body.parentId = parentEl.value || null;
  const catEl = document.getElementById('pe-cat');
  if (catEl) {
    // 多分类：下拉是主分类（写入 category_id，供 {category} 永久链接），复选框是附加分类。
    const extraIds = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('input[name="pe-cat-extra"]:checked')).map(el => el.value)
      : [];
    const categoryIds = [catEl.value || '', ...extraIds].filter(Boolean);
    body.categoryIds = [...new Set(categoryIds)];
    body.categoryId = body.categoryIds[0] || null;
  }
  const tagEl = document.getElementById('pe-tags');
  if (tagEl) body.tagNames = tagEl.value.split(',').map(s => s.trim()).filter(Boolean);
  const coverEl = document.getElementById('pe-cover');
  if (coverEl) body.coverImage = coverEl.value.trim() || null;
  if (document.getElementById('pe-generic-box')) {
    try { body.fields = collectGenericFields(); }
    catch (e) { return toast(e.message, 'error'); }
  }
  const stickyEl = document.getElementById('pe-sticky');
  if (stickyEl) body.sticky = stickyEl.checked;
  // 仅当页面模板下拉存在时才提交 template，避免误清空已有设置
  if (type === 'page') { const tsel = document.getElementById('pe-template'); if (tsel) body.template = tsel.value; }
  try {
    if (id) await api('/admin/posts/' + id, { method: 'PUT', body });
    else await api('/admin/posts', { method: 'POST', body });
    if (runtime && runtime.type === type) runtime.emitSaveAfter({ content, pluginFields: body.pluginFields || {}, type, postId: id || null });
    try { localStorage.removeItem('lill:draft:' + type + ':' + (id || 'new')); } catch (e) {}
    if (id) api('/admin/posts/' + id + '/autosave', { method: 'DELETE' }).catch(() => {});
    toast(id ? '已更新' : '已保存');
    if (activeView === view) return window.navigate(type === 'page' ? 'pages' : 'posts');
  } catch (e) { toast(e.message, 'error'); }
};

window.restorePostVersion = async (versionId) => {
  const postId = currentEditorRuntime && currentEditorRuntime.postId;
  if (!postId) return;
  if (!confirm('恢复到这个修订版本？当前内容会先存为一条新的修订。')) return;
  const key = activeView && activeView.key;
  try {
    await api('/admin/posts/' + postId + '/versions/' + versionId + '/restore', { method: 'POST', body: {} });
    try { await api('/admin/posts/' + postId + '/autosave', { method: 'DELETE' }); } catch (e) {}
    toast('已恢复修订');
    if (activeView && activeView.key === key) window.retryView();
  } catch (e) { toast(e.message, 'error'); }
};

window.delPost = async (id) => { if (!confirm('确定删除？')) return; const view = activeView; try { await api('/admin/posts/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

// ═══ 文章列表 ═══
async function renderPosts() {
  const params = ['page=' + pageNum, 'pageSize=20'];
  if (postKeyword.trim()) params.push('keyword=' + encodeURIComponent(postKeyword.trim()));
  if (postCategoryId) params.push('categoryId=' + encodeURIComponent(postCategoryId));
  if (postStatus) params.push('status=' + encodeURIComponent(postStatus));
  const [r, categoryData] = await Promise.all([
    api('/admin/posts?' + params.join('&')),
    api('/admin/categories').catch(() => []),
  ]);
  const categories = Array.isArray(categoryData) ? categoryData : [];
  postCategoriesCache = categories;
  selectedPosts.clear();
  const rows = (r.items || []).map(p => '<tr><td><input type="checkbox" aria-label="选择文章" class="post-check" value="' + escape(p.id) + '" onchange="togglePostCheck(this.value, this.checked)"></td><td><strong>' + escape(p.title) + '</strong><br><small style="color:#64748b">' + escape(p.slug) + '</small></td><td>' + escape(p.category_name || '-') + '</td><td>' + statusLabel(p.status) + '</td><td>' + (p.comment_count || 0) + '</td><td>' + (p.view_count || 0) + '</td><td>' + fmt(p.created_at) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openPostEditor(\'post\',' + jsArg(p.id) + ')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delPost(\'' + p.id + '\')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openPostEditor(\'post\')">+ 写文章</button>');
  const filters = (user?.role === 'contributor' ? [['', '全部'], ['draft', '草稿']] : [['', '全部'], ['published', '已发布'], ['draft', '草稿'], ['pending', '待审核']]).map(([value, label]) =>
    '<button class="filter-tab' + (postStatus === value ? ' active' : '') + '" aria-pressed="' + (postStatus === value) + '" onclick="filterPosts(\'' + value + '\')">' + label + '</button>').join('');
  const categoryOpts = ['<option value="">全部分类</option>'].concat(categories.map(c => '<option value="' + escape(c.id) + '"' + (postCategoryId === c.id ? ' selected' : '') + '>' + escape(c.name) + '</option>')).join('');
  document.getElementById('content').innerHTML = '<div class="toolbar"><div class="filter-tabs" aria-label="文章状态">' + filters + '</div><div class="list-filters"><label for="post-keyword">关键词</label><input type="text" id="post-keyword" value="' + escape(postKeyword) + '" placeholder="搜索标题或正文"><select id="post-category" aria-label="文章分类">' + categoryOpts + '</select><button class="btn btn-sm btn-outline" onclick="applyPostFilters()">筛选</button><button class="btn btn-sm btn-ghost" onclick="resetPostFilters()">重置</button></div><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllPosts(this.checked)"> 选择本页文章</label></div><div id="post-selection"></div><div class="table-container"><table><thead><tr><th scope="col"><input aria-label="选择本页文章" type="checkbox" onchange="toggleAllPosts(this.checked)"></th><th scope="col">标题</th><th scope="col">分类</th><th scope="col">状态</th><th scope="col">评论</th><th scope="col">浏览</th><th scope="col">日期</th><th scope="col">操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8"><div class="empty">该状态下暂无文章</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
  updatePostSelection();
}

window.filterPosts = status => { postStatus = ['', 'published', 'draft', 'pending'].includes(status) ? status : ''; pageNum = 1; return render(); };
window.applyPostFilters = () => {
  postKeyword = document.getElementById('post-keyword')?.value.trim() || '';
  postCategoryId = document.getElementById('post-category')?.value || '';
  pageNum = 1;
  return render();
};
window.resetPostFilters = () => {
  postKeyword = '';
  postCategoryId = '';
  pageNum = 1;
  return render();
};
function updatePostSelection() {
  const bar = document.getElementById('post-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.post-check')];
  checks.forEach(el => { el.checked = selectedPosts.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllPosts(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  const publishAction = user?.role === 'contributor'
    ? ''
    : '<button class="btn btn-sm btn-outline" onclick="batchPosts(\'publish\')">批量发布</button>';
  const categoryOptions = postCategoriesCache.map(c => '<option value="' + escape(c.id) + '">' + escape(c.name) + '</option>').join('');
  bar.innerHTML = selectedPosts.size
    ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedPosts.size + ' 篇</span>' + publishAction +
      '<button class="btn btn-sm btn-outline" onclick="batchPosts(\'draft\')">批量转草稿</button>' +
      '<button class="btn btn-sm btn-outline" onclick="batchPosts(\'sticky\')">置顶</button>' +
      '<button class="btn btn-sm btn-outline" onclick="batchPosts(\'unsticky\')">取消置顶</button>' +
      (categoryOptions ? '<select id="batch-category" class="batch-select" aria-label="目标分类">' + categoryOptions + '</select><button class="btn btn-sm btn-outline" onclick="batchPosts(\'category\')">移动分类</button>' : '') +
      '<button class="btn btn-sm btn-danger" onclick="batchPosts(\'delete\')">批量删除</button>' +
      '<button class="btn btn-sm btn-outline" onclick="clearPostSelection()">取消选择</button></div>'
    : '';
}
window.togglePostCheck = (id, checked) => {
  if (checked) selectedPosts.add(id);
  else selectedPosts.delete(id);
  updatePostSelection();
};
window.toggleAllPosts = (checked) => {
  if (checked) document.querySelectorAll('.post-check').forEach(c => selectedPosts.add(c.value));
  else selectedPosts.clear();
  updatePostSelection();
};
window.clearPostSelection = () => { selectedPosts.clear(); updatePostSelection(); };
window.batchPosts = async (action) => {
  const view = activeView;
  const ids = selectedPosts.size
    ? Array.from(selectedPosts)
    : Array.from(document.querySelectorAll('.post-check:checked')).map(c => c.value);
  if (!ids.length) return toast('请先选择文章', 'error');
  if (action === 'delete' && !confirm('确定删除选中的文章？')) return;
  const body = { ids, action };
  if (action === 'category') {
    const select = document.getElementById('batch-category');
    if (!select || !select.value) return toast('请选择目标分类', 'error');
    body.categoryId = select.value;
  }
  try {
    await api('/admin/posts/batch', { method: 'POST', body });
    toast('操作完成');
    selectedPosts.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

// ═══ 页面列表 ═══
async function renderPages() {
  const params = new URLSearchParams({ page: String(pageNum), pageSize: '20' });
  if (pageKeyword) params.set('keyword', pageKeyword);
  if (pageCategoryId) params.set('categoryId', pageCategoryId);
  const [r, categories] = await Promise.all([api('/admin/pages?' + params), api('/admin/categories').catch(() => [])]);
  selectedPages.clear();
  const pageItems = r.items || [];
  const pageById = new Map(pageItems.map(item => [item.id, item]));
  const pageDepth = item => {
    let depth = 0; let cursor = item.parent_id ? pageById.get(item.parent_id) : null; const seen = new Set([item.id]);
    while (cursor && !seen.has(cursor.id) && depth < 10) { seen.add(cursor.id); depth++; cursor = cursor.parent_id ? pageById.get(cursor.parent_id) : null; }
    return depth;
  };
  const pageSlugPath = item => {
    const slugs = []; let cursor = item; const seen = new Set();
    while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); slugs.unshift(cursor.slug); cursor = cursor.parent_id ? pageById.get(cursor.parent_id) : null; }
    return slugs.join('/');
  };
  const rows = pageItems.map((p, index) => '<tr><td><input type="checkbox" aria-label="选择页面" class="page-check" value="' + escape(p.id) + '" onchange="togglePageCheck(this.value, this.checked)"></td><td><strong style="display:inline-block;padding-left:' + (pageDepth(p) * 14) + 'px">' + (pageDepth(p) ? '↳ ' : '') + escape(p.title) + '</strong><br><small style="color:#64748b">' + escape(pageSlugPath(p)) + '</small></td><td>' + (p.order ?? 0) + '</td><td>' + escape(p.template || '默认模板') + '</td><td>' + statusLabel(p.status) + '</td><td>' + (p.view_count || 0) + '</td><td>' + fmt(p.created_at) + '</td><td class="actions"><button class="btn btn-sm btn-outline" title="上移" aria-label="上移" onclick="movePage(\'' + p.id + '\',-1)">↑</button> <button class="btn btn-sm btn-outline" title="下移" aria-label="下移" onclick="movePage(\'' + p.id + '\',1)">↓</button> <button class="btn btn-sm btn-outline" onclick="openPostEditor(\'page\',\'' + p.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delPost(\'' + p.id + '\')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openPostEditor(\'page\')">+ 新建页面</button>');
  const categoryOpts = ['<option value="">全部分类</option>'].concat((Array.isArray(categories) ? categories : []).map(c => '<option value="' + escape(c.id) + '"' + (pageCategoryId === c.id ? ' selected' : '') + '>' + escape(c.name) + '</option>')).join('');
  document.getElementById('content').innerHTML = '<div class="toolbar"><div class="list-filters"><label for="page-keyword">关键词</label><input type="text" id="page-keyword" value="' + escape(pageKeyword) + '" placeholder="搜索标题或正文"><select id="page-category" aria-label="页面分类">' + categoryOpts + '</select><button class="btn btn-sm btn-outline" onclick="applyPageFilters()">筛选</button><button class="btn btn-sm btn-ghost" onclick="resetPageFilters()">重置</button></div><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllPages(this.checked)"> 选择本页页面</label></div><div id="page-selection"></div><div class="table-container"><table><thead><tr><th scope="col"><input aria-label="选择本页页面" type="checkbox" onchange="toggleAllPages(this.checked)"></th><th scope="col">标题</th><th scope="col">顺序</th><th scope="col">模板</th><th scope="col">状态</th><th scope="col">浏览</th><th scope="col">日期</th><th scope="col">操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8"><div class="empty">暂无页面</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
  updatePageSelection();
}
window.applyPageFilters = () => {
  pageKeyword = document.getElementById('page-keyword')?.value.trim() || '';
  pageCategoryId = document.getElementById('page-category')?.value || '';
  pageNum = 1;
  return render();
};
window.resetPageFilters = () => { pageKeyword = ''; pageCategoryId = ''; pageNum = 1; return render(); };
window.movePage = async (id, delta) => {
  try {
    const r = await api('/admin/pages?page=1&pageSize=100');
    const items = (r.items || []).slice();
    const from = items.findIndex(item => item.id === id);
    const to = from + delta;
    if (from < 0) return;
    if (to < 0 || to >= items.length) return toast('已经在边界', 'error');
    [items[from], items[to]] = [items[to], items[from]];
    await api('/admin/pages/reorder', { method: 'POST', body: items.map((item, index) => ({ id: item.id, order: index })) });
    toast('顺序已更新');
    refreshView(activeView);
  } catch (e) { toast(e.message, 'error'); }
};
function updatePageSelection() {
  const bar = document.getElementById('page-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.page-check')];
  checks.forEach(el => { el.checked = selectedPages.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllPages(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  const publishAction = user?.role === 'contributor' ? '' : '<button class="btn btn-sm btn-outline" onclick="batchPages(\'publish\')">批量发布</button>';
  bar.innerHTML = selectedPages.size
    ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedPages.size + ' 个页面</span>' + publishAction + '<button class="btn btn-sm btn-outline" onclick="batchPages(\'draft\')">批量转草稿</button><button class="btn btn-sm btn-danger" onclick="batchPages(\'delete\')">批量删除</button><button class="btn btn-sm btn-outline" onclick="clearPageSelection()">取消选择</button></div>'
    : '';
}
window.togglePageCheck = (id, checked) => {
  if (checked) selectedPages.add(id);
  else selectedPages.delete(id);
  updatePageSelection();
};
window.toggleAllPages = (checked) => {
  if (checked) document.querySelectorAll('.page-check').forEach(c => selectedPages.add(c.value));
  else selectedPages.clear();
  updatePageSelection();
};
window.clearPageSelection = () => { selectedPages.clear(); updatePageSelection(); };
window.batchPages = async (action) => {
  const view = activeView;
  const ids = selectedPages.size ? Array.from(selectedPages) : Array.from(document.querySelectorAll('.page-check:checked')).map(c => c.value);
  if (!ids.length) return toast('请先选择页面', 'error');
  if (action === 'delete' && !confirm('确定删除选中的 ' + ids.length + ' 个页面？')) return;
  try {
    await api('/admin/pages/batch', { method: 'POST', body: { ids, action } });
    toast('操作完成');
    selectedPages.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

// ═══ 操作日志 ═══
async function renderLogs() {
  const r = await api('/admin/logs?page=' + pageNum + '&pageSize=20');
  selectedLogs.clear();
  const rows = (r.items || []).map(l => '<tr><td><input type="checkbox" aria-label="选择日志" class="log-check" value="' + escape(l.id) + '" onchange="toggleLogCheck(this.value, this.checked)"></td><td>' + fmt(l.created_at) + '</td><td>' + escape(l.username || '-') + '</td><td><code>' + escape(l.action) + '</code></td><td>' + escape(l.detail || '-') + '</td><td>' + escape(l.ip || '-') + '</td></tr>').join('');
  setTopbar('<button class="btn btn-danger" onclick="clearLogs()">清空日志</button>');
  document.getElementById('content').innerHTML = '<div class="toolbar"><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllLogs(this.checked)"> 选择本页日志</label></div><div id="log-selection"></div><div class="table-container"><table><thead><tr><th scope="col"><input aria-label="选择本页日志" type="checkbox" onchange="toggleAllLogs(this.checked)"></th><th scope="col">时间</th><th scope="col">用户</th><th scope="col">操作</th><th scope="col">详情</th><th scope="col">IP</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6"><div class="empty">暂无日志</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
  updateLogSelection();
}

function updateLogSelection() {
  const bar = document.getElementById('log-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.log-check')];
  checks.forEach(el => { el.checked = selectedLogs.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllLogs(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  bar.innerHTML = selectedLogs.size ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedLogs.size + ' 条</span><button class="btn btn-sm btn-danger" onclick="batchDeleteLogs()">删除选中</button><button class="btn btn-sm btn-outline" onclick="clearLogSelection()">取消选择</button></div>' : '';
}
window.toggleLogCheck = (id, checked) => { if (checked) selectedLogs.add(id); else selectedLogs.delete(id); updateLogSelection(); };
window.toggleAllLogs = checked => { if (checked) document.querySelectorAll('.log-check').forEach(el => selectedLogs.add(el.value)); else selectedLogs.clear(); updateLogSelection(); };
window.clearLogSelection = () => { selectedLogs.clear(); updateLogSelection(); };
window.batchDeleteLogs = async () => {
  const view = activeView;
  const ids = [...selectedLogs];
  if (!ids.length) return toast('请先选择日志', 'error');
  try {
    const result = await api('/admin/logs/batch', { method: 'POST', body: { ids } });
    toast('已删除 ' + result.deleted + ' 条日志');
    selectedLogs.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

window.clearLogs = async () => {
  if (!confirm('确定清空所有日志？')) return;
  const view = activeView;
  try { await api('/admin/logs', { method: 'DELETE' }); toast('已清空'); refreshView(view); } catch (e) { toast(e.message, 'error'); }
};

// ═══ 备份 ═══
async function renderBackup() {
  const backups = await api('/admin/backup/list');
  selectedBackups.clear();
  setTopbar('<button class="btn btn-primary" onclick="createBackup()">+ 创建备份</button>');
  const rows = backups.map(b => '<tr><td><input type="checkbox" aria-label="选择备份" class="backup-check" value="' + escape(b.name) + '" onchange="toggleBackupCheck(this.value, this.checked)"></td><td>' + escape(b.name) + '</td><td>' +
    (b.size / 1024).toFixed(1) + ' KB</td><td>' + escape(new Date(b.created_at).toLocaleString('zh-CN')) +
    '</td><td><button class="btn btn-sm btn-outline" onclick="downloadBackup(' + jsArg(b.name) + ')">下载</button>' +
    (/\.db$/.test(b.name) ? ' <button class="btn btn-sm btn-danger" onclick="restoreBackup(' + jsArg(b.name) + ')">恢复</button>' : '') +
    '</td></tr>').join('');
  document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">站点备份</h3>' +
    '<p>数据库和附件分别打包。数据库包含账号及配置，请将下载的备份妥善保存。</p></div>' +
    '<div id="backup-progress" aria-live="polite"></div>' +
    '<div class="toolbar"><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllBackups(this.checked)"> 选择本页备份</label></div><div id="backup-selection"></div><div class="table-container"><table><thead><tr><th scope="col"><input aria-label="选择本页备份" type="checkbox" onchange="toggleAllBackups(this.checked)"></th><th scope="col">文件</th><th scope="col">大小</th><th scope="col">创建时间</th><th scope="col">操作</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="5"><div class="empty">暂无备份，点击创建备份</div></td></tr>') + '</tbody></table></div>';
  updateBackupSelection();
}

function updateBackupSelection() {
  const bar = document.getElementById('backup-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.backup-check')];
  checks.forEach(el => { el.checked = selectedBackups.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllBackups(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  bar.innerHTML = selectedBackups.size ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedBackups.size + ' 项</span><button class="btn btn-sm btn-danger" onclick="batchDeleteBackups()">删除选中</button><button class="btn btn-sm btn-outline" onclick="clearBackupSelection()">取消选择</button></div>' : '';
}
window.toggleBackupCheck = (name, checked) => { if (checked) selectedBackups.add(name); else selectedBackups.delete(name); updateBackupSelection(); };
window.toggleAllBackups = checked => { if (checked) document.querySelectorAll('.backup-check').forEach(el => selectedBackups.add(el.value)); else selectedBackups.clear(); updateBackupSelection(); };
window.clearBackupSelection = () => { selectedBackups.clear(); updateBackupSelection(); };
window.batchDeleteBackups = async () => {
  const view = activeView;
  const names = [...selectedBackups];
  if (!names.length) return toast('请先选择备份', 'error');
  if (!confirm('确定删除选中的 ' + names.length + ' 个附件备份？')) return;
  try {
    const result = await api('/admin/backup', { method: 'DELETE', body: { names } });
    toast(result.skipped.length ? '已删除 ' + result.updated + ' 个，跳过 ' + result.skipped.length + ' 个' : '已删除 ' + result.updated + ' 个备份');
    selectedBackups.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

window.createBackup = async () => {
  const view = activeView;
  const buttons = [...document.querySelectorAll('button[onclick="createBackup()"]')];
  if (buttons.some(button => button.disabled)) return;
  buttons.forEach(button => { button.disabled = true; button.textContent = '备份中…'; });
  const progress = document.getElementById('backup-progress');
  const showProgress = async () => {
    try {
      const state = await api('/admin/backup/progress');
      if (!progress || activeView?.navigation !== view.navigation) return;
      const percent = Math.max(0, Math.min(100, Number(state.progress) || 0));
      progress.innerHTML = '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">' + escape(state.message || '正在备份') + '</span><progress max="100" value="' + percent + '"></progress><strong>' + percent + '%</strong></div>';
    } catch (e) {
      if (progress) progress.textContent = e.message;
    }
  };
  clearInterval(backupProgressTimer);
  await showProgress();
  backupProgressTimer = setInterval(showProgress, 800);
  try {
    await api('/admin/backup', { method: 'POST', timeout: 180000 });
    toast('备份已创建，可以下载'); refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
  finally {
    clearInterval(backupProgressTimer);
    backupProgressTimer = null;
    buttons.forEach(button => { button.disabled = false; button.textContent = '+ 创建备份'; });
  }
};
window.restoreBackup = async name => {
  if (!/\.db$/.test(name)) return toast('请选择数据库备份文件（.db）', 'error');
  if (!confirm('将用备份 ' + name + ' 覆盖当前站点数据库。\n恢复前会自动生成一份当前数据的安全快照，但恢复后需要重新登录。确定继续？')) return;
  if (!confirm('再次确认：恢复会替换现有的文章、评论、用户与设置。')) return;
  const typed = prompt('请输入「恢复」两个字以确认操作');
  if (typed !== '恢复') return toast('已取消恢复');
  const view = activeView;
  try {
    const result = await api('/admin/backup/restore', { method: 'POST', body: { name }, timeout: 180000 });
    toast(result.message || ('已从 ' + result.restored + ' 恢复 ' + result.tables + ' 张表，请重新登录'), 'success');
    if (confirm('数据库已恢复。是否立即刷新页面并重新登录？')) location.reload();
    else refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
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
  const can = managesTaxonomy();
  selectedCategories.clear();
  const rows = (r || []).map(c => '<tr>' + (can ? '<td><input type="checkbox" aria-label="选择分类" class="cat-check" value="' + escape(c.id) + '" onchange="toggleCatCheck(this.value, this.checked)"></td>' : '') + '<td><strong>' + escape(c.name) + '</strong></td><td><code>' + escape(c.slug) + '</code></td><td>' + escape(c.description || '-') + '</td><td>' + (c.parent_name ? escape(c.parent_name) : '-') + '</td><td>' + (c.post_count || 0) + '</td><td class="sort-cell"><span class="sort-val">' + (c.sort_order || 0) + '</span><button class="btn btn-sm btn-outline" title="上移" aria-label="分类上移" onclick="moveCategory(\'' + c.id + '\',-1)">↑</button><button class="btn btn-sm btn-outline" title="下移" aria-label="分类下移" onclick="moveCategory(\'' + c.id + '\',1)">↓</button></td><td class="actions">' + (managesTaxonomy() ? '<button class="btn btn-sm btn-outline" onclick="openCatEditor(\'' + c.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delCat(\'' + c.id + '\')">删除</button>' : '只读') + '</td></tr>').join('');
  setTopbar(managesTaxonomy() ? '<button class="btn btn-primary" onclick="openCatEditor()">+ 新建分类</button>' : '');
  document.getElementById('content').innerHTML = '<div class="toolbar"><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllCats(this.checked)"> 选择本页分类</label></div><div id="cat-selection"></div><div class="table-container"><table><thead><tr>' + (can ? '<th scope="col"><input aria-label="选择本页分类" type="checkbox" onchange="toggleAllCats(this.checked)"></th>' : '') + '<th scope="col">名称</th><th scope="col">别名</th><th scope="col">描述</th><th scope="col">父级</th><th scope="col">文章数</th><th scope="col">排序</th><th scope="col">操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="' + (can ? 8 : 7) + '"><div class="empty">暂无分类</div></td></tr>') + '</tbody></table></div>';
  labelTableRows();
  updateCatSelection();
}
function updateCatSelection() {
  const bar = document.getElementById('cat-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.cat-check')];
  checks.forEach(el => { el.checked = selectedCategories.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllCats(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  bar.innerHTML = selectedCategories.size
    ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedCategories.size + ' 个分类</span><button class="btn btn-sm btn-danger" onclick="batchCats()">批量删除</button><button class="btn btn-sm btn-outline" onclick="clearCatSelection()">取消选择</button></div>'
    : '';
}
window.toggleCatCheck = (id, checked) => {
  if (checked) selectedCategories.add(id);
  else selectedCategories.delete(id);
  updateCatSelection();
};
window.toggleAllCats = (checked) => {
  if (checked) document.querySelectorAll('.cat-check').forEach(c => selectedCategories.add(c.value));
  else selectedCategories.clear();
  updateCatSelection();
};
window.clearCatSelection = () => { selectedCategories.clear(); updateCatSelection(); };
window.batchCats = async () => {
  const view = activeView;
  const ids = Array.from(selectedCategories);
  if (!ids.length) return toast('请先选择分类', 'error');
  if (!confirm('确定删除选中的 ' + ids.length + ' 个分类？分类下的文章将变为未分类，仍有子分类的分类会跳过并提示。')) return;
  try {
    const r = await api('/admin/categories/batch', { method: 'POST', body: { ids, action: 'delete' } });
    toast('已删除 ' + (r.deleted || ids.length) + ' 个分类');
    selectedCategories.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.moveCategory = async (id, delta) => {
  const view = activeView;
  try {
    const list = (await api('/admin/categories') || []).slice();
    const index = list.findIndex(c => c.id === id);
    const target = index + delta;
    if (index < 0) return;
    if (target < 0 || target >= list.length) return toast('已经在边界', 'error');
    const items = list.map((c, i) => ({ id: c.id, sortOrder: i }));
    [items[index], items[target]] = [items[target], items[index]];
    await api('/admin/categories/reorder', { method: 'POST', body: { items } });
    toast('顺序已更新');
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

window.openCatEditor = id => showView('category-editor:' + (id || 'new'), signal => loadCatEditor(id, signal), true);
async function loadCatEditor(id, signal) {
  let cat = null, cats = [];
  cats = await api('/admin/categories', { signal });
  if (signal.aborted) return;
  if (id) cat = (cats || []).find(c => c.id === id);
  if (id && !cat) throw new Error('分类不存在');
  const children = new Map();
  for (const item of cats || []) {
    if (!item.parent_id) continue;
    if (!children.has(item.parent_id)) children.set(item.parent_id, []);
    children.get(item.parent_id).push(item.id);
  }
  const blocked = new Set([id]);
  const queue = id ? [id] : [];
  while (queue.length) {
    for (const childId of children.get(queue.shift()) || []) {
      if (blocked.has(childId)) continue;
      blocked.add(childId);
      queue.push(childId);
    }
  }
  const parentOpts = ['<option value="">无父级</option>'].concat((cats || []).filter(c => !blocked.has(c.id)).map(c => '<option value="' + c.id + '"' + (cat && cat.parent_id === c.id ? ' selected' : '') + '>' + escape(c.name) + '</option>')).join('');
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
  const can = managesTaxonomy();
  selectedTags.clear();
  const rows = (r.items || []).map(t => '<tr>' + (can ? '<td><input type="checkbox" aria-label="选择标签" class="tag-check" value="' + escape(t.id) + '" onchange="toggleTagCheck(this.value, this.checked)"></td>' : '') + '<td><strong>' + escape(t.name) + '</strong></td><td><code>' + escape(t.slug) + '</code></td><td>' + (t.post_count || 0) + '</td><td class="sort-cell"><span class="sort-val">' + (t.sort_order || 0) + '</span><button class="btn btn-sm btn-outline" title="上移" aria-label="标签上移" onclick="moveTag(\'' + t.id + '\',-1)">↑</button><button class="btn btn-sm btn-outline" title="下移" aria-label="标签下移" onclick="moveTag(\'' + t.id + '\',1)">↓</button></td><td class="actions">' + (managesTaxonomy() ? '<button class="btn btn-sm btn-outline" onclick="openTagEditor(' + jsArg(t.id) + ',' + jsArg(t.name) + ')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delTag(\'' + t.id + '\')">删除</button>' : '只读') + '</td></tr>').join('');
  setTopbar(managesTaxonomy() ? '<button class="btn btn-primary" onclick="openTagEditor()">+ 新建标签</button>' : '');
  document.getElementById('content').innerHTML = '<div class="toolbar"><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllTags(this.checked)"> 选择本页标签</label></div><div id="tag-selection"></div><div class="table-container"><table><thead><tr>' + (can ? '<th scope="col"><input aria-label="选择本页标签" type="checkbox" onchange="toggleAllTags(this.checked)"></th>' : '') + '<th scope="col">名称</th><th scope="col">别名</th><th scope="col">文章数</th><th scope="col">排序</th><th scope="col">操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="' + (can ? 6 : 5) + '"><div class="empty">暂无标签</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
  updateTagSelection();
}
function updateTagSelection() {
  const bar = document.getElementById('tag-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.tag-check')];
  checks.forEach(el => { el.checked = selectedTags.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllTags(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  bar.innerHTML = selectedTags.size
    ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedTags.size + ' 个标签</span><button class="btn btn-sm btn-danger" onclick="batchTags()">批量删除</button><button class="btn btn-sm btn-outline" onclick="clearTagSelection()">取消选择</button></div>'
    : '';
}
window.toggleTagCheck = (id, checked) => {
  if (checked) selectedTags.add(id);
  else selectedTags.delete(id);
  updateTagSelection();
};
window.toggleAllTags = (checked) => {
  if (checked) document.querySelectorAll('.tag-check').forEach(c => selectedTags.add(c.value));
  else selectedTags.clear();
  updateTagSelection();
};
window.clearTagSelection = () => { selectedTags.clear(); updateTagSelection(); };
window.batchTags = async () => {
  const view = activeView;
  const ids = Array.from(selectedTags);
  if (!ids.length) return toast('请先选择标签', 'error');
  if (!confirm('确定删除选中的 ' + ids.length + ' 个标签？文章不会被删除，只会解除标签关联。')) return;
  try {
    const r = await api('/admin/tags/batch', { method: 'POST', body: { ids, action: 'delete' } });
    toast('已删除 ' + (r.deleted || ids.length) + ' 个标签');
    selectedTags.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.moveTag = async (id, delta) => {
  const view = activeView;
  try {
    const r = await api('/admin/tags?pageSize=100&page=' + pageNum);
    const list = (r.items || []).slice();
    const index = list.findIndex(t => t.id === id);
    const target = index + delta;
    if (index < 0) return;
    if (target < 0 || target >= list.length) return toast('已经在边界', 'error');
    const items = list.map((t, i) => ({ id: t.id, sortOrder: i }));
    [items[index], items[target]] = [items[target], items[index]];
    await api('/admin/tags/reorder', { method: 'POST', body: { items } });
    toast('顺序已更新');
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
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
let commentPostOptions = null;
let commentPostOptionsPromise = null;

async function loadCommentPostOptions() {
  if (commentPostOptions) return commentPostOptions;
  if (!commentPostOptionsPromise) {
    commentPostOptionsPromise = api('/admin/posts?type=post&page=1&pageSize=100')
      .then(data => {
        const posts = Array.isArray(data) ? data : (data?.items || []);
        commentPostOptions = posts;
        return posts;
      })
      .catch(() => {
        commentPostOptions = [];
        return commentPostOptions;
      })
      .finally(() => { commentPostOptionsPromise = null; });
  }
  return commentPostOptionsPromise;
}

async function renderComments() {
  const status = commentStatus;
  const params = ['page=' + pageNum, 'pageSize=20'];
  if (status) params.push('status=' + encodeURIComponent(status));
  if (commentPostId) params.push('postId=' + encodeURIComponent(commentPostId));
  if (commentKeyword) params.push('keyword=' + encodeURIComponent(commentKeyword));
  const [r, posts] = await Promise.all([
    api('/admin/comments?' + params.join('&')),
    loadCommentPostOptions(),
  ]);
  commentRows = new Map((r.items || []).map(c => [c.id, c]));
  const rows = (r.items || []).map(c => '<tr><td><input type="checkbox" aria-label="选择评论" class="cmt-check" value="' + c.id + '" ' + (selectedComments.has(c.id) ? 'checked' : '') + ' onchange="toggleCmtCheck(\'' + c.id + '\', this.checked)"></td><td>' + escape((c.content || '').substring(0, 50)) + '</td><td>' + escape(c.post_title || '-') + '</td><td>' + escape(c.author_name || c.username || '匿名') + '</td><td>' + statusLabel(c.status) + '</td><td>' + fmt(c.created_at) + '</td><td class="actions">' +
    (c.status !== 'approved' ? '<button class="btn btn-sm btn-outline" onclick="setCmt(\'' + c.id + '\',\'approved\')">通过</button> ' : '') +
    (c.status !== 'spam' ? '<button class="btn btn-sm btn-outline" onclick="setCmt(\'' + c.id + '\',\'spam\')">垃圾</button> ' : '') +
    '<button class="btn btn-sm btn-outline" onclick="replyCmt(\'' + c.id + '\')">回复</button> ' +
    '<button class="btn btn-sm btn-outline" onclick="editCmt(\'' + c.id + '\')">编辑</button> ' +
    '<button class="btn btn-sm btn-danger" onclick="delCmt(\'' + c.id + '\')">删除</button></td></tr>').join('');
  
  setTopbar('<button class="btn btn-outline" onclick="exportComments()">导出 CSV</button>');
  document.getElementById('content').innerHTML =
    '<div class="toolbar"><div class="list-filters"><label for="comment-keyword">关键词</label><input type="text" id="comment-keyword" value="' + escape(commentKeyword) + '" placeholder="搜索内容、作者或邮箱"><label for="cf-status">评论状态</label><select id="cf-status" onchange="filterComments(this.value, document.getElementById(\'cf-post\').value)">' +
    ['', 'pending', 'approved', 'spam'].map(v => '<option value="' + v + '"' + (status === v ? ' selected' : '') + '>' + ({ '': '所有状态', pending: '待审核', approved: '已通过', spam: '垃圾' }[v]) + '</option>').join('') +
    '</select><label for="cf-post">文章</label><select id="cf-post" onchange="filterComments(document.getElementById(\'cf-status\').value, this.value)"><option value="">所有文章</option>' +
    posts.map(post => '<option value="' + escape(post.id) + '"' + (commentPostId === post.id ? ' selected' : '') + '>' + escape(post.title || '无标题') + '</option>').join('') +
    '</select><button class="btn btn-sm btn-outline" onclick="applyCommentFilters()">筛选</button><button class="btn btn-sm btn-ghost" onclick="resetCommentFilters()">重置</button></div><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllCmts(this.checked)"' +
    ((r.items || []).length && r.items.every(c => selectedComments.has(c.id)) ? ' checked' : '') + '> 选择本页评论</label></div><div id="comment-selection"></div>' +
    '<div class="table-container"><table><thead><tr><th scope="col"><input aria-label="选择本页评论" type="checkbox" onchange="toggleAllCmts(this.checked)"></th><th scope="col">内容</th><th scope="col">文章</th><th scope="col">作者</th><th scope="col">状态</th><th scope="col">日期</th><th scope="col">操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty">该状态下暂无评论</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
  updateCommentSelection();
}
window.exportComments = async () => {
  try {
    const response = await fetch('/api/v1/admin/comments/export', { headers: { Authorization: 'Bearer ' + window.lillAPI.getToken() } });
    if (!response.ok) throw new Error('导出失败（HTTP ' + response.status + '）');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'comments.csv';
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) { toast(error.message, 'error'); }
};
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
  bar.innerHTML = selectedComments.size ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedComments.size + ' 项</span><button class="btn btn-sm btn-outline" onclick="batchCmtStatus(\'approved\')">批量通过</button><button class="btn btn-sm btn-outline" onclick="batchCmtStatus(\'spam\')">批量垃圾</button><button class="btn btn-sm btn-danger" onclick="batchCmtDelete()">批量删除</button><button class="btn btn-sm btn-outline" onclick="clearCmtSelection()">取消选择</button></div>' : '';
}
window.filterComments = (status, postId = commentPostId) => { commentStatus = ['', 'pending', 'approved', 'spam'].includes(status) ? status : ''; commentPostId = typeof postId === 'string' ? postId : ''; selectedComments.clear(); pageNum = 1; return render(); };
window.applyCommentFilters = () => { commentKeyword = document.getElementById('comment-keyword')?.value.trim() || ''; commentStatus = document.getElementById('cf-status')?.value || ''; commentPostId = document.getElementById('cf-post')?.value || ''; pageNum = 1; selectedComments.clear(); return render(); };
window.resetCommentFilters = () => { commentKeyword = ''; commentStatus = ''; commentPostId = ''; pageNum = 1; selectedComments.clear(); return render(); };
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
    await api('/admin/comments/batch-delete', { method: 'POST', body: { ids } });
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
  const params = new URLSearchParams({ pageSize: '24', page: String(pageNum) });
  if (mediaKeyword) params.set('keyword', mediaKeyword);
  const r = await api('/admin/media?' + params);
  mediaRowsCache = r.items || [];
  selectedMedia.clear();
  const grid = (r.items || []).map(m => '<div class="media-card"><label class="media-select"><input type="checkbox" aria-label="选择附件" class="media-check" value="' + escape(m.id) + '" onchange="toggleMediaCheck(this.value, this.checked)"></label><div class="mp">' + (String(m.mime_type || '').startsWith('image/') ? '<img src="' + escape(m.url) + '" alt="' + escape(m.alt || m.name) + '" loading="lazy" decoding="async">' : '<div class="mfi">📎</div>') + '</div><div class="mi2"><div class="mn" title="' + escape(m.name) + '">' + escape(m.name) + '</div><div class="mm">' + (m.size / 1024).toFixed(1) + ' KB · ' + fmt(m.created_at) + '</div></div><div class="ma"><button class="btn btn-sm btn-outline" onclick="openMediaEditor(\'' + m.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delMedia(\'' + m.id + '\')">删除</button></div></div>').join('');
  setTopbar('<button class="btn btn-primary" onclick="uploadMedia()">+ 上传附件</button>');
  document.getElementById('content').innerHTML = '<div class="toolbar"><div class="list-filters"><label for="media-keyword">关键词</label><input type="text" id="media-keyword" value="' + escape(mediaKeyword) + '" placeholder="搜索文件名或替代文本"><button class="btn btn-sm btn-outline" onclick="applyMediaFilters()">筛选</button><button class="btn btn-sm btn-ghost" onclick="resetMediaFilters()">重置</button></div><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllMedia(this.checked)"> 选择本页附件</label></div><div id="media-selection"></div><div class="card"><input type="file" id="media-file-input" accept="image/*,.pdf,.txt,.md,.zip" style="display:none"><div class="media-grid">' + (grid || '<div class="empty">暂无附件，点击右上角上传</div>') + '</div></div>' + paginate(r.meta);
  const fi = document.getElementById('media-file-input');
  if (fi) fi.onchange = handleMediaFile;
  updateMediaSelection();
}
window.applyMediaFilters = () => { mediaKeyword = document.getElementById('media-keyword')?.value.trim() || ''; pageNum = 1; return render(); };
window.resetMediaFilters = () => { mediaKeyword = ''; pageNum = 1; return render(); };
function updateMediaSelection() {
  const bar = document.getElementById('media-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.media-check')];
  checks.forEach(el => { el.checked = selectedMedia.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllMedia(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  bar.innerHTML = selectedMedia.size
    ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedMedia.size + ' 个附件</span><input id="media-batch-alt" class="batch-input" placeholder="替代文本（alt）" aria-label="批量替代文本"><button class="btn btn-sm btn-outline" onclick="batchMediaAlt()">应用</button><button class="btn btn-sm btn-danger" onclick="batchMediaDelete()">批量删除</button><button class="btn btn-sm btn-outline" onclick="copyMediaLinks()">复制链接</button><button class="btn btn-sm btn-outline" onclick="clearMediaSelection()">取消选择</button></div>'
    : '';
}
window.toggleMediaCheck = (id, checked) => {
  if (checked) selectedMedia.add(id);
  else selectedMedia.delete(id);
  updateMediaSelection();
};
window.toggleAllMedia = (checked) => {
  if (checked) document.querySelectorAll('.media-check').forEach(c => selectedMedia.add(c.value));
  else selectedMedia.clear();
  updateMediaSelection();
};
window.clearMediaSelection = () => { selectedMedia.clear(); updateMediaSelection(); };
window.batchMediaDelete = async () => {
  const view = activeView;
  const ids = Array.from(selectedMedia);
  if (!ids.length) return toast('请先选择附件', 'error');
  if (!confirm('确定删除选中的 ' + ids.length + ' 个附件？已引用这些文件的文章会显示失效图片。')) return;
  try {
    const r = await api('/admin/media/batch', { method: 'POST', body: { ids, action: 'delete' } });
    toast('已删除 ' + (r.deleted || ids.length) + ' 个附件');
    selectedMedia.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.batchMediaAlt = async () => {
  const view = activeView;
  const ids = Array.from(selectedMedia);
  if (!ids.length) return toast('请先选择附件', 'error');
  const input = document.getElementById('media-batch-alt');
  const alt = ((input && input.value) || '').trim();
  try {
    const r = await api('/admin/media/batch', { method: 'POST', body: { ids, action: 'alt', alt } });
    toast('已更新 ' + (r.updated || ids.length) + ' 个附件的替代文本');
    if (input) input.value = '';
    selectedMedia.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.copyMediaLinks = async () => {
  const ids = Array.from(selectedMedia);
  if (!ids.length) return toast('请先选择附件', 'error');
  const map = new Map(mediaRowsCache.map(m => [m.id, m]));
  const urls = ids.map(id => map.get(id)).filter(Boolean).map(m => (String(m.url).startsWith('http') ? m.url : location.origin + m.url));
  try { await navigator.clipboard.writeText(urls.join('\n')); toast('已复制 ' + urls.length + ' 个链接'); }
  catch (e) { toast('复制失败，请检查浏览器剪贴板权限', 'error'); }
};
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

window.openMediaEditor = async id => {
  try {
    let item = (mediaRowsCache || []).find(m => String(m.id) === String(id));
    if (!item) item = await api('/admin/media/' + encodeURIComponent(id));
    if (!item) throw new Error('附件不存在');
    const isImage = String(item.mime_type || '').startsWith('image/');
    const ext = (String(item.name || '').match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
    document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">编辑附件</h3>' +
      '<div class="form-group"><label for="me-name">文件名</label><input id="me-name" maxlength="255" value="' + escape(item.name || '') + '"></div>' +
      '<div class="form-group"><label for="me-slug">缩略名</label><input id="me-slug" maxlength="120" value="' + escape(item.slug || '') + '" placeholder="仅小写字母、数字与连字符"><small class="muted">用于生成稳定的附件标识，留空则清空</small></div>' +
      '<div class="form-group"><label for="me-alt">替代文本</label><input id="me-alt" maxlength="500" value="' + escape(item.alt || '') + '"><small class="muted">图片无法显示时展示，也供读屏软件朗读</small></div>' +
      '<div class="form-group"><label for="me-desc">描述</label><textarea id="me-desc" rows="4" maxlength="2000">' + escape(item.description || '') + '</textarea></div>' +
      '<div class="form-group"><label>替换文件</label>' + (isImage ? '<img src="' + escape(item.url) + '" alt="" style="max-width:200px;border-radius:8px;display:block;margin-bottom:8px">' : '') +
      '<input type="file" id="me-file"><small class="muted">就地替换并保留原链接与扩展名（' + escape(ext || '无扩展名') + '），大小上限 40MB</small></div>' +
      '<button class="btn btn-primary" onclick="saveMediaEditor(' + jsArg(item.id) + ')">保存</button> <button class="btn btn-outline" onclick="navigate(\'media\')">取消</button></div>';
    const fi = document.getElementById('me-file');
    if (fi) fi.onchange = ev => replaceMediaFile(item.id, ev);
  } catch (e) { toast(e.message, 'error'); }
};
window.saveMediaEditor = async id => {
  const name = document.getElementById('me-name').value.trim();
  const slug = document.getElementById('me-slug').value.trim();
  const alt = document.getElementById('me-alt').value.trim();
  const description = document.getElementById('me-desc').value.trim();
  if (!name) return toast('文件名不能为空', 'error');
  if (name.length > 255) return toast('文件名不能超过 255 个字符', 'error');
  if (slug && !/^[a-z0-9-]+$/.test(slug)) return toast('缩略名只能包含小写字母、数字与连字符', 'error');
  try {
    await api('/admin/media/' + encodeURIComponent(id), { method: 'PUT', body: { name, slug, alt, description } });
    toast('已保存');
    navigate('media');
  } catch (e) { toast(e.message, 'error'); }
};
async function replaceMediaFile(id, ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) return toast('文件不能超过 40MB', 'error');
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  try {
    await api('/admin/media/' + encodeURIComponent(id) + '/replace', { method: 'POST', body: { name: file.name, data: base64 }, timeout: 120000 });
    toast('已替换，原链接保持不变');
    navigate('media');
  } catch (e) { toast(e.message, 'error'); }
}
window.delMedia = async (id) => { if (!confirm('确定删除？')) return; const view = activeView; try { await api('/admin/media/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

// ═══ 外观（Typecho 模式：主题列表 → 选主题 → 专属设置页） ═══
let currentThemeId = null;
let themeEditorState = null;
let themeEditorRequest = 0;

function clearThemeEditor() {
  themeEditorRequest++;
  themeEditorState = null;
}

async function renderThemes() {
  clearThemeEditor();
  currentThemeId = null;
  const themes = await api('/admin/themes');
  selectedThemes.clear();
  let html = '<div class="card"><h3 class="card-title">主题</h3><div id="theme-selection"></div><div class="theme-grid">';
  if (themes.length) themes.forEach(t => {
    var screenshot = t.screenshot ? '<img src="' + escape(t.screenshot) + '" alt="" loading="lazy">' : '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M3 4h18v16H3z M3 8h18 M8 8v12"/></svg>';
    // 内置主题与当前启用中的主题不可删除，复选框一并禁用，避免选了才被后端拒绝。
    const deletable = !t.active && t.theme_id !== 'default';
    html += '<div class="theme-card' + (t.active ? ' active' : '') + '">' +
      '<label class="theme-check" title="' + (deletable ? '选择此主题' : '内置主题或当前启用中的主题不可删除') + '"><input type="checkbox" class="theme-checkbox" aria-label="选择主题 ' + escape(t.name) + '" value="' + escape(t.theme_id) + '"' + (deletable ? ' onchange="toggleThemeCheck(this.value, this.checked)"' : ' disabled') + '></label>' +
      '<div class="thumb">' + screenshot + (t.active ? '<span class="theme-badge">使用中</span>' : '') + '</div>' +
      '<div class="tv"><h3>' + escape(t.name) + '</h3>' +
      '<p>' + escape(t.description || '暂无描述') + '</p>' +
      '<div class="theme-meta"><span class="theme-version">v' + escape(t.version) + '</span>' +
      (t.author ? '<span class="theme-author">作者：' + escape(t.author) + '</span>' : '') + '</div>' +
      '<div class="actions">' +
      (t.active ? '<span class="tag tag-green">当前主题</span>' : '<button class="btn btn-sm btn-primary" onclick="activateTheme(\'' + escape(t.theme_id) + '\')">启用</button>') +
      (t.hasSettings ? '<button class="btn btn-sm btn-outline" onclick="openThemeSettings(\'' + escape(t.theme_id) + '\')">设置</button>' : '') +
      (['admin', 'editor'].includes(user?.role) ? '<button class="btn btn-sm btn-outline" onclick="openThemeFileEditor(' + jsArg(t.theme_id) + ')">编辑文件</button>' : '') +
      (deletable ? '<button class="btn btn-sm btn-danger" onclick="deleteTheme(\'' + escape(t.theme_id) + '\', \'' + escape(t.name) + '\')">删除</button>' : '') +
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
  updateThemeSelection();
}
window.renderThemes = renderThemes;

function themeEditorHTML() {
  const state = themeEditorState;
  if (!state) return '';
  const files = state.files.map(file => '<button type="button" class="btn btn-sm ' + (state.path === file.path ? 'btn-primary' : 'btn-outline') + '" style="display:block;width:100%;text-align:left;margin-bottom:6px" onclick="selectThemeFile(' + jsArg(file.path) + ')">' + escape(file.path) + ' <small>' + (file.size / 1024).toFixed(1) + ' KB</small></button>').join('');
  const content = state.path === null ? '<p class="empty">选择一个文件开始编辑</p>' :
    '<textarea id="theme-file-content" spellcheck="false" style="width:100%;min-height:320px;font-family:monospace;white-space:pre;tab-size:2" oninput="updateThemeFileContent(this.value)">' + escape(state.content) + '</textarea>';
  return '<div class="card" id="theme-file-editor" style="margin-top:20px"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><h3 class="card-title">主题文件：' + escape(state.themeId) + '</h3><button type="button" class="btn btn-sm btn-outline" onclick="closeThemeFileEditor()">关闭</button></div>' +
    '<div style="display:grid;grid-template-columns:minmax(180px,28%) minmax(0,1fr);gap:16px"><aside><div style="max-height:480px;overflow:auto">' + (files || '<p class="empty">没有可编辑文件</p>') + '</div></aside><section>' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><strong>' + escape(state.path || '未选择文件') + '</strong><span id="theme-file-dirty" style="color:var(--text-light)">' + (state.dirty ? '未保存' : '') + '</span><span style="flex:1"></span><button type="button" class="btn btn-sm btn-outline" onclick="reloadThemeFile()"' + (state.path === null ? ' disabled' : '') + '>重新加载</button><button type="button" class="btn btn-sm btn-primary" onclick="saveThemeFile()"' + (state.path === null ? ' disabled' : '') + '>保存</button></div>' + content + '</section></div></div>';
}

function renderThemeFileEditor() {
  const content = document.getElementById('content');
  const oldPanel = document.getElementById('theme-file-editor');
  if (oldPanel) oldPanel.remove();
  if (content && themeEditorState) content.insertAdjacentHTML('beforeend', themeEditorHTML());
}

window.openThemeFileEditor = async themeId => {
  if (!['admin', 'editor'].includes(user?.role)) return;
  clearThemeEditor();
  themeEditorState = { themeId: String(themeId), files: [], path: null, content: '', dirty: false };
  const requestId = themeEditorRequest;
  renderThemeFileEditor();
  try {
    const files = await api('/admin/themes/files?theme=' + encodeURIComponent(themeEditorState.themeId));
    if (requestId !== themeEditorRequest || !themeEditorState || themeEditorState.themeId !== String(themeId)) return;
    themeEditorState.files = Array.isArray(files) ? files : [];
    renderThemeFileEditor();
  } catch (error) {
    if (requestId === themeEditorRequest) toast(error.message, 'error');
  }
};

window.selectThemeFile = async path => {
  const state = themeEditorState;
  if (!state || (state.dirty && !confirm('当前文件有未保存修改，确定切换文件并丢弃修改吗？'))) return;
  const requestId = ++themeEditorRequest;
  const themeId = state.themeId;
  state.path = String(path);
  state.content = '';
  state.dirty = false;
  renderThemeFileEditor();
  try {
    const result = await api('/admin/themes/file?theme=' + encodeURIComponent(themeId) + '&path=' + encodeURIComponent(path));
    if (requestId !== themeEditorRequest || themeEditorState?.themeId !== themeId || themeEditorState.path !== path) return;
    themeEditorState.content = result.content;
    renderThemeFileEditor();
  } catch (error) {
    if (requestId === themeEditorRequest) toast(error.message, 'error');
  }
};

window.updateThemeFileContent = content => {
  if (!themeEditorState) return;
  themeEditorState.content = content;
  themeEditorState.dirty = true;
  const dirty = document.getElementById('theme-file-dirty');
  if (dirty) dirty.textContent = '未保存';
};

window.reloadThemeFile = async () => {
  const state = themeEditorState;
  if (!state?.path || (state.dirty && !confirm('确定重新加载并丢弃未保存修改吗？'))) return;
  const requestId = ++themeEditorRequest;
  const { themeId, path } = state;
  try {
    const result = await api('/admin/themes/file?theme=' + encodeURIComponent(themeId) + '&path=' + encodeURIComponent(path));
    if (requestId !== themeEditorRequest || themeEditorState?.themeId !== themeId || themeEditorState.path !== path) return;
    themeEditorState.content = result.content;
    themeEditorState.dirty = false;
    renderThemeFileEditor();
  } catch (error) {
    if (requestId === themeEditorRequest) toast(error.message, 'error');
  }
};

window.saveThemeFile = async () => {
  const state = themeEditorState;
  if (!state?.path) return;
  const { themeId, path, content } = state;
  try {
    await api('/admin/themes/file', { method: 'PUT', body: { theme: themeId, path, content } });
    if (themeEditorState?.themeId !== themeId || themeEditorState.path !== path) return;
    themeEditorState.dirty = false;
    toast('保存成功');
    const files = await api('/admin/themes/files?theme=' + encodeURIComponent(themeId));
    if (themeEditorState?.themeId !== themeId) return;
    themeEditorState.files = Array.isArray(files) ? files : [];
    renderThemeFileEditor();
  } catch (error) { toast(error.message, 'error'); }
};

window.closeThemeFileEditor = () => {
  if (themeEditorState?.dirty && !confirm('当前文件有未保存修改，确定关闭并丢弃修改吗？')) return;
  clearThemeEditor();
  document.getElementById('theme-file-editor')?.remove();
};

function updateThemeSelection() {
  const bar = document.getElementById('theme-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.theme-checkbox')];
  checks.forEach(el => { el.checked = selectedThemes.has(el.value); });
  bar.innerHTML = selectedThemes.size
    ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedThemes.size + ' 个主题</span><button class="btn btn-sm btn-danger" onclick="batchDeleteThemes()">批量删除</button><button class="btn btn-sm btn-outline" onclick="clearThemeSelection()">取消选择</button></div>'
    : '';
}
window.toggleThemeCheck = (themeId, checked) => {
  if (checked) selectedThemes.add(themeId);
  else selectedThemes.delete(themeId);
  updateThemeSelection();
};
window.clearThemeSelection = () => { selectedThemes.clear(); updateThemeSelection(); };
window.deleteTheme = async (themeId, name) => {
  const view = activeView;
  if (!confirm('确定删除主题「' + (name || themeId) + '」？该操作不可撤销。')) return;
  try {
    await api('/admin/themes/' + encodeURIComponent(themeId), { method: 'DELETE' });
    toast('已删除主题');
    selectedThemes.delete(themeId);
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.batchDeleteThemes = async () => {
  const view = activeView;
  const themes = selectedThemes.size ? Array.from(selectedThemes) : Array.from(document.querySelectorAll('.theme-checkbox:checked')).map(el => el.value);
  if (!themes.length) return toast('请先选择主题', 'error');
  if (!confirm('确定删除选中的 ' + themes.length + ' 个主题？该操作不可撤销。')) return;
  try {
    const r = await api('/admin/themes/batch', { method: 'POST', body: { themes, action: 'delete' } });
    const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
    toast(skipped.length ? '已删除 ' + (r.deleted?.length || 0) + ' 个，跳过 ' + skipped.length + ' 个' : '操作完成');
    if (skipped.length) console.warn('theme batch skipped', skipped);
    selectedThemes.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

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
  const params = new URLSearchParams({ pageSize: '20', page: String(pageNum) });
  if (userKeyword) params.set('keyword', userKeyword);
  const r = await api('/admin/users?' + params);
  const canBatch = !!(user && user.role === 'admin');
  selectedUsers.clear();
  const rows = (r.items || []).map(u => '<tr>' + (canBatch ? '<td><input type="checkbox" aria-label="选择用户" class="user-check" value="' + escape(u.id) + '" onchange="toggleUserCheck(this.value, this.checked)"></td>' : '') + '<td><strong>' + escape(u.username) + '</strong></td><td>' + escape(u.nickname || '-') + '</td><td>' + escape(u.email) + '</td><td><span class="tag tag-blue">' + roleLabel(u.role) + '</span></td><td>' + statusLabel(u.status) + '</td><td>' + (u.post_count || 0) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openUserEditor(\'' + u.id + '\')">编辑</button> ' + (u.id === (user && user.id) ? '' : '<button class="btn btn-sm btn-danger" onclick="delUser(\'' + u.id + '\')">删除</button>') + '</td></tr>').join('');
  const cols = canBatch ? 8 : 7;
  setTopbar('<button class="btn btn-primary" onclick="openUserEditor()">+ 新建用户</button>');
  document.getElementById('content').innerHTML = '<div class="toolbar"><div class="list-filters"><label for="user-keyword">关键词</label><input type="text" id="user-keyword" value="' + escape(userKeyword) + '" placeholder="搜索用户名、昵称或邮箱"><button class="btn btn-sm btn-outline" onclick="applyUserFilters()">筛选</button><button class="btn btn-sm btn-ghost" onclick="resetUserFilters()">重置</button></div>' + (canBatch ? '<label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllUsers(this.checked)"> 选择本页用户</label>' : '') + '</div>' + (canBatch ? '<div id="user-selection"></div>' : '') + '<div class="table-container"><table><thead><tr>' + (canBatch ? '<th scope="col"><input aria-label="选择本页用户" type="checkbox" onchange="toggleAllUsers(this.checked)"></th>' : '') + '<th scope="col">用户名</th><th scope="col">昵称</th><th scope="col">邮箱</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col">文章</th><th scope="col">操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="' + cols + '"><div class="empty">暂无用户</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
  labelTableRows();
  updateUserSelection();
}
window.applyUserFilters = () => { userKeyword = document.getElementById('user-keyword')?.value.trim() || ''; pageNum = 1; return render(); };
window.resetUserFilters = () => { userKeyword = ''; pageNum = 1; return render(); };
window.openUserEditor = id => showView('user-editor:' + (id || 'new'), signal => loadUserEditor(id, signal), true);
async function loadUserEditor(id, signal) {
  let u = null;
  if (id) {
    u = await api('/admin/users/' + encodeURIComponent(id), { signal });
    if (!u) throw new Error('用户不存在');
  }
  if (signal.aborted) return;
  const currentRole = u ? u.role : 'subscriber';
  const currentStatus = u ? u.status : 'active';
  const roleOpts = [['admin', '管理员'], ['editor', '编辑'], ['author', '作者'], ['contributor', '投稿者'], ['subscriber', '订阅者']].map(x => '<option value="' + x[0] + '"' + (currentRole === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  const statusOpts = [['active', '正常'], ['banned', '禁用']].map(x => '<option value="' + x[0] + '"' + (currentStatus === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
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
  if (!id && !pass) return toast('请填写密码', 'error');
  if (!id && pass.length < 6) return toast('密码至少6位', 'error');
  try {
    if (id) await api('/admin/users/' + id, { method: 'PUT', body });
    else await api('/admin/users', { method: 'POST', body });
    toast('已保存'); if (activeView?.navigation === view.navigation) refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
window.delUser = async (id) => { if (!confirm('确定删除该用户？')) return; const view = activeView; try { await api('/admin/users/' + id, { method: 'DELETE' }); toast('已删除'); refreshView(view); } catch (e) { toast(e.message, 'error'); } };

function updateUserSelection() {
  const bar = document.getElementById('user-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.user-check')];
  checks.forEach(el => { el.checked = selectedUsers.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllUsers(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  bar.innerHTML = selectedUsers.size
    ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedUsers.size + ' 个用户</span><button class="btn btn-sm btn-outline" onclick="batchUsers(\'activate\')">批量启用</button><button class="btn btn-sm btn-outline" onclick="batchUsers(\'ban\')">批量禁用</button><button class="btn btn-sm btn-danger" onclick="batchUsers(\'delete\')">批量删除</button><button class="btn btn-sm btn-outline" onclick="clearUserSelection()">取消选择</button></div>'
    : '';
}
window.toggleUserCheck = (id, checked) => {
  if (checked) selectedUsers.add(id);
  else selectedUsers.delete(id);
  updateUserSelection();
};
window.toggleAllUsers = (checked) => {
  if (checked) document.querySelectorAll('.user-check').forEach(c => selectedUsers.add(c.value));
  else selectedUsers.clear();
  updateUserSelection();
};
window.clearUserSelection = () => { selectedUsers.clear(); updateUserSelection(); };
window.batchUsers = async (action) => {
  const view = activeView;
  const ids = selectedUsers.size ? Array.from(selectedUsers) : Array.from(document.querySelectorAll('.user-check:checked')).map(c => c.value);
  if (!ids.length) return toast('请先选择用户', 'error');
  if (action === 'delete' && !confirm('确定删除选中的 ' + ids.length + ' 个用户？')) return;
  try {
    const r = await api('/admin/users/batch', { method: 'POST', body: { ids, action } });
    const skipped = (r && r.skipped) || [];
    toast(skipped.length ? '完成，跳过 ' + skipped.length + ' 个：' + skipped[0].reason : '操作完成');
    selectedUsers.clear();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

// ═══ 设置 ═══
const PERMALINK_GROUPS = [
  { key: 'post', label: '文章路径', option: 'permalink', defaultPattern: '/archives/{cid}/', sample: 'hello-world',
    presets: [['/archives/{cid}/', '默认：/archives/{cid}/'], ['/archives/{slug}/', '文章别名：/archives/{slug}/'], ['/{category}/{slug}/', '分类 + 别名：/{category}/{slug}/'], ['/{year}/{month}/{slug}/', '年月 + 别名：/{year}/{month}/{slug}/'], ['/archives/{year}/{month}/{day}/{slug}.html', '年月日 + 别名：/archives/{year}/{month}/{day}/{slug}.html']],
    hint: '可用变量：{cid} 文章 ID、{slug} 别名、{category} 分类别名、{year} 年份、{month} 月份、{day} 日期' },
  { key: 'page', label: '独立页面路径', option: 'page_pattern', defaultPattern: '/page/{slug}', sample: 'about',
    presets: [['/page/{slug}', '默认：/page/{slug}'], ['/{slug}', '根路径：/{slug}'], ['/{slug}.html', '静态化：/{slug}.html'], ['/{slug}.htm', '静态化：/{slug}.htm'], ['/{slug}.php', '静态化：/{slug}.php']],
    hint: '可用变量：{slug} 页面别名；建议保持一段路径，便于主题导航与代理重写' },
  { key: 'category', label: '分类路径', option: 'category_prefix', defaultPattern: '/category/{slug}/', sample: 'notes',
    presets: [['/category/{slug}/', '分类别名：/category/{slug}/'], ['/category/{mid}/', '分类 ID：/category/{mid}/'], ['/category/{slug}.html', '分类 + 别名：/category/{slug}.html']],
    hint: '可用变量：{slug} 分类别名、{mid} 分类 ID' },
  { key: 'tag', label: '标签路径', option: 'tag_prefix', defaultPattern: '/tag/{slug}/', sample: 'tips',
    presets: [['/tag/{slug}/', '标签别名：/tag/{slug}/'], ['/tag/{slug}.html', '标签 + 别名：/tag/{slug}.html'], ['/tag/{mid}/', '标签 ID：/tag/{mid}/']],
    hint: '可用变量：{slug} 标签别名、{mid} 标签 ID' },
];
const BUILTIN_PATHS = [
  { key: 'archive_path', label: '归档路径', defaultPath: '/archive' },
  { key: 'search_path', label: '搜索路径', defaultPath: '/search' },
];
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
  
  // 永久链接设置（Typecho 风格：每种类型单选预设 + 自定义格式 + 实时预览）
  html += '<div id="settings-permalink" class="settings-panel" style="display:none"><div class="card"><h3 class="card-title">永久链接设置</h3>' +
    '<p class="form-hint">每种内容类型都可以单独选择预设或填写自定义格式。保存后新链接立即生效，旧链接仍可通过原有路径访问。</p>';
  for (const group of PERMALINK_GROUPS) {
    const current = o[group.option] || group.defaultPattern;
    const isPreset = group.presets.some(preset => preset[0] === current);
    html += '<div class="permalink-group" data-pl-group="' + group.key + '">' +
      '<div class="permalink-label">' + escape(group.label) + '</div>' +
      '<div class="permalink-options">' +
      group.presets.map(preset => '<label class="permalink-option"><input type="radio" name="pl-' + group.key + '" value="' + escape(preset[0]) + '"' + (isPreset && current === preset[0] ? ' checked' : '') + '><span>' + escape(preset[1]) + '</span></label>').join('') +
      '<label class="permalink-option"><input type="radio" name="pl-' + group.key + '" value="__custom__"' + (isPreset ? '' : ' checked') + '><span>自定义格式</span></label>' +
      '</div>' +
      '<div class="permalink-custom"><input id="pl-custom-' + group.key + '" value="' + escape(isPreset ? '' : current) + '" placeholder="' + escape(group.defaultPattern) + '"' + (isPreset ? ' disabled' : '') + '><button type="button" class="btn btn-sm btn-outline" data-pl-reset="' + group.key + '">恢复默认</button></div>' +
      '<div class="form-hint">' + escape(group.hint) + '</div>' +
      '<div class="permalink-preview">示例：<code id="pl-preview-' + group.key + '"></code></div></div>';
  }
  for (const item of BUILTIN_PATHS) {
    html += '<div class="form-group"><label for="' + item.key + '">' + item.label + '</label><input id="' + item.key + '" value="' + escape(o[item.key] || item.defaultPath) + '" placeholder="' + item.defaultPath + '"></div>';
  }
  html += '<p class="form-hint">上线提示：修改永久链接或下面两个内置路径后，若站点走 Nginx 静态壳，需要 reload nginx（<code>nginx -s reload</code>）让 <code>/sitemap.xml</code>、<code>/robots.txt</code> 的反代生效；旧链接仍可按原路径访问。</p>' +
    '<div class="permalink-conflict" id="pl-conflict" role="status" style="display:none"></div>' +
    '<div class="form-group"><label for="pl-resolve-url">粘贴 URL 试解析</label><div class="permalink-custom"><input id="pl-resolve-url" type="url" placeholder="https://example.com/archives/..."><button type="button" class="btn btn-sm btn-outline" data-pl-resolve>解析</button></div><div class="form-hint" id="pl-resolve-result" role="status"></div></div>' +
    '<button class="btn btn-primary" onclick="saveSettings()">保存设置</button></div></div>';
  document.getElementById('content').innerHTML = html;
  PERMALINK_GROUPS.forEach(group => renderPermalinkPreview(group.key));
  bindPermalinkControls();
  renderPermalinkConflicts();
  setTopbar('');
}
window.switchSettingsTab = (tab, button) => {
  document.querySelectorAll('.settings-tab').forEach(el => el.classList.remove('active'));
  if (button) button.classList.add('active');
  document.querySelectorAll('.settings-panel').forEach(el => el.style.display = 'none');
  document.getElementById('settings-' + tab).style.display = 'block';
};
function permalinkPicked(key) {
  const group = PERMALINK_GROUPS.find(item => item.key === key);
  const picked = document.querySelector('input[name="pl-' + key + '"]:checked');
  if (!picked) return group ? group.defaultPattern : '';
  if (picked.value === '__custom__') {
    const custom = document.getElementById('pl-custom-' + key);
    return custom ? custom.value.trim() : '';
  }
  return picked.value;
}
function permalinkPreview(pattern, group) {
  if (!pattern) return '（尚未填写自定义格式）';
  const fill = (text, token, value) => text.split(token).join(value);
  let result = pattern;
  result = fill(result, '{cid}', '42');
  result = fill(result, '{mid}', group.key === 'category' ? '7' : '9');
  result = fill(result, '{slug}', group.sample);
  result = fill(result, '{category}', 'notes');
  result = fill(result, '{year}', '2026');
  result = fill(result, '{month}', '10');
  result = fill(result, '{day}', '20');
  return result;
}
window.renderPermalinkPreview = (key) => {
  const group = PERMALINK_GROUPS.find(item => item.key === key);
  const target = document.getElementById('pl-preview-' + key);
  if (!group || !target) return;
  target.textContent = permalinkPreview(permalinkPicked(key), group);
};
window.resetPermalink = (key) => {
  const group = PERMALINK_GROUPS.find(item => item.key === key);
  if (!group) return;
  const radio = document.querySelector('input[name="pl-' + key + '"][value="' + group.defaultPattern + '"]');
  if (radio) radio.checked = true;
  const custom = document.getElementById('pl-custom-' + key);
  if (custom) { custom.value = ''; custom.disabled = true; }
  renderPermalinkPreview(key);
};
function bindPermalinkControls() {
  document.querySelectorAll('.permalink-option input[type=radio]').forEach(radio => {
    radio.addEventListener('change', () => {
      const key = radio.name.replace('pl-', '');
      const custom = document.getElementById('pl-custom-' + key);
      if (custom) custom.disabled = radio.value !== '__custom__';
      renderPermalinkPreview(key);
    });
  });
  document.querySelectorAll('input[id^=pl-custom-]').forEach(input => {
    input.addEventListener('input', () => renderPermalinkPreview(input.id.replace('pl-custom-', '')));
  });
  document.querySelectorAll('button[data-pl-reset]').forEach(button => {
    button.addEventListener('click', () => resetPermalink(button.getAttribute('data-pl-reset')));
  });
  document.querySelectorAll('input[name^="pl-"]').forEach(input => input.addEventListener('change', renderPermalinkConflicts));
  document.querySelectorAll('input[id^=pl-custom-]').forEach(input => input.addEventListener('input', renderPermalinkConflicts));
  document.querySelector('[data-pl-resolve]')?.addEventListener('click', async () => {
    const input = document.getElementById('pl-resolve-url');
    const target = document.getElementById('pl-resolve-result');
    if (!input || !target) return;
    try {
      const response = await api('/admin/permalinks/resolve', { method: 'POST', body: { url: input.value.trim() } });
      const result = response?.result;
      target.textContent = result ? result.type + ' · ' + result.slug + ' · ' + result.id : '解析不到';
    } catch (error) { target.textContent = '解析不到'; }
  });
}
function renderPermalinkConflicts() {
  const target = document.getElementById('pl-conflict');
  if (!target) return;
  const fill = pattern => {
    const values = { cid: '42', mid: '42', slug: 'sample', category: 'sample-category', year: '2026', month: '10', day: '20' };
    return pattern.replace(/\{([^{}]+)\}/g, (token, key) => values[key] || token);
  };
  const patterns = PERMALINK_GROUPS.map(group => ({ key: group.key, pattern: fill(permalinkPicked(group.key)) }));
  const conflicts = [];
  for (let left = 0; left < patterns.length; left++) for (let right = left + 1; right < patterns.length; right++) {
    if (patterns[left].pattern && patterns[left].pattern === patterns[right].pattern) conflicts.push(patterns[left].key + ' 与 ' + patterns[right].key);
  }
  target.textContent = conflicts.length ? '路径模板可能互相遮蔽：' + conflicts.join('、') + '。仍可保存。' : '';
  target.style.display = conflicts.length ? 'block' : 'none';
}
window.saveSettings = async () => {
  const items = [
    { key: 'site_name', value: document.getElementById('s1') ? document.getElementById('s1').value : '' },
    { key: 'site_description', value: document.getElementById('s2') ? document.getElementById('s2').value : '' },
    { key: 'site_url', value: document.getElementById('s3') ? document.getElementById('s3').value : '' },
    { key: 'posts_per_page', value: document.getElementById('s4') ? document.getElementById('s4').value : '' },
    { key: 'allow_register', value: document.getElementById('s6') ? document.getElementById('s6').value : '' },
    { key: 'comment_moderation', value: document.getElementById('s7') ? document.getElementById('s7').value : '' },
    { key: 'permalink', value: permalinkPicked('post') },
    { key: 'page_pattern', value: permalinkPicked('page') },
    { key: 'comment_display', value: document.getElementById('s9') ? document.getElementById('s9').value : '' },
    { key: 'comments_disabled', value: document.getElementById('s10') ? document.getElementById('s10').value : '' },
    { key: 'comments_per_page', value: document.getElementById('s11') ? document.getElementById('s11').value : '' },
    { key: 'excerpt_length', value: document.getElementById('s12') ? document.getElementById('s12').value : '' },
    { key: 'excerpt_type', value: document.getElementById('s13') ? document.getElementById('s13').value : '' },
    { key: 'posts_order', value: document.getElementById('s14') ? document.getElementById('s14').value : '' },
    { key: 'category_prefix', value: permalinkPicked('category') },
    { key: 'tag_prefix', value: permalinkPicked('tag') },
    ...BUILTIN_PATHS.map(item => ({ key: item.key, value: document.getElementById(item.key)?.value.trim() || '' })),
  ];
  for (const group of PERMALINK_GROUPS) {
    if (!permalinkPicked(group.key)) return toast(group.label + '不能为空', 'error');
  }
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
    for (const h of header) t += '<th scope="col">' + h + '</th>';
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
    if (!box || !section) return;
    const items = Array.isArray(menus) ? menus : [];
    box.innerHTML = items.map(m => {
      const icon = m.icon || '🔌';
      const url = m.url ? ' data-url="' + escape(m.url) + '"' : '';
      const pageAttr = m.url ? '' : ' data-page="' + escape(m.page || ('plugin:' + m.id)) + '"';
      return '<a href="#" class="menu-item"' + url + pageAttr + '><span aria-hidden="true">' + escape(icon) + '</span><span>' + escape(m.title || m.id) + '</span></a>';
    }).join('');
    section.style.display = items.length ? '' : 'none';
  } catch (e) { /* 插件菜单加载失败不影响后台 */ }
}
document.getElementById('logout-btn').onclick = () => { stopSystemPolling(); localStorage.removeItem('lill_token'); location.href = '/admin/login'; };
if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', stopSystemPolling);

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
  selectedPlugins.clear();
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
    return '<tr><td><input type="checkbox" aria-label="选择插件" class="plugin-check" value="' + escape(p.dir) + '" onchange="togglePluginCheck(this.value, this.checked)"></td><td><strong>' + escape(p.name || p.dir) + '</strong><br><small style="color:#64748b">' + escape(p.dir) + '</small></td>'
      + '<td>' + escape(p.version || '-') + '</td>'
      + '<td>' + escape(p.description || '-') + (p.author ? '<br><small style="color:#94a3b8">作者：' + escape(p.author) + '</small>' : '') + '</td>'
      + '<td><span class="badge ' + (p.active ? 'badge-success' : 'badge-secondary') + '">' + (p.active ? '已启用' : '未启用') + '</span></td>'
      + '<td class="actions">' + actions + '</td></tr>';
  }).join('');

  const hint = '<div class="card" style="margin-bottom:16px"><p style="margin:0;color:#64748b;font-size:13px">'
    + '插件包为 ZIP，内部结构为 <code>&lt;插件目录&gt;/plugin.json</code> + <code>&lt;插件目录&gt;/index.js</code>，'
    + '入口需导出 <code>activate(ctx)</code> 与 <code>deactivate(ctx)</code>。详见 <code>docs/插件开发指南.md</code>。</p></div>';

  document.getElementById('content').innerHTML = hint
    + '<div class="toolbar"><label class="mobile-batch-select"><input type="checkbox" onchange="toggleAllPlugins(this.checked)"> 选择本页插件</label></div><div id="plugin-selection"></div><div class="table-container"><table><thead><tr><th scope="col"><input aria-label="选择本页插件" type="checkbox" onchange="toggleAllPlugins(this.checked)"></th><th scope="col">名称</th><th scope="col">版本</th><th scope="col">描述</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="6"><div class="empty">暂无插件，点击右上角上传安装</div></td></tr>')
    + '</tbody></table></div>';
  labelTableRows();
  updatePluginSelection();
}
function updatePluginSelection() {
  const bar = document.getElementById('plugin-selection');
  if (!bar) return;
  const checks = [...document.querySelectorAll('.plugin-check')];
  checks.forEach(el => { el.checked = selectedPlugins.has(el.value); });
  const count = checks.filter(el => el.checked).length;
  document.querySelectorAll('input[onchange="toggleAllPlugins(this.checked)"]').forEach(el => {
    el.checked = checks.length > 0 && count === checks.length;
    el.indeterminate = count > 0 && count < checks.length;
  });
  bar.innerHTML = selectedPlugins.size ? '<div class="batch-bar" role="group" aria-label="批量操作"><span aria-live="polite">已选 ' + selectedPlugins.size + ' 项</span><button class="btn btn-sm btn-outline" onclick="batchPlugins(\'activate\')">批量启用</button><button class="btn btn-sm btn-outline" onclick="batchPlugins(\'deactivate\')">批量禁用</button><button class="btn btn-sm btn-danger" onclick="batchPlugins(\'uninstall\')">批量卸载</button><button class="btn btn-sm btn-outline" onclick="clearPluginSelection()">取消选择</button></div>' : '';
}
window.togglePluginCheck = (dir, checked) => { if (checked) selectedPlugins.add(dir); else selectedPlugins.delete(dir); updatePluginSelection(); };
window.toggleAllPlugins = checked => { if (checked) document.querySelectorAll('.plugin-check').forEach(el => selectedPlugins.add(el.value)); else selectedPlugins.clear(); updatePluginSelection(); };
window.clearPluginSelection = () => { selectedPlugins.clear(); updatePluginSelection(); };
window.batchPlugins = async action => {
  const view = activeView;
  const dirs = [...selectedPlugins];
  if (!dirs.length) return toast('请先选择插件', 'error');
  if (action === 'uninstall' && !confirm('确定卸载选中的 ' + dirs.length + ' 个插件？目录会移动到回收区。')) return;
  try {
    const result = await api('/admin/plugins/batch', { method: 'POST', body: { dirs, action } });
    toast(result.skipped.length ? '完成 ' + result.updated.length + ' 项，跳过 ' + result.skipped.length + ' 项' : '操作完成，共 ' + result.updated.length + ' 项');
    selectedPlugins.clear();
    await loadPluginMenus();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};
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
    await loadPluginMenus();
    refreshView(view);
  } catch (e) { toast(e.message, 'error'); }
};

window.uninstallPlugin = async (dir, name) => {
  if (!confirm('确定卸载插件「' + name + '」？目录会移动到回收区，可手动恢复。')) return;
  const view = activeView;
  try {
    await api('/admin/plugins/' + encodeURIComponent(dir), { method: 'DELETE' });
    toast('插件已卸载');
    await loadPluginMenus();
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
    await loadPluginMenus();
    refreshView(view);
  } catch (e) {
    toast(e.message || '安装失败', 'error');
    input.value = '';
  }
};
