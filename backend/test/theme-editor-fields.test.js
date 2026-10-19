import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeThemeEditorFields,
  normalizeEditorFieldSchema,
  readThemeEditorFields,
} from '../lib/theme-editor-fields.js';

test('normalizes supported field types and filters declarations by content type', () => {
  const manifest = {
    editorFields: [
      { key: 'subtitle', label: '副标题', type: 'text', for: 'post' },
      { key: 'body_note', label: '页面备注', type: 'textarea', for: 'page', default: '说明' },
      { key: 'reading_minutes', label: '阅读分钟', type: 'number', default: '3' },
      { key: 'show_toc', label: '显示目录', type: 'checkbox', default: 'true' },
      {
        key: 'hero_variant', label: '页面样式', type: 'select', for: 'page', default: 'wide',
        options: [{ value: 'standard', label: '标准' }, { value: 'wide', label: '宽屏' }],
      },
      { key: 'source_url', label: '来源链接', type: 'url', default: 'https://example.test/source' },
    ],
  };

  assert.deepEqual(normalizeEditorFieldSchema(manifest, 'post'), [
    { key: 'subtitle', label: '副标题', type: 'text', for: 'post', group: '', default: '', description: '' },
    { key: 'reading_minutes', label: '阅读分钟', type: 'number', for: 'both', group: '', default: 3, description: '' },
    { key: 'show_toc', label: '显示目录', type: 'checkbox', for: 'both', group: '', default: true, description: '' },
    { key: 'source_url', label: '来源链接', type: 'url', for: 'both', group: '', default: 'https://example.test/source', description: '' },
  ]);
  assert.deepEqual(normalizeEditorFieldSchema(manifest, 'page'), [
    { key: 'body_note', label: '页面备注', type: 'textarea', for: 'page', group: '', default: '说明', description: '' },
    {
      key: 'reading_minutes', label: '阅读分钟', type: 'number', for: 'both', group: '', default: 3, description: '',
    },
    { key: 'show_toc', label: '显示目录', type: 'checkbox', for: 'both', group: '', default: true, description: '' },
    {
      key: 'hero_variant', label: '页面样式', type: 'select', for: 'page', group: '', default: 'wide',
      description: '', options: [{ value: 'standard', label: '标准' }, { value: 'wide', label: '宽屏' }],
    },
    { key: 'source_url', label: '来源链接', type: 'url', for: 'both', group: '', default: 'https://example.test/source', description: '' },
  ]);
});

test('rejects malformed, duplicate, unsafe, and unsupported editor field declarations', () => {
  const invalidManifests = [
    { editorFields: [{ key: 'bad.key', label: 'Bad', type: 'text' }] },
    { editorFields: [{ key: 'same', label: 'One', type: 'text' }, { key: 'same', label: 'Two', type: 'text' }] },
    { editorFields: [{ key: '__proto__', label: 'Unsafe', type: 'text' }] },
    { editorFields: [{ key: 'custom_html', label: 'HTML', type: 'html' }] },
    { editorFields: [{ key: 'choice', label: 'Choice', type: 'select' }] },
    { editorFields: [{ key: 'choice', label: 'Choice', type: 'select', options: [] }] },
    { editorFields: [{ key: 'choice', label: 'Choice', type: 'select', options: [{ value: '', label: 'Empty' }] }] },
    { editorFields: [{ key: 'choice', label: 'Choice', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'Again' }] }] },
    { editorFields: [{ key: 'choice', label: 'Choice', type: 'select', options: [{ value: 'a', label: {} }] }] },
    { editorFields: [{ key: 'choice', label: 'Choice', type: 'select', default: 'b', options: [{ value: 'a', label: 'A' }] }] },
    { editorFields: [{ key: 'flag', label: 'Flag', type: 'checkbox', default: 'maybe' }] },
    { editorFields: [{ key: 'count', label: 'Count', type: 'number', default: 'NaN' }] },
    { editorFields: [{ key: 'title', label: 'Title', type: 'text', for: 'comment' }] },
  ];

  for (const manifest of invalidManifests) {
    assert.throws(() => normalizeEditorFieldSchema(manifest, 'post'), undefined, JSON.stringify(manifest));
  }
});

