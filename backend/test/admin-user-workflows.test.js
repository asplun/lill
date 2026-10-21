import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

const adminPassword = 'admin-test-password-123';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Admin workflow test',
    site_url: api.baseUrl,
    admin_username: 'workflow-admin',
    admin_email: 'workflow-admin@example.test',
    admin_password: adminPassword,
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  return {
    api,
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-csrf-token': session.csrfToken,
    },
  };
}

test('admin user creation requires a valid password and defaults to least-privilege role', async t => {
  const { api, headers } = await setup(t);
  const missingPassword = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: { username: 'new-reader', email: 'reader@example.test' },
  });
  assert.equal(missingPassword.status, 400);

  const shortPassword = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: { username: 'new-reader', email: 'reader@example.test', password: '12345' },
  });
  assert.equal(shortPassword.status, 400);

  const created = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: { username: 'new-reader', email: 'reader@example.test', password: 'reader-password-123' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.data.role, 'subscriber');

  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(created.payload.data.id).role, 'subscriber');
});

test('admin user detail lookup supports records beyond the first page', async t => {
  const { api, headers } = await setup(t);
  const created = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: {
      username: 'later-user',
      email: 'later-user@example.test',
      password: 'later-user-password-123',
      role: 'author',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));

  const detail = await api.request('GET', `/api/v1/admin/users/${created.payload.data.id}`, { headers });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  assert.equal(detail.payload.data.username, 'later-user');
  assert.equal(detail.payload.data.role, 'author');
  assert.equal(Object.hasOwn(detail.payload.data, 'password'), false);

  const missing = await api.request('GET', '/api/v1/admin/users/does-not-exist', { headers });
  assert.equal(missing.status, 404);
});

test('admin user creation rejects unsupported roles and duplicate identities', async t => {
  const { api, headers } = await setup(t);
  const invalidRole = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: { username: 'invalid-role', email: 'invalid-role@example.test', password: 'valid-password-123', role: 'owner' },
  });
  assert.equal(invalidRole.status, 400);

  const body = { username: 'duplicate-user', email: 'duplicate@example.test', password: 'valid-password-123' };
  assert.equal((await api.request('POST', '/api/v1/admin/users', { headers, body })).status, 201);
  assert.equal((await api.request('POST', '/api/v1/admin/users', { headers, body: { ...body, email: 'other@example.test' } })).status, 409);
  assert.equal((await api.request('POST', '/api/v1/admin/users', { headers, body: { ...body, username: 'other-user' } })).status, 409);
});

test('admin user update and delete return 404 for nonexistent users', async t => {
  const { api, headers } = await setup(t);
  const update = await api.request('PUT', '/api/v1/admin/users/does-not-exist', {
    headers,
    body: { nickname: 'Nobody' },
  });
  assert.equal(update.status, 404);

  const remove = await api.request('DELETE', '/api/v1/admin/users/does-not-exist', { headers });
  assert.equal(remove.status, 404);
});

test('admin user updates reject duplicate email and invalid role or status', async t => {
  const { api, headers } = await setup(t);
  const first = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: { username: 'email-one', email: 'one@example.test', password: 'password-123', role: 'author' },
  });
  const second = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: { username: 'email-two', email: 'two@example.test', password: 'password-123', role: 'author' },
  });
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  assert.equal(second.status, 201, JSON.stringify(second.payload));

  const duplicate = await api.request('PUT', `/api/v1/admin/users/${first.payload.data.id}`, {
    headers,
    body: { email: 'two@example.test' },
  });
  assert.equal(duplicate.status, 409);

  for (const body of [{ role: 'owner' }, { status: 'deleted' }]) {
    const response = await api.request('PUT', `/api/v1/admin/users/${first.payload.data.id}`, { headers, body });
    assert.equal(response.status, 400, JSON.stringify(response.payload));
  }
});

