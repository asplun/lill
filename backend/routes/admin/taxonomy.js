/** Category and tag management routes. */
export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, validators, uid, slugify, authenticate } = ctx;
  const { route } = helpers;

  route('GET', '/api/v1/admin/categories', async (req, res) => {
    await authenticate(req);
    const items = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM posts WHERE category_id = c.id) as post_count, p.name as parent_name FROM categories c LEFT JOIN categories p ON c.parent_id = p.id ORDER BY c.sort_order, c.name').all();
    json(res, items);
  });

  route('POST', '/api/v1/admin/categories', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    validators.required(body.name, '分类名称');
    validators.string(body.name, '分类名称', 100);
    const id = uid();
    db.prepare('INSERT INTO categories (id, name, slug, description, parent_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(id, body.name, body.slug || slugify(body.name), body.description || null, body.parentId || null, body.sortOrder || 0);
    json(res, db.prepare('SELECT * FROM categories WHERE id = ?').get(id), 201);
  });

  route('PUT', '/api/v1/admin/categories/:id', async (req, res, params) => {
    await authenticate(req);
    const body = await parseBody(req);
    db.prepare('UPDATE categories SET name = ?, slug = ?, description = ?, parent_id = ?, sort_order = ? WHERE id = ?').run(body.name, body.slug || slugify(body.name), body.description || null, body.parentId || null, body.sortOrder || 0, params.id);
    json(res, db.prepare('SELECT * FROM categories WHERE id = ?').get(params.id));
  });

  route('DELETE', '/api/v1/admin/categories/:id', async (req, res, params) => {
    await authenticate(req);
    db.prepare('UPDATE posts SET category_id = NULL WHERE category_id = ?').run(params.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(params.id);
    json(res, { id: params.id });
  });

  route('GET', '/api/v1/admin/tags', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const pageSize = parseInt(url.searchParams.get('pageSize')) || 50;
    const total = db.prepare('SELECT COUNT(*) as c FROM tags').get().c;
    const items = db.prepare('SELECT t.*, (SELECT COUNT(*) FROM post_tags WHERE tag_id = t.id) as post_count FROM tags t ORDER BY t.name LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize);
    json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
  });

  route('POST', '/api/v1/admin/tags', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    validators.required(body.name, '标签名称');
    validators.string(body.name, '标签名称', 100);
    const id = uid();
    db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)').run(id, body.name, body.slug || slugify(body.name));
    json(res, db.prepare('SELECT * FROM tags WHERE id = ?').get(id), 201);
  });

  route('PUT', '/api/v1/admin/tags/:id', async (req, res, params) => {
    await authenticate(req);
    const body = await parseBody(req);
    db.prepare('UPDATE tags SET name = ?, slug = ? WHERE id = ?').run(body.name, body.slug || slugify(body.name), params.id);
    json(res, db.prepare('SELECT * FROM tags WHERE id = ?').get(params.id));
  });

  route('DELETE', '/api/v1/admin/tags/:id', async (req, res, params) => {
    await authenticate(req);
    db.prepare('DELETE FROM post_tags WHERE tag_id = ?').run(params.id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(params.id);
    json(res, { id: params.id });
  });
}
