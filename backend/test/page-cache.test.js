import assert from 'node:assert/strict';
import test from 'node:test';
import * as pageCache from '../lib/page-cache.js';
import { startApiServer } from './helpers/api-server.js';

test('bootstrap sends MISS then HIT without failing the first response', async t => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let api;
  try {
    api = await startApiServer();
  } finally {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  }
  t.after(api.stop);
  const install = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Cache Test', site_url: 'http://localhost', admin_username: 'cache-admin',
    admin_password: 'test-password-123', admin_email: 'cache@example.test',
  }});
  assert.equal(install.status, 200);

  const first = await api.request('GET', '/api/v1/site/bootstrap?type=index&cache_test=unique');
  const second = await api.request('GET', '/api/v1/site/bootstrap?type=index&cache_test=unique');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-cache'), 'MISS');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-cache'), 'HIT');
});

test('bootstrap bypasses authenticated requests and varies by identity headers', async t => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let api;
  try {
    api = await startApiServer();
  } finally {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  }
  t.after(api.stop);
  const install = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Cache Test', site_url: 'http://localhost', admin_username: 'cache-admin',
    admin_password: 'test-password-123', admin_email: 'cache@example.test',
  }});
  assert.equal(install.status, 200);

  const path = '/api/v1/site/bootstrap?type=index&cache_test=identity';
  const authenticated = await api.request('GET', path, { headers: { cookie: 'sid=fake' } });
  assert.equal(authenticated.headers.get('x-cache'), 'BYPASS');
  assert.match(authenticated.headers.get('vary'), /Cookie/);
  assert.match(authenticated.headers.get('vary'), /Authorization/);

  const firstAnonymous = await api.request('GET', path);
  const secondAnonymous = await api.request('GET', path);
  assert.equal(firstAnonymous.headers.get('x-cache'), 'MISS');
  assert.equal(secondAnonymous.headers.get('x-cache'), 'HIT');
  assert.match(secondAnonymous.headers.get('vary'), /Cookie/);
  assert.match(secondAnonymous.headers.get('vary'), /Authorization/);
});

test('page cache stores bytes and clearAll invalidates them', () => {
  pageCache.clearAll();
  assert.equal(pageCache.get('/bootstrap'), null);
  pageCache.set('/bootstrap', Buffer.from('{"ok":true}'));
  assert.equal(pageCache.get('/bootstrap').toString(), '{"ok":true}');
  pageCache.clearAll();
  assert.equal(pageCache.get('/bootstrap'), null);
});
