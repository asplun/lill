/** Dashboard statistics, logs, backups, system diagnostics, and site metadata routes. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, statfsSync, createReadStream, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const BACKUP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, authenticate } = ctx;
  const { route, logAction } = helpers;
  const backendDir = dirname(dirname(ctx.THEMES_DIR));
  const backupDir = join(backendDir, 'data', 'backups');

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
    const dataDir = join(backendDir, 'data');
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const databasePath = join(backupDir, 'lill-backup-' + timestamp + '.db');
    copyFileSync(join(dataDir, 'lill.db'), databasePath);

    let uploads = null;
    const uploadsDir = join(backendDir, 'uploads');
    if (existsSync(uploadsDir)) {
      const uploadsZip = join(backupDir, 'lill-uploads-' + timestamp + '.zip');
      try {
        execSync(`cd "${uploadsDir}" && zip -r "${uploadsZip}" . -x '.*'`, { stdio: 'pipe' });
        uploads = { path: uploadsZip, message: '附件已打包' };
      } catch (e) {
        uploads = { message: '附件打包失败: ' + e.message };
      }
    }

    let cleaned = 0;
    try {
      const now = Date.now();
      for (const file of readdirSync(backupDir)) {
        if (!file.startsWith('lill-backup-')) continue;
        const path = join(backupDir, file);
        if (now - statSync(path).mtimeMs > BACKUP_AGE_MS) { unlinkSync(path); cleaned++; }
      }
    } catch { /* cleanup failure does not fail the backup */ }

    logAction(auth.id, 'backup.create', timestamp, req);
    json(res, { path: databasePath, uploads, cleaned, message: '备份成功' });
  });

  route('GET', '/api/v1/admin/backup/list', async (req, res) => {
    await authenticate(req);
    const backups = [];
    if (existsSync(backupDir)) {
      for (const file of readdirSync(backupDir).filter(name => name.endsWith('.zip') || name.endsWith('.db'))) {
        const stats = statSync(join(backupDir, file));
        backups.push({ name: file, size: stats.size, created_at: stats.mtime.toISOString() });
      }
    }
    json(res, backups.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
  });

  route('GET', '/api/v1/admin/backup/:name/download', async (req, res, params) => {
    await authenticate(req);
    const name = params.name;
    if (!name || name.includes('..') || (!name.endsWith('.zip') && !name.endsWith('.db'))) return error(res, '无效文件名', 400);
    const path = join(backupDir, name);
    if (!path.startsWith(backupDir + '/')) return error(res, '无效文件名', 400);
    if (!existsSync(path)) return error(res, '备份不存在', 404);
    res.setHeader('Content-Type', name.endsWith('.db') ? 'application/octet-stream' : 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    createReadStream(path).pipe(res);
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
