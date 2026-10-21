import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Pages order test', site_url: 'https://blog.example.test',
    admin_username: 'admin', admin_password: 'test-password-123', admin_email: 'admin@example.test',
  } });
  assert.equal(installed.status, 200);
  const session = installed.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  db.prepare('DELETE FROM posts').run();
  const insert = db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, type, status, published_at, author_id, "order", template)
    VALUES (?, ?, ?, ?, ?, ?, 'published', '2020-06-01 12:00:00', ?, ?, ?)`);
  insert.run('page-a', 'Alpha', 'alpha', 'A', '<p>A</p>', 'page', session.user.id, 0, 'default');
  insert.run('page-b', 'Beta', 'beta', 'B', '<p>B</p>', 'page', session.user.id, 1, 'full-width');
  insert.run('page-c', 'Gamma', 'gamma', 'C', '<p>C</p>', 'page', session.user.id, 2, null);
  insert.run('post-1', 'Article', 'article', 'P', '<p>P</p>', 'post', session.user.id, 0, null);
  return { api, db, headers };
}

test('admin page list exposes order and template sorted by order', async t => {
  const { api, headers } = await setup(t);
  const res = await api.request('GET', '/api/v1/admin/pages?page=1&pageSize=20', { headers });
  assert.equal(res.status, 200);
  const items = res.payload.data.items;
  assert.deepEqual(items.map(item => item.id), ['page-a', 'page-b', 'page-c']);
  assert.deepEqual(items.map(item => item.order), [0, 1, 2]);
  assert.deepEqual(items.map(item => item.template), ['default', 'full-width', null]);
});

test('reorder persists new order and rejects unknown or non-page ids', async t => {
  const { api, headers } = await setup(t);
  const moved = await api.request('POST', '/api/v1/admin/pages/reorder', { headers, body: { items: [
    { id: 'page-c', order: 0 },
    { id: 'page-a', order: 1 },
    { id: 'page-b', order: 2 },
  ] } });
  assert.equal(moved.status, 200, JSON.stringify(moved.payload));
  assert.equal(moved.payload.data.updated, 3);
  const list = await api.request('GET', '/api/v1/admin/pages?page=1&pageSize=20', { headers });
  assert.deepEqual(list.payload.data.items.map(item => item.id), ['page-c', 'page-a', 'page-b']);

  for (const body of [
    { items: [] },
    { items: [{ id: 'missing-page', order: 0 }] },
    { items: [{ id: 'post-1', order: 0 }] },
    { items: [{ id: 'page-a', order: -1 }] },
    { items: [{ id: 'page-a', order: 0 }, { id: 'page-a', order: 1 }] },
  ]) {
    const res = await api.request('POST', '/api/v1/admin/pages/reorder', { headers, body });
    assert.ok(res.status >= 400, JSON.stringify(body) + ' → ' + res.status);
  }
  const unchanged = await api.request('GET', '/api/v1/admin/pages?page=1&pageSize=20', { headers });
  assert.deepEqual(unchanged.payload.data.items.map(item => item.id), ['page-c', 'page-a', 'page-b']);
});
