/** Generic theme runtime: manifest policy, extension loading, and route isolation. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function fieldsOf(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  if (Array.isArray(manifest.settings) && manifest.settings.length) return manifest.settings;
  return Array.isArray(manifest.groups) ? manifest.groups.flatMap(g => Array.isArray(g?.fields) ? g.fields : []) : [];
}
function normalizeValue(field, value) {
  if (field.type === 'checkbox') return typeof value === 'boolean' ? value : ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
  if (field.type === 'number') { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  return value;
}
function declaredConfig(manifest, saved = {}) {
  const declared = new Map(fieldsOf(manifest).filter(field => field?.key).map(field => [field.key, field]));
  const config = {};
  for (const [key, field] of declared) {
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && Object.hasOwn(saved, key)) config[key] = normalizeValue(field, saved[key]);
    else if (field.default !== undefined && field.default !== null) config[key] = normalizeValue(field, field.default);
  }
  return config;
}
export function mergeThemeConfig(manifest, saved = {}) {
  return declaredConfig(manifest, saved);
}

/** Apply a settings form without deleting legacy keys kept by older theme versions. */
export function updateThemeConfig(manifest, current = {}, patch = {}) {
  const declared = new Map(fieldsOf(manifest).filter(field => field?.key).map(field => [field.key, field]));
  const result = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  for (const [key, field] of declared) {
    if (!Object.hasOwn(result, key) && field.default !== undefined && field.default !== null) {
      result[key] = normalizeValue(field, field.default);
    }
  }
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      if (declared.has(key)) result[key] = normalizeValue(declared.get(key), value);
    }
  }
  return result;
}

