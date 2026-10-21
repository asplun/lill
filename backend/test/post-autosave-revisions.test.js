import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

const password = 'test-password-123';
const headers = session => ({ authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken });

async function login(api, username) {
  const r = await api.request('POST', '/api/v1/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
  return r.payload.data;
}

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const r = await api.request('POST', '/api/v1/install', { body: { site_name: 'Autosave test', site_url: 'http://localhost', admin_username: 'admin', admin_password: password, admin_email: 'admin@example.test' } });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
  const admin = await login(api, 'admin');
  return { api, admin };
}

async function account(api, admin, role, username = role) {
  const r = await api.request('POST', '/api/v1/admin/users', { headers: headers(admin), body: { username, password, email: `${username}@example.test`, role } });
  assert.equal(r.status, 201, JSON.stringify(r.payload));
  return login(api, username);
}

async function createPost(api, user, title, status = 'draft') {
  const r = await api.request('POST', '/api/v1/admin/posts', { headers: headers(user), body: { title, status, content: `Body ${title}` } });
  assert.equal(r.status, 201, JSON.stringify(r.payload));
  return r.payload.data;
}

test('autosave upserts a single server draft and DELETE clears it', async t => {
  const { api, admin } = await setup(t);
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  const post = await createPost(api, admin, '自动草稿');

  const first = await api.request('POST', `/api/v1/admin/posts/${post.id}/autosave`, { headers: headers(admin), body: { title: '草稿标题', content: '第一版正文', excerpt: '摘要' } });
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.data.draft.post_id, post.id);
  assert.equal(first.payload.data.draft.content, '第一版正文');

  const second = await api.request('POST', `/api/v1/admin/posts/${post.id}/autosave`, { headers: headers(admin), body: { title: '草稿标题2', content: '第二版正文' } });
  assert.equal(second.status, 200, JSON.stringify(second.payload));
  // 同一篇文章只保留一条草稿（post_id UNIQUE + ON CONFLICT）。
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM post_drafts WHERE post_id = ?').get(post.id).c, 1);

  const read = await api.request('GET', `/api/v1/admin/posts/${post.id}/autosave`, { headers: headers(admin) });
  assert.equal(read.status, 200);
  assert.equal(read.payload.data.draft.content, '第二版正文');
  assert.equal(read.payload.data.draft.title, '草稿标题2');

  const removed = await api.request('DELETE', `/api/v1/admin/posts/${post.id}/autosave`, { headers: headers(admin) });
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.data.draft, null);
  const after = await api.request('GET', `/api/v1/admin/posts/${post.id}/autosave`, { headers: headers(admin) });
  assert.equal(after.payload.data.draft, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM post_drafts WHERE post_id = ?').get(post.id).c, 0);
});

test('autosave rejects overlong content and enforces post permissions', async t => {
  const { api, admin } = await setup(t);
  const post = await createPost(api, admin, '权限与长度');
  const contributor = await account(api, admin, 'contributor');

  const tooLong = await api.request('POST', `/api/v1/admin/posts/${post.id}/autosave`, { headers: headers(admin), body: { content: 'x'.repeat(50001) } });
  assert.equal(tooLong.status, 400, JSON.stringify(tooLong.payload));
  assert.match(tooLong.payload.message, /内容/);

  const denied = await api.request('POST', `/api/v1/admin/posts/${post.id}/autosave`, { headers: headers(contributor), body: { content: '越权草稿' } });
  assert.equal(denied.status, 403, JSON.stringify(denied.payload));
  const deniedVersions = await api.request('GET', `/api/v1/admin/posts/${post.id}/versions`, { headers: headers(contributor) });
  assert.equal(deniedVersions.status, 403, JSON.stringify(deniedVersions.payload));

  const missing = await api.request('GET', '/api/v1/admin/posts/not-a-post/autosave', { headers: headers(admin) });
  assert.equal(missing.status, 404, JSON.stringify(missing.payload));
});

test('version list is newest first and restore writes back the snapshot', async t => {
  const { api, admin } = await setup(t);
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  const post = await createPost(api, admin, '修订第一版');
  const v2 = await api.request('PUT', `/api/v1/admin/posts/${post.id}`, { headers: headers(admin), body: { title: '修订第二版', content: '第二版正文' } });
  assert.equal(v2.status, 200, JSON.stringify(v2.payload));
  const v3 = await api.request('PUT', `/api/v1/admin/posts/${post.id}`, { headers: headers(admin), body: { title: '修订第三版', content: '第三版正文' } });
  assert.equal(v3.status, 200, JSON.stringify(v3.payload));

  const list = await api.request('GET', `/api/v1/admin/posts/${post.id}/versions`, { headers: headers(admin) });
  assert.equal(list.status, 200, JSON.stringify(list.payload));
  const items = list.payload.data.items;
  assert.ok(Array.isArray(items) && items.length >= 2, JSON.stringify(items));
  assert.equal(items[0].title, '修订第二版');
  assert.equal(items[1].title, '修订第一版');

  const detail = await api.request('GET', `/api/v1/admin/posts/${post.id}/versions/${items[1].id}`, { headers: headers(admin) });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  assert.equal(detail.payload.data.title, '修订第一版');
  assert.equal(detail.payload.data.content, `Body 修订第一版`);

  const before = db.prepare('SELECT COUNT(*) AS c FROM post_versions WHERE post_id = ?').get(post.id).c;
  const restored = await api.request('POST', `/api/v1/admin/posts/${post.id}/versions/${items[1].id}/restore`, { headers: headers(admin), body: {} });
  assert.equal(restored.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.data.title, '修订第一版');
  assert.equal(restored.payload.data.content, `Body 修订第一版`);
  // 恢复前先把当前值（第三版）再存一版，恢复本身也可回退。
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM post_versions WHERE post_id = ?').get(post.id).c, before + 1);
  const newest = db.prepare('SELECT title, content FROM post_versions WHERE post_id = ? ORDER BY rowid DESC LIMIT 1').get(post.id);
  assert.equal(newest.title, '修订第三版');

  // 版本必须属于本文章：跨文章引用按不存在处理。
  const other = await createPost(api, admin, '另一篇文章');
  const cross = await api.request('POST', `/api/v1/admin/posts/${other.id}/versions/${items[0].id}/restore`, { headers: headers(admin), body: {} });
  assert.equal(cross.status, 404, JSON.stringify(cross.payload));
  const crossDetail = await api.request('GET', `/api/v1/admin/posts/${other.id}/versions/${items[0].id}`, { headers: headers(admin) });
  assert.equal(crossDetail.status, 404, JSON.stringify(crossDetail.payload));
});
