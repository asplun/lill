/** Article and page management routes. */
import { withTransaction } from './shared.js';

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, validators, uid, slugify, renderMD, plainText, authenticate, triggerHook } = ctx;
  const { route, canManagePost, validatePostWrite, logAction, activeThemeId, normalizePageTemplate, listPostsHandler } = helpers;
  const { THEMES_DIR } = ctx;

  /** 规范自定义别名：保留字母（含中文等 Unicode 字母）、数字与连字符，其余折叠为 - */
  const normalizeSlug = (raw) => String(raw).trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const slugTaken = (slug, excludeId) => !!db.prepare(
    excludeId ? 'SELECT id FROM posts WHERE slug = ? AND id != ?' : 'SELECT id FROM posts WHERE slug = ?'
  ).get(...(excludeId ? [slug, excludeId] : [slug]));
  /** 自动别名：优先使用标题，重复时追加 -2、-3…（对齐 WordPress/Typecho 习惯） */
  const autoSlug = (title, excludeId) => {
    const base = normalizeSlug(title) || 'post-' + Date.now().toString(36);
    let candidate = base, n = 2;
    while (slugTaken(candidate, excludeId)) candidate = base + '-' + n++;
    return candidate;
  };
  /** 解析请求里的别名：留空则自动生成，自定义则校验格式与唯一性 */
  const resolveSlug = (raw, title, excludeId) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return { slug: autoSlug(title, excludeId) };
    if (String(raw).trim().length > 200) return { error: '别名长度不能超过 200 个字符' };
    const slug = normalizeSlug(raw);
    if (!slug) return { error: '别名无效：请使用字母、数字、中文或连字符' };
    if (slugTaken(slug, excludeId)) return { error: '别名「' + slug + '」已被占用，请换一个', taken: true };
    return { slug };
  };
  // 统一存储为 SQLite 可直接比较的 UTC 时间；拒绝 Date 自动进位的非法日期。
  const normalizePublishedAt = value => {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
    if (!match) return null;
    const wallTime = `${match[1]}T${match[2]}:${match[3] || '00'}`;
    const wallDate = new Date(wallTime + 'Z');
    if (!Number.isFinite(wallDate.getTime()) || wallDate.toISOString().slice(0, 19) !== wallTime) return null;
    const date = new Date(wallTime + (match[4] || '') + (match[5] || 'Z'));
    if (!Number.isFinite(date.getTime())) return null;
    const iso = date.toISOString();
    return iso.length === 24 ? iso.slice(0, 19).replace('T', ' ') : null;
  };
  const nowPublishedAt = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const validateWrite = body => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '内容参数必须是对象';
    if (body.type !== undefined && !['post', 'page'].includes(body.type)) return '无效内容类型，仅支持 post/page';
    if (body.status !== undefined && !['draft', 'published', 'pending'].includes(body.status)) return '无效内容状态，仅支持 draft/published/pending';
    if (body.visibility !== undefined && body.visibility !== 'public') return '尚未支持非公开可见性，请勿提交私密或密码内容';
    if (body.password !== undefined && body.password !== null && body.password !== '') return '尚未支持密码保护内容';
    if (body.commentAllowed !== undefined && typeof body.commentAllowed !== 'boolean') return '允许评论必须为布尔值';
    if (body.order !== undefined && !Number.isSafeInteger(body.order)) return '页面顺序必须为整数';
    if (body.excerptAuto !== undefined && typeof body.excerptAuto !== 'boolean') return '自动摘要必须为布尔值';
    if (body.publishedAt !== undefined) {
      if (body.publishedAt === null || body.publishedAt === '') body.publishedAt = null;
      else {
        const date = normalizePublishedAt(body.publishedAt);
        if (!date) return '发布时间格式无效，请使用有效日期时间（YYYY-MM-DD HH:mm:ss 或 ISO 8601）';
        body.publishedAt = date;
      }
    }
    if (body.tagNames !== undefined) {
      if (!Array.isArray(body.tagNames) || body.tagNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 100)) return '标签必须是非空名称数组，每个名称不超过 100 个字符';
      body.tagNames = [...new Set(body.tagNames.map(name => name.trim()))];
    }
    return null;
  };
  // 必须在文章事务内调用；名称是标签身份，slug 冲突只影响新标签的 URL。
  const replaceTags = (postId, names) => {
    const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
    const slugExists = db.prepare('SELECT id FROM tags WHERE slug = ?');
    const insertTag = db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)');
    const linkTag = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)');
    db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(postId);
    for (const name of names) {
      let tag = findTag.get(name);
      if (!tag) {
        const base = slugify(name) || 'tag-' + uid();
        let slug = base, suffix = 2;
        while (slugExists.get(slug)) slug = base + '-' + suffix++;
        tag = { id: uid() };
        insertTag.run(tag.id, name, slug);
      }
      linkTag.run(postId, tag.id);
    }
  };
  route('GET', '/api/v1/admin/posts', (req, res) => listPostsHandler(req, res));
  route('GET', '/api/v1/admin/pages', (req, res) => listPostsHandler(req, res, 'page'));
  route('GET', '/api/v1/admin/page-templates', async (req, res) => {
    await authenticate(req);
    const themeId = activeThemeId();
    json(res, { theme: themeId, templates: (await import('../../lib/themes.js')).scanPageTemplates(themeId, THEMES_DIR) });
  });
  route('POST', '/api/v1/admin/posts', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    const invalid = validateWrite(body);
    if (invalid) return error(res, invalid, 400);
    const denied = validatePostWrite(auth, body);
    if (denied) return error(res, denied, 403);
    validators.required(body.title, '标题');
    validators.string(body.title, '标题', 200);
    if (body.content !== undefined) validators.string(body.content, '内容', 50000);
    const id = uid();
    const slugResult = resolveSlug(body.slug, body.title);
    if (slugResult.error) return error(res, slugResult.error, slugResult.taken ? 409 : 400);
    const slug = slugResult.slug;
    const status = body.status ?? 'draft';
    const publishedAt = body.publishedAt || (status === 'published' ? nowPublishedAt() : null);
    const automaticExcerpt = body.excerptAuto ?? !body.excerpt;
    const excerpt = automaticExcerpt ? plainText(body.content || '').substring(0, 200) : (body.excerpt || '');
    const tpl = normalizePageTemplate(body.type || 'post', body.template);
    withTransaction(db, () => {
      db.prepare('INSERT INTO posts (id, title, slug, content, html_content, excerpt, cover_image, type, status, sticky, published_at, author_id, category_id, fields, template, comment_allowed, "order", excerpt_auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, body.title, slug, body.content || '', renderMD(body.content || ''), excerpt, body.coverImage || null, body.type || 'post', status, body.sticky ? 1 : 0, publishedAt, auth.id, body.categoryId || null, JSON.stringify(body.fields || {}), tpl, body.commentAllowed === false ? 0 : 1, body.order ?? 0, automaticExcerpt ? 1 : 0);
      if (body.tagNames !== undefined) replaceTags(id, body.tagNames);
    });
    logAction(auth.id, 'post.create', '创建文章: ' + body.title, req);
    const created = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    try { triggerHook('post.saved', created, { isNew: true }); } catch {}
    json(res, created, 201);
  });
  route('PUT', '/api/v1/admin/posts/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    const exist = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    if (!exist) return error(res, '文章不存在', 404);
    if (!canManagePost(auth, exist)) return error(res, '无权限', 403);
    const body = await parseBody(req);
    const invalid = validateWrite(body);
    if (invalid) return error(res, invalid, 400);
    const denied = validatePostWrite(auth, body);
    if (denied) return error(res, denied, 403);
    if (body.title !== undefined) validators.string(body.title, '标题', 200);
    if (body.content !== undefined) validators.string(body.content, '内容', 50000);
    const updates = [], args = [];
    const fields = [['title','title'],['content','content'],['coverImage','cover_image'],['type','type'],['status','status'],['sticky','sticky'],['order','"order"'],['categoryId','category_id']];
    // 自定义别名单独处理：留空保持原值，避免误改导致旧链接失效
    if (body.slug !== undefined && String(body.slug).trim() !== '') {
      const slugResult = resolveSlug(body.slug, exist.title, exist.id);
      if (slugResult.error) return error(res, slugResult.error, slugResult.taken ? 409 : 400);
      updates.push('slug = ?'); args.push(slugResult.slug);
    }
    if (body.template !== undefined) { updates.push('template = ?'); args.push(normalizePageTemplate(body.type || exist.type, body.template)); }
    for (const [f, d] of fields) if (body[f] !== undefined) { updates.push(d + ' = ?'); args.push(f === 'sticky' ? (body[f] ? 1 : 0) : body[f]); }
    if (body.content !== undefined) updates.push('html_content = ?'), args.push(renderMD(body.content));
    if (body.commentAllowed !== undefined) updates.push('comment_allowed = ?'), args.push(body.commentAllowed ? 1 : 0);
    const automaticExcerpt = body.excerptAuto ?? (body.excerpt !== undefined ? !body.excerpt : exist.excerpt_auto === 1);
    if (body.excerpt !== undefined || body.excerptAuto !== undefined || (automaticExcerpt && body.content !== undefined)) {
      updates.push('excerpt = ?', 'excerpt_auto = ?');
      args.push(automaticExcerpt ? plainText(body.content ?? exist.content).slice(0, 200) : (body.excerpt ?? exist.excerpt ?? ''), automaticExcerpt ? 1 : 0);
    }
    const status = body.status ?? exist.status;
    if (body.publishedAt !== undefined || (status === 'published' && !exist.published_at)) {
      updates.push('published_at = ?');
      args.push(body.publishedAt || (status === 'published' ? (exist.published_at || nowPublishedAt()) : null));
    }
    if (body.fields) updates.push('fields = ?'), args.push(JSON.stringify(body.fields));
    withTransaction(db, () => {
      db.prepare('INSERT INTO post_versions (id, post_id, title, content, html_content, excerpt, status, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uid(), exist.id, exist.title, exist.content, exist.html_content, exist.excerpt, exist.status, exist.author_id);
      if (updates.length) { args.push(params.id); db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`).run(...args); }
      if (body.tagNames !== undefined) replaceTags(params.id, body.tagNames);
    });
    logAction(auth.id, 'post.update', '更新文章: ' + (body.title || exist.title), req);
    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    try { triggerHook('post.saved', updated, { isNew: false }); } catch {}
    json(res, updated);
  });
  route('GET', '/api/v1/admin/posts/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    if (!post) return error(res, '文章不存在', 404);
    if (!canManagePost(auth, post)) return error(res, '无权限', 403);
    const tags = db.prepare('SELECT t.id, t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?').all(params.id);
    json(res, { ...post, tags });
  });
  route('DELETE', '/api/v1/admin/posts/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    const exist = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    if (!exist) return error(res, '文章不存在', 404);
    if (!canManagePost(auth, exist)) return error(res, '无权限', 403);
    db.prepare('DELETE FROM posts WHERE id = ?').run(params.id);
    logAction(auth.id, 'post.delete', '删除文章: ' + exist.title, req);
    try { triggerHook('post.deleted', exist); } catch {}
    json(res, { id: params.id });
  });
  route('GET', '/api/v1/admin/posts/recent', async (req, res) => {
    const auth = await authenticate(req);
    let where = helpers.managesAll(auth) ? '' : ' AND p.author_id = ?';
    if (auth.role === 'contributor') where += " AND p.status = 'draft'";
    const args = helpers.managesAll(auth) ? [] : [auth.id];
    const items = db.prepare(`SELECT p.id, p.title, p.slug, p.type, p.status, p.created_at, u.username as author_name, c.name as category_name FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id WHERE p.type = ? ${where} ORDER BY p.created_at DESC LIMIT 5`).all('post', ...args);
    json(res, items);
  });
  route('POST', '/api/v1/admin/posts/batch', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!body.ids || !Array.isArray(body.ids)) return error(res, '缺少文章ID列表', 400);
    if (!['publish', 'draft', 'delete'].includes(body.action)) return error(res, '无效操作');
    if (auth.role === 'contributor' && body.action === 'publish') return error(res, '投稿者不能发布文章', 403);
    for (const id of body.ids) {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
      if (!post) return error(res, '文章不存在', 404);
      if (!canManagePost(auth, post)) return error(res, '无权限', 403);
    }
    withTransaction(db, () => {
      if (body.action === 'delete') {
        const stmt = db.prepare('DELETE FROM posts WHERE id = ?');
        for (const id of body.ids) stmt.run(id);
      } else {
        const status = body.action === 'publish' ? 'published' : 'draft';
        const stmt = db.prepare(body.action === 'publish'
          ? "UPDATE posts SET status = ?, published_at = COALESCE(NULLIF(published_at, ''), ?) WHERE id = ?"
          : 'UPDATE posts SET status = ? WHERE id = ?');
        const publishedAt = nowPublishedAt();
        for (const id of body.ids) stmt.run(...(body.action === 'publish' ? [status, publishedAt, id] : [status, id]));
      }
    });
    json(res, { updated: body.ids.length });
  });
}
