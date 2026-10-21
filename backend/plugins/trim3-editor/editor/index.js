function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function createPreview(fileName) {
  const item = document.createElement('span');
  item.className = 'trim3-editor-image-item';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'trim3-editor-image';
  button.title = fileName;
  button.setAttribute('aria-label', '插入 ' + fileName);
  const image = document.createElement('img');
  image.alt = fileName;
  image.loading = 'lazy';
  button.appendChild(image);
  item.appendChild(button);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'trim3-editor-remove';
  remove.textContent = '×';
  remove.title = '移除图片';
  remove.setAttribute('aria-label', '移除 ' + fileName);
  item.appendChild(remove);
  return { item, button, image, remove };
}

export const SHORTCODE_TEMPLATES = Object.freeze([
  { id: 'mtitle', label: '居中标题', group: '装饰', text: '{mtitle title="居中标题"/}\n\n' },
  { id: 'lamp', label: '跑马灯', group: '装饰', text: '{lamp/}\n\n' },
  { id: 'check-done', label: '已完成复选框', group: '装饰', text: '{x} ' },
  { id: 'check-empty', label: '未完成复选框', group: '装饰', text: '{ } ' },
  { id: 'dotted', label: '彩色虚线', group: '装饰', text: '{dotted startColor="#ff6c6c" endColor="#1989fa"/}\n\n' },
  { id: 'mp3', label: '外部音频', group: '媒体', text: '{mp3 name="音频名称" url="https://example.com/audio.mp3" cover="https://example.com/cover.jpg"/}\n\n' },
  { id: 'dplayer', label: 'M3U8 / MP4 视频', group: '媒体', text: '{dplayer src="https://example.com/video.mp4"/}\n\n' },
  { id: 'bilibili', label: '哔哩哔哩视频', group: '媒体', text: '{bilibili bvid="BVxxxxxxxxxx" page="1"/}\n\n' },
  { id: 'abtn', label: '多彩按钮', group: '按钮与下载', text: '{abtn icon="ri-download-2-fill" color="#ff6800" href="https://example.com" radius="17.5px" content="立即下载"/}\n\n' },
  { id: 'anote', label: '便条按钮', group: '按钮与下载', text: '{anote icon="ri-link" href="https://example.com" type="info" content="打开链接"/}\n\n' },
  { id: 'cloud', label: '网盘下载', group: '按钮与下载', text: '{cloud title="文件名称" type="default" url="https://example.com" password=""/}\n\n' },
  { id: 'message', label: '消息提示', group: '内容组件', text: '{message type="info" content="消息内容"/}\n\n' },
  { id: 'progress', label: '进度条', group: '内容组件', text: '{progress percentage="50%" color="#ff6c6c"/}\n\n' },
  { id: 'copy', label: '复制文本', group: '内容组件', text: '{copy showText="点击复制" copyText="要复制的内容"/}\n\n' },
  { id: 'hide', label: '回复可见', group: '内容组件', text: '{hide}\n此内容需登录或评论后查看\n{/hide}\n\n' },
  { id: 'alert', label: '提示框', group: '内容组件', text: '{alert type="info"}\n提示内容\n{/alert}\n\n' },
  { id: 'callout', label: '标注卡片', group: '内容组件', text: '{callout color="#f0ad4e"}\n标注内容\n{/callout}\n\n' },
  { id: 'card-default', label: '默认卡片', group: '内容组件', text: '{card-default label="卡片标题" width="100%"}\n卡片内容\n{/card-default}\n\n' },
  { id: 'card-describe', label: '描述卡片', group: '内容组件', text: '{card-describe title="卡片标题"}\n卡片内容\n{/card-describe}\n\n' },
  { id: 'tabs', label: '标签页', group: '布局组件', text: '{tabs}\n{tabs-pane label="标签一"}\n标签一内容\n{/tabs-pane}\n{tabs-pane label="标签二"}\n标签二内容\n{/tabs-pane}\n{/tabs}\n\n' },
  { id: 'collapse', label: '折叠面板', group: '布局组件', text: '{collapse}\n{collapse-item title="折叠标题一"}\n折叠内容一\n{/collapse-item}\n{collapse-item title="折叠标题二"}\n折叠内容二\n{/collapse-item}\n{/collapse}\n\n' },
  { id: 'timeline', label: '时间轴', group: '布局组件', text: '{timeline}\n{timeline-item color="#19be6b"}\n时间节点一\n{/timeline-item}\n{timeline-item color="#ed4014"}\n时间节点二\n{/timeline-item}\n{/timeline}\n\n' },
  { id: 'card-list', label: '卡片列表', group: '布局组件', text: '{card-list}\n{card-list-item}\n列表内容一\n{/card-list-item}\n{card-list-item}\n列表内容二\n{/card-list-item}\n{/card-list}\n\n' },
  { id: 'gird', label: '多列宫格', group: '布局组件', text: '{gird column="2" gap="15"}\n{gird-item}\n第一列内容\n{/gird-item}\n{gird-item}\n第二列内容\n{/gird-item}\n{/gird}\n\n' },
]);

