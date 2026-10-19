import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  createEditorRegistry,
  mergePluginEditorFields,
  readPluginEditorFields,
  validateEditorActionResult,
} from '../lib/plugin-editor-ext.js';
import { startApiServer } from './helpers/api-server.js';

const password = 'plugin-editor-api-test-password';
let api;
let admin;
let sequence = 0;
const headers = session => ({ authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken });
const data = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.payload));
  return response.payload.data;
};

async function preparePlugins(pluginsDir) {
  const dir = join(pluginsDir, 'image-tools');
  await mkdir(join(dir, 'editor'), { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify({
    name: 'Image tools', version: '1.0.0',
  }));
  await writeFile(join(dir, 'editor', 'styles.css'), '.image-tools { color: red; }');
  const activate = [
    'export function activate(ctx) {',
    "  ctx.registerEditorField({ key: 'credit', label: '来源', type: 'text', for: 'post', default: '未知' });",
    "  ctx.registerEditorField({ key: 'enabled', label: '启用', type: 'checkbox', for: 'post', default: true });",
    "  ctx.registerEditorAction({ id: 'insert-image', label: '插入图片', placement: 'toolbar', for: 'post', handler: async ({ selection }) => ({ insertText: selection ? `![${selection}](https://example.test/image.webp)` : '![图片](https://example.test/image.webp)' }) });",
    "  ctx.registerEditorAction({ id: 'bad-enabled', label: '非法字段值', placement: 'toolbar', for: 'post', handler: async () => ({ setPluginField: { key: 'enabled', value: 'yes' } }) });",
    "  ctx.registerEditorExtension({ id: 'image-tools', entry: 'editor/index.js', styles: ['editor/styles.css'], for: ['post'], slots: ['toolbar', 'sidebar'], apiVersion: 1 });",
    '}',
  ].join('\n');
  await writeFile(join(dir, 'index.js'), activate);
  await writeFile(join(dir, 'editor', 'index.js'), 'export function activate() { return () => {}; }');
}

before(async () => {
  api = await startApiServer({ preparePlugins });
  data(await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Plugin editor API', site_url: 'http://localhost',
    admin_username: 'admin', admin_password: password, admin_email: 'admin@example.test',
  } }));
  admin = data(await api.request('POST', '/api/v1/auth/login', { body: { username: 'admin', password } }));
  data(await api.request('POST', '/api/v1/admin/plugins/toggle', {
    headers: headers(admin), body: { dir: 'image-tools' },
  }));
});

after(async () => {
  await api?.stop();
});

function fixtureRegistry() {
  const registry = createEditorRegistry();
  registry.registerField({
    key: 'credit', label: '来源', type: 'text', for: 'post', default: '未知',
  }, 'image-tools');
  registry.registerField({
    key: 'enabled', label: '启用', type: 'checkbox', for: 'post', default: true,
  }, 'image-tools');
  registry.registerField({
    key: 'caption', label: '说明', type: 'text', for: 'post', default: '',
  }, 'other-tools');
  return registry;
}

test('reads active plugin fields from JSON or objects with declared defaults', () => {
  const registry = fixtureRegistry();
  assert.deepEqual(readPluginEditorFields(JSON.stringify({
    legacy: 'keep',
    _lillPluginFields: {
      'image-tools': { credit: '摄影师', retired: 'opaque' },
      'inactive-tools': { secret: 'hidden' },
    },
  }), registry, 'post'), {
    'image-tools': { credit: '摄影师', enabled: true },
    'other-tools': { caption: '' },
  });
});

test('merges one plugin namespace while preserving generic, theme, other plugin, and unknown values', () => {
  const registry = fixtureRegistry();
  const stored = {
    legacy: { keep: true },
    _lillThemeFields: { solbrin: { subtitle: '主题值' } },
    _lillPluginFields: {
      'image-tools': { credit: '旧值', retired: 'opaque' },
      'other-tools': { caption: '其他插件值' },
    },
  };
  const merged = mergePluginEditorFields(stored, {
    'image-tools': { credit: '新值', enabled: false },
  }, registry, 'post');
  assert.deepEqual(merged, {
    legacy: { keep: true },
    _lillThemeFields: { solbrin: { subtitle: '主题值' } },
    _lillPluginFields: {
      'image-tools': { credit: '新值', enabled: false, retired: 'opaque' },
      'other-tools': { caption: '其他插件值' },
    },
  });
});

test('rejects unknown or invalid plugin fields before storage mutation', () => {
  const registry = fixtureRegistry();
  for (const submitted of [
    { 'image-tools': { unknown: 'x' } },
    { 'image-tools': { credit: 42 } },
    { 'unknown-tools': { credit: 'x' } },
    null,
    [],
  ]) {
    assert.throws(() => mergePluginEditorFields({}, submitted, registry, 'post'), /编辑器插件|插件字段|字段|对象/);
  }
});

test('accepts only one bounded editor action operation', () => {
  assert.deepEqual(validateEditorActionResult({ insertText: '![图](url)' }), { insertText: '![图](url)' });
  assert.deepEqual(validateEditorActionResult({ replaceSelection: '替换内容' }), { replaceSelection: '替换内容' });
  assert.deepEqual(validateEditorActionResult({ setPluginField: { key: 'credit', value: '来源' } }), {
    setPluginField: { key: 'credit', value: '来源' },
  });
  for (const result of [
    {},
    { insertText: 'a', replaceSelection: 'b' },
    { html: '<script>alert(1)</script>' },
    { insertText: 'x'.repeat(50001) },
    { setPluginField: { key: 'credit', value: { html: '<b>x</b>' } } },
  ]) {
    assert.throws(() => validateEditorActionResult(result), /动作结果|操作|长度/);
  }
});

