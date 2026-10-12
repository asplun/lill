/** Generic theme runtime: manifest policy, extension loading, and route isolation. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
export function mergeThemeConfig(manifest, saved = {}) {
  const declared = new Map(fieldsOf(manifest).filter(f => f?.key).map(f => [f.key, f])); const config = {};
  for (const field of declared.values()) if (field.default !== undefined && field.default !== null) config[field.key] = normalizeValue(field, field.default);
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [key, value] of Object.entries(saved)) if (declared.has(key)) config[key] = normalizeValue(declared.get(key), value);
  return config;
}
export function publicThemeConfig(manifest, config = {}) {
  const declared = new Map(fieldsOf(manifest).filter(f => f?.key && f.private !== true).map(f => [f.key, f])); const output = {};
  for (const [key, value] of Object.entries(config || {})) if (declared.has(key)) output[key] = normalizeValue(declared.get(key), value);
  return output;
}
export async function loadThemeRuntime(themesDir) {
  const manifests = new Map(); const extensions = new Map(); let dirs;
  try { dirs = readdirSync(themesDir); } catch { return createRuntime(manifests, extensions); }
  for (const id of dirs.sort()) {
    if (id.startsWith('.') || id.startsWith('._')) continue;
    const themeDir = join(themesDir, id);
    try { if (!statSync(themeDir).isDirectory()) continue; } catch { continue; }
    let valid = true; const manifestPath = join(themeDir, 'theme.json');
    if (existsSync(manifestPath)) try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest && typeof manifest === 'object' && manifest.id === id) manifests.set(id, manifest);
      else if (manifest?.id !== undefined) { valid = false; console.error(`  ✗ 主题目录与 manifest.id 不一致：${id} ≠ ${manifest.id}`); }
    } catch (error) { valid = false; console.error(`  ✗ 主题 manifest 解析失败：${id} — ${error.message}`); }
    if (!valid) continue;
    const entry = join(themeDir, 'backend', 'index.js'); if (!existsSync(entry)) continue;
    try { extensions.set(id, await import(pathToFileURL(entry).href)); console.log(`  ✓ 主题扩展已加载：${id}`); }
    catch (error) { console.error(`  ✗ 主题扩展加载失败：${id} — ${error.message}`); }
  }
  return createRuntime(manifests, extensions);
}
function createRuntime(manifests, extensions) {
  return { manifests, extensions, manifest: id => manifests.get(id) || null, config: (id, saved) => mergeThemeConfig(manifests.get(id), saved), publicConfig: (id, saved) => publicThemeConfig(manifests.get(id), mergeThemeConfig(manifests.get(id), saved)) };
}
export function registerThemeExtensions(router, ctx, extensions, resolveActiveId, notFound) {
  for (const [id, extension] of extensions) {
    if (!extension || typeof extension.register !== 'function') continue;
    const scoped = { route(method, path, handler, auth) { router.route(method, path, async (req, res, params) => resolveActiveId() !== id ? notFound(res) : handler(req, res, params), auth); } };
    try { extension.register(scoped, ctx); } catch (error) { console.error(`  ✗ 主题扩展注册失败：${id} — ${error.message}`); }
  }
}
export async function runThemeMigrations(runtime, themeId, ctx) {
  const extension = runtime.extensions.get(themeId);
  if (!extension || typeof extension.runThemeMigrations !== 'function') return { themeId, migrated: false, result: undefined };
  try { return { themeId, migrated: true, result: await extension.runThemeMigrations(ctx) }; }
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
