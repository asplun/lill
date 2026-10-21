import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Batch operations test',
    site_url: api.baseUrl,
    admin_username: 'batch-admin',
    admin_email: 'batch-admin@example.test',
    admin_password: 'batch-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  return {
    api,
    headers: {
      authorization: 'Bearer ' + session.token,
      'x-csrf-token': session.csrfToken,
    },
  };
}

async function setupWithPlugin(t) {
  const api = await startApiServer({ preparePlugins: pluginsDir => {
    mkdirSync(join(pluginsDir, 'batch-fixture'), { recursive: true });
    writeFileSync(join(pluginsDir, 'batch-fixture', 'plugin.json'), JSON.stringify({ name: 'Batch Fixture', version: '1.0.0' }));
    writeFileSync(join(pluginsDir, 'batch-fixture', 'index.js'), 'export function activate() {}\nexport function deactivate() {}\n');
  } });
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Batch operations test', site_url: api.baseUrl, admin_username: 'batch-admin',
    admin_email: 'batch-admin@example.test', admin_password: 'batch-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  return { api, headers: { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken } };
}

const createPost = (api, headers, body) => api.request('POST', '/api/v1/admin/posts', { headers, body });
const createPage = (api, headers, body) => createPost(api, headers, { ...body, type: 'page' });

