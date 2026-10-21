/**
 * Typecho 导出导入验收测试。
 *
 * 夹具按 Typecho 1.x 的 XMLRPC 备份惯例手写（methodCall → params → param → struct，
 * posts 数组里每个 struct 带 post_id/post_title/post_date/post_name/post_content/post_status/
 * post_type/categories/tags）；仓库里没有真实导出样本，格式来源记在回执里。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTypechoDate, parseTypechoExport } from '../lib/typecho-import.js';
import { startApiServer } from './helpers/api-server.js';

const ADMIN_PASSWORD = 'typecho-test-password-123';

const escapeXml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const member = (name, valueXml) => '<member><name>' + name + '</name><value>' + valueXml + '</value></member>';
const text = value => '<string>' + escapeXml(value) + '</string>';
const listValue = values => '<array><data>'
  + values.map(value => '<value>' + text(value) + '</value>').join('')
  + '</data></array>';

function postXml(post) {
  return '<value><struct>' + [
    member('post_id', text(post.post_id)),
    member('post_title', text(post.post_title)),
    member('post_date', text(post.post_date)),
    member('post_name', text(post.post_name)),
    member('post_content', text(post.post_content)),
    member('post_status', text(post.post_status)),
    member('post_type', text(post.post_type || 'post')),
    member('categories', listValue(post.categories || [])),
    member('tags', listValue(post.tags || [])),
  ].join('') + '</struct></value>';
}

function buildExport(posts) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<methodCall>\n<methodName>typecho_backup</methodName>\n<params>\n<param><value><struct>\n'
    + '<member><name>posts</name><value><array><data>\n'
    + posts.map(postXml).join('\n')
    + '\n</data></array></value></member>\n'
    + '</struct></value></param>\n</params>\n</methodCall>\n';
}

const FIXTURE = [
  {
    post_id: '101',
    post_title: '你好 Typecho',
    post_date: '2023-05-06 07:08:09',
    post_name: 'hello-typecho',
    post_content: '# 你好 Typecho\n\n从 Typecho 迁移来的第一篇文章。',
    post_status: 'publish',
    categories: ['默认分类'],
    tags: ['导入', 'Typecho'],
  },
  {
    post_id: '102',
    post_title: 'Typecho 草稿',
    post_date: '2023-05-07 09:10:11',
    post_name: '',
    post_content: '这篇在 Typecho 里是草稿。',
    post_status: 'draft',
    tags: ['Typecho'],
  },
  {
    post_id: '201',
    post_title: '关于本站',
    post_date: '2023-05-08 10:11:12',
    post_name: '',
    post_content: '这是一个独立页面。',
    post_status: 'published',
    post_type: 'page',
    categories: ['默认分类'],
    tags: [],
  },
];

const EXPORT_TEXT = buildExport(FIXTURE);

async function startAdmin(t) {
  const api = await startApiServer();
  t.after(async () => { await api.stop(); });
  const installed = await api.request('POST', '/api/v1/install', {
    body: {
      site_name: 'Typecho 导入测试站',
      site_url: api.baseUrl,
      admin_username: 'admin',
      admin_email: 'admin@example.com',
      admin_password: ADMIN_PASSWORD,
    },
    timeout: 15000,
  });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  return {
    api,
    session,
    headers: { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken },
  };
}

test('parseTypechoExport 解析 XMLRPC 备份并规范化字段', () => {
  const items = parseTypechoExport(EXPORT_TEXT);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    id: '101',
    title: '你好 Typecho',
    slug: 'hello-typecho',
    content: '# 你好 Typecho\n\n从 Typecho 迁移来的第一篇文章。',
    status: 'published',
    type: 'post',
    date: '2023-05-06 07:08:09',
    categories: ['默认分类'],
    tags: ['导入', 'Typecho'],
  });
  assert.equal(items[1].status, 'draft');
  assert.equal(items[1].type, 'post');
  assert.equal(items[2].type, 'page');
  assert.equal(items[2].status, 'published');
});

test('parseTypechoExport 拒绝非 Typecho 内容，normalizeTypechoDate 兼容多种时间格式', () => {
  assert.throws(() => parseTypechoExport('<html><body>not typecho</body></html>'), /不是有效的 Typecho 导出文件/);
  assert.throws(() => parseTypechoExport(''), /不是有效的 Typecho 导出文件/);
  assert.throws(() => parseTypechoExport(buildExport([])), /不是有效的 Typecho 导出文件/);
  assert.equal(normalizeTypechoDate('2023-05-06 07:08:09'), '2023-05-06 07:08:09');
  assert.equal(normalizeTypechoDate('20230506T070809'), '2023-05-06 07:08:09');
  assert.equal(normalizeTypechoDate('2023-05-06T07:08:09Z'), '2023-05-06 07:08:09');
  assert.equal(normalizeTypechoDate('not-a-date'), null);
  assert.equal(normalizeTypechoDate('2023-02-30 00:00:00'), null);
});

test('dryRun 只预览不落库，正式导入写入文章/页面/分类/标签', async t => {
  const { api, session, headers } = await startAdmin(t);

  // 安装时自带一条 Hello World 与「未分类」；预览要确认这些数字不变。
  const before = await api.request('GET', '/api/v1/admin/posts?status=ALL', { headers });
  assert.equal(before.payload.data.meta.total, 1);

  const preview = await api.request('POST', '/api/v1/admin/import/typecho', { headers, body: { text: EXPORT_TEXT } });
  assert.equal(preview.status, 200, JSON.stringify(preview.payload));
  assert.deepEqual(preview.payload.data, {
    dryRun: true, total: 3, posts: 2, pages: 1, categories: 1, tags: 2, skipped: 0,
  });

  const afterPreview = await api.request('GET', '/api/v1/admin/posts?status=ALL', { headers });
  assert.equal(afterPreview.payload.data.meta.total, 1, 'dryRun 不能写文章');
  const previewCategories = await api.request('GET', '/api/v1/admin/categories', { headers });
  assert.equal(previewCategories.payload.data.length, 1, 'dryRun 不能写分类');
  const previewTags = await api.request('GET', '/api/v1/admin/tags', { headers });
  assert.equal(previewTags.payload.data.meta.total, 0, 'dryRun 不能写标签');

  const imported = await api.request('POST', '/api/v1/admin/import/typecho', {
    headers, body: { text: EXPORT_TEXT, dryRun: false },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.payload));
  assert.deepEqual(imported.payload.data, {
    dryRun: false, total: 3, posts: 2, pages: 1, categories: 1, tags: 2, skipped: 0,
  });

  const posts = await api.request('GET', '/api/v1/admin/posts?status=ALL', { headers });
  assert.equal(posts.payload.data.meta.total, 3);
  const importedPost = posts.payload.data.items.find(item => item.id === 'typecho-101');
  assert.ok(importedPost, '缺少 typecho-101');
  assert.equal(importedPost.status, 'published');
  assert.equal(importedPost.slug, 'hello-typecho');
  assert.equal(importedPost.category_name, '默认分类');
  const draft = posts.payload.data.items.find(item => item.id === 'typecho-102');
  assert.equal(draft.status, 'draft');

  const detail = await api.request('GET', '/api/v1/admin/posts/typecho-101', { headers });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  const post = detail.payload.data;
  assert.equal(post.content, FIXTURE[0].post_content, '正文必须原样保存 Markdown');
  assert.match(post.html_content, /<h1[^>]*>你好 Typecho<\/h1>/);
  assert.equal(post.published_at, '2023-05-06 07:08:09');
  assert.equal(post.author_id, session.user.id);
  assert.deepEqual(post.tags.map(tag => tag.name).sort(), ['Typecho', '导入']);
  assert.deepEqual(post.categories.map(category => category.name), ['默认分类']);

  const draftDetail = await api.request('GET', '/api/v1/admin/posts/typecho-102', { headers });
  assert.equal(draftDetail.payload.data.published_at, null);

  const pages = await api.request('GET', '/api/v1/admin/pages', { headers });
  const page = pages.payload.data.items.find(item => item.id === 'typecho-201');
  assert.ok(page, '缺少 typecho-201 页面');
  const pageDetail = await api.request('GET', '/api/v1/admin/posts/typecho-201', { headers });
  assert.deepEqual(pageDetail.payload.data.categories, [], '页面不挂分类');

  // 同一份导出再来一次：全部按 id 命中跳过，不覆盖、不重复。
  const again = await api.request('POST', '/api/v1/admin/import/typecho', {
    headers, body: { text: EXPORT_TEXT, dryRun: false },
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.payload.data, {
    dryRun: false, total: 3, posts: 0, pages: 0, categories: 0, tags: 0, skipped: 3,
  });
  const afterAgain = await api.request('GET', '/api/v1/admin/posts?status=ALL', { headers });
  assert.equal(afterAgain.payload.data.meta.total, 3);
});

test('别名已被占用时整条跳过，不覆盖现有文章', async t => {
  const { api, headers } = await startAdmin(t);
  const occupied = await api.request('POST', '/api/v1/admin/posts', {
    headers,
    body: { title: '占用别名的文章', slug: 'hello-typecho', content: '原有内容', status: 'published' },
  });
  assert.equal(occupied.status, 201, JSON.stringify(occupied.payload));

  const imported = await api.request('POST', '/api/v1/admin/import/typecho', {
    headers, body: { text: buildExport([FIXTURE[0]]), dryRun: false },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.payload));
  assert.deepEqual(imported.payload.data, {
    dryRun: false, total: 1, posts: 0, pages: 0, categories: 0, tags: 0, skipped: 1,
  });

  const missing = await api.request('GET', '/api/v1/admin/posts/typecho-101', { headers });
  assert.equal(missing.status, 404);
  const kept = await api.request('GET', '/api/v1/admin/posts/' + occupied.payload.data.id, { headers });
  assert.equal(kept.payload.data.title, '占用别名的文章');
  assert.equal(kept.payload.data.content, '原有内容');
});

test('坏文件与非法参数返回 4xx，不写库', async t => {
  const { api, headers } = await startAdmin(t);

  const bad = await api.request('POST', '/api/v1/admin/import/typecho', { headers, body: { text: 'hello world' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.message, '不是有效的 Typecho 导出文件');

  const empty = await api.request('POST', '/api/v1/admin/import/typecho', { headers, body: { text: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.payload.message, '请粘贴 Typecho 导出文件内容');

  const badDryRun = await api.request('POST', '/api/v1/admin/import/typecho', { headers, body: { text: EXPORT_TEXT, dryRun: 'yes' } });
  assert.equal(badDryRun.status, 400);
  assert.equal(badDryRun.payload.message, 'dryRun 必须是布尔值');

  const count = await api.request('GET', '/api/v1/admin/posts?status=ALL', { headers });
  assert.equal(count.payload.data.meta.total, 1, '失败请求不能写库');
});
