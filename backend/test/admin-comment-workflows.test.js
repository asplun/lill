import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Comment workflow test',
    site_url: api.baseUrl,
    admin_username: 'comment-admin',
    admin_email: 'comment-admin@example.test',
    admin_password: 'comment-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  const post = db.prepare("SELECT id FROM posts WHERE type = 'post' LIMIT 1").get();
  assert.ok(post);
  const insert = db.prepare("INSERT INTO comments (id, content, status, post_id, author_name) VALUES (?, ?, 'pending', ?, 'Reader')");
  insert.run('comment-one', 'First pending comment', post.id);
  insert.run('comment-two', 'Second pending comment', post.id);
  return {
    api,
    db,
    post,
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-csrf-token': session.csrfToken,
    },
  };
}

test('single comment moderation returns 404 for missing comments', async t => {
  const { api, headers } = await setup(t);
  const status = await api.request('PATCH', '/api/v1/admin/comments/missing/status', {
    headers,
    body: { status: 'approved' },
  });
  assert.equal(status.status, 404);

  const update = await api.request('PUT', '/api/v1/admin/comments/missing', {
    headers,
    body: { content: 'Edited' },
  });
  assert.equal(update.status, 404);

  const remove = await api.request('DELETE', '/api/v1/admin/comments/missing', { headers });
  assert.equal(remove.status, 404);
});

test('comment edits validate status, content and email before writing', async t => {
  const { api, headers } = await setup(t);
  const invalidStatus = await api.request('PUT', '/api/v1/admin/comments/comment-one', {
    headers,
    body: { status: 'published' },
  });
  assert.equal(invalidStatus.status, 400);

  const empty = await api.request('PUT', '/api/v1/admin/comments/comment-one', {
    headers,
    body: { content: '   ' },
  });
  assert.equal(empty.status, 400);

  const invalidEmail = await api.request('PUT', '/api/v1/admin/comments/comment-one', {
    headers,
    body: { author_email: 'not-an-email' },
  });
  assert.equal(invalidEmail.status, 400);

  const longReply = await api.request('POST', '/api/v1/admin/comments/comment-one/reply', {
    headers,
    body: { content: 'x'.repeat(5001) },
  });
  assert.equal(longReply.status, 400);
});

test('batch comment moderation validates every ID before changing anything', async t => {
  const { api, db, headers } = await setup(t);
  const result = await api.request('PATCH', '/api/v1/admin/comments/batch-status', {
    headers,
    body: { ids: ['comment-one', 'missing'], status: 'approved' },
  });
  assert.equal(result.status, 404);
  assert.equal(db.prepare("SELECT status FROM comments WHERE id = 'comment-one'").get().status, 'pending');
  assert.equal(db.prepare("SELECT status FROM comments WHERE id = 'comment-two'").get().status, 'pending');
});

test('batch comment moderation updates only real comments atomically', async t => {
  const { api, db, headers } = await setup(t);
  const result = await api.request('PATCH', '/api/v1/admin/comments/batch-status', {
    headers,
    body: { ids: ['comment-one', 'comment-two'], status: 'approved' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.data.updated, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM comments WHERE status = 'approved'").get().count, 2);
});

test('comment moderation and deletion keep the post comment count synchronized', async t => {
  const { api, db, post, headers } = await setup(t);
  db.prepare("UPDATE posts SET comment_count = 0 WHERE id = ?").run(post.id);

  assert.equal((await api.request('PATCH', '/api/v1/admin/comments/comment-one/status', {
    headers, body: { status: 'approved' },
  })).status, 200);
  assert.equal(db.prepare('SELECT comment_count FROM posts WHERE id = ?').get(post.id).comment_count, 1);

  assert.equal((await api.request('PATCH', '/api/v1/admin/comments/comment-two/status', {
    headers, body: { status: 'approved' },
  })).status, 200);
  assert.equal(db.prepare('SELECT comment_count FROM posts WHERE id = ?').get(post.id).comment_count, 2);

  assert.equal((await api.request('PATCH', '/api/v1/admin/comments/comment-one/status', {
    headers, body: { status: 'spam' },
  })).status, 200);
  assert.equal(db.prepare('SELECT comment_count FROM posts WHERE id = ?').get(post.id).comment_count, 1);

  assert.equal((await api.request('DELETE', '/api/v1/admin/comments/comment-two', { headers })).status, 200);
  assert.equal(db.prepare('SELECT comment_count FROM posts WHERE id = ?').get(post.id).comment_count, 0);
});
