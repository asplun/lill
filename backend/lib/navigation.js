import { PUBLIC_POST_WHERE } from './public-content.js';

/** Public navigation candidates. Themes decide which candidates to display. */
export function listNavigationItems(db, { categories, type = 'index', slug = '' } = {}) {
  const cats = categories || db.prepare('SELECT id, name, slug FROM categories ORDER BY sort_order, name').all();
  const pages = db.prepare(`
    SELECT p.id, p.title, p.slug FROM posts p
    WHERE p.type = 'page' AND ${PUBLIC_POST_WHERE}
    ORDER BY "order" ASC, created_at ASC
  `).all();
  return [
    { key: 'index', title: '首页', url: '/', type: 'index', slug: '', active: type === 'index' },
    ...cats.map(c => ({
      key: 'category:' + c.id, title: c.name, url: c.route || '/category/' + encodeURIComponent(c.slug),
      type: 'category', slug: c.slug, active: type === 'category' && slug === c.slug,
    })),
    ...pages.map(p => ({
      key: 'page:' + p.id, title: p.title, url: '/page/' + encodeURIComponent(p.slug),
      type: 'page', slug: p.slug, active: type === 'page' && slug === p.slug,
    })),
    { key: 'archive', title: '归档', url: '/archive', type: 'archive', slug: '', active: type === 'archive' },
  ];
}
