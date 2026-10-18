import { PUBLIC_POST_WHERE } from './public-content.js';

const DEFAULTS = {
  permalink: '/archives/{cid}/',
  category_prefix: '/category/{slug}/',
  tag_prefix: '/tag/{slug}/',
};
const KEYS = { post: 'permalink', category: 'category_prefix', tag: 'tag_prefix' };
const TOKENS = { post: ['cid', 'slug', 'category', 'year', 'month'], category: ['mid', 'slug'], tag: ['mid', 'slug'], page: ['slug'] };
const RESERVED = new Set(['api', 'admin', 'uploads', 'themes', '_astro']);
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withDefaults = options => ({ ...DEFAULTS, ...options });

/** Read only routing settings, including non-autoload rows; no process cache. */
export function readPermalinkOptions(db) {
  const options = { ...DEFAULTS };
  for (const row of db.prepare("SELECT key, value FROM options WHERE key IN ('permalink', 'category_prefix', 'tag_prefix')").all()) {
    options[row.key] = row.value;
  }
  return options;
}

// Decode individual segments, not a complete URL: URL() would erase dot segments
// before validation, and decoding the whole path would turn encoded slug '/' into separators.
function pathSegments(path) {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') || /[?#\\\s\x00-\x1f\x7f]/.test(path) || path.includes('//')) return null;
  const parts = path.replace(/\/$/, '').slice(1).split('/');
  try {
    const decoded = parts.map(part => decodeURIComponent(part));
    if (decoded.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part))) return null;
    if (RESERVED.has(decoded[0].split('/')[0].toLowerCase())) return null;
    if (decoded.length === 1 && ['archive', 'search'].includes(decoded[0].toLowerCase())) return null;
    return decoded;
  } catch { return null; }
}

function compile(type, template) {
  const segments = pathSegments(template);
  if (!segments) throw new Error('永久链接必须是安全的本站绝对路径，不能包含查询、锚点、点路径或系统前缀');
  const tokens = [];
  const parts = segments.map(segment => {
    const pieces = [];
    let cursor = 0;
    let variableWidth = 0;
    for (const match of segment.matchAll(/\{([^{}]+)\}/g)) {
      const token = match[1];
      if (!TOKENS[type].includes(token)) throw new Error('不支持的永久链接变量：{' + token + '}');
      const literal = segment.slice(cursor, match.index);
      if (/[{}]/.test(literal)) throw new Error('永久链接变量格式无效');
      pieces.push({ literal }, { token });
      tokens.push(token);
      if (!['year', 'month'].includes(token)) variableWidth++;
      cursor = match.index + match[0].length;
    }
    const tail = segment.slice(cursor);
    if (/[{}]/.test(tail)) throw new Error('永久链接变量格式无效');
    pieces.push({ literal: tail });
    // Two unrestricted tokens in one segment cannot be split uniquely (UUIDs
    // and slugs both contain hyphens). Require a path separator between them.
    if (variableWidth > 1) throw new Error('同一路径段不能包含多个不定长变量，请使用 / 分隔');
    const pattern = '^' + pieces.map(piece => piece.token
      ? piece.token === 'year' ? '(\\d{4})' : piece.token === 'month' ? '(\\d{2})' : '(.+?)'
      : escapeRegex(piece.literal)).join('') + '$';
    return { pieces, regex: new RegExp(pattern) };
  });
  const identity = type === 'category' || type === 'tag' ? ['mid', 'slug'] : ['cid', 'slug'];
  if (!tokens.some(token => identity.includes(token))) throw new Error('永久链接必须包含身份变量：' + identity.map(token => '{' + token + '}').join(' 或 '));
  return { parts, trailingSlash: template.endsWith('/') };
}

/** Validate a merged/partial options object before the settings write transaction. */
export function validatePermalinkOptions(options) {
  try {
    const settings = withDefaults(options);
    for (const type of Object.keys(KEYS)) compile(type, settings[KEYS[type]]);
    return null;
  } catch (error) { return error.message; }
}

function templateFor(type, options) {
  if (type === 'page') return '/page/{slug}';
  if (!KEYS[type]) throw new Error('不支持的永久链接内容类型：' + type);
  return withDefaults(options)[KEYS[type]];
}

