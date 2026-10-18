import assert from 'node:assert/strict';
import { cp, readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { startApiServer } from './helpers/api-server.js';

const themeDir = new URL('../../frontend/themes/default/', import.meta.url);
const context = vm.createContext({ window: {}, document: { getElementById: () => null } });
vm.runInContext(await readFile(new URL('../../frontend/public/theme.js', import.meta.url), 'utf8'), context);
const templates = {};
for (const name of await readdir(themeDir)) {
  if (name.endsWith('.html')) templates[name.slice(0, -5)] = await readFile(new URL(name, themeDir), 'utf8');
}
const render = (name, changes = {}) => context.window.LillEngine.render(templates[name], templates, {
  site: { name: 'Test' }, theme: { show_comment: true }, page: { type: 'page' },
  post: { id: 'page-id', title: '留言板', html_content: '<p>页面正文</p>' },
  commentAllowed: true, commentMeta: { total: 1 },
  comments: [{ id: 'comment-one', author: '读者', content: '保留的评论' }],
  ...changes,
});

test('default page templates provide working comment targets', () => {
  for (const name of ['page', 'page-full', 'page-links']) {
    const html = render(name);
    assert.match(html, /保留的评论/, name);
    assert.match(html, /class="[^"]*lill-comment-form[^"]*"[^>]*data-post-id="page-id"/, name);
    assert.match(html, /name="parentId"/, name);
    assert.match(html, /data-comment-id="comment-one"/, name);
  }
});

test('closing comments preserves existing discussion and hides the form', () => {
  const html = render('post', { commentAllowed: false, page: { type: 'post' } });
  assert.match(html, /保留的评论/);
  assert.doesNotMatch(html, /<form[^>]*lill-comment-form/);
});

test('default article renders the reading time supplied by bootstrap', () => {
  assert.match(render('post', { post: { title: '文章', readTime: 3 } }), /3 分钟阅读/);
});

test('page and recent-comment URLs keep the page route', async t => {
  const api = await startApiServer({ prepareThemes: target => cp(themeDir, target + '/default', { recursive: true }) });
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Test', site_url: 'http://localhost', admin_username: 'theme-admin',
    admin_password: 'test-password-123', admin_email: 'theme@example.test',
  } });
  assert.equal(installed.status, 200);
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('theme-admin');
  const insert = db.prepare(`INSERT INTO posts
    (id, title, slug, type, status, visibility, published_at, author_id)
    VALUES (?, ?, ?, 'page', 'published', 'public', ?, ?)`);
  insert.run('page-one', '留言板', 'messages', '2026-10-01 10:00:00', admin.id);
  insert.run('page-two', '关于', 'about', '2026-10-02 10:00:00', admin.id);
  db.prepare(`INSERT INTO comments (id, content, status, post_id, author_name)
    VALUES ('page-comment', '页面评论', 'approved', 'page-one', '读者')`).run();
  const boot = await api.request('GET', '/api/v1/site/bootstrap?type=page&slug=messages');
  assert.equal(boot.status, 200);
  assert.equal(boot.payload.data.data.post.url, '/page/messages');
  assert.equal(boot.payload.data.data.post.next.url, '/page/about');
  assert.equal(boot.payload.data.sidebar.recentComments[0].post_url, '/page/messages');
  const recent = await api.request('GET', '/api/v1/comments/recent');
  assert.equal(recent.payload.data[0].post_url, '/page/messages');
  await t.test('global comment closure reaches both rendering and submission', async () => {
    const { token, csrfToken } = installed.payload.data;
    const headers = { authorization: `Bearer ${token}`, 'x-csrf-token': csrfToken };
    const saved = await api.request('PUT', '/api/v1/admin/options', {
      headers, body: [{ key: 'comments_disabled', value: 'true' }],
    });
    assert.equal(saved.status, 200);
    const closed = await api.request('GET', '/api/v1/site/bootstrap?type=page&slug=messages');
    assert.equal(closed.payload.data.data.commentAllowed, false);
    assert.equal(closed.payload.data.data.comments[0].content, '页面评论');
    const submitted = await api.request('POST', '/api/v1/comments', {
      body: { postId: 'page-one', authorName: '读者', content: '不应接受的新评论' },
    });
    assert.equal(submitted.status, 400);
  });
});