test('active plugin metadata and declared assets are available only to content roles', async () => {
  const manifest = data(await api.request('GET', '/api/v1/admin/editor-extensions?type=post', {
    headers: headers(admin),
  }));
  assert.equal(manifest.extensions.length, 1);
  assert.deepEqual(manifest.extensions[0].fields.map(field => field.key), ['credit', 'enabled']);
  assert.deepEqual(manifest.extensions[0].actions, [
    { id: 'insert-image', label: '插入图片', placement: 'toolbar', for: ['post'] },
    { id: 'bad-enabled', label: '非法字段值', placement: 'toolbar', for: ['post'] },
  ]);
  assert.deepEqual(manifest.extensions[0].modules[0].styles.length, 1);
  assert.match(manifest.extensions[0].modules[0].entry, /editor-assets\/image-tools/);
  assert.equal(Object.hasOwn(manifest.extensions[0].actions[0], 'handler'), false);

  const asset = data(await api.request('GET', '/api/v1/admin/editor-assets/image-tools?path=editor%2Fstyles.css', {
    headers: headers(admin),
  }));
  assert.equal(asset.mime, 'text/css; charset=utf-8');
  assert.match(asset.content, /color: red/);
  const module = data(await api.request('GET', '/api/v1/admin/editor-assets/image-tools?path=editor%2Findex.js', {
    headers: headers(admin),
  }));
  assert.equal(module.mime, 'text/javascript; charset=utf-8');
  assert.match(module.content, /activate/);
  for (const path of ['../plugin.json', '/etc/passwd', 'editor/missing.css', 'plugin.json']) {
    const response = await api.request('GET', `/api/v1/admin/editor-assets/image-tools?path=${encodeURIComponent(path)}`, {
      headers: headers(admin),
    });
    assert.ok([400, 404].includes(response.status), path);
  }
  const unauthenticated = await api.request('GET', '/api/v1/admin/editor-extensions?type=post');
  assert.equal(unauthenticated.status, 401);
});

test('editor action executes with selection context and returns only a safe operation', async () => {
  const action = data(await api.request('POST', '/api/v1/admin/editor-actions/image-tools/insert-image', {
    headers: headers(admin),
    body: { contentType: 'post', selection: '说明文字' },
  }));
  assert.deepEqual(action, { insertText: '![说明文字](https://example.test/image.webp)' });

  for (const body of [
    { contentType: 'page', selection: 'x' },
    { contentType: 'post', selection: 'x'.repeat(50001) },
    { contentType: 'comment', selection: '' },
  ]) {
    const response = await api.request('POST', '/api/v1/admin/editor-actions/image-tools/insert-image', {
      headers: headers(admin), body,
    });
    assert.ok([400, 404].includes(response.status), JSON.stringify(response.payload));
  }
  const invalidField = await api.request('POST', '/api/v1/admin/editor-actions/image-tools/bad-enabled', {
    headers: headers(admin), body: { contentType: 'post', selection: '' },
  });
  assert.equal(invalidField.status, 400);
});

test('plugin fields persist in their own namespace and disappear from projection when disabled', async () => {
  const created = data(await api.request('POST', '/api/v1/admin/posts', {
    headers: headers(admin),
    body: {
      title: `Plugin fields ${++sequence}`,
      content: 'Body',
      fields: { legacy: 'keep' },
      pluginFields: { 'image-tools': { credit: '摄影师', enabled: false } },
    },
  }), 201);
  let detail = data(await api.request('GET', `/api/v1/admin/posts/${created.id}`, { headers: headers(admin) }));
  assert.deepEqual(detail.pluginFields, { 'image-tools': { credit: '摄影师', enabled: false } });
  const raw = JSON.parse(detail.fields);
  assert.deepEqual(raw, {
    legacy: 'keep',
    _lillPluginFields: { 'image-tools': { credit: '摄影师', enabled: false } },
  });

  data(await api.request('PUT', `/api/v1/admin/posts/${created.id}`, {
    headers: headers(admin),
    body: { title: 'Preserve plugin fields' },
  }));
  detail = data(await api.request('GET', `/api/v1/admin/posts/${created.id}`, { headers: headers(admin) }));
  assert.deepEqual(detail.pluginFields, { 'image-tools': { credit: '摄影师', enabled: false } });

  data(await api.request('POST', '/api/v1/admin/plugins/toggle', {
    headers: headers(admin), body: { dir: 'image-tools' },
  }));
  assert.deepEqual(data(await api.request('GET', '/api/v1/admin/editor-extensions?type=post', {
    headers: headers(admin),
  })), { extensions: [] });
  detail = data(await api.request('GET', `/api/v1/admin/posts/${created.id}`, { headers: headers(admin) }));
  assert.deepEqual(detail.pluginFields, {});

  data(await api.request('POST', '/api/v1/admin/plugins/toggle', {
    headers: headers(admin), body: { dir: 'image-tools' },
  }));
  detail = data(await api.request('GET', `/api/v1/admin/posts/${created.id}`, { headers: headers(admin) }));
  assert.deepEqual(detail.pluginFields, { 'image-tools': { credit: '摄影师', enabled: false } });
});
