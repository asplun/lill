/** User management routes. */
import { boundedPagination, inputError } from '../../lib/http.js';

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, validators, uid, hashPwd, authenticate, triggerHook } = ctx;
  const { route, logAction } = helpers;
  const roles = new Set(['admin', 'editor', 'author', 'contributor', 'subscriber']);
  const statuses = new Set(['active', 'banned']);
  const publicUser = id => db.prepare('SELECT id, username, nickname, email, avatar, bio, role, status, created_at, updated_at FROM users WHERE id = ?').get(id);
  const password = value => {
    validators.required(value, '密码');
    validators.string(value, '密码', 100);
    if (value.length < 6) throw inputError('密码至少6位');
  };
  const activeAdminCount = () => db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get().count;

  route('GET', '/api/v1/admin/users', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { page, pageSize, offset } = boundedPagination(url.searchParams, 20, 100);
    const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const items = db.prepare('SELECT id, username, nickname, email, avatar, role, status, created_at, (SELECT COUNT(*) FROM posts WHERE author_id = users.id) as post_count FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(pageSize, offset);
    json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
  });

  route('GET', '/api/v1/admin/users/:id', async (req, res, params) => {
    await authenticate(req);
    const user = publicUser(params.id);
    if (!user) return error(res, '用户不存在', 404);
    json(res, user);
  });

  route('POST', '/api/v1/admin/users', async (req, res) => {
    const auth = await authenticate(req);
    if (auth.role !== 'admin') return error(res, '权限不足', 403);
    const body = await parseBody(req);
    validators.required(body.username, '用户名');
    body.username = validators.string(body.username, '用户名', 50);
    validators.required(body.email, '邮箱');
    body.email = validators.string(body.email, '邮箱', 254);
    validators.email(body.email, '邮箱');
    password(body.password);
    if (body.role !== undefined && !roles.has(body.role)) return error(res, '用户角色无效', 400);
    if (body.status !== undefined && !statuses.has(body.status)) return error(res, '用户状态无效', 400);
    if (db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(body.username, body.email)) {
      return error(res, '用户名或邮箱已存在', 409);
    }
    const id = uid();
    const role = body.role || 'subscriber';
    db.prepare('INSERT INTO users (id, username, email, password, nickname, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.username, body.email, hashPwd(body.password), body.nickname || body.username, role, body.status || 'active');
    logAction(auth.id, 'user.create', '创建用户: ' + body.username, req);
    const created = publicUser(id);
    try { triggerHook('user.created', created); } catch {}
    json(res, created, 201);
  });

  route('PUT', '/api/v1/admin/users/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    if (auth.role !== 'admin') return error(res, '权限不足', 403);
    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
    if (!current) return error(res, '用户不存在', 404);
    const body = await parseBody(req);
    if (body.role !== undefined && !roles.has(body.role)) return error(res, '用户角色无效', 400);
    if (body.status !== undefined && !statuses.has(body.status)) return error(res, '用户状态无效', 400);
    if (body.username !== undefined && body.username !== current.username) {
      return error(res, '用户名创建后不可修改', 400);
    }
    if (body.email !== undefined) {
      validators.required(body.email, '邮箱');
      body.email = validators.string(body.email, '邮箱', 254);
      validators.email(body.email, '邮箱');
      if (db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(body.email, params.id)) {
        return error(res, '邮箱已存在', 409);
      }
    }
    if (body.nickname !== undefined) body.nickname = validators.string(body.nickname, '昵称', 100);
    if (body.avatar !== undefined) body.avatar = validators.string(body.avatar, '头像地址', 500);
    if (body.bio !== undefined) body.bio = validators.string(body.bio, '个人简介', 5000);
    const removesActiveAdmin = current.role === 'admin' && current.status === 'active'
      && ((body.role !== undefined && body.role !== 'admin') || (body.status !== undefined && body.status !== 'active'));
    if (removesActiveAdmin && activeAdminCount() <= 1) return error(res, '至少需要保留一个有效管理员', 409);
    const updates = [];
    const args = [];
    for (const field of ['nickname', 'email', 'avatar', 'bio', 'role', 'status']) {
      if (body[field] !== undefined) { updates.push(field + ' = ?'); args.push(body[field]); }
    }
    if (body.password !== undefined && body.password !== '') {
      password(body.password);
      updates.push('password = ?');
      args.push(hashPwd(body.password));
    }
    if (updates.length) { args.push(params.id); db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...args); }
    logAction(auth.id, 'user.update', '更新用户: ' + current.username, req);
    try { triggerHook('user.updated', publicUser(params.id)); } catch {}
    json(res, publicUser(params.id));
  });

  route('DELETE', '/api/v1/admin/users/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    if (auth.role !== 'admin') return error(res, '权限不足', 403);
    if (auth.id === params.id) return error(res, '不能删除自己', 400);
    const current = db.prepare('SELECT id, username, role, status FROM users WHERE id = ?').get(params.id);
    if (!current) return error(res, '用户不存在', 404);
    if (current.role === 'admin' && current.status === 'active' && activeAdminCount() <= 1) {
      return error(res, '至少需要保留一个有效管理员', 409);
    }
    if (db.prepare('SELECT id FROM posts WHERE author_id = ? LIMIT 1').get(params.id)) {
      return error(res, '该用户仍有文章，请先转移文章或改为禁用账号', 409);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(params.id);
    logAction(auth.id, 'user.delete', '删除用户: ' + current.username, req);
    json(res, { id: params.id });
  });
}
