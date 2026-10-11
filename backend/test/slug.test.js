import assert from 'node:assert/strict';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

const password = 'test-password-123';
const headers = session => ({ authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken });

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const r = await api.request('POST', '/api/v1/install', { body: { site_name: 'Slug test', site_url: 'http://localhost', admin_username: 'admin', admin_password: password, admin_email: 'admin@example.test' } });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
  const login = await api.request('POST', '/api/v1/auth/login', { body: { username: 'admin', password } });
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  return { api, admin: login.payload.data };
}

function createPost(api, admin, body) {
  return api.request('POST', '/api/v1/admin/posts', { headers: headers(admin), body: { status: 'published', content: 'Body', ...body } });
}

test('自定义别名：规范化、唯一性、中文支持与更新', async t => {
  const { api, admin } = await setup(t);

  // 自定义别名会规范化：首尾空白去除、空格与标点折叠为连字符
  const custom = await createPost(api, admin, { title: 'Hello World Title', slug: ' My Custom Slug! ' });
  assert.equal(custom.status, 201, JSON.stringify(custom.payload));
  assert.equal(custom.payload.data.slug, 'my-custom-slug');

  // 与已有别名冲突时返回 409
  const dup = await createPost(api, admin, { title: 'Another', slug: 'my-custom-slug' });
  assert.equal(dup.status, 409, JSON.stringify(dup.payload));
  assert.match(dup.payload.message, /占用/);

  // 未提供别名时按标题生成；重名自动追加 -2
  const auto1 = await createPost(api, admin, { title: 'Auto Generated' });
  assert.equal(auto1.payload.data.slug, 'auto-generated');
  const auto2 = await createPost(api, admin, { title: 'Auto Generated' });
  assert.equal(auto2.payload.data.slug, 'auto-generated-2');

  // 中文别名保留，可通过 URL 编码访问公开接口
  const zh = await createPost(api, admin, { title: '中文标题', slug: '中文-别名' });
  assert.equal(zh.payload.data.slug, '中文-别名');
  const fetched = await api.request('GET', '/api/v1/posts/' + encodeURIComponent('中文-别名'));
  assert.equal(fetched.status, 200, JSON.stringify(fetched.payload));
  assert.equal(fetched.payload.data.title, '中文标题');

  // 更新：与自身相同不算冲突，与其它文章冲突则 409
  const id = custom.payload.data.id;
  const same = await api.request('PUT', '/api/v1/admin/posts/' + id, { headers: headers(admin), body: { slug: 'my-custom-slug' } });
  assert.equal(same.status, 200, JSON.stringify(same.payload));
  const renamed = await api.request('PUT', '/api/v1/admin/posts/' + id, { headers: headers(admin), body: { slug: 'Renamed Post' } });
  assert.equal(renamed.payload.data.slug, 'renamed-post');
  const clash = await api.request('PUT', '/api/v1/admin/posts/' + id, { headers: headers(admin), body: { slug: 'auto-generated' } });
  assert.equal(clash.status, 409);

  // 仅由标点组成的别名会被拒绝
  const invalid = await createPost(api, admin, { title: 'Punctuation', slug: '!!!' });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.payload));

  // 独立页面同样支持自定义别名
  const page = await createPost(api, admin, { title: 'About', type: 'page', slug: 'about-us' });
  assert.equal(page.status, 201, JSON.stringify(page.payload));
  assert.equal(page.payload.data.slug, 'about-us');
});
