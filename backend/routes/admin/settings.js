/** Site option management routes. */
export function register(router, ctx, helpers) {
  const { db, json, parseBody, uid, authenticate, triggerHook } = ctx;
  const { route } = helpers;

  route('GET', '/api/v1/admin/options', async (req, res) => {
    await authenticate(req);
    json(res, db.prepare('SELECT * FROM options ORDER BY key').all());
  });

  route('PUT', '/api/v1/admin/options', async (req, res) => {
    await authenticate(req);
    const items = await parseBody(req);
    if (!Array.isArray(items)) return ctx.error(res, '设置数据格式错误', 400);
    for (const item of items) {
      if (!item || typeof item.key !== 'string' || !item.key.trim()) return ctx.error(res, '设置键无效', 400);
      const existing = db.prepare('SELECT id, autoload FROM options WHERE key = ?').get(item.key);
      const autoload = item.autoload !== undefined ? (item.autoload ? 1 : 0) : (existing ? existing.autoload : 1);
      if (existing) db.prepare("UPDATE options SET value = ?, autoload = ?, updated_at = datetime('now') WHERE key = ?").run(item.value ?? '', autoload, item.key);
      else db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, ?)').run(uid(), item.key, item.value ?? '', autoload);
    }
    try { triggerHook('options.saved', items); } catch {}
    json(res, { updated: items.length });
  });
}
