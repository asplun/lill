/** Dashboard statistics, logs, backups, system diagnostics, and site metadata routes. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, lstatSync, readFileSync, statfsSync, createReadStream, unlinkSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import * as sqlite from 'node:sqlite';

const BACKUP_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const backendDir = fileURLToPath(new URL('../../', import.meta.url));
const runFile = promisify(execFile);
const isBackupName = name => /^lill-(?:backup-[\w-]+\.db|uploads-[\w-]+\.zip)$/.test(name);

async function snapshotDatabase(sourcePath, targetPath) {
  const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec('PRAGMA busy_timeout=5000');
    if (typeof sqlite.backup === 'function') {
      // Keep the application's write connection separate from the async backup.
      await sqlite.backup(source, targetPath);
    } else {
      // Official SQLite snapshot fallback for Node releases without backup().
      source.prepare('VACUUM main INTO ?').run(targetPath);
    }
    const restored = new sqlite.DatabaseSync(targetPath, { readOnly: true });
    try {
      const schema = restored.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
      const integrity = restored.prepare('PRAGMA quick_check').all();
      if (!schema || integrity.length !== 1 || integrity[0].quick_check !== 'ok') {
        throw new Error('备份数据库结构或完整性校验失败');
      }
    } finally { restored.close(); }
  } finally { source.close(); }
}

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, authenticate } = ctx;
  const { route, logAction } = helpers;
  // Resolve lazily so registration remains usable with lightweight route contexts.
  const getBackupDir = () => {
    if (!ctx.DB_PATH) throw new Error('备份缺少运行上下文 DB_PATH');
    return resolve(dirname(ctx.DB_PATH), 'backups');
  };

  route('GET', '/api/v1/admin/stats/dashboard', async (req, res) => {
    await authenticate(req);
    json(res, {
      overview: {
        postCount: db.prepare("SELECT COUNT(*) as c FROM posts WHERE type = 'post' AND status = 'published'").get().c,
        pageCount: db.prepare("SELECT COUNT(*) as c FROM posts WHERE type = 'page' AND status = 'published'").get().c,
        commentCount: db.prepare("SELECT COUNT(*) as c FROM comments WHERE status = 'approved'").get().c,
        pendingCommentCount: db.prepare("SELECT COUNT(*) as c FROM comments WHERE status = 'pending'").get().c,
        userCount: db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active'").get().c,
      },
    });
  });

  route('GET', '/api/v1/admin/stats/system', async (req, res) => {
    await authenticate(req);
    json(res, {
      nodeVersion: process.version,
      platform: process.platform,
      uptime: Math.floor(process.uptime()),
      dbVersion: db.prepare('SELECT sqlite_version() as v').get().v,
      postCount: db.prepare("SELECT COUNT(*) as c FROM posts WHERE type = 'post'").get().c,
      pageCount: db.prepare("SELECT COUNT(*) as c FROM posts WHERE type = 'page'").get().c,
      commentCount: db.prepare('SELECT COUNT(*) as c FROM comments').get().c,
      categoryCount: db.prepare('SELECT COUNT(*) as c FROM categories').get().c,
      tagCount: db.prepare('SELECT COUNT(*) as c FROM tags').get().c,
      mediaCount: db.prepare('SELECT COUNT(*) as c FROM media').get().c,
      userCount: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    });
  });

  route('GET', '/api/v1/admin/logs', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const pageSize = parseInt(url.searchParams.get('pageSize')) || 20;
    const total = db.prepare('SELECT COUNT(*) as c FROM logs').get().c;
    const items = db.prepare('SELECT l.*, u.username FROM logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize);
    json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
  });

  route('GET', '/api/v1/admin/logs/stats', async (req, res) => {
    await authenticate(req);
    json(res, db.prepare('SELECT COUNT(*) as total, COUNT(DISTINCT action) as actions, COUNT(DISTINCT user_id) as users FROM logs').get());
  });

  route('DELETE', '/api/v1/admin/logs', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    const days = parseInt(body.days) || 30;
    const result = db.prepare("DELETE FROM logs WHERE created_at < datetime('now', '-' || ? || ' days')").run(days);
    logAction(auth.id, 'logs.clean', '清理 ' + days + ' 天前日志', req);
    json(res, { deleted: result.changes });
  });

  route('POST', '/api/v1/admin/backup', async (req, res) => {
    const auth = await authenticate(req);
    const responseClosed = () => res.headersSent || res.writableEnded || res.destroyed || req.aborted;
    if (responseClosed()) return;
    const backupDir = getBackupDir();
    if (!ctx.UPLOAD_DIR) throw new Error('备份缺少运行上下文 UPLOAD_DIR');
    const uploadsDir = resolve(ctx.UPLOAD_DIR);
    if (backupDir === uploadsDir || backupDir.startsWith(uploadsDir + sep)) throw new Error('备份目录不能位于附件目录内');
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(6).toString('hex');
    const databasePath = join(backupDir, 'lill-backup-' + timestamp + '.db');
    const uploadsZip = join(backupDir, 'lill-uploads-' + timestamp + '.zip');
    const stagingDir = mkdtempSync(join(backupDir, '.pending-'));
    const published = [];
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const ensureActive = () => {
      if (responseClosed()) cancel();
      controller.signal.throwIfAborted();
    };
    // A guard response or disconnected client must not leave a backup running.
    res.once('finish', cancel);
    res.once('close', cancel);
    req.once('aborted', cancel);
    let uploads = null;
    try {
      const stagedDatabase = join(stagingDir, 'database.db');
      await snapshotDatabase(resolve(ctx.DB_PATH), stagedDatabase);
      ensureActive();
      chmodSync(stagedDatabase, 0o600);
      if (!statSync(uploadsDir).isDirectory()) throw new Error('附件目录无效');
      const stagedUploads = join(stagingDir, 'uploads.zip');
      if (readdirSync(uploadsDir).length) {
        await runFile('zip', ['-q', '-r', '-y', stagedUploads, '.'], {
          cwd: uploadsDir, timeout: 120000, signal: controller.signal, killSignal: 'SIGKILL',
        });
        ensureActive();
        if (!statSync(stagedUploads).size) throw new Error('附件归档为空');
        chmodSync(stagedUploads, 0o600);
        uploads = { path: uploadsZip, message: '附件已打包' };
      }
      // Publish only after both artifacts have succeeded and the DB was verified.
      ensureActive();
      renameSync(stagedDatabase, databasePath);
      published.push(databasePath);
      if (uploads) { renameSync(stagedUploads, uploadsZip); published.push(uploadsZip); }
    } catch (e) {
      for (const path of published) { try { unlinkSync(path); } catch {} }
      // The timeout/client already owns the response; never write or throw late.
      if (controller.signal.aborted || responseClosed()) return;
      throw e;
    } finally {
      res.off('finish', cancel);
      res.off('close', cancel);
      req.off('aborted', cancel);
      rmSync(stagingDir, { recursive: true, force: true });
    }

    let cleaned = 0;
    try {
      const now = Date.now();
      for (const file of readdirSync(backupDir, { withFileTypes: true })) {
        if (!file.isFile() || !isBackupName(file.name)) continue;
        const path = join(backupDir, file.name);
        if (now - statSync(path).mtimeMs > BACKUP_AGE_MS) { unlinkSync(path); cleaned++; }
      }
    } catch { /* cleanup failure does not fail the backup */ }

    logAction(auth.id, 'backup.create', timestamp, req);
    json(res, { path: databasePath, uploads, cleaned, message: '备份成功' });
  });

  route('GET', '/api/v1/admin/backup/list', async (req, res) => {
    await authenticate(req);
    const backupDir = getBackupDir();
    const backups = [];
    if (existsSync(backupDir)) {
      for (const file of readdirSync(backupDir, { withFileTypes: true })) {
        if (!file.isFile() || !isBackupName(file.name)) continue;
        const stats = statSync(join(backupDir, file.name));
        backups.push({ name: file.name, size: stats.size, created_at: stats.mtime.toISOString() });
      }
    }
    json(res, backups.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
  });

  route('GET', '/api/v1/admin/backup/:name/download', async (req, res, params) => {
    await authenticate(req);
    const name = params.name;
    if (!isBackupName(name)) return error(res, '无效文件名', 400);
    const backupDir = getBackupDir();
    const path = join(backupDir, name);
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (!stats?.isFile()) return error(res, '备份不存在', 404);
    res.setHeader('Content-Type', name.endsWith('.db') ? 'application/octet-stream' : 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.setHeader('Content-Length', stats.size);
    try { await pipeline(createReadStream(path), res); } catch (e) { res.destroy(e); }
  });

  route('GET', '/api/v1/admin/backup/progress', async (req, res) => {
    await authenticate(req);
    json(res, { progress: 0, status: 'idle', message: '同步备份，无需进度' });
  });

  route('GET', '/api/v1/admin/system/version', async (req, res) => {
    await authenticate(req);
    const pkg = JSON.parse(readFileSync(join(backendDir, 'package.json'), 'utf8'));
    json(res, { version: pkg.version || '1.0.0', name: pkg.name || 'lill', node: process.version, platform: process.platform });
  });

  route('GET', '/api/v1/admin/system/health', async (req, res) => {
    await authenticate(req);
    let database = 'ok';
    try { db.prepare('SELECT 1').get(); } catch { database = 'error'; }
    let disk = null;
    try {
      const stats = statfsSync(backendDir);
      disk = { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    } catch { /* disk stats are optional diagnostics */ }
    json(res, {
      status: database === 'ok' ? 'healthy' : 'unhealthy',
      database,
      disk,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  });

  route('GET', '/api/v1/admin/system/monitor', async (req, res) => {
    await authenticate(req);
    const memory = process.memoryUsage();
    json(res, {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        used: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
      },
      cpu: process.cpuUsage(),
      connections: 0,
    });
  });

  route('GET', '/api/v1/admin/sites', async (req, res) => {
    await authenticate(req);
    const site = db.prepare('SELECT * FROM options WHERE key = ?').get('site_name');
    json(res, [{ id: 'default', name: site?.value || '默认站点', domain: req.headers.host }]);
  });
}
