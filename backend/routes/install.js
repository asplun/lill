/**
 * lill 安装向导 API
 * - GET  /api/v1/install/status  安装状态 + 环境检查
 * - POST /api/v1/install         执行安装（仅未安装时可用）
 *
 * 设计目标：对标 Typecho / WordPress 的首次安装体验
 * 安装完成后创建：管理员账号、站点信息、默认分类、默认主题、Hello World 文章
 */
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function register(router, ctx) {
  const { db, json, error, parseBody, validators, uid, slugify, renderMD, plainText, hashPwd, signJWT, checkRateLimit } = ctx;
  const route = router.route;

  // 已安装判定：options.installed 为 true，或已存在任意用户（兼容历史站点）
  function isInstalled() {
    const opt = db.prepare('SELECT value FROM options WHERE key = ?').get('installed');
    if (opt && opt.value === 'true') return true;
    return db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
  }

  // 环境检查项
  function runChecks() {
    const checks = [];
    // Node.js 版本
    const nodeVer = process.version;
    const major = parseInt(nodeVer.replace('v', '').split('.')[0], 10);
    // node:sqlite 需要 Node 22+（18/20 不支持）
    checks.push({ name: 'Node.js 版本', pass: major >= 22, detail: nodeVer + (major >= 22 ? '' : '（需要 >= 22，当前版本不支持 node:sqlite）') });
    // SQLite 支持
    let sqliteVer = 'unknown';
    try { sqliteVer = db.prepare('SELECT sqlite_version() AS v').get().v; } catch (e) { /* ignore */ }
    checks.push({ name: 'SQLite 支持', pass: sqliteVer !== 'unknown', detail: sqliteVer });
    // 数据目录可写
    let dataWritable = false;
    let dataDetail = '';
    try {
      const dir = join(process.cwd(), 'data');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      dataWritable = true;
      dataDetail = '可写';
    } catch (e) { dataDetail = e.message; }
    checks.push({ name: '数据目录权限', pass: dataWritable, detail: dataDetail });
    // 数据库可读写
    let dbOk = false;
    try { db.prepare('SELECT 1 AS ok').get(); dbOk = true; } catch (e) { /* ignore */ }
    checks.push({ name: '数据库连接', pass: dbOk, detail: dbOk ? '正常' : '失败' });
    return checks;
  }

  // ── 安装状态 ──
  route('GET', '/api/v1/install/status', async (req, res) => {
    json(res, { installed: isInstalled(), checks: runChecks() });
  });

  // ── 执行安装 ──
  route('POST', '/api/v1/install', async (req, res) => {
    // 限流：同一 IP 每分钟最多 10 次安装尝试
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit('install:' + ip, 10, 60 * 1000)) {
      return error(res, '请求过于频繁，请稍后再试', 429);
    }
    if (isInstalled()) {
      return error(res, '站点已安装，如需重装请先清空数据库', 403);
    }

    const body = await parseBody(req);
    const siteName = validators.string(validators.required(body.site_name, '站点名称'), '站点名称', 60);
    const siteDesc = validators.string(body.site_description || '', '站点描述', 200);
    const siteUrl = validators.string(body.site_url || '', '站点地址', 200);
    const adminUser = validators.string(validators.required(body.admin_username, '管理员用户名'), '管理员用户名', 30);
    const adminPass = validators.required(body.admin_password, '管理员密码');
    const adminEmail = validators.email(validators.required(body.admin_email, '管理员邮箱'), '管理员邮箱');

    if (!/^[a-zA-Z0-9_\-]{3,30}$/.test(adminUser)) {
      return error(res, '用户名只能包含字母、数字、下划线、短横线，长度 3-30', 400);
    }
    if (String(adminPass).length < 6) {
      return error(res, '密码长度至少 6 位', 400);
    }
    if (siteUrl && !/^https?:\/\/.+/.test(siteUrl)) {
      return error(res, '站点地址必须是有效 URL（以 http:// 或 https:// 开头）', 400);
    }

    try {
      db.exec('BEGIN');
      const now = new Date().toISOString();

      // 1) 管理员账号
      const adminId = uid();
      db.prepare('INSERT INTO users (id, username, email, password, nickname, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(adminId, adminUser, adminEmail, hashPwd(adminPass), adminUser, 'admin', 'active');

      // 2) 默认分类（启动引导可能已创建，存在则复用，避免唯一约束冲突）
      let catId;
      const existCat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('uncategorized');
      if (existCat) {
        catId = existCat.id;
      } else {
        catId = uid();
        db.prepare('INSERT INTO categories (id, name, slug, description) VALUES (?, ?, ?, ?)')
          .run(catId, '未分类', 'uncategorized', '默认分类');
      }

      // 3) 站点信息与默认配置
      const options = {
        installed: 'true',
        site_name: siteName,
        site_description: siteDesc || '一个轻量可扩展的博客系统',
        site_url: siteUrl || '',
        posts_per_page: '10',
        allow_register: 'false',
        comment_moderation: 'true',
        active_theme: 'default',
        permalink: '/archives/{cid}/',
        category_prefix: '/category/{slug}/',
        tag_prefix: '/tag/{slug}/',
      };
      for (const [k, v] of Object.entries(options)) {
        const exist = db.prepare('SELECT id FROM options WHERE key = ?').get(k);
        if (exist) db.prepare('UPDATE options SET value = ?, updated_at = ? WHERE key = ?').run(v, now, k);
        else db.prepare('INSERT INTO options (id, key, value, autoload) VALUES (?, ?, ?, 1)').run(uid(), k, v);
      }

      // 4) 默认主题
      if (!db.prepare('SELECT id FROM themes WHERE theme_id = ?').get('default')) {
        db.prepare('INSERT INTO themes (id, theme_id, name, version, active, config) VALUES (?, ?, ?, ?, 1, ?)')
          .run(uid(), 'default', '默认主题', '1.1.0', '{}');
      }

      // 5) Hello World 文章
      if (db.prepare('SELECT COUNT(*) AS c FROM posts').get().c === 0) {
        const content = [
          '欢迎使用 **lill** —— 一个轻量、可扩展、前后端分离的博客系统。',
          '',
          '这是系统为你准备的默认文章。你可以直接编辑它，或删除后开始写作。',
          '',
          '## 快速上手',
          '',
          '- **后台地址**：`/admin/`',
          '- **更换主题**：后台 → 外观，切换主题并进入主题专属设置',
          '- **发布文章**：后台 → 文章 → 新建文章',
          '- **主题开发**：见 `docs/主题开发指南.md`',
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
          .run(pid, 'Hello World', 'hello-world', content, renderMD(content), plainText(content).substring(0, 200), adminId, catId);
      }

      db.exec('COMMIT');

      // 安装成功即签发登录 token，前端可直接进入后台
      const token = signJWT({ id: adminId, username: adminUser, role: 'admin' });
      console.log('✓ 安装完成 | 管理员:', adminUser, '| 站点:', siteName);
      json(res, {
        installed: true,
        token,
        user: { id: adminId, username: adminUser, nickname: adminUser, email: adminEmail, role: 'admin' },
      });
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      console.error('✗ 安装失败:', e.message);
      return error(res, '安装失败：' + e.message, 500);
    }
  });
}
