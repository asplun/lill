/**
 * lill 认证 API（登录 / 当前用户 / 资料）
 * 由 server.js 调用 register(router, ctx) 装配
 */
import { clientIp } from '../lib/http.js';

export function register(router, ctx) {
  const { db, json, error, parseBody, validators, uid, hashPwd, verifyPwd, signJWT, authenticate, loginLimiter, generateCSRFToken, triggerHook } = ctx;
  const route = router.route;

route('POST', '/api/v1/auth/login', async (req, res) => {
  const body = await parseBody(req);
  const ip = clientIp(req) || 'unknown';
  const key = 'login:' + ip;

  // 达到失败上限则锁定
  if (loginLimiter.isBlocked(key)) {
    return error(res, '尝试次数过多，请 15 分钟后再试', 429);
  }

  // 凭据必须是字符串：非字符串会直接抛进 scryptSync 与 SQLite 绑定层，
  // 在日志里留下 500 与堆栈，同时白白消耗一次 scrypt。
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) return error(res, '用户名和密码不能为空', 400);
  if (username.length > 100 || password.length > 200) return error(res, '用户名或密码格式不正确', 400);

  const user = db.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND status = ?').get(username, username, 'active');
  if (!user || !verifyPwd(password, user.password)) {
    loginLimiter.fail(key);
    const left = loginLimiter.remaining(key);
    return error(res, left > 0 ? `用户名或密码错误（还可尝试 ${left} 次）` : '尝试次数过多，请 15 分钟后再试', 401);
  }

  loginLimiter.reset(key);
  const rememberMe = body?.rememberMe === true;
  const csrfToken = generateCSRFToken();
  const token = signJWT({ id: user.id, username: user.username, role: user.role, csrf: csrfToken }, rememberMe ? '30d' : '2h');
  try { if (typeof triggerHook === 'function') triggerHook('user.login', { id: user.id, username: user.username, role: user.role, ip }); } catch {}
  json(res, { token, csrfToken, user: { id: user.id, username: user.username, nickname: user.nickname, email: user.email, role: user.role } });
});

route('GET', '/api/v1/auth/me', async (req, res) => {
  const auth = await authenticate(req);
  const user = db.prepare('SELECT id, username, nickname, email, avatar, bio, role FROM users WHERE id = ?').get(auth.id);
  json(res, user);
}, true);

route('PUT', '/api/v1/auth/profile', async (req, res) => {
  const auth = await authenticate(req);
  const body = await parseBody(req);
  const updates = [], params = [];
  for (const f of ['nickname', 'email', 'avatar', 'bio']) { if (body[f] !== undefined) { updates.push(f + ' = ?'); params.push(body[f]); } }
  if (body.password) { if (body.password.length < 6) return error(res, '密码至少6位'); updates.push('password = ?'); params.push(hashPwd(body.password)); }
  if (updates.length) { params.push(auth.id); db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params); }
  json(res, db.prepare('SELECT id, username, nickname, email, avatar, bio, role FROM users WHERE id = ?').get(auth.id));
}, true);


// ════════════════════════════════════════
// 公开注册（受 allow_register 设置控制）
// ════════════════════════════════════════
route('POST', '/api/v1/auth/register', async (req, res) => {
  const body = await parseBody(req);
  const allowReg = db.prepare('SELECT value FROM options WHERE key = ?').get('allow_register');
  if (!allowReg || allowReg.value !== 'true') return error(res, '注册未开放', 403);
  validators.required(body.username, '用户名');
  validators.required(body.password, '密码');
  validators.required(body.email, '邮箱');
  validators.string(body.username, '用户名', 50);
  validators.string(body.password, '密码', 100);
  validators.email(body.email, '邮箱');
  if (body.password.length < 6) return error(res, '密码至少6位');
  const exist = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(body.username, body.email);
  if (exist) return error(res, '用户名或邮箱已存在', 409);
  const id = uid();
  db.prepare('INSERT INTO users (id, username, email, password, nickname, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, body.username, body.email, hashPwd(body.password), body.username, 'subscriber');
  const csrfToken = generateCSRFToken();
  const token = signJWT({ id, username: body.username, role: 'subscriber', csrf: csrfToken });
  json(res, { token, csrfToken, user: { id, username: body.username, nickname: body.username, email: body.email, role: 'subscriber' } }, 201);
});

// ════════════════════════════════════════
// 管理 API（需要认证）
// ════════════════════════════════════════════════

}
