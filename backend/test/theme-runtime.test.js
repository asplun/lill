import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouter } from '../lib/router.js';
import { loadThemeRuntime, mergeThemeConfig, publicThemeConfig, registerThemeExtensions, runThemeMigrations } from '../lib/theme-runtime.js';

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
