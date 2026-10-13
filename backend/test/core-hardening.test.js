import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function install(api, username = 'hardening-admin') {
  const response = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Hardening Test', site_url: 'http://localhost',
    admin_username: username, admin_password: 'test-password-123',
    admin_email: `${username}@example.test`,
  }});
  assert.equal(response.status, 200, JSON.stringify(response.payload));
}

async function login(api, username = 'hardening-admin') {
  const response = await api.request('POST', '/api/v1/auth/login', { body: {
    username, password: 'test-password-123',
  }});
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  return response.payload.data;
}

async function writeFixtureTheme(themesDir) {
  const dir = join(themesDir, 'settings-fixture');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'theme.json'), JSON.stringify({
    id: 'settings-fixture', name: 'Settings Fixture', version: '1.0.0',
    settings: [
      { key: 'accent', type: 'text', default: 'violet' },
      { key: 'enabled', type: 'checkbox', default: false },
      { key: 'secret', type: 'text', default: 'unset', private: true },
    ],
  }));
}

function sessionHeaders(session) {
  return { authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken };
}

async function writeLateTheme(themesDir) {
  const dir = join(themesDir, 'late-fixture');
  await mkdir(join(dir, 'backend'), { recursive: true });
  await writeFile(join(dir, 'theme.json'), JSON.stringify({
    id: 'late-fixture', name: 'Late Fixture', version: '1.0.0', settings: [],
  }));
  await writeFile(join(dir, 'backend', 'index.js'), `export function register(router, ctx) {
    router.route('GET', '/api/v1/late-fixture/probe', (_req, res) => ctx.json(res, { loaded: true }));
  }`);
}


test('theme activation loads a backend extension added after server startup', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);
  const session = await login(api);
  await writeLateTheme(api.themesDir);

  const activation = await api.request('POST', '/api/v1/admin/themes/late-fixture/activate', {
    headers: sessionHeaders(session), body: {},
  });
  assert.equal(activation.status, 200, JSON.stringify(activation.payload));

  const probe = await api.request('GET', '/api/v1/late-fixture/probe');
  assert.equal(probe.status, 200, JSON.stringify(probe.payload));
  assert.deepEqual(probe.payload.data, { loaded: true });
});


test('theme activation allows a theme without a backend extension', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);
  const session = await login(api);

  const activation = await api.request('POST', '/api/v1/admin/themes/default/activate', {
    headers: sessionHeaders(session), body: {},
  });
  assert.equal(activation.status, 200, JSON.stringify(activation.payload));
  assert.deepEqual(activation.payload.data, { themeId: 'default', active: true });
});

test('theme activation rejects a manifest whose backend extension cannot load', async t => {
  const api = await startApiServer({ prepareThemes: async themesDir => {
    const dir = join(themesDir, 'broken-load');
    await mkdir(join(dir, 'backend'), { recursive: true });
    await writeFile(join(dir, 'theme.json'), JSON.stringify({ id: 'broken-load', name: 'Broken Load', settings: [] }));
    await writeFile(join(dir, 'backend', 'index.js'), 'export function register( {');
  }});
  t.after(api.stop);
  await install(api);
  const session = await login(api);

  const activation = await api.request('POST', '/api/v1/admin/themes/broken-load/activate', {
    headers: sessionHeaders(session), body: {},
  });
  assert.equal(activation.status, 500, JSON.stringify(activation.payload));
  assert.equal(activation.payload.message, '主题后端扩展加载失败');

  const db = new DatabaseSync(api.dbPath);
  assert.equal(db.prepare('SELECT theme_id FROM themes WHERE active = 1').get().theme_id, 'default');
  db.close();
});

test('theme settings persist only manifest fields and normalize declared values', async t => {
  const api = await startApiServer({ prepareThemes: writeFixtureTheme });
  t.after(api.stop);
  await install(api);
  const session = await login(api);
  const headers = sessionHeaders(session);
  const db = new DatabaseSync(api.dbPath);
  db.prepare('UPDATE themes SET config = ? WHERE theme_id = ?').run(JSON.stringify({ legacyKey: 'keep-during-upgrade' }), 'settings-fixture');
  db.close();

  const save = await api.request('PUT', '/api/v1/admin/themes/settings-fixture/settings', {
    headers,
    body: { accent: 'blue', enabled: 'true', secret: 'kept-private', unknown: 'must-drop' },
  });
  assert.equal(save.status, 200, JSON.stringify(save.payload));
  assert.deepEqual(save.payload.data, { legacyKey: 'keep-during-upgrade', accent: 'blue', enabled: true, secret: 'kept-private' });

  const read = await api.request('GET', '/api/v1/admin/themes/settings-fixture/settings', { headers });
  assert.equal(read.status, 200, JSON.stringify(read.payload));
  assert.deepEqual(read.payload.data.values, { legacyKey: 'keep-during-upgrade', accent: 'blue', enabled: true, secret: 'kept-private' });
  assert.equal(Object.hasOwn(read.payload.data.values, 'unknown'), false);
});

test('theme activation rejects a theme that has no manifest directory', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);
  const session = await login(api);
  const response = await api.request('POST', '/api/v1/admin/themes/does-not-exist/activate', {
    headers: sessionHeaders(session), body: {},
  });
  assert.equal(response.status, 404, JSON.stringify(response.payload));

  const db = new DatabaseSync(api.dbPath);
  assert.equal(db.prepare('SELECT 1 FROM themes WHERE theme_id = ?').get('does-not-exist'), undefined);
  assert.equal(db.prepare('SELECT theme_id FROM themes WHERE active = 1').get().theme_id, 'default');
  db.close();
});

test('widget management starts with the core widget schema', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);
  const session = await login(api);
  const response = await api.request('GET', '/api/v1/admin/widgets', { headers: sessionHeaders(session) });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.deepEqual(response.payload.data, []);
});

test('default theme posts_per_page controls bootstrap pagination', async t => {
  const api = await startApiServer({ prepareThemes: async themesDir => {
    await mkdir(join(themesDir, 'default'), { recursive: true });
    await writeFile(join(themesDir, 'default', 'theme.json'), JSON.stringify({ id: 'default', name: 'Default', settings: [{ key: 'posts_per_page', type: 'number', default: 10 }] }));
  }});
  t.after(api.stop);
  await install(api);
  const db = new DatabaseSync(api.dbPath);
  db.prepare('UPDATE themes SET config = ? WHERE theme_id = ?').run(JSON.stringify({ posts_per_page: '1' }), 'default');
  db.close();

  const response = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.data.data.pagination.pageSize, 1);
});

test('theme settings load the manifest for a theme added after server startup', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);
  await writeFixtureTheme(api.themesDir);
  const db = new DatabaseSync(api.dbPath);
  db.prepare('INSERT INTO themes (id, theme_id, name, version, active) VALUES (?, ?, ?, ?, 0)').run(
    'settings-fixture-row', 'settings-fixture', 'Settings Fixture', '1.0.0');
  db.close();
  const session = await login(api);
  const save = await api.request('PUT', '/api/v1/admin/themes/settings-fixture/settings', {
    headers: sessionHeaders(session),
    body: { accent: 'blue', enabled: 'true' },
  });
  assert.equal(save.status, 200, JSON.stringify(save.payload));
  assert.deepEqual(save.payload.data, { accent: 'blue', enabled: true, secret: 'unset' });
});
