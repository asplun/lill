/**
 * lill 主题后端扩展加载器
 *
 * 约定：`<THEMES_DIR>/<themeId>/backend/index.js` 是该主题的后端扩展入口，可导出：
 *   register(router, ctx)               注册主题私有 API
 *   transformContent(html, info)        输出正文转换钩子（短代码等）
 *   pageTemplate(key, info)             自定义页面模板数据注入钩子
 *   decorateWidgets(rawList)            侧边栏小组件归一化 + 装饰
 *   widgetDefinitions / widgetOrder / widgetGroups
 *
 * core 启动时扫描全部主题扩展；每个扩展注册的接口只在「该主题为当前激活主题」时生效，
 * 因此切换主题立即生效、无需重启进程，也不会出现多主题路由互相覆盖的问题。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function isJunk(name) { return name.startsWith('._') || name.startsWith('.'); }

export async function loadThemeExtensions(themesDir) {
  const exts = new Map();
  let dirs = [];
  try { dirs = readdirSync(themesDir); } catch (e) { return exts; }
  for (const id of dirs.sort()) {
    if (isJunk(id)) continue;
    const dir = join(themesDir, id);
    try { if (!statSync(dir).isDirectory()) continue; } catch (e) { continue; }
    const entry = join(dir, 'backend', 'index.js');
    if (!existsSync(entry)) continue;
    try {
      const mod = await import(pathToFileURL(entry).href);
      exts.set(id, mod);
      console.log(`  ✓ 主题扩展已加载：${id}`);
    } catch (e) {
      console.error(`  ✗ 主题扩展加载失败：${id} — ${e.message}`);
    }
  }
  return exts;
}

/** 当前激活主题 id（激活行优先，其次任意一行，最后 default） */
export function resolveActiveThemeId(db) {
  try {
    const row = db.prepare('SELECT theme_id FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get()
      || db.prepare('SELECT theme_id FROM themes ORDER BY created_at ASC LIMIT 1').get();
    if (row && row.theme_id) return String(row.theme_id);
  } catch (e) { /* ignore */ }
  return 'default';
}

/**
 * 把主题扩展注册到主路由：包装 route()，使每个主题的接口只在「该主题激活时」生效，
 * 非激活主题的接口统一按 404 处理（前端拿到的就是「API 不存在」）。
 */
export function registerThemeExtensions(router, ctx, exts, resolveActiveId, notFound) {
  for (const [id, ext] of exts) {
    if (!ext || typeof ext.register !== 'function') continue;
    const scoped = {
      route(method, path, fn, auth) {
        router.route(method, path, async (req, res, params) => {
          if (resolveActiveId() !== id) return notFound(res);
          return fn(req, res, params);
        }, auth);
      },
    };
    try { ext.register(scoped, ctx); }
    catch (e) { console.error(`  ✗ 主题扩展注册失败：${id} — ${e.message}`); }
  }
}
