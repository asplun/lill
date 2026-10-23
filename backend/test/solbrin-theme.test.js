import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';
import { startApiServer } from './helpers/api-server.js';

const themeDir = new URL('../../frontend/themes/solbrin/', import.meta.url);
const themeAvailable = existsSync(themeDir);
const defaultThemeDir = new URL('../../frontend/themes/default/', import.meta.url);

async function templateSet() {
  const templates = {};
  for (const name of await readdir(themeDir)) {
    if (name.endsWith('.html')) templates[name.slice(0, -5)] = await readFile(new URL(name, themeDir), 'utf8');
  }
  const context = vm.createContext({ window: {}, document: { getElementById: () => null } });
  vm.runInContext(await readFile(new URL('../../frontend/public/theme.js', import.meta.url), 'utf8'), context);
  return { templates, engine: context.window.LillEngine };
}

function scope(overrides = {}) {
  return {
    site: { name: 'Solbrin', description: '一页关于设计和生活的记录。', year: 2026 },
    theme: {
      navigation: ['index', 'archive'],
      extension: { navigation: [
        { key: 'index', title: '首页', url: '/', active: true },
        { key: 'archive', title: '归档', url: '/archive', active: false }
      ], heroPosts: [
        { title: '真实文章一', description: '第一篇文章摘要。', cover: '/uploads/one.jpg', url: '/post/one', category: '设计' },
        { title: '真实文章二', description: '第二篇文章摘要。', cover: '', url: '/post/two', category: '代码' }
      ] },
      hero_media_type: 'image', hero_image: '', hero_video: '', hero_poster: '',
      hero_mobile_image: '', hero_mobile_video: '', hero_position: '50% 50%',
      hero_mobile_position: '50% 50%', hero_tone: 'auto', show_sidebar: true,
      show_author: true, show_category: true, show_views: true, show_tags: true,
      show_prevnext: true, show_comment: true, footer_text: '记录设计与生活'
    },
    page: { type: 'index', title: '首页', url: '/', slug: '', query: { q: '', month: '' } },
    sidebar: {
      recentPosts: [{ title: '真实文章', url: '/post/real', published_at: '2026-10-18' }],
      categories: [{ name: '设计', slug: 'design', url: '/category/design', post_count: 2 }],
      tags: [{ name: '界面', slug: 'ui', url: '/tag/ui', post_count: 1 }]
    },
    posts: [
      { id: 'one', title: '真实文章一', excerpt: '第一篇文章摘要。', cover_image: '/uploads/one.jpg', published_at: '2026-10-18', url: '/post/one', category_name: '设计', category_slug: 'design' },
      { id: 'two', title: '真实文章二', excerpt: '第二篇文章摘要。', cover_image: '', published_at: '2026-10-17', url: '/post/two', category_name: '代码', category_slug: 'code' }
    ],
    pagination: { total: 2, page: 1, totalPages: 1, hasPrev: false, hasNext: false },
    ...overrides
  };
}

test('Solbrin manifest and settings page expose the complete configuration contract', { skip: !themeAvailable && 'solbrin 是第三方主题，未安装时跳过' }, async () => {
  const manifest = JSON.parse(await readFile(new URL('theme.json', themeDir), 'utf8'));
  assert.equal(manifest.id, 'solbrin');
  assert.equal(manifest.name, 'Solbrin');
  assert.equal(manifest.settingsPage, 'settings.html');
  assert.equal(manifest.backend.entry, 'backend/index.mjs');
  const keys = new Set(manifest.settings.map(field => field.key));
  for (const key of [
    'navigation', 'hero_media_type', 'hero_image', 'hero_video', 'hero_poster',
    'hero_mobile_image', 'hero_mobile_video', 'hero_position', 'hero_mobile_position',
    'hero_tone', 'show_sidebar', 'footer_text', 'show_author', 'show_category',
    'show_views', 'show_tags', 'show_prevnext', 'show_comment', 'custom_css'
  ]) assert.ok(keys.has(key), key);
  assert.equal(manifest.settings.find(field => field.key === 'navigation').type, 'navigation');
  const settings = await readFile(new URL('settings.html', themeDir), 'utf8');
  const settingsScript = await readFile(new URL('settings.js', themeDir), 'utf8');
  assert.match(settingsScript, /\/admin\/themes\/solbrin\/settings/);
  assert.match(settings, /\/api\.js/);
  assert.match(settingsScript, /data-nav-move/);
  assert.match(settingsScript, /beforeunload/);
});