export function buildMusicShortcode({ kind = 'music', server = 'netease', id, color = '#1989fa', autoplay = true } = {}) {
  const trackId = String(id || '').trim();
  if (!/^[a-z\d_-]+$/i.test(trackId)) throw new Error('请输入有效的歌曲或歌单 ID');
  const tag = kind === 'music-list' ? 'music-list' : 'music';
  const source = server === 'qq' ? 'qq' : 'netease';
  const themeColor = /^#[\da-f]{6}$/i.test(String(color)) ? String(color) : '#1989fa';
  const autoplayAttr = autoplay ? ' autoplay="autoplay"' : '';
  return `{${tag} server="${source}" id="${trackId}" color="${themeColor}"${autoplayAttr}/}\n\n`;
}

function createMusicDialog(onInsert) {
  const dialog = document.createElement('dialog');
  dialog.className = 'trim3-editor-music-dialog';
  dialog.setAttribute('aria-labelledby', 'trim3-editor-music-title');
  const form = document.createElement('form');
  form.className = 'trim3-editor-music-form';
  const title = document.createElement('h3');
  title.id = 'trim3-editor-music-title';
  title.textContent = '插入音乐';
  form.appendChild(title);

  const serverLabel = document.createElement('label');
  serverLabel.textContent = '音乐平台';
  const server = document.createElement('select');
  server.className = 'trim3-editor-music-server';
  for (const [value, label] of [['netease', '网易云音乐'], ['qq', 'QQ 音乐']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    server.appendChild(option);
  }
  serverLabel.appendChild(server);
  form.appendChild(serverLabel);

  const idLabel = document.createElement('label');
  idLabel.textContent = '歌曲 / 歌单 ID';
  const id = document.createElement('input');
  id.className = 'trim3-editor-music-id';
  id.type = 'text';
  id.required = true;
  id.autocomplete = 'off';
  id.placeholder = '请输入歌曲或歌单 ID';
  idLabel.appendChild(id);
  form.appendChild(idLabel);

  const colorLabel = document.createElement('label');
  colorLabel.textContent = '主题色彩';
  const color = document.createElement('input');
  color.className = 'trim3-editor-music-color';
  color.type = 'color';
  color.value = '#1989fa';
  colorLabel.appendChild(color);
  form.appendChild(colorLabel);

  const autoplayLabel = document.createElement('label');
  autoplayLabel.className = 'trim3-editor-music-autoplay-label';
  const autoplay = document.createElement('input');
  autoplay.className = 'trim3-editor-music-autoplay';
  autoplay.type = 'checkbox';
  autoplay.checked = true;
  autoplayLabel.appendChild(autoplay);
  autoplayLabel.appendChild(document.createTextNode('自动播放'));
  form.appendChild(autoplayLabel);

  const error = document.createElement('div');
  error.className = 'trim3-editor-music-error';
  error.setAttribute('role', 'alert');
  form.appendChild(error);
  const actions = document.createElement('div');
  actions.className = 'trim3-editor-music-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-outline';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => dialog.close());
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary';
  submit.textContent = '插入编辑器';
  actions.appendChild(cancel);
  actions.appendChild(submit);
  form.appendChild(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      onInsert(buildMusicShortcode({ kind: dialog.dataset.kind, server: server.value, id: id.value, color: color.value, autoplay: autoplay.checked }));
      error.textContent = '';
      dialog.close();
    } catch (cause) {
      error.textContent = cause?.message || '请检查音乐信息';
      id.focus?.();
    }
  });
  dialog.appendChild(form);
  return { dialog, title };
}

