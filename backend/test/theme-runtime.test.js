import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouter } from '../lib/router.js';
import { loadThemeRuntime, mergeThemeConfig, publicThemeConfig, registerThemeExtension, registerThemeExtensions, runThemeMigrations } from '../lib/theme-runtime.js';

async function fixtureThemes() {
  const root = await mkdtemp(join(tmpdir(), 'lill-theme-runtime-'));
  for (const id of ['fixture-a', 'fixture-b']) {
    await mkdir(join(root, id, 'backend'), { recursive: true });
    await writeFile(join(root, id, 'theme.json'), JSON.stringify({ id, name: id, settings: [
      { key: 'enabled', type: 'checkbox', default: false },
      { key: 'limit', type: 'number', default: 3 },
      { key: 'label', type: 'text', default: 'default' },
      { key: 'secret', type: 'text', default: 'manifest-secret', private: true },
    ] }));
    await writeFile(join(root, id, 'backend', 'index.js'), `export function register(router, ctx) { ctx.received = '${id}'; router.route('GET', '/api/v1/${id}', (_req, res) => res.end('${id}')); }`);
  }
  await mkdir(join(root, 'default'), { recursive: true });
  await writeFile(join(root, 'default', 'theme.json'), JSON.stringify({ id: 'default', name: 'Default' }));
  return root;
}

test('theme runtime merges manifest defaults and normalizes checkbox and number settings', () => {
  const manifest = { settings: [
    { key: 'enabled', type: 'checkbox', default: false }, { key: 'limit', type: 'number', default: 3 },
    { key: 'label', type: 'text', default: 'default' }, { key: 'secret', type: 'text', default: 'manifest-secret', private: true },
  ] };
  const config = mergeThemeConfig(manifest, { enabled: 'true', limit: '12', label: '', unknown: 'drop-me', secret: 'runtime-secret' });
  assert.deepEqual(config, { enabled: true, limit: 12, label: '', secret: 'runtime-secret' });
  assert.deepEqual(publicThemeConfig(manifest, config), { enabled: true, limit: 12, label: '' });
});

test('theme runtime loads a default theme without a backend extension', async t => {
  const themesDir = await fixtureThemes(); t.after(() => rm(themesDir, { recursive: true, force: true }));
  const runtime = await loadThemeRuntime(themesDir);
  assert.ok(runtime.manifests.has('default')); assert.equal(runtime.extensions.has('default'), false);
  assert.deepEqual(runtime.publicConfig('default', { unknown: 'drop-me' }), {});
});

test('theme runtime rejects directory and manifest id mismatch', async t => {
  const themesDir = await fixtureThemes();
  await mkdir(join(themesDir, 'wrong-dir'), { recursive: true });
  await writeFile(join(themesDir, 'wrong-dir', 'theme.json'), JSON.stringify({ id: 'other-id', name: 'Wrong' }));
  t.after(() => rm(themesDir, { recursive: true, force: true }));
  const runtime = await loadThemeRuntime(themesDir);
  assert.equal(runtime.manifests.has('wrong-dir'), false); assert.equal(runtime.extensions.has('wrong-dir'), false);
});

test('theme extension receives ctx and migrations run only when explicitly called', async t => {
  const themesDir = await mkdtemp(join(tmpdir(), 'lill-theme-migration-'));
  await mkdir(join(themesDir, 'migratable', 'backend'), { recursive: true });
  await writeFile(join(themesDir, 'migratable', 'theme.json'), JSON.stringify({ id: 'migratable', settings: [] }));
  await writeFile(join(themesDir, 'migratable', 'backend', 'index.js'), `export function register(router, ctx) { ctx.received = true; } export async function runThemeMigrations(ctx) { ctx.migrated = true; return 'ok'; }`);
  t.after(() => rm(themesDir, { recursive: true, force: true }));
  const runtime = await loadThemeRuntime(themesDir); const ctx = {};
  registerThemeExtensions(createRouter(), ctx, runtime.extensions, () => 'migratable', () => {});
  assert.equal(ctx.received, true); assert.equal(ctx.migrated, undefined);
  assert.deepEqual(await runThemeMigrations(runtime, 'migratable', ctx), { themeId: 'migratable', migrated: true, result: 'ok' });
  assert.equal(ctx.migrated, true);
});

