import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startApiServer } from './helpers/api-server.js';

// Opt in with LILL_UI_PLAYWRIGHT (module path) and optionally LILL_UI_CHROME.
// Uses the built admin HTML with current public assets, without rebuilding themes.
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidenceDir = process.env.LILL_UI_EVIDENCE_DIR;

test('admin UI browser regressions', { skip: !process.env.LILL_UI_PLAYWRIGHT }, async t => {
  const { chromium } = await import(process.env.LILL_UI_PLAYWRIGHT);
  const api = await startApiServer({ prepareThemes: async target => {
    await cp(join(root, 'frontend/themes/default'), join(target, 'default'), { recursive: true });
    const dir = join(target, 'settings-fixture');
    await mkdir(join(dir, 'settings'), { recursive: true });
    await writeFile(join(dir, 'theme.json'), JSON.stringify({
      id: 'settings-fixture', name: 'Custom settings fixture', version: '1.0.0',
      settingsPage: 'settings/editor.html',
      settings: [{ key: 'label', type: 'text', default: 'Initial label' }],
    }));
    await writeFile(join(dir, 'settings/editor.html'), `<!doctype html><html lang="en">
      <meta charset="utf-8"><title>Custom theme settings</title>
      <label>Label <input id="label"></label><button id="save">Save theme</button><output id="result"></output>
      <script src="/api.js"></script><script>
        const endpoint = '/admin/themes/settings-fixture/settings';
        lillAPI.get(endpoint).then(data => {
          document.querySelector('#label').value = data.values.label || 'Initial label';
          document.querySelector('#save').onclick = async () => {
            await lillAPI.put(endpoint, { label: document.querySelector('#label').value });
            document.querySelector('#result').textContent = 'Saved';
          };
          document.body.dataset.ready = 'true';
        });
      </script></html>`);
  } });
  let server, browser;
  t.after(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
    await api.stop();
  });
  const install = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Admin UI test', site_url: api.baseUrl,
    admin_username: 'ui-admin', admin_email: 'ui@example.test',
    admin_password: 'ui-test-password-123',
  } });
  assert.equal(install.status, 200, JSON.stringify(install.payload));
  const session = install.payload.data;
  const headers = { authorization: 'Bearer ' + session.token, 'x-csrf-token': session.csrfToken };
  const write = async (path, body) => {
    const result = await api.request('POST', '/api/v1/admin' + path, { headers, body });
    assert.ok(result.status < 300, JSON.stringify(result.payload));
    return result.payload.data;
  };
  const tagName = 'Reader\'s "notes" \\ archive';
  const tag = await write('/tags', { name: tagName });
  const image = await write('/media/upload', {
    name: 'pixel.png', mime: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6p8AAAAASUVORK5CYII=',
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const upstream = request(api.baseUrl + req.url, { method: req.method, headers: req.headers }, incoming => {
        res.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
      return;
    }
    try {
      const liveAsset = (url.pathname.startsWith('/admin/') && /\.(js|css)$/.test(url.pathname)) || ['/theme.js', '/api.js'].includes(url.pathname);
      const upload = url.pathname === image.url;
      const fixture = url.pathname.startsWith('/themes/settings-fixture/');
      const base = upload ? dirname(image.path) : fixture ? api.themesDir : join(root, 'frontend', liveAsset ? 'public' : 'dist');
      const pathname = fixture ? url.pathname.slice('/themes'.length) : url.pathname;
      let target = upload ? image.path : resolve(base, '.' + decodeURIComponent(pathname));
      if (target !== base && !target.startsWith(base + '/')) { res.writeHead(404); res.end(); return; }
      if ((await stat(target)).isDirectory()) target = join(target, 'index.html');
      const types = { js: 'text/javascript', html: 'text/html', css: 'text/css', svg: 'image/svg+xml', png: 'image/png' };
      res.setHeader('Content-Type', types[target.split('.').pop()] || 'application/octet-stream');
      res.end(await readFile(target));
    } catch {
      if (!/^\/(?:api|admin|themes|uploads|_astro)\//.test(url.pathname) && !/\.(?:js|css|svg|png|jpg|woff2?)$/.test(url.pathname)) {
        res.setHeader('Content-Type', 'text/html');
        res.end(await readFile(join(root, 'frontend/dist/index.html')));
      } else { res.writeHead(404); res.end(); }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.LILL_UI_CHROME ? { executablePath: process.env.LILL_UI_CHROME } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // External avatar hosts are not part of this local application regression.
  await context.route('https://**/*', route => route.abort());
  await context.addInitScript(data => {
    localStorage.setItem('lill_token', data.token);
    localStorage.setItem('lill_csrf_token', data.csrfToken);
  }, session);
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const screenshot = async (page, name) => {
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, name + '.png'), fullPage: true });
  };
  const openAdmin = async subtest => {
    const page = await context.newPage();
    subtest.after(() => page.close());
    page.setDefaultTimeout(5000);
    await page.goto(origin + '/admin/');
    await page.locator('.stats-grid').waitFor();
    return page;
  };
  const openEditor = async page => {
    await page.evaluate(() => window.navigate('posts'));
    await page.getByRole('button', { name: '+ 写文章', exact: true }).click();
    await page.locator('#pe-content').waitFor();
  };

  await t.test('appearance opens the theme-owned settings page and persists its configuration', async subtest => {
    const page = await openAdmin(subtest);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => window.navigate('themes'));
    const card = page.locator('.theme-card').filter({ has: page.getByRole('heading', { name: 'Custom settings fixture', exact: true }) });
    await card.getByRole('button', { name: '启用', exact: true }).click();
    await card.locator('.theme-badge').waitFor();
    try {
      await card.getByRole('button', { name: '设置', exact: true }).click();
      await page.waitForURL('**/themes/settings-fixture/settings/editor.html');
      await page.locator('body[data-ready="true"]').waitFor();
      await page.locator('#label').fill('Saved from the custom page');
      await page.getByRole('button', { name: 'Save theme', exact: true }).click();
      await page.getByText('Saved', { exact: true }).waitFor();
      await page.reload();
      await page.locator('body[data-ready="true"]').waitFor();
      assert.equal(await page.locator('#label').inputValue(), 'Saved from the custom page');
      assert.deepEqual(errors, []);
    } finally {
      await write('/themes/default/activate', {});
    }
    await page.goto(origin + '/admin/');
    await page.locator('.stats-grid').waitFor();
    await page.evaluate(() => window.navigate('themes'));
    await page.locator('.theme-card.active').getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('[data-ts-key]').first().waitFor();
    assert.equal(new URL(page.url()).pathname, '/admin/');
  });

  await t.test('leaving appearance settings while loading cancels a delayed custom-page redirect', async subtest => {
    const page = await openAdmin(subtest);
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    await page.route('**/api/v1/admin/themes/settings-fixture/settings', async route => {
      arrived.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    try {
      await page.evaluate(() => window.navigate('themes'));
      await page.locator('.theme-card').filter({ hasText: 'Custom settings fixture' }).getByRole('button', { name: '设置', exact: true }).click();
      await arrived.promise;
      await page.locator('[data-page="tags"]').click();
      await page.locator('#content table').waitFor();
      release.resolve();
      await page.unrouteAll({ behavior: 'wait' });
      assert.equal(new URL(page.url()).pathname, '/admin/');
      assert.equal(await page.locator('#page-title').innerText(), '标签');
      assert.equal(await page.locator('#content > .loading').count(), 0);
    } finally { release.resolve(); }
  });

  for (const endpoint of ['categories', 'options']) {
    await t.test('leaving an editor while ' + endpoint + ' loads preserves the destination', async subtest => {
      const page = await openAdmin(subtest);
      await page.evaluate(() => window.navigate('posts'));
      const arrived = Promise.withResolvers();
      const release = Promise.withResolvers();
      await page.route('**/api/v1/admin/' + endpoint, async route => {
        arrived.resolve();
        await release.promise;
        await route.continue().catch(() => {});
      });
      try {
        await page.getByRole('button', { name: '+ 写文章', exact: true }).click();
        await arrived.promise;
        await page.locator('[data-page="tags"]').click();
        await page.waitForLoadState('networkidle');
        await screenshot(page, 'navigation-' + endpoint);
        assert.equal(await page.locator('#page-title').innerText(), '标签');
        assert.equal(await page.locator('.menu-item.active').getAttribute('data-page'), 'tags');
        assert.equal(await page.locator('#content table').count(), 1);
        assert.equal(await page.locator('#pe-content').count(), 0);
      } finally { release.resolve(); }
    });
  }

  await t.test('Escape closes the media picker and restores focus in fullscreen editing', async subtest => {
    const page = await openAdmin(subtest);
    await openEditor(page);
    await page.locator('[title="全屏编辑（Esc 退出）"]').click();
    const trigger = page.locator('[title="从附件库插入图片"]');
    await trigger.click();
    await page.locator('.mm-item').waitFor();
    const focusInside = await page.evaluate(() => document.querySelector('.media-modal').contains(document.activeElement));
    await page.keyboard.press('Escape');
    await screenshot(page, 'media-escape');
    assert.equal(await page.locator('.media-modal').count(), 0, 'Escape must close the image picker');
    assert.equal(focusInside, true, 'opening the picker must move focus inside');
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#pe-editor-card').evaluate(element => element.classList.contains('editor-fs')), true);
    await page.locator('#pe-content').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pe-editor-card').evaluate(element => element.classList.contains('editor-fs')), false);
  });

  await t.test('the media picker traps Tab and inserts at the editor selection', async subtest => {
    const page = await openAdmin(subtest);
    await openEditor(page);
    await page.locator('#pe-content').fill('alpha omega');
    await page.locator('#pe-content').evaluate(element => element.setSelectionRange(6, 11));
    await page.locator('[title="从附件库插入图片"]').click();
    await page.locator('.mm-item').waitFor();
    await page.locator('#mm-close').focus();
    await page.keyboard.press('Shift+Tab');
    const reverseInside = await page.evaluate(() => document.querySelector('.media-modal').contains(document.activeElement));
    await page.keyboard.press('Tab');
    const forwardInside = await page.evaluate(() => document.querySelector('.media-modal').contains(document.activeElement));
    await screenshot(page, 'media-focus');
    assert.equal(reverseInside, true, 'Shift+Tab must stay inside the picker');
    assert.equal(forwardInside, true, 'Tab must stay inside the picker');
    await page.locator('.mm-item').first().click();
    assert.equal(await page.locator('#pe-content').inputValue(), 'alpha ![omega](' + image.url + ')');
    assert.equal(await page.locator('#pe-content').evaluate(element => element === document.activeElement), true);
    await page.waitForFunction(() => document.querySelector('#pe-preview img')?.naturalWidth > 0);
  });

  await t.test('tag names with quotes and backslashes can be edited and saved', async subtest => {
    const page = await openAdmin(subtest);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => window.navigate('tags'));
    let defaultValue = null;
    page.once('dialog', async dialog => {
      defaultValue = dialog.defaultValue();
      await dialog.accept('Updated reader notes');
    });
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    await page.waitForLoadState('networkidle');
    await screenshot(page, 'tag-edit');
    assert.deepEqual(errors, []);
    assert.equal(defaultValue, tagName);
    const result = await api.request('GET', '/api/v1/admin/tags', { headers });
    assert.equal(result.payload.data.items.find(item => item.id === tag.id).name, 'Updated reader notes');
  });

  await t.test('editor prerequisites start together instead of waiting behind categories', async subtest => {
    const page = await openAdmin(subtest);
    await page.evaluate(() => { delete window.__lillOptions; window.navigate('pages'); });
    await page.locator('#content table').waitFor();
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    const requested = new Set();
    page.on('request', request => requested.add(new URL(request.url()).pathname));
    await page.route('**/api/v1/admin/categories', async route => {
      arrived.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    try {
      const templates = page.waitForResponse(response => response.url().includes('/admin/page-templates'), { timeout: 1500 });
      await page.getByRole('button', { name: '+ 新建页面', exact: true }).click();
      await arrived.promise;
      await templates;
      assert.ok(requested.has('/api/v1/admin/options'), 'options must start while categories is still pending');
    } finally { release.resolve(); }
    await page.locator('#pe-content').waitFor();
  });

  await t.test('repeating the current destination keeps its in-flight request', async subtest => {
    const page = await openAdmin(subtest);
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    let requests = 0;
    await page.route('**/api/v1/admin/tags*', async route => {
      requests++;
      arrived.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    try {
      await page.evaluate(() => { window.navigate('tags'); });
      await arrived.promise;
      await page.evaluate(() => { window.navigate('tags'); });
      release.resolve();
      await page.locator('#content table').waitFor();
      assert.equal(requests, 1, 'reclicking the active menu must not cancel and restart loading');
    } finally { release.resolve(); }
  });

  await t.test('a failed destination can be retried through its menu', async subtest => {
    const page = await openAdmin(subtest);
    const failOnce = route => route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ code: 1, message: 'Temporary outage' }),
    });
    await page.route('**/api/v1/admin/tags*', failOnce);
    await page.evaluate(() => window.navigate('tags'));
    await page.getByText('加载失败：Temporary outage', { exact: true }).waitFor();
    await page.unroute('**/api/v1/admin/tags*', failOnce);
    await page.locator('[data-page="tags"]').click();
    await page.locator('#content table').waitFor();
    assert.equal(await page.getByText('加载失败：Temporary outage', { exact: true }).count(), 0);
  });

  for (const [name, endpoint, open] of [
    ['plugin settings', 'plugins/missing/config', () => { window.openPluginSettings('missing'); }],
    ['category editor', 'categories', () => { window.openCatEditor(); }],
    ['user editor', 'users*', () => { window.openUserEditor('missing'); }],
  ]) {
    await t.test('leaving ' + name + ' cancels without replacing the destination', async subtest => {
      const page = await openAdmin(subtest);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const arrived = Promise.withResolvers();
      const release = Promise.withResolvers();
      await page.route('**/api/v1/admin/' + endpoint, async route => {
        arrived.resolve();
        await release.promise;
        await route.continue().catch(() => {});
      });
      try {
        await page.evaluate(open);
        await arrived.promise;
        await page.evaluate(() => window.navigate('tags'));
        release.resolve();
        await page.waitForLoadState('networkidle');
        assert.deepEqual(errors, []);
        assert.equal(await page.locator('#page-title').innerText(), '标签');
        assert.equal(await page.locator('#content table').count(), 1);
        assert.equal(await page.locator('#content input').count(), 0);
      } finally { release.resolve(); }
    });
  }

  await t.test('leaving theme settings cancels quietly and preserves the destination', async subtest => {
    const page = await openAdmin(subtest);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => window.navigate('themes'));
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    await page.route('**/api/v1/admin/themes/default/settings', async route => {
      arrived.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    try {
      await page.locator('.theme-card.active').getByRole('button', { name: '设置', exact: true }).click();
      await arrived.promise;
      await page.evaluate(() => window.navigate('tags'));
      release.resolve();
      await page.waitForLoadState('networkidle');
      assert.deepEqual(errors, []);
      assert.equal(await page.locator('#page-title').innerText(), '标签');
      assert.equal(await page.locator('.navigation-editor').count(), 0);
    } finally { release.resolve(); }
  });

  await t.test('retrying theme settings repeats the failed view instead of returning to the list', async subtest => {
    const page = await openAdmin(subtest);
    await page.evaluate(() => window.navigate('themes'));
    const fail = route => route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ code: 1, message: 'Temporary settings outage' }),
    });
    await page.route('**/api/v1/admin/themes/default/settings', fail);
    await page.locator('.theme-card.active').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByText('加载失败：Temporary settings outage', { exact: true }).waitFor();
    await page.unroute('**/api/v1/admin/themes/default/settings', fail);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('.navigation-editor').waitFor();
    assert.equal(await page.locator('.theme-grid').count(), 0);
  });

  await t.test('overlapping writes in the same destination each refresh its records', async subtest => {
    const first = await write('/tags', { name: 'Parallel deletion first' });
    const second = await write('/tags', { name: 'Parallel deletion second' });
    const page = await openAdmin(subtest);
    await page.evaluate(() => window.navigate('tags'));
    page.on('dialog', dialog => dialog.accept());
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    await page.route('**/api/v1/admin/tags/' + second.id, async route => {
      arrived.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    try {
      await page.evaluate(ids => { ids.forEach(id => window.delTag(id)); }, [first.id, second.id]);
      await arrived.promise;
      await page.getByText(first.name, { exact: true }).waitFor({ state: 'hidden' });
      await page.getByText(second.name, { exact: true }).waitFor();
      assert.equal(await page.getByText(second.name, { exact: true }).count(), 1);
      release.resolve();
      await page.getByText(second.name, { exact: true }).waitFor({ state: 'hidden' });
      await page.locator('#content table').waitFor();
      assert.equal(await page.getByText(second.name, { exact: true }).count(), 0);
      const result = await api.request('GET', '/api/v1/admin/tags', { headers });
      assert.ok(result.payload.data.items.every(item => ![first.id, second.id].includes(item.id)));
    } finally { release.resolve(); }
  });

  await t.test('reopening an editor reads current permalink settings', async subtest => {
    const page = await openAdmin(subtest);
    await openEditor(page);
    try {
      const result = await api.request('PUT', '/api/v1/admin/options', {
        headers, body: [{ key: 'permalink', value: '/entries/{slug}/' }],
      });
      assert.equal(result.status, 200);
      await openEditor(page);
      assert.match(await page.locator('#pe-slug-hint').innerText(), /\/entries\//);
    } finally {
      await api.request('PUT', '/api/v1/admin/options', {
        headers, body: [{ key: 'permalink', value: '/archives/{cid}/' }],
      });
    }
  });

  await t.test('comment selection updates locally without refetching or replacing the table', async subtest => {
    const post = await write('/posts', { title: 'Selection test', status: 'published', content: 'Test' });
    for (const content of ['First comment', 'Second comment']) {
      const response = await api.request('POST', '/api/v1/comments', { headers, body: { postId: post.id, content } });
      assert.equal(response.status, 201);
    }
    const page = await openAdmin(subtest);
    await page.evaluate(() => window.navigate('comments'));
    await page.locator('.cmt-check').first().waitFor();
    let requests = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/admin/comments') requests++; });
    await page.evaluate(() => { window.__selectionTable = document.querySelector('#content table'); });
    await page.locator('.cmt-check').first().check();
    await page.getByRole('button', { name: '批量通过', exact: true }).waitFor();
    await page.locator('[data-page="comments"]').click();
    assert.equal(await page.locator('.cmt-check:checked').count(), 1, 'repeating the active menu must preserve selection');
    await page.getByRole('checkbox', { name: '选择本页评论', exact: true }).check();
    assert.equal(await page.locator('.cmt-check:checked').count(), 2);
    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    assert.equal(await page.locator('.cmt-check:checked').count(), 0);
    await page.waitForLoadState('networkidle');
    assert.equal(requests, 0, 'selection is UI state and must not send GETs');
    assert.equal(await page.evaluate(() => window.__selectionTable === document.querySelector('#content table')), true);
  });

  await t.test('saving a post does not take over navigation completed while saving', async subtest => {
    const page = await openAdmin(subtest);
    await openEditor(page);
    await page.locator('#pe-title').fill('Save in background');
    const arrived = Promise.withResolvers();
    const release = Promise.withResolvers();
    await page.route('**/api/v1/admin/posts', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      arrived.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    try {
      await page.locator('#pe-editor-card').getByRole('button', { name: '保存', exact: true }).click();
      await arrived.promise;
      await page.evaluate(() => window.navigate('tags'));
      await page.locator('#content table').waitFor();
      release.resolve();
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#page-title').innerText(), '标签');
      assert.equal(await page.locator('.filter-tabs').count(), 0);
      const result = await api.request('GET', '/api/v1/admin/posts', { headers });
      assert.ok(result.payload.data.items.some(item => item.title === 'Save in background'), 'the write itself must complete');
    } finally { release.resolve(); }
  });

  for (const action of ['replyCmt', 'editCmt']) {
    await t.test(action + ' works on older comment pages without querying the latest 100', async subtest => {
      const post = await write('/posts', { title: 'Old comments ' + action, status: 'published' });
      const db = new DatabaseSync(api.dbPath);
      try {
        db.prepare('DELETE FROM comments').run();
        const insert = db.prepare('INSERT INTO comments (id, content, post_id, author_name, created_at) VALUES (?, ?, ?, ?, ?)');
        for (let index = 0; index < 105; index++) {
          insert.run(action + index, 'Original comment ' + index, post.id, 'Visitor ' + index,
            '2020-01-' + String(Math.floor(index / 24) + 1).padStart(2, '0') + ' ' + String(index % 24).padStart(2, '0') + ':00:00');
        }
      } finally { db.close(); }
      const page = await openAdmin(subtest);
      await page.evaluate(() => window.navigate('comments'));
      await page.evaluate(() => window.gotoPage(6));
      const row = page.locator('#content tbody tr').first();
      await row.locator('.cmt-check').waitFor();
      const id = await row.locator('.cmt-check').inputValue();
      const errors = [];
      let reads = 0, promptDefault;
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', req => { if (req.method() === 'GET' && req.url().includes('pageSize=100')) reads++; });
      page.once('dialog', async dialog => { promptDefault = dialog.defaultValue(); await dialog.accept('Updated old comment ' + action); });
      await row.getByRole('button', { name: action === 'replyCmt' ? '回复' : '编辑', exact: true }).click();
      await page.waitForLoadState('networkidle');
      assert.equal(reads, 0);
      assert.deepEqual(errors, []);
      assert.notEqual(promptDefault, undefined, 'the current row must open the editor');
      if (action === 'editCmt') assert.match(promptDefault, /^Original comment /);
      const result = await api.request('GET', '/api/v1/admin/comments?postId=' + post.id + '&pageSize=200', { headers });
      assert.ok(result.payload.data.items.some(item => item.content === 'Updated old comment ' + action
        && (action === 'editCmt' ? item.id === id : item.parent_id === id)));
    });
  }

  await t.test('editing an article from a list without a type field preserves it as an article', async subtest => {
    const post = await write('/posts', { title: 'Article list edit', status: 'draft' });
    const page = await openAdmin(subtest);
    // During a rolling deployment an older API may still omit type from its list.
    await page.route('**/api/v1/admin/posts?*', async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.items.forEach(item => { delete item.type; });
      await route.fulfill({ response, json: body });
    });
    await page.evaluate(() => window.navigate('posts'));
    await page.getByText(post.title, { exact: true }).locator('..').locator('..').getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#pe-content').fill('Updated article body');
    const saved = page.waitForResponse(r => r.url().endsWith('/admin/posts/' + post.id) && r.request().method() === 'PUT');
    await page.getByRole('button', { name: '更新', exact: true }).click();
    assert.equal((await saved).status(), 200);
    const result = await api.request('GET', '/api/v1/admin/posts/' + post.id, { headers });
    assert.equal(result.payload.data.type, 'post');
    assert.equal(result.payload.data.content, 'Updated article body');
  });

  for (const role of ['editor', 'author', 'contributor', 'subscriber']) {
    await t.test(role + ' sees permitted navigation without forbidden background requests', async subtest => {
      const username = 'ui-' + role;
      await write('/users', { username, password: 'ui-role-password-123', email: username + '@example.test', role });
      const login = await api.request('POST', '/api/v1/auth/login', { body: { username, password: 'ui-role-password-123' } });
      assert.equal(login.status, 200);
      const roleContext = await browser.newContext();
      subtest.after(() => roleContext.close());
      await roleContext.addInitScript(data => {
        localStorage.setItem('lill_token', data.token);
        localStorage.setItem('lill_csrf_token', data.csrfToken);
      }, login.payload.data);
      const page = await roleContext.newPage();
      const forbidden = [];
      page.on('response', r => { if (r.url().includes('/api/v1/') && r.status() === 403) forbidden.push(new URL(r.url()).pathname); });
      await page.goto(origin + '/admin/');
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('[data-page="settings"]').isVisible(), false);
      if (role === 'subscriber') {
        assert.match(await page.locator('#content').innerText(), /没有内容管理权限/);
      } else {
        assert.equal(await page.locator('#page-title').innerText(), '文章');
        await page.getByRole('button', { name: '+ 写文章', exact: true }).click();
        await page.locator('#pe-status').waitFor();
        if (role === 'contributor') {
          assert.equal(await page.locator('#pe-status').inputValue(), 'draft');
          assert.deepEqual(await page.locator('#pe-status option').evaluateAll(items => items.map(item => item.value)), ['draft']);
        }
        if (role === 'author' || role === 'contributor') {
          await page.evaluate(() => window.navigate('categories'));
          assert.equal(await page.getByRole('button', { name: '+ 新建分类', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 0);
        }
      }
      await page.waitForLoadState('networkidle');
      assert.deepEqual(forbidden, []);
    });
  }

  await t.test('backups can be created, listed and downloaded as a valid SQLite file', async subtest => {
    const page = await openAdmin(subtest);
    await page.evaluate(() => window.navigate('backup'));
    await page.getByRole('button', { name: '+ 创建备份', exact: true }).click();
    const downloadButton = page.locator('tr').filter({ hasText: /lill-backup-.*\.db/ }).getByRole('button', { name: '下载', exact: true }).first();
    await downloadButton.waitFor({ timeout: 15000 });
    const downloadEvent = page.waitForEvent('download');
    await downloadButton.click();
    const download = await downloadEvent;
    assert.match(download.suggestedFilename(), /^lill-backup-.*\.db$/);
    const path = join(dirname(api.dbPath), 'browser-backup.db');
    await download.saveAs(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.ok(db.prepare('SELECT COUNT(*) AS total FROM posts').get().total > 0);
    } finally { db.close(); }
  });

  await t.test('editor saves publication time and per-content comment permission; pages retain ordering', async subtest => {
    const page = await openAdmin(subtest);
    await openEditor(page);
    await page.locator('#pe-title').fill('Scheduled article');
    await page.locator('#pe-published-at').fill('2030-04-05T12:30');
    await page.locator('#pe-comment-allowed').uncheck();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.filter-tabs').waitFor();
    const articles = await api.request('GET', '/api/v1/admin/posts', { headers });
    const article = articles.payload.data.items.find(p => p.title === 'Scheduled article');
    assert.ok(article);
    const detail = await api.request('GET', '/api/v1/admin/posts/' + article.id, { headers });
    const expectedTime = await page.evaluate(() => new Date('2030-04-05T12:30').toISOString().slice(0, 19).replace('T', ' '));
    assert.equal(detail.payload.data.published_at, expectedTime);
    assert.equal(detail.payload.data.comment_allowed, 0);
    assert.equal((await api.request('GET', '/api/v1/posts/' + article.slug)).status, 404);
    await page.evaluate(() => window.navigate('pages'));
    await page.getByRole('button', { name: '+ 新建页面', exact: true }).click();
    await page.locator('#pe-title').fill('Ordered page');
    await page.locator('#pe-order').fill('7');
    await page.locator('#pe-comment-allowed').uncheck();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('#content table').waitFor();
    const pages = await api.request('GET', '/api/v1/admin/pages', { headers });
    const created = pages.payload.data.items.find(p => p.title === 'Ordered page');
    const stored = await api.request('GET', '/api/v1/admin/posts/' + created.id, { headers });
    assert.equal(stored.payload.data.order, 7);
    assert.equal(stored.payload.data.comment_allowed, 0);
  });

  await t.test('Markdown preview never creates event attributes or executable link protocols', async subtest => {
    const page = await openAdmin(subtest);
    await openEditor(page);
    await page.locator('#pe-content').fill('![image" onerror="window.__previewXss=1](missing.png)\n\n[click](javascript:alert%281%29)');
    await page.waitForFunction(() => document.querySelector('#pe-preview img'));
    assert.equal(await page.locator('#pe-preview [onerror]').count(), 0);
    assert.equal(await page.locator('#pe-preview a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__previewXss), undefined);
    await page.locator('#pe-content').fill('![safe](/uploads/pixel.png)\n\n[safe](https://example.test/read?q=x&y=2)');
    assert.equal(await page.locator('#pe-preview img').getAttribute('src'), '/uploads/pixel.png');
    assert.equal(await page.locator('#pe-preview a').getAttribute('href'), 'https://example.test/read?q=x&y=2');
  });

  await t.test('the editor distinguishes automatic excerpts from manually entered summaries', async subtest => {
    const page = await openAdmin(subtest);
    await openEditor(page);
    await page.locator('#pe-title').fill('Summary modes');
    await page.locator('#pe-content').fill('Generated summary body');
    assert.equal(await page.locator('#pe-excerpt-auto').isChecked(), true);
    await page.locator('#pe-excerpt-auto').uncheck();
    await page.locator('#pe-excerpt').fill('Manual summary');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.filter-tabs').waitFor();
    const records = await api.request('GET', '/api/v1/admin/posts', { headers });
    const post = records.payload.data.items.find(item => item.title === 'Summary modes');
    assert.ok(post);
    const stored = await api.request('GET', '/api/v1/admin/posts/' + post.id, { headers });
    assert.equal(stored.payload.data.excerpt_auto, 0);
    assert.equal(stored.payload.data.excerpt, 'Manual summary');
    await page.evaluate(id => window.openPostEditor('post', id), post.id);
    assert.equal(await page.locator('#pe-excerpt-auto').isChecked(), false);
    await page.locator('#pe-excerpt-auto').check();
    await page.getByRole('button', { name: '更新', exact: true }).click();
    await page.locator('.filter-tabs').waitFor();
    const automated = await api.request('GET', '/api/v1/admin/posts/' + post.id, { headers });
    assert.equal(automated.payload.data.excerpt_auto, 1);
    assert.equal(automated.payload.data.excerpt, 'Generated summary body');
  });

  await t.test('a summary-only local draft restores its manual mode without changing the body', async subtest => {
    const post = await write('/posts', { title: 'Summary-only recovery', content: 'Unchanged body', excerptAuto: true });
    const page = await openAdmin(subtest);
    await page.evaluate(id => window.openPostEditor('post', id), post.id);
    await page.locator('#pe-excerpt-auto').uncheck();
    await page.locator('#pe-excerpt').fill('Unsaved manual summary');
    const key = 'lill:draft:post:' + post.id;
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || '{}').excerpt === 'Unsaved manual summary', key);
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).excerptAuto, key), false);
    await page.evaluate(() => window.navigate('tags'));
    page.once('dialog', dialog => dialog.accept());
    await page.evaluate(id => window.openPostEditor('post', id), post.id);
    assert.equal(await page.locator('#pe-excerpt-auto').isChecked(), false);
    assert.equal(await page.locator('#pe-excerpt').inputValue(), 'Unsaved manual summary');
    assert.equal(await page.locator('#pe-excerpt').isEnabled(), true);
    assert.equal(await page.locator('#pe-content').inputValue(), 'Unchanged body');
  });

  await t.test('the frontend renders custom permalinks and keeps nonexistent paths off the homepage', async subtest => {
    const article = await write('/posts', { title: 'Custom route article', slug: 'custom-route-article', content: 'Custom route body', status: 'published' });
    assert.ok(article.id);
    try {
      assert.equal((await api.request('PUT', '/api/v1/admin/options', {
        headers, body: [{ key: 'permalink', value: '/entries/{slug}.html' }],
      })).status, 200);
      const page = await context.newPage();
      subtest.after(() => page.close());
      await page.goto(origin + '/entries/custom-route-article.html');
      await page.locator('.post-detail h1').waitFor();
      assert.equal(await page.locator('.post-detail h1').innerText(), article.title);
      await page.goto(origin + '/');
      await page.getByRole('link', { name: article.title, exact: true }).first().waitFor();
      assert.equal(await page.getByRole('link', { name: article.title, exact: true }).first().getAttribute('href'), '/entries/custom-route-article.html');
      await page.goto(origin + '/not-a-real-route');
      await page.locator('.lill-error').waitFor();
      assert.equal(await page.locator('.post-list').count(), 0);
    } finally {
      await api.request('PUT', '/api/v1/admin/options', { headers, body: [{ key: 'permalink', value: '/archives/{cid}/' }] });
    }
  });

  await t.test('default comment pagination uses bootstrap data then preserves the form across page changes', async subtest => {
    const post = await write('/posts', { title: 'Paged discussion', slug: 'paged-discussion', status: 'published' });
    const db = new DatabaseSync(api.dbPath);
    try {
      const insert = db.prepare('INSERT INTO comments (id, post_id, content, status, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (let index = 1; index <= 5; index++) {
        insert.run('paged-' + index, post.id, 'Paged comment ' + index, 'approved', 'Visitor', '2020-01-0' + index + ' 00:00:00');
      }
    } finally { db.close(); }
    await api.request('PUT', '/api/v1/admin/options', { headers, body: [{ key: 'comments_per_page', value: '2' }] });
    try {
      const page = await context.newPage();
      subtest.after(() => page.close());
      let reads = 0;
      page.on('request', req => { if (req.url().includes('/api/v1/comments?postId=')) reads++; });
      const themeInitialized = page.waitForRequest(req => req.url().endsWith('/api/v1/hello'));
      await page.goto(origin + '/post/paged-discussion?commentPage=2#comments');
      await page.locator('.comment-pagination').waitFor();
      await themeInitialized;
      assert.equal(await page.locator('.comment-item').count(), 2);
      assert.equal(reads, 0, 'direct entry must not fetch the same comment page twice');
      await page.locator('.comment-form [name="content"]').fill('Keep my draft');
      await page.getByRole('link', { name: '下一页', exact: true }).click();
      await page.waitForFunction(() => new URL(location.href).searchParams.get('commentPage') === '3');
      assert.equal(await page.locator('.comment-item').count(), 1);
      assert.equal(await page.locator('.comment-form [name="content"]').inputValue(), 'Keep my draft');
      await page.goBack();
      await page.waitForFunction(() => document.querySelectorAll('.comment-item').length === 2);
      assert.equal(await page.locator('.comment-form [name="content"]').inputValue(), 'Keep my draft');
    } finally {
      await api.request('PUT', '/api/v1/admin/options', { headers, body: [{ key: 'comments_per_page', value: '20' }] });
    }
  });

  await t.test('theme navigation can be selected, reordered, saved and emptied on mobile', async subtest => {
    const title = '关于 "lill" ' + '很长的页面名称'.repeat(12);
    const post = await write('/posts', { title, slug: 'navigation-about', type: 'page', status: 'published', content: 'About' });
    const page = await openAdmin(subtest);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const open = async () => {
      await page.evaluate(() => window.navigate('themes'));
      await page.locator('.theme-grid').waitFor();
      await page.locator('.theme-card.active').getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.navigation-editor').waitFor();
    };
    await open();
    const editor = page.locator('[data-ts-key="navigation"]');
    const selected = () => editor.locator('input:checked').evaluateAll(inputs => inputs.map(input => input.value));
    assert.deepEqual(await selected(), ['index', 'archive']);
    const item = editor.locator('input[value="page:' + post.id + '"]');
    await item.check();
    const row = item.locator('..').locator('..');
    const moveUp = row.getByRole('button', { name: '上移', exact: true });
    await moveUp.click();
    assert.equal(await moveUp.evaluate(element => element === document.activeElement), true);
    await moveUp.click();
    await editor.locator('input[value="archive"]').uncheck();
    assert.deepEqual(await selected(), ['page:' + post.id, 'index']);
    const saved = page.waitForResponse(response => response.url().endsWith('/themes/default/settings') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal((await saved).status(), 200);
    await open();
    assert.deepEqual(await selected(), ['page:' + post.id, 'index']);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'navigation must not overflow on mobile');
    await screenshot(page, 'theme-navigation');
    const hidden = await api.request('PUT', '/api/v1/admin/posts/' + post.id, { headers, body: { status: 'draft' } });
    assert.equal(hidden.status, 200);
    await open();
    assert.equal(await editor.locator('.navigation-unavailable').count(), 1);
    while (await editor.locator('input:checked').count()) await editor.locator('input:checked').first().uncheck();
    const emptied = page.waitForResponse(response => response.url().endsWith('/themes/default/settings') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    assert.equal((await emptied).status(), 200);
    const boot = await api.request('GET', '/api/v1/site/bootstrap');
    assert.deepEqual(boot.payload.data.theme.extension.navigation, []);
    assert.deepEqual(errors, []);
  });

  await t.test('admin destinations and editor controls fit narrow and desktop viewports', async subtest => {
    const page = await openAdmin(subtest);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const menus = {
      dashboard: '.stats-grid', posts: '.filter-tabs', pages: '#content table', comments: '#cf-status',
      categories: '#content table', tags: '#content table', media: '.media-grid', themes: '.theme-grid',
      plugins: '#content table', users: '#content table', settings: '#settings-basic',
      logs: '#content table', backup: '.card-title',
    };
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, selector] of Object.entries(menus)) {
        await page.evaluate(name => window.navigate(name), name);
        await page.locator(selector).first().waitFor();
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(scrollWidth <= width, name + ' overflows at ' + width + 'px: ' + scrollWidth);
      }
      await openEditor(page);
      const clipped = await page.evaluate(() => {
        const card = document.querySelector('#pe-editor-card').getBoundingClientRect();
        return [...document.querySelectorAll('.editor-toolbar button')].filter(button => {
          const bounds = button.getBoundingClientRect();
          return bounds.right > card.right || bounds.left < card.left;
        }).map(button => button.title);
      });
      assert.deepEqual(clipped, [], 'editor controls clipped at ' + width + 'px');
      await screenshot(page, 'editor-' + width);
      await page.locator('#pe-title').fill('Responsive draft ' + width);
      await page.locator('#pe-content').fill('## Heading\n\n**Body**');
      await page.locator('#pe-preview strong').waitFor();
      await page.locator('#pe-status').selectOption('draft');
      await page.locator('#pe-editor-card').getByRole('button', { name: '保存', exact: true }).click();
      await page.locator('.filter-tabs').waitFor();
    }
    const saved = await api.request('GET', '/api/v1/admin/posts?status=draft', { headers });
    for (const width of [320, 390, 768, 1024, 1440]) {
      assert.ok(saved.payload.data.items.some(item => item.title === 'Responsive draft ' + width));
    }
    assert.deepEqual(errors, []);
  });
});
