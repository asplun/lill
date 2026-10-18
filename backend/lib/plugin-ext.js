/**
 * lill 插件运行时
 *
 * 约定：`<PLUGINS_DIR>/<dir>/` 是一个插件目录，含：
 *   plugin.json   清单文件（name, version, description, author）
 *   index.js      入口，导出 activate(ctx) / deactivate(ctx)
 *
 * 插件能力（通过 ctx）：
 *   ctx.route(method, path, fn, auth?)   注册 REST 路由
 *   ctx.on(hookName, handler)            注册 hook 监听
 *   ctx.off(hookName, handler)           取消 hook 监听
 *   ctx.trigger(hookName, ...args)       触发 hook（同进程内广播）
 *   ctx.addAdminMenu(item)               注册后台菜单项
 *   ctx.getConfig(key, default)          读取插件配置
 *   ctx.setConfig(key, value)            写入插件配置
 *   ctx.db                              数据库句柄（只读推荐）
 *
 * 生命周期：
 *   安装 → 写入 plugins 表
 *   启用 → 加载 index.js → 调用 activate(ctx)
 *   禁用 → 调用 deactivate(ctx) → 卸载模块
 *   卸载 → 删除目录 + 数据库记录
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

function isJunk(name) { return name.startsWith('._') || name.startsWith('.'); }

/**
 * 登记内置插件。
 *
 * 内置插件与用户上传插件不同：第一次启动时应立即可用，但不能在后续
 * 启动时覆盖管理员已经保存的启用/停用状态。
 */
export function ensureBuiltinPlugin(db, pluginsDir, dir) {
  if (!db || !pluginsDir || !dir) return false;
  const manifestPath = join(pluginsDir, dir, 'plugin.json');
  if (!existsSync(manifestPath)) return false;
  if (db.prepare('SELECT id FROM plugins WHERE dir = ?').get(dir)) return false;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return false;
  }

  db.prepare('INSERT INTO plugins (id, dir, name, version, description, active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(crypto.randomUUID(), dir, manifest.name || dir, manifest.version || '1.0.0', manifest.description || '');
  return true;
}

/** 扫描插件目录，返回 Map<dir, manifest> */
export function scanPlugins(pluginsDir) {
  const plugins = new Map();
  let dirs = [];
  try { dirs = readdirSync(pluginsDir); } catch (e) { return plugins; }
  for (const dir of dirs.sort()) {
    if (isJunk(dir)) continue;
    const full = join(pluginsDir, dir);
    try { if (!statSync(full).isDirectory()) continue; } catch (e) { continue; }
    const manifestPath = join(full, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (!manifest.name) continue;
      plugins.set(dir, { ...manifest, dir });
    } catch (e) { /* 忽略损坏的 manifest */ }
  }
  return plugins;
}

/** 加载单个插件模块（缓存） */
const moduleCache = new Map();
// 注册项被后继路由引用时仍保留撤销标记；WeakMap 不会延长无引用路由的生命期。
const routeRegistrations = new WeakMap();

export async function loadPlugin(dir, pluginsDir) {
  const entry = join(pluginsDir, dir, 'index.js');
  if (!existsSync(entry)) return null;
  const stat = statSync(entry);
  let manifestVersion = '';
  try { manifestVersion = String(JSON.parse(readFileSync(join(pluginsDir, dir, 'plugin.json'), 'utf8')).version || ''); } catch {}
  const cacheKey = [dir, manifestVersion, stat.mtimeMs, stat.ctimeMs, stat.size].join(':');
  if (moduleCache.has(cacheKey)) return moduleCache.get(cacheKey).mod;
  let copyDir = null;
  try {
    // Native ESM ignores query-only changes for already cached file URLs.
    // A versioned copy gives an upgraded plugin a fresh module graph.
    const stamp = crypto.randomBytes(8).toString('hex');
    copyDir = join(pluginsDir, `.load-${dir}-${stamp}`);
    cpSync(join(pluginsDir, dir), copyDir, { recursive: true });
    const mod = await import(pathToFileURL(join(copyDir, 'index.js')).href + '?v=' + encodeURIComponent(cacheKey));
    moduleCache.set(cacheKey, { mod, loadDir: copyDir });
    return mod;
  } catch (e) {
    if (copyDir) { try { rmSync(copyDir, { recursive: true, force: true }); } catch {} }
    console.error(`  ✗ 插件加载失败：${dir} — ${e.message}`);
    return null;
  }
}

