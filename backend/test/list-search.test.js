import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'List search test',
    site_url: api.baseUrl,
    admin_username: 'search-admin',
    admin_email: 'search-admin@example.test',
    admin_password: 'search-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  const post = db.prepare("SELECT id FROM posts WHERE type = 'post' LIMIT 1").get();
  assert.ok(post);
  db.prepare('INSERT INTO comments (id, content, status, post_id, author_name, author_email) VALUES (?, ?, ?, ?, ?, ?)')
    .run('search-comment-1', 'needle comment body', 'pending', post.id, 'Alice Needle', 'alice@example.test');
  db.prepare('INSERT INTO comments (id, content, status, post_id, author_name, author_email) VALUES (?, ?, ?, ?, ?, ?)')
    .run('search-comment-2', 'ordinary comment', 'pending', post.id, 'Bob', 'bob@example.test');
  db.prepare('INSERT INTO users (id, username, email, password, nickname, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('search-user-1', 'needle-user', 'needle@example.test', 'unused', 'A User', 'subscriber', 'active');
  db.prepare('INSERT INTO users (id, username, email, password, nickname, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('search-user-2', 'ordinary-user', 'ordinary@example.test', 'unused', 'B User', 'subscriber', 'active');
  db.prepare('INSERT INTO media (id, name, path, url, mime_type, size, alt, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('search-media-1', 'needle-image.png', '/unused/needle-image.png', '/uploads/needle-image.png', 'image/png', 10, 'cover', session.user.id);
  db.prepare('INSERT INTO media (id, name, path, url, mime_type, size, alt, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('search-media-2', 'ordinary-image.png', '/unused/ordinary-image.png', '/uploads/ordinary-image.png', 'image/png', 10, 'needle alt', session.user.id);
  db.prepare('INSERT INTO users (id, username, email, password, nickname, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('other-user', 'other-user', 'other@example.test', 'unused', 'Other', 'subscriber', 'active');
  return {
    api,
    db,
    headers: { authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken },
  };
}

test('admin list keyword search matches comments, users, and media; blank keywords preserve all rows', async t => {
  const { api, headers } = await setup(t);
  const comments = await api.request('GET', '/api/v1/admin/comments?keyword=needle', { headers });
  assert.equal(comments.status, 200);
  assert.equal(comments.payload.data.items.length, 1);
  const allComments = await api.request('GET', '/api/v1/admin/comments?keyword=%20%20', { headers });
  assert.equal(allComments.payload.data.meta.total, 2);

  const users = await api.request('GET', '/api/v1/admin/users?keyword=needle', { headers });
  assert.equal(users.status, 200);
  assert.equal(users.payload.data.items.length, 1);
  const allUsers = await api.request('GET', '/api/v1/admin/users?keyword=%20%20', { headers });
  assert.equal(allUsers.payload.data.meta.total, 4);

  const media = await api.request('GET', '/api/v1/admin/media?keyword=needle', { headers });
  assert.equal(media.status, 200);
  assert.equal(media.payload.data.items.length, 2);
  const allMedia = await api.request('GET', '/api/v1/admin/media?keyword=%20%20', { headers });
  assert.equal(allMedia.payload.data.meta.total, 2);
});

test('admin list keyword search safely accepts SQL LIKE wildcard characters and ignores overlong values', async t => {
  const { api, headers } = await setup(t);
  for (const keyword of ['%', '_', 'x'.repeat(101)]) {
    for (const endpoint of ['comments', 'users', 'media']) {
      const response = await api.request('GET', `/api/v1/admin/${endpoint}?keyword=${encodeURIComponent(keyword)}`, { headers });
      assert.equal(response.status, 200, `${endpoint} keyword ${keyword.length}: ${JSON.stringify(response.payload)}`);
    }
  }
});
