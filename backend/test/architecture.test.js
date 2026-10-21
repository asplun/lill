import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouter } from '../lib/router.js';
import { register as registerAdmin } from '../routes/admin/index.js';
import { register as registerPublic } from '../routes/public.js';

function context() {
  return {
    db: { prepare() { throw new Error('not called during registration'); } },
    json() {}, error() {}, parseBody() {}, validators: {}, uid() { return 'id'; },
    slugify() { return 'slug'; }, renderMD() {}, plainText() {}, hashPwd() {},
    authenticate() {}, readThemeManifest() {}, UPLOAD_DIR: '/tmp/uploads',
    THEMES_DIR: '/tmp/themes', PLUGINS_DIR: '/tmp/plugins', deactivatePlugin() {},
    activatePlugin() {}, loadPlugin() {}, scanPlugins() {}, loadPlugins() {},
    triggerHook() {}, _activePlugins: new Map(), _hooks: new Map(),
  };
}

test('admin entry registers the complete management route set exactly once', () => {
  const router = createRouter();
  registerAdmin(router, context());
  const routes = [...router.routes.values()].filter(route => route.pattern.startsWith('/api/v1/admin/'));
  assert.equal(routes.length, 97);
  assert.equal(new Set(router.routes.keys()).size, routes.length);
  for (const route of routes) {
    assert.equal(route.auth, true, route.pattern);
    assert.ok(Array.isArray(route.roles) && route.roles.length, route.pattern);
  }
});

test('theme editor field schema is available to all content roles, not only theme managers', () => {
  const router = createRouter();
  registerAdmin(router, context());
  const route = router.routes.get('GET:/api/v1/admin/editor-fields');
  assert.deepEqual(route.roles, ['admin', 'editor', 'author', 'contributor']);
  assert.equal(route.auth, true);
});

test('plugin editor extension routes are available to content roles and remain authenticated', () => {
  const router = createRouter();
  registerAdmin(router, context());
  for (const path of [
    'GET:/api/v1/admin/editor-extensions',
    'GET:/api/v1/admin/editor-assets/:dir',
    'POST:/api/v1/admin/editor-actions/:plugin/:action',
  ]) {
    const route = router.routes.get(path);
    assert.ok(route, path);
    assert.equal(route.auth, true);
    assert.deepEqual(route.roles, ['admin', 'editor', 'author', 'contributor']);
  }
});

test('admin entry preserves parameter matching metadata', () => {
  const router = createRouter();
  registerAdmin(router, context());
  const matched = router.matchRoute('GET', '/api/v1/admin/posts/post-1');
  assert.deepEqual(matched.params, { id: 'post-1' });
  assert.equal(matched.pattern, '/api/v1/admin/posts/:id');
});
test('content module owns the autosave and revision routes', () => {
  const router = createRouter();
  registerAdmin(router, context());
  for (const path of [
    'POST:/api/v1/admin/posts/:id/autosave',
    'GET:/api/v1/admin/posts/:id/autosave',
    'DELETE:/api/v1/admin/posts/:id/autosave',
    'GET:/api/v1/admin/posts/:id/versions',
    'GET:/api/v1/admin/posts/:id/versions/:versionId',
    'POST:/api/v1/admin/posts/:id/versions/:versionId/restore',
  ]) {
    const route = router.routes.get(path);
    assert.ok(route, path);
    assert.equal(route.auth, true);
    assert.deepEqual(route.roles, ['admin', 'editor', 'author', 'contributor']);
  }
  const matched = router.matchRoute('POST', '/api/v1/admin/posts/post-1/versions/ver-1/restore');
  assert.deepEqual(matched.params, { id: 'post-1', versionId: 'ver-1' });
});

import { register as registerComments } from '../routes/admin/comments.js';

test('comments module owns every comment management route', () => {
  const router = createRouter();
  registerComments(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin', 'editor'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/comments/:id',
    'GET:/api/v1/admin/comments',
    'GET:/api/v1/admin/comments/export',
    'GET:/api/v1/admin/comments/recent',
    'PATCH:/api/v1/admin/comments/:id/status',
    'PATCH:/api/v1/admin/comments/batch-status',
    'POST:/api/v1/admin/comments/batch-delete',
    'POST:/api/v1/admin/comments/:id/reply',
    'PUT:/api/v1/admin/comments/:id',
  ].sort());
});
import { register as registerMedia } from '../routes/admin/media.js';

test('media module owns upload, list, edit, replace, and delete routes', () => {
  const router = createRouter();
  registerMedia(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin', 'editor', 'author', 'contributor'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/media/:id',
    'GET:/api/v1/admin/media',
    'POST:/api/v1/admin/media/batch',
    'POST:/api/v1/admin/media/:id/replace',
    'POST:/api/v1/admin/media/upload',
    'PUT:/api/v1/admin/media/:id',
  ].sort());
});
import { register as registerUsers } from '../routes/admin/users.js';

