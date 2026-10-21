// All public readers share the publication boundary, including navigation.
import { createHash, timingSafeEqual } from 'node:crypto';

export const PUBLIC_POST_WHERE = `p.status = 'published' AND p.visibility = 'public'
  AND (p.password IS NULL OR p.password = '')
  AND (p.published_at IS NULL OR datetime(p.published_at) <= datetime('now'))`;

// 详情页只要求「已发布」，可见性由路由按作者/管理员与解锁 cookie 单独判定。
export const PUBLISHED_POST_WHERE = `p.status = 'published'
  AND (p.published_at IS NULL OR datetime(p.published_at) <= datetime('now'))`;

/** 密码文章的解锁 cookie 值：密码哈希与文章 id 的 SHA-256，改密码即失效。 */
export function unlockToken(post) {
  if (!post || typeof post.password !== 'string' || !post.password) return null;
  return createHash('sha256').update(post.password + ':' + post.id).digest('hex');
}

/** 请求是否携带本文章的解锁 cookie（仅对设置了密码的文章有意义）。 */
export function isUnlocked(req, post) {
  const expected = unlockToken(post);
  if (!expected) return false;
  const cookie = req && req.headers ? req.headers.cookie : '';
  if (typeof cookie !== 'string' || !cookie) return false;
  const name = 'lill_post_' + post.id;
  let value = null;
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) { value = part.slice(index + 1).trim(); break; }
  }
  if (!value || value.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'));
  } catch { return false; }
}

const PUBLIC_OPTIONS = new Set([
  'site_name', 'site_description', 'site_url', 'posts_per_page', 'allow_register',
  'comment_moderation', 'comment_display', 'comments_disabled', 'comments_per_page',
  'excerpt_length', 'excerpt_type', 'posts_order', 'permalink', 'page_pattern', 'category_prefix', 'tag_prefix',
]);

export function publicOptions(db) {
  const options = {};
  for (const row of db.prepare('SELECT key, value FROM options WHERE autoload = 1').all()) {
    if (PUBLIC_OPTIONS.has(row.key)) options[row.key] = row.value;
  }
  return options;
}
