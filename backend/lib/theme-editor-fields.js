const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'checkbox', 'select', 'url']);
const CONTENT_TYPES = new Set(['post', 'page']);
const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const THEME_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NAMESPACE = '_lillThemeFields';
const VALUE_LIMITS = { text: 5000, textarea: 50000, url: 2048 };

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStoredFields(value, strict = false) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      if (strict) throw new TypeError('存储的自定义字段不是有效 JSON');
      return {};
    }
  }
  if (isRecord(parsed)) return parsed;
  if (strict) throw new TypeError('存储的自定义字段必须是对象');
  return {};
}

function defaultFor(field) {
  if (field.type === 'checkbox') return false;
  if (field.type === 'number') return 0;
  if (field.type === 'select') return field.options[0].value;
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

function normalizeDefault(field, value) {
  if (field.type === 'checkbox') {
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', 'on', 'yes'].includes(normalized)) return true;
      if (['false', 'off', 'no', ''].includes(normalized)) return false;
    }
    throw new TypeError(`字段 ${field.key} 的默认值必须是布尔值`);
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new TypeError(`字段 ${field.key} 的默认值必须是有限数字`);
    }
    const number = Number(value);
    if (!Number.isFinite(number) || (typeof value === 'string' && value.trim() === '')) {
      throw new TypeError(`字段 ${field.key} 的默认值必须是有限数字`);
    }
    return number;
  }
  if (typeof value !== 'string') throw new TypeError(`字段 ${field.key} 的默认值必须是字符串`);
  if (value.length > (VALUE_LIMITS[field.type] || 128)) {
    throw new TypeError(`字段 ${field.key} 的默认值过长`);
  }
  if (field.type === 'select' && !field.options.some(option => option.value === value)) {
    throw new TypeError(`字段 ${field.key} 的默认值不在选项中`);
  }
  if (field.type === 'url' && !validUrl(value)) {
    throw new TypeError(`字段 ${field.key} 的默认 URL 仅支持 HTTP 或 HTTPS`);
  }
  return value;
}

function validateValue(field, value) {
  if (field.type === 'checkbox') {
    if (typeof value !== 'boolean') throw new TypeError(`字段 ${field.key} 必须是布尔值`);
    return value;
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`字段 ${field.key} 必须是有限数字`);
    }
    return value;
  }
  if (typeof value !== 'string') throw new TypeError(`字段 ${field.key} 必须是字符串`);
  if (value.length > (VALUE_LIMITS[field.type] || 128)) throw new TypeError(`字段 ${field.key} 超过长度限制`);
  if (field.type === 'select' && !field.options.some(option => option.value === value)) {
    throw new TypeError(`字段 ${field.key} 的值不在选项中`);
  }
  if (field.type === 'url' && !validUrl(value)) {
    throw new TypeError(`字段 ${field.key} 仅支持 HTTP 或 HTTPS 地址`);
  }
  return value;
}

function validateThemeId(themeId) {
  if (typeof themeId !== 'string' || !THEME_ID.test(themeId)) {
    throw new TypeError('主题 ID 无效');
  }
}

