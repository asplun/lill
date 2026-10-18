import assert from 'node:assert/strict';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Media widget test',
    site_url: api.baseUrl,
    admin_username: 'media-admin',
    admin_email: 'media-admin@example.test',
    admin_password: 'media-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  return {
    api,
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-csrf-token': session.csrfToken,
    },
  };
}

test('media and widget mutations reject missing records and invalid input', async t => {
  const { api, headers } = await setup(t);

  assert.equal((await api.request('DELETE', '/api/v1/admin/media/missing', { headers })).status, 404);
  assert.equal((await api.request('PUT', '/api/v1/admin/widgets/missing', {
    headers,
    body: { name: 'Missing', type: 'text' },
  })).status, 404);
  assert.equal((await api.request('DELETE', '/api/v1/admin/widgets/missing', { headers })).status, 404);

  for (const body of [
    {},
    { name: '', type: 'text' },
    { name: 'Widget', type: '' },
    { name: 123, type: 'text' },
    { name: 'Widget', type: 'text', sort_order: 'not-a-number' },
  ]) {
    const response = await api.request('POST', '/api/v1/admin/widgets', { headers, body });
    assert.equal(response.status, 400, JSON.stringify(response.payload));
  }
});
