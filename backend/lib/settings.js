/** 通用主题与站点设置服务。 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mergeThemeConfig } from './theme-runtime.js';

export function createSettings(db, { themesDir }) {
  const manifestCache = new Map();

  function activeThemeRow() {
    return db.prepare('SELECT * FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get()
      || db.prepare('SELECT * FROM themes ORDER BY created_at ASC LIMIT 1').get()
      || null;
  }

  function manifestOf(themeId) {
    if (!themeId) return null;
    const path = join(themesDir, themeId, 'theme.json');
    let modified = 0;
    try { modified = existsSync(path) ? statSync(path).mtimeMs : 0; } catch { modified = 0; }
    const hit = manifestCache.get(themeId);
    if (hit && hit.modified === modified) return hit.manifest;
    let manifest = null;
    try {
      if (existsSync(path)) manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch { manifest = null; }
    manifestCache.set(themeId, { modified, manifest });
    return manifest;
  }

  function themeConfig() {
    const row = activeThemeRow();
    let saved = {};
    try { saved = row && row.config ? JSON.parse(row.config) : {}; } catch { saved = {}; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    // Core providers may still read older generic settings that are not declared by
    // the active theme. Keep those values internally; public projection filters them.
    return { ...saved, ...mergeThemeConfig(manifestOf(row?.theme_id), saved) };
  }

  let cfgCache = null;
  let cfgAt = 0;
  function cfg() {
    const now = Date.now();
    if (!cfgCache || now - cfgAt > 3000) { cfgCache = themeConfig(); cfgAt = now; }
    return cfgCache;
  }

  function norm(value) {
    if (Array.isArray(value)) return value.join(',');
    if (value === true) return '1';
    if (value === false) return '0';
    return value === undefined || value === null ? '' : String(value);
  }

  function opt(key, def = '') {
    const config = cfg();
    if (!Object.prototype.hasOwnProperty.call(config, key)) return String(def);
    const value = norm(config[key]).trim();
    return value !== '' ? value : String(def);
  }

  function switchOpt(key, def = '1') {
    return ['1', 'true', 'on', 'yes'].includes(opt(key, def).toLowerCase());
  }

  function checked(key) {
    const value = cfg()[key];
    if (Array.isArray(value)) return value.includes('on') || value.includes('1') || value.includes(true);
    const text = norm(value).trim().toLowerCase();
    if (['on', '1', 'true', 'yes'].includes(text)) return true;
    try { const parsed = JSON.parse(text); return Array.isArray(parsed) && parsed.some(v => ['on', '1', true].includes(v)); }
    catch { return false; }
  }

  function option(key, def = '') {
    try {
      const row = db.prepare('SELECT value FROM options WHERE key = ?').get(key);
      if (row && String(row.value).trim() !== '') return String(row.value);
    } catch { /* ignore */ }
    return String(def);
  }

  function siteUrl() { return option('site_url', '').trim().replace(/\/+$/, ''); }
  function siteName() { return option('site_name', '').trim() || option('title', '').trim(); }

  function adminMail() {
    try {
      const row = db.prepare('SELECT email FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get();
      return row?.email ? String(row.email).trim() : '';
    } catch { return ''; }
  }

  function widgetList(key) {
    const raw = cfg()[key];
    if (!raw) return [];
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }

  function invalidate() { cfgCache = null; cfgAt = 0; manifestCache.clear(); }

  return { activeThemeRow, themeConfig, opt, switchOpt, checked, option, siteUrl, siteName, adminMail, widgetList, manifestOf, invalidate };
}
