/** Core reading defaults. Theme defaults are not explicit site overrides. */
export function positiveInteger(value, fallback) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  const number = /^[1-9]\d*$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(number) ? number : fallback;
}

export function pageWindow(page, totalPages, radius = 2) {
  const safePage = Math.min(Math.max(1, Number.isSafeInteger(page) ? page : 1), Math.max(1, totalPages));
  const pages = new Set([1, safePage, Math.max(1, totalPages)]);
  for (let number = safePage - radius; number <= safePage + radius; number++) {
    if (number >= 1 && number <= totalPages) pages.add(number);
  }
  return [...pages].sort((a, b) => a - b);
}

export function readingPolicy(db) {
  const options = Object.fromEntries(db.prepare(`SELECT key, value FROM options WHERE key IN
    ('posts_per_page', 'excerpt_length', 'excerpt_type', 'posts_order', 'comments_per_page', 'comment_display')`).all().map(row => [row.key, row.value]));
  const theme = db.prepare('SELECT config FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get();
  let saved = {};
  try { saved = JSON.parse(theme?.config || '{}'); } catch { /* malformed config follows site settings */ }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  return {
    postsPerPage: positiveInteger(saved.posts_per_page, positiveInteger(saved.pageSize, positiveInteger(options.posts_per_page, 10))),
    excerptLength: positiveInteger(options.excerpt_length, 200),
    excerptHtml: options.excerpt_type === 'html',
    postsOrder: options.posts_order === 'title' ? 'title' : 'date',
    commentsPerPage: positiveInteger(options.comments_per_page, 20),
    commentDisplay: options.comment_display === 'flat' ? 'flat' : 'threaded',
  };
}

export function postsOrderSql(order) {
  return 'p.sticky DESC, ' + (order === 'title' ? 'p.title COLLATE NOCASE ASC, ' : '')
    + 'p.published_at DESC, p.created_at DESC, p.id DESC';
}

function beforeMore(source) {
  // Code examples are not content boundaries.
  const markers = /```[\s\S]*?```|`[^`\n]*`|<!--\s*more\s*-->/gi;
  for (const match of source.matchAll(markers)) {
    if (match[0].startsWith('<!--')) return source.slice(0, match.index);
  }
  return source;
}

const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value) => {
    if (value[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[value.toLowerCase()] || entity;
    const number = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  });
}

/** Deliberately small inline renderer: no attributes, URLs, images or raw HTML. */
function inlineExcerpt(source, length = Infinity) {
  let input = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, tag => /^<\/?(?:strong|em|b|i|s|code)>$/i.test(tag) ? tag.toLowerCase() : ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|>|[-*]|\d+\.)\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\s+/g, ' ').trim();
  const stack = [];
  let text = '', html = '', count = 0, truncated = false;
  for (const part of input.split(/(<\/?(?:strong|em|b|i|s|code)>)/g)) {
    if (!part) continue;
    // Unclosed markup is a text chunk, not a token emitted by the splitter.
    if (/^<\/?(?:strong|em|b|i|s|code)>$/.test(part)) {
      const closing = part[1] === '/';
      const tag = part.replace(/[</>]/g, '');
      if (!closing) { stack.push(tag); html += '<' + tag + '>'; }
      else if (stack.at(-1) === tag) { stack.pop(); html += '</' + tag + '>'; }
      continue;
    }
    const chars = Array.from(decode(part));
    const remaining = Math.max(0, length - count);
    const chunk = chars.slice(0, remaining).join('');
    text += chunk;
    html += escape(chunk);
    count += Array.from(chunk).length;
    if (chars.length > remaining) { truncated = true; break; }
  }
  while (stack.length) html += '</' + stack.pop() + '>';
  return { text: text.trim() + (truncated ? '…' : ''), html: html.trim() + (truncated ? '…' : '') };
}

export function excerptFor(post, policy) {
  // No read-time guessing: an explicit manual flag wins even if it equals old auto text.
  const automatic = post.excerpt_auto === 1 || (post.excerpt_auto == null && !post.excerpt);
  const source = automatic ? beforeMore(String(post.content || '')) : String(post.excerpt || '');
  const result = inlineExcerpt(source, automatic ? policy.excerptLength : Infinity);
  return {
    excerpt: automatic ? result.text : String(post.excerpt || ''),
    excerpt_auto: automatic ? 1 : 0,
    excerpt_html: policy.excerptHtml ? result.html : '',
  };
}

export function commentPagination(total, replyTotal, topLevelTotal, display, page, pageSize) {
  const paginationTotal = display === 'flat' ? total : topLevelTotal;
  const totalPages = Math.max(1, Math.ceil(paginationTotal / pageSize));
  const pages = pageWindow(page, totalPages);
  return {
    total, replyTotal, topLevelTotal, paginationTotal, page, pageSize, totalPages,
    hasNext: page < totalPages, hasPrev: page > 1, pages,
  };
}