test('Solbrin templates render real data, stable links, and working comments', { skip: !themeAvailable && 'solbrin 是第三方主题，未安装时跳过' }, async () => {
  const { templates, engine } = await templateSet();
  const render = (name, overrides) => engine.render(templates[name], templates, scope(overrides));

  const header = render('header');
  assert.match(header, /class="rail"/);
  assert.match(header, /class="nav-indicator"/);
  assert.match(header, /class="mobile-rail"/);
  assert.equal((header.match(/data-nav-link/g) || []).length, 4, 'configured navigation renders in desktop and mobile rails');
  assert.match(header, /href="\/archive"/);
  assert.doesNotMatch(header, /href="#about"/, 'navigation must not invent prototype-only routes');

  const home = render('index');
  assert.match(home, /Solbrin/);
  assert.match(home, /href="\/post\/one"/);
  assert.equal((home.match(/class="sr-sheet"/g) || []).length, 2);
  assert.match(home, /data-title="真实文章一"/);
  assert.match(home, /data-title="真实文章二"/);
  assert.match(home, /\/category\/design/);
  assert.doesNotMatch(home, /最近写下的|文章归档|选读/);

  const post = render('post', {
    page: { type: 'post', title: '真实文章一', url: '/post/one', slug: 'one', query: {} },
    post: {
      id: 'one', title: '真实文章一', html_content: '<p>正文</p>', published_at: '2026-10-18',
      category_name: '设计', category_url: '/category/design', cover_image: '/uploads/one.jpg',
      tags: [{ name: '界面', slug: 'ui', url: '/tag/ui' }], prev: null, next: { title: '下一篇', url: '/post/two' }
    },
    comments: [{ id: 'comment-one', author: '读者', content: '保留评论', created_at: '2026-10-18', replies: [] }],
    commentMeta: { total: 1, page: 1, totalPages: 1, hasPrev: false, hasNext: false, pages: [1] },
    commentDisplay: 'threaded', commentSort: 'desc', commentAllowed: true
  });
  assert.match(post, /data-sr-progress/);
  assert.match(post, /data-sr-toc-list/);
  assert.match(post, /class="reader-tools"/);
  assert.match(post, /data-reader-setting="fontSize"/);
  assert.match(post, /data-reader-setting="lineHeight"/);
  assert.match(post, /data-reader-setting="contentWidth"/);
  assert.match(post, /data-reader-action="share"/);
  assert.match(post, /data-reader-action="print"/);
  assert.match(post, /class="prose"/);
  assert.doesNotMatch(post, /sr-article__cover/, 'the original article design starts with its title, not a forced cover');
  assert.match(post, /\/post\/two/);
  assert.match(post, /\/tag\/ui/);
  assert.match(post, /class="sr-comment-form lill-comment-form"/);
  assert.match(post, /name="parentId"/);
  assert.match(post, /保留评论/);

  const archive = render('archive', {
    page: { type: 'archive', title: '归档', url: '/archive', slug: '', query: { month: '' } },
    groups: [{ ym: '2026-10', count: 1, posts: [{ title: '归档文章', url: '/post/one', published_at: '2026-10-18' }] }]
  });
  assert.match(archive, /归档文章/);
  assert.match(archive, /\/post\/one/);

  const category = render('category', {
    page: { type: 'category', title: '分类 设计', url: '/category/design', slug: 'design', query: {} },
    category: { name: '设计', url: '/category/design', post_count: 2 }
  });
  assert.match(category, /\/post\/one/);
  assert.match(category, /设计/);

  const emptySearch = render('search', {
    page: { type: 'search', title: '搜索', url: '/search', slug: '', query: { q: '找不到' } },
    keyword: '找不到', posts: [], pagination: { total: 0, page: 1, totalPages: 1 }
  });
  assert.match(emptySearch, /换一个关键词/);
  assert.match(emptySearch, /value="找不到"/);

  const notFound = render('404', { page: { type: '404', title: '页面不存在', url: '/404', slug: '', query: {} }, notFound: true });
  assert.match(notFound, /这一页不在/);
  assert.match(notFound, /\/archive/);
});

