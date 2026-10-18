import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, test } from 'node:test';
import vm from 'node:vm';
import { renderMD, plainText } from '../lib/utils.js';
import { excerptFor } from '../lib/reading-policy.js';
import { startApiServer } from './helpers/api-server.js';

const themeDir = new URL('../../frontend/themes/default/', import.meta.url);
let api, db, admin, authorId;
const data = response => {
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  return response.payload.data;
};
const get = async path => data(await api.request('GET', path));
const bootstrap = async (query = 'type=index') => get('/api/v1/site/bootstrap?' + query);
async function settings(values) {
  data(await api.request('PUT', '/api/v1/admin/options', {
    headers: { authorization: 'Bearer ' + admin.token, 'x-csrf-token': admin.csrfToken },
    body: Object.entries(values).map(([key, value]) => ({ key, value })),
  }));
}
function post(id, changes = {}) {
  const row = {
    title: id, content: '自动 **摘要** 正文abcdefghij', excerpt: '', excerpt_auto: 1,
    published_at: '2020-01-01 00:00:00', sticky: 0, ...changes,
  };
  db.prepare(`INSERT INTO posts
    (id, title, slug, content, html_content, excerpt, excerpt_auto, type, status, author_id, published_at, sticky)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'post', 'published', ?, ?, ?)`)
    .run(id, row.title, id, row.content, renderMD(row.content), row.excerpt, row.excerpt_auto, authorId, row.published_at, row.sticky);
}
function discussion() {
  post('discussion');
  const insert = db.prepare(`INSERT INTO comments
    (id, post_id, content, author_name, author_email, status, parent_id, created_at)
    VALUES (?, 'discussion', ?, ?, 'private@example.test', ?, ?, ?)`);
  for (const [id, parent, date, status = 'approved'] of [
    ['root-a', null, '2020-01-01 01:00:00'], ['root-b', null, '2020-01-01 02:00:00'],
    ['root-c', null, '2020-01-01 03:00:00'], ['reply-a1', 'root-a', '2020-01-01 04:00:00'],
    ['reply-a2', 'root-a', '2020-01-01 05:00:00'], ['reply-b1', 'root-b', '2020-01-01 06:00:00'],
    ['pending-one', null, '2020-01-01 07:00:00', 'pending'],
  ]) insert.run(id, 'Text ' + id, 'Author ' + id, status, parent, date);
}
const context = vm.createContext({ window: {}, document: { getElementById: () => null } });
vm.runInContext(await readFile(new URL('../../frontend/public/theme.js', import.meta.url), 'utf8'), context);
async function render(name, scope) {
  return context.window.LillEngine.render(await readFile(new URL(name + '.html', themeDir), 'utf8'), {}, scope);
}

before(async () => {
  api = await startApiServer({ prepareThemes: async target => {
    await cp(themeDir, target + '/default', { recursive: true });
    await mkdir(target + '/probe/backend', { recursive: true });
    await writeFile(target + '/probe/theme.json', JSON.stringify({
      id: 'probe', name: 'Defaults probe', backend: { entry: 'backend/index.mjs' },
      settings: [{ key: 'pageSize', type: 'text', default: '10' }],
    }));
    await writeFile(target + '/probe/backend/index.mjs', 'export function extendBootstrap(view) { return { kept: true, display: "custom" }; }');
  } });
  admin = data(await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Reading policies', site_url: 'http://localhost', admin_username: 'reader-admin',
    admin_password: 'test-password-123', admin_email: 'reader@example.test',
  } }));
  db = new DatabaseSync(api.dbPath);
  authorId = db.prepare("SELECT id FROM users WHERE username = 'reader-admin'").get().id;
  // The main integration owns the real migration; keep this API fixture runnable before it lands.
  if (!db.prepare('PRAGMA table_info(posts)').all().some(column => column.name === 'excerpt_auto')) {
    db.exec('ALTER TABLE posts ADD COLUMN excerpt_auto INTEGER DEFAULT 1');
  }
});
after(async () => {
  db?.close();
  await api?.stop();
});
beforeEach(async () => {
  db.exec('DELETE FROM post_versions; DELETE FROM post_tags; DELETE FROM comments; DELETE FROM posts;');
  db.prepare("UPDATE themes SET active = CASE WHEN theme_id = 'default' THEN 1 ELSE 0 END, config = '{}'").run();
  await settings({
    posts_per_page: '3', excerpt_length: '6', excerpt_type: 'text', posts_order: 'date',
    comments_per_page: '2', comment_display: 'threaded',
  });
});

