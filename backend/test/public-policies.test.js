import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

const password = 'policy-test-password-123';
const auth = session => ({ authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken });

async function setup(t) {
  const api = await startApiServer();
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
