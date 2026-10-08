/**
 * lill v2 后端 — 纯 REST API 服务
 * 只处理 /api/* 请求，不服务任何静态文件
 */
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { mkdirSync, readFile, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes } from 'node:crypto';

import { uid, slugify, renderMD, plainText } from './lib/utils.js';
import { createAuth } from './lib/auth.js';
import { json, error, parseBody, validators, logRequest } from './lib/http.js';
import { createRouter } from './lib/router.js';
import { register as registerInstall } from './routes/install.js';
import { register as registerPublic } from './routes/public.js';
import { register as registerAuth } from './routes/auth.js';
import { register as registerAdmin } from './routes/admin.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = parseInt(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'lill.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, 'uploads');
const THEMES_DIR = process.env.THEMES_DIR || join(__dirname, '..', 'frontend', 'themes');
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const s = require('node:crypto').randomBytes(32).toString('hex');
  console.warn('⚠️  JWT_SECRET 未设置，已生成随机密钥（重启后失效）');
  return s;
})();

mkdirSync(join(DB_PATH, '..'), { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, nickname TEXT, avatar TEXT, bio TEXT,
    role TEXT DEFAULT 'subscriber', status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL DEFAULT '', html_content TEXT, excerpt TEXT, cover_image TEXT,
    type TEXT DEFAULT 'post', status TEXT DEFAULT 'draft', visibility TEXT DEFAULT 'public',
    password TEXT, comment_allowed INTEGER DEFAULT 1, view_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0, sticky INTEGER DEFAULT 0, "order" INTEGER DEFAULT 0,
    published_at TEXT, author_id TEXT NOT NULL, category_id TEXT, fields TEXT DEFAULT '{}',
    template TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
  CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
  CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type);
  CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category_id);
  CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
  CREATE INDEX IF NOT EXISTS idx_posts_type_status ON posts(type, status);
  CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL,
    description TEXT, parent_id TEXT, sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS post_tags (post_id TEXT, tag_id TEXT, PRIMARY KEY (post_id, tag_id));
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT DEFAULT 'pending',
    user_agent TEXT, ip TEXT, parent_id TEXT, author_name TEXT, author_email TEXT, author_url TEXT,
    post_id TEXT NOT NULL, user_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
  CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
  CREATE INDEX IF NOT EXISTS idx_media_uploader ON media(uploader_id);
  CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, url TEXT NOT NULL,
    mime_type TEXT NOT NULL, size INTEGER DEFAULT 0, width INTEGER, height INTEGER,
    alt TEXT, post_id TEXT, uploader_id TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS options (
    id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL DEFAULT '',
    autoload INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT,
    user_id TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT,
    user_id TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY, theme_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    version TEXT DEFAULT '1.0.0', active INTEGER DEFAULT 0, config TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ════════════════════════════════════════════════════════════
// 结构迁移（幂等）：为历史数据库补齐新增列，老站点升级后自动生效
// 对标 Typecho 的「独立页面自定义模板」：posts.template 保存所选模板 key（page-xxx）
// ════════════════════════════════════════════════════════════
function ensureColumn(table, column, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      console.log(`✓ 迁移：${table}.${column} 已添加`);
    }
  } catch (e) { console.warn(`⚠ 迁移 ${table}.${column} 失败：${e.message}`); }
}
ensureColumn('posts', 'template', "template TEXT DEFAULT ''");
ensureColumn('posts', 'cover_image', 'cover_image TEXT');
ensureColumn('posts', 'sticky', 'sticky INTEGER DEFAULT 0');

// ── 安装状态判定 ──
// 已安装 = options.installed 为 true，或已存在任意用户（兼容历史站点）
function isInstalled() {
  const opt = db.prepare('SELECT value FROM options WHERE key = ?').get('installed');
  if (opt && opt.value === 'true') return true;
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
}
// 兼容已有站点：自动补写 installed 标记，不重复初始化
if (isInstalled() && !db.prepare('SELECT id FROM options WHERE key = ?').get('installed')) {
  db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 1)').run(uid(), 'installed', 'true');
  console.log('✓ 检测到已有站点，已标记为已安装');
}
if (!isInstalled()) {
  console.log('⚠ 尚未安装：请访问 /admin/install/ 完成安装向导');
}

