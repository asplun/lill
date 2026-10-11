/** Shared policy and helpers for management route modules. */
import { scanPageTemplates as scanThemePageTemplates } from '../../lib/themes.js';

/**
 * 在单个事务中执行一组写操作：任一步骤抛错都会整体回滚，避免批量操作只改一半。
 * node:sqlite 的 DatabaseSync 为同步 API，因此回调必须是同步函数。
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 连接已不可用时忽略回滚失败 */ }
    throw err;
  }
}
export function createAdminHelpers(ctx, router, options = {}) {
  const { db, json, uid, slugify, authenticate, THEMES_DIR } = ctx;
  const skipped = options.skip || new Set();
  const contentRoles = ['admin', 'editor', 'author', 'contributor'];
  const editorRoles = ['admin', 'editor'];
  const route = (method, path, fn) => {
    if (skipped.has(method + ':' + path)) return;
    const resource = path.slice('/api/v1/admin/'.length).split('/')[0];
    let roles = ['admin'];
    if (['posts', 'pages', 'page-templates', 'media'].includes(resource)) roles = contentRoles;
    if (['categories', 'tags'].includes(resource)) roles = method === 'GET' ? contentRoles : editorRoles;
    if (resource === 'comments') roles = editorRoles;
    router.route(method, path, fn, { auth: true, roles });
  };
  const managesAll = auth => editorRoles.includes(auth.role);
  const canManagePost = (auth, post) => managesAll(auth) || (post.author_id === auth.id && (auth.role !== 'contributor' || post.status === 'draft'));
  const validatePostWrite = (auth, body) => {
    if (auth.role === 'contributor' && body.status !== undefined && body.status !== 'draft') return '投稿者只能保存草稿';
    if (!managesAll(auth) && Array.isArray(body.tagNames) && body.tagNames.some(name => !db.prepare('SELECT id FROM tags WHERE slug = ?').get(slugify(name)))) return '没有创建标签的权限';
    return null;
  };
  const logAction = (userId, action, detail, req) => {
    try { db.prepare('INSERT INTO logs (id, action, detail, user_id, ip) VALUES (?, ?, ?, ?, ?)').run(uid(), action, detail, userId, req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null); } catch { /* logging must not break the request */ }
  };
  const activeThemeId = () => {
    const theme = db.prepare('SELECT theme_id FROM themes WHERE active = 1').get();
    if (theme?.theme_id) return theme.theme_id;
    const option = db.prepare("SELECT value FROM options WHERE key = 'active_theme'").get();
    return option?.value || 'default';
  };
  const normalizePageTemplate = (type, template) => {
    if (type !== 'page' || !template || !/^page-[\w-]+$/.test(template)) return '';
    return scanThemePageTemplates(activeThemeId(), THEMES_DIR).some(item => item.key === template) ? template : '';
  };
  const listPostsHandler = async (req, res, forcedType) => {
    const auth = await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const pageSize = parseInt(url.searchParams.get('pageSize')) || 20;
    const status = url.searchParams.get('status');
    const type = forcedType || url.searchParams.get('type') || 'post';
    const keyword = url.searchParams.get('keyword');
    const categoryId = url.searchParams.get('categoryId');
    let where = 'WHERE p.type = ?'; const params = [type];
    if (status && status !== 'ALL') { where += ' AND p.status = ?'; params.push(status); }
    if (keyword) { where += ' AND (p.title LIKE ? OR p.content LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
    if (categoryId) { where += ' AND p.category_id = ?'; params.push(categoryId); }
    if (!managesAll(auth)) { where += ' AND p.author_id = ?'; params.push(auth.id); }
    if (auth.role === 'contributor') where += " AND p.status = 'draft'";
    const total = db.prepare(`SELECT COUNT(*) as c FROM posts p ${where}`).get(...params).c;
    const items = db.prepare(`SELECT p.id, p.title, p.slug, p.status, p.view_count, p.comment_count, p.sticky, p.created_at, u.username as author_name, c.name as category_name FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id ${where} ORDER BY p.sticky DESC, p.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
  };
  return { route, managesAll, canManagePost, validatePostWrite, logAction, activeThemeId, normalizePageTemplate, listPostsHandler, contentRoles, editorRoles };
}
