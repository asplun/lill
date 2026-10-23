/** Plugin lifecycle, menus, configuration, install, and uninstall routes. */
import { mkdirSync, writeFileSync, existsSync, renameSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { listZipEntries, readZipEntry, safeEntryPath } from '../../lib/zip.js';
import { rollbackPluginActivation } from '../../lib/plugin-ext.js';

const PLUGIN_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, uid, authenticate, PLUGINS_DIR, activatePlugin, deactivatePlugin, triggerHook, _adminMenus } = ctx;
  const { route, logAction } = helpers;
  const manifestPath = dir => join(PLUGINS_DIR, dir, 'plugin.json');
  const pending = new Set();
  const withPluginOperation = async (dir, res, operation) => {
    if (pending.has(dir)) return error(res, '插件操作正在进行，请稍后重试', 409);
    pending.add(dir);
    try { return await operation(); }
    finally { pending.delete(dir); }
  };

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
            /* 插件是否注册了后台菜单（有自定义面板的插件靠它给入口）。 */
            hasMenu: Array.isArray(_adminMenus) && _adminMenus.some(m => m && m.plugin === entry.name),
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

    return withPluginOperation(body.dir, res, async () => {
      let manifest = {};
      try { manifest = JSON.parse(readFileSync(manifestPath(body.dir), 'utf8')); } catch {}
      const existing = db.prepare('SELECT * FROM plugins WHERE dir = ?').get(body.dir);
      const active = existing ? !existing.active : true;
      let deactivated = false;

      try {
        if (active) {
          const entry = await activatePlugin(body.dir);
          if (!entry) throw new Error('插件未成功加载或未导出 activate');
        } else {
          await deactivatePlugin(body.dir);
          deactivated = true;
        }
        // 生命周期完成之后才保存状态，不能把缺失入口或异步失败误报为成功。
        if (existing) db.prepare('UPDATE plugins SET active = ? WHERE dir = ?').run(active ? 1 : 0, body.dir);
        else db.prepare('INSERT INTO plugins (id, dir, name, version, description, active) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uid(), body.dir, manifest.name || body.dir, manifest.version || '1.0.0', manifest.description || '', active ? 1 : 0);
      } catch (e) {
        if (active) {
          // 包括激活成功但持久化失败；回滚不依赖插件自己的 deactivate 能否成功。
          try { rollbackPluginActivation(body.dir, ctx._activePlugins); }
          catch (cleanupError) { return error(res, '插件启用失败: ' + e.message + '；回滚失败: ' + cleanupError.message, 500); }
        } else if (deactivated) {
          // 数据库仍是启用状态时，恢复运行时，避免显示启用却没有任何注册项。
          try {
            if (!await activatePlugin(body.dir)) throw new Error('插件未成功恢复');
          } catch (restoreError) {
            return error(res, '插件禁用失败: ' + e.message + '；恢复启用状态失败: ' + restoreError.message, 500);
          }
        }
        return error(res, (active ? '插件启用失败: ' : '插件禁用失败: ') + e.message, 500);
      }
      logAction(auth.id, active ? 'plugin.enable' : 'plugin.disable', body.dir, req);
      json(res, { dir: body.dir, active, hot: 'ok', message: active ? '插件已启用' : '插件已禁用' });
    });
  });

  route('POST', '/api/v1/admin/plugins/batch', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!Array.isArray(body.dirs) || !body.dirs.length) return error(res, '请选择插件', 400);
    if (!['activate', 'deactivate', 'uninstall'].includes(body.action)) return error(res, '无效操作', 400);
    const updated = [];
    const skipped = [];
    for (const rawDir of [...new Set(body.dirs)]) {
      const dir = typeof rawDir === 'string' ? rawDir : '';
      if (!PLUGIN_DIR_PATTERN.test(dir) || dir.includes('..')) {
        skipped.push({ dir, reason: '非法插件目录名' });
        continue;
      }
      const pluginPath = join(PLUGINS_DIR, dir);
      if (!existsSync(manifestPath(dir))) {
        skipped.push({ dir, reason: '插件不存在' });
        continue;
      }
      if (pending.has(dir)) {
        skipped.push({ dir, reason: '插件操作正在进行' });
        continue;
      }
      pending.add(dir);
      try {
        const current = !!db.prepare('SELECT active FROM plugins WHERE dir = ?').get(dir)?.active;
        if (body.action === 'activate') {
          if (current) { skipped.push({ dir, reason: '插件已启用' }); continue; }
          const entry = await activatePlugin(dir);
          if (!entry) throw new Error('插件未成功加载或未导出 activate');
          const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8'));
          db.prepare('INSERT INTO plugins (id, dir, name, version, description, active) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(dir) DO UPDATE SET active = 1')
            .run(uid(), dir, manifest.name || dir, manifest.version || '1.0.0', manifest.description || '');
        } else if (body.action === 'deactivate') {
          if (!current) { skipped.push({ dir, reason: '插件已禁用' }); continue; }
          await deactivatePlugin(dir);
          db.prepare('UPDATE plugins SET active = 0 WHERE dir = ?').run(dir);
        } else {
          await deactivatePlugin(dir);
          db.prepare('UPDATE plugins SET active = 0 WHERE dir = ?').run(dir);
          rmSync(pluginPath, { recursive: true, force: true });
          db.prepare('DELETE FROM plugins WHERE dir = ?').run(dir);
        }
        updated.push(dir);
        logAction(auth.id, 'plugin.batch-' + body.action, dir, req);
      } catch (e) {
        skipped.push({ dir, reason: e.message });
      } finally { pending.delete(dir); }
    }
    json(res, { updated, skipped });
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
    const stmt = db.prepare("INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value, autoload = 0, updated_at = datetime('now')");
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
    const body = await parseBody(req, 45 * 1024 * 1024);
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

    return withPluginOperation(dir, res, async () => {
      try { await deactivatePlugin(dir); }
      catch (e) { return error(res, '插件卸载失败（停用失败）: ' + e.message, 500); }
      db.prepare('UPDATE plugins SET active = 0 WHERE dir = ?').run(dir);
      renameSync(pluginPath, join(PLUGINS_DIR, '.trash-' + uid() + '-' + dir));
      db.prepare('DELETE FROM plugins WHERE dir = ?').run(dir);
      logAction(auth.id, 'plugin.uninstall', dir, req);
      json(res, { dir, message: '插件已卸载' });
    });
  });
}
