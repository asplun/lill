import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouter } from '../lib/router.js';
import { register as registerAdmin } from '../routes/admin/index.js';

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
  assert.equal(routes.length, 66);
  assert.equal(new Set(router.routes.keys()).size, routes.length);
  for (const route of routes) {
    assert.equal(route.auth, true, route.pattern);
    assert.ok(Array.isArray(route.roles) && route.roles.length, route.pattern);
  }
});

test('admin entry preserves parameter matching metadata', () => {
  const router = createRouter();
  registerAdmin(router, context());
  const matched = router.matchRoute('GET', '/api/v1/admin/posts/post-1');
  assert.deepEqual(matched.params, { id: 'post-1' });
  assert.equal(matched.pattern, '/api/v1/admin/posts/:id');
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
    'POST:/api/v1/admin/comments/:id/reply',
    'PUT:/api/v1/admin/comments/:id',
  ].sort());
});
import { register as registerMedia } from '../routes/admin/media.js';

test('media module owns upload, list, and delete routes', () => {
  const router = createRouter();
  registerMedia(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin', 'editor', 'author', 'contributor'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/media/:id',
    'GET:/api/v1/admin/media',
    'POST:/api/v1/admin/media/upload',
  ].sort());
});
import { register as registerUsers } from '../routes/admin/users.js';

test('users module owns user management routes', () => {
  const router = createRouter();
  registerUsers(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/users/:id',
    'GET:/api/v1/admin/users',
    'POST:/api/v1/admin/users',
    'PUT:/api/v1/admin/users/:id',
  ].sort());
});
import { register as registerSettings } from '../routes/admin/settings.js';

test('settings module owns site options routes', () => {
  const router = createRouter();
  registerSettings(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'GET:/api/v1/admin/options',
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
  ].sort());
});
import { register as registerWidgets } from '../routes/admin/widgets.js';

test('widgets module owns sidebar widget management routes', () => {
  const router = createRouter();
  registerWidgets(router, context(), { route: (method, path, fn) => router.route(method, path, fn, { auth: true, roles: ['admin'] }) });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE:/api/v1/admin/widgets/:id',
    'GET:/api/v1/admin/widgets',
    'POST:/api/v1/admin/widgets',
    'PUT:/api/v1/admin/widgets/:id',
  ].sort());
});
