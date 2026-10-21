import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  activate as activateEditor,
  buildMusicShortcode,
  SHORTCODE_TEMPLATES,
} from '../plugins/trim3-editor/editor/index.js';
import { activate as activatePlugin } from '../plugins/trim3-editor/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.textContent = '';
    this.value = '';
    this.open = false;
    this.classList = {
      add: (...names) => {
        this.className = `${this.className || ''} ${names.join(' ')}`.trim();
      },
    };
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  setAttribute(name, value) {
    this[name] = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  async dispatch(type, event = {}) {
    return Promise.all((this.listeners.get(type) || []).map(handler => handler({
      target: this,
      preventDefault() {},
      ...event,
    })));
  }

  click() {
    return this.dispatch('click');
  }

  showModal() { this.open = true; }
  close() { this.open = false; }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : '';
    const tagName = selector.startsWith('.') ? '' : selector.toUpperCase();
    const results = [];
    const visit = node => {
      for (const child of node.children) {
        if ((className && child.className?.split(/\s+/).includes(className)) ||
            (tagName && child.tagName === tagName)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

function installDom() {
  const created = [];
  const previousDocument = globalThis.document;
  const previousFileReader = globalThis.FileReader;
  const docListeners = new Map();
  globalThis.document = {
    createElement(tagName) {
      const element = new Element(tagName);
      created.push(element);
      return element;
    },
    createTextNode(text) {
      const node = new Element('#text');
      node.textContent = String(text);
      return node;
    },
    addEventListener(type, handler) {
      const list = docListeners.get(type) || [];
      list.push(handler);
      docListeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = docListeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,${file.base64}`;
      queueMicrotask(() => this.onload?.());
    }
  };
  return {
    created,
    async paste(event) {
      return Promise.all((docListeners.get('paste') || []).map(handler => handler({
        preventDefault() { event.defaultPrevented = true; },
        ...event,
      })));
    },
    listenerCount(type) {
      return (docListeners.get(type) || []).length;
    },
    restore() {
      globalThis.document = previousDocument;
      globalThis.FileReader = previousFileReader;
    },
  };
}

test('Trim3 editor plugin registers a self-contained post and page toolbar extension', async () => {
  const registrations = [];
  await activatePlugin({
    registerEditorExtension(extension) {
      registrations.push(extension);
    },
  });

  assert.deepEqual(registrations, [{
    id: 'trim3-image-upload',
    entry: 'editor/index.js',
    styles: ['editor/styles.css'],
    for: ['post', 'page'],
    slots: ['toolbar'],
    apiVersion: 1,
  }]);

  const manifest = JSON.parse(await readFile(join(ROOT, 'plugins/trim3-editor/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'Trim3 编辑器工具');
});

test('multi-image upload uses the active Trim3 image host and isolates per-file failures', async () => {
  const dom = installDom();
  const root = new Element('div');
  const requests = [];
  const inserted = [];
  let unmounted = false;
  const editor = {
    async request(method, path, options) {
      requests.push({ method, path, options });
      if (options.body.name === 'broken.png') throw new Error('图床拒绝上传');
      return { url: `/uploads/${options.body.name}` };
    },
    insertText(value) {
      inserted.push(value);
    },
  };
  const slots = {
    toolbar: {
      mount(render) {
        render(root);
        return { unmount: () => { unmounted = true; } };
      },
    },
  };

  try {
    const cleanup = activateEditor({ editor, slots });
    const uploadButton = root.querySelectorAll('.trim3-editor-upload')[0];
    await uploadButton.click();
    const picker = dom.created.find(element => element.tagName === 'INPUT' && element.type === 'file');
    picker.files = [
      { name: 'first.png', type: 'image/png', base64: 'Zmlyc3Q=' },
      { name: 'broken.png', type: 'image/png', base64: 'YnJva2Vu' },
      { name: 'last.jpg', type: 'image/jpeg', base64: 'bGFzdA==' },
    ];
    await picker.dispatch('change');

    assert.deepEqual(requests.map(item => [item.method, item.path]), [
      ['POST', '/upload'],
      ['POST', '/upload'],
      ['POST', '/upload'],
    ]);
    assert.equal(requests[0].options.body.data, 'Zmlyc3Q=');
    assert.equal(requests[0].options.body.mime, 'image/png');
    assert.equal(requests[0].options.timeout, 120000);
    const previews = root.querySelectorAll('.trim3-editor-image');
    assert.equal(previews.length, 3);
    assert.match(previews[1].textContent, /broken\.png.*图床拒绝上传/);
    assert.equal(previews[2].querySelectorAll('img').length, 1);

    await previews[0].click();
    assert.deepEqual(inserted, ['![](/uploads/first.png)']);
    const remove = root.querySelectorAll('.trim3-editor-remove')[0];
    await remove.click();
    assert.equal(root.querySelectorAll('.trim3-editor-image').length, 2);
    cleanup();
    assert.equal(unmounted, true);
  } finally {
    dom.restore();
  }
});

test('pasting an image into the markdown editor uploads it and inserts markdown at the caret', async () => {
  const dom = installDom();
  const root = new Element('div');
  const requests = [];
  const inserted = [];
  const content = '正文第一行\n第二行';
  const editor = {
    getContent: () => content,
    insertText: value => inserted.push(value),
    async request(method, path, options) {
      requests.push({ method, path, options });
      return { url: '/uploads/2026-snipaste.png' };
    },
  };
  const slots = { toolbar: { mount(render) { render(root); return { unmount() {} }; } } };

  try {
    const cleanup = activateEditor({ editor, slots });
    assert.equal(dom.listenerCount('paste'), 1);
    const textarea = new Element('textarea');
    textarea.value = content;
    textarea.selectionStart = 4;
    const pasted = { name: 'Snipaste.png', type: 'image/png', base64: 'c25pcA==' };
    const event = {
      target: textarea,
      defaultPrevented: false,
      clipboardData: { items: [{ type: 'image/png', getAsFile: () => pasted }] },
    };
    await dom.paste(event);

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(requests.map(item => [item.method, item.path]), [['POST', '/upload']]);
    assert.equal(requests[0].options.body.name, 'Snipaste.png');
    assert.equal(requests[0].options.body.mime, 'image/png');
    assert.equal(requests[0].options.body.data, 'c25pcA==');
    // 光标不在行首时按原主题补换行，再落 ![](url)
    assert.deepEqual(inserted, ['\n![Snipaste.png](/uploads/2026-snipaste.png)\n']);
    cleanup();
    assert.equal(dom.listenerCount('paste'), 0);
  } finally {
    dom.restore();
  }
});

test('paste stays out of the way for plain text and for textareas other than the editor', async () => {
  const dom = installDom();
  const root = new Element('div');
  const requests = [];
  const inserted = [];
  const content = '正文';
  const editor = {
    getContent: () => content,
    insertText: value => inserted.push(value),
    async request(method, path, options) {
      requests.push({ method, path, options });
      return { url: '/uploads/should-not-happen.png' };
    },
  };
  const slots = { toolbar: { mount(render) { render(root); return { unmount() {} }; } } };

  try {
    const cleanup = activateEditor({ editor, slots });
    const imageItem = { type: 'image/png', getAsFile: () => ({ name: 'x.png', type: 'image/png', base64: 'eA==' }) };
    const excerpt = new Element('textarea');
    excerpt.value = '摘要文本框';
    await dom.paste({ target: excerpt, defaultPrevented: false, clipboardData: { items: [imageItem] } });
    await dom.paste({ target: new Element('textarea'), defaultPrevented: false, clipboardData: { items: [{ type: 'text/plain' }] } });
    await dom.paste({ target: new Element('input'), defaultPrevented: false, clipboardData: { items: [imageItem] } });

    assert.deepEqual(requests, []);
    assert.deepEqual(inserted, []);
    cleanup();
  } finally {
    dom.restore();
  }
});

test('editor exposes Typecho Joe shortcode tools through the plugin toolbar slot', async () => {
  const dom = installDom();
  const root = new Element('div');
  const inserted = [];
  const editor = { insertText: value => inserted.push(value) };
  const slots = {
    toolbar: { mount(render) { render(root); return { unmount() {} }; } },
  };

  try {
    const cleanup = activateEditor({ editor, slots });
    const timeline = root.querySelectorAll('.trim3-editor-insert')
      .find(button => button.dataset.template === 'timeline');
    assert.ok(timeline, 'the original timeline tool is available in the shortcode panel');
    await timeline.click();
    assert.match(inserted[0], /^\{timeline\}[\s\S]*\{\/timeline\}\n\n$/);
    assert.deepEqual(SHORTCODE_TEMPLATES.map(template => template.id), [
      'mtitle', 'lamp', 'check-done', 'check-empty', 'dotted',
      'mp3', 'dplayer', 'bilibili', 'abtn', 'anote', 'cloud',
      'message', 'progress', 'copy', 'hide', 'alert', 'callout',
      'card-default', 'card-describe', 'tabs', 'collapse', 'timeline',
      'card-list', 'gird',
    ]);
    assert.equal(root.querySelectorAll('.trim3-editor-music-open').length, 2);
    cleanup();
  } finally {
    dom.restore();
  }
});

test('music and playlist tools generate valid Joe shortcodes with selectable Meting sources', async () => {
  assert.equal(
    buildMusicShortcode({ kind: 'music', server: 'qq', id: '12345', color: '#123456', autoplay: false }),
    '{music server="qq" id="12345" color="#123456"/}\n\n',
  );
  assert.equal(
    buildMusicShortcode({ kind: 'music-list', server: 'netease', id: '67890', color: '#1989fa', autoplay: true }),
    '{music-list server="netease" id="67890" color="#1989fa" autoplay="autoplay"/}\n\n',
  );
  assert.throws(() => buildMusicShortcode({ id: '"/><script>' }), /有效的歌曲或歌单 ID/);
});

test('music toolbar dialog inserts the chosen platform and playlist type at the selection', async () => {
  const dom = installDom();
  const root = new Element('div');
  const inserted = [];
  const slots = { toolbar: { mount(render) { render(root); return { unmount() {} }; } } };
  try {
    activateEditor({ editor: { insertText: value => inserted.push(value) }, slots });
    const playlist = root.querySelectorAll('.trim3-editor-music-open')
      .find(button => button.dataset.kind === 'music-list');
    await playlist.click();
    const dialog = root.querySelectorAll('.trim3-editor-music-dialog')[0];
    assert.equal(dialog.open, true);
    root.querySelectorAll('.trim3-editor-music-server')[0].value = 'qq';
    root.querySelectorAll('.trim3-editor-music-id')[0].value = '98765';
    root.querySelectorAll('.trim3-editor-music-color')[0].value = '#654321';
    root.querySelectorAll('.trim3-editor-music-autoplay')[0].checked = false;
    await root.querySelectorAll('form')[0].dispatch('submit');
    assert.deepEqual(inserted, ['{music-list server="qq" id="98765" color="#654321"/}\n\n']);
    assert.equal(dialog.open, false);
  } finally {
    dom.restore();
  }
});
