import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Permalink test', site_url: 'https://blog.example.test',
    admin_username: 'admin', admin_password: 'test-password-123', admin_email: 'admin@example.test',
  } });
  assert.equal(installed.status, 200);
  const session = installed.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  db.prepare('DELETE FROM posts').run();
  db.prepare("INSERT INTO categories (id, name, slug) VALUES ('cat-id', 'Category', 'journal')").run();
  db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, type, status, published_at, author_id, category_id)
    VALUES ('post-id', 'Permalink article', 'hello', 'Hello', '<p>Hello</p>', 'post', 'published', '2020-06-01 12:00:00', ?, 'cat-id')`).run(session.user.id);
  db.prepare("INSERT INTO tags (id, name, slug) VALUES ('tag-id', 'Tag', 'notes')").run();
  db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES ('post-id', 'tag-id')").run();
  const set = items => api.request('PUT', '/api/v1/admin/options', { headers, body: items });
  return { api, db, set };
}

test('configured article links generate and resolve the same path through bootstrap', async t => {
  const { api, set } = await setup(t);
  for (const [format, path] of [
    ['/archives/{cid}/', '/archives/post-id/'],
    ['/archives/{slug}/', '/archives/hello/'],
    ['/{category}/{slug}/', '/journal/hello/'],
    ['/{year}/{month}/{slug}/', '/2020/06/hello/'],
    ['/entries/{slug}.html', '/entries/hello.html'],
  ]) {
    assert.equal((await set([{ key: 'permalink', value: format }])).status, 200);
    const list = await api.request('GET', '/api/v1/posts');
    assert.equal(list.payload.data.items[0].route, path);
    assert.equal(list.payload.data.items[0].url, 'https://blog.example.test' + path);
    const boot = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(path));
    assert.equal(boot.status, 200, format + ': ' + JSON.stringify(boot.payload));
    assert.equal(boot.payload.data.page.type, 'post');
    assert.equal(boot.payload.data.data.post.id, 'post-id');
    assert.equal(boot.payload.data.data.post.url, path);
    const feed = await api.request('GET', '/api/v1/feed');
    assert.ok(feed.payload.includes('https://blog.example.test' + path), format);
  }
  const legacy = await api.request('GET', '/api/v1/site/bootstrap?path=/post/hello');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.payload.data.page.type, 'post');
  for (const path of ['/entries/missing.html', '/unknown/hello/']) {
    assert.equal((await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(path))).status, 404, path);
  }
});

test('taxonomy ID paths and encoded Unicode names resolve through the same public policy', async t => {
  const { api, db, set } = await setup(t);
  assert.equal((await set([
    { key: 'category_prefix', value: '/topics/{mid}/' },
    { key: 'tag_prefix', value: '/labels/{mid}/' },
    { key: 'permalink', value: '/entries/{slug}/' },
  ])).status, 200);
  for (const [path, type, slug] of [['/topics/cat-id/', 'category', 'journal'], ['/labels/tag-id/', 'tag', 'notes']]) {
    const boot = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(path));
    assert.equal(boot.status, 200);
    assert.equal(boot.payload.data.page.type, type);
    assert.equal(boot.payload.data.page.slug, slug);
    assert.equal(boot.payload.data.data.posts[0].slug, 'hello');
    if (type === 'category') assert.equal(boot.payload.data.nav.find(item => item.key === 'category:cat-id').url, '/topics/cat-id/');
  }
  db.prepare("UPDATE posts SET slug = '中文文章' WHERE id = 'post-id'").run();
  const unicode = '/entries/' + encodeURIComponent('中文文章') + '/';
  assert.equal((await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(unicode))).status, 200);
  for (const patch of ["status = 'draft'", "visibility = 'private'", "password = 'restricted'", "published_at = '2999-01-01 00:00:00'"]) {
    db.prepare("UPDATE posts SET status = 'published', visibility = 'public', password = NULL, published_at = '2020-06-01 12:00:00'").run();
    db.exec('UPDATE posts SET ' + patch + " WHERE id = 'post-id'");
    assert.equal((await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(unicode))).status, 404, patch);
  }
});

test('sidebar and adjacent article links retain custom category and date paths', async t => {
  const { api, db, set } = await setup(t);
  db.prepare(`INSERT INTO posts (id, title, slug, type, status, published_at, category_id, author_id)
    SELECT 'older-id', 'Older article', 'older', 'post', 'published', '2020-05-01 12:00:00', 'cat-id', author_id
    FROM posts WHERE id = 'post-id'`).run();
  assert.equal((await set([{ key: 'permalink', value: '/{year}/{month}/{category}/{slug}/' }])).status, 200);
  const boot = await api.request('GET', '/api/v1/site/bootstrap?path=/2020/06/journal/hello/');
  assert.equal(boot.status, 200);
  assert.equal(boot.payload.data.sidebar.hotPosts.find(post => post.id === 'post-id').url, '/2020/06/journal/hello/');
  assert.equal(boot.payload.data.data.post.prev.url, '/2020/05/journal/older/');
  const detail = await api.request('GET', '/api/v1/posts/hello');
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.data.prev.route, '/2020/05/journal/older/');
  assert.equal(detail.payload.data.prev.permalink, 'https://blog.example.test/2020/05/journal/older/');
});

test('invalid historical permalink rules generate reachable legacy paths', async t => {
  const { api, db } = await setup(t);
  db.prepare("UPDATE options SET value = '/archives/{cid}-{slug}/' WHERE key = 'permalink'").run();
  const list = await api.request('GET', '/api/v1/posts');
  assert.equal(list.status, 200);
  assert.equal(list.payload.data.items[0].route, '/post/hello');
  const boot = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(list.payload.data.items[0].route));
  assert.equal(boot.status, 200);
  assert.equal(boot.payload.data.data.post.id, 'post-id');
});

test('content names matching archive and search fall back without taking over builtin pages', async t => {
  const { api, db, set } = await setup(t);
  assert.equal((await set([{ key: 'permalink', value: '/{slug}/' }])).status, 200);
  for (const slug of ['archive', 'search']) {
    db.prepare("UPDATE posts SET slug = ? WHERE id = 'post-id'").run(slug);
    const list = await api.request('GET', '/api/v1/posts');
    assert.equal(list.payload.data.items[0].route, '/post/' + slug);
    const post = await api.request('GET', '/api/v1/site/bootstrap?path=/post/' + slug);
    assert.equal(post.status, 200);
    assert.equal(post.payload.data.data.post.id, 'post-id');
    const builtin = await api.request('GET', '/api/v1/site/bootstrap?path=/' + slug + '/');
    assert.equal(builtin.status, 200);
    assert.equal(builtin.payload.data.page.type, slug);
  }
});

test('invalid permalink settings reject the whole write before any option changes', async t => {
  const { api, set } = await setup(t);
  for (const value of ['https://elsewhere.test/{slug}', '//elsewhere.test/{slug}', '/admin/{slug}/',
    '/api/{slug}/', '/themes/{slug}/', '/../{slug}/', '/entries/{unknown}/', '/entries/fixed/', '/entries/{slug}?q=x']) {
    const r = await set([{ key: 'site_name', value: 'Must not persist' }, { key: 'permalink', value }]);
    assert.equal(r.status, 400, value + ': ' + JSON.stringify(r.payload));
    assert.equal((await api.request('GET', '/api/v1/options/public')).payload.data.site_name, 'Permalink test');
  }
});
