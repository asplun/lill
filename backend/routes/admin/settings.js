/** Site option management routes. */
import { readPermalinkOptions, resolvePermalink, validatePermalinkOptions } from '../../lib/permalinks.js';
import { withTransaction } from './shared.js';
import * as pageCache from '../../lib/page-cache.js';
export function register(router, ctx, helpers) {
  const { db, json, parseBody, uid, authenticate, triggerHook } = ctx;
  const { route } = helpers;

  route('GET', '/api/v1/admin/options', async (req, res) => {
    await authenticate(req);
    json(res, db.prepare('SELECT * FROM options ORDER BY key').all());
  });

  route('POST', '/api/v1/admin/permalinks/resolve', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    if (!body || typeof body.url !== 'string') return ctx.error(res, 'URL 无效', 400);
    let pathname;
    try {
      const url = new URL(body.url, 'http://localhost');
      if (!['http:', 'https:'].includes(url.protocol)) return json(res, { result: null });
      pathname = url.pathname;
    } catch { return json(res, { result: null }); }
    json(res, { result: resolvePermalink(db, pathname) });
  });

  route('PUT', '/api/v1/admin/options', async (req, res) => {
    await authenticate(req);
    const items = await parseBody(req);
    if (!Array.isArray(items)) return ctx.error(res, '设置数据格式错误', 400);
    for (const item of items) {
      if (!item || typeof item.key !== 'string' || !item.key.trim()) return ctx.error(res, '设置键无效', 400);
      if (typeof item.value !== 'string') return ctx.error(res, '设置值必须为字符串', 400);
    }
    if (items.some(item => ['permalink', 'page_pattern', 'category_prefix', 'tag_prefix', 'archive_path', 'search_path'].includes(item.key))) {
      const proposed = { ...readPermalinkOptions(db), ...Object.fromEntries(items.map(item => [item.key, item.value])) };
      const invalid = validatePermalinkOptions(proposed);
      if (invalid) return ctx.error(res, invalid, 400);
    }
    withTransaction(db, () => { for (const item of items) {
      const existing = db.prepare('SELECT id, autoload FROM options WHERE key = ?').get(item.key);
      const autoload = item.autoload !== undefined ? (item.autoload ? 1 : 0) : (existing ? existing.autoload : 1);
      if (existing) db.prepare("UPDATE options SET value = ?, autoload = ?, updated_at = datetime('now') WHERE key = ?").run(item.value ?? '', autoload, item.key);
      else db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, ?)').run(uid(), item.key, item.value ?? '', autoload);
    } });
    try { pageCache.clearAll(); } catch {}
    try { triggerHook('options.saved', items); } catch {}
    json(res, { updated: items.length });
  });
}
