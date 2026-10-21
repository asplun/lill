import assert from 'node:assert/strict';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

test('unknown public paths return a themed 404 bootstrap payload', async t => {
  const api = await startApiServer();
  t.after(api.stop);

  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: '一个薄荷', site_url: 'https://blog.example.test',
    admin_username: 'admin', admin_password: 'test-password-123', admin_email: 'admin@example.test',
  } });
  assert.equal(installed.status, 200);
  const session = installed.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const created = await api.request('POST', '/api/v1/admin/posts', { headers, body: {
    title: 'Recent post', slug: 'recent-post', content: '<p>Recent</p>', type: 'post', status: 'published',
  } });
  assert.equal(created.status, 201);

  const boot = await api.request('GET', '/api/v1/site/bootstrap?type=index&slug=&path=%2Fzzz-no-such-page');
  assert.equal(boot.status, 404);
  assert.equal(boot.payload.data.page.type, '404');
  assert.equal(boot.payload.data.page.title, '页面没找到');
  assert.equal(boot.payload.code, 0);
  assert.ok(boot.payload.data.sidebar.recentPosts.length > 0);
});
