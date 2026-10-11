import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const THEME = join(ROOT, 'frontend', 'themes', 'trim3');
const THEME_MANIFEST = join(THEME, 'theme.json');
const ORIGINAL_ADMIN = join(dirname(ROOT), 'TriM3', 'lib', 'admin.php');
const PAGE_TEMPLATES = [
  '404.html',
  'archive.html',
  'category.html',
  'index.html',
  'page.html',
  'page-albums.html',
  'page-bangumi.html',
  'page-douban.html',
  'page-links.html',
  'page-moment.html',
  'page-music.html',
  'post.html',
  'search.html',
  'tag.html',
];

function engine() {
  const source = readFileSync(join(ROOT, 'frontend', 'dist', 'theme.js'), 'utf8');
  const context = {
    window: {},
    document: { getElementById: () => null },
    location: { pathname: '/' },
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.LillEngine;
}

function render(name, scope) {
  const partials = {};
  for (const file of readdirSync(THEME)) {
    if (file.endsWith('.html')) partials[file.slice(0, -5)] = readFileSync(join(THEME, file), 'utf8');
  }
  return engine().render(readFileSync(join(THEME, name), 'utf8'), partials, scope);
}

function manifestFields() {
  const manifest = JSON.parse(readFileSync(THEME_MANIFEST, 'utf8'));
  return [
    ...(Array.isArray(manifest.settings) ? manifest.settings : []),
    ...(Array.isArray(manifest.groups)
      ? manifest.groups.flatMap(group => Array.isArray(group.fields) ? group.fields : [])
      : []),
  ];
}

function originalTriM3SettingKeys() {
  const source = readFileSync(ORIGINAL_ADMIN, 'utf8');
  const start = source.indexOf('$triAllKeys = array(');
  assert.notEqual(start, -1, '原 TriM3 后台设置白名单不存在');
  const end = source.indexOf(');', start);
  assert.notEqual(end, -1, '原 TriM3 后台设置白名单未闭合');
  return [...source.slice(start, end).matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].map(match => match[1]);
}

const base = {
  site: { name: '测试站', title: '测试站', description: '' },
  page: { title: '测试页', type: 'page', query: { page: 1 } },
  theme: {},
};

test('trim3 页面模板不重复注入文档外壳', () => {
  for (const name of PAGE_TEMPLATES) {
    const source = readFileSync(join(THEME, name), 'utf8');
    assert.doesNotMatch(source, /\{include head\}/, name);
    assert.doesNotMatch(source, /<html\b|<body\b|<\/html>|<\/body>/i, name);
  }

  const head = readFileSync(join(THEME, 'head.html'), 'utf8');
  assert.doesNotMatch(head, /<!doctype|<html\b|<body\b|<\/html>|<\/body>/i);

  const footer = readFileSync(join(THEME, 'footer.html'), 'utf8');
  assert.doesNotMatch(footer, /<html\b|<body\b|<\/html>|<\/body>/i);
});

test('trim3 文章汇总页模板存在', () => {
  assert.ok(readFileSync(join(THEME, 'page-articles.html'), 'utf8'));
});

test('文章汇总页使用主题文章数据和分页状态', () => {
  const html = render('page-articles.html', {
    ...base,
    theme: { postCardStyle: 'original', showCategory: true, showComment: true, showThumb: true },
    articlesTotal: 2,
    articles: [{
      title: '汇总文章',
      url: '/post/summary',
      excerpt: '摘要',
      published_at: '2024-01-02',
      category_name: '技术',
      comment_count: 3,
      likes: 4,
    }],
    articlesPagination: { page: 1, totalPages: 2, hasPrev: false, hasNext: true },
  });

  assert.match(html, /汇总文章/);
  assert.match(html, /共 2 篇文章/);
  assert.match(html, /下一页/);
});

test('友情链接模板使用后端 linkGroups 数据并渲染链接', () => {
  const html = render('page-links.html', {
    ...base,
    theme: { friendApply: 'true' },
    linkGroupsList: [{
      name: '技术',
      links: [{ url: 'https://example.com', name: '示例站', avatar: '', description: '描述' }],
    }, {
      name: '其他',
      links: [{ url: 'https://other.example.com', name: '其他站', avatar: '', description: '' }],
    }],
    linkGroupCount: 2,
  });

  assert.match(html, /技术/);
  assert.match(html, /示例站/);
  assert.match(html, /https:\/\/example\.com/);
  assert.doesNotMatch(html, />true</);
});

test('左侧导航使用 navItems 的名称、地址和图标', () => {
  const html = render('nav-left.html', {
    ...base,
    navItems: [{ name: '首页', title: '错误标题', url: '/', icon: 'ri-home-5-line', active: true }],
  });

  assert.match(html, /href="\/"/);
  assert.match(html, /ri-home-5-line/);
  assert.match(html, />首页</);
  assert.doesNotMatch(html, /ri-links-line/);
});

test('豆瓣模板可以编译并渲染动态类型数据', () => {
  const html = render('page-douban.html', {
    ...base,
    theme: { doubanUid: '123', doubanShowSearch: '1', doubanShowFilter: '1' },
    doubanTotal: 1,
    doubanSections: [{
      type: 'movie',
      name: '电影',
      icon: 'ri-film-line',
      active: true,
      items: [{
        title: '测试电影',
        url: 'https://movie.example.com',
        cover: '/cover.jpg',
        rating: 8.5,
        rating_stars: '★★★★',
        remark: '很好看',
        status_key: 'done',
        status_text: '看过',
        date: '2024-01-01',
        genres: ['剧情'],
      }],
      statuses: [{ key: 'done', label: '看过', count: 1 }],
      years: [{ year: '2024', items: [{ title: '测试电影' }] }],
    }],
  });

  assert.match(html, /测试电影/);
  assert.match(html, /看过/);
  assert.match(html, /2024/);
});

test('说说模板使用图片数量、点赞数和评论数真实字段', () => {
  const html = render('page-moment.html', {
    ...base,
    momentTotal: 1,
    momentTotalPages: 1,
    moments: [{
      id: 7,
      content: '测试说说',
      images: ['/a.jpg'],
      likes: 3,
      comment_count: 4,
      created_at: '2024-01-01 12:00:00',
    }],
  });

  assert.match(html, /gallery-n-1/);
  assert.match(html, />3</);
  assert.match(html, />4</);
  assert.doesNotMatch(html, /\{count\(/);
});

test('番剧模板使用数组化的年份和类型分组', () => {
  const html = render('page-bangumi.html', {
    ...base,
    bangumiTotal: 1,
    bangumiData: [{
      title: '测试番剧',
      url: 'https://example.com/bangumi',
      cover: '/bangumi.jpg',
      status: '2',
      styles: ['科幻'],
      remark: '更新至 1 话',
    }],
    bangumiGenreList: [{ name: '科幻', count: 1 }],
    bangumiYearGroups: [{ year: '2024', items: [{
      title: '测试番剧',
      url: 'https://example.com/bangumi',
      cover: '/bangumi.jpg',
      status: '2',
      styles: ['科幻'],
      remark: '更新至 1 话',
    }] }],
    bangumiStatusCount: { watching: 1, wish: 0, watched: 0 },
  });

  assert.match(html, /测试番剧/);
  assert.match(html, /科幻/);
  assert.match(html, /更新至 1 话/);
});

test('trim3 主题设置只使用 lill 支持的控件并隐藏内部小组件字段', () => {
  const fields = manifestFields();
  const supported = new Set(['color', 'select', 'text', 'textarea', 'checkbox', 'number']);
  assert.ok(fields.length > 0);
  for (const field of fields) {
    assert.ok(supported.has(field.type), `${field.key} 使用了不受支持的控件类型 ${field.type}`);
  }

  const keys = new Set(fields.map(field => field.key));
  assert.equal(keys.has('leftWidgets'), false);
  assert.equal(keys.has('rightWidgets'), false);
});

test('trim3 主题设置覆盖原 TriM3 的全部公开设置键', () => {
  const keys = new Set(manifestFields().map(field => field.key));
  for (const key of originalTriM3SettingKeys()) {
    assert.equal(keys.has(key), true, `主题设置缺少原 TriM3 字段 ${key}`);
  }
});

test('首页横向菜单使用统一的分类属性并支持文章汇总页回退', () => {
  const template = readFileSync(join(THEME, 'home-menu.html'), 'utf8');
  const runtime = readFileSync(join(THEME, 'theme.js'), 'utf8');

  assert.match(template, /data-tri3-cat=/);
  assert.match(template, /\$menuItem\.type == 'posts' && \(\$menuItem\.url == '\/' \|\| !\$menuItem\.url\)/);
  assert.doesNotMatch(runtime, /getAttribute\(['"]data-moment-cat['"]\)/);
  assert.match(runtime, /data-tri3-cat/);
  assert.match(runtime, /page\/articles/);
});

test('首页菜单首屏把空文章入口渲染为文章汇总页并保留自定义文章地址', () => {
  const html = render('home-menu.html', {
    ...base,
    theme: { homeMenu: 'true' },
    menuItems: [
      { name: '首页', url: '/', type: 'link', active: true },
      { name: '文章', url: '/', type: 'posts', active: false },
      { name: '自定义文章', url: '/page/custom-articles', type: 'posts', active: false },
    ],
    menuCats: [],
    momentCategories: [],
  });

  assert.match(html, /href="\/page\/articles"[^>]*data-posts-link/);
  assert.match(html, /href="\/page\/custom-articles"[^>]*data-posts-link/);
});
