import { cp } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { startApiServer } from '../backend/test/helpers/api-server.js';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'frontend/dist');
const themes = join(root, 'frontend/themes');
const port = 4178;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

async function serveFile(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('404');
  }
}

async function main() {
  const api = await startApiServer({
    prepareThemes: async dir => {
      await cp(join(themes, 'default'), join(dir, 'default'), { recursive: true });
      await cp(join(themes, 'solbrin'), join(dir, 'solbrin'), { recursive: true });
    }
  });
  const install = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Solbrin',
    site_description: '在设计与代码之间，记录生活的另一种可能。',
    site_url: `http://127.0.0.1:${port}`,
    admin_username: 'preview',
    admin_password: 'preview-password-123',
    admin_email: 'preview@example.test'
  } });
  if (install.status !== 200) throw new Error(JSON.stringify(install.payload));
  const headers = { authorization: 'Bearer ' + install.payload.data.token, 'x-csrf-token': install.payload.data.csrfToken };
  const activated = await api.request('POST', '/api/v1/admin/themes/solbrin/activate', { headers });
  if (activated.status !== 200) throw new Error(JSON.stringify(activated.payload));

  const db = new DatabaseSync(api.dbPath);
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('preview');
  const category = db.prepare("SELECT id FROM categories ORDER BY created_at LIMIT 1").get();
  const insert = db.prepare(`INSERT INTO posts
    (id, title, slug, type, status, visibility, published_at, author_id, category_id, excerpt, cover_image, content, html_content)
    VALUES (?, ?, ?, 'post', 'published', 'public', ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('preview-one', '关于悬浮导航的一点想法', 'one', '2026-10-12 10:00:00', admin.id, category.id, '一条竖直的胶囊，为何比横着的顶栏更耐看。', '/themes/solbrin/assets/home-landscape.jpg', '', '<p>导航不是页面上最重要的内容，却会参与每一次浏览。</p><h2>把位置交给内容</h2><p>侧边导航让页面保留连续的横向空间。当前页、焦点和悬停状态需要轻，但也要能被一眼读出来。</p><h2>让交互保持连续</h2><p>指示器跟着当前入口移动，在连续切换时保留速度和方向，避免每一次动作都像重新开始。</p><h3>阅读设置</h3><p>正文宽度和行高可以独立调节，修改后刷新仍保留选择。</p><h2>最后一节</h2><p>目录只在正文存在标题时出现，读到末尾时退开，不与结论争位置。</p>');
  insert.run('preview-two', '毛玻璃到底该用在什么上面', 'two', '2026-10-08 10:00:00', admin.id, category.id, '背后得有东西可透，玻璃才成立。', '/themes/solbrin/assets/home-aurora.jpg', '', '<p>背后有东西在动、颜色在变，半透明才有意义。</p>');
  insert.run('preview-three', '写作这件事的节奏', 'three', '2026-09-27 10:00:00', admin.id, category.id, '想清楚了才写。写不下来的时候，就不写。', '/themes/solbrin/assets/home-mist.jpg', '', '<p>有些想法需要留一段空白。</p>');
  db.close();

  const staticServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      const target = new URL(url.pathname + url.search, api.baseUrl);
      const response = await fetch(target, {
        method: req.method,
        headers: { ...req.headers, host: new URL(api.baseUrl).host },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (url.pathname === '/favicon.ico') return serveFile(res, join(dist, 'favicon.svg'));
    let file = url.pathname;
    if (file === '/' || /^\/(post|page|archive|category|tag|search)(?:\/.*)?$/.test(file)) file = '/index.html';
    if (file.startsWith('/themes/')) return serveFile(res, join(root, 'frontend', file));
    return serveFile(res, join(dist, file));
  });
  await new Promise(resolve => staticServer.listen(port, '127.0.0.1', resolve));

  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: process.env.REDUCED_MOTION === 'reduce' ? 'reduce' : 'no-preference'
    });
    const errors = [];
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.location().url + ' — ' + message.text());
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400) errors.push(response.status() + ' ' + response.url());
    });
    await page.addInitScript(({ token, csrfToken }) => {
      localStorage.setItem('lill_token', token);
      localStorage.setItem('lill_csrf_token', csrfToken);
    }, { token: install.payload.data.token, csrfToken: install.payload.data.csrfToken });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const desktopGeometry = await page.evaluate(() => {
      const box = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        rail: box('.rail'),
        hero: box('.sr-hero'),
        media: box('.sr-hero__media'),
        identity: box('.sr-hero__copy'),
        deck: box('.sr-deck'),
        card: box('.sr-post-card')
      };
    });
    assert.equal(desktopGeometry.hero.x, 0, 'hero starts at the viewport edge');
    assert.equal(desktopGeometry.hero.y, 0, 'hero starts at the top edge');
    assert.equal(desktopGeometry.hero.width, desktopGeometry.viewport.width, 'hero spans the viewport');
    assert.deepEqual(
      [desktopGeometry.rail.x, desktopGeometry.rail.y, desktopGeometry.rail.width],
      [20, 20, 60],
      'desktop navigation keeps the original floating geometry'
    );
    assert.equal(desktopGeometry.card.y, desktopGeometry.hero.y + desktopGeometry.hero.height, 'cards start at the end of the hero');
    assert.ok(desktopGeometry.card.height <= 168, 'cards stay compact');
    assert.equal(await page.locator('[data-sr-title]').textContent(), 'Solbrin', 'hero shows the site name by default');
    await page.screenshot({ path: '/tmp/solbrin-home.png' });
    const choiceCount = await page.locator('.sr-sheet').count();
    await page.locator('.sr-deck').hover();
    await page.waitForTimeout(260);
    await page.screenshot({ path: '/tmp/solbrin-deck-expanded.png' });
    const expanded = await page.locator('.sr-deck').getAttribute('data-expanded');
    if (choiceCount > 1) {
      await page.locator('.sr-sheet').nth(1).click();
      await page.waitForTimeout(420);
    }
    const selectedTitle = await page.locator('[data-sr-title]').textContent();
    await page.screenshot({ path: '/tmp/solbrin-selected.png' });
    const reset = page.locator('[data-sr-reset]');
    if (await reset.isVisible()) {
      await reset.click();
      await page.waitForTimeout(320);
    }
    await page.evaluate(() => window.scrollTo(0, 520));
    await page.waitForTimeout(160);
    await page.evaluate(() => window.scrollTo(0, 460));
    await page.waitForTimeout(700);
    await page.locator('[data-sr-sidebar-open]').click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: '/tmp/solbrin-sidebar.png' });
    await page.locator('[data-sr-sidebar-close]').last().click();

    let articleHeadings = 0;
    await page.goto(`http://127.0.0.1:${port}/post/one`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    const postGeometry = await page.evaluate(() => {
      const box = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
      };
      return {
        rail: box('.rail'),
        toc: box('.article-toc'),
        body: box('.article-body'),
        tools: box('.reader-tools')
      };
    });
    assert.deepEqual([postGeometry.rail.x, postGeometry.rail.y, postGeometry.rail.width], [20, 20, 60], 'article pages use the same floating navigation');
    articleHeadings = await page.locator('[data-sr-toc-list] a').count();
    assert.ok(articleHeadings >= 3, 'article headings generate a reading outline');
    assert.ok(postGeometry.toc.right < postGeometry.body.x, 'the outline stays left of the article body');
    assert.ok(postGeometry.tools.x > postGeometry.body.right, 'reading tools stay right of the article body');
    assert.equal(await page.locator('.sr-article__cover').count(), 0, 'article content does not get a forced cover');
    await page.screenshot({ path: '/tmp/solbrin-post.png', fullPage: true });
    const articleUrl = page.url();
    await page.locator('[data-sr-toc-list] a').first().click();
    await page.waitForTimeout(180);
    assert.equal(page.url(), articleUrl, 'outline navigation scrolls without changing the article route');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } });
    });
    await page.locator('[data-reader-action="share"]').click();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[data-reader-feedback]').textContent(), '链接已复制', 'share has a clipboard fallback and feedback');

    const bodyWidth = await page.locator('.article-body').evaluate(node => node.getBoundingClientRect().width);
    const contentWidth = page.locator('[data-reader-setting="contentWidth"]');
    await contentWidth.evaluate(input => {
      input.value = '820';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.locator('.article-body').evaluate(node => node.getBoundingClientRect().width), bodyWidth + 70, 'reading width control updates the content measure');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('[data-reader-setting="contentWidth"]').inputValue(), '820', 'reading width is restored from local preferences');
    await page.evaluate(() => { window.print = () => { window.__printCalled = true; }; });
    await page.locator('[data-reader-action="print"]').click();
    assert.equal(await page.evaluate(() => window.__printCalled), true, 'print control invokes the browser print action');
    await page.locator('[data-reader-reset]').click();
    assert.equal(await page.locator('[data-reader-setting="contentWidth"]').inputValue(), '750', 'reader reset restores the default width');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const mobileGeometry = await page.evaluate(() => {
      const node = document.querySelector('.mobile-rail');
      const hero = document.querySelector('.sr-hero');
      const rail = node.getBoundingClientRect();
      const scene = hero.getBoundingClientRect();
      return { rail: { x: rail.x, y: rail.y, width: rail.width, height: rail.height }, hero: { x: scene.x, y: scene.y, width: scene.width } };
    });
    assert.equal(mobileGeometry.hero.x, 0, 'mobile hero starts at the viewport edge');
    assert.equal(mobileGeometry.hero.width, 390, 'mobile hero keeps the viewport width');
    assert.ok(mobileGeometry.rail.y > 700, 'mobile navigation stays at the bottom instead of becoming a top bar');
    await page.screenshot({ path: '/tmp/solbrin-mobile.png' });
    await page.locator('.mobile-rail a[data-nav-link]').nth(1).click();
    await page.waitForLoadState('networkidle');
    assert.match(page.url(), /\/archive\/?$/, 'mobile navigation follows the configured archive URL');
    assert.equal(await page.locator('.mobile-rail a[data-nav-link][aria-current="page"]').getAttribute('aria-label'), '归档');
    await page.goto(`http://127.0.0.1:${port}/post/one`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'mobile article layout has no horizontal overflow');
    assert.ok(await page.locator('[data-sr-toc-list] a').count() >= 3, 'mobile article keeps its generated outline');
    await page.screenshot({ path: '/tmp/solbrin-post-mobile.png', fullPage: true });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/tmp/solbrin-short-landscape.png' });
    const homeTitle = await page.title();
    const cardCount = await page.locator('.sr-post-card').count();
    await page.goto(`http://127.0.0.1:${port}/themes/solbrin/settings.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: '/tmp/solbrin-settings.png' });
    const settingsLoadingHidden = await page.locator('#settings-loading').isHidden();
    assert.deepEqual(errors, [], 'all theme pages run without browser errors');
    console.log(JSON.stringify({
      homeTitle,
      cards: cardCount,
      articleHeadings,
      choices: choiceCount,
      deckExpanded: expanded === '',
      selectedTitle,
      settingsLoadingHidden,
      errors
    }));
  } finally {
    await browser.close();
    staticServer.close();
    await api.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
