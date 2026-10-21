import { PUBLIC_POST_WHERE } from './public-content.js';
import { pagePath, readPermalinkOptions } from './permalinks.js';

/** Public navigation candidates. Themes decide which candidates to display. */
export function listNavigationItems(db, { categories, type = 'index', slug = '' } = {}) {
  const cats = categories || db.prepare('SELECT id, name, slug FROM categories ORDER BY sort_order, name').all();
  const pages = db.prepare(`
    SELECT p.id, p.title, p.slug, p.parent_id, p.published_at, p.created_at FROM posts p
    WHERE p.type = 'page' AND ${PUBLIC_POST_WHERE}
    ORDER BY "order" ASC, created_at ASC
  `).all();
  const permalinkOptions = readPermalinkOptions(db);
  const pageUrl = page => {
    try { return pagePath(db, page, permalinkOptions); }
    catch { return '/page/' + encodeURIComponent(page.slug); }
  };
  const pageDepth = page => {
    let depth = 0; const byId = new Map(pages.map(item => [item.id, item]));
    let cursor = page.parent_id ? byId.get(page.parent_id) : null; const seen = new Set([page.id]);
    while (cursor && !seen.has(cursor.id) && depth < 10) { seen.add(cursor.id); depth++; cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null; }
    return depth;
  };
  return [
    { key: 'index', title: '首页', url: '/', type: 'index', slug: '', active: type === 'index' },
    ...cats.map(c => ({
      key: 'category:' + c.id, title: c.name, url: c.route || '/category/' + encodeURIComponent(c.slug),
      type: 'category', slug: c.slug, active: type === 'category' && slug === c.slug,
    })),
    ...pages.map(p => ({
      key: 'page:' + p.id, title: p.title, url: pageUrl(p),
      type: 'page', slug: p.slug, parent_id: p.parent_id || null, depth: pageDepth(p),
      active: type === 'page' && slug === p.slug,
    })),
    { key: 'archive', title: '归档', url: permalinkOptions.archive_path || '/archive', type: 'archive', slug: '', active: type === 'archive' },
  ];
}
