import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRouter } from '../lib/router.js';
import { createAuth } from '../lib/auth.js';
import { json, error, validators } from '../lib/http.js';
import { plainText, renderMD } from '../lib/utils.js';
import { createAdminHelpers } from '../routes/admin/shared.js';
import { register as registerInstall } from '../routes/install.js';
import { register as registerPlugins } from '../routes/admin/plugins.js';
import { startApiServer } from './helpers/api-server.js';
import {
  activatePlugin, cleanupPluginLoadCopies, deactivatePlugin, createPluginContext, ensureBuiltinPlugin, loadPlugins, triggerHook, unloadPlugin,
} from '../lib/plugin-ext.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t) {
  const pluginsDir = mkdtempSync(join(tmpdir(), 'lill-plugin-integrity-'));
  writeFileSync(join(pluginsDir, 'package.json'), '{"type":"module"}');
  const db = new DatabaseSync(':memory:');
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // server.js 把建表 DDL 抽成了 `const SCHEMA_SQL = `…``（另有动态 db.exec 模板），
  // 直接匹配第一个 db.exec(`…`) 会抓到 ALTER TABLE ${table}… 这类动态语句；优先取常量，回退旧写法。
  const schemaSql = source.match(/const SCHEMA_SQL = `([\s\S]*?)`;/);
  db.exec(schemaSql ? schemaSql[1] : source.match(/db\.exec\(`([\s\S]*?)`\);/)[1]);
  const router = createRouter();
  const ctx = {
    db, router, route: router.route, json, error, validators,
    uid: randomUUID, slugify: value => value.toLowerCase(), plainText, renderMD,
    ...createAuth('install-plugin-test-only'),
    parseBody: req => req.bodyGate || Promise.resolve(req.body),
    authenticate: async () => ({ id: 'admin', role: 'admin' }),
    checkRateLimit: () => true,
    ensureBuiltinPlugin,
    PLUGINS_DIR: pluginsDir, THEMES_DIR: '/tmp/unused-integrity-themes',
    _hooks: new Map(), _adminMenus: [], _activePlugins: new Map(), settings: {},
  };
  ctx.activatePlugin = dir => activatePlugin(dir, pluginsDir, ctx);
  ctx.deactivatePlugin = dir => deactivatePlugin(dir, ctx._activePlugins);
  ctx.triggerHook = (name, ...args) => triggerHook(ctx, name, ...args);
  registerInstall(router, ctx);
  registerPlugins(router, ctx, createAdminHelpers(ctx, router));
  const pluginDirs = [];
  t.after(() => {
    for (const dir of pluginDirs) unloadPlugin(dir);
    db.close();
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  function plugin(code, { active = 0, registered = true, dir = `fixture-${randomUUID()}` } = {}) {
    pluginDirs.push(dir);
    const path = join(pluginsDir, dir);
    mkdirSync(path);
    writeFileSync(join(path, 'plugin.json'), JSON.stringify({
      name: dir, version: '1.0.0',
      settings: [{ key: 'secret', type: 'text' }, { key: 'count', type: 'number' }],
    }));
    if (code !== null) writeFileSync(join(path, 'index.js'), code);
    if (registered) {
      db.prepare('INSERT INTO plugins (id, dir, name, active) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), dir, dir, active);
    }
    return dir;
  }

  async function request(method, path, body = {}, bodyGate) {
    const matched = router.matchRoute(method, path);
    assert.ok(matched, `${method} ${path} must exist`);
    const response = {
      writeHead(status) { this.status = status; },
      end(text) { this.payload = JSON.parse(text); },
    };
    await matched.fn({
      url: path, body, bodyGate, headers: { host: 'integrity.test' },
      socket: { remoteAddress: '127.0.0.1' },
    }, response, matched.params);
    return response;
  }

  return {
    ctx, db, router, plugin, request,
    toggle: dir => request('POST', '/api/v1/admin/plugins/toggle', { dir }),
    active: dir => db.prepare('SELECT active FROM plugins WHERE dir = ?').get(dir)?.active ?? 0,
  };
}

function installBody(username) {
  return {
    site_name: `Site ${username}`, site_url: 'https://integrity.test',
    admin_username: username, admin_password: 'test-password-123',
    admin_email: `${username}@integrity.test`,
  };
}

const registrations = `
  ctx.route('GET', '/api/v1/fixture/' + ctx.dirName, (_req, res) => ctx.json(res, { live: true }));
  ctx.on('integrity.event', () => ctx.setConfig('events', ctx.getConfig('events', 0) + 1));
  ctx.addAdminMenu({ id: ctx.dirName, title: 'Fixture' });
`;

function assertRegistered(f, dir) {
  assert.ok(f.router.matchRoute('GET', '/api/v1/fixture/' + dir));
  assert.ok(f.ctx._hooks.get('integrity.event')?.some(hook => hook.plugin === dir));
  assert.ok(f.ctx._adminMenus.some(menu => menu.plugin === dir));
  assert.ok(f.ctx._activePlugins.has(dir));
}

function assertUnregistered(f, dir) {
  assert.equal(f.router.matchRoute('GET', '/api/v1/fixture/' + dir), null);
  assert.equal(f.ctx._hooks.get('integrity.event')?.some(hook => hook.plugin === dir) ?? false, false);
  assert.equal(f.ctx._adminMenus.some(menu => menu.plugin === dir), false);
  assert.equal(f.ctx._activePlugins.has(dir), false);
}

test('concurrent initial installs return one success and one 403 without a second administrator', async t => {
  const f = fixture(t);
  const firstBody = deferred();
  const secondBody = deferred();
  // Both handlers pass the pre-body check before either body is delivered.
  const first = f.request('POST', '/api/v1/install', {}, firstBody.promise);
  const second = f.request('POST', '/api/v1/install', {}, secondBody.promise);
  firstBody.resolve(installBody('first'));
  const winner = await first;
  secondBody.resolve(installBody('second'));
  const loser = await second;
  assert.equal(winner.status, 200);
  assert.equal(loser.status, 403);
  assert.equal(loser.payload.code, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count, 1);
  assert.equal(f.db.prepare('SELECT username FROM users').get().username, 'first');
  assert.equal(f.db.prepare("SELECT value FROM options WHERE key = 'site_name'").get().value, 'Site first');
  assert.equal(f.db.isTransaction, false);
});

test('installation failure rolls back the administrator and can be retried', async t => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER reject_site BEFORE INSERT ON options
    WHEN NEW.key = 'site_name' BEGIN SELECT RAISE(ABORT, 'fixture install failure'); END;`);
  const failed = await f.request('POST', '/api/v1/install', installBody('first'));
  assert.equal(failed.status, 500);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM options WHERE key = 'installed'").get().count, 0);
  assert.equal(f.db.isTransaction, false);
  f.db.exec('DROP TRIGGER reject_site');
  assert.equal((await f.request('POST', '/api/v1/install', installBody('retry'))).status, 200);
});

for (const [failure, code] of [
  ['missing entry', null],
  ['failed import', "import './missing-builtin.js'; export function activate() {}"],
  ['activation rejection', `export async function activate(ctx) {
    ${registrations}
    await Promise.resolve();
    throw new Error('fixture builtin activation failure');
  }`],
]) {
  test(`post-commit builtin ${failure} returns an installed session with a warning and disables the plugin`, async t => {
    const f = fixture(t);
    const dir = f.plugin(code, { dir: 'hello-world', registered: false });
    const response = await f.request('POST', '/api/v1/install', installBody('first'));
    assert.equal(response.status, 200, JSON.stringify(response.payload));
    assert.equal(response.payload.code, 0);
    const session = response.payload.data;
    assert.equal(session.installed, true);
    assert.equal(typeof session.token, 'string');
    assert.ok(session.token.length > 0);
    assert.equal(typeof session.csrfToken, 'string');
    assert.equal(session.user.username, 'first');
    assert.ok(session.warnings.some(warning => /hello-world/.test(warning)));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
    assert.equal(f.db.prepare("SELECT value FROM options WHERE key = 'installed'").get().value, 'true');
    assert.equal(f.db.isTransaction, false);
    assert.equal(f.active(dir), 0);
    assertUnregistered(f, dir);
    assert.equal((await f.request('POST', '/api/v1/install', installBody('second'))).status, 403);
  });
}

test('successful builtin activation and an administrator-disabled builtin preserve normal install semantics', async t => {
  for (const active of [0, 1]) {
    await t.test(`builtin active=${active}`, async t => {
      const f = fixture(t);
      const dir = f.plugin(`export function activate(ctx) { ${registrations} }`, { dir: 'hello-world', active });
      const response = await f.request('POST', '/api/v1/install', installBody('first'));
      assert.equal(response.status, 200);
      assert.equal(response.payload.data.warnings, undefined);
      assert.equal(f.active(dir), active);
      if (active) assertRegistered(f, dir);
      else assertUnregistered(f, dir);
    });
  }
});

test('real HTTP install keeps its committed administrator and session when the optional builtin fails', async t => {
  const api = await startApiServer();
  let db;
  t.after(async () => { db?.close(); await api.stop(); });
  const pluginsDir = join(dirname(api.dbPath), 'plugins');
  const builtinDir = join(pluginsDir, 'hello-world');
  mkdirSync(builtinDir, { recursive: true });
  writeFileSync(join(pluginsDir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(builtinDir, 'plugin.json'), '{"name":"Review builtin","version":"1.0.0"}');
  // Added after startup, so a cached startup activation cannot hide the failure.
  writeFileSync(join(builtinDir, 'index.js'), `export async function activate(ctx) {
    ctx.route('GET', '/api/v1/review-builtin', (_req, res) => ctx.json(res, { live: true }));
    ctx.addAdminMenu({ id: 'review-builtin', title: 'Broken builtin' });
    ctx.on('review.builtin', () => {});
    await Promise.resolve();
    throw new Error('review builtin activation failure');
  }`);
  const response = await api.request('POST', '/api/v1/install', { body: installBody('httpadmin') });
  db = new DatabaseSync(api.dbPath);
  const status = await api.request('GET', '/api/v1/install/status');
  const route = await api.request('GET', '/api/v1/review-builtin');
  const administrators = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
  const builtinActive = db.prepare("SELECT active FROM plugins WHERE dir = 'hello-world'").get()?.active;
  console.log('INSTALL_POST_COMMIT_EVIDENCE', JSON.stringify({
    status: response.status, installed: status.payload.data.installed, administrators,
    builtinActive, routeStatus: route.status, hasSession: !!response.payload.data?.token,
  }));
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.code, 0);
  assert.equal(status.payload.data.installed, true);
  assert.equal(administrators, 1);
  assert.equal(builtinActive, 0);
  assert.equal(route.status, 404);
  const session = response.payload.data;
  assert.ok(session.token && session.csrfToken);
  assert.match(session.warnings.join(' '), /review builtin activation failure/);
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  assert.equal((await api.request('GET', '/api/v1/admin/plugins', { headers })).status, 200);
  const menus = await api.request('GET', '/api/v1/admin/plugin-menus', { headers });
  assert.equal(menus.payload.data.some(menu => menu.plugin === 'hello-world'), false);
  assert.equal((await api.request('POST', '/api/v1/install', { body: installBody('second') })).status, 403);
});

for (const [failure, code] of [
  ['missing entry', null],
  ['failed module import', "import './does-not-exist.js'; export function activate() {}"],
  ['missing activate export', 'export const name = "no lifecycle";'],
]) {
  test(`plugin toggle rejects ${failure} without setting active`, async t => {
    const f = fixture(t);
    const dir = f.plugin(code);
    const response = await f.toggle(dir);
    assert.equal(response.status, 500);
    assert.equal(response.payload.code, 1);
    assert.match(response.payload.message, /启用失败/);
    assert.equal(f.active(dir), 0);
    assertUnregistered(f, dir);
  });
}

test('activation failure removes routes, hooks and menus without disrupting another plugin', async t => {
  const f = fixture(t);
  const good = f.plugin(`export function activate(ctx) { ${registrations} }`);
  assert.equal((await f.toggle(good)).status, 200);
  const broken = f.plugin(`export async function activate(ctx) {
    ${registrations}
    await Promise.resolve();
    throw new Error('fixture activation failure');
  }`);
  const response = await f.toggle(broken);
  assert.equal(response.status, 500);
  assert.equal(f.active(broken), 0);
  assertUnregistered(f, broken);
  assertRegistered(f, good);
  triggerHook(f.ctx, 'integrity.event');
  assert.equal(f.db.prepare('SELECT value FROM options WHERE key = ?').get(`plugin_${good}_events`).value, '1');
  assert.equal(f.db.prepare('SELECT value FROM options WHERE key = ?').get(`plugin_${broken}_events`), undefined);
});

test('a plugin upgrade loaded after restart executes the new module version', async t => {
  const f = fixture(t);
  const dir = f.plugin(`export function activate(ctx) {
    ctx.route('GET', '/api/v1/plugin-version-check', (_req, res) => ctx.json(res, { version: '1.0.0' }));
  }`);
  assert.equal((await f.toggle(dir)).status, 200);
  assert.equal((await f.request('GET', '/api/v1/plugin-version-check')).payload.data.version, '1.0.0');
  assert.equal((await f.toggle(dir)).status, 200);

  writeFileSync(join(f.ctx.PLUGINS_DIR, dir, 'plugin.json'), JSON.stringify({ name: dir, version: '2.0.0' }));
  writeFileSync(join(f.ctx.PLUGINS_DIR, dir, 'index.js'), `export function activate(ctx) {
    ctx.route('GET', '/api/v1/plugin-version-check', (_req, res) => ctx.json(res, { version: '2.0.0' }));
  }`);
  assert.equal((await f.toggle(dir)).status, 200);
  assert.equal((await f.request('GET', '/api/v1/plugin-version-check')).payload.data.version, '2.0.0');
});

test('replacing an installed plugin loads the new entry after disable and enable', async t => {
  const f = fixture(t);
  const dir = f.plugin(`export function activate(ctx) {
    ctx.route('GET', '/api/v1/plugin-version-check', (_req, res) => ctx.json(res, { version: '1.0.0' }));
  }`);
  assert.equal((await f.toggle(dir)).status, 200);
  let live = await f.request('GET', '/api/v1/plugin-version-check');
  assert.equal(live.payload.data.version, '1.0.0');

  assert.equal((await f.toggle(dir)).status, 200);
  writeFileSync(join(f.ctx.PLUGINS_DIR, dir, 'index.js'), `export function activate(ctx) {
    ctx.route('GET', '/api/v1/plugin-version-check', (_req, res) => ctx.json(res, { version: '2.0.0' }));
  }`);
  assert.equal((await f.toggle(dir)).status, 200);
  live = await f.request('GET', '/api/v1/plugin-version-check');
  assert.equal(live.payload.data.version, '2.0.0');
});

test('an activated plugin can read bundled files relative to its module at runtime', async t => {
  const f = fixture(t);
  const dir = f.plugin(`import { readFileSync } from 'node:fs';
    const asset = () => readFileSync(new URL('./asset.txt', import.meta.url), 'utf8');
    export function activate(ctx) {
      ctx.route('GET', '/api/v1/plugin-asset', (_req, res) => ctx.json(res, { text: asset() }));
    }
  `);
  writeFileSync(join(f.ctx.PLUGINS_DIR, dir, 'asset.txt'), 'bundled asset');
  assert.equal((await f.toggle(dir)).status, 200);
  const response = await f.request('GET', '/api/v1/plugin-asset');
  assert.equal(response.payload.data.text, 'bundled asset');
});

test('startup cleanup removes interrupted module copies but keeps active ones', async t => {
  const f = fixture(t);
  const dir = f.plugin('export function activate(ctx) { ctx.route("GET", "/api/v1/cleanup-check", (_req, res) => ctx.json(res, { ok: true })); }');
  assert.equal((await f.toggle(dir)).status, 200);
  const stale = join(f.ctx.PLUGINS_DIR, '.load-stale-fixture');
  mkdirSync(stale);
  writeFileSync(join(stale, 'index.js'), '');
  const removed = cleanupPluginLoadCopies(f.ctx.PLUGINS_DIR, f.ctx._activePlugins);
  assert.ok(removed >= 1);
  assert.equal(existsSync(stale), false);
});

test('failed activation restores a route it temporarily replaced', async t => {
  const f = fixture(t);
  f.router.route('GET', '/api/v1/shared-fixture', (_req, res) => json(res, { owner: 'core' }));
  const dir = f.plugin(`export function activate(ctx) {
    ctx.route('GET', '/api/v1/shared-fixture', (_req, res) => ctx.json(res, { owner: 'broken' }));
    throw new Error('fixture activation failure');
  }`);
  await f.toggle(dir);
  const response = await f.request('GET', '/api/v1/shared-fixture');
  assert.deepEqual(response.payload.data, { owner: 'core' });
  assert.equal(f.active(dir), 0);
});

for (const hasCoreRoute of [false, true]) {
  test(`disabling overwritten A then B never restores inactive A${hasCoreRoute ? ' and restores core' : ''}`, async t => {
    const f = fixture(t);
    const path = '/api/v1/review-shared';
    if (hasCoreRoute) f.router.route('GET', path, (_req, res) => json(res, { owner: 'core' }));
    const a = f.plugin(`export function activate(ctx) {
      ${registrations}
      ctx.route('GET', '${path}', (_req, res) => ctx.json(res, { owner: 'A' }));
    }`);
    const b = f.plugin(`export function activate(ctx) {
      ${registrations}
      ctx.route('GET', '${path}', (_req, res) => ctx.json(res, { owner: 'B' }));
    }`);
    assert.equal((await f.toggle(a)).status, 200);
    assert.equal((await f.toggle(b)).status, 200);
    assert.equal((await f.toggle(a)).payload.data.active, false);
    assert.equal((await f.request('GET', path)).payload.data.owner, 'B');
    assertRegistered(f, b);
    assert.equal((await f.toggle(b)).payload.data.active, false);
    assert.equal(f.active(a), 0);
    assert.equal(f.active(b), 0);
    assertUnregistered(f, a);
    assertUnregistered(f, b);
    if (hasCoreRoute) assert.equal((await f.request('GET', path)).payload.data.owner, 'core');
    else assert.equal(f.router.matchRoute('GET', path), null);
  });
}

test('real HTTP toggles never resurrect an inactive overwritten plugin route', async t => {
  const api = await startApiServer();
  let db;
  t.after(async () => { db?.close(); await api.stop(); });
  const install = await api.request('POST', '/api/v1/install', { body: installBody('httpadmin') });
  assert.equal(install.status, 200);
  const session = install.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const pluginsDir = join(dirname(api.dbPath), 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, 'package.json'), '{"type":"module"}');
  for (const dir of ['review-a', 'review-b']) {
    const path = join(pluginsDir, dir);
    mkdirSync(path);
    writeFileSync(join(path, 'plugin.json'), JSON.stringify({ name: dir, version: '1.0.0' }));
    writeFileSync(join(path, 'index.js'), `export function activate(ctx) {
      ctx.route('GET', '/api/v1/review-shared', (_req, res) => ctx.json(res, { owner: '${dir}' }));
    }`);
  }
  const toggle = dir => api.request('POST', '/api/v1/admin/plugins/toggle', { headers, body: { dir } });
  for (const dir of ['review-a', 'review-b']) assert.equal((await toggle(dir)).status, 200);
  assert.equal((await api.request('GET', '/api/v1/review-shared')).payload.data.owner, 'review-b');
  for (const dir of ['review-a', 'review-b']) {
    const response = await toggle(dir);
    assert.equal(response.status, 200);
    assert.equal(response.payload.data.active, false);
  }
  db = new DatabaseSync(api.dbPath);
  const active = db.prepare('SELECT dir, active FROM plugins ORDER BY dir').all();
  assert.ok(active.every(row => row.active === 0));
  const route = await api.request('GET', '/api/v1/review-shared');
  console.log('PLUGIN_ROUTE_OWNER_EVIDENCE', JSON.stringify({
    active, status: route.status, owner: route.payload.data?.owner,
  }));
  assert.equal(route.status, 404, JSON.stringify(route.payload));
});

test('plugin is persisted active only after asynchronous activation completes', async t => {
  const f = fixture(t);
  const entered = deferred();
  const release = deferred();
  f.ctx.settings = { entered: entered.resolve, release: release.promise };
  const dir = f.plugin(`export async function activate(ctx) {
    ctx.settings.entered();
    await ctx.settings.release;
    ${registrations}
  }`);
  const pending = f.toggle(dir);
  await entered.promise;
  try {
    assert.equal(f.active(dir), 0);
    assert.equal(f.ctx._activePlugins.has(dir), false);
  } finally {
    release.resolve();
    await pending;
  }
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.payload.data.active, true);
  assert.equal(f.active(dir), 1);
  assertRegistered(f, dir);
});

test('database failure after activation rolls back the runtime registrations', async t => {
  const f = fixture(t);
  const dir = f.plugin(`export function activate(ctx) { ${registrations} }
    export function deactivate() { throw new Error('rollback must not depend on plugin cleanup'); }`);
  f.db.exec(`CREATE TRIGGER reject_enable BEFORE UPDATE OF active ON plugins
    WHEN NEW.active = 1 BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END;`);
  const response = await f.toggle(dir);
  assert.equal(response.status, 500);
  assert.equal(f.active(dir), 0);
  assertUnregistered(f, dir);
});

test('new plugin activation failure does not create an active database record', async t => {
  const f = fixture(t);
  const dir = f.plugin(`export function activate(ctx) {
    ${registrations}
    throw new Error('fixture activation failure');
  }`, { registered: false });
  const response = await f.toggle(dir);
  assert.equal(response.status, 500);
  assert.equal(f.active(dir), 0);
  assertUnregistered(f, dir);
});

for (const [failure, declaration] of [
  ['synchronous throw', "export function deactivate() { throw new Error('fixture disable failure'); }"],
  ['asynchronous rejection', "export async function deactivate() { await Promise.resolve(); throw new Error('fixture disable failure'); }"],
]) {
  test(`disable ${failure} returns an error and preserves enabled state for retry`, async t => {
    const f = fixture(t);
    const dir = f.plugin(`export function activate(ctx) { ${registrations} }\n${declaration}`);
    assert.equal((await f.toggle(dir)).status, 200);
    const response = await f.toggle(dir);
    assert.equal(response.status, 500);
    assert.equal(response.payload.code, 1);
    assert.match(response.payload.message, /禁用失败/);
    assert.equal(f.active(dir), 1);
    assertRegistered(f, dir);
  });
}

test('disable awaits cleanup before persisting inactive and supports enabling again', async t => {
  const f = fixture(t);
  const entered = deferred();
  const release = deferred();
  f.ctx.settings = { entered: entered.resolve, release: release.promise };
  const dir = f.plugin(`export function activate(ctx) { ${registrations} }
    export async function deactivate(ctx) { ctx.settings.entered(); await ctx.settings.release; }`);
  assert.equal((await f.toggle(dir)).status, 200);
  const pending = f.toggle(dir);
  await entered.promise;
  try {
    assert.equal(f.active(dir), 1);
    assertRegistered(f, dir);
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal((await pending).status, 200);
  assert.equal(f.active(dir), 0);
  assertUnregistered(f, dir);
  assert.equal((await f.toggle(dir)).status, 200);
  assert.equal(f.active(dir), 1);
  assertRegistered(f, dir);
  assert.equal(f.ctx._hooks.get('integrity.event').filter(hook => hook.plugin === dir).length, 1);
});

test('failed inactive-state persistence restores the running plugin to match its enabled record', async t => {
  const f = fixture(t);
  const dir = f.plugin(`export function activate(ctx) { ${registrations} }`);
  assert.equal((await f.toggle(dir)).status, 200);
  f.db.exec(`CREATE TRIGGER reject_disable BEFORE UPDATE OF active ON plugins
    WHEN NEW.active = 0 BEGIN SELECT RAISE(ABORT, 'fixture disable persistence failure'); END;`);
  const response = await f.toggle(dir);
  assert.equal(response.status, 500);
  assert.equal(f.active(dir), 1);
  assertRegistered(f, dir);
});

test('concurrent toggles of one plugin reject the second operation instead of registering it twice', async t => {
  const f = fixture(t);
  const entered = deferred();
  const duplicate = deferred();
  const release = deferred();
  let activations = 0;
  f.ctx.settings = {
    entered() {
      if (++activations === 1) entered.resolve();
      else duplicate.resolve({ status: 'duplicate activation' });
    },
    release: release.promise,
  };
  const dir = f.plugin(`export async function activate(ctx) {
    ctx.settings.entered();
    await ctx.settings.release;
    ${registrations}
  }`);
  const first = f.toggle(dir);
  await entered.promise;
  const second = f.toggle(dir);
  try {
    const response = await Promise.race([second, duplicate.promise]);
    assert.equal(response.status, 409);
    assert.equal(response.payload.code, 1);
    assert.equal((await f.request('DELETE', '/api/v1/admin/plugins/' + dir)).status, 409);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  assert.equal(f.active(dir), 1);
  assertRegistered(f, dir);
  assert.equal(f.ctx._hooks.get('integrity.event').filter(hook => hook.plugin === dir).length, 1);
});

test('uninstall stops when deactivation fails rather than deleting a running plugin', async t => {
  const f = fixture(t);
  const dir = f.plugin(`export function activate(ctx) { ${registrations} }
    export async function deactivate() { throw new Error('fixture disable failure'); }`);
  assert.equal((await f.toggle(dir)).status, 200);
  const response = await f.request('DELETE', '/api/v1/admin/plugins/' + dir);
  assert.equal(response.status, 500);
  assert.equal(f.active(dir), 1);
  assertRegistered(f, dir);
  assert.ok(readFileSync(join(f.ctx.PLUGINS_DIR, dir, 'plugin.json'), 'utf8'));
});

test('startup activation failure removes partial registrations and clears the active flag', async t => {
  const f = fixture(t);
  const dir = f.plugin(`export async function activate(ctx) {
    ${registrations}
    throw new Error('fixture startup failure');
  }`, { active: 1 });
  const active = await loadPlugins(f.ctx.PLUGINS_DIR, f.ctx);
  assert.equal(active.has(dir), false);
  assert.equal(f.active(dir), 0);
  assertUnregistered(f, dir);
});

for (const existing of [false, true]) {
  test(`plugin config save keeps ${existing ? 'historical autoload' : 'new'} fields private and readable by the plugin`, async t => {
    const f = fixture(t);
    const dir = f.plugin('export function activate() {}');
    const key = `plugin_${dir}_secret`;
    if (existing) f.db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 1)')
      .run(randomUUID(), key, '"old-value"');
    const response = await f.request('PUT', `/api/v1/admin/plugins/${dir}/config`, { secret: 'private-value' });
    assert.equal(response.status, 200);
    const row = f.db.prepare('SELECT value, autoload FROM options WHERE key = ?').get(key);
    assert.equal(row.autoload, 0);
    assert.equal(row.value, '"private-value"');
    assert.equal(createPluginContext(f.ctx, dir).getConfig('secret'), 'private-value');
    const config = await f.request('GET', `/api/v1/admin/plugins/${dir}/config`);
    assert.equal(config.payload.data.values.secret, 'private-value');
  });
}

test('plugin runtime config writes also make historical public records private', t => {
  const f = fixture(t);
  const dir = f.plugin('export function activate() {}');
  const key = `plugin_${dir}_secret`;
  f.db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 1)')
    .run(randomUUID(), key, '"old-value"');
  const context = createPluginContext(f.ctx, dir);
  context.setConfig('secret', 'runtime-private-value');
  assert.equal(context.getConfig('secret'), 'runtime-private-value');
  assert.equal(f.db.prepare('SELECT autoload FROM options WHERE key = ?').get(key).autoload, 0);
});
