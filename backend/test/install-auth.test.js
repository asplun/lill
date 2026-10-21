import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApiServer } from './helpers/api-server.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const source = readFileSync(join(ROOT, 'backend', 'routes', 'install.js'), 'utf8');

test('installation response includes the CSRF token needed by the first admin session', () => {
  assert.match(source, /generateCSRFToken/);
  assert.match(source, /csrf:\s*csrfToken/);
  assert.match(source, /csrfToken,/);
});

test('installation log endpoint returns a valid empty log instead of crashing', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  const response = await api.request('GET', '/api/v1/install/log');
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.ok(Array.isArray(response.payload.data.logs));
});
