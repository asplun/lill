import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const UUID = '83acb5f4-cdf0-4466-83cc-13ddf5ac1e4a';
const CAT = { id: 'category-uuid', slug: '研发与记录' };
const TAG = { id: 'tag-uuid', slug: 'node+sqlite' };
const POST = {
  id: UUID, type: 'post', slug: '中文别名', title: '真实标题',
  category_id: CAT.id, category_slug: CAT.slug,
  published_at: '2020-06-07T08:09:10.000Z', created_at: '2019-01-02 00:00:00',
};
const DEFAULTS = {
  permalink: '/archives/{cid}/',
  category_prefix: '/category/{slug}/',
  tag_prefix: '/tag/{slug}/',
};

async function moduleUnderTest() {
  const api = await import('../lib/permalinks.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('/lib/permalinks.js')) return {};
    throw error;
  });
  for (const name of ['readPermalinkOptions', 'permalinkPath', 'resolvePermalink', 'validatePermalinkOptions']) {
    assert.equal(typeof api[name], 'function', 'shared permalink implementation required: ' + name);
  }
  return api;
}

function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE options (key TEXT PRIMARY KEY, value TEXT, autoload INTEGER DEFAULT 0);
    CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE);
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE);
    CREATE TABLE posts (
      id TEXT PRIMARY KEY, type TEXT DEFAULT 'post', title TEXT, slug TEXT UNIQUE,
      status TEXT DEFAULT 'published', visibility TEXT DEFAULT 'public', password TEXT,
      published_at TEXT, created_at TEXT, category_id TEXT
    );
  `);
  db.prepare('INSERT INTO categories VALUES (?, ?, ?)').run(CAT.id, '研发与记录', CAT.slug);
  db.prepare('INSERT INTO tags VALUES (?, ?, ?)').run(TAG.id, 'Node SQLite', TAG.slug);
  addPost(db, POST);
  addPost(db, { ...POST, id: 'page-uuid', type: 'page', slug: 'about-us', category_id: null });
  return db;
}

function addPost(db, post) {
  db.prepare(`INSERT INTO posts
    (id, type, title, slug, status, visibility, password, published_at, created_at, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    post.id, post.type || 'post', post.title || 'Title', post.slug,
    post.status || 'published', post.visibility || 'public', post.password ?? null,
    post.published_at ?? null, post.created_at ?? '2020-01-01 00:00:00', post.category_id ?? null,
  );
}

function setOptions(db, options) {
  for (const [key, value] of Object.entries(options)) {
    db.prepare('INSERT OR REPLACE INTO options (key, value) VALUES (?, ?)').run(key, value);
  }
}

test('reads only the three permalink options dynamically and uses defaults for missing keys', async t => {
  const { readPermalinkOptions } = await moduleUnderTest();
  const db = database(t);
  assert.deepEqual(readPermalinkOptions(db), DEFAULTS);
  setOptions(db, { permalink: '/entries/{slug}.html', smtp_password: 'private' });
  assert.deepEqual(readPermalinkOptions(db), { ...DEFAULTS, permalink: '/entries/{slug}.html' });
  setOptions(db, { permalink: '/articles_{cid}' });
  assert.equal(readPermalinkOptions(db).permalink, '/articles_{cid}');
});

