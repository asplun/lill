/**
 * lill 公开 API（前台使用，无需登录）
 * 由 server.js 调用 register(router, ctx) 装配
 */
export function register(router, ctx) {
  const { db, json, error, parseBody, validators, uid, slugify, renderMD, authenticate, readThemeManifest } = ctx;
  const route = router.route;

// ════════════════════════════════════════
// 永久链接处理
// ════════════════════════════════════════
function getPermalinkUrl(type, post, category, tag) {
  const getOpt = (k, d) => { const r = db.prepare('SELECT value FROM options WHERE key = ?').get(k); return (r && r.value) || d; };
  const siteUrl = getOpt('site_url', '').replace(/\/$/, '');
  
  if (type === 'post') {
    const format = getOpt('permalink', '/archives/{cid}/');
    const cid = post.id;
    const slug = post.slug;
    const categorySlug = category ? category.slug : '';
    const year = post.published_at ? post.published_at.substring(0, 4) : '';
    const month = post.published_at ? post.published_at.substring(5, 7) : '';
    const path = format
      .replace('{cid}', cid)
      .replace('{slug}', slug)
      .replace('{category}', categorySlug)
      .replace('{year}', year)
      .replace('{month}', month);
    return { url: siteUrl + path, route: '/post/' + slug };
  }
  if (type === 'category') {
    const format = getOpt('category_prefix', '/category/{slug}/');
    const path = format.replace('{slug}', category.slug).replace('{mid}', category.id);
    return { url: siteUrl + path, route: '/category/' + category.slug };
  }
  if (type === 'tag') {
    const format = getOpt('tag_prefix', '/tag/{slug}/');
    const path = format.replace('{slug}', tag.slug).replace('{mid}', tag.id);
    return { url: siteUrl + path, route: '/tag/' + tag.slug };
  }
  return { url: '', route: '' };
}


// 文章列表（支持分页、分类、标签、关键词搜索）
route('GET', '/api/v1/posts', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = parseInt(url.searchParams.get('page')) || 1;
  const pageSize = parseInt(url.searchParams.get('pageSize')) || 10;
  const status = url.searchParams.get('status') || 'published';
  const typeFilter = url.searchParams.get('type') || 'post';
  const categoryId = url.searchParams.get('categoryId');
  const categorySlug = url.searchParams.get('categorySlug');
  const tag = url.searchParams.get('tag');
  const keyword = url.searchParams.get('keyword');
  const full = url.searchParams.get('full') === '1';

  let where = `WHERE p.status = ? AND p.type = ?`;
  const params = [status, typeFilter];
  if (categoryId) { where += ' AND p.category_id = ?'; params.push(categoryId); }
  if (categorySlug) { where += ' AND p.category_id = (SELECT id FROM categories WHERE slug = ?)'; params.push(categorySlug); }
  if (tag) { where += ' AND p.id IN (SELECT post_id FROM post_tags WHERE tag_id = (SELECT id FROM tags WHERE slug = ?))'; params.push(tag); }
  if (keyword) { where += ' AND (p.title LIKE ? OR p.excerpt LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM posts p ${where}`).get(...params)).c;
  const items = db.prepare(`
    SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.view_count, p.sticky, p.published_at,
           u.nickname as author_nickname, c.name as category_name, c.slug as category_slug${full ? ', p.html_content' : ''}
    FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id
    ${where} ORDER BY p.sticky DESC, p.published_at DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  // 为每篇文章生成 permalink URL
  const catMap = {};
  db.prepare('SELECT id, slug FROM categories').all().forEach(c => catMap[c.id] = c.slug);
  items.forEach(p => { const r = getPermalinkUrl('post', p, p.category_id ? { slug: catMap[p.category_id] } : null); p.url = r.url; p.route = r.route; });
  json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
});

// 独立页面列表（导航菜单用）
route('GET', '/api/v1/pages', async (req, res) => {
  const pages = db.prepare(`SELECT id, title, slug, excerpt, created_at FROM posts WHERE type = 'page' AND status = 'published' ORDER BY "order" ASC, created_at ASC`).all();
  json(res, pages);
});

// 归档（按年月分组，侧边栏 Widget）
route('GET', '/api/v1/archives', async (req, res) => {
  const rows = db.prepare(`SELECT strftime('%Y-%m', published_at) as ym, COUNT(*) as count FROM posts WHERE type = 'post' AND status = 'published' AND published_at IS NOT NULL GROUP BY ym ORDER BY ym DESC`).all();
  json(res, rows);
});

// 最新评论（侧边栏 Widget）
route('GET', '/api/v1/comments/recent', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit')) || 5;
  const items = db.prepare(`
    SELECT c.id, c.content, c.created_at, c.author_name, c.post_id,
           p.title as post_title, p.slug as post_slug, u.nickname, u.avatar
    FROM comments c LEFT JOIN posts p ON c.post_id = p.id LEFT JOIN users u ON c.user_id = u.id
    WHERE c.status = 'approved' ORDER BY c.created_at DESC LIMIT ?
  `).all(limit);
  // 为每条评论生成 post_url 和 post_route
  items.forEach(c => {
    c.post_url = '/post/' + c.post_slug;
    c.post_route = '/post/' + c.post_slug;
  });
  json(res, items);
});

// 文章详情（含标签、上下篇导航）
route('GET', '/api/v1/posts/:slug', async (req, res, params) => {
  const post = db.prepare('SELECT p.*, u.nickname as author_nickname, u.avatar as author_avatar, c.name as category_name, c.slug as category_slug FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id WHERE p.slug = ?').get(params.slug);
  if (!post) return error(res, '文章不存在', 404);
  post.tags = db.prepare('SELECT t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?').all(post.id);
  post.prev = db.prepare(`SELECT title, slug FROM posts WHERE type = ? AND status = 'published' AND published_at < ? ORDER BY published_at DESC LIMIT 1`).get(post.type, post.published_at) || null;
  post.next = db.prepare(`SELECT title, slug FROM posts WHERE type = ? AND status = 'published' AND published_at > ? ORDER BY published_at ASC LIMIT 1`).get(post.type, post.published_at) || null;
  db.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').run(post.id);
  const postUrlResult = getPermalinkUrl('post', post, post.category_id ? { slug: post.category_slug } : null); post.url = postUrlResult.url; post.route = postUrlResult.route;
  json(res, post);
});

// RSS Feed（Nginx /feed.xml 反向代理到此）
route('GET', '/api/v1/feed', async (req, res) => {
  const getOpt = (k, d) => { const r = db.prepare('SELECT value FROM options WHERE key = ?').get(k); return (r && r.value) || d; };
  const siteName = getOpt('site_name', 'lill 博客');
  const siteDesc = getOpt('site_description', '');
  const siteUrl = getOpt('site_url', 'https://test.abohe.cn').replace(/\/$/, '');
  const posts = db.prepare(`SELECT title, slug, excerpt, published_at FROM posts WHERE type = 'post' AND status = 'published' ORDER BY published_at DESC LIMIT 20`).all();
  const x = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n';
  xml += '<title>' + x(siteName) + '</title>\n<link>' + x(siteUrl) + '</link>\n<description>' + x(siteDesc) + '</description>\n';
  xml += '<language>zh-CN</language>\n<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n';
  for (const p of posts) {
    const link = siteUrl + '/post/' + encodeURIComponent(p.slug);
    xml += '<item>\n<title>' + x(p.title) + '</title>\n<link>' + x(link) + '</link>\n<guid isPermaLink="true">' + x(link) + '</guid>\n';
    xml += '<description>' + x(p.excerpt || '') + '</description>\n';
    if (p.published_at) xml += '<pubDate>' + new Date(String(p.published_at).replace(' ', 'T') + 'Z').toUTCString() + '</pubDate>\n';
    xml += '</item>\n';
  }
  xml += '</channel></rss>';
  res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  res.end(xml);
});

route('GET', '/api/v1/categories', async (req, res) => {
  const cats = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM posts WHERE category_id = c.id AND status = \'published\') as post_count FROM categories c ORDER BY sort_order').all();
  cats.forEach(c => { const r = getPermalinkUrl('category', null, c); c.url = r.url; c.route = r.route; });
  json(res, cats);
});

route('GET', '/api/v1/tags', async (req, res) => {
  const tags = db.prepare('SELECT t.*, (SELECT COUNT(*) FROM post_tags pt JOIN posts p ON p.id = pt.post_id WHERE pt.tag_id = t.id AND p.status = \'published\') as post_count FROM tags t ORDER BY t.name').all();
  tags.forEach(t => { const r = getPermalinkUrl('tag', null, null, t); t.url = r.url; t.route = r.route; });
  json(res, tags);
});

route('GET', '/api/v1/options/public', async (req, res) => {
  const rows = db.prepare('SELECT key, value FROM options WHERE autoload = 1').all();
  const r = {}; rows.forEach(x => r[x.key] = x.value);
  const activeTheme = db.prepare('SELECT * FROM themes WHERE active = 1').get();
  if (activeTheme) {
    let saved = {};
    try { saved = JSON.parse(activeTheme.config || '{}'); } catch (e) { saved = {}; }
    // 合并主题 manifest 的默认值，前端无需重复定义
    const manifest = readThemeManifest(activeTheme.theme_id);
    const defaults = {};
    if (manifest && manifest.settings) {
      manifest.settings.forEach(f => { if (f.default !== undefined) defaults[f.key] = f.default; });
    }
    r.theme_config = { ...defaults, ...saved };
    r.active_theme = activeTheme.theme_id;
    r.theme_meta = manifest ? { name: manifest.name, version: manifest.version, author: manifest.author } : {};
  }
  json(res, r);
});

route('GET', '/api/v1/comments', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const postId = url.searchParams.get('postId');
  if (!postId) return error(res, '缺少 postId');
  const page = parseInt(url.searchParams.get('page')) || 1;
  const ps = parseInt(url.searchParams.get('pageSize')) || 20;
  const total = (db.prepare('SELECT COUNT(*) as c FROM comments WHERE post_id = ? AND status = ? AND parent_id IS NULL').get(postId, 'approved')).c;
  const items = db.prepare('SELECT c.*, u.username, u.nickname, u.avatar FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.post_id = ? AND c.status = ? AND c.parent_id IS NULL ORDER BY c.created_at DESC LIMIT ? OFFSET ?').all(postId, 'approved', ps, (page - 1) * ps);
  for (const c of items) c.replies = db.prepare('SELECT c.*, u.username, u.nickname, u.avatar FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.parent_id = ? AND c.status = ? ORDER BY c.created_at ASC').all(c.id, 'approved');
  json(res, { items, meta: { total, page, pageSize: ps, totalPages: Math.ceil(total / ps), hasNext: page * ps < total, hasPrev: page > 1 } });
});

route('POST', '/api/v1/comments', async (req, res) => {
  const body = await parseBody(req);
  validators.required(body.postId, '文章ID');
  validators.required(body.content, '评论内容');
  validators.string(body.content, '评论内容', 2000);
  if (body.authorName) validators.string(body.authorName, '昵称', 50);
  if (body.authorEmail) validators.email(body.authorEmail, '邮箱');
  if (body.authorUrl) validators.url(body.authorUrl, '网站');
  const moderation = db.prepare('SELECT value FROM options WHERE key = ?').get('comment_moderation');
  const needModeration = !moderation || moderation.value !== 'false';
  const status = needModeration ? 'pending' : 'approved';
  const id = uid();
  db.prepare('INSERT INTO comments (id, content, post_id, parent_id, user_id, author_name, author_email, author_url, user_agent, ip, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, body.content, body.postId, body.parentId || null, body.userId || null, body.authorName || null, body.authorEmail || null, body.authorUrl || null, req.headers['user-agent'] || '', req.socket.remoteAddress || '', status);
  json(res, { id, status }, 201);
});

}
