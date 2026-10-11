/** User management routes. */
export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, validators, uid, hashPwd, authenticate, triggerHook } = ctx;
  const { route, logAction } = helpers;

  route('GET', '/api/v1/admin/users', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const pageSize = parseInt(url.searchParams.get('pageSize')) || 20;
    const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const items = db.prepare('SELECT id, username, nickname, email, avatar, role, status, created_at, (SELECT COUNT(*) FROM posts WHERE author_id = users.id) as post_count FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize);
    json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
  });

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
    const created = db.prepare('SELECT id, username, nickname, email, role FROM users WHERE id = ?').get(id);
    try { triggerHook('user.created', created); } catch {}
    json(res, { id, username: body.username, role: body.role }, 201);
  });

  route('PUT', '/api/v1/admin/users/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    if (auth.role !== 'admin') return error(res, '权限不足', 403);
    const body = await parseBody(req);
    const updates = [];
    const args = [];
    for (const field of ['nickname', 'email', 'avatar', 'bio', 'role', 'status']) {
      if (body[field] !== undefined) { updates.push(field + ' = ?'); args.push(body[field]); }
    }
    if (body.password) { validators.string(body.password, '密码', 100); updates.push('password = ?'); args.push(hashPwd(body.password)); }
    if (updates.length) { args.push(params.id); db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...args); }
    json(res, db.prepare('SELECT id, username, nickname, email, avatar, role, status FROM users WHERE id = ?').get(params.id));
  });

  route('DELETE', '/api/v1/admin/users/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    if (auth.role !== 'admin') return error(res, '权限不足', 403);
    if (auth.id === params.id) return error(res, '不能删除自己', 400);
    db.prepare('DELETE FROM users WHERE id = ?').run(params.id);
    logAction(auth.id, 'user.delete', '删除用户: ' + params.id, req);
    json(res, { id: params.id });
  });
}
