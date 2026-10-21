(function () {
  'use strict';

  var endpoint = '/admin/themes/solbrin/settings';
  var fallbackImage = '/themes/solbrin/assets/home-mist.jpg';
  var state = {
    schema: [],
    values: {},
    original: {},
    activeGroup: '',
    dirty: false,
    saving: false
  };
  var nav = document.getElementById('settings-nav');
  var groups = document.getElementById('settings-groups');
  var form = document.getElementById('settings-form');
  var loading = document.getElementById('settings-loading');
  var status = document.getElementById('settings-status');
  var save = document.getElementById('settings-save');
  var dirtyLabel = document.getElementById('settings-dirty');
  var previewImage = document.getElementById('settings-preview-image');
  var previewType = document.getElementById('settings-preview-type');

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function icon(direction) {
    return direction === 'up'
      ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
  }

  function valueOf(field) {
    var value = state.values[field.key];
    if (value !== undefined && value !== null && value !== '') return value;
    return field.default;
  }

  function normalize(field, value) {
    if (field.type === 'checkbox') {
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'on', 'yes'].indexOf(String(value || '').toLowerCase()) !== -1;
    }
    if (field.type === 'navigation') return Array.isArray(value) ? value.slice() : [];
    return value == null ? '' : value;
  }

  function setStatus(message, error) {
    status.textContent = message || '';
    status.classList.toggle('is-error', Boolean(error));
  }

  function setDirty(dirty) {
    state.dirty = dirty;
    dirtyLabel.textContent = dirty ? '有未保存的修改' : '尚未修改';
    dirtyLabel.classList.toggle('is-dirty', dirty);
    save.disabled = !dirty || state.saving;
  }

  function collectValues() {
    var result = {};
    state.schema.forEach(function (field) {
      var input = form.querySelector('[data-key="' + cssEscape(field.key) + '"]');
      if (!input) {
        result[field.key] = state.values[field.key];
        return;
      }
      if (field.type === 'navigation') {
        result[field.key] = Array.prototype.slice.call(input.querySelectorAll('input[type="checkbox"]:checked'))
          .map(function (item) { return item.value; });
      } else if (field.type === 'checkbox') {
        result[field.key] = input.checked;
      } else {
        result[field.key] = input.value;
      }
    });
    return result;
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function fieldHTML(field) {
    var value = normalize(field, valueOf(field));
    var key = esc(field.key);
    var label = esc(field.label || field.key);
    var description = field.description ? '<p>' + esc(field.description) + '</p>' : '';
    var control = '';
    if (field.type === 'checkbox') {
      control = '<label class="settings-toggle"><input type="checkbox" data-key="' + key + '"' + (value ? ' checked' : '') + '><span class="settings-toggle__track" aria-hidden="true"></span><span>' + (value ? '已开启' : '已关闭') + '</span></label>';
    } else if (field.type === 'select') {
      control = '<select class="settings-select" data-key="' + key + '">' +
        (field.options || []).map(function (option) {
          return '<option value="' + esc(option.value) + '"' + (String(option.value) === String(value) ? ' selected' : '') + '>' + esc(option.label || option.value) + '</option>';
        }).join('') + '</select>';
    } else if (field.type === 'textarea') {
      control = '<textarea class="settings-textarea" data-key="' + key + '" spellcheck="false">' + esc(value) + '</textarea>';
    } else if (field.type === 'navigation') {
      control = navigationHTML(field, value);
    } else {
      control = '<input class="settings-input" type="text" data-key="' + key + '" value="' + esc(value) + '" autocomplete="off">';
    }
    return '<div class="settings-field"><div class="settings-field__label"><label for="field-' + key + '">' + label + '</label>' + description + '</div><div class="settings-control">' + control + '</div></div>';
  }

  function navigationHTML(field, selected) {
    var options = Array.isArray(field.options) ? field.options : [];
    var byValue = {};
    options.forEach(function (option) { byValue[option.value] = option; });
    var ordered = selected.concat(options.map(function (option) { return option.value; }).filter(function (value) { return selected.indexOf(value) === -1; }));
    return '<div class="settings-nav-editor" data-key="' + esc(field.key) + '">' +
      ordered.filter(function (value, index, all) { return all.indexOf(value) === index; }).map(function (value) {
        var option = byValue[value];
        if (!option) return '';
        var checked = selected.indexOf(value) !== -1;
        return '<div class="settings-nav-row" data-nav-key="' + esc(value) + '"><label><input type="checkbox" value="' + esc(value) + '"' + (checked ? ' checked' : '') + '><span>' + esc(option.label || value) + '</span></label><span class="settings-nav-row__actions"><button class="settings-icon-btn" type="button" data-nav-move="up" aria-label="上移 ' + esc(option.label || value) + '">' + icon('up') + '</button><button class="settings-icon-btn" type="button" data-nav-move="down" aria-label="下移 ' + esc(option.label || value) + '">' + icon('down') + '</button></span></div>';
      }).join('') + '</div>';
  }

  function renderGroups() {
    var groupMap = {};
    var order = [];
    state.schema.forEach(function (field) {
      var name = field.group || '其他';
      if (!groupMap[name]) { groupMap[name] = []; order.push(name); }
      groupMap[name].push(field);
    });
    state.activeGroup = state.activeGroup || order[0] || '';
    nav.innerHTML = order.map(function (name) {
      return '<button type="button" role="tab" data-group="' + esc(name) + '" aria-selected="' + (name === state.activeGroup) + '">' + esc(name) + '</button>';
    }).join('');
    groups.innerHTML = order.map(function (name) {
      return '<section class="settings-group' + (name === state.activeGroup ? ' is-active' : '') + '" data-group-panel="' + esc(name) + '"><header class="settings-group__head"><h2>' + esc(name) + '</h2><p>' + groupDescription(name) + '</p></header>' + groupMap[name].map(fieldHTML).join('') + '</section>';
    }).join('');
    nav.addEventListener('click', function (event) {
      var button = event.target.closest('[data-group]');
      if (!button) return;
      state.activeGroup = button.getAttribute('data-group');
      Array.prototype.slice.call(nav.querySelectorAll('[data-group]')).forEach(function (item) {
        item.setAttribute('aria-selected', String(item === button));
      });
      Array.prototype.slice.call(groups.querySelectorAll('[data-group-panel]')).forEach(function (panel) {
        panel.classList.toggle('is-active', panel.getAttribute('data-group-panel') === state.activeGroup);
      });
    });
    groups.addEventListener('click', function (event) {
      var button = event.target.closest('[data-nav-move]');
      if (!button) return;
      var row = button.closest('[data-nav-key]');
      var editor = row && row.parentElement;
      if (!row || !editor) return;
      var target = button.getAttribute('data-nav-move') === 'up' ? row.previousElementSibling : row.nextElementSibling;
      if (!target) return;
      if (button.getAttribute('data-nav-move') === 'up') editor.insertBefore(row, target);
      else editor.insertBefore(target, row);
      refreshNavButtons(editor);
      markEdited();
    });
    groups.addEventListener('input', onInput);
    groups.addEventListener('change', onInput);
    refreshNavButtons();
  }

  function groupDescription(name) {
    var descriptions = {
      '导航': '决定侧栏里出现哪些站点入口，以及它们的顺序。',
      '首页影像': '选择首页的第一印象。图片和视频都会在首屏下方融入文章区域。',
      '界面': '控制站点的侧栏入口和页脚信息。',
      '文章': '控制文章详情页中的元信息与评论显示。',
      '高级': '为需要进一步调整的站点追加自定义样式。'
    };
    return esc(descriptions[name] || '调整这个分组的显示选项。');
  }

  function onInput(event) {
    var input = event.target;
    var key = input.getAttribute('data-key');
    if (key) {
      state.values[key] = input.type === 'checkbox' ? input.checked : input.value;
      if (input.type === 'checkbox') {
        var label = input.closest('.settings-toggle');
        var text = label && label.querySelector('span:last-child');
        if (text) text.textContent = input.checked ? '已开启' : '已关闭';
      }
      markEdited();
    }
    if (input.closest('[data-nav-key]')) markEdited();
  }

  function markEdited() {
    setDirty(true);
    setStatus('');
    updatePreview();
  }

  function refreshNavButtons(editor) {
    Array.prototype.slice.call(groups.querySelectorAll('.settings-nav-editor')).forEach(function (list) {
      var rows = Array.prototype.slice.call(list.querySelectorAll('[data-nav-key]'));
      rows.forEach(function (row, index) {
        var up = row.querySelector('[data-nav-move="up"]');
        var down = row.querySelector('[data-nav-move="down"]');
        if (up) up.disabled = index === 0;
        if (down) down.disabled = index === rows.length - 1;
      });
    });
  }

  function updatePreview() {
    var type = state.values.hero_media_type === 'video' ? 'video' : 'image';
    var image = state.values.hero_image || state.values.hero_poster || fallbackImage;
    previewImage.src = image;
    previewImage.style.objectPosition = state.values.hero_position || '50% 50%';
    previewImage.onerror = function () {
      previewImage.onerror = null;
      previewImage.src = fallbackImage;
    };
    previewType.textContent = type === 'video' ? '视频' : '图片';
  }

  async function load() {
    try {
      var data = await window.lillAPI.get(endpoint);
      state.schema = Array.isArray(data.schema) ? data.schema : [];
      state.values = {};
      state.schema.forEach(function (field) {
        state.values[field.key] = normalize(field, Object.prototype.hasOwnProperty.call(data.values || {}, field.key) ? data.values[field.key] : field.default);
      });
      state.original = JSON.parse(JSON.stringify(state.values));
      loading.hidden = true;
      form.hidden = false;
      renderGroups();
      updatePreview();
      setDirty(false);
    } catch (error) {
      loading.innerHTML = '<span>设置读取失败：' + esc(error.message || '未知错误') + '</span>';
      setStatus(error.message || '设置读取失败', true);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (state.saving) return;
    state.saving = true;
    save.disabled = true;
    save.textContent = '保存中…';
    setStatus('');
    try {
      var saved = await window.lillAPI.put(endpoint, collectValues());
      state.original = JSON.parse(JSON.stringify(saved || state.values));
      state.values = JSON.parse(JSON.stringify(state.original));
      setDirty(false);
      setStatus('设置已保存');
    } catch (error) {
      setDirty(true);
      setStatus(error.message || '保存失败', true);
    } finally {
      state.saving = false;
      save.textContent = '保存设置';
      save.disabled = !state.dirty;
    }
  }

  form.addEventListener('submit', submit);
  window.addEventListener('beforeunload', function (event) {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  load();
})();
