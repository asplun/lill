/** Sidebar widget management routes. */
export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, uid, authenticate } = ctx;
  const { route } = helpers;

  route('GET', '/api/v1/admin/widgets', async (req, res) => {
    await authenticate(req);
    json(res, db.prepare('SELECT * FROM widgets ORDER BY sort_order ASC').all());
  });

  route('POST', '/api/v1/admin/widgets', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    if (!body.name || !body.type) return error(res, '缺少必要参数', 400);
    const id = uid();
    db.prepare('INSERT INTO widgets (id, name, type, content, position, sort_order, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.type, body.content || '', body.position || 'sidebar', body.sort_order || 0, body.enabled ? 1 : 0);
    json(res, db.prepare('SELECT * FROM widgets WHERE id = ?').get(id), 201);
  });

  route('PUT', '/api/v1/admin/widgets/:id', async (req, res, params) => {
    await authenticate(req);
    const body = await parseBody(req);
    if (!body.name || !body.type) return error(res, '缺少必要参数', 400);
    db.prepare('UPDATE widgets SET name = ?, type = ?, content = ?, position = ?, sort_order = ?, enabled = ? WHERE id = ?')
      .run(body.name, body.type, body.content || '', body.position || 'sidebar', body.sort_order || 0, body.enabled ? 1 : 0, params.id);
    json(res, db.prepare('SELECT * FROM widgets WHERE id = ?').get(params.id));
  });

  route('DELETE', '/api/v1/admin/widgets/:id', async (req, res, params) => {
    await authenticate(req);
    db.prepare('DELETE FROM widgets WHERE id = ?').run(params.id);
    json(res, { message: '删除成功' });
  });
}
