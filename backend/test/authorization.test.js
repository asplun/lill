import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createRouter } from '../lib/router.js';
import { register } from '../routes/admin/index.js';
import { startApiServer } from './helpers/api-server.js';

const password = 'test-password-123';
const headers = session => ({ authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken });
async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const r = await api.request('POST', '/api/v1/install', { body: { site_name: 'Authorization test', site_url: 'http://localhost', admin_username: 'admin', admin_password: password, admin_email: 'admin@example.test' } });
  assert.equal(r.status, 200);
  const admin = await login(api, 'admin');
  return { api, admin };
}
async function login(api, username) {
  const r = await api.request('POST', '/api/v1/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
  return r.payload.data;
}
async function account(api, admin, role, username = role) {
  const r = await api.request('POST', '/api/v1/admin/users', { headers: headers(admin), body: { username, password, email: `${username}@example.test`, role } });
  assert.equal(r.status, 201, JSON.stringify(r.payload));
  return login(api, username);
}
async function post(api, user, title, status = 'draft') {
  const r = await api.request('POST', '/api/v1/admin/posts', { headers: headers(user), body: { title, status, content: `Body ${title}` } });
  assert.equal(r.status, 201, JSON.stringify(r.payload));
  return r.payload.data;
}

test('inactive and deleted accounts, malformed and expired tokens return 401', async t => {
  const { api, admin } = await setup(t);
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(admin.user.id);
  assert.equal((await api.request('GET', '/api/v1/auth/me', { headers: headers(admin) })).status, 401);
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(admin.user.id);
  const { createHmac } = await import('node:crypto');
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  for (const body of [JSON.stringify({ id: admin.user.id, exp: 1 }), 'not-json', JSON.stringify({ id: admin.user.id })]) {
    const b = Buffer.from(body).toString('base64url');
    const sig = createHmac('sha256', 'test-only-secret-not-for-production').update(`${h}.${b}`).digest('base64url');
    assert.equal((await api.request('GET', '/api/v1/auth/me', { headers: { authorization: `Bearer ${h}.${b}.${sig}` } })).status, 401);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(admin.user.id);
  assert.equal((await api.request('GET', '/api/v1/admin/posts', { headers: headers(admin) })).status, 401);
});

test('role changes take effect for an existing token', async t => {
  const { api, admin } = await setup(t);
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  db.prepare("UPDATE users SET role = 'subscriber' WHERE id = ?").run(admin.user.id);
  assert.equal((await api.request('GET', '/api/v1/admin/users', { headers: headers(admin) })).status, 403);
  const me = await api.request('GET', '/api/v1/auth/me', { headers: headers(admin) });
  assert.equal(me.status, 200);
  assert.equal(me.payload.data.role, 'subscriber');
});

test('management routes enforce the role matrix for reads and denied writes', async t => {
  const { api, admin } = await setup(t);
  for (const role of ['admin', 'editor', 'author', 'contributor', 'subscriber']) {
    const user = role === 'admin' ? admin : await account(api, admin, role);
    const content = role !== 'subscriber';
    const editor = ['admin', 'editor'].includes(role);
    for (const [path, allowed] of [
      ['posts', content], ['pages', content], ['page-templates', content], ['media', content],
      ['categories', content], ['tags', content], ['comments', editor],
      ['users', role === 'admin'], ['options', role === 'admin'], ['themes', role === 'admin'], ['plugins', role === 'admin'],
    ]) {
      const r = await api.request('GET', `/api/v1/admin/${path}`, { headers: headers(user) });
      assert.equal(r.status, allowed ? 200 : 403, `${role} GET ${path}: ${JSON.stringify(r.payload)}`);
    }
    if (role !== 'admin') {
      for (const [method, path, body] of [
        ['PUT', 'options', [{ key: 'site_name', value: 'unauthorized' }]],
        ['POST', 'users', {}], ['POST', 'themes/default/activate', {}], ['PUT', 'plugins/hello-world/config', {}],
        ['POST', 'backup', {}], ['DELETE', 'logs', {}], ['POST', 'widgets', {}],
      ]) assert.equal((await api.request(method, `/api/v1/admin/${path}`, { headers: headers(user), body })).status, 403, `${role} ${path}`);
      assert.equal((await api.request('GET', '/api/v1/admin/backup/list', { headers: headers(user) })).status, 403);
    }
    const c = await api.request('POST', '/api/v1/admin/categories', { headers: headers(user), body: { name: `${role}-category`, slug: `${role}-category` } });
    assert.equal(c.status, editor ? 201 : 403);
    const tag = await api.request('POST', '/api/v1/admin/tags', { headers: headers(user), body: { name: `${role}-tag`, slug: `${role}-tag` } });
    assert.equal(tag.status, editor ? 201 : 403);
  }
  const opts = await api.request('GET', '/api/v1/admin/options', { headers: headers(admin) });
  assert.equal(opts.payload.data.find(o => o.key === 'site_name').value, 'Authorization test');
});

test('authors only manage own content; contributors cannot publish; mixed batches make no changes', async t => {
  const { api, admin } = await setup(t);
  const author = await account(api, admin, 'author');
  const contributor = await account(api, admin, 'contributor');
  const editor = await account(api, admin, 'editor');
  const foreign = await post(api, admin, 'Foreign');
  const own = await post(api, author, 'Own', 'published');
  const draft = await post(api, contributor, 'Contribution');
  for (const user of [author, contributor]) {
    for (const [method, body] of [['GET', undefined], ['PUT', { title: 'stolen' }], ['DELETE', undefined]]) {
      const r = await api.request(method, `/api/v1/admin/posts/${foreign.id}`, { headers: headers(user), body });
      assert.equal(r.status, 403, `${user.user.role} ${method}: ${JSON.stringify(r.payload)}`);
    }
    for (const path of ['posts?status=ALL', 'posts/recent']) {
      const r = await api.request('GET', `/api/v1/admin/${path}`, { headers: headers(user) });
      assert.equal(r.status, 200);
      assert.equal((r.payload.data.items || r.payload.data).some(p => p.id === foreign.id), false);
    }
  }
  assert.equal((await api.request('POST', '/api/v1/admin/posts', { headers: headers(contributor), body: { title: 'Cannot publish', status: 'published' } })).status, 403);
  assert.equal((await api.request('PUT', `/api/v1/admin/posts/${draft.id}`, { headers: headers(contributor), body: { status: 'published' } })).status, 403);
  assert.equal((await api.request('POST', '/api/v1/admin/posts/batch', { headers: headers(contributor), body: { ids: [draft.id], action: 'publish' } })).status, 403);
  for (const action of ['publish', 'draft', 'delete']) {
    assert.equal((await api.request('POST', '/api/v1/admin/posts/batch', { headers: headers(author), body: { ids: [own.id, foreign.id], action } })).status, 403);
  }
  const updated = await api.request('PUT', `/api/v1/admin/posts/${own.id}`, { headers: headers(author), body: { title: 'Own edited' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.data.status, 'published');
  assert.equal((await api.request('PUT', `/api/v1/admin/posts/${foreign.id}`, { headers: headers(editor), body: { title: 'Editor edited' } })).status, 200);
  assert.equal((await api.request('POST', '/api/v1/admin/posts', { headers: headers(author), body: { title: 'Bypass taxonomy', tagNames: ['new-tag'] } })).status, 403);
  const db = new DatabaseSync(api.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE title = ?').get('Bypass taxonomy').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM post_versions WHERE post_id = ?').get(foreign.id).n, 1);
  db.close();
  assert.equal((await api.request('POST', '/api/v1/admin/posts/batch', { headers: headers(author), body: { ids: [own.id], action: 'draft' } })).status, 200);
  assert.equal((await api.request('DELETE', `/api/v1/admin/posts/${draft.id}`, { headers: headers(contributor) })).status, 200);
});

test('media ownership and editor comment moderation work without partial failures', async t => {
  const { api, admin } = await setup(t);
  const author = await account(api, admin, 'author');
  const editor = await account(api, admin, 'editor');
  const upload = user => api.request('POST', '/api/v1/admin/media/upload', { headers: headers(user), body: { name: 'test.txt', mime: 'text/plain', data: Buffer.from('test').toString('base64') } });
  const own = await upload(author), other = await upload(admin);
  assert.equal(own.status, 201, JSON.stringify(own.payload));
  assert.equal(other.status, 201);
  const list = await api.request('GET', '/api/v1/admin/media', { headers: headers(author) });
  assert.deepEqual(list.payload.data.items.map(m => m.id), [own.payload.data.id]);
  assert.equal((await api.request('DELETE', `/api/v1/admin/media/${other.payload.data.id}`, { headers: headers(author) })).status, 403);
  assert.equal((await api.request('DELETE', '/api/v1/admin/media/missing', { headers: headers(author) })).status, 404);
  assert.equal((await api.request('DELETE', `/api/v1/admin/media/${other.payload.data.id}`, { headers: headers(editor) })).status, 200);
  assert.equal((await api.request('DELETE', `/api/v1/admin/media/${own.payload.data.id}`, { headers: headers(author) })).status, 200);
  const p = await post(api, admin, 'Comments', 'published');
  const db = new DatabaseSync(api.dbPath);
  db.prepare('INSERT INTO comments (id, post_id, content) VALUES (?, ?, ?)').run('moderation', p.id, 'Test comment');
  db.close();
  assert.equal((await api.request('PATCH', '/api/v1/admin/comments/moderation/status', { headers: headers(author), body: { status: 'approved' } })).status, 403);
  const result = await api.request('PATCH', '/api/v1/admin/comments/moderation/status', { headers: headers(editor), body: { status: 'approved' } });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
});

test('all management routes carry policies, including parameter matches and extension defaults', () => {
  const router = createRouter();
  register(router, { THEMES_DIR: '/temporary/themes' });
  for (const [key, route] of router.routes) {
    if (!key.includes('/api/v1/admin/')) continue;
    assert.equal(route.auth, true, key);
    assert.ok(Array.isArray(route.roles) && route.roles.length, key);
    assert.equal(typeof route.pattern, 'string', key);
  }
  router.route('GET', '/api/v1/admin/extension/:id', () => {}, false);
  assert.deepEqual(router.matchRoute('GET', '/api/v1/admin/extension/123').roles, ['admin']);
  assert.equal(router.matchRoute('GET', '/api/v1/admin/extension/123').auth, true);
  router.route('GET', '/api/v1/extension/:id', () => {});
  assert.equal(router.matchRoute('GET', '/api/v1/extension/123').auth, false);
});