test('normalizes declared select and checkbox defaults while rejecting unsupported content types', () => {
  const fields = normalizeEditorFieldSchema({
    editorFields: [
      { key: 'enabled', label: 'Enabled', type: 'checkbox', default: 1 },
      { key: 'layout', label: 'Layout', type: 'select', options: [{ value: 'wide', label: 'Wide' }] },
    ],
  }, 'post');

  assert.equal(fields[0].default, true);
  assert.equal(fields[1].default, 'wide');
  assert.throws(() => normalizeEditorFieldSchema({}, 'comment'), /content type|内容类型/i);
});

test('reads only declared values from JSON or object storage and fills normalized defaults', () => {
  const schema = normalizeEditorFieldSchema({
    editorFields: [
      { key: 'title_note', label: '标题说明', type: 'text', default: '默认值' },
      { key: 'show_toc', label: '显示目录', type: 'checkbox', default: true },
      { key: 'layout', label: '布局', type: 'select', options: [{ value: 'wide', label: '宽' }, { value: 'normal', label: '常规' }] },
    ],
  }, 'post');
  const stored = {
    legacy: 'keep private to the generic fields contract',
    _lillThemeFields: {
      current: { title_note: '已保存', show_toc: false, unknown: 'must not project', layout: 'invalid' },
      other: { title_note: 'other theme' },
    },
  };

  assert.deepEqual(readThemeEditorFields(JSON.stringify(stored), 'current', schema), {
    title_note: '已保存', show_toc: false, layout: 'wide',
  });
  assert.deepEqual(readThemeEditorFields(stored, 'missing', schema), {
    title_note: '默认值', show_toc: true, layout: 'wide',
  });
});

test('merges one theme namespace without mutating generic or other-theme values', () => {
  const schema = normalizeEditorFieldSchema({
    editorFields: [
      { key: 'subtitle', label: '副标题', type: 'text', default: '' },
      { key: 'visible', label: '显示', type: 'checkbox', default: false },
    ],
  }, 'post');
  const stored = {
    legacy: { value: 1 },
    _lillThemeFields: {
      current: { subtitle: 'old', retired: 'retain for a later theme version' },
      other: { subtitle: 'untouched' },
    },
  };

  const merged = mergeThemeEditorFields(stored, 'current', { subtitle: 'new', visible: true }, schema);
  assert.deepEqual(merged, {
    legacy: { value: 1 },
    _lillThemeFields: {
      current: { subtitle: 'new', retired: 'retain for a later theme version', visible: true },
      other: { subtitle: 'untouched' },
    },
  });
  assert.deepEqual(stored._lillThemeFields.current, { subtitle: 'old', retired: 'retain for a later theme version' });
});

test('rejects unknown keys, invalid field values, and non-object theme field submissions', () => {
  const schema = normalizeEditorFieldSchema({
    editorFields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'count', label: 'Count', type: 'number' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox' },
      { key: 'url', label: 'URL', type: 'url' },
      { key: 'layout', label: 'Layout', type: 'select', options: [{ value: 'wide', label: 'Wide' }] },
    ],
  }, 'post');
  const invalidSubmissions = [
    { unknown: 'value' },
    { title: 42 },
    { count: '4' },
    { enabled: 'true' },
    { url: 'javascript:alert(1)' },
    { layout: 'compact' },
    null,
    [],
    'not an object',
  ];

  for (const submission of invalidSubmissions) {
    assert.throws(() => mergeThemeEditorFields({}, 'current', submission, schema), undefined, JSON.stringify(submission));
  }
});

test('rejects invalid stored theme identifiers before creating an unsafe namespace', () => {
  assert.throws(() => mergeThemeEditorFields({}, '__proto__', {}, []));
});
