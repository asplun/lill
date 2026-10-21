import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Post permissions', site_url: 'https://blog.example.test',
    admin_username: 'admin', admin_password: 'test-password-123', admin_email: 'admin@example.test',
  } });
  assert.equal(installed.status, 200);
  const session = installed.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const set = items => api.request('PUT', '/api/v1/admin/options', { headers, body: items });
  // 固定永久链接，让 sitemap 断言能直接按 slug 检索文章条目。
  assert.equal((await set([{ key: 'permalink', value: '/{year}/{month}/{day}/{slug}.html' }])).status, 200);
  return { api, headers, session };
}

test('single-post ping and feed switches default to on and gate feed output', async t => {
  const { api, headers } = await setup(t);
  const created = await api.request('POST', '/api/v1/admin/posts', { headers, body: {
    title: 'Feed gate article', slug: 'feed-gate', content: 'Feed body', status: 'published',
  } });
  assert.equal(created.status, 201);
  const post = created.payload.data;
  assert.equal(post.allow_ping, 1, '允许引用默认开启');
  assert.equal(post.allow_feed, 1, '输出到 Feed 默认开启');
  assert.ok((await api.request('GET', '/api/v1/feed')).payload.includes('Feed gate article'), '默认文章应进 Feed');
  assert.ok((await api.request('GET', '/api/v1/sitemap.xml')).payload.includes('/feed-gate.html'), '默认文章应进 sitemap');

  const detailPath = '/api/v1/posts/' + post.slug;
  const opened = await api.request('GET', detailPath);
  assert.equal(opened.status, 200);
  assert.equal(opened.payload.data.allow_feed, 1, '详情页下发 Feed 开关');
  assert.equal(opened.payload.data.allow_ping, 1, '详情页下发引用开关');

  const closed = await api.request('PUT', '/api/v1/admin/posts/' + post.id, { headers, body: { allowFeed: false } });
  assert.equal(closed.status, 200);
  assert.equal(closed.payload.data.allow_feed, 0);
  assert.equal(closed.payload.data.allow_ping, 1, '关闭 Feed 不影响引用开关');
  assert.ok(!(await api.request('GET', '/api/v1/feed')).payload.includes('Feed gate article'), '关闭后文章应离开 Feed');
  assert.ok(!(await api.request('GET', '/api/v1/sitemap.xml')).payload.includes('/feed-gate.html'), '关闭后文章应离开 sitemap');
  const stillOpen = await api.request('GET', detailPath);
  assert.equal(stillOpen.status, 200, '离开 Feed 后详情页仍可访问');
  assert.equal(stillOpen.payload.data.allow_feed, 0);

  const pingOff = await api.request('PUT', '/api/v1/admin/posts/' + post.id, { headers, body: { allowPing: false } });
  assert.equal(pingOff.status, 200);
  assert.equal(pingOff.payload.data.allow_ping, 0);
  assert.equal(pingOff.payload.data.allow_feed, 0);
  const detail = await api.request('GET', detailPath);
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.data.allow_ping, 0, '详情页应返回关闭后的引用开关');

  for (const [field, message] of [['allowPing', '允许引用必须为布尔值'], ['allowFeed', '输出到 Feed 必须为布尔值']]) {
    for (const value of ['false', 0, 1, null]) {
      const res = await api.request('PUT', '/api/v1/admin/posts/' + post.id, { headers, body: { [field]: value } });
      assert.equal(res.status, 400, field + '=' + JSON.stringify(value));
      assert.equal(res.payload.message, message, field + '=' + JSON.stringify(value));
    }
  }
  const untouched = await api.request('GET', '/api/v1/admin/posts/' + post.id, { headers });
  assert.equal(untouched.payload.data.allow_ping, 0, '非法请求不得落库');
  assert.equal(untouched.payload.data.allow_feed, 0, '非法请求不得落库');
});

test('articles created with the switches off stay out until reopened and reject non-booleans', async t => {
  const { api, headers } = await setup(t);
  const invalid = await api.request('POST', '/api/v1/admin/posts', { headers, body: {
    title: 'Invalid switches', allowFeed: 'no',
  } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.payload.message, '输出到 Feed 必须为布尔值');

  const created = await api.request('POST', '/api/v1/admin/posts', { headers, body: {
    title: 'Silent article', slug: 'silent-article', content: 'Quiet body', status: 'published',
    allowPing: false, allowFeed: false,
  } });
  assert.equal(created.status, 201);
  assert.equal(created.payload.data.allow_ping, 0);
  assert.equal(created.payload.data.allow_feed, 0);
  assert.ok(!(await api.request('GET', '/api/v1/feed')).payload.includes('Silent article'));
  assert.ok(!(await api.request('GET', '/api/v1/sitemap.xml')).payload.includes('/silent-article.html'));
  assert.equal((await api.request('GET', '/api/v1/posts/' + created.payload.data.slug)).status, 200, '关闭输出的文章详情仍可访问');

  const reopened = await api.request('PUT', '/api/v1/admin/posts/' + created.payload.data.id, { headers, body: {
    allowPing: true, allowFeed: true,
  } });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.payload.data.allow_ping, 1);
  assert.equal(reopened.payload.data.allow_feed, 1);
  assert.ok((await api.request('GET', '/api/v1/feed')).payload.includes('Silent article'), '重新开启后应回到 Feed');
  assert.ok((await api.request('GET', '/api/v1/sitemap.xml')).payload.includes('/silent-article.html'), '重新开启后应回到 sitemap');
});

test('legacy rows without the new columns stay in the feed', async t => {
  const { api, headers, session } = await setup(t);
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, type, status, published_at, author_id)
    VALUES ('legacy-feed', 'Legacy feed article', 'legacy-feed', 'Body', '<p>Body</p>', 'post', 'published', '2020-01-02 03:04:05', ?)`).run(session.user.id);
  db.prepare('UPDATE posts SET allow_ping = NULL, allow_feed = NULL WHERE id = ?').run('legacy-feed');
  const xml = (await api.request('GET', '/api/v1/feed')).payload;
  assert.ok(xml.includes('Legacy feed article'), '未标记的历史行按默认开启处理');
  const sitemap = (await api.request('GET', '/api/v1/sitemap.xml')).payload;
  assert.ok(sitemap.includes('/2020/01/02/legacy-feed.html'), '历史行同样进 sitemap');
  const admin = await api.request('GET', '/api/v1/admin/posts/legacy-feed', { headers });
  assert.equal(admin.status, 200);
});
