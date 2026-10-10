/**
 * lill 后台 API（全部需要登录）
 * 由 server.js 调用 register(router, ctx) 装配
 */
import { randomBytes } from 'node:crypto';
import { createThumbnailOnUpload } from '../lib/thumbnail.js';
import { writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, statSync, readFileSync, statfsSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { listZipEntries, readZipEntry, safeEntryPath } from '../lib/zip.js';
import { scanPageTemplates } from '../lib/themes.js';

// 主题包中允许落盘的文件类型（其余一律忽略，防止可执行文件混入静态目录）
const THEME_ALLOWED_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.txt', '.md', '.map', '.xml', '.webmanifest']);

export function register(router, ctx) {
  const { db, json, error, parseBody, validators, uid, slugify, renderMD, plainText, authenticate, readThemeManifest, UPLOAD_DIR, THEMES_DIR, PLUGINS_DIR, deactivatePlugin, activatePlugin, loadPlugin, scanPlugins, loadPlugins, triggerHook, _activePlugins, _hooks } = ctx;
  const route = router.route;
  const FRONTEND_DIR = dirname(THEMES_DIR);
  const ROOT_DIR = dirname(FRONTEND_DIR);

  // 操作日志辅助函数
  function logAction(userId, action, detail, req) {
    try {
      db.prepare('INSERT INTO logs (id, action, detail, user_id, ip) VALUES (?, ?, ?, ?, ?)')
        .run(uid(), action, detail, userId, req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null);
    } catch (e) { /* 日志记录失败不影响主流程 */ }
  }

  // 当前启用主题 id（themes 表为准，回退 options.active_theme）
  function activeThemeId() {
    const t = db.prepare('SELECT theme_id FROM themes WHERE active = 1').get();
    if (t && t.theme_id) return t.theme_id;
    const o = db.prepare("SELECT value FROM options WHERE key = 'active_theme'").get();
    return (o && o.value) || 'default';
  }

  // 校验页面模板：仅允许当前主题中真实存在的 page-*.html
  function normalizePageTemplate(type, template) {
    if (type !== 'page' || !template) return '';
    if (!/^page-[\w-]+$/.test(template)) return '';
    const list = scanPageTemplates(activeThemeId(), THEMES_DIR);
    return list.some(t => t.key === template) ? template : '';
  }

const listPostsHandler = async (req, res, forcedType) => {
  const auth = await authenticate(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = parseInt(url.searchParams.get('page')) || 1;
  const ps = parseInt(url.searchParams.get('pageSize')) || 20;
  const status = url.searchParams.get('status');
  const typeFilter = forcedType || url.searchParams.get('type') || 'post';
  const keyword = url.searchParams.get('keyword');
  const categoryId = url.searchParams.get('categoryId');
  let where = 'WHERE p.type = ?'; const params = [typeFilter];
  if (status && status !== 'ALL') { where += ' AND p.status = ?'; params.push(status); }
  if (keyword) { where += ' AND (p.title LIKE ? OR p.content LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (categoryId) { where += ' AND p.category_id = ?'; params.push(categoryId); }
  if (auth.role === 'contributor') { where += ' AND p.author_id = ?'; params.push(auth.id); }
  const total = (db.prepare(`SELECT COUNT(*) as c FROM posts p ${where}`).get(...params)).c;
  const items = db.prepare(`SELECT p.id, p.title, p.slug, p.status, p.view_count, p.comment_count, p.sticky, p.created_at, u.username as author_name, c.name as category_name FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id ${where} ORDER BY p.sticky DESC, p.created_at DESC LIMIT ? OFFSET ?`).all(...params, ps, (page - 1) * ps);
  json(res, { items, meta: { total, page, pageSize: ps, totalPages: Math.ceil(total / ps), hasNext: page * ps < total, hasPrev: page > 1 } });
};

route('GET', '/api/v1/admin/posts', (req, res) => listPostsHandler(req, res), true);

route('GET', '/api/v1/admin/pages', (req, res) => listPostsHandler(req, res, 'page'), true);

// 当前主题可用的「独立页面模板」列表（对标 Typecho 的 page-xxx.php 下拉）
route('GET', '/api/v1/admin/page-templates', async (req, res) => {
  await authenticate(req);
  const themeId = activeThemeId();
  json(res, { theme: themeId, templates: scanPageTemplates(themeId, THEMES_DIR) });
}, true);

route('POST', '/api/v1/admin/posts', async (req, res) => {
  const auth = await authenticate(req);
  const body = await parseBody(req);
  validators.required(body.title, '标题');
  validators.string(body.title, '标题', 200);
  if (body.content) validators.string(body.content, '内容', 50000);
  const id = uid();
  const slug = body.slug || slugify(body.title) + '-' + Date.now().toString(36);
  const status = body.status || 'draft';
  const publishedAt = body.publishedAt || (status === 'published' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null);
  const excerpt = body.excerpt || plainText(body.content || '').substring(0, 200);
  const tpl = normalizePageTemplate(body.type || 'post', body.template);
  db.prepare('INSERT INTO posts (id, title, slug, content, html_content, excerpt, cover_image, type, status, sticky, published_at, author_id, category_id, fields, template) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, body.title, slug, body.content || '', renderMD(body.content || ''), excerpt, body.coverImage || null, body.type || 'post', status, body.sticky ? 1 : 0, publishedAt, auth.id, body.categoryId || null, JSON.stringify(body.fields || {}), tpl);
  if (body.tagNames?.length) { for (const name of body.tagNames) { const ts = slugify(name) || 'tag-' + Date.now().toString(36); let tag = db.prepare('SELECT id FROM tags WHERE slug = ?').get(ts); if (!tag) { const tid = uid(); db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)').run(tid, name, ts); tag = { id: tid }; } db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)').run(id, tag.id); } }
  logAction(auth.id, 'post.create', '创建文章: ' + body.title, req);
  const created = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  try { triggerHook('post.saved', created, { isNew: true }); } catch {}
  json(res, created, 201);
}, true);

route('PUT', '/api/v1/admin/posts/:id', async (req, res, params) => {
  // 保存版本历史
  const oldPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
  if (oldPost) {
    const { uid } = await import('../lib/utils.js');
    db.prepare('INSERT INTO post_versions (id, post_id, title, content, html_content, excerpt, status, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid(), oldPost.id, oldPost.title, oldPost.content, oldPost.html_content, oldPost.excerpt, oldPost.status, oldPost.author_id);
  }
  const auth = await authenticate(req);
  const exist = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
  if (!exist) return error(res, '文章不存在', 404);
  if (auth.role === 'contributor' && exist.author_id !== auth.id) return error(res, '无权限', 403);
  const body = await parseBody(req);
  if (body.title !== undefined) validators.string(body.title, '标题', 200);
  if (body.content !== undefined) validators.string(body.content, '内容', 50000);
  const updates = [], args = [];
  const fields = [['title','title'],['slug','slug'],['content','content'],['excerpt','excerpt'],['coverImage','cover_image'],['type','type'],['status','status'],['sticky','sticky'],['order','"order"'],['publishedAt','published_at'],['categoryId','category_id']];
  if (body.template !== undefined) { updates.push('template = ?'); args.push(normalizePageTemplate(body.type || exist.type, body.template)); }
  for (const [f, d] of fields) { if (body[f] !== undefined) { updates.push(d + ' = ?'); args.push(f === 'sticky' ? (body[f] ? 1 : 0) : body[f]); } }
  if (body.content) updates.push('html_content = ?'), args.push(renderMD(body.content));
  if (body.excerpt === undefined && body.content) updates.push('excerpt = ?'), args.push(plainText(body.content).substring(0, 200));
  if (body.status === 'published' && body.publishedAt === undefined && !exist.published_at) { updates.push('published_at = ?'); args.push(new Date().toISOString().slice(0, 19).replace('T', ' ')); }
  if (body.fields) updates.push('fields = ?'), args.push(JSON.stringify(body.fields));
  if (updates.length) { args.push(params.id); db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`).run(...args); }
  if (body.tagNames !== undefined) { db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(params.id); for (const name of body.tagNames) { const ts = slugify(name) || 'tag-' + Date.now().toString(36); let tag = db.prepare('SELECT id FROM tags WHERE slug = ?').get(ts); if (!tag) { const tid = uid(); db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)').run(tid, name, ts); tag = { id: tid }; } db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)').run(params.id, tag.id); } }
  logAction(auth.id, 'post.update', '更新文章: ' + (body.title || exist.title), req);
  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
  try { triggerHook('post.saved', updated, { isNew: false }); } catch {}
  json(res, updated);
}, true);

route('GET', '/api/v1/admin/posts/:id', async (req, res, params) => {
  await authenticate(req);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
  if (!post) return error(res, '文章不存在', 404);
  const tags = db.prepare('SELECT t.id, t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?').all(params.id);
  json(res, { ...post, tags });
}, true);

route('DELETE', '/api/v1/admin/posts/:id', async (req, res, params) => {
  const auth = await authenticate(req);
  const exist = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
  if (!exist) return error(res, '文章不存在', 404);
  if (auth.role === 'contributor' && exist.author_id !== auth.id) return error(res, '无权限', 403);
  db.prepare('DELETE FROM posts WHERE id = ?').run(params.id);
  logAction(auth.id, 'post.delete', '删除文章: ' + exist.title, req);
  try { triggerHook('post.deleted', exist); } catch {}
  json(res, { id: params.id });
}, true);

route('GET', '/api/v1/admin/categories', async (req, res) => {
  await authenticate(req);
  const items = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM posts WHERE category_id = c.id) as post_count, p.name as parent_name FROM categories c LEFT JOIN categories p ON c.parent_id = p.id ORDER BY c.sort_order, c.name').all();
  json(res, items);
}, true);

route('POST', '/api/v1/admin/categories', async (req, res) => {
  await authenticate(req);
  const body = await parseBody(req);
  validators.required(body.name, '分类名称');
  validators.string(body.name, '分类名称', 100);
  const id = uid();
  db.prepare('INSERT INTO categories (id, name, slug, description, parent_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(id, body.name, body.slug || slugify(body.name), body.description || null, body.parentId || null, body.sortOrder || 0);
  json(res, db.prepare('SELECT * FROM categories WHERE id = ?').get(id), 201);
}, true);

route('PUT', '/api/v1/admin/categories/:id', async (req, res, params) => {
  await authenticate(req);
  const body = await parseBody(req);
  db.prepare('UPDATE categories SET name = ?, slug = ?, description = ?, parent_id = ?, sort_order = ? WHERE id = ?').run(body.name, body.slug || slugify(body.name), body.description || null, body.parentId || null, body.sortOrder || 0, params.id);
  json(res, db.prepare('SELECT * FROM categories WHERE id = ?').get(params.id));
}, true);

route('DELETE', '/api/v1/admin/categories/:id', async (req, res, params) => {
  await authenticate(req);
  db.prepare('UPDATE posts SET category_id = NULL WHERE category_id = ?').run(params.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(params.id);
  json(res, { id: params.id });
}, true);

route('GET', '/api/v1/admin/tags', async (req, res) => {
  await authenticate(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = parseInt(url.searchParams.get('page')) || 1, ps = parseInt(url.searchParams.get('pageSize')) || 50;
  const total = (db.prepare('SELECT COUNT(*) as c FROM tags').get()).c;
  const items = db.prepare('SELECT t.*, (SELECT COUNT(*) FROM post_tags WHERE tag_id = t.id) as post_count FROM tags t ORDER BY t.name LIMIT ? OFFSET ?').all(ps, (page - 1) * ps);
  json(res, { items, meta: { total, page, pageSize: ps, totalPages: Math.ceil(total / ps), hasNext: page * ps < total, hasPrev: page > 1 } });
}, true);

route('POST', '/api/v1/admin/tags', async (req, res) => {
  await authenticate(req);
  const body = await parseBody(req);
  validators.required(body.name, '标签名称');
  validators.string(body.name, '标签名称', 100);
  const id = uid();
  db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)').run(id, body.name, body.slug || slugify(body.name));
  json(res, db.prepare('SELECT * FROM tags WHERE id = ?').get(id), 201);
}, true);

route('PUT', '/api/v1/admin/tags/:id', async (req, res, params) => {
  await authenticate(req);
  const body = await parseBody(req);
  db.prepare('UPDATE tags SET name = ?, slug = ? WHERE id = ?').run(body.name, body.slug || slugify(body.name), params.id);
  json(res, db.prepare('SELECT * FROM tags WHERE id = ?').get(params.id));
}, true);

route('DELETE', '/api/v1/admin/tags/:id', async (req, res, params) => {
  await authenticate(req);
  db.prepare('DELETE FROM post_tags WHERE tag_id = ?').run(params.id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(params.id);
  json(res, { id: params.id });
}, true);

route('GET', '/api/v1/admin/comments/export', async (req, res) => {
  const auth = await authenticate(req);
  if (!['admin', 'editor'].includes(auth.role)) return error(res, '权限不足', 403);
  const items = db.prepare('SELECT c.*, p.title as post_title, u.username FROM comments c LEFT JOIN posts p ON c.post_id = p.id LEFT JOIN users u ON c.user_id = u.id ORDER BY c.created_at DESC').all();
  // CSV 格式导出
  const header = 'ID,内容,文章,作者,邮箱,状态,日期\n';
  const rows = items.map(c => {
    const esc = s => '"' + String(s || '').replace(/"/g, '""') + '"';
    return [c.id, esc(c.content), esc(c.post_title), esc(c.author_name || c.username), esc(c.author_email), c.status, c.created_at].join(',');
  }).join('\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="comments.csv"' });
  res.end('\uFEFF' + header + rows); // BOM for Excel
}, true);

route('GET', '/api/v1/admin/comments', async (req, res) => {
  await authenticate(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = parseInt(url.searchParams.get('page')) || 1, ps = parseInt(url.searchParams.get('pageSize')) || 20;
  const status = url.searchParams.get('status'), postId = url.searchParams.get('postId');
  let where = 'WHERE 1=1'; const params = [];
  if (status) { where += ' AND c.status = ?'; params.push(status); }
  if (postId) { where += ' AND c.post_id = ?'; params.push(postId); }
  const total = (db.prepare(`SELECT COUNT(*) as c FROM comments c ${where}`).get(...params)).c;
  const items = db.prepare(`SELECT c.*, p.title as post_title, u.username FROM comments c LEFT JOIN posts p ON c.post_id = p.id LEFT JOIN users u ON c.user_id = u.id ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params, ps, (page - 1) * ps);
  json(res, { items, meta: { total, page, pageSize: ps, totalPages: Math.ceil(total / ps), hasNext: page * ps < total, hasPrev: page > 1 } });
}, true);

route('PATCH', '/api/v1/admin/comments/:id/status', async (req, res, params) => {
  await authenticate(req);
  const { status } = await parseBody(req);
  if (!['approved', 'pending', 'spam', 'trash'].includes(status)) return error(res, '无效状态');
  db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(status, params.id);
  logAction(auth.id, 'comment.status', '评论状态更新: ' + params.id + ' -> ' + status, req);
  try { triggerHook('comment.status', { id: params.id, status }); } catch {}
  json(res, { id: params.id, status });
}, true);

route('DELETE', '/api/v1/admin/comments/:id', async (req, res, params) => {
  const auth = await authenticate(req);
  if (!['admin', 'editor'].includes(auth.role)) return error(res, '权限不足', 403);
  const gone = db.prepare('SELECT * FROM comments WHERE id = ?').get(params.id);
  db.prepare('DELETE FROM comments WHERE id = ?').run(params.id);
  logAction(auth.id, 'comment.delete', '删除评论: ' + params.id, req);
  try { triggerHook('comment.deleted', gone || { id: params.id }); } catch {}
  json(res, { id: params.id });
}, true);

route('POST', '/api/v1/admin/media/upload', async (req, res) => {
  const auth = await authenticate(req);
  const body = await parseBody(req);
  if (!body.data || !body.name) return error(res, '缺少文件数据', 400);
  const ext = (body.name.match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
  const safeExt = ['.jpg','.jpeg','.png','.gif','.webp','.svg','.pdf','.txt','.md','.zip'].includes(ext) ? ext : '';
  const filename = Date.now().toString(36) + '-' + randomBytes(4).toString('hex') + safeExt;
  const fp = join(UPLOAD_DIR, filename);
  const fileBuf = Buffer.from(body.data, 'base64');
  // MIME 魔数校验：防止伪装文件类型
  const mimeMap = [
    { ext: '.jpg', magic: [0xFF, 0xD8, 0xFF] },
    { ext: '.jpeg', magic: [0xFF, 0xD8, 0xFF] },
    { ext: '.png', magic: [0x89, 0x50, 0x4E, 0x47] },
    { ext: '.gif', magic: [0x47, 0x49, 0x46, 0x38] },
    { ext: '.webp', magic: [0x52, 0x49, 0x46, 0x46] },
    { ext: '.pdf', magic: [0x25, 0x50, 0x44, 0x46] },
    { ext: '.zip', magic: [0x50, 0x4B, 0x03, 0x04] },
  ];
  const mimeCheck = mimeMap.find(m => m.ext === safeExt);
  if (mimeCheck) {
    const ok = mimeCheck.magic.every((b, i) => fileBuf[i] === b);
    if (!ok) return error(res, '文件类型与扩展名不符', 400);
  }
  writeFileSync(fp, fileBuf);
  const id = uid();
  const url = '/uploads/' + filename;
  const size = Buffer.from(body.data, 'base64').length;
  // 读取图片尺寸（仅图片类型）
  let width = null, height = null;
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(safeExt)) {
    try {
      // 简单的图片尺寸读取（不依赖外部库）
      if (safeExt === '.png') {
        width = fileBuf.readUInt32BE(16);
        height = fileBuf.readUInt32BE(20);
      } else if (safeExt === '.gif') {
        width = fileBuf.readUInt16LE(6);
        height = fileBuf.readUInt16LE(8);
      } else if (safeExt === '.jpg' || safeExt === '.jpeg') {
        // JPEG 需要扫描 SOF 标记
        let offset = 2;
        while (offset < fileBuf.length - 9) {
          if (fileBuf[offset] === 0xFF) {
            const marker = fileBuf[offset + 1];
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
              height = fileBuf.readUInt16BE(offset + 5);
              width = fileBuf.readUInt16BE(offset + 7);
              break;
            }
            const len = fileBuf.readUInt16BE(offset + 2);
            offset += 2 + len;
          } else { offset++; }
        }
      }
    } catch (e) { /* 尺寸读取失败不影响上传 */ }
  }
  const thumbUrl = createThumbnailOnUpload(fp, safeExt);
  db.prepare('INSERT INTO media (id, name, path, url, mime_type, size, width, height, alt, thumbnail_url, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, body.name, fp, url, body.mime || 'application/octet-stream', size, width, height, body.alt || null, thumbUrl, auth.id);
  const mediaRow = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  try { triggerHook('media.uploaded', mediaRow, { isNew: true }); } catch {}
  json(res, mediaRow, 201);
}, true);

route('GET', '/api/v1/admin/media', async (req, res) => {
  await authenticate(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = parseInt(url.searchParams.get('page')) || 1, ps = parseInt(url.searchParams.get('pageSize')) || 20;
  const total = (db.prepare('SELECT COUNT(*) as c FROM media').get()).c;
  const items = db.prepare('SELECT m.*, u.username as uploader_name FROM media m LEFT JOIN users u ON m.uploader_id = u.id ORDER BY m.created_at DESC LIMIT ? OFFSET ?').all(ps, (page - 1) * ps);
  json(res, { items, meta: { total, page, pageSize: ps, totalPages: Math.ceil(total / ps), hasNext: page * ps < total, hasPrev: page > 1 } });
}, true);

route('DELETE', '/api/v1/admin/media/:id', async (req, res, params) => {
  const auth = await authenticate(req);
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(params.id);
  if (auth.role !== 'admin' && media.uploader_id !== auth.id) return error(res, '权限不足', 403);
  if (!media) return error(res, '文件不存在', 404);
  try { const { unlinkSync } = await import('node:fs'); unlinkSync(media.path); } catch {}
  db.prepare('DELETE FROM media WHERE id = ?').run(params.id);
  try { triggerHook('media.deleted', media); } catch {}
  json(res, { id: params.id });
}, true);

route('GET', '/api/v1/admin/users', async (req, res) => {
  await authenticate(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = parseInt(url.searchParams.get('page')) || 1, ps = parseInt(url.searchParams.get('pageSize')) || 20;
  const total = (db.prepare('SELECT COUNT(*) as c FROM users').get()).c;
  const items = db.prepare('SELECT id, username, nickname, email, avatar, role, status, created_at, (SELECT COUNT(*) FROM posts WHERE author_id = users.id) as post_count FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(ps, (page - 1) * ps);
  json(res, { items, meta: { total, page, pageSize: ps, totalPages: Math.ceil(total / ps), hasNext: page * ps < total, hasPrev: page > 1 } });
}, true);

route('POST', '/api/v1/admin/users', async (req, res) => {
  const auth = await authenticate(req);
  if (auth.role !== 'admin') return error(res, '权限不足', 403);
  const body = await parseBody(req);
  validators.required(body.username, '用户名');
  validators.string(body.username, '用户名', 50);
  validators.required(body.email, '邮箱');
  validators.email(body.email, '邮箱');
  if (body.password) validators.string(body.password, '密码', 100);
  const id = uid();
  db.prepare('INSERT INTO users (id, username, email, password, nickname, role) VALUES (?, ?, ?, ?, ?, ?)').run(id, body.username, body.email, hashPwd(body.password), body.nickname || body.username, body.role || 'subscriber');
  logAction(auth.id, 'user.create', '创建用户: ' + body.username, req);
  const createdUser = db.prepare('SELECT id, username, nickname, email, role FROM users WHERE id = ?').get(id);
  try { triggerHook('user.created', createdUser); } catch {}
  json(res, { id, username: body.username, role: body.role }, 201);
}, true);

route('PUT', '/api/v1/admin/users/:id', async (req, res, params) => {
  const auth = await authenticate(req);
  if (auth.role !== 'admin') return error(res, '权限不足', 403);
  const body = await parseBody(req);
  const updates = [], args = [];
  for (const f of ['nickname', 'email', 'avatar', 'bio', 'role', 'status']) { if (body[f] !== undefined) { updates.push(f + ' = ?'); args.push(body[f]); } }
  if (body.password) updates.push('password = ?'), args.push(hashPwd(body.password));
  if (updates.length) { args.push(params.id); db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...args); }
  json(res, db.prepare('SELECT id, username, nickname, email, avatar, role, status FROM users WHERE id = ?').get(params.id));
}, true);

route('DELETE', '/api/v1/admin/users/:id', async (req, res, params) => {
  const auth = await authenticate(req);
  if (auth.role !== 'admin') return error(res, '权限不足', 403);
  if (auth.id === params.id) return error(res, '不能删除自己', 400);
  db.prepare('DELETE FROM users WHERE id = ?').run(params.id);
  logAction(auth.id, 'user.delete', '删除用户: ' + params.id, req);
  json(res, { id: params.id });
}, true);

route('GET', '/api/v1/admin/options', async (req, res) => { await authenticate(req); json(res, db.prepare('SELECT * FROM options ORDER BY key').all()); }, true);

route('PUT', '/api/v1/admin/options', async (req, res) => {
  await authenticate(req);
  const items = await parseBody(req);
  for (const item of items) {
    const existing = db.prepare('SELECT id, autoload FROM options WHERE key = ?').get(item.key);
    const autoload = item.autoload !== undefined ? (item.autoload ? 1 : 0) : (existing ? existing.autoload : 1);
    if (existing) db.prepare(`UPDATE options SET value = ?, autoload = ?, updated_at = datetime('now') WHERE key = ?`).run(item.value, autoload, item.key);
    else db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, ?)').run(uid(), item.key, item.value, autoload);
  }
  try { triggerHook('options.saved', items); } catch {}
  json(res, { updated: items.length });
}, true);

route('GET', '/api/v1/admin/themes', async (req, res) => {
  await authenticate(req);
  const themes = db.prepare('SELECT * FROM themes ORDER BY name').all();
  const result = themes.map(t => {
    const manifest = readThemeManifest(t.theme_id);
    // 以 theme.json 清单为准，保证名称/版本/描述始终同步
    if (manifest) {
      const mName = manifest.name || t.name;
      const mVersion = manifest.version || t.version;
      if (mName !== t.name || mVersion !== t.version) {
        db.prepare('UPDATE themes SET name = ?, version = ? WHERE theme_id = ?').run(mName, mVersion, t.theme_id);
      }
    }
    return {
      ...t,
      name: manifest?.name || t.name,
      version: manifest?.version || t.version,
      description: manifest?.description || t.description || '',
      author: manifest?.author || t.author || '',
      hasSettings: !!(manifest && manifest.settings && manifest.settings.length),
    };
  });
  json(res, result);
}, true);

route('POST', '/api/v1/admin/themes/:themeId/activate', async (req, res, params) => {
  await authenticate(req);
  if (!db.prepare('SELECT id FROM themes WHERE theme_id = ?').get(params.themeId)) db.prepare('INSERT INTO themes (id, theme_id, name, version, active) VALUES (?, ?, ?, ?, 0)').run(uid(), params.themeId, params.themeId, '1.0.0');
  db.prepare('UPDATE themes SET active = 0').run();
  db.prepare('UPDATE themes SET active = 1 WHERE theme_id = ?').run(params.themeId);
  // 同步更新 options.active_theme，消除双写不一致
  db.prepare("INSERT INTO options (id, key, value, autoload) VALUES (?, 'active_theme', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(uid(), params.themeId);
  try { triggerHook('theme.activated', { themeId: params.themeId }); } catch {}
  json(res, { themeId: params.themeId, active: true });
}, true);

route('GET', '/api/v1/admin/themes/:themeId/settings', async (req, res, params) => {
  await authenticate(req);
  const theme = db.prepare('SELECT * FROM themes WHERE theme_id = ?').get(params.themeId);
  if (!theme) { json(res, { code: 404, message: '主题不存在' }, 404); return; }
  const manifest = readThemeManifest(params.themeId);
  let config = {};
  try { config = JSON.parse(theme.config || '{}'); } catch (e) {}
  json(res, { theme, schema: (manifest && manifest.settings) || [], values: config });
}, true);

route('PUT', '/api/v1/admin/themes/:themeId/settings', async (req, res, params) => {
  await authenticate(req);
  const body = await parseBody(req);
  const theme = db.prepare('SELECT * FROM themes WHERE theme_id = ?').get(params.themeId);
  if (!theme) { json(res, { code: 404, message: '主题不存在' }, 404); return; }
  let config = {};
  try { config = JSON.parse(theme.config || '{}'); } catch (e) {}
  const merged = { ...config, ...body };
  db.prepare("UPDATE themes SET config = ? WHERE theme_id = ?").run(JSON.stringify(merged), params.themeId);
  // 清除主题配置缓存
  if (typeof invalidateThemeConfigCache === 'function') invalidateThemeConfigCache();
  json(res, merged);
}, true);

// 上传安装主题（zip）：对标 Typecho / WP 的「上传主题包」
route('POST', '/api/v1/admin/themes/install', async (req, res) => {
  const auth = await authenticate(req);
  const body = await parseBody(req);
  if (!body || !body.data) return error(res, '缺少主题包数据', 400);

  let buf;
  try { buf = Buffer.from(String(body.data).replace(/^data:[^,]*,/, ''), 'base64'); }
  catch (e) { return error(res, '主题包数据无效', 400); }
  if (buf.length < 22) return error(res, '主题包为空或已损坏', 400);
  if (buf.length > 30 * 1024 * 1024) return error(res, '主题包过大（上限 30MB）', 400);

  let entries;
  try { entries = listZipEntries(buf); }
  catch (e) { return error(res, e.message, 400); }
  if (!entries.length) return error(res, '主题包为空', 400);

  // 定位 theme.json（允许 zip 内再套一层目录）
  let manifestEntry = null, prefix = '';
  for (const e of entries) {
    const p = safeEntryPath(e.name);
    if (p && p.endsWith('theme.json') && p.split('/').length <= 2) { manifestEntry = e; prefix = p.slice(0, -'theme.json'.length); break; }
  }
  if (!manifestEntry) return error(res, '主题包内未找到 theme.json（必须位于根目录或一级子目录）', 400);

  let manifest;
  try { manifest = JSON.parse(readZipEntry(buf, manifestEntry).toString('utf8')); }
  catch (e) { return error(res, 'theme.json 解析失败：' + e.message, 400); }

  const themeId = String(manifest.id || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(themeId)) return error(res, 'theme.json 的 id 非法（仅允许字母、数字、- 和 _，且以字母或数字开头）', 400);
  if (!manifest.name) return error(res, 'theme.json 缺少 name 字段', 400);

  const destDir = join(THEMES_DIR, themeId);
  const staging = destDir + '.staging-' + Date.now().toString(36);
  mkdirSync(staging, { recursive: true });

  let written = 0, skipped = 0;
  try {
    for (const e of entries) {
      const p = safeEntryPath(e.name);
      if (!p || p.endsWith('/')) continue;                       // 目录项 / 越界路径
      if (prefix && !p.startsWith(prefix)) continue;             // 不属于主题根
      const rel = prefix ? p.slice(prefix.length) : p;
      if (!rel || rel.startsWith('__MACOSX/') || rel.split('/').some(x => x === '__MACOSX' || x.startsWith('._'))) { skipped++; continue; }
      const dot = rel.lastIndexOf('.');
      const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
      if (!THEME_ALLOWED_EXT.has(ext)) { skipped++; continue; }  // 非静态资源（含 .php）一律不落盘
      const target = join(staging, rel);
      if (!target.startsWith(staging + '/')) { skipped++; continue; }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readZipEntry(buf, e));
      written++;
    }
  } catch (e) {
    return error(res, '解压失败：' + e.message, 400);
  }
  if (!written) return error(res, '主题包内没有可用的静态文件', 400);

  // 校验落盘后的清单确实存在
  if (!existsSync(join(staging, 'theme.json'))) return error(res, '主题包缺少 theme.json', 400);

  // 覆盖安装：旧目录改名备份，便于回滚
  if (existsSync(destDir)) {
    try { renameSync(destDir, destDir + '.bak-' + Date.now().toString(36)); }
    catch (e) { return error(res, '旧主题目录无法替换：' + e.message, 500); }
  }
  try { renameSync(staging, destDir); }
  catch (e) { return error(res, '安装失败：' + e.message, 500); }

  // 注册到主题表（幂等）
  if (!db.prepare('SELECT id FROM themes WHERE theme_id = ?').get(themeId)) {
    db.prepare('INSERT INTO themes (id, theme_id, name, version, active) VALUES (?, ?, ?, ?, 0)').run(uid(), themeId, manifest.name, manifest.version || '1.0.0');
  } else {
    db.prepare('UPDATE themes SET name = ?, version = ? WHERE theme_id = ?').run(manifest.name, manifest.version || '1.0.0', themeId);
  }
  logAction(auth.id, 'theme.install', themeId + ' (' + written + ' files, ' + skipped + ' skipped)', req);
  json(res, { themeId, name: manifest.name, version: manifest.version || '1.0.0', files: written, skipped }, 201);
}, true);


// ═══ 新增：控制台增强 ═══

route('GET', '/api/v1/admin/posts/recent', async (req, res) => {
  await authenticate(req);
  const items = db.prepare('SELECT p.id, p.title, p.slug, p.status, p.created_at, u.username as author_name, c.name as category_name FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id WHERE p.type = ? ORDER BY p.created_at DESC LIMIT 5').all('post');
  json(res, items);
}, true);

route('GET', '/api/v1/admin/comments/recent', async (req, res) => {
  await authenticate(req);
  const items = db.prepare('SELECT c.id, c.content, c.status, c.created_at, p.title as post_title, c.author_name FROM comments c LEFT JOIN posts p ON c.post_id = p.id ORDER BY c.created_at DESC LIMIT 5').all();
  json(res, items);
}, true);

route('GET', '/api/v1/admin/stats/system', async (req, res) => {
  await authenticate(req);
  const stats = {
    nodeVersion: process.version,
    platform: process.platform,
    uptime: Math.floor(process.uptime()),
    dbVersion: db.prepare('SELECT sqlite_version() as v').get().v,
    postCount: (db.prepare('SELECT COUNT(*) as c FROM posts WHERE type = ?').get('post')).c,
    pageCount: (db.prepare('SELECT COUNT(*) as c FROM posts WHERE type = ?').get('page')).c,
    commentCount: (db.prepare('SELECT COUNT(*) as c FROM comments').get()).c,
    categoryCount: (db.prepare('SELECT COUNT(*) as c FROM categories').get()).c,
    tagCount: (db.prepare('SELECT COUNT(*) as c FROM tags').get()).c,
    mediaCount: (db.prepare('SELECT COUNT(*) as c FROM media').get()).c,
    userCount: (db.prepare('SELECT COUNT(*) as c FROM users').get()).c,
  };
  json(res, stats);
}, true);

// ═══ 新增：评论管理增强 ═══

route('POST', '/api/v1/admin/comments/:id/reply', async (req, res, params) => {
  const auth = await authenticate(req);
  const body = await parseBody(req);
  validators.required(body.content, '回复内容');
  const parent = db.prepare('SELECT * FROM comments WHERE id = ?').get(params.id);
  if (!parent) return error(res, '评论不存在', 404);
  const id = uid();
  db.prepare('INSERT INTO comments (id, content, status, author_name, author_email, post_id, user_id, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, body.content, 'approved', auth.nickname || auth.username, auth.email || '', parent.post_id, auth.id, parent.id);
  json(res, db.prepare('SELECT * FROM comments WHERE id = ?').get(id), 201);
}, true);

route('PUT', '/api/v1/admin/comments/:id', async (req, res, params) => {
  await authenticate(req);
  const body = await parseBody(req);
  if (body.content !== undefined) validators.string(body.content, '评论内容', 5000);
  const updates = [], args = [];
  for (const f of ['content', 'status', 'author_name', 'author_email']) {
    if (body[f] !== undefined) { updates.push(f + ' = ?'); args.push(body[f]); }
  }
  if (updates.length) {
    args.push(params.id);
    db.prepare('UPDATE comments SET ' + updates.join(', ') + ' WHERE id = ?').run(...args);
  }
  json(res, db.prepare('SELECT * FROM comments WHERE id = ?').get(params.id));
}, true);

route('PATCH', '/api/v1/admin/comments/batch-status', async (req, res) => {
  await authenticate(req);
  const body = await parseBody(req);
  if (!body.ids || !Array.isArray(body.ids)) return error(res, '缺少评论ID列表', 400);
  if (!['approved', 'pending', 'spam', 'trash'].includes(body.status)) return error(res, '无效状态');
  const stmt = db.prepare('UPDATE comments SET status = ? WHERE id = ?');
  for (const id of body.ids) stmt.run(body.status, id);
  json(res, { updated: body.ids.length });
}, true);

// ═══ 新增：文章批量操作 ═══

route('POST', '/api/v1/admin/posts/batch', async (req, res) => {
  const auth = await authenticate(req);
  const body = await parseBody(req);
  if (!body.ids || !Array.isArray(body.ids)) return error(res, '缺少文章ID列表', 400);
  if (!['publish', 'draft', 'delete'].includes(body.action)) return error(res, '无效操作');
  if (body.action === 'delete') {
    const stmt = db.prepare('DELETE FROM posts WHERE id = ?');
    for (const id of body.ids) stmt.run(id);
  } else {
    const status = body.action === 'publish' ? 'published' : 'draft';
    const stmt = db.prepare('UPDATE posts SET status = ? WHERE id = ?');
    for (const id of body.ids) stmt.run(status, id);
  }
  json(res, { updated: body.ids.length });
}, true);

// ═══ 新增：操作日志 ═══

route('DELETE', '/api/v1/admin/logs', async (req, res) => {
  const auth = await authenticate(req);
  if (auth.role !== 'admin') return error(res, '权限不足', 403);
  const body = await parseBody(req);
  const days = parseInt(body.days) || 30;
  const result = db.prepare("DELETE FROM logs WHERE created_at < datetime('now', '-' || ? || ' days')").run(days);
  json(res, { deleted: result.changes });
}, true);

route('GET', '/api/v1/admin/logs', async (req, res) => {
  await authenticate(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = parseInt(url.searchParams.get('page')) || 1, ps = parseInt(url.searchParams.get('pageSize')) || 20;
  const total = (db.prepare('SELECT COUNT(*) as c FROM logs').get()).c;
  const items = db.prepare('SELECT l.*, u.username FROM logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC LIMIT ? OFFSET ?').all(ps, (page - 1) * ps);
  json(res, { items, meta: { total, page, pageSize: ps, totalPages: Math.ceil(total / ps), hasNext: page * ps < total, hasPrev: page > 1 } });
}, true);

// ═══ 新增：数据库备份 ═══

route('POST', '/api/v1/admin/backup', async (req, res) => {
  await authenticate(req);
  const { copyFileSync, existsSync, mkdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { execSync } = await import('node:child_process');
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const src = join(__dirname, '..', 'data', 'lill.db');
  const backupDir = join(__dirname, '..', 'data', 'backups');
  mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = join(backupDir, 'lill-backup-' + ts + '.db');
  copyFileSync(src, dst);
  // 同时打包 uploads/ 目录
  const uploadsDir = join(__dirname, '..', 'uploads');
  let uploadInfo = null;
  if (existsSync(uploadsDir)) {
    const zipPath = join(backupDir, 'lill-uploads-' + ts + '.zip');
    try {
      execSync(`cd "${uploadsDir}" && zip -r "${zipPath}" . -x '.*'`, { stdio: 'pipe' });
      uploadInfo = { path: zipPath, message: '附件已打包' };
    } catch (e) { uploadInfo = { message: '附件打包失败: ' + e.message }; }
  }
  // 自动清理 30 天前的备份文件
  try {
    const { readdirSync, unlinkSync, statSync } = await import('node:fs');
    const files = readdirSync(backupDir);
    const now = Date.now();
    let cleaned = 0;
    for (const f of files) {
      if (!f.startsWith('lill-backup-')) continue;
      const fp = join(backupDir, f);
      const stat = statSync(fp);
      if (now - stat.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
        unlinkSync(fp);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log('🧹 清理了 ' + cleaned + ' 个过期备份');
  } catch (e) { /* 清理失败不影响备份 */ }
  json(res, { path: dst, uploads: uploadInfo, message: '备份成功' });
}, true);

route('GET', '/api/v1/admin/stats/dashboard', async (req, res) => {
  await authenticate(req);
  const o = {
    postCount: (db.prepare('SELECT COUNT(*) as c FROM posts WHERE type = ? AND status = ?').get('post', 'published')).c,
    pageCount: (db.prepare('SELECT COUNT(*) as c FROM posts WHERE type = ? AND status = ?').get('page', 'published')).c,
    commentCount: (db.prepare('SELECT COUNT(*) as c FROM comments WHERE status = ?').get('approved')).c,
    pendingCommentCount: (db.prepare('SELECT COUNT(*) as c FROM comments WHERE status = ?').get('pending')).c,
    userCount: (db.prepare('SELECT COUNT(*) as c FROM users WHERE status = ?').get('active')).c,
  };
  json(res, { overview: o });
}, true);

// 主题在线编辑器 - 读取文件
route('GET', '/api/v1/admin/themes/files', async (req, res) => {
  await authenticate(req);
  const themeId = req.query.theme || 'default';
  const themeDir = join(FRONTEND_DIR, 'themes', themeId);
  if (!existsSync(themeDir)) return error(res, '主题不存在', 404);
  const files = [];
  function scanDir(dir, prefix = '') {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) scanDir(join(dir, e.name), rel + '/');
      else if (/\.(html|css|js|json|md)$/.test(e.name)) {
        files.push({ path: rel, size: statSync(join(dir, e.name)).size });
      }
    }
  }
  scanDir(themeDir);
  json(res, files);
});

// 主题在线编辑器 - 读取文件内容
route('GET', '/api/v1/admin/themes/file', async (req, res) => {
  await authenticate(req);
  const themeId = req.query.theme || 'default';
  const filePath = req.query.path || '';
  if (!filePath || filePath.includes('..')) return error(res, '无效路径', 400);
  const fullPath = join(FRONTEND_DIR, 'themes', themeId, filePath);
  if (!existsSync(fullPath)) return error(res, '文件不存在', 404);
  json(res, { content: readFileSync(fullPath, 'utf8') });
});

// 主题在线编辑器 - 保存文件
route('PUT', '/api/v1/admin/themes/file', async (req, res) => {
  await authenticate(req);
  const body = await parseBody(req);
  const themeId = body.theme || 'default';
  const filePath = body.path || '';
  if (!filePath || filePath.includes('..')) return error(res, '无效路径', 400);
  const fullPath = join(FRONTEND_DIR, 'themes', themeId, filePath);
  if (!existsSync(fullPath)) return error(res, '文件不存在', 404);
  writeFileSync(fullPath, body.content || '', 'utf8');
  json(res, { message: '保存成功' });
}, true);

// 插件系统 - 列出插件
route('GET', '/api/v1/admin/plugins', async (req, res) => {
  await authenticate(req);
  const pluginsDir = PLUGINS_DIR;
  const plugins = [];
  if (existsSync(pluginsDir)) {
    const entries = readdirSync(pluginsDir, { withFileTypes: true });
    for (const e of entries) {
      // 跳过隐藏/临时/回收目录（.tmp-*、.trash-*、.bak-*、._* 等）
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const manifestPath = join(pluginsDir, e.name, 'plugin.json');
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            // 从 plugins 表读取 active 状态
            const dbPlugin = db.prepare('SELECT active FROM plugins WHERE dir = ?').get(e.name);
            plugins.push({ ...manifest, dir: e.name, active: dbPlugin ? !!dbPlugin.active : false });
          } catch {}
        }
      }
    }
  }
  json(res, plugins);
});

// 插件系统 - 启用/禁用插件
route('POST', '/api/v1/admin/plugins/toggle', async (req, res) => {
  await authenticate(req);
  const body = await parseBody(req);
  if (!body.dir) return error(res, '缺少插件目录名', 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(body.dir) || body.dir.includes('..')) {
    return error(res, '非法插件目录名', 400);
  }

  // 检查插件是否存在
  const pluginsDir = PLUGINS_DIR;
  const manifestPath = join(pluginsDir, body.dir, 'plugin.json');
  if (!existsSync(manifestPath)) return error(res, '插件不存在', 404);
  
  // 读取插件信息
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {}
  
  // 查询当前状态
  const existing = db.prepare('SELECT * FROM plugins WHERE dir = ?').get(body.dir);
  const newActive = existing ? !existing.active : true;
  
  // 更新或插入插件状态
  if (existing) {
    db.prepare('UPDATE plugins SET active = ? WHERE dir = ?').run(newActive ? 1 : 0, body.dir);
  } else {
    db.prepare('INSERT INTO plugins (id, dir, name, version, description, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uid(), body.dir, manifest.name || body.dir, manifest.version || '1.0.0', manifest.description || '', newActive ? 1 : 0);
  }
  
  // 运行时热加载 / 卸载，无需重启服务
  let hot = 'ok';
  try {
    if (newActive) {
      await activatePlugin(body.dir);
    } else {
      deactivatePlugin(body.dir);
    }
  } catch (e) {
    hot = 'reload_failed: ' + e.message;
    console.error(`  ✗ 插件热加载失败：${body.dir} — ${e.message}`);
  }

  json(res, { dir: body.dir, active: newActive, hot, message: newActive ? '插件已启用' : '插件已禁用' });
}, true);

// 插件注册的后台菜单
route('GET', '/api/v1/admin/plugin-menus', async (req, res) => {
  await authenticate(req);
  const menus = Array.isArray(ctx._adminMenus) ? ctx._adminMenus.slice().sort((a, b) => (a.order || 0) - (b.order || 0)) : [];
  json(res, menus);
}, true);

// 插件系统 - 上传 ZIP 安装插件
route('POST', '/api/v1/admin/plugins/install', async (req, res) => {
  await authenticate(req);
  const body = await parseBody(req);
  if (!body.name || !body.data) return error(res, '缺少插件数据', 400);

  // base64 解码
  let buf;
  try {
    buf = Buffer.from(body.data, 'base64');
  } catch {
    return error(res, '无效的数据', 400);
  }

  // 解压到临时目录
  const pluginsDir = PLUGINS_DIR;
  mkdirSync(pluginsDir, { recursive: true });
  const tmpDir = join(pluginsDir, '.tmp-' + uid());
  mkdirSync(tmpDir, { recursive: true });

  try {
    const entries = listZipEntries(buf);
    // 检查根目录（去前缀后只剩一级的为顶层目录名）
    const topDirs = new Set();
    for (const e of entries) {
      const parts = e.name.split('/').filter(Boolean);
      if (parts.length > 0) topDirs.add(parts[0]);
    }
    // 支持直接打包 plugins/<dir>/xxx 或 <dir>/xxx 两种结构
    let targetDir = topDirs.size === 1 ? [...topDirs][0] : String(body.name || '').replace(/\.[^.]+$/, '');
    // 目录名安全校验，防路径穿越
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(targetDir) || targetDir.includes('..')) {
      return error(res, '插件目录名非法（仅允许字母、数字、- _ .，且以字母或数字开头）', 400);
    }

    for (const e of entries) {
      if (e.rawSize === 0 && e.name.endsWith('/')) continue; // 目录条目
      const rel = e.name.split('/').filter(Boolean).slice(topDirs.size === 1 ? 1 : 0).join('/');
      if (!rel) continue;
      const safeRel = safeEntryPath(rel);
      if (!safeRel) continue;
      const safe = join(tmpDir, safeRel);
      const data = readZipEntry(buf, e);
      mkdirSync(dirname(safe), { recursive: true });
      writeFileSync(safe, data);
    }

    // 解压时已剥离顶层目录，内容统一落在 tmpDir 根
    const srcDir = tmpDir;

    // 找到 plugin.json 的位置
    const manifestFullPath = join(srcDir, 'plugin.json');

    if (!existsSync(manifestFullPath)) {
      // 清理临时目录
      readdirSync(tmpDir).forEach(f => {
        try { renameSync(join(tmpDir, f), join(pluginsDir, '.trash-' + uid() + '-' + f)); } catch {}
      });
      return error(res, 'ZIP 中未找到 plugin.json', 400);
    }

    // 读取 manifest
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestFullPath, 'utf8'));
    } catch {
      return error(res, 'plugin.json 格式错误', 400);
    }

    // 移动到正式位置
    const finalDir = join(pluginsDir, targetDir);
    if (existsSync(finalDir)) {
      // 已存在则覆盖：先备份
      renameSync(finalDir, join(pluginsDir, '.bak-' + uid() + '-' + targetDir));
    }
    renameSync(srcDir, finalDir);

    // 写入数据库
    const existing = db.prepare('SELECT id FROM plugins WHERE dir = ?').get(targetDir);
    if (!existing) {
      db.prepare('INSERT INTO plugins (id, dir, name, version, description, active) VALUES (?, ?, ?, ?, ?, 0)')
        .run(uid(), targetDir, manifest.name || targetDir, manifest.version || '1.0.0', manifest.description || '');
    }

    // 清理临时目录
    try {
      readdirSync(tmpDir).forEach(f => {
        try { renameSync(join(tmpDir, f), join(pluginsDir, '.trash-' + uid() + '-' + f)); } catch {}
      });
    } catch {}

    json(res, { dir: targetDir, name: manifest.name || targetDir, version: manifest.version || '1.0.0', message: '插件已安装，请在列表中启用' }, 201);
  } catch (e) {
    // 清理临时目录
    try {
      readdirSync(tmpDir).forEach(f => {
        try { renameSync(join(tmpDir, f), join(pluginsDir, '.trash-' + uid() + '-' + f)); } catch {}
      });
    } catch {}
    return error(res, '安装失败: ' + e.message, 400);
  }
}, true);

// 插件系统 - 卸载插件
route('DELETE', '/api/v1/admin/plugins/:dir', async (req, res, params) => {
  await authenticate(req);
  const dir = params.dir;
  // 防目录穿越：目录名只允许字母/数字/_/-/.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(dir) || dir.includes('..')) {
    return error(res, '非法插件目录名', 400);
  }
  const pluginsDir = PLUGINS_DIR;
  const pluginPath = join(pluginsDir, dir);

  if (!existsSync(pluginPath)) return error(res, '插件不存在', 404);

  // 先停用（未加载时为空操作），再清理数据库状态
  try { deactivatePlugin(dir); } catch {}
  db.prepare('UPDATE plugins SET active = 0 WHERE dir = ?').run(dir);

  // 移动到回收目录（不直接删除，可恢复）
  const trashDir = join(pluginsDir, '.trash-' + uid() + '-' + dir);
  renameSync(pluginPath, trashDir);
  db.prepare('DELETE FROM plugins WHERE dir = ?').run(dir);

  json(res, { dir, message: '插件已卸载' });
}, true);

// 小工具管理
route('GET', '/api/v1/admin/widgets', async (req, res) => {
  await authenticate(req);
  const items = db.prepare('SELECT * FROM widgets ORDER BY sort_order ASC').all();
  json(res, items);
});

route('POST', '/api/v1/admin/widgets', async (req, res) => {
  await authenticate(req);
  const body = await parseBody(req);
  if (!body.name || !body.type) return error(res, '缺少必要参数', 400);
  const id = uid();
  db.prepare('INSERT INTO widgets (id, name, type, content, position, sort_order, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, body.name, body.type, body.content || '', body.position || 'sidebar', body.sort_order || 0, body.enabled ? 1 : 0);
  json(res, db.prepare('SELECT * FROM widgets WHERE id = ?').get(id), 201);
}, true);

route('PUT', '/api/v1/admin/widgets/:id', async (req, res, params) => {
  await authenticate(req);
  const body = await parseBody(req);
  db.prepare('UPDATE widgets SET name=?, type=?, content=?, position=?, sort_order=?, enabled=? WHERE id=?')
    .run(body.name, body.type, body.content || '', body.position || 'sidebar', body.sort_order || 0, body.enabled ? 1 : 0, params.id);
  json(res, db.prepare('SELECT * FROM widgets WHERE id = ?').get(params.id));
}, true);

route('DELETE', '/api/v1/admin/widgets/:id', async (req, res, params) => {
  await authenticate(req);
  db.prepare('DELETE FROM widgets WHERE id = ?').run(params.id);
  json(res, { message: '删除成功' });
});

// 自动备份 - 备份列表
route('GET', '/api/v1/admin/backup/list', async (req, res) => {
  await authenticate(req);
  const backupDir = join(ROOT_DIR, 'backend', 'data', 'backups');
  const backups = [];
  if (existsSync(backupDir)) {
    const entries = readdirSync(backupDir).filter(f => f.endsWith('.zip'));
    for (const f of entries) {
      const stat = statSync(join(backupDir, f));
      backups.push({ name: f, size: stat.size, created_at: stat.mtime.toISOString() });
    }
  }
  json(res, backups.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});
// 自动备份 - 下载备份
route('GET', '/api/v1/admin/backup/:name/download', async (req, res, params) => {
  await authenticate(req);
  const name = params.name;
  if (!name || name.includes('..')) return error(res, '无效文件名', 400);
  const fp = join(ROOT_DIR, 'backend', 'data', 'backups', name);
  if (!existsSync(fp)) return error(res, '备份不存在', 404);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  readFileSync(fp); // 确保文件存在
  const { createReadStream } = await import('node:fs');
  createReadStream(fp).pipe(res);
});
// 系统版本信息
route('GET', '/api/v1/admin/system/version', async (req, res) => {
  await authenticate(req);
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'backend', 'package.json'), 'utf8'));
  json(res, {
    version: pkg.version || '1.0.0',
    name: pkg.name || 'lill',
    node: process.version,
    platform: process.platform
  });
});
// 系统健康检查
route('GET', '/api/v1/admin/system/health', async (req, res) => {
  await authenticate(req);
  const dbStatus = (() => {
    try { db.prepare('SELECT 1').get(); return 'ok'; } catch { return 'error'; }
  })();
  const diskSpace = (() => {
    try {
      const stats = statfsSync(ROOT_DIR);
      return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    } catch { return null; }
  })();
  json(res, {
    status: dbStatus === 'ok' ? 'healthy' : 'unhealthy',
    database: dbStatus,
    disk: diskSpace,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});
// 系统监控 - 实时监控数据
route('GET', '/api/v1/admin/system/monitor', async (req, res) => {
  await authenticate(req);
  const mem = process.memoryUsage();
  json(res, {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB'
    },
    cpu: process.cpuUsage(),
    connections: 0
  });
});
// 日志分析 - 获取日志统计
route('GET', '/api/v1/admin/logs/stats', async (req, res) => {
  await authenticate(req);
  const stats = db.prepare("SELECT COUNT(*) as total, COUNT(DISTINCT action) as actions, COUNT(DISTINCT user_id) as users FROM logs").get();
  json(res, stats);
});
// 备份进度 - 获取备份进度
route('GET', '/api/v1/admin/backup/progress', async (req, res) => {
  await authenticate(req);
  // 简化版：返回当前备份状态
  json(res, { progress: 0, status: 'idle', message: '无备份任务' });
});
// 多站点支持 - 站点列表
route('GET', '/api/v1/admin/sites', async (req, res) => {
  await authenticate(req);
  // 简化版：返回当前站点信息
  const site = db.prepare('SELECT * FROM options WHERE key = ?').get('site_name');
  json(res, [{ id: 'default', name: site?.value || '默认站点', domain: req.headers.host }]);
});
// 多站点支持 - 切换站点
route('POST', '/api/v1/admin/sites/switch', async (req, res) => {
  await authenticate(req);
  const body = await parseBody(req);
  if (!body.siteId) return error(res, '缺少站点ID', 400);
  json(res, { message: '站点切换功能待实现' });
}, true);
}