test('default UUID article paths and page/category/tag paths roundtrip through a real database', async t => {
  const { permalinkPath, resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  const article = '/archives/' + UUID + '/';
  assert.equal(permalinkPath('post', POST, CAT), article);
  assert.deepEqual(resolvePermalink(db, article), { type: 'post', slug: POST.slug, id: UUID });
  assert.deepEqual(resolvePermalink(db, '/archives/' + UUID), { type: 'post', slug: POST.slug, id: UUID });
  assert.equal(permalinkPath('page', { id: 'page-uuid', slug: 'about-us' }), '/page/about-us');
  assert.deepEqual(resolvePermalink(db, '/page/about-us'), { type: 'page', slug: 'about-us', id: 'page-uuid' });
  assert.equal(permalinkPath('category', CAT), '/category/%E7%A0%94%E5%8F%91%E4%B8%8E%E8%AE%B0%E5%BD%95/');
  assert.deepEqual(resolvePermalink(db, '/category/%E7%A0%94%E5%8F%91%E4%B8%8E%E8%AE%B0%E5%BD%95/'), { type: 'category', slug: CAT.slug, id: CAT.id });
  assert.equal(permalinkPath('tag', TAG), '/tag/node%2Bsqlite/');
  assert.deepEqual(resolvePermalink(db, '/tag/node%2Bsqlite/'), { type: 'tag', slug: TAG.slug, id: TAG.id });
});

test('configured literal prefixes/suffixes, dates and taxonomy IDs generate the same paths they resolve', async t => {
  const { permalinkPath, resolvePermalink, readPermalinkOptions } = await moduleUnderTest();
  const db = database(t);
  setOptions(db, {
    permalink: '/writing/{year}/{month}/{category}/{slug}.html',
    category_prefix: '/topics/{mid}/', tag_prefix: '/labels/{mid}.html',
  });
  const options = readPermalinkOptions(db);
  const path = '/writing/2020/06/%E7%A0%94%E5%8F%91%E4%B8%8E%E8%AE%B0%E5%BD%95/%E4%B8%AD%E6%96%87%E5%88%AB%E5%90%8D.html';
  assert.equal(permalinkPath('post', POST, CAT, options), path);
  assert.deepEqual(resolvePermalink(db, path), { type: 'post', slug: POST.slug, id: UUID });
  assert.equal(permalinkPath('category', CAT, null, options), '/topics/category-uuid/');
  assert.deepEqual(resolvePermalink(db, '/topics/category-uuid/'), { type: 'category', slug: CAT.slug, id: CAT.id });
  assert.equal(permalinkPath('tag', TAG, null, options), '/labels/tag-uuid.html');
  assert.deepEqual(resolvePermalink(db, '/labels/tag-uuid.html'), { type: 'tag', slug: TAG.slug, id: TAG.id });
  assert.equal(permalinkPath('post', POST, CAT, { permalink: '/articles_{cid}' }), '/articles_' + UUID);
  assert.deepEqual(resolvePermalink(db, '/articles_' + UUID, { permalink: '/articles_{cid}' }), { type: 'post', slug: POST.slug, id: UUID });
});

test('lookup verifies the real slug/category/date/type instead of accepting arbitrary alternate paths', async t => {
  const { resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  const options = { permalink: '/writing/{year}/{month}/{category}/{cid}/{slug}/' };
  const valid = '/writing/2020/06/' + encodeURIComponent(CAT.slug) + '/' + UUID + '/' + encodeURIComponent(POST.slug) + '/';
  assert.equal(resolvePermalink(db, valid, options)?.id, UUID);
  for (const path of [
    valid.replace('/2020/', '/2021/'), valid.replace('/06/', '/12/'),
    valid.replace(encodeURIComponent(CAT.slug), 'invented-category'),
    valid.replace(encodeURIComponent(POST.slug), 'invented-title'),
    valid.replace(UUID, 'page-uuid'), '/post/about-us', '/page/' + encodeURIComponent(POST.slug),
  ]) assert.equal(resolvePermalink(db, path, options), null, path);
});

test('all custom and legacy content lookups share the public publication boundary', async t => {
  const { resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  for (const [name, flags] of [
    ['draft', { status: 'draft' }], ['private', { visibility: 'private' }],
    ['password', { password: 'secret' }], ['future', { published_at: '2999-01-01 00:00:00' }],
    ['invalid-date', { published_at: 'not-a-date' }],
  ]) {
    for (const type of ['post', 'page']) {
      const slug = type + '-' + name;
      addPost(db, { ...POST, ...flags, type, id: slug, slug });
      assert.equal(resolvePermalink(db, '/' + type + '/' + slug), null);
      if (type === 'post') assert.equal(resolvePermalink(db, '/archives/' + slug + '/'), null);
    }
  }
  addPost(db, { id: 'null-date', slug: 'null-date', password: '' });
  assert.equal(resolvePermalink(db, '/archives/null-date/')?.id, 'null-date');
  db.prepare("UPDATE posts SET published_at = '2020-01-01 00:00:00' WHERE id = 'post-future'").run();
  assert.equal(resolvePermalink(db, '/archives/post-future/')?.slug, 'post-future');
});

test('legacy slug routes remain available after every configured prefix changes', async t => {
  const { resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  setOptions(db, { permalink: '/writing/{slug}/', category_prefix: '/topics/{mid}/', tag_prefix: '/labels/{mid}/' });
  for (const [type, slug, id] of [
    ['post', POST.slug, UUID], ['page', 'about-us', 'page-uuid'], ['category', CAT.slug, CAT.id], ['tag', TAG.slug, TAG.id],
  ]) {
    assert.deepEqual(resolvePermalink(db, '/' + type + '/' + encodeURIComponent(slug)), { type, slug, id });
  }
});

test('templates reject external/unsafe paths, reserved prefixes and unsupported or missing identity tokens', async () => {
  const { validatePermalinkOptions, permalinkPath } = await moduleUnderTest();
  assert.equal(validatePermalinkOptions({}), null);
  for (const key of ['permalink', 'category_prefix', 'tag_prefix']) {
    for (const path of [
      '', 'relative/{slug}', 'https://evil.test/{slug}', '//evil.test/{slug}', '/x/{slug}?draft=1', '/x/{slug}#part',
      '/x/../{slug}', '/x/%2e%2e/{slug}', '/x/./{slug}', '/x\\evil/{slug}', '/x//{slug}',
      '/x/{slug}\n', '/api/{slug}', '/ADMIN/{slug}', '/uploads/{slug}', '/themes/{slug}', '/_astro/{slug}',
      '/%61pi/{slug}', '/x/{title}', '/x/{type}', '/x/{unsupported}', '/x/{slug',
    ]) assert.equal(typeof validatePermalinkOptions({ [key]: path }), 'string', key + ': ' + JSON.stringify(path));
  }
  for (const options of [
    { permalink: '/writing/{year}/{month}/' }, { permalink: '/x/{mid}/' },
    { category_prefix: '/x/{cid}/' }, { tag_prefix: '/x/{category}/{slug}/' },
  ]) assert.equal(typeof validatePermalinkOptions(options), 'string', JSON.stringify(options));
  assert.throws(() => permalinkPath('post', POST, CAT, { permalink: '/api/{cid}' }), /./);
});

test('captures are data, regex metacharacters and SQL text in slugs are never executable patterns', async t => {
  const { permalinkPath, resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  const unusual = { ...POST, id: 'special', slug: 'a.*[x]+$\' OR 1=1 --?#%/你好' };
  addPost(db, unusual);
  const options = { permalink: '/literal.+(posts)/{slug}/' };
  const path = permalinkPath('post', unusual, CAT, options);
  assert.ok(path.includes('%3F%23%25%2F'));
  assert.deepEqual(resolvePermalink(db, path, options), { type: 'post', slug: unusual.slug, id: 'special' });
  assert.equal(resolvePermalink(db, path.replace('literal.%2B(posts)', 'literalZZposts'), options), null);
  assert.equal(resolvePermalink(db, '/literal.+(posts)/does-not-exist/', options), null);
});

test('malformed paths cannot normalize into public routes or reserved endpoints', async t => {
  const { resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  for (const path of [
    'https://example.test/post/a', '//example.test/post/a', '/post/../page/about-us',
    '/post/%2e%2e/page/about-us', '/page//about-us', '/page/%ZZ', '/page/about-us?x=1',
    '/page/about-us#part', '/admin/about-us', '/api/archives/' + UUID,
    '/uploads/' + UUID, '/themes/' + UUID, '/_astro/' + UUID,
  ]) assert.equal(resolvePermalink(db, path), null, path);
});

test('canonical fields can fall back to created_at, and unavailable category/date uses a reachable legacy URL', async t => {
  const { permalinkPath, resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  addPost(db, { id: 'undated', slug: 'undated', created_at: '2020-02-03 04:05:06', category_id: null });
  const undated = db.prepare("SELECT * FROM posts WHERE id = 'undated'").get();
  const options = { permalink: '/{year}/{month}/{slug}/' };
  assert.equal(permalinkPath('post', undated, null, options), '/2020/02/undated/');
  assert.equal(resolvePermalink(db, '/2020/02/undated/', options)?.id, 'undated');
  assert.equal(resolvePermalink(db, '/2020/03/undated/', options), null);
  const missing = { permalink: '/{category}/{slug}/' };
  assert.equal(permalinkPath('post', undated, null, missing), '/post/undated');
  assert.equal(resolvePermalink(db, '/post/undated', missing)?.id, 'undated');
});

test('ambiguous cross-type matches are rejected rather than choosing a different record silently', async t => {
  const { resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  db.prepare('INSERT INTO tags VALUES (?, ?, ?)').run('collision-tag', 'Collision', POST.slug);
  const options = { permalink: '/shared/{slug}/', tag_prefix: '/shared/{slug}/' };
  assert.equal(resolvePermalink(db, '/shared/' + encodeURIComponent(POST.slug) + '/', options), null);
  assert.equal(resolvePermalink(db, '/post/' + encodeURIComponent(POST.slug), options)?.id, UUID);
});

test('date fragments may share a segment with one UUID and duplicate identity segments must agree', async t => {
  const { permalinkPath, resolvePermalink, validatePermalinkOptions } = await moduleUnderTest();
  const db = database(t);
  const options = { permalink: '/writing/{year}-{month}-{cid}.html/{slug}/{slug}/' };
  assert.equal(validatePermalinkOptions(options), null);
  const expected = '/writing/2020-06-' + UUID + '.html/' + encodeURIComponent(POST.slug) + '/' + encodeURIComponent(POST.slug) + '/';
  assert.equal(permalinkPath('post', POST, CAT, options), expected);
  assert.equal(resolvePermalink(db, expected, options)?.id, UUID);
  assert.equal(resolvePermalink(db, expected.replace('.html/', 'xhtml/'), options), null);
  assert.equal(resolvePermalink(db, expected.replace(new RegExp(encodeURIComponent(POST.slug) + '/$'), 'different/'), options), null);
  assert.equal(typeof validatePermalinkOptions({ permalink: '/{cid}-{slug}/' }), 'string');
  assert.equal(typeof validatePermalinkOptions({ tag_prefix: '/{mid}{slug}/' }), 'string');
});

test('dynamic reserved values use safe legacy paths and invalid historical options cannot hide legacy records', async t => {
  const { permalinkPath, resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  db.prepare("INSERT INTO categories VALUES ('api-category', 'API', 'api')").run();
  db.prepare("UPDATE posts SET category_id = 'api-category' WHERE id = ?").run(UUID);
  const options = { permalink: '/{category}/{slug}/' };
  assert.equal(permalinkPath('post', POST, { slug: 'api' }, options), '/post/' + encodeURIComponent(POST.slug));
  assert.equal(resolvePermalink(db, '/api/' + encodeURIComponent(POST.slug), options), null);
  assert.equal(resolvePermalink(db, '/post/' + encodeURIComponent(POST.slug), options)?.id, UUID);
  setOptions(db, { permalink: 'https://external.test/{cid}' });
  assert.equal(resolvePermalink(db, '/archives/' + UUID), null);
  assert.equal(resolvePermalink(db, '/post/' + encodeURIComponent(POST.slug))?.id, UUID);
});

test('taxonomy paths containing both mid and slug reject a mismatching real record', async t => {
  const { permalinkPath, resolvePermalink } = await moduleUnderTest();
  const db = database(t);
  const options = { category_prefix: '/topics/{mid}/{slug}/', tag_prefix: '/labels/{mid}/{slug}/' };
  assert.equal(resolvePermalink(db, permalinkPath('category', CAT, null, options), options)?.id, CAT.id);
  assert.equal(resolvePermalink(db, '/topics/' + CAT.id + '/wrong/', options), null);
  assert.equal(resolvePermalink(db, '/labels/' + TAG.id + '/wrong/', options), null);
  assert.equal(resolvePermalink(db, '/labels/' + CAT.id + '/' + encodeURIComponent(CAT.slug) + '/', options), null);
});