test('global excerpt length replaces previously persisted automatic 200-character summaries', async () => {
  const content = 'ABCDEFGHIJ'.repeat(25);
  post('auto', { content, excerpt: plainText(content).slice(0, 200), excerpt_auto: 1 });
  for (const result of [(await bootstrap()).data.posts[0], (await get('/api/v1/posts')).items[0]]) {
    assert.equal(result.excerpt, 'ABCDEF…');
    assert.equal(result.excerpt_auto, 1);
  }
  await settings({ excerpt_length: '9' });
  assert.equal((await bootstrap()).data.posts[0].excerpt, 'ABCDEFGHI…');
  assert.equal(db.prepare("SELECT excerpt FROM posts WHERE id = 'auto'").get().excerpt.length, 200);
});

test('manual summaries are preserved even when identical to an old generated summary', async () => {
  const content = '手填摘要内容很长，不应被重新截取';
  post('manual', { content, excerpt: plainText(content).slice(0, 200), excerpt_auto: 0 });
  assert.equal((await bootstrap()).data.posts[0].excerpt, content);
  assert.equal((await get('/api/v1/posts')).items[0].excerpt, content);
});

test('more splits original Markdown before rendering and does not split a marker inside a code fence', async () => {
  const content = '前文 **强调**\n\n<!--more-->\n\n后文不应进入摘要';
  assert.doesNotMatch(renderMD(content), /<!--more-->|&lt;!--more--&gt;/, 'more is a boundary, not visible body text');
  post('more', { content });
  await settings({ excerpt_length: '100' });
  const summary = (await bootstrap()).data.posts[0].excerpt;
  assert.equal(summary, '前文 强调');
  assert.doesNotMatch(summary, /more|后文/);
  post('code', { content: '起始\n\n```html\n<!--more-->\n```\n\n结尾', published_at: '2020-01-02 00:00:00' });
  assert.match((await bootstrap()).data.posts[0].excerpt, /结尾/);
});

test('safe HTML summaries keep supported inline emphasis but never emit arbitrary attributes, links or scripts', async () => {
  post('unsafe', {
    content: '**粗体** [链接](javascript:alert(1)) <img src=x onerror="alert(2)"> <script>alert(3)</script> 正文',
  });
  await settings({ excerpt_type: 'html', excerpt_length: '3' });
  const item = (await bootstrap()).data.posts[0];
  assert.match(item.excerpt_html, /<strong>粗体<\/strong>/);
  assert.doesNotMatch(item.excerpt_html, /javascript:|onerror|<script|<img|<a\b/);
  assert.match(item.excerpt_html, /…$/);
  const html = await render('post-card', { post: item, theme: { home_mode: 'excerpt' } });
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.doesNotMatch(html, /&lt;strong/);
});

