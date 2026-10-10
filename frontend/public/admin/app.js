let user = null;
let page = 'dashboard';
let pageNum = 1;

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

function escape(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function fmt(d) { if (!d) return '-'; const x = new Date(d.replace ? d.replace(' ', 'T') + 'Z' : d); if (isNaN(x)) return '-'; return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
function statusLabel(s) {
  const m = { published: ['已发布', 'green'], draft: ['草稿', 'gray'], pending: ['待审核', 'orange'], trash: ['回收站', 'red'], approved: ['已通过', 'green'], spam: ['垃圾', 'red'], active: ['正常', 'green'], banned: ['禁用', 'red'] };
  const t = m[s] || [s || '-', 'gray'];
  return '<span class="tag tag-' + t[1] + '">' + t[0] + '</span>';
}
function roleLabel(r) {
  const m = { admin: '管理员', editor: '编辑', author: '作者', contributor: '投稿者', subscriber: '订阅者' };
  return m[r] || r;
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
async function render() {
  // 切换页面时取消上一页未完成的 GET 请求，避免竞态与"永久转圈"
  window.lillAPI.newRenderScope();
  document.getElementById('page-title').textContent = TITLES[page] || '';
  setTopbar('');
  const c = document.getElementById('content');
  c.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
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
        if (page.startsWith('plugin:')) return renderPluginMenuPanel(page.slice(7));
        c.innerHTML = '<div class="empty">页面不存在</div>';
    }
  } catch (e) {
    // 被新页面取代而取消的请求：静默忽略，交给新页面渲染
    if (e && e.message === '请求已取消') return;
    c.innerHTML = '<div class="card"><p style="color:#ef4444">加载失败：' + escape(e.message) + '</p><button class="btn btn-outline" onclick="render()">重试</button></div>';
  }
}

// ═══ 控制台 ═══
async function renderDashboard() {
  const [stats, sys, recentPosts, recentComments] = await Promise.all([
    api('/admin/stats/dashboard'),
    api('/admin/stats/system'),
    api('/admin/posts/recent'),
    api('/admin/comments/recent')
  ]);
  const o = stats.overview || {};
  let html = '<div class="stats-grid">' +
    sc('📝', o.postCount || 0, '文章') + sc('📄', o.pageCount || 0, '页面') + sc('💬', o.commentCount || 0, '评论') +
    sc('⏳', o.pendingCommentCount || 0, '待审评论') + sc('👥', o.userCount || 0, '用户') +
    '</div>';
  
  // 系统信息
  html += '<div class="card"><h3 class="card-title">系统信息</h3><div class="info-grid">' +
    '<div class="info-item"><span class="info-label">lill 版本</span><span class="info-value">v2.0.0</span></div>' +
    '<div class="info-item"><span class="info-label">Node.js</span><span class="info-value">' + escape(sys.nodeVersion || '-') + '</span></div>' +
    '<div class="info-item"><span class="info-label">SQLite</span><span class="info-value">' + escape(sys.dbVersion || '-') + '</span></div>' +
    '<div class="info-item"><span class="info-label">运行时间</span><span class="info-value">' + Math.floor((sys.uptime || 0) / 3600) + ' 小时</span></div>' +
    '<div class="info-item"><span class="info-label">平台</span><span class="info-value">' + escape(sys.platform || '-') + '</span></div>' +
    '</div></div>';

  // 关于 lill（系统标准 / 品牌标识）
  html += '<div class="card"><h3 class="card-title">关于 lill</h3><div class="about-lill">' +
    '<img src="/logo.svg" alt="lill" class="about-logo">' +
    '<div class="about-info">' +
    '<div class="about-name">lill 博客系统 <span class="about-ver">v2.0.0</span></div>' +
    '<div class="about-desc">轻量、可扩展、前后端分离的博客系统。后端 Node.js + SQLite 纯 REST API，前端 Astro 静态站点，主题即模板。</div>' +
    '<div class="about-meta">主题开发规范见 <code>docs/主题开发指南.md</code> · 后台入口 <code>/admin/</code></div>' +
    '</div></div></div>';
  
  // 最近文章
  html += '<div class="card"><h3 class="card-title">最近文章</h3>';
  if (recentPosts && recentPosts.length) {
    html += '<div class="recent-list">' + recentPosts.map(p => 
      '<div class="recent-item"><a href="javascript:void(0)" onclick="openPostEditor(\'post\',\'' + p.id + '\')">' + escape(p.title) + '</a>' +
      '<span class="recent-meta">' + escape(p.author_name || '-') + ' · ' + fmt(p.created_at) + '</span></div>'
    ).join('') + '</div>';
  } else {
    html += '<div class="empty">暂无文章</div>';
  }
  html += '</div>';
  
  // 最近评论
  html += '<div class="card"><h3 class="card-title">最近评论</h3>';
  if (recentComments && recentComments.length) {
    html += '<div class="recent-list">' + recentComments.map(c => 
      '<div class="recent-item"><span class="recent-comment">' + escape((c.content || '').substring(0, 50)) + '</span>' +
      '<span class="recent-meta">' + escape(c.author_name || '匿名') + ' · ' + fmt(c.created_at) + '</span></div>'
    ).join('') + '</div>';
  } else {
    html += '<div class="empty">暂无评论</div>';
  }
  html += '</div>';
  
  // 快捷操作
  html += '<div class="card"><h3 class="card-title">快捷操作</h3><div class="toolbar">' +
    '<button class="btn btn-primary" onclick="openPostEditor(\'post\')">+ 写文章</button>' +
    '<button class="btn btn-outline" onclick="openPostEditor(\'page\')">+ 新建页面</button>' +
    '<button class="btn btn-outline" onclick="page=\'media\';render()">上传附件</button>' +
    '<a class="btn btn-outline" href="/" target="_blank">查看站点</a>' +
    '</div></div>';
  
  document.getElementById('content').innerHTML = html;
}
function sc(icon, val, label) {
  return '<div class="stat-card"><div class="stat-icon">' + icon + '</div><div class="stat-value">' + val + '</div><div class="stat-label">' + label + '</div></div>';
}

// ═══ 文章 / 页面 ═══
window.openPostEditor = async (type, id) => {
  type = type || 'post';
  let post = null;
  if (id) { try { post = await api('/admin/posts/' + id); } catch (e) { return toast(e.message, 'error'); } }
  let cats = [];
  try { cats = await api('/admin/categories'); } catch (e) { cats = []; }
  // 独立页面模板（对标 Typecho 页面编辑里的「自定义模板」下拉）
  let pageTpls = [];
  if (type === 'page') {
    try { const r = await api('/admin/page-templates'); pageTpls = (r && r.templates) || []; } catch (e) { pageTpls = []; }
  }
  const curTpl = post ? (post.template || '') : '';
  const tplOpts = ['<option value=""' + (curTpl ? '' : ' selected') + '>默认模板（page.html）</option>']
    .concat(pageTpls.map(t => '<option value="' + escape(t.key) + '"' + (curTpl === t.key ? ' selected' : '') + '>' + escape(t.name) + '（' + escape(t.file) + '）</option>'))
    .join('');
  // 与 Typecho 一致：主题里没有 page-*.html 时不显示「页面模板」下拉
  const tplGroup = (type === 'page' && pageTpls.length)
    ? '<div class="form-group"><label>页面模板</label><select id="pe-template">' + tplOpts + '</select></div>'
    : '';
  const catOpts = ['<option value="">无分类</option>'].concat((cats || []).map(c => '<option value="' + c.id + '"' + (post && post.category_id === c.id ? ' selected' : '') + '>' + escape(c.name) + '</option>')).join('');
  const st = post ? post.status : 'published';
  const statusOpts = [['draft', '草稿'], ['published', '发布'], ['pending', '待审核']].map(x => '<option value="' + x[0] + '"' + (st === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  const tagStr = post && post.tags ? post.tags.map(t => t.name).join(',') : '';
  setTopbar('<button class="btn btn-outline" onclick="page=\'' + (type === 'page' ? 'pages' : 'posts') + '\';render()">← 返回列表</button>');
  document.getElementById('page-title').textContent = (id ? '编辑' : '新建') + (type === 'page' ? '页面' : '文章');
  document.getElementById('content').innerHTML = '<div class="card">' +
    '<div class="form-group"><label>标题</label><input id="pe-title" placeholder="请输入标题" value="' + escape(post ? post.title : '') + '"></div>' +
    '<div class="editor-wrap"><div class="editor-pane"><textarea id="pe-content" placeholder="Markdown 内容...">' + escape(post ? post.content : '') + '</textarea></div><div class="preview-pane" id="pe-preview"></div></div>' +
    '<div class="form-row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px">' +
    '<div class="form-group"><label>状态</label><select id="pe-status">' + statusOpts + '</select></div>' +
    '<div class="form-group"><label>分类</label><select id="pe-cat">' + catOpts + '</select></div>' +
    '<div class="form-group"><label>标签（逗号分隔）</label><input id="pe-tags" value="' + escape(tagStr) + '" placeholder="tag1,tag2"></div>' +
    tplGroup +
    '</div>' +
    '<div class="form-group"><label>摘要（可选）</label><textarea id="pe-excerpt" rows="2" placeholder="留空自动截取">' + escape(post ? post.excerpt : '') + '</textarea></div>' +
    '<button class="btn btn-primary" onclick="savePost(\'' + type + '\',' + (id ? '\'' + id + '\'' : 'null') + ')">' + (id ? '更新' : '保存') + '</button></div>';
  const ta = document.getElementById('pe-content');
  const pv = document.getElementById('pe-preview');
  pv.innerHTML = mdToHtml(ta.value);
  ta.oninput = () => { pv.innerHTML = mdToHtml(ta.value); };
};

window.savePost = async (type, id) => {
  const title = document.getElementById('pe-title').value.trim();
  const content = document.getElementById('pe-content').value;
  if (!title) return toast('请填写标题', 'error');
  const tagNames = document.getElementById('pe-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  const body = { title, content, status: document.getElementById('pe-status').value, type, categoryId: document.getElementById('pe-cat').value || null, excerpt: document.getElementById('pe-excerpt').value || null, tagNames };
  // 仅当页面模板下拉存在时才提交 template，避免误清空已有设置
  if (type === 'page') { const tsel = document.getElementById('pe-template'); if (tsel) body.template = tsel.value; }
  try {
    if (id) await api('/admin/posts/' + id, { method: 'PUT', body });
    else await api('/admin/posts', { method: 'POST', body });
    toast(id ? '已更新' : '已保存');
    page = type === 'page' ? 'pages' : 'posts'; pageNum = 1; render();
  } catch (e) { toast(e.message, 'error'); }
};

window.delPost = async (id) => { if (!confirm('确定删除？')) return; try { await api('/admin/posts/' + id, { method: 'DELETE' }); toast('已删除'); render(); } catch (e) { toast(e.message, 'error'); } };

// ═══ 文章列表 ═══
async function renderPosts() {
  const r = await api('/admin/posts?page=' + pageNum + '&pageSize=20');
  const rows = (r.items || []).map(p => '<tr><td><input type="checkbox" class="post-check" value="' + p.id + '"></td><td><strong>' + escape(p.title) + '</strong><br><small style="color:#64748b">' + escape(p.slug) + '</small></td><td>' + escape(p.category_name || '-') + '</td><td>' + statusLabel(p.status) + '</td><td>' + (p.comment_count || 0) + '</td><td>' + (p.view_count || 0) + '</td><td>' + fmt(p.created_at) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openPostEditor(\'' + p.type + '\',\'' + p.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delPost(\'' + p.id + '\')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openPostEditor(\'post\')">+ 写文章</button>');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th><input type="checkbox" onchange="toggleAllPosts(this.checked)"></th><th>标题</th><th>分类</th><th>状态</th><th>评论</th><th>浏览</th><th>日期</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8"><div class="empty">暂无文章</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
}

window.toggleAllPosts = (checked) => { document.querySelectorAll('.post-check').forEach(c => c.checked = checked); };
window.batchPosts = async (action) => {
  const ids = Array.from(document.querySelectorAll('.post-check:checked')).map(c => c.value);
  if (!ids.length) return toast('请先选择文章', 'error');
  if (action === 'delete' && !confirm('确定删除选中的文章？')) return;
  try {
    await api('/admin/posts/batch', { method: 'POST', body: { ids, action } });
    toast('操作完成'); renderPosts();
  } catch (e) { toast(e.message, 'error'); }
};

// ═══ 页面列表 ═══
async function renderPages() {
  const r = await api('/admin/pages?page=' + pageNum + '&pageSize=20');
  const rows = (r.items || []).map(p => '<tr><td><strong>' + escape(p.title) + '</strong><br><small style="color:#64748b">' + escape(p.slug) + '</small></td><td>' + statusLabel(p.status) + '</td><td>' + (p.view_count || 0) + '</td><td>' + fmt(p.created_at) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openPostEditor(\'page\',\'' + p.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delPost(\'' + p.id + '\')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openPostEditor(\'page\')">+ 新建页面</button>');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>标题</th><th>状态</th><th>浏览</th><th>日期</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5"><div class="empty">暂无页面</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
}

// ═══ 操作日志 ═══
async function renderLogs() {
  const r = await api('/admin/logs?page=' + pageNum + '&pageSize=20');
  const rows = (r.items || []).map(l => '<tr><td>' + fmt(l.created_at) + '</td><td>' + escape(l.username || '-') + '</td><td><code>' + escape(l.action) + '</code></td><td>' + escape(l.detail || '-') + '</td><td>' + escape(l.ip || '-') + '</td></tr>').join('');
  setTopbar('<button class="btn btn-danger" onclick="clearLogs()">清空日志</button>');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th><th>IP</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5"><div class="empty">暂无日志</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
}

window.clearLogs = async () => {
  if (!confirm('确定清空所有日志？')) return;
  try { await api('/admin/logs', { method: 'DELETE' }); toast('已清空'); renderLogs(); } catch (e) { toast(e.message, 'error'); }
};

// ═══ 备份 ═══
async function renderBackup() {
  setTopbar('<button class="btn btn-primary" onclick="createBackup()">+ 创建备份</button>');
  document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">数据库备份</h3><p style="color:#64748b;margin-bottom:16px">创建当前数据库的完整备份文件。</p><button class="btn btn-primary" onclick="createBackup()">立即创建备份</button></div>';
}

window.createBackup = async () => {
  const btn = document.querySelector('button[onclick="createBackup()"]');
  if (btn) { btn.disabled = true; btn.textContent = '备份中...'; }
  try { const r = await api('/admin/backup', { method: 'POST' }); toast('备份成功: ' + r.path); } catch (e) { toast(e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '立即创建备份'; } }
};

// ═══ 分类 ═══
async function renderCategories() {
  const r = await api('/admin/categories');
  const rows = (r || []).map(c => '<tr><td><strong>' + escape(c.name) + '</strong></td><td><code>' + escape(c.slug) + '</code></td><td>' + escape(c.description || '-') + '</td><td>' + (c.parent_name ? escape(c.parent_name) : '-') + '</td><td>' + (c.post_count || 0) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openCatEditor(\'' + c.id + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delCat(\'' + c.id + '\')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openCatEditor()">+ 新建分类</button>');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>名称</th><th>别名</th><th>描述</th><th>父级</th><th>文章数</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6"><div class="empty">暂无分类</div></td></tr>') + '</tbody></table></div>';
}

window.openCatEditor = async (id) => {
  let cat = null, cats = [];
  try { cats = await api('/admin/categories'); } catch (e) {}
  if (id) cat = (cats || []).find(c => c.id === id);
  const parentOpts = ['<option value="">无父级</option>'].concat((cats || []).filter(c => c.id !== id).map(c => '<option value="' + c.id + '"' + (cat && cat.parent_id === c.id ? ' selected' : '') + '>' + escape(c.name) + '</option>')).join('');
  document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">' + (id ? '编辑分类' : '新建分类') + '</h3>' +
    '<div class="form-group"><label>名称</label><input id="ce-name" value="' + escape(cat ? cat.name : '') + '"></div>' +
    '<div class="form-group"><label>别名（留空自动生成）</label><input id="ce-slug" value="' + escape(cat ? cat.slug : '') + '"></div>' +
    '<div class="form-group"><label>描述</label><textarea id="ce-desc" rows="2">' + escape(cat ? cat.description : '') + '</textarea></div>' +
    '<div class="form-group"><label>父级分类</label><select id="ce-parent">' + parentOpts + '</select></div>' +
    '<div class="form-group"><label>排序</label><input id="ce-sort" type="number" value="' + (cat ? cat.sort_order : 0) + '"></div>' +
    '<button class="btn btn-primary" onclick="saveCat(' + (id ? '\'' + id + '\'' : 'null') + ')">保存</button> <button class="btn btn-outline" onclick="renderCategories()">取消</button></div>';
};

window.saveCat = async (id) => {
  const name = document.getElementById('ce-name').value.trim();
  if (!name) return toast('请填写名称', 'error');
  const body = { name, slug: document.getElementById('ce-slug').value.trim() || undefined, description: document.getElementById('ce-desc').value, parentId: document.getElementById('ce-parent').value || null, sortOrder: parseInt(document.getElementById('ce-sort').value) || 0 };
  try {
    if (id) await api('/admin/categories/' + id, { method: 'PUT', body });
    else await api('/admin/categories', { method: 'POST', body });
    toast('已保存'); renderCategories();
  } catch (e) { toast(e.message, 'error'); }
};

window.delCat = async (id) => { if (!confirm('确定删除？该分类下的文章将变为未分类')) return; try { await api('/admin/categories/' + id, { method: 'DELETE' }); toast('已删除'); renderCategories(); } catch (e) { toast(e.message, 'error'); } };

// ═══ 标签 ═══
async function renderTags() {
  const r = await api('/admin/tags?pageSize=100&page=' + pageNum);
  const rows = (r.items || []).map(t => '<tr><td><strong>' + escape(t.name) + '</strong></td><td><code>' + escape(t.slug) + '</code></td><td>' + (t.post_count || 0) + '</td><td class="actions"><button class="btn btn-sm btn-outline" onclick="openTagEditor(\'' + t.id + '\',\'' + escape(t.name) + '\')">编辑</button> <button class="btn btn-sm btn-danger" onclick="delTag(\'' + t.id + '\')">删除</button></td></tr>').join('');
  setTopbar('<button class="btn btn-primary" onclick="openTagEditor()">+ 新建标签</button>');
  document.getElementById('content').innerHTML = '<div class="table-container"><table><thead><tr><th>名称</th><th>别名</th><th>文章数</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="4"><div class="empty">暂无标签</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
}
window.openTagEditor = (id, name) => {
  const n = prompt('标签名称：', name || '');
  if (!n) return;
  (async () => {
    try {
      if (id) await api('/admin/tags/' + id, { method: 'PUT', body: { name: n } });
      else await api('/admin/tags', { method: 'POST', body: { name: n } });
      toast('已保存'); renderTags();
    } catch (e) { toast(e.message, 'error'); }
  })();
};
window.delTag = async (id) => { if (!confirm('确定删除？')) return; try { await api('/admin/tags/' + id, { method: 'DELETE' }); toast('已删除'); renderTags(); } catch (e) { toast(e.message, 'error'); } };

// ═══ 评论 ═══
let selectedComments = new Set();

async function renderComments() {
  const sel = document.getElementById('cf-status');
  const status = sel ? sel.value : '';
  const r = await api('/admin/comments?page=' + pageNum + '&pageSize=20' + (status ? '&status=' + status : ''));
  const rows = (r.items || []).map(c => '<tr><td><input type="checkbox" class="cmt-check" value="' + c.id + '" ' + (selectedComments.has(c.id) ? 'checked' : '') + ' onchange="toggleCmtCheck(\'' + c.id + '\', this.checked)"> ' + escape((c.content || '').substring(0, 50)) + '</td><td>' + escape(c.post_title || '-') + '</td><td>' + escape(c.author_name || c.username || '匿名') + '</td><td>' + statusLabel(c.status) + '</td><td>' + fmt(c.created_at) + '</td><td class="actions">' +
    (c.status !== 'approved' ? '<button class="btn btn-sm btn-outline" onclick="setCmt(\'' + c.id + '\',\'approved\')">通过</button> ' : '') +
    (c.status !== 'spam' ? '<button class="btn btn-sm btn-outline" onclick="setCmt(\'' + c.id + '\',\'spam\')">垃圾</button> ' : '') +
    '<button class="btn btn-sm btn-outline" onclick="replyCmt(\'' + c.id + '\')">回复</button> ' +
    '<button class="btn btn-sm btn-outline" onclick="editCmt(\'' + c.id + '\')">编辑</button> ' +
    '<button class="btn btn-sm btn-danger" onclick="delCmt(\'' + c.id + '\')">删除</button></td></tr>').join('');
  
  const batchBar = selectedComments.size > 0 ? '<div class="batch-bar"><span>已选 ' + selectedComments.size + ' 项</span><button class="btn btn-sm btn-outline" onclick="batchCmtStatus(\'approved\')">批量通过</button><button class="btn btn-sm btn-outline" onclick="batchCmtStatus(\'spam\')">批量垃圾</button><button class="btn btn-sm btn-danger" onclick="batchCmtDelete()">批量删除</button><button class="btn btn-sm btn-outline" onclick="clearCmtSelection()">取消选择</button></div>' : '';
  
  setTopbar('');
  document.getElementById('content').innerHTML =
    '<div class="toolbar"><select id="cf-status" onchange="gotoPage(1)">' +
    ['', 'pending', 'approved', 'spam'].map(v => '<option value="' + v + '"' + (status === v ? ' selected' : '') + '>' + ({ '': '所有状态', pending: '待审核', approved: '已通过', spam: '垃圾' }[v]) + '</option>').join('') +
    '</select></div>' + batchBar +
    '<div class="table-container"><table><thead><tr><th><input type="checkbox" onchange="toggleAllCmts(this.checked)"></th><th>内容</th><th>文章</th><th>作者</th><th>状态</th><th>日期</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty">暂无评论</div></td></tr>') + '</tbody></table></div>' + paginate(r.meta);
}
window.setCmt = async (id, status) => { try { await api('/admin/comments/' + id + '/status', { method: 'PATCH', body: { status } }); toast('已更新'); renderComments(); } catch (e) { toast(e.message, 'error'); } };
window.delCmt = async (id) => { if (!confirm('确定删除？')) return; try { await api('/admin/comments/' + id, { method: 'DELETE' }); toast('已删除'); renderComments(); } catch (e) { toast(e.message, 'error'); } };
window.toggleCmtCheck = (id, checked) => { if (checked) selectedComments.add(id); else selectedComments.delete(id); renderComments(); };
window.toggleAllCmts = (checked) => { 
  if (checked) { document.querySelectorAll('.cmt-check').forEach(el => selectedComments.add(el.value)); }
  else { selectedComments.clear(); }
  renderComments();
};
window.clearCmtSelection = () => { selectedComments.clear(); renderComments(); };
window.batchCmtStatus = async (status) => {
  if (!selectedComments.size) return;
  try {
    await api('/admin/comments/batch-status', { method: 'PATCH', body: { ids: Array.from(selectedComments), status } });
    toast('操作完成'); selectedComments.clear(); renderComments();
  } catch (e) { toast(e.message, 'error'); }
};
window.batchCmtDelete = async () => {
  if (!selectedComments.size) return;
  if (!confirm('确定删除选中的 ' + selectedComments.size + ' 条评论？')) return;
  try {
    for (const id of selectedComments) { await api('/admin/comments/' + id, { method: 'DELETE' }); }
    toast('已删除'); selectedComments.clear(); renderComments();
  } catch (e) { toast(e.message, 'error'); }
};
window.replyCmt = async (id) => {
  const c = (await api('/admin/comments?pageSize=100')).items.find(x => x.id === id);
  if (!c) return toast('评论不存在', 'error');
  const content = prompt('回复 ' + (c.author_name || '匿名') + '：', '');
  if (!content) return;
  try {
    await api('/admin/comments/' + id + '/reply', { method: 'POST', body: { content } });
    toast('已回复'); renderComments();
  } catch (e) { toast(e.message, 'error'); }
};
window.editCmt = async (id) => {
  const c = (await api('/admin/comments?pageSize=100')).items.find(x => x.id === id);
  if (!c) return toast('评论不存在', 'error');
  const content = prompt('编辑评论：', c.content || '');
  if (!content) return;
  try {
    await api('/admin/comments/' + id, { method: 'PUT', body: { content } });
    toast('已更新'); renderComments();
  } catch (e) { toast(e.message, 'error'); }
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
    renderMedia();
  } catch (e) { toast(e.message, 'error'); }
}
window.uploadMedia = () => {
  const el = document.getElementById('media-file-input');
  if (el) el.click();
};
window.delMedia = async (id) => { if (!confirm('确定删除？')) return; try { await api('/admin/media/' + id, { method: 'DELETE' }); toast('已删除'); renderMedia(); } catch (e) { toast(e.message, 'error'); } };

// ═══ 外观（Typecho 模式：主题列表 → 选主题 → 专属设置页） ═══
let currentThemeId = null;

async function renderThemes() {
  currentThemeId = null;
  const themes = await api('/admin/themes');
  let html = '<div class="card"><h3 class="card-title">主题</h3><div class="theme-grid">';
  if (themes.length) themes.forEach(t => {
    var screenshot = t.screenshot ? '<img src="' + escape(t.screenshot) + '" alt="" loading="lazy">' : '🎨';
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
    renderThemes();
  } catch (e) {
    if (msg) msg.textContent = '';
    toast(e.message || '安装失败', 'error');
    input.value = '';
  }
};

window.activateTheme = async (themeId) => { try { await api('/admin/themes/' + encodeURIComponent(themeId) + '/activate', { method: 'POST' }); toast('已切换主题'); renderThemes(); } catch (e) { toast(e.message, 'error'); } };

window.openThemeSettings = async (themeId) => {
  currentThemeId = themeId;
  const r = await api('/admin/themes/' + encodeURIComponent(themeId) + '/settings');
  const theme = r.theme || {};
  const schema = r.schema || [];
  const values = r.values || {};

  let html = '<div class="card"><h3 class="card-title">主题设置 — ' + escape(theme.name || themeId) + '</h3>';
  if (!schema.length) {
    html += '<div class="empty">该主题没有可配置的选项</div>';
  } else {
    // 按 group 分组渲染（对标 Typecho / WP 的主题设置面板）
    const groups = [], groupMap = {};
    schema.forEach(f => {
      const g = f.group || '常规';
      if (!groupMap[g]) { groupMap[g] = []; groups.push(g); }
      groupMap[g].push(f);
    });
    groups.forEach(g => {
      html += '<div class="settings-group"><h4 class="settings-group-title">' + escape(g) + '</h4>';
      groupMap[g].forEach(f => {
        const v = values[f.key] !== undefined ? values[f.key] : (f.default !== undefined ? f.default : '');
        const id = 'ts_' + f.key;
        html += '<div class="form-group"><label>' + escape(f.label || f.key) + '</label>';
        if (f.type === 'color') {
          html += '<input type="color" id="' + id + '" value="' + escape(v) + '">';
        } else if (f.type === 'select') {
          html += '<select id="' + id + '">' + (f.options || []).map(o => '<option value="' + escape(o.value) + '"' + (v === o.value ? ' selected' : '') + '>' + escape(o.label) + '</option>').join('') + '</select>';
        } else if (f.type === 'textarea') {
          html += '<textarea id="' + id + '" rows="3">' + escape(v) + '</textarea>';
        } else if (f.type === 'checkbox') {
          html += '<label style="display:flex;align-items:center;gap:8px;font-weight:normal"><input type="checkbox" id="' + id + '" style="width:auto"' + (v === 'true' || v === true ? ' checked' : '') + '> 启用</label>';
        } else if (f.type === 'number') {
          html += '<input type="number" id="' + id + '" value="' + escape(v) + '">';
        } else {
          html += '<input type="text" id="' + id + '" value="' + escape(v) + '">';
        }
        html += '</div>';
      });
      html += '</div>';
    });
    html += '<button class="btn btn-primary" onclick="saveThemeSettings(\'' + escape(themeId) + '\')">保存设置</button>';
  }
  html += '<div style="margin-top:12px"><button class="btn btn-outline" onclick="renderThemes()">← 返回主题列表</button></div></div>';
  setTopbar('');
  document.getElementById('content').innerHTML = html;
};

window.saveThemeSettings = async (themeId) => {
  // 直接从 DOM 读取 schema（避免重复 GET 请求）
  const body = {};
  document.querySelectorAll('[data-ts-key]').forEach(el => {
    const key = el.getAttribute('data-ts-key');
    if (el.type === 'checkbox') body[key] = el.checked ? 'true' : 'false';
    else body[key] = el.value;
  });
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
}
window.openUserEditor = async (id) => {
  let u = null;
  if (id) { try { const r = await api('/admin/users?pageSize=100'); u = (r.items || []).find(x => x.id === id); } catch (e) {} }
  const roleOpts = [['admin', '管理员'], ['editor', '编辑'], ['author', '作者'], ['contributor', '投稿者'], ['subscriber', '订阅者']].map(x => '<option value="' + x[0] + '"' + (u && u.role === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  const statusOpts = [['active', '正常'], ['banned', '禁用']].map(x => '<option value="' + x[0] + '"' + (u && u.status === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('');
  setTopbar('<button class="btn btn-outline" onclick="renderUsers()">← 返回</button>');
  document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">' + (id ? '编辑用户' : '新建用户') + '</h3>' +
    '<div class="form-group"><label>用户名</label><input id="ue-name" value="' + escape(u ? u.username : '') + '"' + (id ? ' disabled' : '') + '></div>' +
    '<div class="form-group"><label>昵称</label><input id="ue-nick" value="' + escape(u ? u.nickname : '') + '"></div>' +
    '<div class="form-group"><label>邮箱</label><input id="ue-email" value="' + escape(u ? u.email : '') + '"></div>' +
    '<div class="form-group"><label>密码' + (id ? '（留空不修改）' : '') + '</label><input id="ue-pass" type="password" placeholder="' + (id ? '留空保持不变' : '至少 6 位') + '"></div>' +
    '<div class="form-group"><label>角色</label><select id="ue-role">' + roleOpts + '</select></div>' +
    '<div class="form-group"><label>状态</label><select id="ue-status">' + statusOpts + '</select></div>' +
    '<button class="btn btn-primary" onclick="saveUser(' + (id ? '\'' + id + '\'' : 'null') + ')">保存</button></div>';
};
window.saveUser = async (id) => {
  const body = { username: document.getElementById('ue-name').value.trim(), nickname: document.getElementById('ue-nick').value.trim(), email: document.getElementById('ue-email').value.trim(), role: document.getElementById('ue-role').value, status: document.getElementById('ue-status').value };
  const pass = document.getElementById('ue-pass').value;
  if (pass) body.password = pass;
  if (!body.username && !id) return toast('请填写用户名', 'error');
  try {
    if (id) await api('/admin/users/' + id, { method: 'PUT', body });
    else await api('/admin/users', { method: 'POST', body });
    toast('已保存'); pageNum = 1; renderUsers();
  } catch (e) { toast(e.message, 'error'); }
};
window.delUser = async (id) => { if (!confirm('确定删除该用户？')) return; try { await api('/admin/users/' + id, { method: 'DELETE' }); toast('已删除'); renderUsers(); } catch (e) { toast(e.message, 'error'); } };

// ═══ 设置 ═══
async function renderSettings() {
  const r = await api('/admin/options');
  const o = {}; (r || []).forEach(x => o[x.key] = x.value);
  
  let html = '<div class="settings-tabs">' +
    '<button class="settings-tab active" onclick="switchSettingsTab(\'basic\')">基本</button>' +
    '<button class="settings-tab" onclick="switchSettingsTab(\'comment\')">评论</button>' +
    '<button class="settings-tab" onclick="switchSettingsTab(\'reading\')">阅读</button>' +
    '<button class="settings-tab" onclick="switchSettingsTab(\'permalink\')">永久链接</button>' +
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
window.switchSettingsTab = (tab) => {
  document.querySelectorAll('.settings-tab').forEach(el => el.classList.remove('active'));
  event.target.classList.add('active');
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

function mdToHtml(md) {
  if (!md) return '';
  return '<p>' + md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
}

// ═══ 导航（事件委托，兼容插件动态注入的菜单项）═══
window.gotoPage = (p) => { pageNum = p; render(); };
document.querySelector('.sidebar-menu').addEventListener('click', (ev) => {
  const el = ev.target.closest('.menu-item');
  if (!el) return;
  // 插件菜单若给了 url，则直接跳转，不当作内部页面
  if (el.dataset.url) { location.href = el.dataset.url; return; }
  if (!el.dataset.page) return;
  ev.preventDefault();
  document.querySelectorAll('.menu-item').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  page = el.dataset.page; pageNum = 1; render();
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
      return '<a class="menu-item"' + url + pageAttr + '><span>' + icon + '</span>' + escape(m.title || m.id) + '</a>';
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
    if (user) document.getElementById('user-name').textContent = user.nickname || user.username;
  } catch (e) { authed = false; }
}
if (!authed) {
  document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div><p style="margin-top:12px;color:#64748b">登录已过期，正在跳转登录页…</p></div>';
  location.href = '/admin/login';
} else {
  loadPluginMenus();
  render();
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
    const actions = '<button class="btn btn-sm btn-outline" onclick="togglePlugin(\'' + escape(p.dir) + '\')">' + (p.active ? '禁用' : '启用') + '</button>'
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
}
window.renderPlugins = renderPlugins;

// 插件注册的后台菜单若未提供 url，则渲染一个通用面板（插件可通过 url 指向自定义页面）
function renderPluginMenuPanel(id) {
  setTopbar('');
  document.getElementById('content').innerHTML = '<div class="card"><h3 class="card-title">插件页面</h3>'
    + '<p style="color:#64748b">插件「' + escape(id) + '」注册了后台菜单，但未提供自定义页面地址（url）。</p>'
    + '<p style="color:#64748b">请在插件的 <code>ctx.addAdminMenu({ id, title, icon, order, url })</code> 中指定 <code>url</code>，'
    + '指向插件自己提供的后台页面（例如主题/插件目录下的静态页面）。</p>'
    + '<button class="btn btn-outline" onclick="page=\'plugins\';render()">前往插件管理</button></div>';
}

window.togglePlugin = async (dir) => {
  try {
    const r = await api('/admin/plugins/toggle', { method: 'POST', body: { dir } });
    if (r && r.hot && r.hot !== 'ok') toast('状态已保存，但热加载失败：' + r.hot, 'error');
    else toast(r && r.active ? '插件已启用' : '插件已禁用');
    renderPlugins();
  } catch (e) { toast(e.message, 'error'); }
};

window.uninstallPlugin = async (dir, name) => {
  if (!confirm('确定卸载插件「' + name + '」？目录会移动到回收区，可手动恢复。')) return;
  try {
    await api('/admin/plugins/' + encodeURIComponent(dir), { method: 'DELETE' });
    toast('插件已卸载');
    renderPlugins();
  } catch (e) { toast(e.message, 'error'); }
};

window.uploadPlugin = async (input) => {
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
    renderPlugins();
  } catch (e) {
    toast(e.message || '安装失败', 'error');
    input.value = '';
  }
};
