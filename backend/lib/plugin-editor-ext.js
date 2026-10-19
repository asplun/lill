const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'checkbox', 'select', 'url']);
const CONTENT_TYPES = new Set(['post', 'page']);
const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PLUGIN_DIR = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SLOTS = new Set(['toolbar', 'sidebar']);
const ACTION_PLACEMENTS = new Set(['toolbar', 'sidebar']);
const VALUE_LIMITS = { text: 5000, textarea: 50000, url: 2048 };
const ACTION_TEXT_LIMIT = 50000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePluginDir(pluginDir) {
  if (typeof pluginDir !== 'string' || !PLUGIN_DIR.test(pluginDir) || pluginDir.includes('..')) {
    throw new TypeError('插件目录名无效');
  }
}

function normalizeContentScope(value, label) {
  if (value === undefined) return ['post', 'page'];
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some(item => !CONTENT_TYPES.has(item))) {
    throw new TypeError(`${label} 的 for 无效`);
  }
  const result = [...new Set(values)];
  return result.length === 2 ? ['post', 'page'] : result;
}

function normalizeOptions(options, key) {
  if (!Array.isArray(options) || options.length < 1 || options.length > 100) {
    throw new TypeError(`字段 ${key} 必须声明 1 至 100 个选项`);
  }
  const seen = new Set();
  return options.map(option => {
    if (!isRecord(option) || typeof option.value !== 'string' || !option.value.trim() ||
        option.value.length > 128 || typeof option.label !== 'string' ||
        !option.label.trim() || option.label.length > 200) {
      throw new TypeError(`字段 ${key} 包含无效选项`);
    }
    if (seen.has(option.value)) throw new TypeError(`字段 ${key} 的选项值重复`);
    seen.add(option.value);
    return { value: option.value, label: option.label };
  });
}

function defaultValue(type, options) {
  if (type === 'checkbox') return false;
  if (type === 'number') return 0;
  if (type === 'select') return options[0].value;
  return '';
}

function validUrl(value) {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeFieldDefault(field, value) {
  if (field.type === 'checkbox') {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    throw new TypeError(`字段 ${field.key} 的默认值必须是布尔值`);
  }
  if (field.type === 'number') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number) || (typeof value === 'string' && value.trim() === '')) {
      throw new TypeError(`字段 ${field.key} 的默认值必须是有限数字`);
    }
    return number;
  }
  if (typeof value !== 'string') throw new TypeError(`字段 ${field.key} 的默认值必须是字符串`);
  if (value.length > (VALUE_LIMITS[field.type] || 128)) throw new TypeError(`字段 ${field.key} 的默认值过长`);
  if (field.type === 'select' && !field.options.some(option => option.value === value)) {
    throw new TypeError(`字段 ${field.key} 的默认值不在选项中`);
  }
  if (field.type === 'url' && !validUrl(value)) {
    throw new TypeError(`字段 ${field.key} 的默认 URL 仅支持 HTTP 或 HTTPS`);
  }
  return value;
}

function parseStoredFields(value, strict = false) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); }
    catch {
      if (strict) throw new TypeError('存储的自定义字段不是有效 JSON');
      return {};
    }
  }
  if (isRecord(parsed)) return parsed;
  if (strict) throw new TypeError('存储的自定义字段必须是对象');
  return {};
}

export function validateEditorFieldValue(field, value) {
  if (field.type === 'checkbox') {
    if (typeof value !== 'boolean') throw new TypeError(`插件字段 ${field.key} 必须是布尔值`);
    return value;
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`插件字段 ${field.key} 必须是有限数字`);
    }
    return value;
  }
  if (typeof value !== 'string') throw new TypeError(`插件字段 ${field.key} 必须是字符串`);
  if (value.length > (VALUE_LIMITS[field.type] || 128)) throw new TypeError(`插件字段 ${field.key} 超过长度限制`);
  if (field.type === 'select' && !field.options.some(option => option.value === value)) {
    throw new TypeError(`插件字段 ${field.key} 的值不在选项中`);
  }
  if (field.type === 'url' && !validUrl(value)) {
    throw new TypeError(`插件字段 ${field.key} 仅支持 HTTP 或 HTTPS 地址`);
  }
  return value;
}

