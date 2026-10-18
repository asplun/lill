/** Category and tag management routes. */
import { boundedPagination } from '../../lib/http.js';

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, validators, uid, slugify, authenticate, triggerHook } = ctx;
  const { route } = helpers;
  const category = id => db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  const categoryBySlug = (slug, excludeId = '') => db.prepare('SELECT id FROM categories WHERE slug = ? AND id != ?').get(slug, excludeId);
  const categoryByName = (name, excludeId = '') => db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(name, excludeId);
  const tag = id => db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
  const tagBySlug = (slug, excludeId = '') => db.prepare('SELECT id FROM tags WHERE slug = ? AND id != ?').get(slug, excludeId);
  const tagByName = (name, excludeId = '') => db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(name, excludeId);
  const validateParent = (parentId, ownId = '') => {
    if (parentId === undefined || parentId === null || parentId === '') return { parentId: null };
    if (typeof parentId !== 'string') return { error: '父级分类无效' };
    if (parentId === ownId) return { error: '分类不能以自身作为父级' };
    if (!category(parentId)) return { error: '父级分类不存在' };
    const seen = new Set();
    let cursor = parentId;
    while (cursor) {
      if (cursor === ownId) return { error: '分类父级不能形成循环' };
      if (seen.has(cursor)) return { error: '分类父级不能形成循环' };
      seen.add(cursor);
      cursor = category(cursor)?.parent_id || null;
    }
    return { parentId };
  };

  route('GET', '/api/v1/admin/categories', async (req, res) => {
    await authenticate(req);
    const items = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM posts WHERE category_id = c.id) as post_count, p.name as parent_name FROM categories c LEFT JOIN categories p ON c.parent_id = p.id ORDER BY c.sort_order, c.name').all();
    json(res, items);
  });

  route('POST', '/api/v1/admin/categories', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    validators.required(body.name, '分类名称');
    body.name = validators.string(body.name, '分类名称', 100);
    const parent = validateParent(body.parentId);
    if (parent.error) return error(res, parent.error, 400);
    const slug = body.slug ? slugify(body.slug) : slugify(body.name);
    if (categoryByName(body.name) || categoryBySlug(slug)) return error(res, '分类名称或别名已存在', 409);
    const id = uid();
    db.prepare('INSERT INTO categories (id, name, slug, description, parent_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(id, body.name, slug, body.description || null, parent.parentId, body.sortOrder || 0);
    try { if (typeof triggerHook === 'function') triggerHook('category.created', db.prepare('SELECT * FROM categories WHERE id = ?').get(id)); } catch {}
    json(res, db.prepare('SELECT * FROM categories WHERE id = ?').get(id), 201);
  });

  route('PUT', '/api/v1/admin/categories/:id', async (req, res, params) => {
    await authenticate(req);
    if (!category(params.id)) return error(res, '分类不存在', 404);
    const body = await parseBody(req);
    validators.required(body.name, '分类名称');
    body.name = validators.string(body.name, '分类名称', 100);
    const parent = validateParent(body.parentId, params.id);
    if (parent.error) return error(res, parent.error, 400);
    const slug = body.slug ? slugify(body.slug) : slugify(body.name);
    if (categoryByName(body.name, params.id) || categoryBySlug(slug, params.id)) return error(res, '分类名称或别名已存在', 409);
    db.prepare('UPDATE categories SET name = ?, slug = ?, description = ?, parent_id = ?, sort_order = ? WHERE id = ?').run(body.name, slug, body.description || null, parent.parentId, body.sortOrder || 0, params.id);
    try { if (typeof triggerHook === 'function') triggerHook('category.updated', db.prepare('SELECT * FROM categories WHERE id = ?').get(params.id)); } catch {}
    json(res, db.prepare('SELECT * FROM categories WHERE id = ?').get(params.id));
  });

  route('DELETE', '/api/v1/admin/categories/:id', async (req, res, params) => {
    await authenticate(req);
    if (!category(params.id)) return error(res, '分类不存在', 404);
    if (db.prepare('SELECT id FROM categories WHERE parent_id = ? LIMIT 1').get(params.id)) {
      return error(res, '该分类仍有子分类，请先调整子分类父级', 409);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE posts SET category_id = NULL WHERE category_id = ?').run(params.id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(params.id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
    try { if (typeof triggerHook === 'function') triggerHook('category.deleted', params.id); } catch {}
    json(res, { id: params.id });
  });

  route('GET', '/api/v1/admin/tags', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { page, pageSize, offset } = boundedPagination(url.searchParams, 50, 100);
    const total = db.prepare('SELECT COUNT(*) as c FROM tags').get().c;
    const items = db.prepare('SELECT t.*, (SELECT COUNT(*) FROM post_tags WHERE tag_id = t.id) as post_count FROM tags t ORDER BY t.name LIMIT ? OFFSET ?').all(pageSize, offset);
    json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
  });

  route('POST', '/api/v1/admin/tags', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    validators.required(body.name, '标签名称');
    body.name = validators.string(body.name, '标签名称', 100);
    const slug = body.slug ? slugify(body.slug) : slugify(body.name);
    if (tagByName(body.name) || tagBySlug(slug)) return error(res, '标签名称或别名已存在', 409);
    const id = uid();
    db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)').run(id, body.name, slug);
    try { if (typeof triggerHook === 'function') triggerHook('tag.created', db.prepare('SELECT * FROM tags WHERE id = ?').get(id)); } catch {}
    json(res, db.prepare('SELECT * FROM tags WHERE id = ?').get(id), 201);
  });

  route('PUT', '/api/v1/admin/tags/:id', async (req, res, params) => {
    await authenticate(req);
    if (!tag(params.id)) return error(res, '标签不存在', 404);
    const body = await parseBody(req);
    validators.required(body.name, '标签名称');
    body.name = validators.string(body.name, '标签名称', 100);
    const slug = body.slug ? slugify(body.slug) : slugify(body.name);
    if (tagByName(body.name, params.id) || tagBySlug(slug, params.id)) return error(res, '标签名称或别名已存在', 409);
    db.prepare('UPDATE tags SET name = ?, slug = ? WHERE id = ?').run(body.name, slug, params.id);
    try { if (typeof triggerHook === 'function') triggerHook('tag.updated', db.prepare('SELECT * FROM tags WHERE id = ?').get(params.id)); } catch {}
    json(res, db.prepare('SELECT * FROM tags WHERE id = ?').get(params.id));
  });

  route('DELETE', '/api/v1/admin/tags/:id', async (req, res, params) => {
    await authenticate(req);
    if (!tag(params.id)) return error(res, '标签不存在', 404);
    db.prepare('DELETE FROM post_tags WHERE tag_id = ?').run(params.id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(params.id);
    try { if (typeof triggerHook === 'function') triggerHook('tag.deleted', params.id); } catch {}
    json(res, { id: params.id });
  });
}
