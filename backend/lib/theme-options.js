/**
 * 主题配置读取（运行时抓取层的公共依赖）
 *
 * 主题扩展可以通过这些通用工具读取 themes.config（JSON）和 theme.json 中声明的默认值。
 *
 * 合并规则与 routes/public.js 的 buildThemeOptions() 保持一致：
 *   1) 先铺 theme.json settings 的 default
 *   2) 再覆盖数据库里已保存的 config
 *   3) 按 manifest 声明的 type 规整：checkbox -> 布尔，number -> Number
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeThemeConfig as mergeRuntimeThemeConfig } from './theme-runtime.js';

export const THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'themes');
export const FALLBACK_THEME_ID = 'default';

/* theme.json 体积偏大（通用主题协议），按 mtime 做进程内缓存，避免每次抓取都读盘 */
const manifestCache = new Map();

export function readManifest(themeId) {
  const id = String(themeId || '').trim();
  if (!id) return null;
  const p = join(THEMES_DIR, id, 'theme.json');
  try {
    const st = statSync(p);
    const hit = manifestCache.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    manifestCache.set(id, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch (e) { return null; }
}

/* 与核心主题 runtime 的 config 合并规则保持一致。 */
export function mergeThemeConfig(saved, manifest) {
  return mergeRuntimeThemeConfig(manifest, saved);
}

/* 取值并 trim，空串回落默认值。 */
export function themeOpt(cfg, key, def = '') {
  const v = cfg ? cfg[key] : undefined;
  if (v === undefined || v === null) return String(def);
  const s = String(v).trim();
  return s === '' ? String(def) : s;
}

/* 开关值：0/false/off/no/空视为关，其余为开。 */
export function themeSwitch(cfg, key, def = '1') {
  const s = themeOpt(cfg, key, def).toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

/* 取整数并按原版的 max/min 夹取 */
export function themeRange(cfg, key, def, min, max) {
  let n = parseInt(themeOpt(cfg, key, String(def)), 10);
  if (!Number.isFinite(n)) n = def;
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}

/* 复选框组：数组直接取值，逗号/换行串切分。 */
export function themeCheckedArr(cfg, key) {
  const v = cfg ? cfg[key] : undefined;
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (v === undefined || v === null) return [];
  return String(v).split(/[\r\n,，]+/).map(x => x.trim()).filter(Boolean);
}

export function siteUrlOf(db) {
  try {
    const row = db.prepare('SELECT value FROM options WHERE key = ?').get('site_url');
    const v = row && row.value ? String(row.value).trim() : '';
    return v ? v.replace(/\/+$/, '') : '';
  } catch (e) { return ''; }
}

/* 一次取齐抓取层需要的上下文：生效主题配置 + 主题 id + 站点根地址 */
export function themeContext(db) {
  let row = null;
  try { row = db.prepare('SELECT theme_id, config FROM themes WHERE active = 1').get(); } catch (e) { row = null; }
  if (!row) {
    try { row = db.prepare('SELECT theme_id, config FROM themes WHERE theme_id = ?').get(FALLBACK_THEME_ID); } catch (e) { row = null; }
  }
  const themeId = row && row.theme_id ? String(row.theme_id) : FALLBACK_THEME_ID;
  let saved = {};
  try { saved = JSON.parse((row && row.config) || '{}'); } catch (e) { saved = {}; }
  return { themeId, cfg: mergeThemeConfig(saved, readManifest(themeId)), siteUrl: siteUrlOf(db) };
}

/* 主题目录下的缓存目录（原版是 __DIR__ . '/../cache/xxx'，lill 主题根是 frontend/themes/<id>） */
export function themeCacheDir(themeId, name) {
  return join(THEMES_DIR, String(themeId || FALLBACK_THEME_ID), 'cache', name);
}

/* 缓存文件对外可访问的站点地址（nginx 直接托管 /themes/**） */
export function themeCacheUrl(siteUrl, themeId, name, file) {
  const base = String(siteUrl || '').replace(/\/+$/, '');
  return base + '/themes/' + String(themeId || FALLBACK_THEME_ID) + '/cache/' + name + '/' + file;
}
