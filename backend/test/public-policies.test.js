import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startApiServer } from './helpers/api-server.js';

const password = 'policy-test-password-123';
const auth = session => ({ authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken });

async function setup(t, options = {}) {
  const api = await startApiServer(options);
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Public policies', site_url: 'http://localhost',
    admin_username: 'admin', admin_email: 'admin@example.test', admin_password: password,
  } });
  assert.equal(installed.status, 200);
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  return { api, db, session: installed.payload.data };
}

test('public options and bootstrap exclude legacy plugin and internal autoload values', async t => {
  const { api, db } = await setup(t);
  const insert = db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 1)');
  for (const key of ['plugin_example_config', 'smtp_password', 'spamAiKey', 'internal_marker']) {
    insert.run(key, key, 'private-sentinel-' + key);
  }
  db.prepare("UPDATE options SET value = 'Public title' WHERE key = 'site_name'").run();
  for (const path of ['/api/v1/options/public', '/api/v1/site/bootstrap?type=index']) {
    const r = await api.request('GET', path);
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.payload), /private-sentinel/);
    const options = path.includes('bootstrap') ? r.payload.data.options : r.payload.data;
    assert.equal(options.site_name, 'Public title');
    assert.equal(Object.hasOwn(options, 'installed'), false);
  }
});

test('server loads PORT, HOST, DATA_DIR, UPLOAD_DIR and FRONTEND_URL from backend .env', async t => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lill-dotenv-test-'));
  const envFile = join(resolve(import.meta.dirname, '..'), '.env');
  const originalEnv = await readFile(envFile).catch(() => null);
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const { port } = portProbe.address();
  await new Promise((resolveClose, reject) => portProbe.close(error => error ? reject(error) : resolveClose()));
  const dataDir = join(tempDir, 'persistent-data');
  const uploadDir = join(tempDir, 'persistent-uploads');
  await writeFile(envFile, `PORT=${port}\nHOST=127.0.0.1\nDATA_DIR=${dataDir}\nUPLOAD_DIR=${uploadDir}\nJWT_SECRET=\nFRONTEND_URL=https://env-frontend.example.test\n`);
  await chmod(envFile, 0o600);
  t.after(async () => {
    if (originalEnv) await writeFile(envFile, originalEnv);
    else await rm(envFile, { force: true });
    await rm(tempDir, { recursive: true, force: true });
  });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PORT', 'HOST', 'DATA_DIR', 'UPLOAD_DIR', 'JWT_SECRET', 'FRONTEND_URL'].includes(key))),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const baseUrl = `http://127.0.0.1:${port}`;
  let response;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { response = await fetch(baseUrl + '/api/v1/install/status'); if (response.status === 200) break; } catch {}
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.equal(response?.status, 200);
  assert.equal((await fetch(baseUrl + '/api/v1/options/public', { headers: { origin: 'https://env-frontend.example.test' } })).headers.get('access-control-allow-origin'), 'https://env-frontend.example.test');
  const secretPath = join(dataDir, 'jwt-secret.txt');
  const secret = await readFile(secretPath, 'utf8');
  assert.ok(secret.length >= 32);
  assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
  await fetch(baseUrl + '/api/v1/install/status');
  child.kill('SIGKILL');
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  const restarted = spawn(process.execPath, ['server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PORT', 'HOST', 'DATA_DIR', 'UPLOAD_DIR', 'JWT_SECRET', 'FRONTEND_URL'].includes(key))),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    const restartDeadline = Date.now() + 10000;
    while (Date.now() < restartDeadline) {
      try { if ((await fetch(baseUrl + '/api/v1/install/status')).status === 200) break; } catch {}
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    assert.equal(await readFile(secretPath, 'utf8'), secret);
    assert.equal((await fetch(baseUrl + '/api/v1/options/public', { headers: { origin: 'https://env-frontend.example.test' } })).headers.get('access-control-allow-origin'), 'https://env-frontend.example.test');
  } finally { restarted.kill('SIGKILL'); await new Promise(resolveDelay => setTimeout(resolveDelay, 100)); }
});

