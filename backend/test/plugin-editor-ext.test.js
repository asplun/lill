import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEditorRegistry,
  normalizeEditorAction,
  normalizeEditorExtension,
  normalizeEditorField,
} from '../lib/plugin-editor-ext.js';
import { createPluginContext } from '../lib/plugin-ext.js';

const validField = {
  key: 'image_credit',
  label: '图片来源',
  type: 'text',
  for: 'post',
  group: '图片信息',
  default: '未知',
  description: '可选来源',
};

test('normalizes an editor field with plugin ownership and content scope', () => {
  assert.deepEqual(normalizeEditorField(validField, 'image-tools'), {
    plugin: 'image-tools',
    key: 'image_credit',
    label: '图片来源',
    type: 'text',
    for: ['post'],
    group: '图片信息',
    default: '未知',
    description: '可选来源',
  });
});

test('rejects malformed editor field declarations', () => {
  assert.throws(() => normalizeEditorField({ ...validField, key: '__proto__' }, 'image-tools'), /key 无效/);
  assert.throws(() => normalizeEditorField({ ...validField, type: 'html' }, 'image-tools'), /type 不受支持/);
  assert.throws(() => normalizeEditorField({ ...validField, for: 'comment' }, 'image-tools'), /for 无效/);
  assert.throws(() => normalizeEditorField({ ...validField, label: '' }, 'image-tools'), /label/);
  assert.throws(() => normalizeEditorField({
    ...validField, type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: '重复' }],
  }, 'image-tools'), /选项值重复/);
});

test('normalizes actions without exposing executable handlers in public metadata', () => {
  const handler = async () => ({ insertText: '![image](url)' });
  const normalized = normalizeEditorAction({
    id: 'insert-image',
    label: '插入图片',
    placement: 'toolbar',
    for: ['post'],
    handler,
  }, 'image-tools');
  assert.equal(normalized.plugin, 'image-tools');
  assert.equal(normalized.handler, handler);
  assert.deepEqual(normalized.public, {
    id: 'insert-image',
    label: '插入图片',
    placement: 'toolbar',
    for: ['post'],
  });
});

test('normalizes extensions and rejects unsafe assets or slots', () => {
  assert.deepEqual(normalizeEditorExtension({
    id: 'image-tools',
    entry: 'editor/index.js',
    styles: ['editor/styles.css'],
    for: ['post'],
    slots: ['toolbar', 'sidebar'],
    apiVersion: 1,
  }, 'image-tools'), {
    plugin: 'image-tools',
    id: 'image-tools',
    entry: 'editor/index.js',
    styles: ['editor/styles.css'],
    for: ['post'],
    slots: ['toolbar', 'sidebar'],
    apiVersion: 1,
    public: {
      id: 'image-tools',
      entry: 'editor/index.js',
      styles: ['editor/styles.css'],
      for: ['post'],
      slots: ['toolbar', 'sidebar'],
      apiVersion: 1,
    },
  });
  assert.throws(() => normalizeEditorExtension({
    id: 'bad', entry: '../index.js', slots: ['toolbar'], apiVersion: 1,
  }, 'image-tools'), /entry/);
  assert.throws(() => normalizeEditorExtension({
    id: 'bad', entry: 'editor/index.js', slots: ['content'], apiVersion: 1,
  }, 'image-tools'), /slot/);
  assert.throws(() => normalizeEditorExtension({
    id: 'bad', entry: 'editor/index.js', styles: ['editor/theme.scss'], slots: ['toolbar'], apiVersion: 1,
  }, 'image-tools'), /styles/);
});

test('registry isolates plugins, rejects duplicate ids, and cleans registrations idempotently', () => {
  const registry = createEditorRegistry();
  const removeField = registry.registerField(validField, 'image-tools');
  registry.registerField({ ...validField, key: 'image_credit' }, 'other-tools');
  assert.equal(registry.fieldsFor('post').length, 2);
  assert.throws(() => registry.registerField(validField, 'image-tools'), /重复/);

  const removeAction = registry.registerAction({
    id: 'insert-image', label: '插入图片', placement: 'toolbar', for: ['post'], handler: () => ({ insertText: 'x' }),
  }, 'image-tools');
  registry.registerExtension({
    id: 'image-tools', entry: 'editor/index.js', styles: [], for: ['post'], slots: ['sidebar'], apiVersion: 1,
  }, 'image-tools');
  assert.equal(registry.actionsFor('post')[0].public.id, 'insert-image');
  assert.equal(registry.extensionsFor('post')[0].public.id, 'image-tools');

  assert.equal(removeField(), true);
  assert.equal(removeField(), false);
  assert.equal(removeAction(), true);
  registry.clearPlugin('image-tools');
  assert.equal(registry.extensionsFor('post').length, 0);
  assert.equal(registry.actionsFor('post').length, 0);
  assert.equal(registry.fieldsFor('post').length, 1);
});

test('plugin context exposes editor registration methods and cleanup removes all three kinds', () => {
  const registry = createEditorRegistry();
  const core = {
    _hooks: new Map(),
    _adminMenus: [],
    _editorRegistry: registry,
    PLUGINS_DIR: '/tmp/plugins',
    route() {},
  };
  const context = createPluginContext(core, 'image-tools');
  context.registerEditorField(validField);
  context.registerEditorAction({
    id: 'insert-image', label: '插入图片', placement: 'toolbar', for: ['post'], handler: () => ({ insertText: 'x' }),
  });
  context.registerEditorExtension({
    id: 'image-tools', entry: 'editor/index.js', styles: [], for: ['post'], slots: ['toolbar'], apiVersion: 1,
  });
  assert.equal(registry.fieldsFor('post').length, 1);
  assert.equal(registry.actionsFor('post').length, 1);
  assert.equal(registry.extensionsFor('post').length, 1);
  context.__editorRegistrations.cleanup();
  assert.equal(registry.fieldsFor('post').length, 0);
  assert.equal(registry.actionsFor('post').length, 0);
  assert.equal(registry.extensionsFor('post').length, 0);
});
