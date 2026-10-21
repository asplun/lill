const path = require('node:path');
const { chromium } = require('/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const serverRoot = path.resolve(__dirname, '../backend');
const frontendRoot = path.resolve(__dirname, '../frontend');
process.chdir(serverRoot);

async function main() {
  const { startApiServer } = await import('../backend/test/helpers/api-server.js');
  const api = await startApiServer({
    prepareThemes: async themesDir => {
      const { cp } = await import('node:fs/promises');
      await cp(path.join(frontendRoot, 'themes/default'), path.join(themesDir, 'default'), { recursive: true });
      await cp(path.join(frontendRoot, 'themes/solbrin'), path.join(themesDir, 'solbrin'), { recursive: true });
    }
  });

  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const install = await api.request('POST', '/api/v1/install', { body: {
      site_name: 'Solbrin',
      site_url: api.baseUrl,
      admin_username: 'capture-admin',
      admin_password: 'capture-password-123',
      admin_email: 'capture@example.test'
    } });
    if (install.status !== 200) throw new Error(JSON.stringify(install.payload));
    const headers = {
      authorization: 'Bearer ' + install.payload.data.token,
      'x-csrf-token': install.payload.data.csrfToken
    };
    const activate = await api.request('POST', '/api/v1/admin/themes/solbrin/activate', { headers });
    if (activate.status !== 200) throw new Error(JSON.stringify(activate.payload));

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://frontend.test') {
        if (url.pathname.startsWith('/api/')) {
          const target = api.baseUrl + url.pathname + url.search;
          const response = await route.fetch({ url: target });
          await route.fulfill({ response });
          return;
        }
        let file = url.pathname === '/' ? '/index.html' : url.pathname;
        if (file === '/index.html' || /^\/(post|page|archive|category|tag|search)\/?$/.test(file)) {
          file = '/index.html';
        }
        if (file.startsWith('/themes/')) {
          const resolved = path.join(frontendRoot, file);
          try {
            await route.fulfill({ path: resolved });
          } catch {
            await route.fulfill({ status: 404, body: '404' });
          }
          return;
        }
        try {
          await route.fulfill({ path: path.join(frontendRoot, 'dist', file) });
        } catch {
          await route.fulfill({ path: path.join(frontendRoot, 'dist', 'index.html') });
        }
        return;
      }
      await route.continue();
    });
    await page.addInitScript(({ token, csrfToken }) => {
      localStorage.setItem('lill_token', token);
      localStorage.setItem('lill_csrf_token', csrfToken);
      localStorage.setItem('lill_dark', '0');
    }, { token: install.payload.data.token, csrfToken: install.payload.data.csrfToken });
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://frontend.test/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.screenshot({ path: '/tmp/solbrin-home.png' });
    await page.locator('[data-sr-sidebar-open]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/tmp/solbrin-sidebar.png' });
    await page.locator('[data-sr-sidebar-close]').last().click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/tmp/solbrin-mobile.png' });
    await page.goto('http://frontend.test/themes/solbrin/settings.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.screenshot({ path: '/tmp/solbrin-settings.png' });
    console.log(JSON.stringify({
      home: {
        title: await page.title(),
        cards: await page.locator('.sr-post-card').count(),
        errors
      }
    }));
  } finally {
    await browser.close();
    await api.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