function dateParts(item) {
  const raw = item.published_at || item.created_at;
  if (!raw) return {};
  // SQLite timestamps without a zone are UTC, not the server's local timezone.
  const text = String(raw);
  const date = new Date(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(text) ? text.replace(' ', 'T') + 'Z' : text);
  if (Number.isNaN(date.getTime())) return {};
  const iso = date.toISOString();
  return { year: iso.slice(0, 4), month: iso.slice(5, 7) };
}

function render(compiled, values) {
  const segments = [];
  for (const { pieces } of compiled.parts) {
    let segment = '';
    for (const piece of pieces) {
      if (!piece.token) segment += piece.literal;
      else {
        const value = values[piece.token];
        if (value === undefined || value === null || value === '') return null;
        segment += String(value);
      }
    }
    segments.push(encodeURIComponent(segment));
  }
  const path = '/' + segments.join('/') + (compiled.trailingSlash ? '/' : '');
  return pathSegments(path) ? path : null;
}

/** Generate a pathname, not a site_url-prefixed URL. Missing optional fields use a legacy slug route. */
export function permalinkPath(type, item, category = null, options = {}) {
  const compiled = compile(type, templateFor(type, options));
  const values = type === 'post' || type === 'page'
    ? { cid: item.id, slug: item.slug, category: category?.slug ?? item.category_slug, ...dateParts(item) }
    : { mid: item.id, slug: item.slug };
  const path = render(compiled, values);
  if (path) return path;
  const legacy = render(compile(type, '/' + type + '/{slug}'), { slug: item.slug });
  if (!legacy) throw new Error('内容缺少可用的永久链接身份');
  return legacy;
}

function captures(compiled, segments) {
  if (compiled.parts.length !== segments.length) return null;
  const values = {};
  for (let index = 0; index < segments.length; index++) {
    const part = compiled.parts[index];
    const match = segments[index].match(part.regex);
    if (!match) return null;
    let group = 1;
    for (const piece of part.pieces) {
      if (!piece.token) continue;
      const value = match[group++];
      if (Object.hasOwn(values, piece.token) && values[piece.token] !== value) return null;
      values[piece.token] = value;
    }
  }
  return values;
}

function lookup(db, type, values) {
  if (type === 'post' || type === 'page') {
    const where = [], args = [type];
    if (values.cid !== undefined) { where.push('p.id = ?'); args.push(values.cid); }
    if (values.slug !== undefined) { where.push('p.slug = ?'); args.push(values.slug); }
    if (!where.length) return null;
    return db.prepare(`SELECT p.id, p.type, p.slug, p.published_at, p.created_at, c.slug AS category_slug
      FROM posts p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.type = ? AND ${PUBLIC_POST_WHERE} AND ${where.join(' AND ')} LIMIT 1`).get(...args) || null;
  }
  const where = [], args = [];
  if (values.mid !== undefined) { where.push('id = ?'); args.push(values.mid); }
  if (values.slug !== undefined) { where.push('slug = ?'); args.push(values.slug); }
  if (!where.length) return null;
  // Table names originate only from the fixed type list, never from path input.
  return db.prepare(`SELECT id, slug FROM ${type === 'category' ? 'categories' : 'tags'} WHERE ${where.join(' AND ')} LIMIT 1`).get(...args) || null;
}

/**
 * Resolve an encoded pathname in the bootstrap request itself. Re-rendering the
 * real record verifies every captured field; a valid ID alone is insufficient.
 */
export function resolvePermalink(db, path, options = readPermalinkOptions(db)) {
  const segments = pathSegments(path);
  if (!segments) return null;
  const matches = new Map();
  for (const type of ['post', 'page', 'category', 'tag']) {
    for (const template of new Set(['/' + type + '/{slug}', templateFor(type, options)])) {
      let compiled;
      try { compiled = compile(type, template); } catch { continue; }
      const values = captures(compiled, segments);
      if (!values) continue;
      const item = lookup(db, type, values);
      if (!item) continue;
      const canonical = render(compiled, {
        cid: item.id, mid: item.id, slug: item.slug,
        category: item.category_slug, ...dateParts(item),
      });
      if (!canonical || JSON.stringify(pathSegments(canonical)) !== JSON.stringify(segments)) continue;
      const result = { type, slug: item.slug, id: item.id };
      matches.set(type + ':' + item.id, result);
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}