test('users module owns user management routes', () => {
  const router = createRouter();
  registerUsers(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/users/:id',
    'GET:/api/v1/admin/users',
    'GET:/api/v1/admin/users/:id',
    'POST:/api/v1/admin/users',
    'POST:/api/v1/admin/users/batch',
    'PUT:/api/v1/admin/users/:id',
  ].sort());
});
import { register as registerSettings } from '../routes/admin/settings.js';

test('settings module owns site options routes', () => {
  const router = createRouter();
  registerSettings(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'GET:/api/v1/admin/options',
    'POST:/api/v1/admin/permalinks/resolve',
    'PUT:/api/v1/admin/options',
  ].sort());
});
import { register as registerThemes } from '../routes/admin/themes.js';

test('themes module owns theme listing, activation, settings, install, and editor routes', () => {
  const router = createRouter();
  registerThemes(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'GET:/api/v1/admin/themes',
    'GET:/api/v1/admin/themes/:themeId/settings',
    'GET:/api/v1/admin/themes/file',
    'GET:/api/v1/admin/themes/files',
    'DELETE:/api/v1/admin/themes/:themeId',
    'POST:/api/v1/admin/themes/batch',
    'POST:/api/v1/admin/themes/:themeId/activate',
    'POST:/api/v1/admin/themes/install',
    'PUT:/api/v1/admin/themes/:themeId/settings',
    'PUT:/api/v1/admin/themes/file',
  ].sort());
});
import { register as registerPlugins } from '../routes/admin/plugins.js';

test('plugins module owns plugin lifecycle, menus, config, install, and delete routes', () => {
  const router = createRouter();
  registerPlugins(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/plugins/:dir',
    'GET:/api/v1/admin/plugin-menus',
    'GET:/api/v1/admin/plugins',
    'GET:/api/v1/admin/plugins/:dir/config',
    'POST:/api/v1/admin/plugins/batch',
    'POST:/api/v1/admin/plugins/install',
    'POST:/api/v1/admin/plugins/toggle',
    'PUT:/api/v1/admin/plugins/:dir/config',
  ].sort());
});
import { register as registerSystem } from '../routes/admin/system.js';

test('system module owns dashboard stats, logs, backups, system health, and site routes', () => {
  const router = createRouter();
  registerSystem(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/backup',
    'DELETE:/api/v1/admin/logs',
    'GET:/api/v1/admin/backup/:name/download',
    'GET:/api/v1/admin/backup/list',
    'GET:/api/v1/admin/backup/progress',
    'GET:/api/v1/admin/logs',
    'GET:/api/v1/admin/logs/stats',
    'GET:/api/v1/admin/sites',
    'GET:/api/v1/admin/stats/dashboard',
    'GET:/api/v1/admin/stats/system',
    'GET:/api/v1/admin/system/health',
    'GET:/api/v1/admin/system/monitor',
    'GET:/api/v1/admin/system/version',
    'POST:/api/v1/admin/backup',
    'POST:/api/v1/admin/backup/restore',
    'POST:/api/v1/admin/logs/batch',
  ].sort());
});
import { register as registerImport } from '../routes/admin/import.js';

test('import module owns the Typecho import route', () => {
  const router = createRouter();
  registerImport(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()], ['POST:/api/v1/admin/import/typecho']);
});

test('admin entry exposes the Typecho import route to admins only', () => {
  const router = createRouter();
  registerAdmin(router, context());
  const route = router.routes.get('POST:/api/v1/admin/import/typecho');
  assert.ok(route, 'POST:/api/v1/admin/import/typecho');
  assert.equal(route.auth, true);
  assert.deepEqual(route.roles, ['admin']);
});
import { register as registerWidgets } from '../routes/admin/widgets.js';

test('widgets module owns sidebar widget management routes', () => {
  const router = createRouter();
  registerWidgets(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/widgets/:id',
    'GET:/api/v1/admin/widgets',
    'POST:/api/v1/admin/widgets',
    'POST:/api/v1/admin/widgets/batch',
    'PUT:/api/v1/admin/widgets/:id',
  ].sort());
});
test('public entry registers the password unlock route without authentication', () => {
  const router = createRouter();
  registerPublic(router, context());
  const route = router.routes.get('POST:/api/v1/posts/:slug/unlock');
  assert.ok(route, 'POST:/api/v1/posts/:slug/unlock');
  assert.equal(route.auth, false);
});
import { readFileSync } from 'node:fs';
test('server provides the generic theme runtime through route context', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /themeRuntime/);
  assert.match(source, /loadThemeRuntime\(THEMES_DIR\)/);
});
