/** Sidebar widget management routes. */
export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, uid, authenticate } = ctx;
  const { route } = helpers;
  const findWidget = id => db.prepare('SELECT * FROM widgets WHERE id = ?').get(id);
  const validate = body => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '组件参数无效';
    if (typeof body.name !== 'string' || !body.name.trim()) return '缺少组件名称';
    if (typeof body.type !== 'string' || !body.type.trim()) return '缺少组件类型';
    if (body.name.length > 100 || body.type.length > 50) return '组件名称或类型过长';
    if (body.content !== undefined && typeof body.content !== 'string') return '组件内容必须是字符串';
    if (body.position !== undefined && !['sidebar', 'left', 'right', 'footer'].includes(body.position)) return '组件位置无效';
    if (body.sort_order !== undefined && !Number.isSafeInteger(Number(body.sort_order))) return '组件排序必须是整数';
    return null;
  };

  route('GET', '/api/v1/admin/widgets', async (req, res) => {
    await authenticate(req);
    json(res, db.prepare('SELECT * FROM widgets ORDER BY sort_order ASC').all());
  });

  route('POST', '/api/v1/admin/widgets', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    const invalid = validate(body);
    if (invalid) return error(res, invalid, 400);
    const id = uid();
    db.prepare('INSERT INTO widgets (id, name, type, content, position, sort_order, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name.trim(), body.type.trim(), body.content || '', body.position || 'sidebar', Number(body.sort_order) || 0, body.enabled ? 1 : 0);
    json(res, db.prepare('SELECT * FROM widgets WHERE id = ?').get(id), 201);
  });

  route('PUT', '/api/v1/admin/widgets/:id', async (req, res, params) => {
    await authenticate(req);
    if (!findWidget(params.id)) return error(res, '组件不存在', 404);
    const body = await parseBody(req);
    const invalid = validate(body);
    if (invalid) return error(res, invalid, 400);
    db.prepare('UPDATE widgets SET name = ?, type = ?, content = ?, position = ?, sort_order = ?, enabled = ? WHERE id = ?')
      .run(body.name.trim(), body.type.trim(), body.content || '', body.position || 'sidebar', Number(body.sort_order) || 0, body.enabled ? 1 : 0, params.id);
    json(res, db.prepare('SELECT * FROM widgets WHERE id = ?').get(params.id));
  });

  route('DELETE', '/api/v1/admin/widgets/:id', async (req, res, params) => {
    await authenticate(req);
    if (!findWidget(params.id)) return error(res, '组件不存在', 404);
    db.prepare('DELETE FROM widgets WHERE id = ?').run(params.id);
    json(res, { message: '删除成功' });
  });

  route('POST', '/api/v1/admin/widgets/batch', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    if (!body || !Array.isArray(body.ids) || !body.ids.length) return error(res, '缺少小工具ID列表', 400);
    if (!['enable', 'disable', 'delete'].includes(body.action)) return error(res, '无效操作', 400);
    const ids = [...new Set(body.ids.filter(id => typeof id === 'string' && id.trim()))];
    if (!ids.length) return error(res, '缺少小工具ID列表', 400);
    const skipped = [];
    let updated = 0;
    for (const id of ids) {
      if (!findWidget(id)) {
        skipped.push({ id, reason: '组件不存在' });
        continue;
      }
      if (body.action === 'delete') db.prepare('DELETE FROM widgets WHERE id = ?').run(id);
      else db.prepare('UPDATE widgets SET enabled = ? WHERE id = ?').run(body.action === 'enable' ? 1 : 0, id);
      updated++;
    }
    json(res, { updated, skipped });
  });
}
