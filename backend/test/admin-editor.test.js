import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../../frontend/public/admin/app.js', import.meta.url), 'utf8');

const decodeEntities = (s) => String(s)
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** 极简 DOM 桩：只为验证 admin 编辑器的 HTML 结构与交互逻辑，不做真实渲染 */
async function createAdminApp(options = {}) {
  const elements = new Map();
  const protectedIds = new Set(['content', 'page-title', 'topbar-actions']);
  const apiCalls = [];
  const store = new Map();

  class FakeElement {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.id = '';
      this.value = '';
      this.checked = false;
      this._text = '';
      this._html = '';
      this._ownedIds = new Set();
      this._listeners = {};
      this.dataset = {};
      this.classList = {
        _set: new Set(),
        add: (c) => this.classList._set.add(c),
        remove: (c) => this.classList._set.delete(c),
        toggle: (c) => this.classList._set.has(c) ? this.classList._set.delete(c) : this.classList._set.add(c),
        contains: (c) => this.classList._set.has(c),
      };
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this._html = escapeHtml(v); }
    get innerHTML() { return this._html; }
    set innerHTML(html) {
      for (const id of this._ownedIds) if (!protectedIds.has(id)) elements.delete(id);
      this._ownedIds = new Set();
      this._html = String(html);
      const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
      let m;
      while ((m = tagRe.exec(this._html))) {
        const attrs = m[2] || '';
        const idMatch = /\bid="([^"]+)"/.exec(attrs);
        if (!idMatch) continue;
        const el = new FakeElement(m[1]);
        el.id = idMatch[1];
        const valueMatch = /\bvalue="([^"]*)"/.exec(attrs);
        if (valueMatch) el.value = decodeEntities(valueMatch[1]);
        if (/\bchecked\b/.test(attrs)) el.checked = true;
        elements.set(el.id, el);
        this._ownedIds.add(el.id);
      }
    }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    dispatch(type, event = {}) {
      const ev = { preventDefault() {}, target: this, ...event };
      for (const fn of this._listeners[type] || []) fn(ev);
      return ev;
    }
    focus() {}
    appendChild() {}
    remove() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
  }

  const document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new FakeElement(tag),
    querySelector: () => new FakeElement('div'),
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: new FakeElement('body'),
  };
  for (const id of ['content', 'page-title', 'topbar-actions', 'logout-btn', 'user-name']) {
    const el = new FakeElement('div');
    el.id = id;
    elements.set(id, el);
  }

  const responses = {
    '/admin/categories': [],
    '/admin/page-templates': { templates: [{ key: 'page-links', name: '友情链接', file: 'page-links.html' }] },
    '/admin/options': [{ key: 'permalink', value: '/archives/{slug}/' }],
    ...(options.responses || {}),
  };
  const lillAPI = {
    request: async (path, opts = {}) => {
      apiCalls.push({ path, opts });
      if (path in responses) return responses[path];
      if (path.startsWith('/admin/posts/')) {
        return { id: path.split('/').pop(), title: '已有文章', slug: 'existing-post', content: '旧内容', excerpt: '', status: 'published', tags: ['旧标签'] };
      }
      if (path.startsWith('/admin/posts')) return { items: [], meta: {} };
      return {};
    },
  };

  const sandbox = {
    console, setTimeout, clearTimeout, Date, JSON, Math, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
    prompt: options.prompt || (() => null),
    confirm: options.confirm || (() => false),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document,
    location: { href: 'http://localhost/admin/' },
  };
  sandbox.window = sandbox;
  sandbox.window.lillAPI = lillAPI;

  const ctx = vm.createContext(sandbox);
  // app.js 是 type="module"（含顶层 await），用 async IIFE 包装后执行，
  // 并把模块内部的纯函数暴露到 window.__editorInternals 供断言使用。
  const wrapped = [
    '(async () => {',
    appSource,
    ';window.__editorInternals = { mdToHtml, mdClientSlug, mdSync, mdInsertText, mdToggleMode, mdEl };',
    'render = async () => {};',
    '})();',
  ].join('\n');
  await vm.runInContext(wrapped, ctx, { filename: 'admin-app.js' });
  return { sandbox, ctx, elements, apiCalls, store, document, internals: sandbox.__editorInternals };
}

test('mdToHtml 渲染标题、列表、强调、链接、图片与代码块', async () => {
  const { internals } = await createAdminApp();
  const html = internals.mdToHtml('# 标题\n\n- a\n- b\n\n**粗体** 与 *斜体* 和 `code`\n\n[链接](https://example.com) ![图](https://example.com/a.png)\n\n> 引用\n\n```js\nconst a = 1;\n```');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png"/);
  assert.match(html, /<blockquote>引用<\/blockquote>/);
  assert.match(html, /<pre><code class="language-js">/);
});

test('mdClientSlug 与后端规则一致：保留中文、折叠标点', async () => {
  const { internals } = await createAdminApp();
  assert.equal(internals.mdClientSlug('Hello World! 你好'), 'hello-world-你好');
  assert.equal(internals.mdClientSlug('  A_B '), 'a-b');
  assert.equal(internals.mdClientSlug('!!!'), '');
});