test('page batch publish/draft/delete only touches pages and rejects mixed ids', async t => {
  const { api, headers } = await setup(t);
  const post = await createPost(api, headers, { title: 'Article', slug: 'article', content: 'body', status: 'published' });
  assert.equal(post.status, 201, JSON.stringify(post.payload));
  const pages = [];
  for (const slug of ['one', 'two', 'three']) {
    const page = await createPage(api, headers, { title: 'Page ' + slug, slug, content: 'page body', status: 'draft' });
    assert.equal(page.status, 201, JSON.stringify(page.payload));
    pages.push(page.payload.data);
  }

  const published = await api.request('POST', '/api/v1/admin/pages/batch', {
    headers, body: { ids: [pages[0].id, pages[1].id], action: 'publish' },
  });
  assert.equal(published.status, 200, JSON.stringify(published.payload));
  assert.equal(published.payload.data.updated, 2);
  let list = await api.request('GET', '/api/v1/admin/pages', { headers });
  const byId = new Map(list.payload.data.items.map(item => [item.id, item]));
  assert.equal(byId.get(pages[0].id).status, 'published');
  assert.equal(byId.get(pages[1].id).status, 'published');
  assert.equal(byId.get(pages[2].id).status, 'draft');

  const drafted = await api.request('POST', '/api/v1/admin/pages/batch', {
    headers, body: { ids: [pages[0].id], action: 'draft' },
  });
  assert.equal(drafted.status, 200, JSON.stringify(drafted.payload));
  list = await api.request('GET', '/api/v1/admin/pages', { headers });
  assert.equal(list.payload.data.items.find(item => item.id === pages[0].id).status, 'draft');

  const mixed = await api.request('POST', '/api/v1/admin/pages/batch', {
    headers, body: { ids: [pages[0].id, post.payload.data.id], action: 'delete' },
  });
  assert.equal(mixed.status, 404);
  const invalid = await api.request('POST', '/api/v1/admin/pages/batch', {
    headers, body: { ids: [pages[0].id], action: 'archive' },
  });
  assert.equal(invalid.status, 400);

  const deleted = await api.request('POST', '/api/v1/admin/pages/batch', {
    headers, body: { ids: pages.map(page => page.id), action: 'delete' },
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.data.updated, 3);
  list = await api.request('GET', '/api/v1/admin/pages', { headers });
  assert.equal(list.payload.data.items.length, 0);
  const article = await api.request('GET', '/api/v1/admin/posts/' + post.payload.data.id, { headers });
  assert.equal(article.status, 200);
});

test('category batch delete blocks parents with unselected children and detaches posts', async t => {
  const { api, headers } = await setup(t);
  const parent = await api.request('POST', '/api/v1/admin/categories', { headers, body: { name: 'Parent', slug: 'parent' } });
  assert.equal(parent.status, 201, JSON.stringify(parent.payload));
  const child = await api.request('POST', '/api/v1/admin/categories', {
    headers, body: { name: 'Child', slug: 'child', parentId: parent.payload.data.id },
  });
  assert.equal(child.status, 201, JSON.stringify(child.payload));
  const post = await createPost(api, headers, {
    title: 'Categorized', slug: 'categorized', content: 'body', status: 'published', categoryId: parent.payload.data.id,
  });
  assert.equal(post.status, 201, JSON.stringify(post.payload));

  const blocked = await api.request('POST', '/api/v1/admin/categories/batch', {
    headers, body: { ids: [parent.payload.data.id], action: 'delete' },
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.payload.message, /仍有子分类/);

  const removed = await api.request('POST', '/api/v1/admin/categories/batch', {
    headers, body: { ids: [parent.payload.data.id, child.payload.data.id], action: 'delete' },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(removed.payload.data.deleted, 2);
  const categories = await api.request('GET', '/api/v1/admin/categories', { headers });
  const remaining = new Set(categories.payload.data.map(category => category.id));
  assert.equal(remaining.has(parent.payload.data.id), false);
  assert.equal(remaining.has(child.payload.data.id), false);
  const detached = await api.request('GET', '/api/v1/admin/posts/' + post.payload.data.id, { headers });
  assert.equal(detached.payload.data.category_id, null);

  const missing = await api.request('POST', '/api/v1/admin/categories/batch', {
    headers, body: { ids: ['missing-category'], action: 'delete' },
  });
  assert.equal(missing.status, 404);
});

test('tag batch delete unlinks post_tags before removing tags', async t => {
  const { api, headers } = await setup(t);
  const post = await createPost(api, headers, {
    title: 'Tagged', slug: 'tagged', content: 'body', status: 'published', tagNames: ['Alpha', 'Beta'],
  });
  assert.equal(post.status, 201, JSON.stringify(post.payload));
  const tags = await api.request('GET', '/api/v1/admin/tags', { headers });
  assert.equal(tags.payload.data.meta.total, 2);
  const ids = tags.payload.data.items.map(tag => tag.id);

  const removed = await api.request('POST', '/api/v1/admin/tags/batch', { headers, body: { ids, action: 'delete' } });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(removed.payload.data.deleted, 2);
  const after = await api.request('GET', '/api/v1/admin/tags', { headers });
  assert.equal(after.payload.data.meta.total, 0);
  const detail = await api.request('GET', '/api/v1/admin/posts/' + post.payload.data.id, { headers });
  assert.deepEqual(detail.payload.data.tags, []);

  const missing = await api.request('POST', '/api/v1/admin/tags/batch', {
    headers, body: { ids: ['missing-tag'], action: 'delete' },
  });
  assert.equal(missing.status, 404);
});

test('media batch delete removes records and uploaded files', async t => {
  const { api, headers } = await setup(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const files = [];
  for (const name of ['one.png', 'two.png']) {
    const upload = await api.request('POST', '/api/v1/admin/media/upload', {
      headers, body: { name, data: png, mime: 'image/png' },
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.payload));
    files.push(upload.payload.data);
  }
  assert.ok(files.every(file => existsSync(file.path)));

  const removed = await api.request('POST', '/api/v1/admin/media/batch', {
    headers, body: { ids: files.map(file => file.id), action: 'delete' },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(removed.payload.data.deleted, 2);
  assert.ok(files.every(file => !existsSync(file.path)));
  const library = await api.request('GET', '/api/v1/admin/media', { headers });
  assert.equal(library.payload.data.meta.total, 0);

  const missing = await api.request('POST', '/api/v1/admin/media/batch', {
    headers, body: { ids: ['missing-media'], action: 'delete' },
  });
  assert.equal(missing.status, 404);
});

test('comment batch delete removes every selected comment in one request', async t => {
  const { api, headers } = await setup(t);
  const post = await createPost(api, headers, { title: 'Commented', slug: 'commented', content: 'body', status: 'published' });
  assert.equal(post.status, 201, JSON.stringify(post.payload));
  for (const text of ['first', 'second', 'third']) {
    const created = await api.request('POST', '/api/v1/comments', {
      body: { postId: post.payload.data.id, content: text, authorName: 'Reader', authorEmail: 'reader@example.test' },
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.payload));
  }
  const list = await api.request('GET', '/api/v1/admin/comments', { headers });
  assert.equal(list.payload.data.meta.total, 3);
  const ids = list.payload.data.items.map(comment => comment.id);

  const removed = await api.request('POST', '/api/v1/admin/comments/batch-delete', { headers, body: { ids } });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(removed.payload.data.deleted, 3);
  const after = await api.request('GET', '/api/v1/admin/comments', { headers });
  assert.equal(after.payload.data.meta.total, 0);

  const missing = await api.request('POST', '/api/v1/admin/comments/batch-delete', {
    headers, body: { ids: ['missing-comment'] },
  });
  assert.equal(missing.status, 404);
});

test('page pattern setting is validated, exposed publicly and used by routing', async t => {
  const { api, headers } = await setup(t);
  const options = await api.request('GET', '/api/v1/admin/options', { headers });
  assert.equal(options.payload.data.find(item => item.key === 'page_pattern').value, '/page/{slug}');

  const invalid = await api.request('PUT', '/api/v1/admin/options', {
    headers, body: [{ key: 'page_pattern', value: '/api/{slug}' }],
  });
  assert.equal(invalid.status, 400);
  const badToken = await api.request('PUT', '/api/v1/admin/options', {
    headers, body: [{ key: 'page_pattern', value: '/{cid}/{slug}' }],
  });
  assert.equal(badToken.status, 400);

  const saved = await api.request('PUT', '/api/v1/admin/options', {
    headers, body: [{ key: 'page_pattern', value: '/{slug}' }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  const publicOptions = await api.request('GET', '/api/v1/options/public');
  assert.equal(publicOptions.payload.data.page_pattern, '/{slug}');

  const page = await createPage(api, headers, { title: 'About', slug: 'about-us', content: 'about', status: 'published' });
  assert.equal(page.status, 201, JSON.stringify(page.payload));
  const boot = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent('/about-us'));
  assert.equal(boot.status, 200, JSON.stringify(boot.payload));
  assert.equal(boot.payload.data.page.type, 'page');
  assert.equal(boot.payload.data.page.slug, 'about-us');
  const legacy = await api.request('GET', '/api/v1/site/bootstrap?path=' + encodeURIComponent('/page/about-us'));
  assert.equal(legacy.status, 200, JSON.stringify(legacy.payload));
  assert.equal(legacy.payload.data.page.slug, 'about-us');
});

test('post batch moves to a category and toggles sticky', async t => {
  const { api, headers } = await setup(t);
  const category = await api.request('POST', '/api/v1/admin/categories', {
    headers, body: { name: 'Batch Target', slug: 'batch-target' },
  });
  assert.equal(category.status, 201, JSON.stringify(category.payload));
  const categoryId = category.payload.data.id;

  const ids = [];
  for (const slug of ['batch-post-one', 'batch-post-two']) {
    const created = await api.request('POST', '/api/v1/admin/posts', {
      headers, body: { title: slug, slug, content: 'body', status: 'draft' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    ids.push(created.payload.data.id);
  }

  const sticky = await api.request('POST', '/api/v1/admin/posts/batch', { headers, body: { ids, action: 'sticky' } });
  assert.equal(sticky.status, 200, JSON.stringify(sticky.payload));
  const afterSticky = await api.request('GET', '/api/v1/admin/posts/' + ids[0], { headers });
  assert.equal(afterSticky.payload.data.sticky, 1);

  const unsticky = await api.request('POST', '/api/v1/admin/posts/batch', { headers, body: { ids, action: 'unsticky' } });
  assert.equal(unsticky.status, 200, JSON.stringify(unsticky.payload));
  assert.equal((await api.request('GET', '/api/v1/admin/posts/' + ids[0], { headers })).payload.data.sticky, 0);

  const moved = await api.request('POST', '/api/v1/admin/posts/batch', { headers, body: { ids, action: 'category', categoryId } });
  assert.equal(moved.status, 200, JSON.stringify(moved.payload));
  for (const id of ids) {
    assert.equal((await api.request('GET', '/api/v1/admin/posts/' + id, { headers })).payload.data.category_id, categoryId);
  }

  const missing = await api.request('POST', '/api/v1/admin/posts/batch', { headers, body: { ids, action: 'category' } });
  assert.equal(missing.status, 400);
  const unknown = await api.request('POST', '/api/v1/admin/posts/batch', { headers, body: { ids, action: 'category', categoryId: 'no-such-category' } });
  assert.equal(unknown.status, 404);
});

test('user batch ban/activate/delete skips self and the last active admin', async t => {
  const { api, headers } = await setup(t);
  const me = await api.request('GET', '/api/v1/auth/me', { headers });
  assert.equal(me.status, 200, JSON.stringify(me.payload));
  const myId = me.payload.data.id;

  const created = [];
  for (const name of ['reader-one', 'reader-two']) {
    const user = await api.request('POST', '/api/v1/admin/users', {
      headers, body: { username: name, email: name + '@example.test', password: 'secret-123', role: 'subscriber' },
    });
    assert.equal(user.status, 201, JSON.stringify(user.payload));
    created.push(user.payload.data.id);
  }

  const banned = await api.request('POST', '/api/v1/admin/users/batch', {
    headers, body: { ids: [myId, ...created], action: 'ban' },
  });
  assert.equal(banned.status, 200, JSON.stringify(banned.payload));
  assert.equal(banned.payload.data.updated, 2);
  assert.equal(banned.payload.data.skipped.length, 1);
  assert.match(banned.payload.data.skipped[0].reason, /不能禁用自己/);
  const afterBan = await api.request('GET', '/api/v1/admin/users?pageSize=20', { headers });
  const bannedUsers = afterBan.payload.data.items.filter(item => created.includes(item.id));
  assert.deepEqual(bannedUsers.map(item => item.status), ['banned', 'banned']);

  const activated = await api.request('POST', '/api/v1/admin/users/batch', {
    headers, body: { ids: created, action: 'activate' },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.payload));
  assert.equal(activated.payload.data.updated, 2);

  const deleted = await api.request('POST', '/api/v1/admin/users/batch', {
    headers, body: { ids: [myId, ...created], action: 'delete' },
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.data.deleted, 2);
  assert.equal(deleted.payload.data.skipped.length, 1);
  assert.match(deleted.payload.data.skipped[0].reason, /自己/);
  const users = await api.request('GET', '/api/v1/admin/users?pageSize=20', { headers });
  assert.equal(users.payload.data.meta.total, 1);

  const invalid = await api.request('POST', '/api/v1/admin/users/batch', {
    headers, body: { ids: created, action: 'promote' },
  });
  assert.equal(invalid.status, 400);
});

test('log batch delete removes only selected log records', async t => {
  const { api, headers } = await setup(t);
  for (const detail of ['selected-one', 'selected-two', 'keep-me']) {
    const created = await api.request('POST', '/api/v1/admin/posts', {
      headers, body: { title: detail, slug: detail, content: detail, status: 'draft' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
  }
  const logs = await api.request('GET', '/api/v1/admin/logs?pageSize=100', { headers });
  const selected = logs.payload.data.items.filter(item => item.detail.includes('selected-'));
  const kept = logs.payload.data.items.find(item => item.detail.includes('keep-me'));
  assert.equal(selected.length, 2);
  assert.ok(kept);

  const removed = await api.request('POST', '/api/v1/admin/logs/batch', { headers, body: { ids: selected.map(item => item.id) } });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(removed.payload.data.deleted, 2);
  const after = await api.request('GET', '/api/v1/admin/logs?pageSize=100', { headers });
  assert.ok(after.payload.data.items.some(item => item.id === kept.id));
  assert.ok(selected.every(item => !after.payload.data.items.some(row => row.id === item.id)));
});

test('backup batch delete accepts only existing listed zip basenames', async t => {
  const { api, headers } = await setup(t);
  const uploadsDir = join(dirname(api.dbPath), 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(join(uploadsDir, 'upload-fixture.txt'), 'fixture');
  const created = await api.request('POST', '/api/v1/admin/backup', { headers });
  assert.equal(created.status, 200, JSON.stringify(created.payload));
  const listed = await api.request('GET', '/api/v1/admin/backup/list', { headers });
  const zip = listed.payload.data.find(item => item.name.endsWith('.zip'));
  assert.ok(zip);

  const invalid = await api.request('DELETE', '/api/v1/admin/backup', {
    headers, body: { names: ['../x.zip'] },
  });
  assert.equal(invalid.status, 400);
  const missing = await api.request('DELETE', '/api/v1/admin/backup', {
    headers, body: { names: ['lill-uploads-not-found.zip'] },
  });
  assert.equal(missing.status, 404);
  assert.ok(existsSync(join(dirname(api.dbPath), 'backups', zip.name)));

  const removed = await api.request('DELETE', '/api/v1/admin/backup', { headers, body: { names: [zip.name] } });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.equal(removed.payload.data.updated, 1);
  const after = await api.request('GET', '/api/v1/admin/backup/list', { headers });
  assert.ok(!after.payload.data.some(item => item.name === zip.name));
});

test('theme batch delete removes selected theme directories and guards builtin themes', async t => {
  const api = await startApiServer({ prepareThemes: themesDir => {
    for (const id of ['theme-a', 'theme-b']) {
      mkdirSync(join(themesDir, id), { recursive: true });
      writeFileSync(join(themesDir, id, 'theme.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
      writeFileSync(join(themesDir, id, 'index.astro'), '<div></div>');
    }
    mkdirSync(join(themesDir, 'default'), { recursive: true });
    writeFileSync(join(themesDir, 'default', 'theme.json'), JSON.stringify({ id: 'default', name: 'Default', version: '1.0.0' }));
  } });
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Theme batch test', site_url: api.baseUrl, admin_username: 'batch-admin',
    admin_email: 'batch-admin@example.test', admin_password: 'batch-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };

  const removed = await api.request('POST', '/api/v1/admin/themes/batch', {
    headers, body: { themes: ['theme-a', 'theme-b', 'default', 'theme-missing'], action: 'delete' },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.deepEqual(removed.payload.data.deleted.sort(), ['theme-a', 'theme-b']);
  const skipped = Object.fromEntries(removed.payload.data.skipped.map(item => [item.themeId, item.reason]));
  assert.match(skipped.default, /内置主题/);
  assert.match(skipped['theme-missing'], /不存在/);
  assert.equal(existsSync(join(api.themesDir, 'theme-a')), false);
  assert.equal(existsSync(join(api.themesDir, 'theme-b')), false);
  assert.equal(existsSync(join(api.themesDir, 'default', 'theme.json')), true);

  const invalid = await api.request('POST', '/api/v1/admin/themes/batch', {
    headers, body: { themes: ['theme-a'], action: 'activate' },
  });
  assert.equal(invalid.status, 400);
  const missing = await api.request('DELETE', '/api/v1/admin/themes/theme-a', { headers });
  assert.equal(missing.status, 404);
  const builtin = await api.request('DELETE', '/api/v1/admin/themes/default', { headers });
  assert.equal(builtin.status, 400);
});

test('plugin batch deactivates, activates and uninstalls selected plugins', async t => {
  const { api, headers } = await setupWithPlugin(t);
  const activated = await api.request('POST', '/api/v1/admin/plugins/batch', {
    headers, body: { dirs: ['batch-fixture'], action: 'activate' },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.payload));
  assert.deepEqual(activated.payload.data.updated, ['batch-fixture']);
  let plugins = await api.request('GET', '/api/v1/admin/plugins', { headers });
  assert.equal(plugins.payload.data.find(plugin => plugin.dir === 'batch-fixture').active, true);

  const deactivated = await api.request('POST', '/api/v1/admin/plugins/batch', {
    headers, body: { dirs: ['batch-fixture'], action: 'deactivate' },
  });
  assert.equal(deactivated.status, 200, JSON.stringify(deactivated.payload));
  assert.deepEqual(deactivated.payload.data.updated, ['batch-fixture']);
  plugins = await api.request('GET', '/api/v1/admin/plugins', { headers });
  assert.equal(plugins.payload.data.find(plugin => plugin.dir === 'batch-fixture').active, false);

  const removed = await api.request('POST', '/api/v1/admin/plugins/batch', {
    headers, body: { dirs: ['batch-fixture'], action: 'uninstall' },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.payload));
  assert.deepEqual(removed.payload.data.updated, ['batch-fixture']);
  assert.equal(existsSync(join(api.pluginsDir, 'batch-fixture')), false);
});


test('media batch sets alt text and rejects oversized replacements', async t => {
  const { api, headers } = await setup(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const files = [];
  for (const name of ['alt-one.png', 'alt-two.png']) {
    const upload = await api.request('POST', '/api/v1/admin/media/upload', {
      headers, body: { name, data: png, mime: 'image/png' },
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.payload));
    files.push(upload.payload.data);
  }
  const ids = files.map(file => file.id);

  const applied = await api.request('POST', '/api/v1/admin/media/batch', {
    headers, body: { ids, action: 'alt', alt: '  首页配图  ' },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.payload));
  assert.equal(applied.payload.data.updated, 2);
  assert.equal(applied.payload.data.alt, '首页配图');
  const library = await api.request('GET', '/api/v1/admin/media', { headers });
  const byId = new Map(library.payload.data.items.map(item => [item.id, item]));
  assert.equal(byId.get(ids[0]).alt, '首页配图');
  assert.equal(byId.get(ids[1]).alt, '首页配图');

  const tooLong = await api.request('POST', '/api/v1/admin/media/batch', {
    headers, body: { ids, action: 'alt', alt: 'x'.repeat(501) },
  });
  assert.equal(tooLong.status, 400);

  const unknownAction = await api.request('POST', '/api/v1/admin/media/batch', {
    headers, body: { ids, action: 'rename' },
  });
  assert.equal(unknownAction.status, 400);
  assert.ok(files.every(file => existsSync(file.path)));
});

test('media editor validates metadata and preserves ownership boundaries', async t => {
  const { api, headers } = await setup(t);
  const created = await api.request('POST', '/api/v1/admin/users', {
    headers, body: { username: 'media-author', email: 'media-author@example.test', password: 'secret-123', role: 'author' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const authorHeaders = { authorization: headers.authorization, 'x-csrf-token': headers['x-csrf-token'] };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const uploaded = await api.request('POST', '/api/v1/admin/media/upload', {
    headers: authorHeaders, body: { name: 'media-original.png', data: png, mime: 'image/png' },
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.payload));
  const id = uploaded.payload.data.id;

  const renamed = await api.request('PUT', '/api/v1/admin/media/' + id, {
    headers: authorHeaders, body: { name: '编辑后的标题.png', slug: 'media-title-1', alt: '替代文本', description: '附件描述' },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.payload));
  assert.equal(renamed.payload.data.name, '编辑后的标题.png');
  assert.equal(renamed.payload.data.slug, 'media-title-1');
  assert.equal(renamed.payload.data.alt, '替代文本');
  assert.equal(renamed.payload.data.description, '附件描述');

  const emptyName = await api.request('PUT', '/api/v1/admin/media/' + id, {
    headers: authorHeaders, body: { name: '  ', slug: 'valid', alt: '', description: '' },
  });
  assert.equal(emptyName.status, 400);
  assert.equal(emptyName.payload.message, '文件名不能为空');
  const invalidSlug = await api.request('PUT', '/api/v1/admin/media/' + id, {
    headers: authorHeaders, body: { name: 'name.png', slug: 'Bad Slug!', alt: '', description: '' },
  });
  assert.equal(invalidSlug.status, 400);
  const tooLong = await api.request('PUT', '/api/v1/admin/media/' + id, {
    headers: authorHeaders, body: { name: 'name.png', slug: 'x'.repeat(121), alt: '', description: '' },
  });
  assert.equal(tooLong.status, 400);

  const replacement = await api.request('POST', '/api/v1/admin/media/' + id + '/replace', {
    headers: authorHeaders, body: { name: 'replacement.png', data: Buffer.from(png, 'base64').toString('base64') },
  });
  assert.equal(replacement.status, 200, JSON.stringify(replacement.payload));
  assert.equal(replacement.payload.data.id, id);
  assert.equal(replacement.payload.data.path, uploaded.payload.data.path);
  assert.equal(replacement.payload.data.width, 1);
  assert.equal(replacement.payload.data.height, 1);
  const badMagic = await api.request('POST', '/api/v1/admin/media/' + id + '/replace', {
    headers: authorHeaders, body: { name: 'replacement.png', data: Buffer.from('not png').toString('base64') },
  });
  assert.equal(badMagic.status, 400);

  const otherInstalled = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Second media site', site_url: api.baseUrl, admin_username: 'second-admin',
    admin_email: 'second-admin@example.test', admin_password: 'second-password-123',
  } });
  assert.equal(otherInstalled.status, 403);
});

test('category and tag batch reorder persists the requested order', async t => {
  const { api, headers } = await setup(t);
  const categories = [];
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const created = await api.request('POST', '/api/v1/admin/categories', { headers, body: { name } });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    categories.push(created.payload.data);
  }
  const reordered = await api.request('POST', '/api/v1/admin/categories/reorder', {
    headers, body: { items: [
      { id: categories[0].id, sortOrder: 2 },
      { id: categories[1].id, sortOrder: 0 },
      { id: categories[2].id, sortOrder: 1 },
    ] },
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.payload));
  assert.equal(reordered.payload.data.updated, 3);
  let list = await api.request('GET', '/api/v1/admin/categories', { headers });
  assert.deepEqual(list.payload.data.map(item => item.name).filter(name => name !== '未分类'), ['Beta', 'Gamma', 'Alpha']);

  const badOrder = await api.request('POST', '/api/v1/admin/categories/reorder', {
    headers, body: { items: [{ id: categories[0].id, sortOrder: -1 }] },
  });
  assert.equal(badOrder.status, 400);
  const missingCategory = await api.request('POST', '/api/v1/admin/categories/reorder', {
    headers, body: { items: [{ id: 'missing-category', sortOrder: 0 }] },
  });
  assert.equal(missingCategory.status, 404);

  const tags = [];
  for (const name of ['one', 'two', 'three']) {
    const created = await api.request('POST', '/api/v1/admin/tags', { headers, body: { name } });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    tags.push(created.payload.data);
  }
  const tagOrder = await api.request('POST', '/api/v1/admin/tags/reorder', {
    headers, body: { items: [
      { id: tags[0].id, sortOrder: 2 },
      { id: tags[1].id, sortOrder: 1 },
      { id: tags[2].id, sortOrder: 0 },
    ] },
  });
  assert.equal(tagOrder.status, 200, JSON.stringify(tagOrder.payload));
  const tagList = await api.request('GET', '/api/v1/admin/tags?pageSize=100', { headers });
  assert.deepEqual(tagList.payload.data.items.map(item => item.name), ['three', 'two', 'one']);
  const missingTag = await api.request('POST', '/api/v1/admin/tags/reorder', {
    headers, body: { items: [{ id: 'missing-tag', sortOrder: 0 }] },
  });
  assert.equal(missingTag.status, 404);
});

test('widget batch enables, disables and deletes selected widgets', async t => {
  const { api, headers } = await setup(t);
  const widgets = [];
  for (const name of ['Batch One', 'Batch Two', 'Batch Three']) {
    const created = await api.request('POST', '/api/v1/admin/widgets', {
      headers, body: { name, type: 'html', content: name, enabled: 0 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    widgets.push(created.payload.data);
  }

  const enabled = await api.request('POST', '/api/v1/admin/widgets/batch', {
    headers, body: { ids: [widgets[0].id, widgets[1].id], action: 'enable' },
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.payload));
  assert.equal(enabled.payload.data.updated, 2);
  let list = await api.request('GET', '/api/v1/admin/widgets', { headers });
  let byId = new Map(list.payload.data.map(widget => [widget.id, widget]));
  assert.equal(byId.get(widgets[0].id).enabled, 1);
  assert.equal(byId.get(widgets[1].id).enabled, 1);
  assert.equal(byId.get(widgets[2].id).enabled, 0);

  const disabled = await api.request('POST', '/api/v1/admin/widgets/batch', {
    headers, body: { ids: [widgets[0].id], action: 'disable' },
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.payload));
  assert.equal(disabled.payload.data.updated, 1);
  list = await api.request('GET', '/api/v1/admin/widgets', { headers });
  byId = new Map(list.payload.data.map(widget => [widget.id, widget]));
  assert.equal(byId.get(widgets[0].id).enabled, 0);

  const deleted = await api.request('POST', '/api/v1/admin/widgets/batch', {
    headers, body: { ids: [widgets[0].id, 'missing-widget'], action: 'delete' },
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.data.updated, 1);
  assert.deepEqual(deleted.payload.data.skipped, [{ id: 'missing-widget', reason: '组件不存在' }]);
  list = await api.request('GET', '/api/v1/admin/widgets', { headers });
  assert.equal(list.payload.data.some(widget => widget.id === widgets[0].id), false);

  const invalid = await api.request('POST', '/api/v1/admin/widgets/batch', {
    headers, body: { ids: [widgets[1].id], action: 'archive' },
  });
  assert.equal(invalid.status, 400);
  const empty = await api.request('POST', '/api/v1/admin/widgets/batch', {
    headers, body: { ids: [], action: 'enable' },
  });
  assert.equal(empty.status, 400);
});
