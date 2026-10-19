import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

const NODE = process.execPath;

async function fixtureTheme(themesDir, { throws = false } = {}) {
  const dir = join(themesDir, 'fixture');
  await mkdir(join(dir, 'backend'), { recursive: true });
  await writeFile(join(dir, 'theme.json'), JSON.stringify({
    id: 'fixture', name: 'Fixture Theme', version: '1.0.0',
    editorFields: [
      { key: 'subtitle', label: 'Subtitle', type: 'text', for: 'post', default: 'Default subtitle' },
      { key: 'show_index', label: 'Show in index', type: 'checkbox', for: 'post', default: true },
      { key: 'hero_title', label: 'Hero title', type: 'text', for: 'page', default: 'Default page title' },
    ],
    settings: [
      { key: 'accent', label: 'Accent', type: 'text', default: 'violet' },
      { key: 'privateToken', label: 'Private', type: 'text', default: 'fixture-default-secret', private: true },
    ],
  }));
  await writeFile(join(dir, 'backend', 'index.js'), throws
    ? `export async function extendBootstrap() { throw new Error('fixture secret stack detail'); }`
    : `export async function extendBootstrap() { return { fixture: { enabled: true } }; }`);
}

async function install(api) {
  const response = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Bootstrap Test', site_url: 'http://localhost',
    admin_username: 'bootstrap-admin', admin_password: 'test-password-123',
    admin_email: 'bootstrap@example.test',
  }});
  assert.equal(response.status, 200, JSON.stringify(response.payload));
}

async function activateFixture(api) {
  const login = await api.request('POST', '/api/v1/auth/login', { body: {
    username: 'bootstrap-admin', password: 'test-password-123',
  }});
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  const token = login.payload.data.token;
  const csrf = login.payload.data.csrfToken;
  const response = await api.request('POST', '/api/v1/admin/themes/fixture/activate', {
    headers: { authorization: `Bearer ${token}`, 'x-csrf-token': csrf }, body: {},
  });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
}

test('default bootstrap is theme agnostic when theme-only tables do not exist', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);
  const response = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.ok(response.payload.data.site);
  assert.ok(response.payload.data.page);
  assert.ok(response.payload.data.data);
  assert.ok(response.payload.data.sidebar);
  assert.ok(Array.isArray(response.payload.data.sidebar.hotPosts));
  assert.ok(Array.isArray(response.payload.data.sidebar.hotTags));
  assert.equal(Object.hasOwn(response.payload.data, 'moments'), false);
  assert.equal(Object.hasOwn(response.payload.data.data, 'musicTabs'), false);
});

test('manifest controls public theme fields and extension data is namespaced', async t => {
  const api = await startApiServer({ prepareThemes: themesDir => fixtureTheme(themesDir) });
  t.after(api.stop);
  await install(api);
  await activateFixture(api);

  const options = await api.request('GET', '/api/v1/options/public');
  assert.equal(options.status, 200, JSON.stringify(options.payload));
  assert.equal(options.payload.data.theme_config.accent, 'violet');
  assert.equal(Object.hasOwn(options.payload.data.theme_config, 'privateToken'), false);

  const bootstrap = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.payload));
  assert.deepEqual(bootstrap.payload.data.theme.extension, { fixture: { enabled: true } });
  assert.equal(Object.hasOwn(bootstrap.payload.data.theme, 'privateToken'), false);
  assert.equal(Object.hasOwn(bootstrap.payload.data.options.theme_config, 'privateToken'), false);
});

test('theme bootstrap failures do not break the core response or leak stack details', async t => {
  const api = await startApiServer({ prepareThemes: themesDir => fixtureTheme(themesDir, { throws: true }) });
  t.after(api.stop);
  await install(api);
  await activateFixture(api);

  const bootstrap = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.payload));
  assert.ok(bootstrap.payload.data.site);
  assert.ok(bootstrap.payload.data.data);
  assert.equal(JSON.stringify(bootstrap.payload).includes('fixture secret stack detail'), false);
  assert.deepEqual(bootstrap.payload.data.theme.extension, {});
});

