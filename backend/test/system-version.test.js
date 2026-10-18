import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

test('system version comes from the backend package with a custom theme directory', async t => {
  const api = await startApiServer();
  t.after(() => api.stop());
  const install = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Version test', site_url: api.baseUrl,
    admin_username: 'version-admin', admin_email: 'version@example.test',
    admin_password: 'version-test-password-123',
  } });
  assert.equal(install.status, 200);
  const headers = { authorization: 'Bearer ' + install.payload.data.token };
  const result = await api.request('GET', '/api/v1/admin/system/version', { headers });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(result.payload.data.name, '@lill/backend');
  assert.equal(result.payload.data.version, pkg.version);
  assert.match(result.payload.data.node, /^v\d+\./);
});