export function normalizeEditorField(field, pluginDir) {
  validatePluginDir(pluginDir);
  if (!isRecord(field)) throw new TypeError('编辑器字段必须是对象');
  const { key, label, type } = field;
  if (typeof key !== 'string' || !FIELD_KEY.test(key) || RESERVED_KEYS.has(key)) {
    throw new TypeError(`字段 ${key || ''} 的 key 无效`);
  }
  if (typeof label !== 'string' || !label.trim() || label.length > 200) {
    throw new TypeError(`字段 ${key} 必须提供不超过 200 字符的 label`);
  }
  if (!FIELD_TYPES.has(type)) throw new TypeError(`字段 ${key} 的 type 不受支持`);
  const scope = normalizeContentScope(field.for, `字段 ${key}`);
  const group = field.group === undefined ? '' : field.group;
  const description = field.description === undefined ? '' : field.description;
  if (typeof group !== 'string' || group.length > 100) throw new TypeError(`字段 ${key} 的 group 无效`);
  if (typeof description !== 'string' || description.length > 500) throw new TypeError(`字段 ${key} 的 description 无效`);
  if (type !== 'select' && field.options !== undefined) {
    throw new TypeError(`字段 ${key} 只有 select 类型可以声明 options`);
  }
  const options = type === 'select' ? normalizeOptions(field.options, key) : undefined;
  const normalized = {
    plugin: pluginDir,
    key,
    label,
    type,
    for: scope,
    group,
    default: defaultValue(type, options),
    description,
  };
  if (options) normalized.options = options;
  if (field.default !== undefined) normalized.default = normalizeFieldDefault(normalized, field.default);
  return normalized;
}

export function normalizeEditorAction(action, pluginDir) {
  validatePluginDir(pluginDir);
  if (!isRecord(action)) throw new TypeError('编辑器动作必须是对象');
  if (typeof action.id !== 'string' || !IDENTIFIER.test(action.id) || RESERVED_KEYS.has(action.id)) {
    throw new TypeError('编辑器动作 id 无效');
  }
  if (typeof action.label !== 'string' || !action.label.trim() || action.label.length > 200) {
    throw new TypeError(`动作 ${action.id} 必须提供不超过 200 字符的 label`);
  }
  if (!ACTION_PLACEMENTS.has(action.placement)) throw new TypeError(`动作 ${action.id} 的 placement 无效`);
  if (typeof action.handler !== 'function') throw new TypeError(`动作 ${action.id} 必须提供 handler`);
  const scope = normalizeContentScope(action.for, `动作 ${action.id}`);
  const publicMeta = { id: action.id, label: action.label, placement: action.placement, for: scope };
  return { plugin: pluginDir, id: action.id, label: action.label, placement: action.placement, for: scope, handler: action.handler, public: publicMeta };
}

function normalizeRelativeAsset(asset, extension) {
  if (typeof asset !== 'string' || !asset || asset.startsWith('/') || asset.includes('\\') ||
      asset.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new TypeError(`${extension} 路径无效`);
  }
  const suffix = extension === 'entry' ? '.js' : '.css';
  if (!asset.endsWith(suffix)) throw new TypeError(`${extension} 必须使用 ${suffix} 文件`);
  return asset;
}

