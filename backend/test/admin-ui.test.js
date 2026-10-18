import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startApiServer } from './helpers/api-server.js';

// Opt in with LILL_UI_PLAYWRIGHT (module path) and optionally LILL_UI_CHROME.
// Uses the built admin HTML with current public assets, without rebuilding themes.
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidenceDir = process.env.LILL_UI_EVIDENCE_DIR;

test('admin UI browser regressions', { skip: !process.env.LILL_UI_PLAYWRIGHT }, async t => {
  const { chromium } = await import(process.env.LILL_UI_PLAYWRIGHT);
  const api = await startApiServer({ prepareThemes: target => cp(
    join(root, 'frontend/themes/default'), join(target, 'default'), { recursive: true },
  ) });
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
      const liveAsset = url.pathname.startsWith('/admin/') && /\.(js|css)$/.test(url.pathname);
      const upload = url.pathname === image.url;
      const base = upload ? dirname(image.path) : join(root, 'frontend', liveAsset ? 'public' : 'dist');
      let target = upload ? image.path : resolve(base, '.' + decodeURIComponent(url.pathname));
      if (!target.startsWith(base + '/')) { res.writeHead(404); res.end(); return; }
      if ((await stat(target)).isDirectory()) target = join(target, 'index.html');
      const types = { js: 'text/javascript', html: 'text/html', css: 'text/css', svg: 'image/svg+xml', png: 'image/png' };
      res.setHeader('Content-Type', types[target.split('.').pop()] || 'application/octet-stream');
      res.end(await readFile(target));
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.LILL_UI_CHROME ? { executablePath: process.env.LILL_UI_CHROME } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
