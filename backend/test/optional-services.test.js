import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function install(api, username = 'provider-admin') {
  const response = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Provider Test', site_url: 'http://localhost',
    admin_username: username, admin_password: 'test-password-123',
    admin_email: `${username}@example.test`,
  }});
  assert.equal(response.status, 200, JSON.stringify(response.payload));
}

async function login(api, username = 'provider-admin') {
  const response = await api.request('POST', '/api/v1/auth/login', { body: {
    username, password: 'test-password-123',
  }});
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  return response.payload.data;
}

async function fixtureTheme(themesDir) {
  const dir = join(themesDir, 'provider-fixture');
  await mkdir(join(dir, 'backend'), { recursive: true });
  await writeFile(join(dir, 'theme.json'), JSON.stringify({
    id: 'provider-fixture', name: 'Provider Fixture', version: '1.0.0', settings: [],
  }));
  await writeFile(join(dir, 'backend', 'index.js'), `
    export function register(router, ctx) {
      if (!ctx.core || !ctx.core.mail || !ctx.core.security) throw new Error('core providers missing');
      router.route('GET', '/api/v1/provider-fixture/probe', (_req, res) => ctx.json(res, {
        mail: typeof ctx.core.mail.notifyComment === 'function',
        security: typeof ctx.core.security.spamCheck === 'function',
        hasThemeFeed: Object.hasOwn(ctx, 'feed'),
        hasThemeImageHost: Object.hasOwn(ctx, 'imageHost'),
      }));
    }
  `);
}

test('default startup does not create optional external-service cache tables', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);

  const bootstrap = await api.request('GET', '/api/v1/site/bootstrap?type=index', { timeout: 1500 });
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.payload));

  const db = new DatabaseSync(api.dbPath);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
  db.close();
  assert.equal(tables.includes('api_cache'), false);
  assert.equal(tables.includes('moments'), false);
  assert.equal(tables.includes('music_playlists'), false);
});

test('generic comment security and local media work without optional providers', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);
  const session = await login(api);

  const db = new DatabaseSync(api.dbPath);
  const post = db.prepare("SELECT id FROM posts WHERE slug = 'hello-world'").get();
  db.close();
  assert.ok(post);
  const comment = await api.request('POST', '/api/v1/comments', { body: {
    postId: post.id, content: 'provider test comment', authorName: 'Visitor', authorEmail: 'visitor@example.test',
  }});
  assert.equal(comment.status, 201, JSON.stringify(comment.payload));

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const upload = await api.request('POST', '/api/v1/admin/media/upload', {
    headers: { authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken },
    body: { name: 'provider-test.png', mime: 'image/png', data: png },
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.payload));
  assert.match(upload.payload.data.url, /^\/uploads\//);
});

test('theme extensions receive only generic core providers and do not inherit optional theme services', async t => {
  const api = await startApiServer({ prepareThemes: fixtureTheme });
  t.after(api.stop);
  await install(api);
  const session = await login(api);
  const activation = await api.request('POST', '/api/v1/admin/themes/provider-fixture/activate', {
    headers: { authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken }, body: {},
  });
  assert.equal(activation.status, 200, JSON.stringify(activation.payload));

  const probe = await api.request('GET', '/api/v1/provider-fixture/probe');
  assert.equal(probe.status, 200, JSON.stringify(probe.payload));
  assert.deepEqual(probe.payload.data, {
    mail: true, security: true, hasThemeFeed: false, hasThemeImageHost: false,
  });
});
