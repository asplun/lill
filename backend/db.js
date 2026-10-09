/**
 * lill 数据库层 — node:sqlite (Node.js 22+ 内置)
 * 核心表结构在此定义，主题扩展表由 themes/<id>/migration.js 管理
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'lill.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ════════════════════════════════════════════════════════════
// 核心表结构（与主题无关）
// ════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    nickname    TEXT,
    avatar      TEXT,
    bio         TEXT,
    role        TEXT DEFAULT 'subscriber',
    status      TEXT DEFAULT 'active',
    created_at  TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at  TEXT DEFAULT (CURRENT_TIMESTAMP)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    content       TEXT NOT NULL DEFAULT '',
    html_content  TEXT,
    excerpt       TEXT,
    cover_image   TEXT,
    type          TEXT DEFAULT 'post',
    status        TEXT DEFAULT 'draft',
    visibility    TEXT DEFAULT 'public',
    password      TEXT,
    comment_allowed INTEGER DEFAULT 1,
    view_count    INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    sticky        INTEGER DEFAULT 0,
    sort_order    INTEGER DEFAULT 0,
    published_at  TEXT,
    author_id     TEXT NOT NULL,
    category_id   TEXT,
    template      TEXT DEFAULT '',
    fields        TEXT DEFAULT '{}',
    created_at    TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at    TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY (author_id) REFERENCES users(id),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );
  CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
  CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
  CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at);

  CREATE TABLE IF NOT EXISTS categories (
    id          TEXT PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    slug        TEXT UNIQUE NOT NULL,
    description TEXT,
    parent_id   TEXT,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY (parent_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    name       TEXT UNIQUE NOT NULL,
    slug       TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );

  CREATE TABLE IF NOT EXISTS post_tags (
    post_id TEXT NOT NULL,
    tag_id  TEXT NOT NULL,
    PRIMARY KEY (post_id, tag_id),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    user_agent  TEXT,
    ip          TEXT,
    parent_id   TEXT,
    author_name TEXT,
    author_email TEXT,
    author_url  TEXT,
    post_id     TEXT NOT NULL,
    user_id     TEXT,
    created_at  TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at  TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY (parent_id) REFERENCES comments(id),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);

  CREATE TABLE IF NOT EXISTS widgets (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    content    TEXT,
    position   TEXT DEFAULT 'sidebar',
    sort_order INTEGER DEFAULT 0,
    enabled    INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );

  CREATE TABLE IF NOT EXISTS post_versions (
    id         TEXT PRIMARY KEY,
    post_id    TEXT NOT NULL,
    title      TEXT,
    content    TEXT,
    html_content TEXT,
    excerpt    TEXT,
    status     TEXT,
    author_id  TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS media (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    path         TEXT NOT NULL,
    url          TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    size         INTEGER DEFAULT 0,
    width        INTEGER,
    height       INTEGER,
    alt          TEXT,
    thumbnail_url TEXT,
    post_id      TEXT,
    uploader_id  TEXT,
    created_at   TEXT DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL,
    FOREIGN KEY (uploader_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS options (
    id         TEXT PRIMARY KEY,
    key        TEXT UNIQUE NOT NULL,
    value      TEXT NOT NULL DEFAULT '',
    autoload   INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id         TEXT PRIMARY KEY,
    action     TEXT NOT NULL,
    detail     TEXT,
    user_id    TEXT,
    ip         TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );

  CREATE TABLE IF NOT EXISTS themes (
    id         TEXT PRIMARY KEY,
    theme_id   TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    version    TEXT DEFAULT '1.0.0',
    active     INTEGER DEFAULT 0,
    config     TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
  );
  CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    dir TEXT UNIQUE NOT NULL,
    name TEXT,
    version TEXT,
    description TEXT,
    active INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

`);

// ════════════════════════════════════════════════════════════
// 结构迁移（幂等）：为历史数据库补齐新增列
// 对标 Typecho 的「页面自定义模板」：posts.template 保存所选模板文件名
// ════════════════════════════════════════════════════════════
function ensureColumn(table, column, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      console.log(`✓ 迁移：${table}.${column} 已添加`);
    }
  } catch (e) { console.warn(`⚠ 迁移 ${table}.${column} 失败：`, e.message); }
}
ensureColumn('posts', 'template', "template TEXT DEFAULT ''");
ensureColumn('posts', 'cover_image', 'cover_image TEXT');
ensureColumn('posts', 'sticky', 'sticky INTEGER DEFAULT 0');

// ════════════════════════════════════════════════════════════
// 默认数据初始化
// ════════════════════════════════════════════════════════════
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('myadmin');
if (!adminExists) {
  const uid = crypto.randomUUID();
  const { scryptSync, randomBytes } = await import('node:crypto');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync('admin123', salt, 64).toString('hex');
  db.prepare('INSERT INTO users (id, username, email, password, nickname, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid, 'myadmin', 'admin@lill.local', `${salt}:${hash}`, '管理员', 'admin');

  const catId = crypto.randomUUID();
  db.prepare('INSERT INTO categories (id, name, slug, description) VALUES (?, ?, ?, ?)')
    .run(catId, '未分类', 'uncategorized', '默认分类');

  const postId = crypto.randomUUID();
  db.prepare(`INSERT INTO posts (id, title, slug, content, html_content, excerpt, type, status, visibility, published_at, author_id, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`)
    .run(postId, '欢迎使用 lill', 'hello-lill', '# 欢迎使用 lill\n\nlill 是一个轻量、可扩展的博客系统。', '<h1>欢迎使用 lill</h1><p>lill 是一个轻量、可扩展的博客系统。</p>', '欢迎使用 lill', 'post', 'published', 'public', uid, catId);

  const defaults = {
    site_name: 'lill 博客',
    site_description: '一个轻量可扩展的博客系统',
    site_url: 'http://localhost:3000',
    posts_per_page: '10',
    allow_register: 'false',
    comment_moderation: 'true',
    active_theme: 'trim3',
  };
  for (const [key, value] of Object.entries(defaults)) {
    db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 1)').run(crypto.randomUUID(), key, value);
  }

  console.log('✓ 默认数据已初始化 | 管理员: myadmin / admin123');
}
