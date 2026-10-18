/** Navigation selection belongs to this theme; the core supplies public candidates. */
export function extendBootstrap(view, { config }) {
  const items = new Map(view.nav.map(item => [item.key, item]));
  const selected = Array.isArray(config.navigation) ? config.navigation : ['index', 'archive'];
  return { navigation: [...new Set(selected)].map(key => items.get(key)).filter(Boolean) };
}
