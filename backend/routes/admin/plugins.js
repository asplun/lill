/** Plugin lifecycle, menus, configuration, install, and uninstall routes. */
import { mkdirSync, writeFileSync, existsSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { listZipEntries, readZipEntry, safeEntryPath } from '../../lib/zip.js';

const PLUGIN_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, uid, authenticate, PLUGINS_DIR, activatePlugin, deactivatePlugin, triggerHook, _adminMenus } = ctx;
  const { route, logAction } = helpers;
  const manifestPath = dir => join(PLUGINS_DIR, dir, 'plugin.json');

  route('GET', '/api/v1/admin/plugins', async (req, res) => {
    await authenticate(req);
    const plugins = [];
    if (existsSync(PLUGINS_DIR)) {
      for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const path = manifestPath(entry.name);
        if (!existsSync(path)) continue;
        try {
          const manifest = JSON.parse(readFileSync(path, 'utf8'));
          const active = db.prepare('SELECT active FROM plugins WHERE dir = ?').get(entry.name);
          const { settings, ...meta } = manifest;
          plugins.push({
            ...meta,
            dir: entry.name,
            active: active ? !!active.active : false,
            hasSettings: Array.isArray(settings) && settings.length > 0,
          });
        } catch { /* invalid plugin manifests remain hidden until fixed */ }
      }
    }
    json(res, plugins);
  });

  route('POST', '/api/v1/admin/plugins/toggle', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!body.dir || !PLUGIN_DIR_PATTERN.test(body.dir) || body.dir.includes('..')) return error(res, '非法插件目录名', 400);
    if (!existsSync(manifestPath(body.dir))) return error(res, '插件不存在', 404);

    let manifest = {};
    try { manifest = JSON.parse(readFileSync(manifestPath(body.dir), 'utf8')); } catch {}
    const existing = db.prepare('SELECT * FROM plugins WHERE dir = ?').get(body.dir);
    const active = existing ? !existing.active : true;
    if (existing) db.prepare('UPDATE plugins SET active = ? WHERE dir = ?').run(active ? 1 : 0, body.dir);
    else db.prepare('INSERT INTO plugins (id, dir, name, version, description, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uid(), body.dir, manifest.name || body.dir, manifest.version || '1.0.0', manifest.description || '', active ? 1 : 0);

    let hot = 'ok';
    try {
      if (active) await activatePlugin(body.dir);
      else deactivatePlugin(body.dir);
    } catch (e) {
      hot = 'reload_failed: ' + e.message;
    }
    logAction(auth.id, active ? 'plugin.enable' : 'plugin.disable', body.dir, req);
    json(res, { dir: body.dir, active, hot, message: active ? '插件已启用' : '插件已禁用' });
  });

  route('GET', '/api/v1/admin/plugin-menus', async (req, res) => {
    await authenticate(req);
    json(res, Array.isArray(_adminMenus) ? _adminMenus.slice().sort((a, b) => (a.order || 0) - (b.order || 0)) : []);
  });

  route('GET', '/api/v1/admin/plugins/:dir/config', async (req, res, params) => {
    await authenticate(req);
    const dir = params.dir;
    if (!PLUGIN_DIR_PATTERN.test(dir) || dir.includes('..')) return error(res, '非法插件目录名', 400);
    if (!existsSync(manifestPath(dir))) return error(res, '插件不存在', 404);
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')); } catch {}
    const schema = Array.isArray(manifest.settings) ? manifest.settings : [];
    const values = {};
    for (const field of schema) {
      if (!field?.key) continue;
      const row = db.prepare('SELECT value FROM options WHERE key = ?').get(`plugin_${dir}_${field.key}`);
      if (row) {
        try { values[field.key] = JSON.parse(row.value); } catch { values[field.key] = row.value; }
      } else if (field.default !== undefined) values[field.key] = field.default;
    }
    json(res, { dir, name: manifest.name || dir, active: !!db.prepare('SELECT active FROM plugins WHERE dir = ?').get(dir)?.active, schema, values });
  });

  route('PUT', '/api/v1/admin/plugins/:dir/config', async (req, res, params) => {
    const auth = await authenticate(req);
    const dir = params.dir;
    if (!PLUGIN_DIR_PATTERN.test(dir) || dir.includes('..')) return error(res, '非法插件目录名', 400);
    if (!existsSync(manifestPath(dir))) return error(res, '插件不存在', 404);

    const body = await parseBody(req);
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8')); } catch {}
    const schema = Array.isArray(manifest.settings) ? manifest.settings : [];
    const coerce = (field, value) => {
      if (field.type === 'checkbox') return value === true || value === 'true' || value === '1' || value === 1;
      if (field.type === 'number') { const number = Number(value); return Number.isFinite(number) ? number : 0; }
      return value;
    };
    const stmt = db.prepare("INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')");
    let saved = 0;
    for (const field of schema) {
      if (!field?.key || !Object.prototype.hasOwnProperty.call(body, field.key)) continue;
      stmt.run(uid(), `plugin_${dir}_${field.key}`, JSON.stringify(coerce(field, body[field.key])));
      saved++;
    }
    try { triggerHook('plugin.config.saved', { dir, values: body }); } catch {}
    logAction(auth.id, 'plugin.config.save', dir, req);
    json(res, { dir, saved, message: '设置已保存' });
  });

  route('POST', '/api/v1/admin/plugins/install', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!body.name || !body.data) return error(res, '缺少插件数据', 400);

    let buf;
    try { buf = Buffer.from(body.data, 'base64'); }
    catch { return error(res, '无效的数据', 400); }

    mkdirSync(PLUGINS_DIR, { recursive: true });
    const tmpDir = join(PLUGINS_DIR, '.tmp-' + uid());
    mkdirSync(tmpDir, { recursive: true });

    try {
      const entries = listZipEntries(buf);
      const topDirs = new Set();
      for (const entry of entries) {
        const first = entry.name.split('/').filter(Boolean)[0];
        if (first) topDirs.add(first);
      }
      const targetDir = topDirs.size === 1 ? [...topDirs][0] : String(body.name || '').replace(/\.[^.]+$/, '');
      if (!PLUGIN_DIR_PATTERN.test(targetDir) || targetDir.includes('..')) {
        return error(res, '插件目录名非法（仅允许字母、数字、- _ .，且以字母或数字开头）', 400);
      }

      for (const entry of entries) {
        if (entry.rawSize === 0 && entry.name.endsWith('/')) continue;
        const rel = entry.name.split('/').filter(Boolean).slice(topDirs.size === 1 ? 1 : 0).join('/');
        if (!rel) continue;
        const safeRel = safeEntryPath(rel);
        if (!safeRel) continue;
        const safe = join(tmpDir, safeRel);
        if (!safe.startsWith(tmpDir + '/')) continue;
        mkdirSync(dirname(safe), { recursive: true });
        writeFileSync(safe, readZipEntry(buf, entry));
      }

      if (!existsSync(join(tmpDir, 'plugin.json'))) return error(res, 'ZIP 中未找到 plugin.json', 400);
      let manifest;
      try { manifest = JSON.parse(readFileSync(join(tmpDir, 'plugin.json'), 'utf8')); }
      catch { return error(res, 'plugin.json 格式错误', 400); }

      const finalDir = join(PLUGINS_DIR, targetDir);
      if (!finalDir.startsWith(PLUGINS_DIR + '/')) return error(res, '非法插件目录名', 400);
      if (existsSync(finalDir)) renameSync(finalDir, join(PLUGINS_DIR, '.bak-' + uid() + '-' + targetDir));
      renameSync(tmpDir, finalDir);

      if (!db.prepare('SELECT id FROM plugins WHERE dir = ?').get(targetDir)) {
        db.prepare('INSERT INTO plugins (id, dir, name, version, description, active) VALUES (?, ?, ?, ?, ?, 0)')
          .run(uid(), targetDir, manifest.name || targetDir, manifest.version || '1.0.0', manifest.description || '');
      }

      logAction(auth.id, 'plugin.install', targetDir, req);
      json(res, { dir: targetDir, name: manifest.name || targetDir, version: manifest.version || '1.0.0', message: '插件已安装，请在列表中启用' }, 201);
    } catch (e) {
      try {
        for (const file of readdirSync(tmpDir)) renameSync(join(tmpDir, file), join(PLUGINS_DIR, '.trash-' + uid() + '-' + file));
      } catch { /* cleanup failure should not hide the original error */ }
      return error(res, '安装失败: ' + e.message, 400);
    }
  });

  route('DELETE', '/api/v1/admin/plugins/:dir', async (req, res, params) => {
    const auth = await authenticate(req);
    const dir = params.dir;
    if (!PLUGIN_DIR_PATTERN.test(dir) || dir.includes('..')) return error(res, '非法插件目录名', 400);
    const pluginPath = join(PLUGINS_DIR, dir);
    if (!pluginPath.startsWith(PLUGINS_DIR + '/')) return error(res, '非法插件目录名', 400);
    if (!existsSync(pluginPath)) return error(res, '插件不存在', 404);

    try { deactivatePlugin(dir); } catch {}
    db.prepare('UPDATE plugins SET active = 0 WHERE dir = ?').run(dir);
    renameSync(pluginPath, join(PLUGINS_DIR, '.trash-' + uid() + '-' + dir));
    db.prepare('DELETE FROM plugins WHERE dir = ?').run(dir);
    logAction(auth.id, 'plugin.uninstall', dir, req);
    json(res, { dir, message: '插件已卸载' });
  });
}