export function publicThemeConfig(manifest, config = {}) {
  const declared = new Map(fieldsOf(manifest).filter(f => f?.key && f.private !== true).map(f => [f.key, f])); const output = {};
  // Treat credential-shaped keys as server-only even when an older/third-party manifest forgot `private: true`.
  const credentialKey = /(?:secret|token|password|passwd|pass|cookie|credential|api[_-]?key|access[_-]?key)/i;
  for (const [key, value] of Object.entries(config || {})) {
    if (declared.has(key) && !credentialKey.test(key)) output[key] = normalizeValue(declared.get(key), value);
  }
  return output;
}
async function loadThemeDirectory(themesDir, id, manifests, extensions) {
  if (!id || id.startsWith('.') || id.startsWith('._')) return null;
  const themeDir = join(themesDir, id);
  try {
    if (!statSync(themeDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const manifestPath = join(themeDir, 'theme.json');
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`  ✗ 主题 manifest 解析失败：${id} — ${error.message}`);
    return null;
  }
  if (!manifest || typeof manifest !== 'object' || manifest.id !== id) {
    console.error(`  ✗ 主题目录与 manifest.id 不一致：${id} ≠ ${manifest?.id || 'missing'}`);
    return null;
  }
  const previousManifest = manifests.get(id);

  const declaredEntry = manifest.backend && typeof manifest.backend === 'object'
    ? manifest.backend.entry
    : undefined;
  const entryName = typeof declaredEntry === 'string' && declaredEntry.trim()
    ? declaredEntry.trim()
    : 'backend/index.js';
  const entry = resolve(themeDir, entryName);
  const entryRelative = relative(themeDir, entry);
  if (isAbsolute(entryName) || entryRelative === '' || entryRelative === '..' || entryRelative.startsWith(`..${sep}`)) {
    console.error(`  ✗ 主题后端入口越界：${id} — ${entryName}`);
    manifests.set(id, manifest);
    extensions.delete(id);
    return { manifest, extension: null, loadError: new Error('主题后端入口必须位于主题目录内') };
  }
  if (!existsSync(entry)) {
    manifests.set(id, manifest);
    extensions.delete(id);
    return { manifest, extension: null };
  }
  const previousExtension = extensions.get(id);
  try {
    const stat = statSync(entry);
    const version = `${stat.mtimeMs}-${stat.ctimeMs}-${stat.size}`;
    const extension = await import(`${pathToFileURL(entry).href}?v=${version}`);
    manifests.set(id, manifest);
    extensions.set(id, extension);
    console.log(`  ✓ 主题扩展已加载：${id}`);
    return { manifest, extension };
  } catch (error) {
    if (previousManifest) manifests.set(id, previousManifest);
    else manifests.delete(id);
    if (previousExtension) extensions.set(id, previousExtension);
    else extensions.delete(id);
    console.error(`  ✗ 主题扩展加载失败：${id} — ${error.message}`);
    return { manifest, extension: previousExtension || null, loadError: error };
  }
}

export async function loadThemeRuntime(themesDir) {
  const manifests = new Map();
  const extensions = new Map();
  let dirs;
  try {
    dirs = readdirSync(themesDir);
  } catch {
    return createRuntime(themesDir, manifests, extensions);
  }
  for (const id of dirs.sort()) await loadThemeDirectory(themesDir, id, manifests, extensions);
  return createRuntime(themesDir, manifests, extensions);
}

function createRuntime(themesDir, manifests, extensions) {
  return {
    themesDir,
    manifests,
    extensions,
    manifest: id => manifests.get(id) || null,
    config: (id, saved) => mergeThemeConfig(manifests.get(id), saved),
    publicConfig: (id, saved) => publicThemeConfig(manifests.get(id), mergeThemeConfig(manifests.get(id), saved)),
    normalizeConfig: (id, saved) => mergeThemeConfig(manifests.get(id), saved),
    updateConfig: (id, current, patch) => updateThemeConfig(manifests.get(id), current, patch),
    loadTheme: id => loadThemeDirectory(themesDir, String(id || '').trim(), manifests, extensions),
  };
}

const registeredByRouter = new WeakMap();

function removeRegisteredRoutes(router, registered, keep = new Set()) {
  for (const key of registered?.routes || []) {
    if (keep.has(key)) continue;
    const separator = key.indexOf(':');
    router.removeRoute?.(key.slice(0, separator), key.slice(separator + 1));
  }
}

export function registerThemeExtension(router, ctx, extensions, id, resolveActiveId, notFound) {
  const extension = extensions.get(id) || null;
  let registered = registeredByRouter.get(router);
  if (!registered) {
    registered = new Map();
    registeredByRouter.set(router, registered);
  }
  const previous = registered.get(id);
  if (previous?.extension === extension && extension) return true;

  // Stage the extension first, so a broken upgrade cannot remove the currently working routes.
  const staged = new Map();
  const scoped = {
    core: ctx.core,
    json: ctx.json,
    error: ctx.error,
    settings: ctx.settings,
    route(method, path, handler, auth) {
      staged.set(`${method}:${path}`, { method, path, handler, auth });
    },
  };
  try {
    // Hooks such as extendBootstrap or migrate do not need routes.
    if (typeof extension?.register === 'function') extension.register(scoped, ctx);
    const previousRoutes = previous?.routes || new Set();
    for (const key of staged.keys()) {
      if (router.routes?.has(key) && !previousRoutes.has(key)) throw new Error(`主题扩展路由冲突：${key}`);
    }

    const routes = new Set(staged.keys());
    removeRegisteredRoutes(router, previous, routes);
    for (const [key, { method, path, handler, auth }] of staged) {
      const routeHandler = async (req, res, params) => {
        if (resolveActiveId() !== id) return notFound(res);
        const current = registeredByRouter.get(router)?.get(id);
        const currentHandler = current?.handlers.get(key);
        return currentHandler ? currentHandler(req, res, params) : notFound(res);
      };
      router.route(method, path, routeHandler, auth);
    }
    registered.set(id, { extension, routes, handlers: new Map([...staged].map(([key, value]) => [key, value.handler])) });
    return true;
  } catch (error) {
    if (previous?.extension) extensions.set(id, previous.extension);
    else extensions.delete(id);
    console.error(`  ✗ 主题扩展注册失败：${id} — ${error.message}`);
    return false;
  }
}

export function registerThemeExtensions(router, ctx, extensions, resolveActiveId, notFound) {
  for (const id of extensions.keys()) registerThemeExtension(router, ctx, extensions, id, resolveActiveId, notFound);
}
export async function runThemeMigrations(runtime, themeId, ctx) {
  const extension = runtime.extensions.get(themeId);
  if (!extension) return { themeId, migrated: false, result: undefined };
  // `migrate` is the current protocol; keep the old explicit hook during migration.
  const migrate = typeof extension.migrate === 'function' ? extension.migrate : extension.runThemeMigrations;
  if (typeof migrate !== 'function') return { themeId, migrated: false, result: undefined };
  try { return { themeId, migrated: true, result: await migrate(ctx) }; }
  catch (error) { throw new Error(`主题迁移失败：${themeId}: ${error.message}`, { cause: error }); }
}
export function resolveActiveThemeId(db) {
  try { const row = db.prepare('SELECT theme_id FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get() || db.prepare('SELECT theme_id FROM themes ORDER BY created_at ASC LIMIT 1').get(); if (row?.theme_id) return String(row.theme_id); } catch { /* core can start before metadata exists */ }
  return 'default';
}

/** Run one hook for the active extension without allowing it to break core APIs. */
export async function runActiveThemeHook(extensions, activeId, hookName, args = [], fallback) {
  const extension = extensions && typeof extensions.get === 'function' ? extensions.get(activeId) : null;
  if (!extension || typeof extension[hookName] !== 'function') return fallback;
  try {
    return await extension[hookName](...args);
  } catch (error) {
    console.warn(`主题钩子 ${hookName} 执行失败：${error?.message || error}`);
    return fallback;
  }
}
