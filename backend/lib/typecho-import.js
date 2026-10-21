/**
 * Typecho 1.x 备份导出（.txt）解析器。
 *
 * 格式来源：Typecho 1.x 后台「备份 → 导出」生成的 .txt 是 XML-RPC 文档，
 * 形如 <methodCall><methodName>…</methodName><params><param><value><array><data>，
 * 每个 <value> 是一个文章 <struct>，成员名沿用 post_id/post_title/post_date/
 * post_name/post_content/post_status/post_type，分类与标签是数组。
 * 本模块不依赖第三方 XML 库，只实现该文档用到的子集
 * （struct/array/string/int/i4/boolean/double/dateTime.iso8601/base64），
 * 并对常见字段别名做兼容，见 POST_FIELDS。
 *
 * 解析失败统一抛「不是有效的 Typecho 导出文件」，由路由转成 400。
 */

const INVALID = '不是有效的 Typecho 导出文件';

class XmlReader {
  constructor(source) {
    this.source = source;
    this.pos = 0;
  }

  startsWith(token) {
    return this.source.startsWith(token, this.pos);
  }

  /** 跳过空白、注释与处理指令（<?xml …?>） */
  skipSpace() {
    for (;;) {
      const ch = this.source[this.pos];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { this.pos++; continue; }
      if (this.startsWith('<!--')) {
        const end = this.source.indexOf('-->', this.pos);
        if (end < 0) throw new Error(INVALID);
        this.pos = end + 3;
        continue;
      }
      if (this.startsWith('<?')) {
        const end = this.source.indexOf('?>', this.pos);
        if (end < 0) throw new Error(INVALID);
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  expect(token) {
    this.skipSpace();
    if (!this.startsWith(token)) throw new Error(INVALID);
    this.pos += token.length;
  }

  /** 读取并消费一个开标签，返回标签名 */
  openTag() {
    this.skipSpace();
    const match = /^<([A-Za-z][\w.:-]*)(?:\s[^>]*)?>/.exec(this.source.slice(this.pos, this.pos + 160));
    if (!match) throw new Error(INVALID);
    this.pos += match[0].length;
    return match[1];
  }

  /** 读取到指定闭标签之前的原始文本并消费闭标签 */
  closeTag(name) {
    const marker = '</' + name + '>';
    const end = this.source.indexOf(marker, this.pos);
    if (end < 0) throw new Error(INVALID);
    const text = this.source.slice(this.pos, end);
    this.pos = end + marker.length;
    return text;
  }
}

function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, entity) => {
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
        return String.fromCodePoint(code);
      }
    }
  });
}

/** 标量文本：CDATA 原样返回，其余做实体解码 */
function scalarText(raw) {
  const text = String(raw);
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text);
  return cdata ? cdata[1] : decodeXml(text);
}

function finishScalar(reader, tag, convert) {
  const raw = reader.closeTag(tag);
  reader.skipSpace();
  reader.expect('</value>');
  return convert(scalarText(raw));
}

function parseStruct(reader) {
  const result = {};
  reader.skipSpace();
  while (!reader.startsWith('</struct>')) {
    reader.expect('<member>');
    reader.expect('<name>');
    const name = scalarText(reader.closeTag('name'));
    const value = parseValue(reader);
    reader.expect('</member>');
    result[name] = value;
    reader.skipSpace();
  }
  reader.pos += '</struct>'.length;
  reader.skipSpace();
  reader.expect('</value>');
  return result;
}

function parseArray(reader) {
  const values = [];
  reader.skipSpace();
  if (reader.startsWith('<data/>')) {
    reader.pos += '<data/>'.length;
  } else {
    reader.expect('<data>');
    for (;;) {
      reader.skipSpace();
      if (reader.startsWith('</data>')) break;
      values.push(parseValue(reader));
    }
    reader.pos += '</data>'.length;
  }
  reader.expect('</array>');
  reader.skipSpace();
  reader.expect('</value>');
  return values;
}

function parseValue(reader) {
  reader.skipSpace();
  if (reader.startsWith('<value/>')) {
    reader.pos += '<value/>'.length;
    return '';
  }
  reader.expect('<value>');
  reader.skipSpace();
  if (reader.startsWith('</value>')) {
    reader.pos += '</value>'.length;
    return '';
  }
  const tag = reader.openTag();
  switch (tag) {
    case 'struct': return parseStruct(reader);
    case 'array': return parseArray(reader);
    case 'string': return finishScalar(reader, 'string', text => text);
    case 'int':
    case 'i4':
    case 'i8':
      return finishScalar(reader, tag, text => {
        const number = Number(text.trim());
        return Number.isFinite(number) ? number : 0;
      });
    case 'double':
      return finishScalar(reader, 'double', text => {
        const number = Number(text.trim());
        return Number.isFinite(number) ? number : 0;
      });
    case 'boolean':
      return finishScalar(reader, 'boolean', text => text.trim() === '1');
    case 'dateTime.iso8601':
      return finishScalar(reader, 'dateTime.iso8601', text => text.trim());
    case 'base64':
      return finishScalar(reader, 'base64', text => text.trim());
    default:
      throw new Error(INVALID);
  }
}

