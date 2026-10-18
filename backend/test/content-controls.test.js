import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { startApiServer } from './helpers/api-server.js';

test('single-content comment permission and page order persist and validate without partial writes', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  const install = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Content controls', site_url: 'http://localhost',
    admin_username: 'admin', admin_password: 'test-password-123', admin_email: 'admin@example.test',
  } });
  const session = install.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const created = await api.request('POST', '/api/v1/admin/posts', {
    headers, body: { title: 'Page controls', type: 'page', status: 'published', order: 7, commentAllowed: false },
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.data.order, 7);
  assert.equal(created.payload.data.comment_allowed, 0);
  const id = created.payload.data.id;
  const enabled = await api.request('PUT', '/api/v1/admin/posts/' + id, { headers, body: { order: 2, commentAllowed: true } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.payload.data.comment_allowed, 1);
  for (const body of [{ commentAllowed: 'false' }, { commentAllowed: 2 }, { order: 1.5 }, { order: 'invalid' }]) {
    assert.equal((await api.request('PUT', '/api/v1/admin/posts/' + id, { headers, body: { title: 'Must not persist', ...body } })).status, 400);
  }
  const stored = await api.request('GET', '/api/v1/admin/posts/' + id, { headers });
  assert.equal(stored.payload.data.title, 'Page controls');
  assert.equal(stored.payload.data.order, 2);
});

test('automatic and manual excerpts retain their explicit mode through editing', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Excerpt mode', site_url: 'http://localhost', admin_username: 'admin',
    admin_password: 'test-password-123', admin_email: 'admin@example.test',
  } });
  const session = installed.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const create = body => api.request('POST', '/api/v1/admin/posts', { headers, body: { title: 'Excerpt article', content: 'Original body', ...body } });
  const auto = await create({});
  assert.equal(auto.payload.data.excerpt_auto, 1);
  const manual = await create({ excerpt: 'My hand-written summary' });
  assert.equal(manual.payload.data.excerpt_auto, 0);
  const path = '/api/v1/admin/posts/' + manual.payload.data.id;
  const changed = await api.request('PUT', path, { headers, body: { content: 'Changed body' } });
  assert.equal(changed.payload.data.excerpt, 'My hand-written summary');
  assert.equal(changed.payload.data.excerpt_auto, 0);
  const switched = await api.request('PUT', path, { headers, body: { excerptAuto: true } });
  assert.equal(switched.payload.data.excerpt_auto, 1);
  assert.equal(switched.payload.data.excerpt, 'Changed body');
  const explicit = await api.request('PUT', path, { headers, body: { excerpt: 'Changed body', excerptAuto: false } });
  assert.equal(explicit.payload.data.excerpt_auto, 0, 'a manual summary can equal generated text');
  assert.equal((await api.request('PUT', path, { headers, body: { excerptAuto: 'true' } })).status, 400);
});

test('upgrading old excerpt rows classifies them once without overwriting explicit modes', async t => {
  const source = await startApiServer();
  t.after(source.stop);
  const installed = await source.request('POST', '/api/v1/install', { body: {
    site_name: 'Legacy excerpts', site_url: 'http://localhost', admin_username: 'admin',
    admin_password: 'test-password-123', admin_email: 'admin@example.test',
  } });
  const session = installed.payload.data;
  const db = new DatabaseSync(source.dbPath);
  t.after(() => db.close());
  if (!db.prepare('PRAGMA table_info(posts)').all().some(c => c.name === 'excerpt_auto')) db.exec('ALTER TABLE posts ADD COLUMN excerpt_auto INTEGER');
  const insert = db.prepare(`INSERT INTO posts (id, title, slug, content, excerpt, excerpt_auto, author_id)
    VALUES (?, ?, ?, 'Original body', ?, ?, ?)`);
  insert.run('legacy-auto', 'auto', 'legacy-auto', 'Original body', null, session.user.id);
  db.prepare(`UPDATE posts SET html_content = '<img src=x onerror="alert(1)">' WHERE id = 'legacy-auto'`).run();
  // The fixture represents an older installation, before the security migration.
  db.prepare("DELETE FROM options WHERE key = 'md_renderer_v3_security'").run();
  db.prepare("INSERT OR REPLACE INTO options (id, key, value, autoload) VALUES ('md-old', 'md_renderer_v2', 'done', 0)").run();
  insert.run('legacy-manual', 'manual', 'legacy-manual', 'Hand-written', null, session.user.id);
  insert.run('explicit-manual', 'manual2', 'explicit-manual', 'Original body', 0, session.user.id);
  insert.run('legacy-empty', 'empty', 'legacy-empty', '', null, session.user.id);
  db.prepare("UPDATE posts SET content = '', html_content = '<p>Stale body</p>' WHERE id = 'legacy-empty'").run();
  const upgraded = await startApiServer({ prepareThemes: target => {
    db.prepare('VACUUM INTO ?').run(join(dirname(target), 'lill.db'));
  } });
  t.after(upgraded.stop);
  const restored = new DatabaseSync(upgraded.dbPath);
  try {
    assert.equal(restored.prepare("SELECT excerpt_auto FROM posts WHERE id = 'legacy-auto'").get().excerpt_auto, 1);
    assert.equal(restored.prepare("SELECT excerpt_auto FROM posts WHERE id = 'legacy-manual'").get().excerpt_auto, 0);
    assert.equal(restored.prepare("SELECT excerpt_auto FROM posts WHERE id = 'explicit-manual'").get().excerpt_auto, 0);
    assert.equal(restored.prepare("SELECT html_content FROM posts WHERE id = 'legacy-auto'").get().html_content, '<p>Original body</p>');
    assert.equal(restored.prepare("SELECT html_content FROM posts WHERE id = 'legacy-empty'").get().html_content, '');
  } finally { restored.close(); }
});