test('文章编辑器：结构完整、onclick 语法合法、含别名与工具栏', async () => {
  const { sandbox, elements } = await createAdminApp();
  await sandbox.openPostEditor('post', null);
  const content = elements.get('content').innerHTML;
  for (const id of ['pe-title', 'pe-content', 'pe-preview', 'pe-slug', 'pe-slug-hint', 'pe-status', 'pe-cat', 'pe-tags', 'pe-cover', 'pe-sticky', 'pe-excerpt', 'pe-wrap', 'pe-count']) {
    assert.ok(content.includes('id="' + id + '"'), '缺少 ' + id);
  }
  for (const label of ['H2', '粗体', '引用', '代码块', '无序列表', '全屏编辑']) {
    assert.ok(content.includes(label), '工具栏缺少 ' + label);
  }
  const onclicks = [...content.matchAll(/onclick="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  assert.ok(onclicks.length >= 15, '按钮数量异常: ' + onclicks.length);
  for (const code of onclicks) {
    assert.doesNotThrow(() => new vm.Script('(function(){' + code + '})'), 'onclick 语法错误: ' + code);
  }
  assert.match(content, /data-mode="split"/);
});

test('别名联动：标题自动生成、手动改后不再覆盖、地址预览更新', async () => {
  const { sandbox, elements } = await createAdminApp();
  await sandbox.openPostEditor('post', null);
  const title = elements.get('pe-title');
  const slug = elements.get('pe-slug');
  const hint = elements.get('pe-slug-hint');

  title.value = '新的文章标题';
  title.dispatch('input');
  assert.equal(slug.value, '新的文章标题');
  assert.match(hint.textContent, /^预计地址：\/archives\/%E6%96%B0/);
  assert.ok(!hint.textContent.includes('未使用别名'));

  slug.value = 'custom-slug';
  slug.dispatch('input');
  title.value = '另一个标题';
  title.dispatch('input');
  assert.equal(slug.value, 'custom-slug', '手动改过别名后标题不应覆盖');
  assert.match(hint.textContent, /\/archives\/custom-slug\//);
});

test('保存文章：组装 slug、置顶、封面、标签与分类', async () => {
  const { sandbox, elements, apiCalls } = await createAdminApp();
  await sandbox.openPostEditor('post', null);

  elements.get('pe-title').value = '测试标题';
  elements.get('pe-content').value = '正文';
  elements.get('pe-slug').value = 'my-slug';
  elements.get('pe-cover').value = 'https://img.example/a.png';
  elements.get('pe-sticky').checked = true;
  elements.get('pe-tags').value = 'a, b';
  elements.get('pe-cat').value = 'cat-1';

  await sandbox.savePost('post', null);
  const create = apiCalls.find((c) => c.path === '/admin/posts' && c.opts.method === 'POST');
  assert.ok(create, '未调用创建接口');
  assert.equal(create.opts.body.slug, 'my-slug');
  assert.equal(create.opts.body.sticky, true);
  assert.equal(create.opts.body.coverImage, 'https://img.example/a.png');
  assert.equal(JSON.stringify(create.opts.body.tagNames), JSON.stringify(['a', 'b']));
  assert.equal(create.opts.body.categoryId, 'cat-1');
  assert.equal(create.opts.body.title, '测试标题');
});

test('页面编辑器：保留别名与模板，不显示分类标签框', async () => {
  const { sandbox, elements } = await createAdminApp();
  await sandbox.openPostEditor('page', 'p1');
  const content = elements.get('content').innerHTML;
  assert.ok(content.includes('id="pe-slug"'));
  assert.ok(content.includes('id="pe-template"'), '页面模板下拉应存在');
  assert.ok(!content.includes('id="pe-cat"'), '页面不应有分类下拉');
  assert.ok(!content.includes('id="pe-tags"'), '页面不应有标签输入');
  assert.equal(elements.get('pe-slug').value, 'existing-post');
  // 编辑旧文时改标题不应覆盖已有别名
  const title = elements.get('pe-title');
  title.value = '改名了';
  title.dispatch('input');
  assert.equal(elements.get('pe-slug').value, 'existing-post');
});

test('控制台显示真实草稿与待审评论，并转义用户内容', async () => {
  const { sandbox, elements, apiCalls } = await createAdminApp({
    responses: {
      '/admin/stats/dashboard': { overview: { postCount: 24, pageCount: 4, pendingCommentCount: 1 } },
      '/admin/stats/system': { nodeVersion: 'v22', dbVersion: '3', uptime: 3600 },
      '/admin/posts/recent': [{ id: 'p1', title: 'Hello World', status: 'published' }],
      '/admin/posts?status=draft&pageSize=3': {
        items: [{ id: 'd1', title: '<script>草稿</script>', status: 'draft' }],
        meta: { total: 7 },
      },
      '/admin/comments?status=pending&pageSize=2': {
        items: [{ id: 'c1', author_name: '读者', content: '<img src=x>待审核内容' }],
        meta: { total: 1 },
      },
    },
  });
  await sandbox.renderDashboard();
  const html = elements.get('content').innerHTML;
  assert.ok(html.includes('&lt;script&gt;草稿&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x&gt;待审核内容'));
  assert.ok(!html.includes('<script>草稿'));
  assert.ok(html.includes('>7<'), '草稿总数应来自分页总量，不能使用当前页长度');
  assert.ok(apiCalls.some(call => call.path === '/admin/comments?status=pending&pageSize=2'));
});

test('文章状态筛选实际传给接口，切回全部后移除筛选', async () => {
  const { sandbox, apiCalls } = await createAdminApp();
  await sandbox.filterPosts('draft');
  await sandbox.renderPosts();
  assert.ok(apiCalls.some(call => call.path === '/admin/posts?page=1&pageSize=20&status=draft'));
  apiCalls.length = 0;
  await sandbox.filterPosts('');
  await sandbox.renderPosts();
  assert.ok(apiCalls.some(call => call.path === '/admin/posts?page=1&pageSize=20'));
});

test('评论状态筛选在重建页面容器后保留', async () => {
  const { sandbox, elements, apiCalls } = await createAdminApp();
  await sandbox.filterComments('pending');
  elements.get('content').innerHTML = '<div class="loading"></div>';
  await sandbox.renderComments();
  assert.ok(apiCalls.some(call => call.path === '/admin/comments?page=1&pageSize=20&status=pending'));
});