const POST_FIELDS = {
  id: ['post_id', 'cid', 'postId'],
  title: ['post_title', 'title'],
  date: ['post_date', 'post_created', 'created', 'post_modified'],
  slug: ['post_name', 'post_slug', 'slug'],
  content: ['post_content', 'post_text', 'content', 'text'],
  status: ['post_status', 'status'],
  type: ['post_type', 'type'],
  categories: ['categories', 'post_categories', 'category'],
  tags: ['tags', 'post_tags', 'tag'],
};

const NAME_KEYS = ['name', 'categoryName', 'category_name', 'tagName', 'title', 'slug'];

function pick(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function nameOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const name = pick(value, NAME_KEYS);
    return typeof name === 'string' ? name.trim() : '';
  }
  return '';
}

function namesOf(value) {
  if (typeof value === 'string') {
    return value.split(/[,，;；]/).map(name => name.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(nameOf).filter(Boolean))];
}

function sqliteTime(match) {
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second || '00'}Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== iso.slice(0, 19)) return null;
  return `${year}-${month}-${day} ${hour}:${minute}:${second || '00'}`;
}

/**
 * 把 Typecho 的发布时间规范成 SQLite 可比较的 UTC 时间字符串。
 * Typecho 备份里可能是 YYYY-MM-DD HH:mm:ss、ISO 8601、dateTime.iso8601
 * （20230506T07:08:09）或 Unix 时间戳；无法识别时返回 null。
 */
export function normalizeTypechoDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replace('T', ' ') : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const dashed = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (dashed) return sqliteTime(dashed);
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2}):?(\d{2}):?(\d{2})/.exec(text);
  if (compact) return sqliteTime(compact);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 19).replace('T', ' ') : null;
}

function looksLikePost(value) {
  return (typeof value.post_title === 'string' || typeof value.title === 'string'
    || typeof value.post_content === 'string' || typeof value.post_text === 'string'
    || typeof value.content === 'string');
}

function collectPostStructs(value, out, depth = 0) {
  if (depth > 24) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPostStructs(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (looksLikePost(value)) { out.push(value); return; }
  for (const key of Object.keys(value)) collectPostStructs(value[key], out, depth + 1);
}

function normalizePost(struct, index) {
  const title = String(pick(struct, POST_FIELDS.title)).trim();
  const content = String(pick(struct, POST_FIELDS.content));
  if (!title && !content) throw new Error(INVALID);
  const rawId = String(pick(struct, POST_FIELDS.id)).trim();
  const rawStatus = String(pick(struct, POST_FIELDS.status)).trim().toLowerCase();
  const rawType = String(pick(struct, POST_FIELDS.type)).trim().toLowerCase();
  return {
    id: rawId || 'auto-' + (index + 1),
    title: title || '未命名',
    slug: String(pick(struct, POST_FIELDS.slug)).trim(),
    content,
    status: rawStatus === 'publish' || rawStatus === 'published' ? 'published' : 'draft',
    type: rawType === 'page' ? 'page' : 'post',
    date: normalizeTypechoDate(pick(struct, POST_FIELDS.date)),
    categories: namesOf(pick(struct, POST_FIELDS.categories)),
    tags: namesOf(pick(struct, POST_FIELDS.tags)),
  };
}

/**
 * 解析 Typecho 1.x 导出文本，返回规范化的内容数组：
 * { id, title, slug, content, status: 'published'|'draft', type: 'post'|'page',
 *   date: 'YYYY-MM-DD HH:mm:ss'|null, categories: string[], tags: string[] }
 * 不是有效导出（没有 XML-RPC 文章结构）时抛「不是有效的 Typecho 导出文件」。
 */
export function parseTypechoExport(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(INVALID);
  const values = [];
  const param = /<param\s*>/g;
  let match;
  while ((match = param.exec(text))) {
    const reader = new XmlReader(text);
    reader.pos = match.index + match[0].length;
    values.push(parseValue(reader));
    param.lastIndex = reader.pos;
  }
  if (!values.length) {
    const reader = new XmlReader(text);
    reader.skipSpace();
    if (!reader.startsWith('<value>')) throw new Error(INVALID);
    values.push(parseValue(reader));
  }
  const posts = [];
  for (const value of values) collectPostStructs(value, posts);
  if (!posts.length) throw new Error(INVALID);
  return posts.map(normalizePost);
}