test('theme extension routes are isolated to the active theme and switch immediately', async t => {
  const themesDir = await fixtureThemes(); t.after(() => rm(themesDir, { recursive: true, force: true }));
  const runtime = await loadThemeRuntime(themesDir); let active = 'fixture-a'; const router = createRouter(); const ctx = {};
  registerThemeExtensions(router, ctx, runtime.extensions, () => active, res => res.end('404'));
  assert.equal(ctx.received, 'fixture-b'); assert.equal(await routeResponse(router, 'GET', '/api/v1/fixture-a'), 'fixture-a');
  assert.equal(await routeResponse(router, 'GET', '/api/v1/fixture-b'), '404'); active = 'fixture-b';
  assert.equal(await routeResponse(router, 'GET', '/api/v1/fixture-a'), '404'); assert.equal(await routeResponse(router, 'GET', '/api/v1/fixture-b'), 'fixture-b');
});

async function routeResponse(router, method, path) {
  const route = router.matchRoute(method, path); assert.ok(route, path); const chunks = [];
  await route.fn({ method, url: path }, { end(value) { chunks.push(value); } }, route.params); return chunks.join('');
}

test('theme runtime replaces extension routes after an installed theme is upgraded', async t => {
  const themesDir = await fixtureThemes();
  t.after(() => rm(themesDir, { recursive: true, force: true }));
  const runtime = await loadThemeRuntime(themesDir);
  const router = createRouter();
  let active = 'fixture-a';
  const ctx = {};
  const notFound = res => res.end('404');
  registerThemeExtensions(router, ctx, runtime.extensions, () => active, notFound);
  assert.equal(await routeResponse(router, 'GET', '/api/v1/fixture-a'), 'fixture-a');
  const entry = join(themesDir, 'fixture-a', 'backend', 'index.js');
  await writeFile(entry, `export function register(router) { router.route('GET', '/api/v1/fixture-a', (_req, res) => res.end('fixture-a-v2')); }`);
  await utimes(entry, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
  await runtime.loadTheme('fixture-a');
  assert.equal(registerThemeExtension(router, ctx, runtime.extensions, 'fixture-a', () => active, notFound), true);
  assert.equal(await routeResponse(router, 'GET', '/api/v1/fixture-a'), 'fixture-a-v2');
});

test('theme runtime ignores a backend directory without a manifest', async t => {
  const themesDir = await mkdtemp(join(tmpdir(), 'lill-theme-no-manifest-'));
  await mkdir(join(themesDir, 'orphan', 'backend'), { recursive: true });
  await writeFile(join(themesDir, 'orphan', 'backend', 'index.js'), `export function register() { throw new Error('orphan extension should not load'); }`);
  t.after(() => rm(themesDir, { recursive: true, force: true }));
  await mkdir(join(themesDir, 'nameless', 'backend'), { recursive: true });
  await writeFile(join(themesDir, 'nameless', 'theme.json'), JSON.stringify({ name: 'Nameless' }));
  await writeFile(join(themesDir, 'nameless', 'backend', 'index.js'), `export function register() { throw new Error('nameless extension should not load'); }`);
  await mkdir(join(themesDir, 'mismatch', 'backend'), { recursive: true });
  await writeFile(join(themesDir, 'mismatch', 'theme.json'), JSON.stringify({ id: 'other', name: 'Mismatch' }));
  await writeFile(join(themesDir, 'mismatch', 'backend', 'index.js'), `export function register() { throw new Error('mismatch extension should not load'); }`);
  const runtime = await loadThemeRuntime(themesDir);
  assert.equal(runtime.manifests.has('orphan'), false);
  assert.equal(runtime.manifests.has('nameless'), false);
  assert.equal(runtime.manifests.has('mismatch'), false);
  assert.equal(runtime.extensions.has('orphan'), false);
  assert.equal(runtime.extensions.has('nameless'), false);
  assert.equal(runtime.extensions.has('mismatch'), false);
});
test('failed extension reload keeps the previously loaded extension available', async t => {
  const themesDir = await fixtureThemes();
  t.after(() => rm(themesDir, { recursive: true, force: true }));
  const runtime = await loadThemeRuntime(themesDir);
  const previous = runtime.extensions.get('fixture-a');
  const previousManifest = runtime.manifests.get('fixture-a');
  const entry = join(themesDir, 'fixture-a', 'backend', 'index.js');
  await writeFile(entry, 'export function register( {');
  await utimes(entry, new Date('2030-01-02T00:00:00Z'), new Date('2030-01-02T00:00:00Z'));
  const result = await runtime.loadTheme('fixture-a');
  assert.ok(result?.loadError);
  assert.equal(runtime.extensions.get('fixture-a'), previous);
  assert.equal(runtime.manifests.get('fixture-a'), previousManifest);
});
test('failed extension registration restores the previous routes and runtime module', async t => {
  const themesDir = await fixtureThemes();
  t.after(() => rm(themesDir, { recursive: true, force: true }));
  const runtime = await loadThemeRuntime(themesDir);
  const router = createRouter();
  const ctx = {};
  const notFound = res => res.end('404');
  registerThemeExtensions(router, ctx, runtime.extensions, () => 'fixture-a', notFound);
  const previous = runtime.extensions.get('fixture-a');
  const entry = join(themesDir, 'fixture-a', 'backend', 'index.js');
  await writeFile(entry, `export function register() { throw new Error('bad upgrade'); }`);
  await utimes(entry, new Date('2030-01-03T00:00:00Z'), new Date('2030-01-03T00:00:00Z'));
  await runtime.loadTheme('fixture-a');
  assert.equal(registerThemeExtension(router, ctx, runtime.extensions, 'fixture-a', () => 'fixture-a', notFound), false);
  assert.equal(runtime.extensions.get('fixture-a'), previous);
  assert.equal(await routeResponse(router, 'GET', '/api/v1/fixture-a'), 'fixture-a');
});

test('theme runtime loads the backend entry declared by the manifest', async t => {
  const themesDir = await mkdtemp(join(tmpdir(), 'lill-theme-entry-'));
  await mkdir(join(themesDir, 'declared-entry', 'server'), { recursive: true });
  await writeFile(join(themesDir, 'declared-entry', 'theme.json'), JSON.stringify({
    id: 'declared-entry', name: 'Declared Entry',
    backend: { entry: 'server/extension.mjs', protocol: 1 }, settings: [],
  }));
  await writeFile(join(themesDir, 'declared-entry', 'server', 'extension.mjs'), `
    export function register(router) {
      router.route('GET', '/api/v1/declared-entry', (_req, res) => res.end('declared'));
    }
  `);
  t.after(() => rm(themesDir, { recursive: true, force: true }));

  const runtime = await loadThemeRuntime(themesDir);
  assert.equal(typeof runtime.extensions.get('declared-entry')?.register, 'function');
});

test('theme runtime rejects a backend entry that escapes the theme directory', async t => {
  const themesDir = await mkdtemp(join(tmpdir(), 'lill-theme-entry-invalid-'));
  await mkdir(join(themesDir, 'invalid-entry'), { recursive: true });
  await writeFile(join(themesDir, 'invalid-entry', 'theme.json'), JSON.stringify({
    id: 'invalid-entry', name: 'Invalid Entry',
    backend: { entry: '../outside.js', protocol: 1 }, settings: [],
  }));
  t.after(() => rm(themesDir, { recursive: true, force: true }));

  const runtime = await loadThemeRuntime(themesDir);
  assert.equal(runtime.extensions.has('invalid-entry'), false);
});
