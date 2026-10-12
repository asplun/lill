/**
 * Generic theme runtime: manifest/config policy and isolated backend extensions.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function isJunk(name) { return name.startsWith('._') || name.startsWith('.'); }

function fieldsOf(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  if (Array.isArray(manifest.settings) && manifest.settings.length) return manifest.settings;
  return Array.isArray(manifest.groups)
    ? manifest.groups.flatMap(group => Array.isArray(group?.fields) ? group.fields : [])
    : [];
}

function normalizeValue(field, value) {
  if (field.type === 'checkbox') {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
  }
  if (field.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  return value;
}

export function mergeThemeConfig(manifest, saved = {}) {
  const fields = fieldsOf(manifest);
  const declared = new Map(fields.filter(field => field && field.key).map(field => [field.key, field]));
  const config = {};
  for (const field of declared.values()) {
    if (field.default !== undefined && field.default !== null) config[field.key] = normalizeValue(field, field.default);
  }
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const [key, value] of Object.entries(saved)) {
      const field = declared.get(key);
      if (field) config[key] = normalizeValue(field, value);
    }
  }
  return config;
}

export function publicThemeConfig(manifest, config = {}) {
  const fields = fieldsOf(manifest);
  const publicFields = new Map(fields
    .filter(field => field && field.key && field.private !== true)
    .map(field => [field.key, field]));
  const output = {};
  for (const [key, value] of Object.entries(config || {})) {
    const field = publicFields.get(key);
    if (field) output[key] = normalizeValue(field, value);
  }
  return output;
}

export async function loadThemeRuntime(themesDir) {
  const manifests = new Map();
  const extensions = new Map();
  let dirs = [];
  try { dirs = readdirSync(themesDir); } catch { return createRuntime(manifests, extensions); }
  for (const id of dirs.sort()) {
    if (isJunk(id)) continue;
    const themeDir = join(themesDir, id);
    try { if (!statSync(themeDir).isDirectory()) continue; } catch { continue; }
    const manifestPath = join(themeDir, 'theme.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest && typeof manifest === 'object') manifests.set(id, manifest);
      } catch (error) {
        console.error(`  ✗ 主题 manifest 解析失败：${id} — ${error.message}`);
      }
    }
    const entry = join(themeDir, 'backend', 'index.js');
    if (!existsSync(entry)) continue;
    try {
      extensions.set(id, await import(pathToFileURL(entry).href));
      console.log(`  ✓ 主题扩展已加载：${id}`);
    } catch (error) {
      console.error(`  ✗ 主题扩展加载失败：${id} — ${error.message}`);
    }
  }
  return createRuntime(manifests, extensions);
}

function createRuntime(manifests, extensions) {
  return {
    manifests,
    extensions,
    manifest: id => manifests.get(id) || null,
    config: (id, saved) => mergeThemeConfig(manifests.get(id), saved),
    publicConfig: (id, saved) => publicThemeConfig(manifests.get(id), mergeThemeConfig(manifests.get(id), saved)),
  };
}

export function registerThemeExtensions(router, ctx, extensions, resolveActiveId, notFound) {
  for (const [id, extension] of extensions) {
    if (!extension || typeof extension.register !== 'function') continue;
    const scoped = {
      route(method, path, handler, auth) {
        router.route(method, path, async (req, res, params) => {
          if (resolveActiveId() !== id) return notFound(res);
          return handler(req, res, params);
        }, auth);
      },
    };
    try { extension.register(scoped, ctx); }
    catch (error) { console.error(`  ✗ 主题扩展注册失败：${id} — ${error.message}`); }
  }
}

export function resolveActiveThemeId(db) {
  try {
    const row = db.prepare('SELECT theme_id FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get()
      || db.prepare('SELECT theme_id FROM themes ORDER BY created_at ASC LIMIT 1').get();
    if (row?.theme_id) return String(row.theme_id);
  } catch { /* core can start before theme metadata exists */ }
  return 'default';
}