export function normalizeEditorExtension(extension, pluginDir) {
  validatePluginDir(pluginDir);
  if (!isRecord(extension)) throw new TypeError('编辑器扩展必须是对象');
  if (typeof extension.id !== 'string' || !IDENTIFIER.test(extension.id) || RESERVED_KEYS.has(extension.id)) {
    throw new TypeError('编辑器扩展 id 无效');
  }
  const entry = normalizeRelativeAsset(extension.entry, 'entry');
  const styles = extension.styles === undefined ? [] : extension.styles;
  if (!Array.isArray(styles) || styles.length > 20) throw new TypeError(`扩展 ${extension.id} 的 styles 无效`);
  const normalizedStyles = styles.map(style => normalizeRelativeAsset(style, 'styles'));
  const slots = extension.slots === undefined ? [] : extension.slots;
  if (!Array.isArray(slots) || !slots.length || slots.some(slot => !SLOTS.has(slot))) {
    throw new TypeError(`扩展 ${extension.id} 的 slot 无效`);
  }
  if (extension.apiVersion !== 1) throw new TypeError(`扩展 ${extension.id} 只支持 apiVersion 1`);
  const scope = normalizeContentScope(extension.for, `扩展 ${extension.id}`);
  const publicMeta = {
    id: extension.id,
    entry,
    styles: normalizedStyles,
    for: scope,
    slots: [...new Set(slots)],
    apiVersion: 1,
  };
  return { plugin: pluginDir, ...publicMeta, public: publicMeta };
}