/** 卸载插件模块（清缓存） */
export function unloadPlugin(dir) {
  for (const [key, entry] of moduleCache) {
    if (key !== dir && !key.startsWith(dir + ':')) continue;
    moduleCache.delete(key);
    try { rmSync(entry.loadDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 创建插件上下文
 * @param {object} ctx - 核心上下文（router, db, settings 等）
 * @param {string} pluginDir - 插件目录名
 */
export function createPluginContext(ctx, pluginDir) {
  const hooks = ctx._hooks;
  const pluginsDir = ctx.PLUGINS_DIR || ctx.pluginsDir;

  const registeredRoutes = [];

  return {
    // 路由注册（记录以便停用时摘除）
    route: (method, path, fn, auth) => {
      const previous = ctx.router?.routes?.get(method + ':' + path);
      ctx.route(method, path, fn, auth);
      const registered = ctx.router?.routes?.get(method + ':' + path);
      const registration = { method, path, previous, registered, removed: false };
      registeredRoutes.push(registration);
      if (registered) routeRegistrations.set(registered, registration);
    },

    // 内部：停用清理用
    __core: ctx,
    __routes: registeredRoutes,

    // 常用工具透传
    json: ctx.json,
    error: ctx.error,
    db: ctx.db,
    settings: ctx.settings,
    uid: ctx.uid,

    // Hook 系统
    on: (name, handler) => {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push({ plugin: pluginDir, handler });
    },
    off: (name, handler) => {
      const list = hooks.get(name);
      if (!list) return;
      const idx = list.findIndex(h => h.plugin === pluginDir && h.handler === handler);
      if (idx >= 0) list.splice(idx, 1);
    },

    // 后台菜单
    addAdminMenu: (item) => {
      if (!ctx._adminMenus) ctx._adminMenus = [];
      ctx._adminMenus.push({ plugin: pluginDir, ...item });
    },

    // 配置存储（插件独立命名空间）
    getConfig: (key, def) => {
      const k = `plugin_${pluginDir}_${key}`;
      try {
        const row = ctx.db.prepare('SELECT value FROM options WHERE key = ?').get(k);
        return row ? JSON.parse(row.value) : def;
      } catch { return def; }
    },
    setConfig: (key, value) => {
      const k = `plugin_${pluginDir}_${key}`;
      try {
        ctx.db.prepare("INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value, autoload = 0, updated_at = datetime('now')")
          .run(crypto.randomUUID(), k, JSON.stringify(value));
      } catch { /* ignore */ }
    },

    // 插件目录路径
    dir: join(pluginsDir, pluginDir),
    dirName: pluginDir,

    // 日志
    log: (...args) => console.log(`[plugin:${pluginDir}]`, ...args),
  };
}

/**
 * 加载并激活所有已启用的插件
 * @returns {Map<dir, {manifest, ctx}>}
 */
export async function loadPlugins(pluginsDir, ctx) {
  const active = new Map();
  ctx._activePlugins = active;

  // 只加载数据库中 active=1 的插件；磁盘上未登记或 active=0 的插件一律不加载
  let dirs = [];
  try {
    dirs = ctx.db.prepare('SELECT dir FROM plugins WHERE active = 1').all().map(r => r.dir);
  } catch { /* 表可能不存在 */ }

  for (const dir of dirs) {
    try {
      const entry = await activatePlugin(dir, pluginsDir, ctx);
      console.log(`  ✓ 插件已激活：${entry.manifest.name || dir}`);
    } catch (e) {
      ctx.db.prepare('UPDATE plugins SET active = 0 WHERE dir = ?').run(dir);
      console.error(`  ✗ 插件激活失败：${dir} — ${e.message}`);
    }
  }

  return active;
}

/** 激活单个插件（用于运行时热加载） */
export async function activatePlugin(dir, pluginsDir, ctx) {
  if (!ctx._activePlugins) ctx._activePlugins = new Map();
  if (ctx._activePlugins.has(dir)) return ctx._activePlugins.get(dir);
  const scanned = scanPlugins(pluginsDir);
  const manifest = scanned.get(dir) || { dir, name: dir, version: '1.0.0' };
  const mod = await loadPlugin(dir, pluginsDir);
  if (!mod || typeof mod.activate !== 'function') {
    unloadPlugin(dir);
    throw new Error('插件未成功加载或未导出 activate');
  }
  const pluginCtx = createPluginContext(ctx, dir);
  try {
    await mod.activate(pluginCtx);
  } catch (e) {
    try { clearPluginRegistrations(dir, pluginCtx); }
    finally { unloadPlugin(dir); }
    throw e;
  }
  const entry = { manifest, ctx: pluginCtx, mod };
  ctx._activePlugins.set(dir, entry);
  return entry;
}

/** 回收核心管理的注册项；逆序恢复被覆盖的路由，避免失败插件破坏原有入口。 */
function clearPluginRegistrations(dir, pctx) {
  const core = pctx.__core;
  for (const r of [...(pctx.__routes || [])].reverse()) {
    r.removed = true;
    const routes = core?.router?.routes;
    const key = r.method + ':' + r.path;
    // 其他插件后来接管的入口不能被本次回收误删。
    if (routes && r.registered && routes.get(key) !== r.registered) continue;
    // 被覆盖的插件可能已停用；不能从旧 previous 快照复活其入口。
    let previous = r.previous;
    while (routeRegistrations.get(previous)?.removed) previous = routeRegistrations.get(previous).previous;
    if (routes && previous) routes.set(key, previous);
    else core?.router?.removeRoute?.(r.method, r.path);
  }
  pctx.__routes.length = 0;
  if (core?._hooks) {
    for (const [name, list] of core._hooks) {
      const filtered = list.filter(h => h.plugin !== dir);
      if (filtered.length) core._hooks.set(name, filtered);
      else core._hooks.delete(name);
    }
  }
  if (Array.isArray(core?._adminMenus)) {
    const menus = core._adminMenus;
    for (let i = menus.length - 1; i >= 0; i--) {
      if (menus[i].plugin === dir) menus.splice(i, 1);
    }
  }
}

/** 激活/持久化失败时强制回收注册项，不执行可能再次失败的插件生命周期。 */
export function rollbackPluginActivation(dir, active) {
  const entry = active?.get(dir);
  if (entry) clearPluginRegistrations(dir, entry.ctx);
  unloadPlugin(dir);
  active?.delete(dir);
}

/** 停用失败向调用方抛错，保持启用状态及注册项，允许管理员重试。 */
export async function deactivatePlugin(dir, active) {
  const entry = active.get(dir);
  if (!entry) return;
  if (typeof entry.mod.deactivate === 'function') await entry.mod.deactivate(entry.ctx);
  rollbackPluginActivation(dir, active);
}

/** 触发 hook（同步广播，忽略单个插件错误） */
export function triggerHook(ctx, name, ...args) {
  const hooks = ctx._hooks;
  const list = hooks.get(name);
  if (!list || list.length === 0) return;
  for (const { plugin, handler } of list) {
    try {
      handler(...args);
    } catch (e) {
      console.error(`  ✗ hook 执行失败 [${name}] @${plugin} — ${e.message}`);
    }
  }
}