export function normalizeEditorFieldSchema(manifest, contentType) {
  if (!CONTENT_TYPES.has(contentType)) throw new TypeError('无效的内容类型，仅支持 post/page');
  if (manifest == null) return [];
  if (!isRecord(manifest)) throw new TypeError('主题 manifest 必须是对象');
  if (manifest.editorFields === undefined) return [];
  if (!Array.isArray(manifest.editorFields) || manifest.editorFields.length > 100) {
    throw new TypeError('editorFields 必须是最多包含 100 项的数组');
  }

  const seen = new Set();
  const normalized = manifest.editorFields.map((declaration, index) => {
    if (!isRecord(declaration)) throw new TypeError(`第 ${index + 1} 个主题字段必须是对象`);
    const { key, label, type } = declaration;
    if (typeof key !== 'string' || !FIELD_KEY.test(key) || RESERVED_KEYS.has(key)) {
      throw new TypeError(`第 ${index + 1} 个主题字段 key 无效`);
    }
    if (seen.has(key)) throw new TypeError(`主题字段 key 重复：${key}`);
    seen.add(key);
    if (typeof label !== 'string' || !label.trim() || label.length > 200) {
      throw new TypeError(`字段 ${key} 必须提供不超过 200 字符的 label`);
    }
    if (!FIELD_TYPES.has(type)) throw new TypeError(`字段 ${key} 的 type 不受支持`);

    const content = declaration.for === undefined ? 'both' : declaration.for;
    if (!['post', 'page', 'both'].includes(content)) throw new TypeError(`字段 ${key} 的 for 无效`);
    const group = declaration.group === undefined ? '' : declaration.group;
    const description = declaration.description === undefined ? '' : declaration.description;
    if (typeof group !== 'string' || group.length > 100) throw new TypeError(`字段 ${key} 的 group 无效`);
    if (typeof description !== 'string' || description.length > 500) throw new TypeError(`字段 ${key} 的 description 无效`);

    let options;
    if (type === 'select') {
      if (!Array.isArray(declaration.options) || declaration.options.length < 1 || declaration.options.length > 100) {
        throw new TypeError(`字段 ${key} 必须声明 1 至 100 个选项`);
      }
      const optionValues = new Set();
      options = declaration.options.map(option => {
        if (!isRecord(option) || typeof option.value !== 'string' || !option.value.trim() ||
            option.value.length > 128 || typeof option.label !== 'string' ||
            !option.label.trim() || option.label.length > 200) {
          throw new TypeError(`字段 ${key} 包含无效选项`);
        }
        if (optionValues.has(option.value)) throw new TypeError(`字段 ${key} 的选项值重复`);
        optionValues.add(option.value);
        return { value: option.value, label: option.label };
      });
    } else if (declaration.options !== undefined) {
      throw new TypeError(`字段 ${key} 只有 select 类型可以声明 options`);
    }

    const field = {
      key,
      label,
      type,
      for: content,
      group,
      default: defaultFor({ type, options }),
      description,
    };
    if (options) field.options = options;
    if (declaration.default !== undefined) field.default = normalizeDefault(field, declaration.default);
    return field;
  });

  return normalized.filter(field => field.for === 'both' || field.for === contentType);
}

export function readThemeEditorFields(storedFields, themeId, schema) {
  validateThemeId(themeId);
  const stored = parseStoredFields(storedFields);
  const themes = isRecord(stored[NAMESPACE]) ? stored[NAMESPACE] : {};
  const values = isRecord(themes[themeId]) ? themes[themeId] : {};
  const result = {};
  for (const field of Array.isArray(schema) ? schema : []) {
    if (!isRecord(field) || typeof field.key !== 'string') continue;
    let value = field.default;
    if (Object.hasOwn(values, field.key)) {
      try {
        value = validateValue(field, values[field.key]);
      } catch {
        value = field.default;
      }
    }
    Object.defineProperty(result, field.key, { value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function mergeThemeEditorFields(storedFields, themeId, submitted, schema) {
  validateThemeId(themeId);
  if (!isRecord(submitted)) throw new TypeError('主题字段必须是对象');
  if (!Array.isArray(schema)) throw new TypeError('主题字段 schema 必须是数组');

  const declared = new Map(schema.filter(field => isRecord(field) && typeof field.key === 'string').map(field => [field.key, field]));
  const normalized = {};
  for (const [key, value] of Object.entries(submitted)) {
    const field = declared.get(key);
    if (!field) throw new TypeError(`未知主题字段：${key}`);
    Object.defineProperty(normalized, key, {
      value: validateValue(field, value), enumerable: true, configurable: true, writable: true,
    });
  }

  const stored = parseStoredFields(storedFields, true);
  const existingThemes = stored[NAMESPACE] === undefined ? {} : stored[NAMESPACE];
  if (!isRecord(existingThemes)) throw new TypeError('存储的主题字段必须是对象');
  const existingValues = existingThemes[themeId] === undefined ? {} : existingThemes[themeId];
  if (!isRecord(existingValues)) throw new TypeError('当前主题的存储字段必须是对象');

  return {
    ...stored,
    [NAMESPACE]: {
      ...existingThemes,
      [themeId]: { ...existingValues, ...normalized },
    },
  };
}
