import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
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
  const store = new Map([['lill_token', 'test-only-admin-session']]);

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
      this.style = {};
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
      const textareaRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g;
      while ((m = textareaRe.exec(this._html))) {
        const idMatch = /\bid="([^"]+)"/.exec(m[1] || '');
        const el = idMatch && elements.get(idMatch[1]);
        if (el) el.value = decodeEntities(m[2]);
      }
      const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/g;
      while ((m = selectRe.exec(this._html))) {
        const idMatch = /\bid="([^"]+)"/.exec(m[1] || '');
        const optionMatch = /<option\b[^>]*\bvalue="([^"]*)"[^>]*\bselected\b/.exec(m[2] || '');
        const el = idMatch && elements.get(idMatch[1]);
        if (el && optionMatch) el.value = decodeEntities(optionMatch[1]);
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
    '/auth/me': { id: 'admin-test', username: 'admin', role: 'admin' },
    '/admin/categories': [],
    '/admin/page-templates': { templates: [{ key: 'page-links', name: '友情链接', file: 'page-links.html' }] },
    '/admin/options': [{ key: 'permalink', value: '/archives/{slug}/' }],
    '/admin/users/user-late': { id: 'user-late', username: 'late', nickname: 'Late User', email: 'late@example.test', role: 'author', status: 'active' },
    ...(options.responses || {}),
  };
  const lillAPI = {
    newRenderScope: () => new AbortController().signal,
    request: async (path, opts = {}) => {
      apiCalls.push({ path, opts });
      if (options.errors?.[path]) throw options.errors[path];
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
    encodeURIComponent, decodeURIComponent, crypto: webcrypto, URL,
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
    ';window.__editorInternals = { mdToHtml, mdClientSlug, mdSync, mdInsertText, mdToggleMode, mdEl, paginate, loadPluginMenus, createEditorBridge, createEditorSlots, loadEditorExtensions };',
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

test('文章编辑器按 schema 渲染已保存主题字段、分组并安全转义用户文本', async () => {
  const maliciousLabel = '<img id="theme-field-xss" src=x onerror=alert(1)>';
  const maliciousValue = '<script>alert("value")</script>';
  const { sandbox, elements, apiCalls } = await createAdminApp({
    responses: {
      '/admin/editor-fields?type=post': { themeId: 'fixture', fields: [
        { key: 'subtitle', label: maliciousLabel, type: 'text', for: 'post', group: '展示', default: '默认副标题', description: '<b>说明</b>' },
        { key: 'body_note', label: '补充说明', type: 'textarea', for: 'post', group: '展示', default: '' },
        { key: 'layout', label: '版式', type: 'select', for: 'post', group: '显示', default: 'wide', options: [{ value: 'wide', label: '宽屏' }, { value: 'normal', label: '常规' }] },
        { key: 'show_index', label: '加入目录', type: 'checkbox', for: 'post', default: true },
        { key: 'reading_time', label: '阅读时长', type: 'number', for: 'post', group: '显示', default: 5 },
        { key: 'source_url', label: '来源地址', type: 'url', for: 'post', group: '来源', default: '' },
      ] },
      '/admin/posts/post-1': {
        id: 'post-1', title: '已有文章', slug: 'existing-post', content: '旧内容', excerpt: '',
        status: 'published', tags: [], themeFields: {
          subtitle: maliciousValue, body_note: '<b>正文备注</b>', layout: 'normal', show_index: false,
        },
      },
    },
  });
  await sandbox.openPostEditor('post', 'post-1');
  const html = elements.get('content').innerHTML;
  assert.ok(html.includes('id="pe-theme-field-subtitle"'));
  assert.ok(html.includes('id="pe-theme-field-body_note"'));
  assert.ok(html.includes('id="pe-theme-field-layout"'));
  assert.ok(html.includes('id="pe-theme-field-show_index"'));
  assert.ok(html.includes('id="pe-theme-field-reading_time"'));
  assert.match(html, /id="pe-theme-field-reading_time" type="number" step="any"/);
  assert.ok(html.includes('id="pe-theme-field-source_url"'));
  assert.match(html, /&lt;img id=&quot;theme-field-xss&quot;/);
  assert.match(html, /&lt;b&gt;说明&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img id="theme-field-xss"/);
  assert.doesNotMatch(html, /<script>alert\("value"\)<\/script>/);
  assert.equal(elements.get('pe-theme-field-subtitle').value, maliciousValue);
  assert.equal(elements.get('pe-theme-field-body_note').value, '<b>正文备注</b>');
  assert.equal(elements.get('pe-theme-field-layout').value, 'normal');
  assert.equal(elements.get('pe-theme-field-show_index').checked, false);
  assert.equal(elements.get('pe-theme-field-reading_time').value, '5');
  assert.equal(elements.get('pe-theme-field-source_url').value, '');
  assert.equal((html.match(/class="side-box theme-editor-group"/g) || []).length, 4);
  assert.ok(apiCalls.some(call => call.path === '/admin/editor-fields?type=post'));

  elements.get('pe-theme-field-subtitle').value = '新的副标题';
  elements.get('pe-theme-field-layout').value = 'wide';
  elements.get('pe-theme-field-show_index').checked = true;
  elements.get('pe-theme-field-reading_time').value = '12';
  elements.get('pe-theme-field-source_url').value = 'https://example.test/source';
  sandbox.navigate = () => {};
  await sandbox.savePost('post', 'post-1');
  const update = apiCalls.find(call => call.path === '/admin/posts/post-1' && call.opts.method === 'PUT');
  assert.deepEqual(JSON.parse(JSON.stringify(update.opts.body.themeFields)), {
    subtitle: '新的副标题', body_note: '<b>正文备注</b>', layout: 'wide', show_index: true,
    reading_time: 12, source_url: 'https://example.test/source',
  });
});

test('文章和页面只渲染对应字段并以声明默认值提交', async () => {
  const { sandbox, elements, apiCalls } = await createAdminApp({
    responses: {
      '/admin/editor-fields?type=post': { themeId: 'fixture', fields: [
        { key: 'post_note', label: '文章备注', type: 'text', for: 'post', default: '文章默认值' },
      ] },
      '/admin/editor-fields?type=page': { themeId: 'fixture', fields: [
        { key: 'page_heading', label: '页面标题', type: 'text', for: 'page', default: '页面默认值' },
      ] },
    },
  });
  await sandbox.openPostEditor('post', null);
  assert.equal(elements.get('pe-theme-field-post_note').value, '文章默认值');
  assert.equal(elements.has('pe-theme-field-page_heading'), false);
  elements.get('pe-title').value = '主题字段文章';
  sandbox.navigate = () => {};
  await sandbox.savePost('post', null);
  const createPost = apiCalls.find(call => call.path === '/admin/posts' && call.opts.method === 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(createPost.opts.body.themeFields)), { post_note: '文章默认值' });

  await sandbox.openPostEditor('page', null);
  const html = elements.get('content').innerHTML;
  assert.equal(elements.has('pe-theme-field-post_note'), false);
  assert.equal(elements.get('pe-theme-field-page_heading').value, '页面默认值');
  assert.doesNotMatch(html, /文章备注/);
  elements.get('pe-title').value = '主题字段页面';
  await sandbox.savePost('page', null);
  const createPage = apiCalls.find(call => call.path === '/admin/posts' && call.opts.method === 'POST' && call.opts.body.type === 'page');
  assert.deepEqual(JSON.parse(JSON.stringify(createPage.opts.body.themeFields)), { page_heading: '页面默认值' });
});

test('主题字段 schema 加载失败时保留核心编辑器并允许不带主题字段保存', async () => {
  const { sandbox, elements, apiCalls } = await createAdminApp({
    errors: { '/admin/editor-fields?type=post': new Error('schema unavailable') },
  });
  await sandbox.openPostEditor('post', null);
  const html = elements.get('content').innerHTML;
  assert.match(html, /主题字段加载失败/);
  assert.ok(html.includes('id="pe-title"'));
  assert.ok(html.includes('id="pe-content"'));
  assert.equal(elements.has('pe-theme-field-subtitle'), false);

  elements.get('pe-title').value = '仍可写作';
  sandbox.navigate = () => {};
  await sandbox.savePost('post', null);
  const create = apiCalls.find(call => call.path === '/admin/posts' && call.opts.method === 'POST');
  assert.ok(create);
  assert.equal(Object.hasOwn(create.opts.body, 'themeFields'), false);
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

test('标签编辑按钮保留名称中的引号和反斜杠，并保存修改', async () => {
  const name = 'Reader\'s "notes" \\ archive';
  let promptDefault;
  const { sandbox, elements, ctx, apiCalls } = await createAdminApp({
    prompt: (_message, value) => { promptDefault = value; return 'Renamed notes'; },
    responses: {
      '/admin/tags?pageSize=100&page=1': { items: [{ id: 'tag-1', name, slug: 'notes' }], meta: {} },
    },
  });
  await sandbox.renderTags();
  const onclick = [...elements.get('content').innerHTML.matchAll(/onclick="([^"]*)"/g)]
    .map(match => decodeEntities(match[1])).find(code => code.startsWith('openTagEditor('));
  assert.ok(onclick, '缺少标签编辑按钮');
  vm.runInContext(onclick, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(promptDefault, name);
  const update = apiCalls.find(call => call.path === '/admin/tags/tag-1' && call.opts.method === 'PUT');
  assert.equal(update?.opts.body.name, 'Renamed notes');
});

test('后台分页只渲染当前页附近的有限页码', async () => {
  const { internals } = await createAdminApp();
  const html = internals.paginate({ page: 5000, totalPages: 10000, hasPrev: true, hasNext: true });
  const labels = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['←', '1', '4998', '4999', '5000', '5001', '5002', '10000', '→']);
  assert.ok(Buffer.byteLength(html) < 2000);
});

test('用户编辑器通过单条接口加载，不依赖前 100 条用户列表', async () => {
  const { sandbox, elements, apiCalls } = await createAdminApp();
  await sandbox.openUserEditor('user-late');
  assert.ok(apiCalls.some(call => call.path === '/admin/users/user-late'));
  assert.ok(!apiCalls.some(call => call.path.startsWith('/admin/users?pageSize=')));
  assert.equal(elements.get('ue-name').value, 'late');
  assert.match(elements.get('content').innerHTML, /value="author" selected/);
});

test('新建用户默认订阅者角色，且无密码时不发送请求', async () => {
  const { sandbox, elements, apiCalls } = await createAdminApp();
  await sandbox.openUserEditor();
  assert.match(elements.get('content').innerHTML, /value="subscriber" selected/);
  elements.get('ue-name').value = 'reader';
  elements.get('ue-nick').value = 'Reader';
  elements.get('ue-email').value = 'reader@example.test';
  await sandbox.saveUser(null);
  assert.equal(apiCalls.some(call => call.path === '/admin/users' && call.opts.method === 'POST'), false);
});

test('插件菜单刷新后可以删除已停用插件的入口', async () => {
  const menus = [{ id: 'announcement', plugin: 'announcement', title: '公告栏', page: 'plugin-settings:announcement' }];
  const { sandbox, elements, apiCalls } = await createAdminApp({
    responses: { '/admin/plugin-menus': menus },
  });
  const box = new (elements.get('content').constructor)('div');
  box.id = 'plugin-menus';
  const section = new (elements.get('content').constructor)('div');
  section.id = 'plugin-menu-section';
  elements.set('plugin-menus', box);
  elements.set('plugin-menu-section', section);

  await sandbox.__editorInternals.loadPluginMenus();
  assert.match(box.innerHTML, /公告栏/);
  assert.equal(section.style.display, '');
  menus.length = 0;
  await sandbox.__editorInternals.loadPluginMenus();
  assert.equal(box.innerHTML, '');
  assert.equal(section.style.display, 'none');
  assert.ok(apiCalls.some(call => call.path === '/admin/plugin-menus'));
});

test('editor bridge scopes plugin fields and supports content and lifecycle operations', async () => {
  const { internals } = await createAdminApp();
  const textarea = {
    value: '正文',
    selectionStart: 1,
    selectionEnd: 1,
    focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  const calls = [];
  const bridge = internals.createEditorBridge({
    post: { pluginFields: { 'image-tools': { credit: '旧来源' } } },
    type: 'post',
    pluginDir: 'image-tools',
    fieldSchema: [{ key: 'credit', type: 'text', default: '' }],
    textarea,
    request: async (method, path, options) => { calls.push([method, path, options]); return { ok: true }; },
  });
  assert.equal(bridge.getContent(), '正文');
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.getPluginFields())), { credit: '旧来源' });
  bridge.insertText('AB');
  assert.equal(textarea.value, '正AB文');
  textarea.setSelectionRange(1, 3);
  bridge.replaceSelection('替换');
  assert.equal(textarea.value, '正替换文');
  bridge.setPluginField('credit', '新来源');
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.getPluginFields())), { credit: '新来源' });
  assert.throws(() => bridge.setPluginField('unknown', 'x'), /字段/);
  assert.throws(() => bridge.on('unsupported:event', () => {}), /事件/);
  let changed = 0;
  bridge.on('content:change', () => { changed++; });
  bridge.insertText('!');
  assert.equal(changed, 1);
  assert.equal(typeof bridge.request, 'function');
  await bridge.request('GET', '/admin/ping');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['GET', '/admin/ping', {}]]);
});

