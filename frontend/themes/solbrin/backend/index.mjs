export function extendBootstrap(view, { config }) {
  const items = new Map((view.nav || []).map(item => [item.key, item]));
  const selected = Array.isArray(config.navigation) ? config.navigation : ['index', 'archive'];
  const categories = new Map((view.sidebar?.categories || []).map(item => [item.slug, item.url]));
  const tags = new Map((view.sidebar?.tags || []).map(item => [item.slug, item.url]));

  const decoratePost = post => {
    if (!post || typeof post !== 'object') return;
    if (post.category_slug && categories.has(post.category_slug)) post.category_url = categories.get(post.category_slug);
    if (Array.isArray(post.tags)) {
      post.tags.forEach(tag => {
        if (tag?.slug && tags.has(tag.slug)) tag.url = tags.get(tag.slug);
      });
    }
  };

  Object.values(view.data || {}).forEach(value => {
    if (Array.isArray(value)) value.forEach(decoratePost);
  });
  decoratePost(view.data?.post);
  const heroPosts = (view.data?.posts || []).slice(0, 3).map(post => ({
    title: post.title || '',
    description: String(post.excerpt || post.excerpt_html || '').replace(/<[^>]*>/g, '').trim(),
    cover: post.cover_image || '',
    url: post.url || '',
    category: post.category_name || ''
  }));
  return {
    navigation: [...new Set(selected)].map(key => items.get(key)).filter(Boolean),
    heroPosts
  };
}
