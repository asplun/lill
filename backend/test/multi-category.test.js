import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Multi category test',
    site_url: api.baseUrl,
    admin_username: 'multi-admin',
    admin_email: 'multi-admin@example.test',
    admin_password: 'multi-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  const category = async (name, slug) => {
    const response = await api.request('POST', '/api/v1/admin/categories', { headers, body: { name, slug } });
    assert.equal(response.status, 201, JSON.stringify(response.payload));
    return response.payload.data;
  };
  const createPost = (body) => api.request('POST', '/api/v1/admin/posts', { headers, body });
  return { api, db, headers, session, category, createPost };
}

const bootstrap = (api, path) => api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(path));

const countBySlug = async (api, key) => {
  const publicCats = await api.request('GET', '/api/v1/categories');
  assert.equal(publicCats.status, 200, JSON.stringify(publicCats.payload));
  return Object.fromEntries(publicCats.payload.data.map(item => [item.slug, item.post_count]));
};

test('一篇文章挂两个分类：两个分类页都能查到，计数各 1，详情返回两个分类，category_id 保持主分类', async t => {
  const { api, headers, category, createPost } = await setup(t);
  const alpha = await category('Alpha', 'alpha');
  const omega = await category('Omega', 'omega');
  const created = await createPost({
    title: '双分类文章', content: '多分类正文', status: 'published',
    categoryIds: [alpha.id, omega.id],
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const post = created.payload.data;

  // 写库：关系表两行，主分类仍是数组第一项
  const detail = await api.request('GET', '/api/v1/admin/posts/' + post.id, { headers });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  assert.equal(detail.payload.data.category_id, alpha.id, '主分类必须是 categoryIds 第一项');
  assert.deepEqual([...detail.payload.data.categoryIds].sort(), [alpha.id, omega.id].sort());
  assert.equal(detail.payload.data.categories.length, 2);

  // 公开详情返回两个分类
  const publicPost = await api.request('GET', '/api/v1/posts/' + post.slug);
  assert.equal(publicPost.status, 200, JSON.stringify(publicPost.payload));
  assert.equal(publicPost.payload.data.categories.length, 2);
  assert.equal(publicPost.payload.data.category_id, alpha.id);

  // 两个分类页都查得到这篇
  for (const slug of ['alpha', 'omega']) {
    const page = await bootstrap(api, '/category/' + slug + '/');
    assert.equal(page.status, 200, slug + ': ' + JSON.stringify(page.payload));
    assert.equal(page.payload.data.page.type, 'category', slug);
    assert.ok(page.payload.data.data.posts.some(item => item.id === post.id), slug + ' 分类页缺少文章');
  }

  // 公开分类计数各 1（不会因关系表/主分类重复算成 2）
  const publicCounts = await countBySlug(api);
  assert.equal(publicCounts.alpha, 1, JSON.stringify(publicCounts));
  assert.equal(publicCounts.omega, 1, JSON.stringify(publicCounts));

  // 后台分类计数同样走 DISTINCT，各 1
  const adminCats = await api.request('GET', '/api/v1/admin/categories', { headers });
  assert.equal(adminCats.status, 200, JSON.stringify(adminCats.payload));
  const adminCounts = Object.fromEntries(adminCats.payload.data.map(item => [item.slug, item.post_count]));
  assert.equal(adminCounts.alpha, 1, JSON.stringify(adminCounts));
  assert.equal(adminCounts.omega, 1, JSON.stringify(adminCounts));
});

test('只有 posts.category_id 的旧数据（直接 SQL 写入）也能被分类页与计数命中', async t => {
  const { api, db, headers, session, category } = await setup(t);
  const legacy = await category('Legacy', 'legacy');
  db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, type, status, published_at, author_id, category_id, visibility)
    VALUES ('legacy-post', '旧数据文章', 'legacy-post', 'legacy', '<p>legacy</p>', 'post', 'published', '2024-01-01 00:00:00', ?, ?, 'public')`)
    .run(session.user.id, legacy.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM post_categories WHERE post_id = ?').get('legacy-post').c, 0);

  const page = await bootstrap(api, '/category/legacy/');
  assert.equal(page.status, 200, JSON.stringify(page.payload));
  assert.ok(page.payload.data.data.posts.some(item => item.id === 'legacy-post'), '旧数据未出现在分类页');

  const publicCounts = await countBySlug(api);
  assert.equal(publicCounts.legacy, 1, JSON.stringify(publicCounts));

  const adminCats = await api.request('GET', '/api/v1/admin/categories', { headers });
  const adminCounts = Object.fromEntries(adminCats.payload.data.map(item => [item.slug, item.post_count]));
  assert.equal(adminCounts.legacy, 1, JSON.stringify(adminCounts));

  // 后台按分类筛选（categoryId）同样能查到旧数据
  const filtered = await api.request('GET', '/api/v1/admin/posts?categoryId=' + legacy.id, { headers });
  assert.equal(filtered.status, 200, JSON.stringify(filtered.payload));
  assert.ok(filtered.payload.data.items.some(item => item.id === 'legacy-post'), '后台筛选未命中旧数据');
});

test('PUT categoryIds:[] 解绑全部分类，再传单个分类只剩主分类', async t => {
  const { api, headers, category, createPost } = await setup(t);
  const first = await category('First', 'first');
  const second = await category('Second', 'second');
  const created = await createPost({
    title: '解绑文章', content: '解绑正文', status: 'published',
    categoryIds: [first.id, second.id],
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const post = created.payload.data;

  const cleared = await api.request('PUT', '/api/v1/admin/posts/' + post.id, { headers, body: { categoryIds: [] } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.payload));
  const afterClear = await api.request('GET', '/api/v1/admin/posts/' + post.id, { headers });
  assert.deepEqual(afterClear.payload.data.categoryIds, []);
  assert.equal(afterClear.payload.data.category_id, null);
  const publicPost = await api.request('GET', '/api/v1/posts/' + post.slug);
  assert.deepEqual(publicPost.payload.data.categories, []);
  for (const slug of ['first', 'second']) {
    const page = await bootstrap(api, '/category/' + slug + '/');
    assert.ok(!page.payload.data.data.posts.some(item => item.id === post.id), slug + ' 分类页仍能查到已解绑文章');
  }
  const clearedCounts = await countBySlug(api);
  assert.equal(clearedCounts.first, 0, JSON.stringify(clearedCounts));
  assert.equal(clearedCounts.second, 0, JSON.stringify(clearedCounts));

  const single = await api.request('PUT', '/api/v1/admin/posts/' + post.id, { headers, body: { categoryIds: [second.id] } });
  assert.equal(single.status, 200, JSON.stringify(single.payload));
  const afterSingle = await api.request('GET', '/api/v1/admin/posts/' + post.id, { headers });
  assert.deepEqual(afterSingle.payload.data.categoryIds, [second.id]);
  assert.equal(afterSingle.payload.data.category_id, second.id);
  const singleCounts = await countBySlug(api);
  assert.equal(singleCounts.first, 0, JSON.stringify(singleCounts));
  assert.equal(singleCounts.second, 1, JSON.stringify(singleCounts));
});

test('非法分类 id 或非数组 categoryIds 返回 400，且不写入', async t => {
  const { api, headers, category, createPost } = await setup(t);
  const keep = await category('Keep', 'keep');
  const created = await createPost({
    title: '校验文章', content: '校验正文', status: 'published', categoryIds: [keep.id],
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const post = created.payload.data;

  const missing = await createPost({ title: '缺分类文章', content: 'x', categoryIds: ['missing-category'] });
  assert.equal(missing.status, 400, JSON.stringify(missing.payload));
  assert.match(String(missing.payload.message || ''), /分类不存在/);

  const wrongType = await createPost({ title: '错误类型文章', content: 'x', categoryIds: 'not-an-array' });
  assert.equal(wrongType.status, 400, JSON.stringify(wrongType.payload));

  const updateMissing = await api.request('PUT', '/api/v1/admin/posts/' + post.id, {
    headers, body: { categoryIds: [keep.id, 'missing-category'] },
  });
  assert.equal(updateMissing.status, 400, JSON.stringify(updateMissing.payload));
  const afterFailure = await api.request('GET', '/api/v1/admin/posts/' + post.id, { headers });
  assert.deepEqual(afterFailure.payload.data.categoryIds, [keep.id], '失败请求不应改动已有分类');
  assert.equal(afterFailure.payload.data.category_id, keep.id);
});
