import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function installTestSite(api, username = 'security-admin') {
  const install = await api.request('POST', '/api/v1/install', {
    body: {
      site_name: 'Security Test',
      site_url: 'http://localhost',
      admin_username: username,
      admin_password: 'test-password-123',
      admin_email: `${username}@example.test`,
    },
  });
  assert.equal(install.status, 200);
  return install.payload.data;
}

function seedPublicIsolationFixtures(dbPath, adminUsername = 'security-admin') {
  const db = new DatabaseSync(dbPath);
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
  assert.ok(admin);
  // 安装向导会创建默认 Hello World，测试夹具只保留本用例声明的内容。
  db.prepare('DELETE FROM posts').run();
  const category = { id: 'security-category', name: 'Security', slug: 'security' };
  db.prepare('INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)').run(category.id, category.name, category.slug);
  const rows = [
    ['public-post', 'Public Post', 'published', 'public', null, 'Public body'],
    ['draft-post', 'Draft Post', 'draft', 'public', null, 'Draft body'],
    ['private-post', 'Private Post', 'published', 'private', null, 'Private body'],
    ['password-post', 'Password Post', 'published', 'public', 'secret-password', 'Password body'],
  ];
  const insert = db.prepare(`
    INSERT INTO posts
      (id, title, slug, content, html_content, excerpt, type, status, visibility, password,
       published_at, author_id, category_id)
    VALUES (?, ?, ?, ?, ?, ?, 'post', ?, ?, ?, datetime('now'), ?, ?)
  `);
  for (const [slug, title, status, visibility, password, body] of rows) {
    insert.run(slug, title, slug, body, `<p>${body}</p>`, body, status, visibility, password, admin.id, category.id);
  }
  const pageInsert = db.prepare(`
    INSERT INTO posts
      (id, title, slug, content, html_content, excerpt, type, status, visibility, password,
       published_at, author_id, category_id)
    VALUES (?, ?, ?, ?, ?, ?, 'page', ?, ?, ?, datetime('now'), ?, ?)
  `);
  pageInsert.run(
    'public-page',
    'Public Page',
    'public-page',
    'Page body',
    '<p>Page body</p>',
    'Page body',
    'published',
    'public',
    null,
    admin.id,
    category.id,
  );
  pageInsert.run(
    'private-page',
    'Private Page',
    'private-page',
    'Private page body',
    '<p>Private page body</p>',
    'Private page body',
    'published',
    'private',
    null,
    admin.id,
    category.id,
  );
  db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)').run('security-tag', 'Security', 'security');
  db.prepare('INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)').run('private-post', 'security-tag');
  db.prepare('INSERT INTO comments (id, content, status, post_id, author_name) VALUES (?, ?, ?, ?, ?)')
    .run('private-comment', 'Private comment', 'approved', 'private-post', 'Private author');
  db.close();
}

function collectObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output);
  } else if (value && typeof value === 'object') {
    output.push(value);
    for (const item of Object.values(value)) collectObjects(item, output);
  }
  return output;
}

test('anonymous reset endpoint is unavailable and leaves the database intact', async t => {
  const api = await startApiServer();
  t.after(api.stop);

  await installTestSite(api);

  const reset = await api.request('POST', '/api/v1/install/reset', {
    body: { confirm: 'RESET' },
  });
  assert.equal(reset.status, 404);
  for (const ip of ['127.0.0.1', '10.0.0.1, 127.0.0.1']) {
    const spoof = await api.request('POST', '/api/v1/install/reset', { headers: { 'x-forwarded-for': ip }, body: { confirm: 'RESET' } });
    assert.equal(spoof.status, 404);
  }

  const status = await api.request('GET', '/api/v1/install/status');
  assert.equal(status.status, 200);
  assert.equal(status.payload.data.installed, true);

  const login = await api.request('POST', '/api/v1/auth/login', {
    body: { username: 'security-admin', password: 'test-password-123' },
  });
  assert.equal(login.status, 200);
});

test('public list ignores requested non-published statuses', async t => {
  const api = await startApiServer();
  t.after(api.stop);

  await installTestSite(api);
  seedPublicIsolationFixtures(api.dbPath);

  const response = await api.request('GET', '/api/v1/posts?status=draft&pageSize=100');
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload.data.items.map(item => item.slug), ['public-post']);
  assert.equal(response.payload.data.items.some(item => item.slug === 'draft-post'), false);
  assert.equal(response.payload.data.items.some(item => item.slug === 'private-post'), false);
  assert.equal(response.payload.data.items.some(item => item.slug === 'password-post'), false);
  assert.equal(response.payload.data.items.some(item => Object.hasOwn(item, 'password')), false);
});

test('public detail hides draft, private, and password posts', async t => {
  const api = await startApiServer();
  t.after(api.stop);

  await installTestSite(api);
  seedPublicIsolationFixtures(api.dbPath);

  for (const slug of ['draft-post', 'private-post']) {
    const response = await api.request('GET', `/api/v1/posts/${slug}`);
    assert.equal(response.status, 404, slug);
  }

  const passwordPost = await api.request('GET', '/api/v1/posts/password-post');
  assert.equal(passwordPost.status, 404);
});

