/** Theme management, settings, installer, and editor routes. */
import { mkdirSync, writeFileSync, existsSync, renameSync, readdirSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listZipEntries, readZipEntry, safeEntryPath } from '../../lib/zip.js';
import { runThemeMigrations } from '../../lib/theme-runtime.js';
import { listNavigationItems } from '../../lib/navigation.js';

const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const THEME_ALLOWED_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.txt', '.md', '.map', '.xml', '.webmanifest']);

// Settings pages are static theme assets, subject to the theme publisher's directory exclusions.
const PRIVATE_THEME_DIRS = new Set(['backend', 'cache', 'admin', 'api', 'node_modules', 'src']);
function themeSettingsUrl(themeId, manifest, themesDir) {
  const page = typeof manifest?.settingsPage === 'string' ? manifest.settingsPage.trim() : '';
  const parts = page.split('/');
  if (!THEME_ID_PATTERN.test(themeId) || !/\.html?$/i.test(page) ||
      parts.some(part => !/^[a-z0-9_-][a-z0-9_.-]*$/i.test(part) || PRIVATE_THEME_DIRS.has(part.toLowerCase()))) return '';
  try {
    const dir = realpathSync(join(themesDir, themeId));
    const file = realpathSync(join(dir, page));
    if (!file.startsWith(dir + sep) || !statSync(file).isFile()) return '';
  } catch { return ''; }
  return '/themes/' + encodeURIComponent(themeId) + '/' + parts.map(encodeURIComponent).join('/');
}

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, uid, authenticate, readThemeManifest, THEMES_DIR, triggerHook, themeRuntime } = ctx;
  const { route, logAction } = helpers;

  route('GET', '/api/v1/admin/themes', async (req, res) => {
    await authenticate(req);
    const themes = db.prepare('SELECT * FROM themes ORDER BY name').all();
    const result = themes.map(theme => {
      const manifest = readThemeManifest(theme.theme_id);
      if (manifest) {
        const name = manifest.name || theme.name;
        const version = manifest.version || theme.version;
        if (name !== theme.name || version !== theme.version) {
          db.prepare('UPDATE themes SET name = ?, version = ? WHERE theme_id = ?').run(name, version, theme.theme_id);
        }
      }
      const settingsUrl = themeSettingsUrl(theme.theme_id, manifest, THEMES_DIR);
      return {
        ...theme,
        name: manifest?.name || theme.name,
        version: manifest?.version || theme.version,
        description: manifest?.description || theme.description || '',
        author: manifest?.author || theme.author || '',
        settingsUrl,
        hasSettings: !!(settingsUrl || (Array.isArray(manifest?.settings) && manifest.settings.length)),
      };
    });
    json(res, result);
  });

  route('POST', '/api/v1/admin/themes/:themeId/activate', async (req, res, params) => {
    await authenticate(req);
    const themeId = String(params.themeId || '').trim();
    if (!THEME_ID_PATTERN.test(themeId)) return error(res, '主题 ID 无效', 400);
    const manifest = readThemeManifest(themeId);
    const registeredTheme = db.prepare('SELECT id FROM themes WHERE theme_id = ?').get(themeId);
    if ((!manifest || manifest.id !== themeId) && !(themeId === 'default' && registeredTheme)) {
      return error(res, '主题不存在或 manifest 无效', 404);
    }
    const previous = db.prepare('SELECT theme_id FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get()?.theme_id || 'default';
    const previousManifest = themeRuntime?.manifests?.get(themeId);
    const previousExtension = themeRuntime?.extensions?.get(themeId);
    let migrationDb = null;
    try {
      const loadedTheme = themeRuntime?.loadTheme ? await themeRuntime.loadTheme(themeId) : null;
      if (loadedTheme?.loadError) throw new Error('主题后端扩展加载失败');
      // Register the new handlers before migrations so a migration can safely
      // exercise extension routes; restore the previous handlers on failure.
      if (typeof ctx.registerThemeExtension === 'function' && themeRuntime?.extensions && !ctx.registerThemeExtension(themeId)) {
        throw new Error(`主题扩展注册失败：${themeId}`);
      }
      // Theme migrations can await I/O. Keep their transaction on a dedicated
      // connection so an activation failure can never roll back unrelated writes
      // that arrived on the shared request connection while migration was pending.
      if (ctx.DB_PATH) {
        migrationDb = new DatabaseSync(ctx.DB_PATH);
        migrationDb.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN');
      }
      try {
        await runThemeMigrations(themeRuntime, themeId, { ...ctx, db: migrationDb || db, themeId });
        migrationDb?.exec('COMMIT');
      } catch (migrationError) {
        try { migrationDb?.exec('ROLLBACK'); } catch {}
        throw migrationError;
      } finally {
        migrationDb?.close();
        migrationDb = null;
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!db.prepare('SELECT id FROM themes WHERE theme_id = ?').get(themeId)) {
          db.prepare('INSERT INTO themes (id, theme_id, name, version, active) VALUES (?, ?, ?, ?, 0)').run(uid(), themeId, manifest?.name || themeId, manifest?.version || '1.0.0');
        }
        db.prepare('UPDATE themes SET active = 0').run();
        db.prepare('UPDATE themes SET active = 1 WHERE theme_id = ?').run(themeId);
        db.prepare("INSERT INTO options (id, key, value, autoload) VALUES (?, 'active_theme', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(uid(), themeId);
        db.exec('COMMIT');
      } catch (activationError) {
        try { db.exec('ROLLBACK'); } catch {}
        throw activationError;
      }
    } catch (migrationError) {
      try { migrationDb?.exec('ROLLBACK'); } catch {}
      try { migrationDb?.close(); } catch {}
      if (themeRuntime?.manifests) {
        if (previousManifest) themeRuntime.manifests.set(themeId, previousManifest);
        else themeRuntime.manifests.delete(themeId);
      }
      if (themeRuntime?.extensions) {
        if (previousExtension) themeRuntime.extensions.set(themeId, previousExtension);
        else themeRuntime.extensions.delete(themeId);
      }
      // If registration succeeded but DB commit failed, restore the old route handlers too.
      if (typeof ctx.registerThemeExtension === 'function' && themeRuntime?.extensions) {
        ctx.registerThemeExtension(themeId);
      }
      console.error(`✗ 主题激活失败：${themeId}`, migrationError);
      return error(res, migrationError.message || `主题迁移失败：${themeId}`, 500);
    }
    try { triggerHook('theme.activated', { themeId, previousThemeId: previous }); } catch {}
    json(res, { themeId, active: true });
  });

  route('GET', '/api/v1/admin/themes/:themeId/settings', async (req, res, params) => {
    await authenticate(req);
    if (themeRuntime?.loadTheme) await themeRuntime.loadTheme(params.themeId);
    const theme = db.prepare('SELECT * FROM themes WHERE theme_id = ?').get(params.themeId);
    if (!theme) return error(res, '主题不存在', 404);
    const manifest = readThemeManifest(params.themeId);
    if (!manifest || manifest.id !== params.themeId) return error(res, '主题不存在或 manifest 无效', 404);
    const activeTheme = db.prepare('SELECT theme_id FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get()?.theme_id;
    if (activeTheme === params.themeId && typeof ctx.registerThemeExtension === 'function' &&
        !ctx.registerThemeExtension(params.themeId)) {
      return error(res, '主题扩展注册失败，请重新启用主题', 500);
    }
    let config = {};
    try { config = JSON.parse(theme.config || '{}'); } catch {}
    const schema = (manifest.settings || []).map(field => field.type === 'navigation'
      ? { ...field, options: listNavigationItems(db).map(item => ({ value: item.key, label: item.title, url: item.url })) }
      : field);
    json(res, { theme, schema, values: config, settingsUrl: themeSettingsUrl(params.themeId, manifest, THEMES_DIR) });
  });

  route('PUT', '/api/v1/admin/themes/:themeId/settings', async (req, res, params) => {
    await authenticate(req);
    if (themeRuntime?.loadTheme) await themeRuntime.loadTheme(params.themeId);
    const body = await parseBody(req);
    const theme = db.prepare('SELECT * FROM themes WHERE theme_id = ?').get(params.themeId);
    if (!theme) return error(res, '主题不存在', 404);
    let config = {};
    try { config = JSON.parse(theme.config || '{}'); } catch {}
    const merged = themeRuntime?.updateConfig
      ? themeRuntime.updateConfig(params.themeId, config, body)
      : { ...config, ...body };
    db.prepare('UPDATE themes SET config = ? WHERE theme_id = ?').run(JSON.stringify(merged), params.themeId);
    json(res, merged);
  });

  route('POST', '/api/v1/admin/themes/install', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req, 45 * 1024 * 1024);
    if (!body || !body.data) return error(res, '缺少主题包数据', 400);

    let buf;
    try { buf = Buffer.from(String(body.data).replace(/^data:[^,]*,/, ''), 'base64'); }
    catch { return error(res, '主题包数据无效', 400); }
    if (buf.length < 22) return error(res, '主题包为空或已损坏', 400);
    if (buf.length > 30 * 1024 * 1024) return error(res, '主题包过大（上限 30MB）', 400);

    let entries;
    try { entries = listZipEntries(buf); }
    catch (e) { return error(res, e.message, 400); }
    if (!entries.length) return error(res, '主题包为空', 400);

    let manifestEntry = null;
    let prefix = '';
    for (const entry of entries) {
      const path = safeEntryPath(entry.name);
      if (path && path.endsWith('theme.json') && path.split('/').length <= 2) {
        manifestEntry = entry;
        prefix = path.slice(0, -'theme.json'.length);
        break;
      }
    }
    if (!manifestEntry) return error(res, '主题包内未找到 theme.json（必须位于根目录或一级子目录）', 400);

    let manifest;
    try { manifest = JSON.parse(readZipEntry(buf, manifestEntry).toString('utf8')); }
    catch (e) { return error(res, 'theme.json 解析失败：' + e.message, 400); }

    const themeId = String(manifest.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(themeId)) return error(res, 'theme.json 的 id 非法（仅允许字母、数字、- 和 _，且以字母或数字开头）', 400);
    if (!manifest.name) return error(res, 'theme.json 缺少 name 字段', 400);

    const destDir = join(THEMES_DIR, themeId);
    const staging = destDir + '.staging-' + Date.now().toString(36);
    mkdirSync(staging, { recursive: true });

    let written = 0;
    let skipped = 0;
    try {
      for (const entry of entries) {
        const path = safeEntryPath(entry.name);
        if (!path || path.endsWith('/')) continue;
        if (prefix && !path.startsWith(prefix)) continue;
        const rel = prefix ? path.slice(prefix.length) : path;
        if (!rel || rel.startsWith('__MACOSX/') || rel.split('/').some(part => part === '__MACOSX' || part.startsWith('._'))) { skipped++; continue; }
        const dot = rel.lastIndexOf('.');
        const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
        if (!THEME_ALLOWED_EXT.has(ext)) { skipped++; continue; }
        const target = join(staging, rel);
        if (!target.startsWith(staging + '/')) { skipped++; continue; }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readZipEntry(buf, entry));
        written++;
      }
    } catch (e) {
      return error(res, '解压失败：' + e.message, 400);
    }
    if (!written) return error(res, '主题包内没有可用的静态文件', 400);
    if (!existsSync(join(staging, 'theme.json'))) return error(res, '主题包缺少 theme.json', 400);

    if (existsSync(destDir)) {
      try { renameSync(destDir, destDir + '.bak-' + Date.now().toString(36)); }
      catch (e) { return error(res, '旧主题目录无法替换：' + e.message, 500); }
    }
    try { renameSync(staging, destDir); }
    catch (e) { return error(res, '安装失败：' + e.message, 500); }

    if (!db.prepare('SELECT id FROM themes WHERE theme_id = ?').get(themeId)) {
      db.prepare('INSERT INTO themes (id, theme_id, name, version, active) VALUES (?, ?, ?, ?, 0)').run(uid(), themeId, manifest.name, manifest.version || '1.0.0');
    } else {
      db.prepare('UPDATE themes SET name = ?, version = ? WHERE theme_id = ?').run(manifest.name, manifest.version || '1.0.0', themeId);
    }
    logAction(auth.id, 'theme.install', themeId + ' (' + written + ' files, ' + skipped + ' skipped)', req);
    json(res, { themeId, name: manifest.name, version: manifest.version || '1.0.0', files: written, skipped }, 201);
  });

  route('GET', '/api/v1/admin/themes/files', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const themeId = url.searchParams.get('theme') || 'default';
    const themeDir = join(THEMES_DIR, themeId);
    if (!existsSync(themeDir)) return error(res, '主题不存在', 404);
    if (!themeDir.startsWith(THEMES_DIR + '/')) return error(res, '无效主题', 400);
    const files = [];
    const scan = (dir, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name.startsWith('._')) continue;
        const rel = prefix + entry.name;
        if (entry.isDirectory()) scan(join(dir, entry.name), rel + '/');
        else if (/\.(html|css|js|json|md)$/i.test(entry.name)) files.push({ path: rel, size: statSync(join(dir, entry.name)).size });
      }
    };
    scan(themeDir);
    json(res, files);
  });

  route('GET', '/api/v1/admin/themes/file', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const themeId = url.searchParams.get('theme') || 'default';
    const filePath = url.searchParams.get('path') || '';
    if (!filePath || filePath.includes('..')) return error(res, '无效路径', 400);
    const fullPath = join(THEMES_DIR, themeId, filePath);
    if (!fullPath.startsWith(THEMES_DIR + '/')) return error(res, '无效路径', 400);
    if (!existsSync(fullPath)) return error(res, '文件不存在', 404);
    json(res, { content: readFileSync(fullPath, 'utf8') });
  });

  route('PUT', '/api/v1/admin/themes/file', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    const themeId = body.theme || 'default';
    const filePath = body.path || '';
    if (!filePath || filePath.includes('..')) return error(res, '无效路径', 400);
    const fullPath = join(THEMES_DIR, themeId, filePath);
    if (!fullPath.startsWith(THEMES_DIR + '/')) return error(res, '无效路径', 400);
    if (!existsSync(fullPath)) return error(res, '文件不存在', 404);
    if (typeof body.content !== 'string') return error(res, '文件内容无效', 400);
    writeFileSync(fullPath, body.content, 'utf8');
    logAction(auth.id, 'theme.file.save', themeId + '/' + filePath, req);
    json(res, { message: '保存成功' });
  });
}
