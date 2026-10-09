/**
 * 主题设置读取（对照原版 TriM3 的 tri_opt / tri_switch / tri_checked / tri3_admin_mail）
 *
 * 原版语义（lib/helpers.php:140）：
 *   tri_opt($key, $default) —— 键不存在「或值为空字符串」时返回默认值
 *   tri_switch($key, $default='1') —— tri_opt(...) === '1'
 * 配置来源：themes 表 active=1 那行的 config JSON，缺省值取主题 manifest（theme.json）
 * 的 settings 声明（与 routes/public.js buildThemeOptions 保持一致）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createSettings(db, { themesDir }) {
  const manifestCache = new Map();

  function activeThemeRow() {
    return db.prepare('SELECT * FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get()
      || db.prepare('SELECT * FROM themes ORDER BY created_at ASC LIMIT 1').get()
      || null;
  }

  function manifestOf(themeId) {
    if (!themeId) return null;
    if (manifestCache.has(themeId)) return manifestCache.get(themeId);
    let m = null;
    try {
      const p = join(themesDir, themeId, 'theme.json');
      if (existsSync(p)) m = JSON.parse(readFileSync(p, 'utf8'));
    } catch { m = null; }
    manifestCache.set(themeId, m);
    return m;
  }

  /** 主题 manifest 声明的字段默认值（settings 优先，缺失时退回 groups[].fields[]） */
  function themeDefaults(themeId) {
    const m = manifestOf(themeId);
    const out = {};
    if (!m) return out;
    const put = (f) => {
      if (!f || !f.key) return;
      if (f.default === undefined || f.default === null) return;
      out[f.key] = f.default;
    };
    if (Array.isArray(m.settings) && m.settings.length) {
      m.settings.forEach(put);
    } else if (Array.isArray(m.groups)) {
      m.groups.forEach(g => Array.isArray(g.fields) && g.fields.forEach(put));
    }
    return out;
  }

  /** 主题设置（默认值 + 已保存值），与原版 Helper::options() 等价 */
  function themeConfig() {
    const row = activeThemeRow();
    let saved = {};
    try { saved = row && row.config ? JSON.parse(row.config) : {}; } catch { saved = {}; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    return { ...themeDefaults(row ? row.theme_id : ''), ...saved };
  }

  let cfgCache = null;
  let cfgAt = 0;
  /** 缓存 3 秒：一次请求里多处调用只读一次库，又不会让保存设置后长时间不生效 */
  function cfg() {
    const now = Date.now();
    if (!cfgCache || now - cfgAt > 3000) { cfgCache = themeConfig(); cfgAt = now; }
    return cfgCache;
  }

  function norm(v) {
    if (Array.isArray(v)) return v.join(',');
    if (v === true) return '1';
    if (v === false) return '0';
    return v === undefined || v === null ? '' : String(v);
  }

  /** tri_opt：空值走默认 */
  function opt(key, def = '') {
    const c = cfg();
    if (!Object.prototype.hasOwnProperty.call(c, key)) return String(def);
    const v = norm(c[key]);
    return v.trim() !== '' ? v.trim() : String(def);
  }

  /** tri_switch：值严格等于 '1' 才算开启 */
  function switchOpt(key, def = '1') {
    return opt(key, def) === '1';
  }

  /** tri_checked：复选框型选项（'on' / '1' / ['on'] / '["on"]'） */
  function checked(key) {
    const c = cfg();
    const v = c[key];
    if (Array.isArray(v)) return v.includes('on');
    const s = norm(v).trim();
    if (s === 'on' || s === '1') return true;
    try { const a = JSON.parse(s); return Array.isArray(a) && a.includes('on'); } catch { return false; }
  }

  /** 站点级选项（options 表） */
  function option(key, def = '') {
    try {
      const row = db.prepare('SELECT value FROM options WHERE key = ?').get(key);
      if (row && String(row.value).trim() !== '') return String(row.value);
    } catch { /* ignore */ }
    return String(def);
  }

  /** 站点地址（无尾斜杠） */
  function siteUrl() {
    return option('site_url', '').trim().replace(/\/+$/, '');
  }

  /** 站点名称：主题 authorName 优先，其次 options.title / site_name（对照 tri3_site_name） */
  function siteName() {
    let n = opt('authorName', '').trim();
    if (n === '') n = option('title', '').trim();
    if (n === '') n = option('site_name', '').trim();
    return n;
  }

  /** 系统首个管理员邮箱（对照 tri3_admin_mail：table.users 按 uid 升序第一条） */
  function adminMail() {
    try {
      const row = db.prepare('SELECT email FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1').get();
      if (row && row.email) return String(row.email).trim();
    } catch { /* ignore */ }
    return '';
  }

  /** 主题设置里的「小组件」列表（leftWidgets / rightWidgets），用于取天气等小组件配置 */
  function widgetList(key) {
    const raw = cfg()[key];
    if (!raw) return [];
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function invalidate() { cfgCache = null; cfgAt = 0; }

  return { activeThemeRow, themeConfig, opt, switchOpt, checked, option, siteUrl, siteName, adminMail, widgetList, manifestOf, invalidate };
}