test('bootstrap excludes private content and secret fields', async t => {
  const api = await startApiServer();
  t.after(api.stop);

  await installTestSite(api);
  seedPublicIsolationFixtures(api.dbPath);

  const index = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  assert.equal(index.status, 200);
  const indexText = JSON.stringify(index.payload);
  assert.match(indexText, /Public Post/);
  assert.doesNotMatch(indexText, /Draft Post|Private Post|Password Post|secret-password|private-comment/);
  assert.equal(collectObjects(index.payload).some(item => Object.hasOwn(item, 'password')), false);

  const hidden = await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=private-post');
  assert.equal(hidden.status, 404);

  const pages = await api.request('GET', '/api/v1/pages');
  assert.equal(pages.status, 200);
  assert.deepEqual(pages.payload.data.map(item => item.slug), ['public-page']);

  const archives = await api.request('GET', '/api/v1/archives');
  assert.equal(archives.status, 200);
  assert.equal(archives.payload.data.every(item => item.count === 1), true);

  const categories = await api.request('GET', '/api/v1/categories');
  assert.equal(categories.status, 200);
  assert.equal(categories.payload.data.find(item => item.slug === 'security').post_count, 1);

  const tags = await api.request('GET', '/api/v1/tags');
  assert.equal(tags.status, 200);
  assert.equal(tags.payload.data.find(item => item.slug === 'security').post_count, 0);

  const recentComments = await api.request('GET', '/api/v1/comments/recent');
  assert.equal(recentComments.status, 200);
  assert.deepEqual(recentComments.payload.data, []);

  const feed = await api.request('GET', '/api/v1/feed');
  assert.equal(feed.status, 200);
  assert.match(feed.payload, /Public Post/);
  assert.doesNotMatch(feed.payload, /Private Post|secret-password/);
});

test('public comments and likes cannot access hidden content; public details still work', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await installTestSite(api);
  seedPublicIsolationFixtures(api.dbPath);
  for (const id of ['draft-post', 'private-post', 'password-post', 'private-page']) {
    assert.equal((await api.request('GET', `/api/v1/comments?postId=${id}`)).status, 404, id);
    assert.equal((await api.request('POST', '/api/v1/comments', { body: { postId: id, content: 'hidden' } })).status, 404, id);
    assert.equal((await api.request('POST', `/api/v1/posts/${id}/like`, { body: {} })).status, 404, id);
  }
  assert.equal((await api.request('POST', '/api/v1/comments/private-comment/like', { body: {} })).status, 404);
  for (const path of ['/api/v1/posts/public-post', '/api/v1/site/bootstrap?type=post&slug=public-post', '/api/v1/site/bootstrap?type=page&slug=public-page', '/api/v1/comments?postId=public-post']) {
    const r = await api.request('GET', path);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.payload)}`);
    assert.equal(collectObjects(r.payload).some(o => Object.hasOwn(o, 'password')), false);
  }
  const bootstrap = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  assert.equal(bootstrap.payload.data.data.commentTotal, 0);
  assert.equal((await api.request('POST', '/api/v1/posts/public-post/like', { body: {} })).status, 200);
  const comment = await api.request('POST', '/api/v1/comments', { body: { postId: 'public-post', content: 'Public comment', authorName: 'Visitor' } });
  assert.equal(comment.status, 201, JSON.stringify(comment.payload));
  // 待审核评论即使属于公开文章，也不能通过点赞接口探测或修改。
  assert.equal((await api.request('POST', `/api/v1/comments/${comment.payload.data.id}/like`, { body: {} })).status, 404);
});

test('bootstrap does not leak private theme configuration through options', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await installTestSite(api);
  const db = new DatabaseSync(api.dbPath);
  db.prepare('UPDATE themes SET config = ? WHERE active = 1').run(JSON.stringify({ smtpPass: 'theme-secret-123' }));
  db.close();
  const response = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  assert.equal(response.status, 200);
  assert.doesNotMatch(JSON.stringify(response.payload), /theme-secret-123/);
});

test('login rejects non-string credentials instead of crashing', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await installTestSite(api);

  // 非字符串会直接抛进 scryptSync / SQLite 绑定，曾导致 500 并在日志里留下堆栈
  const payloads = [
    { username: 'security-admin', password: [] },
    { username: 'security-admin', password: { a: 1 } },
    { username: 'security-admin', password: 123456 },
    { username: { a: 1 }, password: 'test-password-123' },
    { username: ['security-admin'], password: 'test-password-123' },
    { username: 'security-admin' },
    { password: 'test-password-123' },
  ];
  for (const body of payloads) {
    const response = await api.request('POST', '/api/v1/auth/login', { body });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.doesNotMatch(JSON.stringify(response.payload), /scryptSync|node:internal|at Object\.fn/);
  }

  // 合法凭据依然可用
  const ok = await api.request('POST', '/api/v1/auth/login', {
    body: { username: 'security-admin', password: 'test-password-123' },
  });
  assert.equal(ok.status, 200);
});