test('CORS echoes the configured site origin and falls back to the site URL for other origins', async t => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lill-cors-policy-test-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const { port } = portProbe.address();
  await new Promise((resolveClose, reject) => portProbe.close(error => error ? reject(error) : resolveClose()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(tempDir, 'lill.db');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOAD_DIR: join(tempDir, 'uploads'),
      THEMES_DIR: join(tempDir, 'themes'), PLUGINS_DIR: join(tempDir, 'plugins'), DATA_DIR: join(tempDir, 'data'),
      FRONTEND_URL: 'https://frontend.example.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  const request = async (method, path, options = {}) => {
    const response = await fetch(baseUrl + path, { method, headers: options.headers, signal: AbortSignal.timeout(5000),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json', ...options.headers } }) });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { status: response.status, payload, headers: response.headers };
  };
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('API server exited before readiness');
    try { if ((await request('GET', '/api/v1/install/status')).status === 200) break; } catch {}
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  const installed = await request('POST', '/api/v1/install', { body: {
    site_name: 'CORS policy', site_url: '', admin_username: 'admin',
    admin_email: 'admin@example.test', admin_password: password,
  } });
  assert.equal(installed.status, 200);
  const installDb = new DatabaseSync(dbPath);
  assert.equal(installDb.prepare("SELECT value FROM options WHERE key = 'site_url'").get().value, '');
  installDb.close();
  const persistedSecretPath = join(tempDir, 'data', 'jwt-secret.txt');
  const persistedSecret = await readFile(persistedSecretPath, 'utf8');
  assert.ok(persistedSecret.length >= 32);
  assert.equal((await stat(persistedSecretPath)).mode & 0o777, 0o600);
  const api = { request };
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.prepare("UPDATE options SET value = 'https://origin.example.test' WHERE key = 'site_url'").run();

  const trusted = await api.request('GET', '/api/v1/options/public', {
    headers: { origin: 'https://origin.example.test' },
  });
  assert.equal(trusted.headers.get('access-control-allow-origin'), 'https://origin.example.test');

  const untrusted = await api.request('GET', '/api/v1/options/public', {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(untrusted.headers.get('access-control-allow-origin'), 'https://origin.example.test');

  const configuredFrontend = await api.request('GET', '/api/v1/options/public', {
    headers: { origin: baseUrl },
  });
  assert.equal(configuredFrontend.headers.get('access-control-allow-origin'), baseUrl);

  const hostFallback = await api.request('GET', '/api/v1/options/public', {
    headers: { origin: 'http://untrusted.example.test' },
  });
  assert.equal(hostFallback.headers.get('access-control-allow-origin'), 'https://origin.example.test');
  db.prepare("UPDATE options SET value = '' WHERE key = 'site_url'").run();
  const emptySiteUrl = await api.request('GET', '/api/v1/options/public', {
    headers: { origin: 'http://untrusted.example.test' },
  });
  assert.equal(emptySiteUrl.headers.get('access-control-allow-origin'), baseUrl);
});

test('separate frontend preflight permits the CSRF header required for authenticated writes', async t => {
  const { api } = await setup(t);
  const r = await api.request('OPTIONS', '/api/v1/admin/posts', {
    headers: { origin: api.baseUrl, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-csrf-token' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), api.baseUrl);
  const allowed = r.headers.get('access-control-allow-headers').toLowerCase().split(',').map(s => s.trim());
  assert.ok(allowed.includes('x-csrf-token'));
});

test('future publications stay hidden across lists, navigation, feeds and mutations', async t => {
  const { api, db, session } = await setup(t);
  const id = db.prepare("SELECT id FROM posts WHERE type = 'post' LIMIT 1").get().id;
  db.prepare("UPDATE posts SET slug = 'future-post', title = 'Future sentinel', published_at = '2999-01-01 00:00:00' WHERE id = ?").run(id);
  db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, type, status, published_at, author_id)
    VALUES ('future-page', 'Future page sentinel', 'future-page', '', '', 'page', 'published', '2999-01-01T00:00:00.000Z', ?)`).run(session.user.id);
  db.prepare("INSERT INTO comments (id, content, status, post_id, author_name) VALUES ('future-comment', 'Future comment sentinel', 'approved', ?, 'Visitor')").run(id);
  for (const path of ['/api/v1/posts', '/api/v1/pages', '/api/v1/site/bootstrap?type=index',
    '/api/v1/site/bootstrap?type=archive', '/api/v1/feed', '/api/v1/comments/recent']) {
    const r = await api.request('GET', path);
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload), /Future (?:sentinel|page sentinel|comment sentinel)/, path);
  }
  for (const path of ['/api/v1/posts/future-post', '/api/v1/site/bootstrap?type=post&slug=future-post',
    '/api/v1/site/bootstrap?type=page&slug=future-page', '/api/v1/comments?postId=' + id]) {
    assert.equal((await api.request('GET', path)).status, 404, path);
  }
  for (const path of ['/api/v1/posts/' + id + '/like', '/api/v1/comments/future-comment/like']) {
    assert.equal((await api.request('POST', path, { body: {} })).status, 404, path);
  }
  assert.equal((await api.request('POST', '/api/v1/comments', { body: { postId: id, content: 'Future response' } })).status, 404);
  db.prepare("UPDATE posts SET published_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  assert.equal((await api.request('GET', '/api/v1/posts/future-post')).status, 200, 'publication becomes visible after its timestamp');
});

test('comment moderation applies to subscribers and unrelated authors while editors can approve', async t => {
  const { api, db, session } = await setup(t);
  const postId = db.prepare("SELECT id FROM posts WHERE type = 'post' LIMIT 1").get().id;
  // This test isolates moderation from the independent spam and rate policies.
  for (const key of ['spamEnable', 'spamRateEnable']) {
    db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 0)').run(key, key, '0');
  }
  const sessions = { admin: session };
  for (const role of ['subscriber', 'author', 'editor']) {
    const created = await api.request('POST', '/api/v1/admin/users', {
      headers: auth(session), body: { username: role, email: role + '@example.test', password, role },
    });
    assert.equal(created.status, 201);
    const login = await api.request('POST', '/api/v1/auth/login', { body: { username: role, password } });
    assert.equal(login.status, 200);
    sessions[role] = login.payload.data;
  }
  for (const [role, expected] of [['subscriber', 'pending'], ['author', 'pending'], ['editor', 'approved'], ['admin', 'approved']]) {
    const r = await api.request('POST', '/api/v1/comments', {
      headers: auth(sessions[role]), body: { postId, content: 'Comment by ' + role },
    });
    assert.equal(r.status, 201, JSON.stringify(r.payload));
    assert.equal(r.payload.data.status, expected, role);
  }
  db.prepare('UPDATE posts SET author_id = ? WHERE id = ?').run(sessions.author.user.id, postId);
  const owner = await api.request('POST', '/api/v1/comments', {
    headers: auth(sessions.author), body: { postId, content: 'Author responds' },
  });
  assert.equal(owner.payload.data.status, 'approved');
  db.prepare("UPDATE options SET value = 'false' WHERE key = 'comment_moderation'").run();
  const open = await api.request('POST', '/api/v1/comments', {
    headers: auth(sessions.subscriber), body: { postId, content: 'Open discussion' },
  });
  assert.equal(open.payload.data.status, 'approved');
});
