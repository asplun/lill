/**
 * lill 主题扫描工具
 * - scanThemeAssets:   扫描主题运行时资源（head.html / theme.js / style.css / 模板列表）
 * - scanPageTemplates: 扫描主题提供的「页面自定义模板」（对标 Typecho 的 page-*.php）
 *
 * 页面模板约定：
 *   1) 文件名形如 page-<name>.html（page.html 是默认页面模板，不算自定义模板）
 *   2) 模板显示名优先级：
 *        a. 文件首行注释  <!--! 友情链接 -->   或   <!-- name: 友情链接 -->
 *        b. theme.json 中 templates: [{ "file": "page-links.html", "name": "友情链接" }]
 *        c. 文件名（page-links → page-links）
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// macOS 归档工具会产生 ._xxx / .DS_Store 之类的垃圾文件，一律忽略
function isJunk(name) { return name.startsWith('._') || name.startsWith('.'); }

export function scanThemeAssets(themeId, themesDir) {
  const out = { head: false, script: false, style: false, templates: [] };
  try {
    for (const f of readdirSync(join(themesDir, themeId))) {
      if (isJunk(f)) continue;
      if (f === 'head.html') out.head = true;
      else if (f === 'theme.js') out.script = true;
      else if (f === 'style.css') out.style = true;
      else if (f.endsWith('.html')) out.templates.push(f.replace(/\.html$/, ''));
    }
  } catch (e) { /* 主题目录不存在则跳过 */ }
  return out;
}

// 从模板文件头部注释里取显示名
function readTemplateLabel(filePath) {
  try {
    const head = readFileSync(filePath, 'utf8').slice(0, 400);
    let m = head.match(/<!--\s*!\s*([^>]{1,40}?)\s*-->/);
    if (m) return m[1].trim();
    m = head.match(/<!--\s*name\s*:\s*([^>]{1,40}?)\s*-->/i);
    if (m) return m[1].trim();
  } catch (e) { /* ignore */ }
  return '';
}

export function scanPageTemplates(themeId, themesDir) {
  const dir = join(themesDir, themeId);
  let files = [];
  try { files = readdirSync(dir); } catch (e) { return []; }

  // theme.json 显式声明（可选，用于排序 / 自定义显示名）
  let declared = [];
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8'));
    if (Array.isArray(manifest.templates)) {
      declared = manifest.templates.filter(t => t && t.file).map(t => ({ file: t.file, name: t.name || '' }));
    }
  } catch (e) { /* ignore */ }

  const out = [];
  const seen = new Set();

  // 1) 显式声明的优先，按声明顺序
  for (const d of declared) {
    if (isJunk(d.file)) continue;
    if (!/^[\w.-]+\.html$/i.test(d.file)) continue;
    if (!files.includes(d.file)) continue;
    if (d.file === 'page.html') continue;
    seen.add(d.file);
    out.push({
      key: d.file.replace(/\.html$/i, ''),
      file: d.file,
      name: d.name || readTemplateLabel(join(dir, d.file)) || d.file.replace(/\.html$/i, ''),
    });
  }

  // 2) 自动发现 page-*.html
  for (const f of files.sort()) {
    if (isJunk(f)) continue;
    if (!/^page-[\w-]+\.html$/i.test(f)) continue;
    if (seen.has(f)) continue;
    out.push({
      key: f.replace(/\.html$/i, ''),
      file: f,
      name: readTemplateLabel(join(dir, f)) || f.replace(/\.html$/i, ''),
    });
  }
  return out;
}
