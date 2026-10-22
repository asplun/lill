const TTL_MS = 300 * 1000;
const MAX_ENTRIES = 300;
const store = new Map();
const stats = { hits: 0, misses: 0, sets: 0, clears: 0 };

export function get(key) {
  const item = store.get(key);
  if (!item) { stats.misses++; return null; }
  if (Date.now() > item.expireAt) { store.delete(key); stats.misses++; return null; }
  stats.hits++;
  return item.body;
}

export function set(key, body) {
  if (!body || !body.length) return;
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { body, expireAt: Date.now() + TTL_MS });
  stats.sets++;
}

export function clearAll() {
  store.clear();
  stats.clears++;
}

export function info() {
  return { size: store.size, ttlMs: TTL_MS, max: MAX_ENTRIES, ...stats };
}