test('Solbrin installs, activates, preserves its navigation, and renders through Lill', { skip: !themeAvailable && 'solbrin 是第三方主题，未安装时跳过' }, async t => {
  const api = await startApiServer({
    prepareThemes: async themesDir => {
      await cp(defaultThemeDir, join(themesDir, 'default'), { recursive: true });
      await cp(themeDir, join(themesDir, 'solbrin'), { recursive: true });
    }
  });
  t.after(api.stop);

  const install = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Solbrin Test',
    site_url: api.baseUrl,
    admin_username: 'solbrin-admin',
    admin_password: 'solbrin-password-123',
    admin_email: 'solbrin@example.test'
  } });
  assert.equal(install.status, 200, JSON.stringify(install.payload));
  const token = install.payload.data.token;
  const csrfToken = install.payload.data.csrfToken;
  const headers = { authorization: 'Bearer ' + token, 'x-csrf-token': csrfToken };

  const activate = await api.request('POST', '/api/v1/admin/themes/solbrin/activate', { headers });
  assert.equal(activate.status, 200, JSON.stringify(activate.payload));

  const db = new DatabaseSync(api.dbPath);
  t.after(() => db.close());
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('solbrin-admin');
  const category = db.prepare("INSERT INTO categories (id, name, slug, sort_order) VALUES ('solbrin-cat', '设计', 'design', 0)").run();
  const insert = db.prepare(`INSERT INTO posts
    (id, title, slug, type, status, visibility, published_at, author_id, category_id, excerpt, cover_image)
    VALUES (?, ?, ?, 'post', 'published', 'public', ?, ?, ?, ?, ?)`);
  insert.run('solbrin-one', '真实文章一', 'one', '2026-10-18 10:00:00', admin.id, 'solbrin-cat', '第一篇文章摘要。', '/themes/solbrin/assets/home-landscape.jpg');
  insert.run('solbrin-two', '真实文章二', 'two', '2026-10-17 10:00:00', admin.id, 'solbrin-cat', '第二篇文章摘要。', '/themes/solbrin/assets/home-aurora.jpg');

  const settings = await api.request('GET', '/api/v1/admin/themes/solbrin/settings', { headers });
  assert.equal(settings.status, 200, JSON.stringify(settings.payload));
  assert.equal(settings.payload.data.settingsUrl, '/themes/solbrin/settings.html');
  assert.equal(settings.payload.data.schema.find(field => field.key === 'navigation').type, 'navigation');

  const saved = await api.request('PUT', '/api/v1/admin/themes/solbrin/settings', {
    headers, body: { navigation: ['index', 'archive'], hero_media_type: 'image', hero_tone: 'dark', show_sidebar: true }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.data.hero_tone, 'dark');

  const boot = await api.request('GET', '/api/v1/site/bootstrap?type=index');
  assert.equal(boot.status, 200, JSON.stringify(boot.payload));
  assert.equal(boot.payload.data.themeId, 'solbrin');
  assert.equal(boot.payload.data.theme.extension.navigation[0].url, '/');
  assert.match(boot.payload.data.theme.extension.heroPosts[0].url, /^\/.+/);

  const article = await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=one');
  assert.equal(article.status, 200, JSON.stringify(article.payload));
  assert.ok(article.payload.data.data.post.url, JSON.stringify(article.payload));
});