test('manual HTML-like summaries are never trusted as raw executable markup', async () => {
  post('manual-html', {
    excerpt_auto: 0, excerpt: '<strong>手填</strong><img src=x onerror="alert(1)"><a href="javascript:alert(2)">链接</a>',
  });
  await settings({ excerpt_type: 'html' });
  const item = (await get('/api/v1/posts')).items[0];
  const html = await render('post-card', { post: item, theme: { home_mode: 'excerpt' } });
  assert.match(html, /手填/);
  assert.doesNotMatch(html, /onerror|javascript:|<img|<a href="javascript/);
});

test('HTML summaries escape malformed tags before raw template rendering', async t => {
  const cases = [
    {
      name: 'unclosed img',
      source: '<img src=x onerror="globalThis.__reviewXss=1"',
      expected: '&lt;img src=x onerror=&quot;globalThis.__reviewXss=1&quot;',
    },
    {
      name: 'unclosed svg',
      source: '<svg onload="globalThis.__reviewXss=1"',
      expected: '&lt;svg onload=&quot;globalThis.__reviewXss=1&quot;',
    },
    {
      name: 'unclosed slash-separated svg',
      source: '<svg/onload=globalThis.__reviewXss=1',
      expected: '&lt;svg/onload=globalThis.__reviewXss=1',
    },
    {
      name: 'unclosed img after an allowed tag',
      source: '<strong>safe</strong><img src=x onerror="globalThis.__reviewXss=1"',
      expected: '<strong>safe</strong>&lt;img src=x onerror=&quot;globalThis.__reviewXss=1&quot;',
    },
    {
      name: 'unclosed svg after Markdown emphasis',
      source: '**safe**<svg onload="globalThis.__reviewXss=1"',
      expected: '<strong>safe</strong>&lt;svg onload=&quot;globalThis.__reviewXss=1&quot;',
    },
    {
      name: 'unclosed img inside an allowed tag',
      source: '<code><img src=x onerror="globalThis.__reviewXss=1"',
      expected: '<code>&lt;img src=x onerror=&quot;globalThis.__reviewXss=1&quot;</code>',
    },
    {
      name: 'incomplete allowed tag',
      source: '<strong',
      expected: '&lt;strong',
    },
  ];
  for (const { name, source, expected } of cases) {
    for (const excerpt_auto of [0, 1]) {
      await t.test(`${name}, ${excerpt_auto ? 'automatic' : 'manual'}`, async () => {
        const item = {
          id: 'malformed', title: 'Malformed HTML', url: '/post/malformed',
          excerpt_auto, content: source, excerpt: source,
        };
        Object.assign(item, excerptFor(item, { excerptLength: 200, excerptHtml: true }));
        const html = await render('post-card', { post: item, theme: { home_mode: 'excerpt' } });
        assert.equal(item.excerpt_html, expected);
        assert.ok(html.includes('<div class="post-excerpt">' + expected + '</div>'), html);
        assert.doesNotMatch(html, /<(?:img|svg)\b/i);
        if (!excerpt_auto) assert.equal(item.excerpt, source, 'manual source is retained, not trusted as HTML');
      });
    }
  }
});

test('public readers return escaped malformed HTML for automatic and manual summaries', async () => {
  const source = '<img src=x onerror="globalThis.__reviewXss=1"';
  const expected = '&lt;img src=x onerror=&quot;globalThis.__reviewXss=1&quot;';
  post('malformed-auto', { content: source });
  post('malformed-manual', { excerpt: source, excerpt_auto: 0 });
  await settings({ excerpt_type: 'html', excerpt_length: '200' });
  for (const items of [(await bootstrap()).data.posts, (await get('/api/v1/posts')).items]) {
    assert.equal(items.length, 2);
    for (const item of items) {
      const html = await render('post-card', { post: item, theme: { home_mode: 'excerpt' } });
      assert.equal(item.excerpt_html, expected);
      assert.ok(html.includes('<div class="post-excerpt">' + expected + '</div>'), html);
      assert.doesNotMatch(html, /<img\b/i);
    }
  }
});

test('global title ordering is stable in both readers and keeps sticky posts first', async () => {
  post('zulu', { title: 'Zulu', published_at: '2020-01-03 00:00:00' });
  post('alpha', { title: 'Alpha', published_at: '2020-01-01 00:00:00' });
  post('middle', { title: 'Middle', sticky: 1, published_at: '2020-01-02 00:00:00' });
  await settings({ posts_order: 'title' });
  assert.deepEqual((await bootstrap()).data.posts.map(item => item.id), ['middle', 'alpha', 'zulu']);
  assert.deepEqual((await get('/api/v1/posts')).items.map(item => item.id), ['middle', 'alpha', 'zulu']);
});

test('global page size wins over manifest defaults; only saved positive integers override it', async () => {
  for (let i = 0; i < 5; i++) post('size-' + i);
  db.prepare("UPDATE themes SET active = CASE WHEN theme_id = 'probe' THEN 1 ELSE 0 END").run();
  for (const config of [{}, { pageSize: '' }, { pageSize: '0' }, { pageSize: '2x' }, { pageSize: '1.5' }]) {
    db.prepare("UPDATE themes SET config = ? WHERE theme_id = 'probe'").run(JSON.stringify(config));
    const boot = await bootstrap();
    assert.equal(boot.data.pagination.pageSize, 3, JSON.stringify(config));
    assert.equal(boot.data.posts.length, 3);
    assert.equal(boot.theme.extension.kept, true, 'extension namespace is preserved');
    assert.equal((await get('/api/v1/posts')).meta.pageSize, 3);
  }
  db.prepare("UPDATE themes SET config = ? WHERE theme_id = 'probe'").run('{"pageSize":"2"}');
  assert.equal((await bootstrap()).data.pagination.pageSize, 2);
  assert.equal((await get('/api/v1/posts')).meta.pageSize, 2);
  assert.equal((await get('/api/v1/posts?pageSize=4')).meta.pageSize, 4);
});

test('default theme follows the global page size until its override is explicitly saved', async () => {
  for (let i = 0; i < 5; i++) post('default-size-' + i);
  assert.equal((await bootstrap()).data.pagination.pageSize, 3);
  db.prepare("UPDATE themes SET config = ? WHERE theme_id = 'default'").run('{"posts_per_page":"2"}');
  assert.equal((await bootstrap()).data.pagination.pageSize, 2);
});

test('threaded comment pagination counts roots, includes replies, and is identical in bootstrap and the comments API', async () => {
  discussion();
  const boot = await bootstrap('type=post&slug=discussion&commentPage=2&commentSort=asc');
  const comments = await get('/api/v1/comments?postId=discussion&page=2&sort=asc');
  assert.equal(boot.data.commentDisplay, 'threaded');
  assert.deepEqual(boot.data.comments.map(row => row.id), ['root-c']);
  assert.deepEqual(boot.data.comments, comments.items);
  assert.deepEqual(boot.data.commentMeta, comments.meta);
  assert.equal(comments.meta.total, 6);
  assert.equal(comments.meta.replyTotal, 3);
  assert.equal(comments.meta.topLevelTotal, 3);
  assert.equal(comments.meta.paginationTotal, 3);
  assert.equal(comments.meta.pageSize, 2);
  assert.equal(comments.meta.page, 2);
  assert.equal(comments.meta.totalPages, 2);
  assert.equal(comments.meta.hasPrev, true);
  assert.equal(comments.meta.hasNext, false);
  assert.deepEqual(comments.meta.pages, [1, 2]);
  const first = await get('/api/v1/comments?postId=discussion&sort=asc');
  assert.deepEqual(first.items[0].replies.map(row => row.id), ['reply-a1', 'reply-a2']);
  assert.doesNotMatch(JSON.stringify(first), /private@example.test|pending-one/);
});

test('flat pagination includes every approved comment once, with cross-page parent context and no nested duplicates', async () => {
  discussion();
  await settings({ comment_display: 'flat' });
  const comments = await get('/api/v1/comments?postId=discussion&page=2&sort=asc');
  const boot = await bootstrap('type=post&slug=discussion&commentPage=2&commentSort=asc');
  assert.deepEqual(comments.items.map(row => row.id), ['root-c', 'reply-a1']);
  assert.deepEqual(boot.data.comments, comments.items);
  assert.deepEqual(boot.data.commentFlat, comments.commentFlat);
  assert.deepEqual(boot.data.commentMeta, comments.meta);
  assert.equal(comments.display, 'flat');
  assert.equal(comments.meta.paginationTotal, 6);
  assert.equal(comments.meta.totalPages, 3);
  assert.ok(comments.items.every(row => !row.replies?.length));
  assert.equal(comments.items[1].parent_author, 'Author root-a');
  assert.equal(comments.items[1].parent_ref, 'root-a');
  const html = await render('comments', {
    theme: { show_comment: true }, post: { id: 'discussion' }, ...boot.data,
  });
  assert.match(html, /data-comment-display="flat"/);
  assert.match(html, /href="[^"]*commentPage=3/);
  assert.doesNotMatch(html, /class="comment-replies"/);
});