// ── 默认欢迎文章（幂等：仅已安装且没有任何文章时创建，兼容已安装站点）──
{
  const postCount = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c;
  if (isInstalled() && postCount === 0) {
    const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    let cat = db.prepare('SELECT id FROM categories ORDER BY created_at ASC LIMIT 1').get();
    if (!cat) {
      const cid = uid();
      db.prepare('INSERT INTO categories (id, name, slug, description) VALUES (?, ?, ?, ?)').run(cid, '未分类', 'uncategorized', '默认分类');
      cat = { id: cid };
    }
    if (admin) {
      const content = [
        '欢迎使用 **lill** —— 一个轻量、可扩展、前后端分离的博客系统。',
        '',
        '这是系统为你准备的默认文章。你可以直接编辑它，或删除后开始写作。',
        '',
        '## 快速上手',
        '',
        '- **后台地址**：`/admin/`',
        '- **默认账号**：`admin` / `admin123`（请登录后尽快修改密码）',
        '- **更换主题**：后台 → 外观，切换主题并进入主题专属设置',
        '- **发布文章**：后台 → 文章 → 新建文章',
        '',
        '## 为什么选择 lill',
        '',
        '- **前后端分离**：后端只提供 REST API，前端是静态站点，互不耦合',
        '- **主题即模板**：主题放在 `frontend/themes/` 下，用 `theme.json` 声明元数据与设置项',
        '- **主题专属设置**：每个主题可定义自己的设置面板，保存后前台即时生效',
        '- **轻量高性能**：后端基于 Node.js 原生 HTTP + SQLite，无重型框架',
        '',
        '## 开始写作',
        '',
        '现在，去写下你的第一篇文章吧。',
      ].join('\n');
      const pid = uid();
      db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, excerpt, type, status, visibility, published_at, author_id, category_id) VALUES (?, ?, ?, ?, ?, ?, 'post', 'published', 'public', datetime('now'), ?, ?)`)
        .run(pid, 'Hello World', 'hello-world', content, renderMD(content), plainText(content).substring(0, 200), admin.id, cat.id);
      console.log('✓ 已创建默认文章：Hello World');
    }
  }
}

// 默认主题（幂等，兼容已有数据库）
if (!db.prepare('SELECT id FROM themes WHERE theme_id = ?').get('default')) {
  db.prepare('INSERT INTO themes (id, theme_id, name, version, active) VALUES (?, ?, ?, ?, 1)').run(uid(), 'default', '默认主题', '1.0.0');
  console.log('✓ 默认主题已注册');
}

// 扫描主题目录，注册新主题（幂等）
function readThemeManifest(themeId) {
  try {
    const p = join(THEMES_DIR, themeId, 'theme.json');
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}
{
  const themesDir = join(__dirname, '..', 'frontend', 'themes');
  try {
    const themeDirs = readdirSync(themesDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of themeDirs) {
      const manifestPath = join(themesDir, d.name, 'theme.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!db.prepare('SELECT id FROM themes WHERE theme_id = ?').get(manifest.id)) {
          db.prepare('INSERT INTO themes (id, theme_id, name, version, active) VALUES (?, ?, ?, ?, 0)').run(uid(), manifest.id, manifest.name || manifest.id, manifest.version || '1.0.0');
          console.log('✓ 主题已注册:', manifest.id);
        }
      } catch (e) { console.warn('⚠ 主题 manifest 解析失败:', d.name, e.message); }
    }
  } catch (e) { /* 主题目录不存在则跳过 */ }
}

// 必要配置项（幂等，兼容已有数据库）
{
  const defaults = { site_name: 'lill 博客', site_description: '一个轻量可扩展的博客系统', site_url: 'http://test.abohe.cn', posts_per_page: '10', allow_register: 'false', comment_moderation: 'true', active_theme: 'default', permalink: '/archives/{cid}/', category_prefix: '/category/{slug}/', tag_prefix: '/tag/{slug}/' };
  let seeded = 0;
  for (const [k, v] of Object.entries(defaults)) {
    if (!db.prepare('SELECT id FROM options WHERE key = ?').get(k)) {
      db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 1)').run(uid(), k, v);
      seeded++;
    }
  }
  if (seeded) console.log(`✓ 已补齐 ${seeded} 项默认配置`);
}
// 数据修复：已发布但缺少发布时间的历史文章，补上发布时间
try {
  db.prepare("UPDATE posts SET published_at = COALESCE(created_at, datetime('now')) WHERE status = 'published' AND (published_at IS NULL OR published_at = '')").run();
  const needFix = db.prepare("SELECT id, content, excerpt FROM posts WHERE excerpt LIKE '%\n%' OR excerpt LIKE '#%' OR excerpt LIKE '>%' OR excerpt LIKE '- %'").all();
  for (const row of needFix) {
    db.prepare('UPDATE posts SET excerpt = ? WHERE id = ?').run(plainText(row.content).substring(0, 200), row.id);
  }
} catch (e) { console.error('backfill failed:', e.message); }

// ════════════════════════════════════════
// 速率限制（简单内存实现）
// ════════════════════════════════════════
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15分钟
const RATE_LIMIT_MAX = 5; // 登录失败5次后锁定

// 登录限流：只统计失败次数，成功后清零
const loginLimiter = {
  // 是否已被锁定（达到失败上限）
  isBlocked(key) {
    const rec = rateLimit.get(key);
    if (!rec) return false;
    if (Date.now() - rec.first > RATE_LIMIT_WINDOW) { rateLimit.delete(key); return false; }
    return rec.count >= RATE_LIMIT_MAX;
  },
  // 记录一次失败
  fail(key) {
    const now = Date.now();
    const rec = rateLimit.get(key);
    if (!rec || now - rec.first > RATE_LIMIT_WINDOW) rateLimit.set(key, { count: 1, first: now });
    else rec.count++;
  },
  // 成功后清零
  reset(key) { rateLimit.delete(key); },
  // 剩余可尝试次数（供提示）
  remaining(key) {
    const rec = rateLimit.get(key);
    if (!rec || Date.now() - rec.first > RATE_LIMIT_WINDOW) return RATE_LIMIT_MAX;
    return Math.max(0, RATE_LIMIT_MAX - rec.count);
  },
};

// 通用限流（其他接口可按需使用）
function checkRateLimit(key, max = 60, windowMs = 60 * 1000) {
  const now = Date.now();
  const rec = rateLimit.get(key);
  if (!rec || now - rec.first > windowMs) { rateLimit.set(key, { count: 1, first: now }); return true; }
  if (rec.count >= max) return false;
  rec.count++;
  return true;
}

// ════════════════════════════════════════
// 认证
// ════════════════════════════════════════
const { hashPwd, verifyPwd, signJWT, verifyJWT, authenticate } = createAuth(JWT_SECRET);

// ════════════════════════════════════════
// 路由装配（顺序：公开 → 认证 → 后台）
// ════════════════════════════════════════
const router = createRouter();
const ctx = { db, json, error, parseBody, validators, uid, slugify, renderMD, plainText, hashPwd, verifyPwd, signJWT, authenticate, readThemeManifest, UPLOAD_DIR, THEMES_DIR, checkRateLimit, loginLimiter };
registerInstall(router, ctx);
registerPublic(router, ctx);
registerAuth(router, ctx);
registerAdmin(router, ctx);
const REQUEST_TIMEOUT = 20000; // 请求级超时兜底：避免个别慢请求让前端长时间转圈
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const path = req.url.split('?')[0];

  // 兜底超时：到点仍未响应则返回 503，前端可立即提示而非一直等待
  const guard = setTimeout(() => {
    if (!res.headersSent) {
      logRequest(req.method, path, 503, Date.now() - startTime);
      error(res, '请求处理超时，请稍后重试', 503);
    }
  }, REQUEST_TIMEOUT);
  res.on('finish', () => clearTimeout(guard));
  res.on('close', () => clearTimeout(guard));

  // CORS + 安全响应头
  const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://test.abohe.cn';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 上传文件（带安全检查）
  if (path.startsWith('/uploads/')) {
    const fp = join(UPLOAD_DIR, path.replace('/uploads/', ''));
    try {
      const content = await readFile(fp);
      const ext = extname(fp).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
      if (!mime[ext]) { res.writeHead(403); res.end('Forbidden'); return; }
      res.writeHead(200, { 'Content-Type': mime[ext], 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(content);
    } catch { res.writeHead(404); res.end('Not Found'); }
    return;
  }

  // 公开 GET 接口缓存（提升前台性能，后台接口不缓存）
  // 注意：bootstrap 是前台数据的唯一入口，必须每次校验，否则发文章/改设置/换主题后前台会长时间不更新
  if (req.method === 'GET' && path.startsWith('/api/v1/') && !path.startsWith('/api/v1/admin/') && !path.startsWith('/api/v1/install/') && path !== '/api/v1/auth/me') {
    if (path === '/api/v1/site/bootstrap') {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    }
  }

  // API 路由
  const matched = router.matchRoute(req.method, path);
  if (!matched) { logRequest(req.method, path, 404, Date.now() - startTime); return error(res, 'API 不存在', 404); }

  try {
    if (matched.auth) await authenticate(req);
    await matched.fn(req, res, matched.params);
    logRequest(req.method, path, 200, Date.now() - startTime);
  } catch (e) {
    const status = (e.message === '未登录' || e.message === 'Token expired' || e.message === 'Invalid') ? 401 : 500;
    logRequest(req.method, path, status, Date.now() - startTime);
    if (status === 401) error(res, '未登录', 401);
    else { console.error('Internal error:', e); error(res, '服务器内部错误', 500); }
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 30000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🪴 lill v2 API 服务\n  http://localhost:${PORT}/api/v1\n`);
});
