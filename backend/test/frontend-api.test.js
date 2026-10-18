import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../frontend/public/api.js', import.meta.url), 'utf8');
const ok = value => JSON.stringify({ code: 0, data: value });
const deferred = () => Promise.withResolvers();

async function client(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const storage = new Map();
  const context = vm.createContext({
    window: {}, AbortController, setTimeout, clearTimeout,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    location: { pathname: '/admin/', href: '/admin/' },
    fetch: (url, config) => fetch(`http://127.0.0.1:${server.address().port}${url}`, config),
  });
  vm.runInContext(source, context);
  return context.window.lillAPI;
}

test('concurrent GETs in one render share a request', async t => {
  let calls = 0;
  const api = await client(t, (_req, res) => {
    calls++;
    res.end(ok('shared'));
  });
  api.newRenderScope();
  assert.deepEqual(await Promise.all([api.get('/themes'), api.get('/themes')]), ['shared', 'shared']);
  assert.equal(calls, 1);
});

test('opening the same page immediately after cancelling it starts a fresh GET', async t => {
  const api = await client(t, (_req, res) => res.end(ok('new-page')));
  api.newRenderScope();
  const old = api.get('/themes').then(() => 'completed', () => 'cancelled');
  api.newRenderScope();
  const current = api.get('/themes');
  assert.equal(await old, 'cancelled');
  assert.equal(await current, 'new-page');
});

test('a cancelled request cannot evict the replacement GET from deduplication', async t => {
  const arrived = deferred();
  const release = deferred();
  let calls = 0;
  const api = await client(t, async (_req, res) => {
    calls++;
    arrived.resolve();
    await release.promise;
    res.end(ok('current'));
  });
  t.after(() => release.resolve());
  api.newRenderScope();
  const old = api.get('/themes').catch(() => {});
  api.newRenderScope();
  const current = api.get('/themes');
  await old;
  // Let the cancelled request's cleanup run before the third subscriber joins.
  await new Promise(resolve => setImmediate(resolve));
  await arrived.promise;
  const joined = api.get('/themes');
  release.resolve();
  assert.deepEqual(await Promise.all([current, joined]), ['current', 'current']);
  assert.equal(calls, 1);
});

test('timeout remains active while the response body is downloading', async t => {
  const api = await client(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"code":0,"data":');
    // A stalled body must settle through the client's deadline.
  });
  const result = await Promise.race([
    api.get('/slow-body', { timeout: 80 }).then(() => 'resolved', error => error.message),
    new Promise(resolve => {
      const timer = setTimeout(() => resolve('still waiting for body'), 600);
      t.after(() => clearTimeout(timer));
    }),
  ]);
  assert.equal(result, '请求超时，请重试');
});

test('navigation cancels response bodies already downloading', async t => {
  const headersArrived = deferred();
  const release = deferred();
  const api = await client(t, async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"code":0,"data":');
    headersArrived.resolve();
    await release.promise;
    res.end('"old-page"}');
  });
  t.after(() => release.resolve());
  api.newRenderScope();
  const old = api.get('/slow-body').then(() => 'rendered stale page', error => error.message);
  await headersArrived.promise;
  await new Promise(resolve => setTimeout(resolve, 25));
  api.newRenderScope();
  release.resolve();
  assert.equal(await old, '请求已取消');
});

test('requests with independent cancellation signals do not cancel each other', async t => {
  const api = await client(t, (_req, res) => res.end(ok('independent')));
  const first = new AbortController();
  const second = new AbortController();
  const old = api.get('/themes', { signal: first.signal }).catch(() => 'cancelled');
  const current = api.get('/themes', { signal: second.signal });
  first.abort();
  assert.equal(await old, 'cancelled');
  assert.equal(await current, 'independent');
});