test('editor bridge runs save hooks in order and emits after only on success', async () => {
  const { internals } = await createAdminApp();
  const textarea = { value: '初始', selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange() {} };
  const bridge = internals.createEditorBridge({
    post: { pluginFields: {} }, type: 'post', pluginDir: 'image-tools',
    fieldSchema: [], textarea,
  });
  const order = [];
  bridge.on('save:before', ({ content }) => { order.push('first:' + content); return { content: content + ' A' }; });
  bridge.on('save:before', ({ content }) => { order.push('second:' + content); return { content: content + ' B' }; });
  bridge.on('save:after', ({ content }) => order.push('after:' + content));
  const transformed = await bridge.runSaveBefore();
  assert.equal(transformed.content, '初始 A B');
  bridge.emitSaveAfter({ content: transformed.content });
  assert.deepEqual(order, ['first:初始', 'second:初始 A', 'after:初始 A B']);
  const failing = internals.createEditorBridge({
    post: { pluginFields: {} }, type: 'post', pluginDir: 'image-tools',
    fieldSchema: [], textarea: { value: 'x', selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange() {} },
  });
  failing.on('save:before', () => { throw new Error('stop'); });
  await assert.rejects(() => failing.runSaveBefore(), /stop/);
});

test('plugin editor fields and actions render separately and persist with content saves', async () => {
  const { sandbox, elements, apiCalls } = await createAdminApp({
    responses: {
      '/admin/editor-extensions?type=post': {
        extensions: [{
          plugin: 'image-tools',
          fields: [{ key: 'credit', label: '图片来源', type: 'text', for: ['post'], default: '未知' }],
          actions: [{ id: 'insert-image', label: '插入图片', placement: 'toolbar', for: ['post'] }],
          modules: [],
        }],
      },
      '/admin/editor-fields?type=post': { themeId: 'fixture', fields: [] },
      '/admin/posts/post-1': {
        id: 'post-1', title: '已有文章', slug: 'existing-post', content: '旧内容', excerpt: '',
        status: 'published', tags: [], themeFields: {},
        pluginFields: { 'image-tools': { credit: '已有来源' } },
      },
    },
  });
  await sandbox.openPostEditor('post', 'post-1');
  const html = elements.get('content').innerHTML;
  assert.ok(html.includes('id="pe-plugin-field-image-tools-credit"'));
  assert.ok(html.includes('id="pe-plugin-actions-image-tools"'));
  assert.equal(elements.get('pe-plugin-field-image-tools-credit').value, '已有来源');
  elements.get('pe-plugin-field-image-tools-credit').value = '新来源';
  sandbox.navigate = () => {};
  await sandbox.savePost('post', 'post-1');
  const update = apiCalls.find(call => call.path === '/admin/posts/post-1' && call.opts.method === 'PUT');
  assert.deepEqual(JSON.parse(JSON.stringify(update.opts.body.pluginFields)), { 'image-tools': { credit: '新来源' } });
});

test('slot mounts are isolated and extension failures do not reject editor loading', async () => {
  const { internals, elements } = await createAdminApp();
  const Element = elements.get('content').constructor;
  const root = new Element('div');
  const slots = internals.createEditorSlots(root);
  assert.ok(slots.toolbar && slots.sidebar);
  const mounted = slots.sidebar.mount(container => { container.textContent = 'plugin panel'; });
  assert.equal(typeof mounted.unmount, 'function');
  mounted.unmount();
  const result = await internals.loadEditorExtensions({
    extensions: [{
      plugin: 'broken-tools',
      fields: [], actions: [],
      modules: [{ id: 'broken', entry: '/missing.js', styles: [], slots: ['sidebar'], apiVersion: 1 }],
    }],
  }, {
    editor: {}, slots,
    request: async () => { throw new Error('module unavailable'); },
  });
  assert.equal(result.errors.length, 1);
});
