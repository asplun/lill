/** Public navigation candidates. Themes decide which candidates to display. */
export function listNavigationItems(db, { categories, type = 'index', slug = '' } = {}) {
  const cats = categories || db.prepare('SELECT id, name, slug FROM categories ORDER BY sort_order, name').all();
  const pages = db.prepare(`
    SELECT id, title, slug FROM posts
    WHERE type = 'page' AND status = 'published' AND visibility = 'public'
      AND (password IS NULL OR password = '')
    ORDER BY "order" ASC, created_at ASC
  `).all();
  return [
    { key: 'index', title: '首页', url: '/', type: 'index', slug: '', active: type === 'index' },
    ...cats.map(c => ({
      key: 'category:' + c.id, title: c.name, url: '/category/' + c.slug,
      type: 'category', slug: c.slug, active: type === 'category' && slug === c.slug,
    })),
    ...pages.map(p => ({
      key: 'page:' + p.id, title: p.title, url: '/page/' + p.slug,
      type: 'page', slug: p.slug, active: type === 'page' && slug === p.slug,
    })),
    { key: 'archive', title: '归档', url: '/archive', type: 'archive', slug: '', active: type === 'archive' },
  ];
}
