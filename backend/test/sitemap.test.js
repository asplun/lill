import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Sitemap test', site_url: 'https://blog.example.test',
    admin_username: 'admin', admin_password: 'test-password-123', admin_email: 'admin@example.test',
  } });
  assert.equal(installed.status, 200);
  const session = installed.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  db.prepare('DELETE FROM posts').run();
  db.prepare("INSERT INTO categories (id, name, slug, sort_order) VALUES ('cat-id', 'Journal', 'journal', 1)").run();
  db.prepare("INSERT INTO tags (id, name, slug) VALUES ('tag-id', 'Notes', 'notes')").run();
  db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, type, status, published_at, author_id, category_id)
    VALUES ('post-id', 'Sitemap article', 'hello', 'Hello', '<p>Hello</p>', 'post', 'published', '2020-06-01 12:00:00', ?, 'cat-id')`).run(session.user.id);
  db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, type, status, published_at, author_id, "order")
    VALUES ('page-id', 'About', 'about', 'About', '<p>About</p>', 'page', 'published', '2020-05-01 08:00:00', ?, 2)`).run(session.user.id);
  db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, type, status, published_at, author_id)
    VALUES ('draft-id', 'Draft', 'draft-post', 'Draft', '<p>Draft</p>', 'post', 'draft', '2020-06-02 12:00:00', ?)`).run(session.user.id);
  db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES ('post-id', 'tag-id')").run();
  const set = items => api.request('PUT', '/api/v1/admin/options', { headers, body: items });
  return { api, db, set };
}

test('sitemap lists posts, pages, categories and tags with absolute permalink URLs', async t => {
  const { api } = await setup(t);
  const res = await api.request('GET', '/api/v1/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  const xml = res.payload;
  assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  for (const path of ['/archives/post-id/', '/page/about', '/category/journal/', '/tag/notes/']) {
    assert.ok(xml.includes('<loc>https://blog.example.test' + path + '</loc>'), path);
  }
  assert.ok(!xml.includes('draft-post'), 'draft posts must stay out of the sitemap');
  assert.match(xml, /<lastmod>2020-06-01T12:00:00\.000Z<\/lastmod>/);
});

test('sitemap follows permalink, page pattern and taxonomy prefix changes', async t => {
  const { api, set } = await setup(t);
  assert.equal((await set([
    { key: 'permalink', value: '/{year}/{month}/{day}/{slug}.html' },
    { key: 'page_pattern', value: '/{slug}.html' },
    { key: 'category_prefix', value: '/topics/{slug}/' },
    { key: 'tag_prefix', value: '/labels/{slug}/' },
  ])).status, 200);
  const xml = (await api.request('GET', '/api/v1/sitemap.xml')).payload;
  for (const path of ['/2020/06/01/hello.html', '/about.html', '/topics/journal/', '/labels/notes/']) {
    assert.ok(xml.includes('<loc>https://blog.example.test' + path + '</loc>'), path);
  }
  assert.ok(!xml.includes('/archives/post-id/'), 'old permalink must disappear after the change');
});

test('robots.txt allows crawling and points at the sitemap', async t => {
  const { api } = await setup(t);
  const res = await api.request('GET', '/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.ok(res.payload.includes('User-agent: *'));
  assert.ok(res.payload.includes('Allow: /'));
  assert.ok(res.payload.includes('Sitemap: https://blog.example.test/sitemap.xml'));
});

test('archive and search paths are configurable and legacy paths keep working', async t => {
  const { api, set } = await setup(t);
  assert.equal((await set([
    { key: 'archive_path', value: '/timeline/' },
    { key: 'search_path', value: '/find' },
  ])).status, 200);
  const archive = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent('/timeline/'));
  assert.equal(archive.status, 200);
  assert.equal(archive.payload.data.page.type, 'archive');
  assert.equal(archive.payload.data.nav.find(item => item.key === 'archive').url, '/timeline/');
  const search = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent('/find'));
  assert.equal(search.status, 200);
  assert.equal(search.payload.data.page.type, 'search');
  for (const legacy of ['/archive/', '/search']) {
    const boot = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(legacy));
    assert.equal(boot.status, 200, legacy);
  }
  for (const bad of ['/api/{slug}', '/timeline/{year}']) {
    assert.equal((await set([{ key: 'archive_path', value: bad }])).status, 400, bad);
  }
});