test('deleting a user who still owns articles is rejected', async t => {
  const { api, headers } = await setup(t);
  const created = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: { username: 'article-owner', email: 'article-owner@example.test', password: 'owner-password-123', role: 'author' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const login = await api.request('POST', '/api/v1/auth/login', {
    body: { username: 'article-owner', password: 'owner-password-123' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const authorHeaders = {
    authorization: `Bearer ${login.payload.data.token}`,
    'x-csrf-token': login.payload.data.csrfToken,
  };
  const post = await api.request('POST', '/api/v1/admin/posts', {
    headers: authorHeaders,
    body: { title: 'Owned article', content: 'Body', status: 'draft' },
  });
  assert.equal(post.status, 201, JSON.stringify(post.payload));

  const removed = await api.request('DELETE', `/api/v1/admin/users/${created.payload.data.id}`, { headers });
  assert.equal(removed.status, 409);
  const detail = await api.request('GET', `/api/v1/admin/users/${created.payload.data.id}`, { headers });
  assert.equal(detail.status, 200);
});

test('the last active administrator cannot be demoted or disabled', async t => {
  const { api, headers } = await setup(t);
  const me = await api.request('GET', '/api/v1/auth/me', { headers });
  assert.equal(me.status, 200);

  for (const body of [{ role: 'editor' }, { status: 'banned' }]) {
    const response = await api.request('PUT', `/api/v1/admin/users/${me.payload.data.id}`, { headers, body });
    assert.equal(response.status, 409, JSON.stringify(response.payload));
  }
});

test('users who still own content cannot be deleted', async t => {
  const { api, headers } = await setup(t);
  const created = await api.request('POST', '/api/v1/admin/users', {
    headers,
    body: { username: 'content-owner', email: 'content-owner@example.test', password: 'content-password-123', role: 'author' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const login = await api.request('POST', '/api/v1/auth/login', {
    body: { username: 'content-owner', password: 'content-password-123' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const authorHeaders = {
    authorization: `Bearer ${login.payload.data.token}`,
    'x-csrf-token': login.payload.data.csrfToken,
  };
  const post = await api.request('POST', '/api/v1/admin/posts', {
    headers: authorHeaders,
    body: { title: 'Owned content', content: 'Body', status: 'draft' },
  });
  assert.equal(post.status, 201, JSON.stringify(post.payload));

  const removed = await api.request('DELETE', `/api/v1/admin/users/${created.payload.data.id}`, { headers });
  assert.equal(removed.status, 409);
  const detail = await api.request('GET', `/api/v1/admin/users/${created.payload.data.id}`, { headers });
  assert.equal(detail.status, 200);
});

test('admin list pagination rejects unlimited or unsafe page sizes', async t => {
  const { api, headers } = await setup(t);
  const negative = await api.request('GET', '/api/v1/admin/users?page=-1&pageSize=-1', { headers });
  assert.equal(negative.status, 200);
  assert.equal(negative.payload.data.meta.page, 1);
  assert.equal(negative.payload.data.meta.pageSize, 20);

  const oversized = await api.request('GET', '/api/v1/admin/users?pageSize=1000000', { headers });
  assert.equal(oversized.status, 200);
  assert.equal(oversized.payload.data.meta.pageSize, 100);

  const unsafe = await api.request('GET', '/api/v1/admin/users?page=9007199254740991&pageSize=1000000', { headers });
  assert.equal(unsafe.status, 400);

  const enormous = await api.request('GET', '/api/v1/admin/users?page=' + '9'.repeat(1000) + '&pageSize=1000000', { headers });
  assert.equal(enormous.status, 400);
});

test('malformed JSON is a client error with a useful message', async t => {
  const { api } = await setup(t);
  const response = await fetch(api.baseUrl + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"username":',
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /JSON/);
});

test('authenticated writes require the CSRF token bound to the session', async t => {
  const { api, headers } = await setup(t);
  const forged = await api.request('POST', '/api/v1/admin/tags', {
    headers: { ...headers, 'x-csrf-token': 'forged-token' },
    body: { name: 'Forged tag' },
  });
  assert.equal(forged.status, 403, JSON.stringify(forged.payload));

  const valid = await api.request('POST', '/api/v1/admin/tags', {
    headers,
    body: { name: 'Valid tag' },
  });
  assert.equal(valid.status, 201, JSON.stringify(valid.payload));
});

test('startup does not recreate the welcome article after an administrator deletes all content', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Restart test',
    site_url: api.baseUrl,
    admin_username: 'restart-admin',
    admin_email: 'restart-admin@example.test',
    admin_password: 'restart-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  const headers = {
    authorization: `Bearer ${session.token}`,
    'x-csrf-token': session.csrfToken,
  };
  const db = new DatabaseSync(api.dbPath);
  const posts = db.prepare('SELECT id FROM posts').all();
  db.close();
  for (const post of posts) {
    const removed = await api.request('DELETE', `/api/v1/admin/posts/${post.id}`, { headers });
    assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  }

  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createServer } = await import('node:net');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: api.dbPath,
      UPLOAD_DIR: new URL('../uploads', import.meta.url).pathname,
      THEMES_DIR: api.themesDir,
      PLUGINS_DIR: new URL('../plugins', import.meta.url).pathname,
      JWT_SECRET: 'restart-test-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/install/status`);
      if (response.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const restarted = new DatabaseSync(api.dbPath);
  const count = restarted.prepare('SELECT COUNT(*) AS count FROM posts').get().count;
  restarted.close();
  assert.equal(count, 0);
});
