import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startApiServer } from './helpers/api-server.js';

const password = 'page-hierarchy-password-123';
const siteUrl = 'https://pages.example.test';
let api, db, admin;
const headers = session => ({ authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken });
const write = (method, path, body) => api.request(method, path, { headers: headers(admin), body });
const data = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.payload));
  return response.payload.data;
};
const createPage = async (title, slug, parentId) => data(await write('POST', '/api/v1/admin/posts', {
  title, slug, content: 'Body', type: 'page', status: 'published',
  ...(parentId === undefined ? {} : { parentId }),
}), 201);
// 主题访问页面时会同时带上 type=page（theme.js 的 bootstrap 请求），顶层页面靠它走回退解析
const boot = (path, type = 'page') => api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent(path) + (type ? '&type=' + type : ''));
const pageRow = id => db.prepare('SELECT id, slug, type, parent_id FROM posts WHERE id = ?').get(id);

async function fresh() {
  if (api) { await api.stop(); api = null; }
  api = await startApiServer();
  data(await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Page hierarchy', site_url: siteUrl,
    admin_username: 'admin', admin_password: password, admin_email: 'admin@example.test',
  } }));
  admin = data(await api.request('POST', '/api/v1/auth/login', { body: { username: 'admin', password } }));
  db = new DatabaseSync(api.dbPath);
  db.prepare('DELETE FROM posts').run();
}

async function teardown() {
  if (db) { db.close(); db = null; }
  if (api) { await api.stop(); api = null; }
}

test('nested pages resolve through their parent directories', async () => {
  await fresh();
  try {
    const parent = await createPage('Docs', 'docs');
    const child = await createPage('Install', 'install', parent.id);
    const grandchild = await createPage('Linux', 'linux', child.id);
    assert.equal(pageRow(child.id).parent_id, parent.id);
    assert.equal(pageRow(grandchild.id).parent_id, child.id);

    for (const [path, page] of [['/docs', parent], ['/docs/install', child], ['/docs/install/linux', grandchild]]) {
      const res = await boot(path);
      assert.equal(res.status, 200, path + ' ' + JSON.stringify(res.payload).slice(0, 300));
      assert.equal(res.payload.data.page.type, 'page', path);
      assert.equal(res.payload.data.data.post.id, page.id, path);
      assert.equal(res.payload.data.data.post.route, path, path);
      assert.equal(res.payload.data.data.post.permalink, siteUrl + path, path);
    }

    // 后台页面列表返回 parent_id，供编辑器父级下拉与列表缩进使用
    const listed = await write('GET', '/api/v1/admin/pages?page=1&pageSize=100');
    assert.equal(listed.status, 200, JSON.stringify(listed.payload));
    const rows = listed.payload.data.items;
    assert.equal(rows.find(item => item.id === child.id).parent_id, parent.id);
    assert.equal(rows.find(item => item.id === parent.id).parent_id ?? null, null);

    // 旧的 /page/<slug> 别名继续可解析（顶层页面）
    const legacy = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent('/page/docs'));
    assert.equal(legacy.status, 200, JSON.stringify(legacy.payload).slice(0, 300));
    assert.equal(legacy.payload.data.data.post.id, parent.id);
  } finally {
    await teardown();
  }
});

test('navigation lists hierarchy URLs and depths', async () => {
  await fresh();
  try {
    const parent = await createPage('Docs', 'docs');
    await createPage('Install', 'install', parent.id);
    const res = await boot('/', 'index');
    assert.equal(res.status, 200, JSON.stringify(res.payload).slice(0, 300));
    const pages = res.payload.data.nav.filter(item => item.type === 'page');
    assert.deepEqual(pages.map(item => [item.slug, item.url, item.depth]), [
      ['docs', '/docs', 0],
      ['install', '/docs/install', 1],
    ]);
  } finally {
    await teardown();
  }
});

test('page hierarchy rejects cycles and misplaced parents', async () => {
  await fresh();
  try {
    const parent = await createPage('Docs', 'docs');
    const child = await createPage('Install', 'install', parent.id);
    const article = data(await write('POST', '/api/v1/admin/posts', { title: 'Article', content: 'Body', status: 'published' }), 201);

    const selfParent = await write('PUT', '/api/v1/admin/posts/' + parent.id, { parentId: parent.id });
    assert.equal(selfParent.status, 400);
    assert.match(selfParent.payload.message, /自身/);

    const cycle = await write('PUT', '/api/v1/admin/posts/' + parent.id, { parentId: child.id });
    assert.equal(cycle.status, 400);
    assert.match(cycle.payload.message, /子页面/);

    const missing = await write('PUT', '/api/v1/admin/posts/' + child.id, { parentId: 'missing-page' });
    assert.equal(missing.status, 400);
    assert.match(missing.payload.message, /父级页面不存在/);

    const notPage = await write('PUT', '/api/v1/admin/posts/' + child.id, { parentId: article.id });
    assert.equal(notPage.status, 400);
    assert.match(notPage.payload.message, /父级页面不存在/);

    const articleWithParent = await write('POST', '/api/v1/admin/posts', {
      title: 'Nested article', content: 'Body', parentId: parent.id,
    });
    assert.equal(articleWithParent.status, 400);
    assert.match(articleWithParent.payload.message, /只有独立页面/);

    const detached = await write('PUT', '/api/v1/admin/posts/' + child.id, { parentId: null });
    assert.equal(detached.status, 200);
    assert.equal(pageRow(child.id).parent_id ?? null, null);

    const res = await boot('/install');
    assert.equal(res.status, 200, JSON.stringify(res.payload).slice(0, 300));
    assert.equal(res.payload.data.data.post.id, child.id);
  } finally {
    await teardown();
  }
});

test('deleting a parent page promotes its children instead of orphaning them', async () => {
  await fresh();
  try {
    const parent = await createPage('Docs', 'docs');
    const child = await createPage('Install', 'install', parent.id);
    const removed = await write('DELETE', '/api/v1/admin/posts/' + parent.id);
    assert.equal(removed.status, 200, JSON.stringify(removed.payload));
    assert.equal(pageRow(child.id).parent_id ?? null, null);

    const res = await boot('/install');
    assert.equal(res.status, 200, JSON.stringify(res.payload).slice(0, 300));
    assert.equal(res.payload.data.data.post.id, child.id);
  } finally {
    await teardown();
  }
});