test('public content exposes only active declared theme fields and hides internal namespaces', async t => {
  const api = await startApiServer({ prepareThemes: themesDir => fixtureTheme(themesDir) });
  t.after(api.stop);
  await install(api);
  await activateFixture(api);

  const db = new DatabaseSync(api.dbPath);
  try {
    const author = db.prepare('SELECT id FROM users WHERE username = ?').get('bootstrap-admin');
    const insert = db.prepare(`INSERT INTO posts
      (id, title, slug, content, html_content, excerpt, type, status, visibility, published_at, author_id, fields)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'published', 'public', datetime('now'), ?, ?)`);
    insert.run('theme-field-post', 'Theme field post', 'theme-field-post', 'Body', '<p>Body</p>', 'Body', 'post', author.id, JSON.stringify({
      legacy: 'preserved generic field',
      _lillThemeFields: {
        fixture: { subtitle: 'Visible subtitle', show_index: false, undeclared: 'must not leak' },
        inactive: { subtitle: 'inactive theme secret' },
      },
    }));
    insert.run('theme-field-page', 'Theme field page', 'theme-field-page', 'Page body', '<p>Page body</p>', 'Page body', 'page', author.id, JSON.stringify({
      legacyPage: 'preserved page field',
      _lillThemeFields: { inactive: { hero_title: 'inactive page secret' } },
    }));
  } finally {
    db.close();
  }

  const direct = await api.request('GET', '/api/v1/posts/theme-field-post');
  assert.equal(direct.status, 200, JSON.stringify(direct.payload));
  assert.deepEqual(direct.payload.data.theme_fields, { subtitle: 'Visible subtitle', show_index: false });
  assert.deepEqual(JSON.parse(direct.payload.data.fields), { legacy: 'preserved generic field' });

  const bootstrapPost = await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=theme-field-post');
  assert.equal(bootstrapPost.status, 200, JSON.stringify(bootstrapPost.payload));
  assert.deepEqual(bootstrapPost.payload.data.data.post.theme_fields, { subtitle: 'Visible subtitle', show_index: false });

  const bootstrapList = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  const listed = bootstrapList.payload.data.data.posts.find(post => post.id === 'theme-field-post');
  assert.deepEqual(listed.theme_fields, { subtitle: 'Visible subtitle', show_index: false });

  const pages = await api.request('GET', '/api/v1/pages');
  const page = pages.payload.data.find(item => item.id === 'theme-field-page');
  assert.deepEqual(page.theme_fields, { hero_title: 'Default page title' });

  const bootstrapPage = await api.request('GET', '/api/v1/site/bootstrap?type=page&slug=theme-field-page');
  assert.equal(bootstrapPage.status, 200, JSON.stringify(bootstrapPage.payload));
  assert.deepEqual(bootstrapPage.payload.data.data.post.theme_fields, { hero_title: 'Default page title' });
  const serialized = JSON.stringify([
    direct.payload, bootstrapPost.payload, bootstrapList.payload, pages.payload, bootstrapPage.payload,
  ]);
  for (const secret of ['inactive theme secret', 'inactive page secret', 'must not leak']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('commenter persistence uses only the generic lill_commenter_mail cookie', async t => {
  const api = await startApiServer();
  t.after(api.stop);
  await install(api);
  const db = new DatabaseSync(api.dbPath);
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('bootstrap-admin');
  const cat = db.prepare('SELECT id FROM categories LIMIT 1').get();
  db.prepare(`INSERT INTO posts (id,title,slug,content,html_content,excerpt,type,status,visibility,published_at,author_id,category_id)
              VALUES (?,?,?,?,?,?, 'post','published','public',datetime('now'),?,?)`)
    .run('comment-post', 'Comment Post', 'comment-post', 'Body', '<p>Body</p>', 'Body', admin.id, cat.id);
  db.close();
  const response = await api.request('POST', '/api/v1/comments', { body: {
    postId: 'comment-post', content: 'hello', authorName: 'Visitor', authorEmail: 'visitor@example.test',
  }});
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')];
  const setCookie = cookies.filter(Boolean).join(';');
  assert.match(setCookie, /lill_commenter_mail=/);
  assert.doesNotMatch(setCookie, /tri3_comment_mail=/);
});
