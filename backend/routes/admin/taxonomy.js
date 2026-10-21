/** Category and tag management routes. */
import { boundedPagination } from '../../lib/http.js';
import { withTransaction } from './shared.js';

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
    // post_count 走多分类关系表，才能统计到「非主分类」的文章；DISTINCT 防止关系表与 category_id 重复计数。
    const items = db.prepare('SELECT c.*, (SELECT COUNT(DISTINCT p.id) FROM posts p WHERE (p.category_id = c.id OR p.id IN (SELECT post_id FROM post_categories WHERE category_id = c.id))) as post_count, p.name as parent_name FROM categories c LEFT JOIN categories p ON c.parent_id = p.id ORDER BY c.sort_order, c.name').all();
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
      db.prepare('DELETE FROM post_categories WHERE category_id = ?').run(params.id);
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
    const items = db.prepare('SELECT t.*, (SELECT COUNT(*) FROM post_tags WHERE tag_id = t.id) as post_count FROM tags t ORDER BY t.sort_order, t.name LIMIT ? OFFSET ?').all(pageSize, offset);
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

  const batchIds = value => {
    if (!Array.isArray(value) || !value.length) throw new Error('缺少有效的ID列表');
    const ids = value.filter(id => typeof id === 'string' && id.trim());
    if (!ids.length) throw new Error('缺少有效的ID列表');
    return [...new Set(ids)];
  };

  const reorderItems = value => {
    if (!Array.isArray(value) || !value.length) throw new Error('缺少排序项');
    if (value.length > 500) throw new Error('一次最多调整 500 项');
    const seen = new Set();
    return value.map(row => {
      if (!row || typeof row.id !== 'string' || !row.id.trim()) throw new Error('排序项缺少 ID');
      if (seen.has(row.id)) throw new Error('排序项重复：' + row.id);
      seen.add(row.id);
      const order = Number(row.sortOrder);
      if (!Number.isSafeInteger(order) || order < 0 || order > 100000) throw new Error('排序值必须是 0-100000 的整数');
      return { id: row.id, order };
    });
  };

  route('POST', '/api/v1/admin/categories/reorder', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    let items;
    try { items = reorderItems(body.items); } catch (e) { return error(res, e.message, 400); }
    for (const item of items) {
      if (!category(item.id)) return error(res, '分类不存在：' + item.id, 404);
    }
    withTransaction(db, () => {
      const update = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
      for (const item of items) update.run(item.order, item.id);
    });
    json(res, { updated: items.length });
  });

  route('POST', '/api/v1/admin/tags/reorder', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    let items;
    try { items = reorderItems(body.items); } catch (e) { return error(res, e.message, 400); }
    for (const item of items) {
      if (!tag(item.id)) return error(res, '标签不存在：' + item.id, 404);
    }
    withTransaction(db, () => {
      const update = db.prepare('UPDATE tags SET sort_order = ? WHERE id = ?');
      for (const item of items) update.run(item.order, item.id);
    });
    json(res, { updated: items.length });
  });

  route('POST', '/api/v1/admin/categories/batch', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    if (body.action !== 'delete') return error(res, '无效操作', 400);
    let ids;
    try { ids = batchIds(body.ids); } catch (e) { return error(res, e.message, 400); }
    const selected = new Set(ids);
    const names = new Map();
    for (const id of ids) {
      const row = category(id);
      if (!row) return error(res, '分类不存在：' + id, 404);
      names.set(id, row.name);
    }
    const blocked = [];
    for (const id of ids) {
      const children = db.prepare('SELECT id, name FROM categories WHERE parent_id = ?').all(id)
        .filter(row => !selected.has(row.id));
      if (children.length) blocked.push(names.get(id) + '（' + children.map(c => c.name).join('、') + '）');
    }
    if (blocked.length) return error(res, '以下分类仍有子分类，请先调整：' + blocked.join('；'), 409);
    withTransaction(db, () => {
      const unset = db.prepare('UPDATE posts SET category_id = NULL WHERE category_id = ?');
      const dropLinks = db.prepare('DELETE FROM post_categories WHERE category_id = ?');
      const del = db.prepare('DELETE FROM categories WHERE id = ?');
      for (const id of ids) { unset.run(id); dropLinks.run(id); del.run(id); }
    });
    for (const id of ids) {
      try { if (typeof triggerHook === 'function') triggerHook('category.deleted', id); } catch {}
    }
    json(res, { deleted: ids.length });
  });

  route('POST', '/api/v1/admin/tags/batch', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    if (body.action !== 'delete') return error(res, '无效操作', 400);
    let ids;
    try { ids = batchIds(body.ids); } catch (e) { return error(res, e.message, 400); }
    for (const id of ids) {
      if (!tag(id)) return error(res, '标签不存在：' + id, 404);
    }
    withTransaction(db, () => {
      const unlink = db.prepare('DELETE FROM post_tags WHERE tag_id = ?');
      const del = db.prepare('DELETE FROM tags WHERE id = ?');
      for (const id of ids) { unlink.run(id); del.run(id); }
    });
    for (const id of ids) {
      try { if (typeof triggerHook === 'function') triggerHook('tag.deleted', id); } catch {}
    }
    json(res, { deleted: ids.length });
  });
}
