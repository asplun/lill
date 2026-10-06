import { defineConfig } from 'astro/config';
import { cpSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

/**
 * lill 主题发布器
 * 把 frontend/themes/<id>/ 里的「运行时文件」原样拷进 dist/themes/<id>/，
 * 让主题真正实现「拷文件夹即用」。
 *
 * 拷贝白名单：theme.json / *.html / *.css / *.js / assets/**
 * 永不拷贝：*.php（安全）、cache/（缓存）、admin/、api/（源码目录）、._*（macOS 垃圾）
 */
const NEVER_COPY_DIRS = new Set(['cache', 'admin', 'api', 'node_modules', 'src']);
const NEVER_COPY_EXT = new Set(['.php', '.phtml', '.env', '.db', '.sqlite', '.sql']);

function copyThemeDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name.startsWith('._') || name.startsWith('.')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (NEVER_COPY_DIRS.has(name)) continue;
      copyThemeDir(src, dst);
      continue;
    }
    const ext = extname(name).toLowerCase();
    if (NEVER_COPY_EXT.has(ext)) continue;
    cpSync(src, dst);
  }
}

/** @type {import('astro').AstroIntegration} */
const lillThemes = () => ({
  name: 'lill-copy-themes',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const themesSrc = join(process.cwd(), 'themes');
      if (!existsSync(themesSrc)) return;
      const outRoot = join(dir.pathname.replace(/\/$/, ''), 'themes');
      let count = 0;
      for (const d of readdirSync(themesSrc, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.')) continue;
        if (!existsSync(join(themesSrc, d.name, 'theme.json'))) continue;
        copyThemeDir(join(themesSrc, d.name), join(outRoot, d.name));
        count++;
      }
      console.log(`\n  🎨 lill: 已发布 ${count} 个主题到 dist/themes/\n`);
    },
  },
});

export default defineConfig({
  srcDir: './src',
  publicDir: './public',
  outDir: './dist',
  output: 'static',
  integrations: [lillThemes()],
});
