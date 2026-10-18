// All public readers share the publication boundary, including navigation.
export const PUBLIC_POST_WHERE = `p.status = 'published' AND p.visibility = 'public'
  AND (p.password IS NULL OR p.password = '')
  AND (p.published_at IS NULL OR datetime(p.published_at) <= datetime('now'))`;

const PUBLIC_OPTIONS = new Set([
  'site_name', 'site_description', 'site_url', 'posts_per_page', 'allow_register',
  'comment_moderation', 'comment_display', 'comments_disabled', 'comments_per_page',
  'excerpt_length', 'excerpt_type', 'posts_order', 'permalink', 'category_prefix', 'tag_prefix',
]);

export function publicOptions(db) {
  const options = {};
  for (const row of db.prepare('SELECT key, value FROM options WHERE autoload = 1').all()) {
    if (PUBLIC_OPTIONS.has(row.key)) options[row.key] = row.value;
  }
  return options;
}