function createShortcodeTools(editor, container) {
  const toolbar = document.createElement('span');
  toolbar.className = 'trim3-editor-shortcode-tools';
  container.appendChild(toolbar);

  const panel = document.createElement('details');
  panel.className = 'trim3-editor-shortcode-panel';
  const summary = document.createElement('summary');
  summary.className = 'tb trim3-editor-shortcode-toggle';
  summary.textContent = 'Joe 组件';
  summary.title = '插入 TriM3 原主题短代码';
  panel.appendChild(summary);
  const menu = document.createElement('div');
  menu.className = 'trim3-editor-shortcode-menu';
  let activeGroup = '';
  let groupRoot = null;
  for (const template of SHORTCODE_TEMPLATES) {
    if (template.group !== activeGroup) {
      activeGroup = template.group;
      groupRoot = document.createElement('section');
      groupRoot.className = 'trim3-editor-shortcode-group';
      const heading = document.createElement('h4');
      heading.textContent = activeGroup;
      groupRoot.appendChild(heading);
      menu.appendChild(groupRoot);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'trim3-editor-insert';
    button.dataset.template = template.id;
    button.textContent = template.label;
    button.addEventListener('click', () => {
      editor.insertText(template.text);
      panel.open = false;
    });
    groupRoot.appendChild(button);
  }
  panel.appendChild(menu);
  toolbar.appendChild(panel);

  const { dialog, title } = createMusicDialog(text => editor.insertText(text));
  const musicButton = (kind, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb trim3-editor-music-open';
    button.dataset.kind = kind;
    button.textContent = label;
    button.addEventListener('click', () => {
      dialog.dataset.kind = kind;
      title.textContent = kind === 'music-list' ? '插入音乐歌单' : '插入音乐单曲';
      dialog.showModal();
    });
    toolbar.appendChild(button);
  };
  musicButton('music', '音乐单曲');
  musicButton('music-list', '音乐歌单');
  toolbar.appendChild(dialog);
}

export function activate({ editor, slots }) {
  let onPaste = null;
  const mount = slots.toolbar.mount(container => {
    const wrap = document.createElement('span');
    wrap.className = 'trim3-editor-upload-wrap';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb trim3-editor-upload';
    button.textContent = '上传图片到图床';
    button.title = '上传图片到 Trim3 图床';
    wrap.appendChild(button);

    const previews = document.createElement('span');
    previews.className = 'trim3-editor-previews';
    wrap.appendChild(previews);
    container.appendChild(wrap);
    createShortcodeTools(editor, container);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.hidden = true;
    container.appendChild(input);

    const setBusy = (busy, progress = '') => {
      button.disabled = busy;
      button.textContent = busy ? '上传中 ' + progress : '上传图片到图床';
    };

    const upload = async file => {
      const preview = createPreview(file.name);
      previews.appendChild(preview.item);
      try {
        const data = await readFileAsBase64(file);
        const result = await editor.request('POST', '/upload', {
          body: { name: file.name, mime: file.type || 'application/octet-stream', data },
          timeout: 120000,
        });
        if (!result?.url) throw new Error('上传返回地址为空');
        preview.image.src = result.url;
        preview.button.addEventListener('click', () => editor.insertText('![](' + result.url + ')'));
        return result.url;
      } catch (error) {
        preview.item.classList.add('is-error');
        preview.button.classList.add('is-error');
        preview.button.textContent = file.name + '：' + (error?.message || '上传失败');
        return null;
      } finally {
        preview.remove.addEventListener('click', () => preview.item.remove());
      }
    };

    input.addEventListener('change', async () => {
      const files = [...(input.files || [])];
      input.value = '';
      if (!files.length) return;
      try {
        for (const [index, file] of files.entries()) {
          setBusy(true, (index + 1) + '/' + files.length);
          await upload(file);
        }
      } finally {
        setBusy(false);
      }
    });

    /* 原主题写文章页在 CodeMirror 的 paste 处理里把剪贴板图片直接传到图床
       （TriM3/assets/typecho/write/dist/index.bundle.js 的 domEventHandlers.paste）。
       这里按 lill 的稳定接口重做：只监听剪贴板事件，不改核心编辑器 DOM，
       上传仍走同一受认证入口 /api/v1/upload，成功后用 editor.insertText 落 Markdown。 */
    let pasting = false;
    onPaste = async event => {
      const clipboard = event.clipboardData;
      if (!clipboard || !Array.isArray(clipboard.items) || !clipboard.items.length) return;
      const target = event.target;
      if (!target || String(target.tagName || '').toUpperCase() !== 'TEXTAREA') return;
      if (typeof editor.getContent === 'function' && String(target.value ?? '') !== editor.getContent()) return;
      const item = clipboard.items.find(entry => String(entry?.type || '').includes('image'));
      if (!item || typeof item.getAsFile !== 'function') return;
      const file = item.getAsFile();
      if (!file || pasting) return;
      event.preventDefault();
      pasting = true;
      const caret = Number(target.selectionStart) || 0;
      const before = String(target.value ?? '').slice(0, caret);
      try {
        const url = await upload(file);
        if (!url) return;
        editor.insertText((before && !before.endsWith('\n') ? '\n' : '') + '![' + file.name + '](' + url + ')\n');
      } finally {
        pasting = false;
      }
    };
    document.addEventListener('paste', onPaste, true);

    button.addEventListener('click', () => input.click());
  });

  return () => {
    if (onPaste) document.removeEventListener('paste', onPaste, true);
    mount.unmount();
  };
}
