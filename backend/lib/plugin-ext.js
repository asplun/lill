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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function isJunk(name) { return name.startsWith('._') || name.startsWith('.'); }

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

export async function loadPlugin(dir, pluginsDir) {
  const entry = join(pluginsDir, dir, 'index.js');
  if (!existsSync(entry)) return null;
  if (moduleCache.has(dir)) return moduleCache.get(dir);
  try {
    const mod = await import(pathToFileURL(entry).href);
    moduleCache.set(dir, mod);
    return mod;
  } catch (e) {
    console.error(`  ✗ 插件加载失败：${dir} — ${e.message}`);
    return null;
  }
}

/** 卸载插件模块（清缓存） */
export function unloadPlugin(dir) {
  moduleCache.delete(dir);
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
      ctx.route(method, path, fn, auth);
      registeredRoutes.push({ method, path });
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
        ctx.db.prepare('INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(k, JSON.stringify(value));
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

  // 只加载数据库中 active=1 的插件；磁盘上未登记或 active=0 的插件一律不加载
  let dirs = [];
  try {
    dirs = ctx.db.prepare('SELECT dir FROM plugins WHERE active = 1').all().map(r => r.dir);
  } catch { /* 表可能不存在 */ }

  const scanned = scanPlugins(pluginsDir);

  for (const dir of dirs) {
    if (!scanned.has(dir)) continue;
    const manifest = scanned.get(dir) || { dir, name: dir, version: '1.0.0' };
    const mod = await loadPlugin(dir, pluginsDir);
    if (!mod || typeof mod.activate !== 'function') continue;

    const pluginCtx = createPluginContext(ctx, dir);
    try {
      await mod.activate(pluginCtx);
      active.set(dir, { manifest, ctx: pluginCtx, mod });
      console.log(`  ✓ 插件已激活：${manifest.name || dir}`);
    } catch (e) {
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
  if (!mod || typeof mod.activate !== 'function') return null;
  const pluginCtx = createPluginContext(ctx, dir);
  await mod.activate(pluginCtx);
  const entry = { manifest, ctx: pluginCtx, mod };
  ctx._activePlugins.set(dir, entry);
  return entry;
}

/** 停用插件：调用 deactivate + 摘除该插件注册的路由 / hook / 后台菜单 */
export function deactivatePlugin(dir, active) {
  const entry = active.get(dir);
  if (!entry) return;
  const pctx = entry.ctx;
  const core = pctx.__core;

  try {
    if (typeof entry.mod.deactivate === 'function') entry.mod.deactivate(pctx);
  } catch (e) {
    console.error(`  ✗ 插件停用失败：${dir} — ${e.message}`);
  }

  // 摘除路由
  try {
    for (const r of (pctx.__routes || [])) {
      if (core && core.router && typeof core.router.removeRoute === 'function') {
        core.router.removeRoute(r.method, r.path);
      }
    }
  } catch (e) { console.error(`  ✗ 清理插件路由失败：${dir} — ${e.message}`); }

  // 摘除 hook
  try {
    const hooks = core && core._hooks;
    if (hooks) {
      for (const [name, list] of [...hooks]) {
        const filtered = list.filter(h => h.plugin !== dir);
        if (filtered.length) hooks.set(name, filtered); else hooks.delete(name);
      }
    }
  } catch (e) { console.error(`  ✗ 清理插件 hook 失败：${dir} — ${e.message}`); }

  // 摘除后台菜单
  try {
    if (core && Array.isArray(core._adminMenus)) {
      const arr = core._adminMenus;
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].plugin === dir) arr.splice(i, 1);
    }
  } catch (e) { /* ignore */ }

  unloadPlugin(dir);
  active.delete(dir);
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