export function readPluginEditorFields(storedFields, registry, contentType) {
  if (!registry || typeof registry.fieldsFor !== 'function') throw new TypeError('编辑器插件注册表无效');
  const stored = parseStoredFields(storedFields);
  const namespaces = isRecord(stored._lillPluginFields) ? stored._lillPluginFields : {};
  const result = {};
  for (const field of registry.fieldsFor(contentType)) {
    const values = isRecord(namespaces[field.plugin]) ? namespaces[field.plugin] : {};
    const value = Object.hasOwn(values, field.key)
      ? (() => {
        try { return validateEditorFieldValue(field, values[field.key]); }
        catch { return field.default; }
      })()
      : field.default;
    if (!result[field.plugin]) result[field.plugin] = {};
    Object.defineProperty(result[field.plugin], field.key, {
      value, enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

export function mergePluginEditorFields(storedFields, submitted, registry, contentType) {
  if (!isRecord(submitted)) throw new TypeError('插件字段必须是对象');
  if (!registry || typeof registry.fieldsFor !== 'function') throw new TypeError('编辑器插件注册表无效');
  const stored = parseStoredFields(storedFields, true);
  const existingNamespaces = stored._lillPluginFields === undefined ? {} : stored._lillPluginFields;
  if (!isRecord(existingNamespaces)) throw new TypeError('存储的插件字段必须是对象');
  const nextNamespaces = { ...existingNamespaces };

  for (const [pluginDir, values] of Object.entries(submitted)) {
    if (!isRecord(values)) throw new TypeError(`插件 ${pluginDir} 的字段必须是对象`);
    const fields = registry.fieldsFor(contentType, pluginDir);
    if (!fields.length) throw new TypeError(`未知或未启用的编辑器插件：${pluginDir}`);
    const declared = new Map(fields.map(field => [field.key, field]));
    const current = nextNamespaces[pluginDir] === undefined ? {} : nextNamespaces[pluginDir];
    if (!isRecord(current)) throw new TypeError(`插件 ${pluginDir} 的存储字段必须是对象`);
    const normalized = {};
    for (const [key, value] of Object.entries(values)) {
      const field = declared.get(key);
      if (!field) throw new TypeError(`未知插件字段：${pluginDir}/${key}`);
      normalized[key] = validateEditorFieldValue(field, value);
    }
    nextNamespaces[pluginDir] = { ...current, ...normalized };
  }
  return { ...stored, _lillPluginFields: nextNamespaces };
}

function validateActionText(value) {
  if (typeof value !== 'string') throw new TypeError('动作结果文本必须是字符串');
  if (value.length > ACTION_TEXT_LIMIT) throw new TypeError('动作结果超过长度限制');
  if (/<\/?script\b/i.test(value) || /\bon[a-z]+\s*=/i.test(value)) {
    throw new TypeError('动作结果不能包含可执行脚本');
  }
  return value;
}

export function validateEditorActionResult(result) {
  if (!isRecord(result)) throw new TypeError('动作结果必须是对象');
  const keys = Object.keys(result);
  if (keys.length !== 1) throw new TypeError('动作结果只能包含一个受支持的编辑器操作');
  if (keys[0] === 'insertText' || keys[0] === 'replaceSelection') {
    return { [keys[0]]: validateActionText(result[keys[0]]) };
  }
  if (keys[0] === 'setPluginField') {
    const operation = result.setPluginField;
    if (!isRecord(operation) || typeof operation.key !== 'string' ||
        !FIELD_KEY.test(operation.key) || RESERVED_KEYS.has(operation.key) ||
        !['string', 'number', 'boolean'].includes(typeof operation.value) ||
        (typeof operation.value === 'number' && !Number.isFinite(operation.value))) {
      throw new TypeError('动作结果字段操作无效');
    }
    if (typeof operation.value === 'string') validateActionText(operation.value);
    return { setPluginField: { key: operation.key, value: operation.value } };
  }
  throw new TypeError('动作结果包含未知编辑器操作');
}

function registrationMap() {
  return new Map();
}

function removeFromMap(map, pluginDir, id) {
  const plugin = map.get(pluginDir);
  if (!plugin || !plugin.delete(id)) return false;
  if (!plugin.size) map.delete(pluginDir);
  return true;
}

export function createEditorRegistry() {
  const fields = registrationMap();
  const actions = registrationMap();
  const extensions = registrationMap();

  const register = (map, normalizer, item, pluginDir) => {
    validatePluginDir(pluginDir);
    const normalized = normalizer(item, pluginDir);
    const pluginMap = map.get(pluginDir) || new Map();
    if (pluginMap.has(normalized.key || normalized.id)) {
      throw new TypeError(`编辑器注册项重复：${pluginDir}/${normalized.key || normalized.id}`);
    }
    pluginMap.set(normalized.key || normalized.id, normalized);
    map.set(pluginDir, pluginMap);
    let removed = false;
    return () => {
      if (removed) return false;
      removed = true;
      return removeFromMap(map, pluginDir, normalized.key || normalized.id);
    };
  };

  const listFor = (map, contentType, pluginDir) => {
    if (!CONTENT_TYPES.has(contentType)) throw new TypeError('无效的内容类型，仅支持 post/page');
    const maps = pluginDir ? [map.get(pluginDir)].filter(Boolean) : [...map.values()];
    return [...maps.flatMap(items => [...items.values()])].filter(item => item.for.includes(contentType));
  };

  return {
    fields,
    actions,
    extensions,
    registerField: (field, pluginDir) => register(fields, normalizeEditorField, field, pluginDir),
    registerAction: (action, pluginDir) => register(actions, normalizeEditorAction, action, pluginDir),
    registerExtension: (extension, pluginDir) => register(extensions, normalizeEditorExtension, extension, pluginDir),
    fieldsFor: (contentType, pluginDir) => listFor(fields, contentType, pluginDir),
    actionsFor: (contentType, pluginDir) => listFor(actions, contentType, pluginDir),
    extensionsFor: (contentType, pluginDir) => listFor(extensions, contentType, pluginDir),
    getAction: (pluginDir, id, contentType = null) => {
      const action = actions.get(pluginDir)?.get(id);
      if (!action || (contentType && !action.for.includes(contentType))) return null;
      return action;
    },
    getField: (pluginDir, key, contentType = null) => {
      const field = fields.get(pluginDir)?.get(key);
      if (!field || (contentType && !field.for.includes(contentType))) return null;
      return field;
    },
    clearPlugin: pluginDir => {
      const removed = fields.has(pluginDir) || actions.has(pluginDir) || extensions.has(pluginDir);
      fields.delete(pluginDir);
      actions.delete(pluginDir);
      extensions.delete(pluginDir);
      return removed;
    },
  };
}
