import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { startApiServer } from './helpers/api-server.js';

test('default navigation follows its own selection without changing other themes', async t => {
  const api = await startApiServer({ prepareThemes: async target => {
    await cp(new URL('../../frontend/themes/default/', import.meta.url), join(target, 'default'), { recursive: true });
    await mkdir(join(target, 'fixture'), { recursive: true });
    await writeFile(join(target, 'fixture/theme.json'), JSON.stringify({
      id: 'fixture', name: 'Fixture',
      settings: [{ key: 'navigation', type: 'navigation', default: ['archive'] }],
    }));
  } });
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Navigation test', site_url: api.baseUrl, admin_username: 'nav-admin',
    admin_email: 'nav@example.test', admin_password: 'nav-test-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const { token, csrfToken, user } = installed.payload.data;
  const headers = { authorization: 'Bearer ' + token, 'x-csrf-token': csrfToken };
  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  db.prepare("INSERT INTO categories (id, name, slug) VALUES ('nav-cat', '随笔', 'notes')").run();
  const insert = db.prepare(`INSERT INTO posts
    (id, title, slug, type, status, visibility, password, author_id)
    VALUES (?, ?, ?, 'page', ?, ?, ?, ?)`);
  insert.run('nav-about', '关于 "lill"', 'about', 'published', 'public', '', user.id);
  insert.run('nav-album', '相册', 'album', 'published', 'public', '', user.id);
  insert.run('nav-draft', '草稿', 'draft', 'draft', 'public', '', user.id);
  insert.run('nav-private', '私密', 'private', 'published', 'private', '', user.id);
  insert.run('nav-password', '密码', 'password', 'published', 'public', 'secret', user.id);
  const boot = async (query = 'type=index') => {
    const r = await api.request('GET', '/api/v1/site/bootstrap?' + query);
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    return r.payload.data;
  };
  const save = async navigation => {
    const r = await api.request('PUT', '/api/v1/admin/themes/default/settings', { headers, body: { navigation } });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
  };

  await t.test('existing pages are available but are not automatically added to the default header', async () => {
    const view = await boot();
    assert.deepEqual(view.theme.extension.navigation?.map(item => item.url), ['/', '/archive']);
    assert.ok(view.nav.some(item => item.url === '/page/album'), 'core candidates remain available to other themes');
    const r = await api.request('GET', '/api/v1/admin/themes/default/settings', { headers });
    assert.equal(r.status, 200);
    const field = r.payload.data.schema.find(field => field.key === 'navigation');
    assert.equal(field?.type, 'navigation');
    assert.deepEqual(field.default, ['index', 'archive']);
    assert.equal(field.options.find(item => item.value === 'page:nav-about')?.label, '关于 "lill"');
    for (const id of ['nav-draft', 'nav-private', 'nav-password']) {
      assert.ok(!field.options.some(item => item.value === 'page:' + id), id + ' must not be offered');
    }
  });

  await t.test('saving selection preserves order, hides unselected items and marks the current page', async () => {
    await save(['page:nav-about', 'index', 'category:nav-cat']);
    const view = await boot('type=page&slug=about');
    assert.deepEqual(view.theme.extension.navigation?.map(item => [item.title, item.url, item.active]), [
      ['关于 "lill"', '/page/about', true], ['首页', '/', false], ['随笔', '/category/notes', false],
    ]);
  });

  await t.test('content references follow renames and stop exposing unpublished content', async () => {
    db.prepare("UPDATE posts SET title = '新关于', slug = 'about-new' WHERE id = 'nav-about'").run();
    let view = await boot();
    assert.equal(view.theme.extension.navigation?.[0]?.title, '新关于');
    assert.equal(view.theme.extension.navigation?.[0]?.url, '/page/about-new');
    db.prepare("UPDATE posts SET status = 'draft' WHERE id = 'nav-about'").run();
    view = await boot();
    assert.deepEqual(view.theme.extension.navigation?.map(item => item.url), ['/', '/category/notes']);
    const r = await api.request('GET', '/api/v1/admin/themes/default/settings', { headers });
    assert.deepEqual(r.payload.data.values.navigation, ['page:nav-about', 'index', 'category:nav-cat']);
  });

  await t.test('private, password-protected and deleted pages stay hidden; public pages recover their selection', async () => {
    insert.run('nav-temporary', '临时页面', 'temporary', 'published', 'public', '', user.id);
    await save(['page:nav-temporary', 'index']);
    for (const [visibility, password] of [['private', ''], ['public', 'secret']]) {
      db.prepare('UPDATE posts SET visibility = ?, password = ? WHERE id = ?').run(visibility, password, 'nav-temporary');
      assert.deepEqual((await boot()).theme.extension.navigation.map(item => item.url), ['/']);
    }
    db.prepare("UPDATE posts SET visibility = 'public', password = '' WHERE id = 'nav-temporary'").run();
    assert.deepEqual((await boot()).theme.extension.navigation.map(item => item.url), ['/page/temporary', '/']);
    db.prepare("DELETE FROM posts WHERE id = 'nav-temporary'").run();
    assert.deepEqual((await boot()).theme.extension.navigation.map(item => item.url), ['/']);
  });

  await t.test('category references follow renames and are removed from the header after deletion', async () => {
    db.prepare("INSERT INTO categories (id, name, slug) VALUES ('nav-changing', '旧分类', 'old-category')").run();
    await save(['category:nav-changing', 'index']);
    db.prepare("UPDATE categories SET name = '新分类', slug = 'new-category' WHERE id = 'nav-changing'").run();
    const view = await boot('type=category&slug=new-category');
    assert.deepEqual(view.theme.extension.navigation.map(item => [item.title, item.url, item.active]), [
      ['新分类', '/category/new-category', true], ['首页', '/', false],
    ]);
    db.prepare("DELETE FROM categories WHERE id = 'nav-changing'").run();
    assert.deepEqual((await boot()).theme.extension.navigation.map(item => item.url), ['/']);
  });

  await t.test('empty navigation stays empty and theme switches preserve separate settings', async () => {
    await save([]);
    assert.deepEqual((await boot()).theme.extension.navigation, []);
    let r = await api.request('POST', '/api/v1/admin/themes/fixture/activate', { headers, body: {} });
    assert.equal(r.status, 200);
    r = await api.request('PUT', '/api/v1/admin/themes/fixture/settings', {
      headers, body: { navigation: ['category:nav-cat', 'archive'] },
    });
    assert.equal(r.status, 200);
    const other = await boot();
    assert.deepEqual(other.theme.extension, {});
    assert.deepEqual(other.theme.navigation, ['category:nav-cat', 'archive']);
    assert.ok(other.nav.some(item => item.url === '/page/album'));
    r = await api.request('POST', '/api/v1/admin/themes/default/activate', { headers, body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual((await boot()).theme.extension.navigation, []);
    r = await api.request('GET', '/api/v1/admin/themes/fixture/settings', { headers });
    assert.deepEqual(r.payload.data.values.navigation, ['category:nav-cat', 'archive']);
  });

  await t.test('unknown and duplicate references cannot inject links or duplicate navigation', async () => {
    await save(['index', 'index', 'javascript:alert(1)', 'page:missing', { url: 'https://example.test' }, 'archive']);
    assert.deepEqual((await boot()).theme.extension.navigation?.map(item => item.url), ['/', '/archive']);
  });
});

test('default header renders only the theme selection and hides empty mobile navigation', async () => {
  const context = vm.createContext({ window: {}, document: { getElementById: () => null } });
  vm.runInContext(await readFile(new URL('../../frontend/public/theme.js', import.meta.url), 'utf8'), context);
  const source = await readFile(new URL('../../frontend/themes/default/header.html', import.meta.url), 'utf8');
  const scope = {
    site: { name: 'Test' }, page: { type: 'page' },
    nav: [{ title: '不应显示的页面', url: '/page/hidden' }],
    theme: { extension: { navigation: [{ title: '<关于>', url: '/page/about', active: true }] } },
  };
  let html = context.window.LillEngine.render(source, {}, scope);
  assert.match(html, /href="\/page\/about" class="active" aria-current="page">&lt;关于&gt;<\/a>/);
  assert.doesNotMatch(html, /不应显示的页面/);
  scope.theme.extension.navigation = [];
  html = context.window.LillEngine.render(source, {}, scope);
  assert.doesNotMatch(html, /id="site-nav"|data-lill-toggle="menu"/);
});