test('comment sorting honors the legacy cookie and explicit hot sorting in both readers', async () => {
  discussion();
  db.prepare("UPDATE comments SET likes = 10 WHERE id = 'root-a'").run();
  const headers = { cookie: 'lill_comment_sort=asc' };
  const boot = data(await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=discussion', { headers }));
  const comments = data(await api.request('GET', '/api/v1/comments?postId=discussion', { headers }));
  assert.equal(boot.data.commentSort, 'asc');
  assert.equal(comments.sort, 'asc');
  assert.deepEqual(boot.data.comments, comments.items);
  assert.equal((await get('/api/v1/comments?postId=discussion&sort=hot')).items[0].id, 'root-a');
});

test('empty comments expose complete pagination and invalid page values safely fall back', async () => {
  post('discussion');
  const boot = await bootstrap('type=post&slug=discussion&commentPage=-9');
  const comments = await get('/api/v1/comments?postId=discussion&page=-9&pageSize=garbage');
  assert.deepEqual(boot.data.comments, []);
  assert.equal(boot.data.commentMeta.page, 1);
  assert.equal(boot.data.commentMeta.pageSize, 2);
  assert.equal(boot.data.commentMeta.totalPages, 1);
  assert.deepEqual(boot.data.commentMeta, comments.meta);
});

test('default theme loads a linked comment page from the real API without changing the shared frontend runtime', async () => {
  discussion();
  const boot = await bootstrap('type=post&slug=discussion&commentSort=asc');
  const location = new URL('http://localhost/post/discussion?commentPage=2&commentSort=asc');
  const listeners = new Map();
  const replaced = Promise.withResolvers();
  let sectionReplaced = false;
  let rendered = '';
  const list = { set innerHTML(value) { replaced.resolve(rendered); } };
  const section = {
    set outerHTML(value) { sectionReplaced = true; replaced.resolve(value); },
    setAttribute() {},
    querySelector: selector => selector === '.comment-list' ? list
      : selector === '.comments-title span' ? { textContent: '' } : { replaceWith() {} },
  };
  const browser = vm.createContext({
    URL, location, setTimeout,
    history: { replaceState() {}, pushState() {} },
    localStorage: { getItem: () => null },
    document: {
      querySelector: () => null,
      getElementById: id => id === 'comments' ? section : null,
      createElement: () => ({
        set innerHTML(value) { rendered = value; },
        querySelector: () => ({ innerHTML: rendered }),
      }),
      addEventListener: (name, listener) => listeners.set(name, listener),
      documentElement: { classList: { contains: () => false, toggle() {} } },
    },
    fetch: async path => path.includes('comments.html')
      ? { ok: true, text: async () => readFile(new URL('comments.html', themeDir), 'utf8') }
      : { ok: false },
    window: {
      LillEngine: context.window.LillEngine,
      lillAPI: { get: path => get('/api/v1' + path) },
      __LILL_SCOPE__: { ...boot.data, theme: boot.theme, page: boot.page },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener() {},
    },
  });
  vm.runInContext(await readFile(new URL('theme.js', themeDir), 'utf8'), browser);
  const html = await Promise.race([replaced.promise, new Promise(resolve => setTimeout(() => resolve('No page reload'), 500))]);
  assert.match(html, /id="comment-root-c"/);
  assert.doesNotMatch(html, /id="comment-root-a"/);
  assert.equal(browser.window.__LILL_SCOPE__.commentMeta.page, 2);
  assert.equal(typeof listeners.get('click'), 'function');
  assert.equal(sectionReplaced, false, 'keep the live comment form and the shared runtime submit listener');
});
