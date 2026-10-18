import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Pagination archive test',
    site_url: api.baseUrl,
    admin_username: 'archive-admin',
    admin_email: 'archive-admin@example.test',
    admin_password: 'archive-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  const author = db.prepare("SELECT id FROM users WHERE username = 'archive-admin'").get().id;
  db.prepare('DELETE FROM posts').run();
  const insert = db.prepare(`INSERT INTO posts
    (id, title, slug, content, html_content, type, status, visibility, author_id, published_at)
    VALUES (?, ?, ?, ?, ?, 'post', 'published', 'public', ?, ?)`);
  for (let i = 0; i < 650; i++) {
    const id = 'archive-post-' + i;
    insert.run(id, id, id, 'Body', '<p>Body</p>', author, i < 600 ? '2026-01-01 00:00:00' : '2020-01-01 00:00:00');
  }
  return { api, db };
}

test('public list endpoints cap oversized page sizes and reject unsafe offsets', async t => {
  const { api } = await setup(t);
  const posts = await api.request('GET', '/api/v1/posts?pageSize=1000000');
  assert.equal(posts.status, 200);
  assert.equal(posts.payload.data.items.length, 100);
  assert.equal(posts.payload.data.meta.pageSize, 100);

  const comments = await api.request('GET', '/api/v1/comments?postId=archive-post-0&pageSize=1000000');
  assert.equal(comments.status, 200);
  assert.equal(comments.payload.data.meta.pageSize, 100);

  const huge = await api.request('GET', '/api/v1/posts?page=9007199254740991&pageSize=9007199254740991');
  assert.equal(huge.status, 400);
});

test('archive month filtering happens before result limiting', async t => {
  const { api } = await setup(t);
  const response = await api.request('GET', '/api/v1/site/bootstrap?type=archive&month=2020-01');
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.data.data.posts.length, 50);
  assert.equal(response.payload.data.data.posts[0].published_at.slice(0, 7), '2020-01');
});

test('archive totals and groups are not silently truncated', async t => {
  const { api } = await setup(t);
  const response = await api.request('GET', '/api/v1/site/bootstrap?type=archive');
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  const data = response.payload.data.data;
  assert.equal(data.posts.length, 650);
  assert.equal(data.archTotal, 650);
  assert.equal(data.archWords, 2600);
  assert.equal(data.groups.reduce((sum, group) => sum + group.count, 0), 650);
});
