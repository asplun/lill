/**
 * lill 公开 API（前台使用，无需登录）
 * 由 server.js 调用 register(router, ctx) 装配
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanThemeAssets, scanPageTemplates } from '../lib/themes.js';
import { orderBy, normQQ, shapeComment } from '../lib/comment-util.js';
import { clientIp } from '../lib/http.js';

const __themeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'themes');

// 访客只能看到已发布、公开且未设置密码的内容。密码文章暂不提供访客验证流程。
const PUBLIC_POST_WHERE = "p.status = 'published' AND p.visibility = 'public' AND (p.password IS NULL OR p.password = '')";
const PUBLIC_POST_FIELDS = `
  p.id, p.title, p.slug, p.content, p.html_content, p.excerpt, p.cover_image,
  p.type, p.status, p.visibility, p.comment_allowed, p.view_count, p.comment_count,
  p.sticky, p."order", p.likes, p.published_at, p.author_id, p.category_id,
  p.template, p.fields, p.created_at, p.updated_at`;

export function register(router, ctx) {
  const { db, json, error, parseBody, validators, uid, authenticate, readThemeManifest, triggerHook, themeRuntime, runActiveThemeHook } = ctx;
  const { security, mail } = ctx;
  const route = router.route;

  /* 当前激活主题的后端扩展只通过通用 runtime 调用；失败不阻断核心 API。 */
  const activeThemeId = () => {
    const row = db.prepare('SELECT theme_id FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get();
    return row?.theme_id || 'default';
  };
  const activeThemeExt = () => (ctx.themeExt && typeof ctx.themeExt.active === 'function') ? ctx.themeExt.active() : null;
  async function runThemeHook(name, ...args) {
    if (runActiveThemeHook && themeRuntime?.extensions) {
      return runActiveThemeHook(themeRuntime.extensions, activeThemeId(), name, args, undefined);
    }
    const ext = activeThemeExt();
    if (!ext || typeof ext[name] !== 'function') return undefined;
    try { return await ext[name](...args); }
    catch (e) { console.warn('theme hook ' + name + ' failed:', e.message); return undefined; }
  }

/* ── 访客上下文（通用） ──────────────────────────────
   「回复可见」类主题短代码需要知道当前访客是否登录、是否在该内容下留过言。
   core 只提供这个通用判定，具体怎么用由主题钩子决定。
   cookie 使用 lill_commenter_mail，主题兼容别名由主题扩展自行处理。 */
function commenterMail(req) {
  const ck = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)lill_commenter_mail=([^;]*)/.exec(ck);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

async function viewerContext(req, post) {
  let user = null;
  try { user = await optionalUser(req); } catch (e) { user = null; }
  const mail = commenterMail(req) || (user && user.email) || '';
  let hasCommented = false;
  if (post && post.id && mail) {
    try {
      hasCommented = !!db.prepare('SELECT 1 FROM comments WHERE post_id = ? AND author_email = ? LIMIT 1').get(post.id, mail);
    } catch (e) { hasCommented = false; }
  }
  return { user, mail, hasCommented, reveal: hasCommented || !!user };
}

// ════════════════════════════════════════
// 永久链接处理
// ════════════════════════════════════════
function getPermalinkUrl(type, post, category, tag) {
  const getOpt = (k, d) => { const r = db.prepare('SELECT value FROM options WHERE key = ?').get(k); return (r && r.value) || d; };
  const siteUrl = getOpt('site_url', '').replace(/\/$/, '');
  
  if (type === 'post') {
    const format = getOpt('permalink', '/archives/{cid}/');
    const cid = post.id;
    const slug = post.slug;
    const categorySlug = category ? category.slug : '';
    const year = post.published_at ? post.published_at.substring(0, 4) : '';
    const month = post.published_at ? post.published_at.substring(5, 7) : '';
    const path = format
      .replace('{cid}', cid)
      .replace('{slug}', slug)
      .replace('{category}', categorySlug)
      .replace('{year}', year)
      .replace('{month}', month);
    return { url: siteUrl + path, route: '/post/' + slug };
  }
  if (type === 'category') {
    const format = getOpt('category_prefix', '/category/{slug}/');
    const path = format.replace('{slug}', category.slug).replace('{mid}', category.id);
    return { url: siteUrl + path, route: '/category/' + category.slug };
  }
  if (type === 'tag') {
    const format = getOpt('tag_prefix', '/tag/{slug}/');
    const path = format.replace('{slug}', tag.slug).replace('{mid}', tag.id);
    return { url: siteUrl + path, route: '/tag/' + tag.slug };
  }
  return { url: '', route: '' };
}


// ════════════════════════════════════════
// 主题渲染引导数据 /api/v1/site/bootstrap
// 主题引擎一次请求拿全渲染所需数据，主题作者只需写 HTML + 标签
// ════════════════════════════════════════
function publicThemeConfig(cfg, themeId) {
  if (themeRuntime?.publicConfig) return themeRuntime.publicConfig(themeId || activeThemeId(), cfg);
  return {};
}

function buildThemeOptions() {
  const rows = db.prepare('SELECT key, value FROM options WHERE autoload = 1').all();
  const result = {};
  rows.forEach(x => { result[x.key] = x.value; });
  const activeTheme = db.prepare('SELECT * FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get();
  if (!activeTheme) {
    result.theme_config = {};
    result.active_theme = 'default';
    result.theme_meta = {};
    return result;
  }
  let saved = {};
  try { saved = JSON.parse(activeTheme.config || '{}'); } catch { saved = {}; }
  const config = themeRuntime?.config
    ? themeRuntime.config(activeTheme.theme_id, saved)
    : {};
  const manifest = themeRuntime?.manifest
    ? themeRuntime.manifest(activeTheme.theme_id)
    : readThemeManifest(activeTheme.theme_id);
  result.theme_config = config;
  result.active_theme = activeTheme.theme_id;
  result.theme_meta = manifest ? {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    screenshot: manifest.screenshot || '',
  } : {};
  return result;
}

function decoratePost(p) {
  const r = getPermalinkUrl('post', p, p.category_slug ? { slug: p.category_slug } : null);
  p.permalink = r.url;
  p.route = r.route;
  p.url = r.route;              // 模板中 {$post.url} 直接用可访问地址
  p.date = p.published_at || p.created_at || '';
  return p;
}

function listPosts(o) {
  const page = Math.max(1, parseInt(o.page) || 1);
  const pageSize = Math.max(1, parseInt(o.pageSize) || 10);
  const typeFilter = o.type || 'post';
  let where = `WHERE ${PUBLIC_POST_WHERE} AND p.type = ?`;
  const params = [typeFilter];
  if (o.categorySlug) { where += ' AND p.category_id = (SELECT id FROM categories WHERE slug = ?)'; params.push(o.categorySlug); }
  if (o.tag) { where += ' AND p.id IN (SELECT post_id FROM post_tags WHERE tag_id = (SELECT id FROM tags WHERE slug = ?))'; params.push(o.tag); }
  if (o.keyword) { where += ' AND (p.title LIKE ? OR p.excerpt LIKE ? OR p.content LIKE ?)'; params.push(`%${o.keyword}%`, `%${o.keyword}%`, `%${o.keyword}%`); }
  const total = db.prepare(`SELECT COUNT(*) as c FROM posts p ${where}`).get(...params).c;
  const items = db.prepare(`
    SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.view_count, p.likes, p.sticky, p.published_at, p.created_at, p.category_id,
           u.nickname as author_nickname, c.name as category_name, c.slug as category_slug,
           (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = p.id AND cm.status = 'approved') as comment_count${o.full ? ', p.html_content' : ''}
    FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id
    ${where} ORDER BY p.sticky DESC, p.published_at DESC, p.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);
  items.forEach(decoratePost);
  return { items, meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), hasNext: page * pageSize < total, hasPrev: page > 1 } };
}

function listCategories() {
  const cats = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM posts p WHERE p.category_id = c.id AND p.type = 'post' AND ${PUBLIC_POST_WHERE}) as post_count FROM categories c ORDER BY sort_order, name`).all();
  cats.forEach(c => { const r = getPermalinkUrl('category', null, c); c.permalink = r.url; c.route = r.route; c.url = r.route; });
  return cats;
}

function listTags() {
  const tags = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM post_tags pt JOIN posts p ON p.id = pt.post_id WHERE pt.tag_id = t.id AND ${PUBLIC_POST_WHERE}) as post_count FROM tags t ORDER BY t.name`).all();
  tags.forEach(t => { const r = getPermalinkUrl('tag', null, null, t); t.permalink = r.url; t.route = r.route; t.url = r.route; });
  return tags;
}

function listArchives() {
  return db.prepare(`SELECT strftime('%Y-%m', p.published_at) as ym, COUNT(*) as count FROM posts p WHERE p.type = 'post' AND ${PUBLIC_POST_WHERE} AND p.published_at IS NOT NULL GROUP BY ym ORDER BY ym DESC`).all();
}

function listRecentComments(limit) {
  const items = db.prepare(`
    SELECT c.id, c.content, c.created_at, c.author_name, c.post_id,
           p.title as post_title, p.slug as post_slug, u.nickname, u.avatar
    FROM comments c LEFT JOIN posts p ON c.post_id = p.id LEFT JOIN users u ON c.user_id = u.id
    WHERE c.status = 'approved' AND ${PUBLIC_POST_WHERE}
    ORDER BY c.created_at DESC LIMIT ?
  `).all(limit || 5);
  items.forEach(c => { c.post_url = '/post/' + c.post_slug; c.post_route = '/post/' + c.post_slug; c.author = c.nickname || c.author_name || '匿名'; });
  return items;
}

route('GET', '/api/v1/site/bootstrap', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type') || 'index';
  const slug = url.searchParams.get('slug') || '';
  const page = parseInt(url.searchParams.get('page')) || 1;
  const q = url.searchParams.get('q') || '';
  const month = url.searchParams.get('month') || '';

  const options = buildThemeOptions();
  const cfg = options.theme_config || {};
  // 每页文章数：主题「布局与导航」的 pageSize 优先，未设置时回落站点选项 posts_per_page
  const themePerPage = parseInt(cfg.pageSize);
  const perPage = (themePerPage > 0 ? themePerPage : parseInt(options.posts_per_page)) || 10;
  const activeThemeId = options.active_theme || 'default';
  const themesDir = ctx.THEMES_DIR || __themeDir;
  const pageTemplatesList = scanPageTemplates(activeThemeId, themesDir);

  const cats = listCategories();
  const pagesList = db.prepare(`SELECT id, title, slug, template FROM posts p WHERE p.type = 'page' AND ${PUBLIC_POST_WHERE} ORDER BY p."order" ASC, p.created_at ASC`).all();
  const nav = [
    { title: '首页', url: '/', type: 'index', slug: '', active: type === 'index' },
    ...cats.map(c => ({ title: c.name, url: c.route, type: 'category', slug: c.slug, active: type === 'category' && slug === c.slug })),
    ...pagesList.map(p => ({ title: p.title, url: '/page/' + p.slug, type: 'page', slug: p.slug, active: type === 'page' && slug === p.slug })),
    { title: '归档', url: '/archive', type: 'archive', slug: '', active: type === 'archive' },
  ];

  // 左右边栏小组件配置（由「小组件」管理页面维护，存于 themes.config）
  // 归一化与 name/icon 装饰由主题扩展负责（各主题的小组件定义不同）
  const themeExt = activeThemeExt();
  const decorateWidgets = (themeExt && typeof themeExt.decorateWidgets === 'function')
    ? themeExt.decorateWidgets
    : () => [];
  const sidebar = {
    recentPosts: listPosts({ pageSize: 5 }).items,
    categories: cats,
    tags: listTags(),
    archives: listArchives(),
    recentComments: listRecentComments(5),
    widgets: {
      left: decorateWidgets(cfg.leftWidgets),
      right: decorateWidgets(cfg.rightWidgets),
    },
  };

  const frontPath = url.searchParams.get('path') || '';
  const pageInfo = { type, slug, url: frontPath || ('/' + (type === 'index' ? '' : type + '/')), title: '', query: { page, q, month } };
  let data = {};
  try {
    data.commentTotal = db.prepare(`SELECT COUNT(*) as c FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.status = 'approved' AND ${PUBLIC_POST_WHERE}`).get().c;
    data.postTotal = db.prepare(`SELECT COUNT(*) as c FROM posts p WHERE p.type = 'post' AND ${PUBLIC_POST_WHERE}`).get().c;
  } catch (e) { data.commentTotal = 0; data.postTotal = 0; }
  // 自定义页面模板（page-*.html）额外需要的视图模型，最终并进 theme 一起下发
  const pageView = {};

  if (type === 'post' || type === 'page') {
    const post = db.prepare(`
      SELECT ${PUBLIC_POST_FIELDS},
             u.nickname as author_nickname, u.avatar as author_avatar,
             c.name as category_name, c.slug as category_slug
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.slug = ? AND p.type = ? AND ${PUBLIC_POST_WHERE}
    `).get(slug, type);
    if (!post) return error(res, '内容不存在', 404);
    post.tags = db.prepare('SELECT t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?').all(post.id);
    post.prev = db.prepare(`SELECT title, slug FROM posts p WHERE p.type = ? AND ${PUBLIC_POST_WHERE} AND p.published_at < ? ORDER BY p.published_at DESC LIMIT 1`).get(post.type, post.published_at) || null;
    post.next = db.prepare(`SELECT title, slug FROM posts p WHERE p.type = ? AND ${PUBLIC_POST_WHERE} AND p.published_at > ? ORDER BY p.published_at ASC LIMIT 1`).get(post.type, post.published_at) || null;
    if (post.prev) post.prev.url = '/post/' + post.prev.slug;
    if (post.next) post.next.url = '/post/' + post.next.slug;
    decoratePost(post);
    post.comment_count = db.prepare(`SELECT COUNT(*) as c FROM comments WHERE post_id = ? AND status = 'approved'`).get(post.id).c;
    /* 阅读时长：原版 post.php 的元信息行显示「N 分钟」而不是阅读量。
       按正文估算：中日韩字符按 1 字计，拉丁词按 1.5 计，300 字/分钟。 */
    post.readTime = (function () {
      try {
        const text = String(post.html_content || '')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]*>/g, ' ');
        const reCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
        const cjk = (text.match(reCjk) || []).length;
        const latin = (text.replace(reCjk, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
        return Math.max(1, Math.round((cjk + latin * 1.5) / 300));
      } catch (e) { return 1; }
    })();
    pageInfo.title = post.title;
    data.post = post;
    /* 正文输出钩子：主题短代码（如 {hide} 回复可见）按本次访客身份在输出时转换，
       而不是保存时固化。core 不关心具体短代码语法。 */
    {
      const viewer = await viewerContext(req, post);
      const out = await runThemeHook('transformContent', post.html_content, { req, post, viewer, db });
      if (typeof out === 'string') post.html_content = out;
    }
    // 独立页面自定义模板（对标 Typecho 的 page-xxx.php）
    // 页面记录里的 template 字段保存模板 key（如 page-links），仅当主题里确实存在该文件时才生效
    if (type === 'page' && post.template) {
      const tpl = pageTemplatesList.find(t => t.key === post.template);
      if (tpl) { data.pageTemplate = tpl.key; pageInfo.template = tpl.key; pageInfo.templateName = tpl.name; }
      // 主题扩展只接收 manifest 已声明且实际存在的模板 key。
      if (tpl) await runThemeHook('pageTemplate', tpl.key, { req, url, db, data, pageView, post });
    }
    /* 原版 page.php:37 是 `if ($this->allow('comment')) $this->need('comments.php');`
       —— 独立页面同样渲染评论区（主站 /index.php/messages.html 实测带
       <div class="md-card comments-section">，首页留言链接直指 #comment-308）。
       此前只判 type==='post'，使所有 type==='page' 的页面评论区整体不渲染。 */
    if (type === 'post' || type === 'page') {
      const cmtViewer = await optionalUser(req);
      const total = db.prepare(`SELECT COUNT(*) as c FROM comments WHERE post_id = ? AND status = 'approved'`).get(post.id).c;
      /* 评论排序：与原版 helpers.php themecomment_sort() 一致 ——
         默认 desc；URL ?commentSort=asc|desc 覆盖；无 URL 参数时用 cookie lill_comment_sort（30 天）记忆 */
      let cmtSort = String(url.searchParams.get('commentSort') || '');
      if (cmtSort !== 'asc' && cmtSort !== 'desc') {
        const ck = String(req.headers.cookie || '').match(/(?:^|;\s*)lill_comment_sort=(asc|desc)/);
        cmtSort = ck ? ck[1] : 'desc';
      }
      const dir = cmtSort === 'asc' ? 'ASC' : 'DESC';
      const rows = db.prepare(`SELECT c.*, u.email AS user_email, u.nickname, u.avatar FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.post_id = ? AND c.status = 'approved' ORDER BY c.created_at ${dir}, c.id ${dir}`).all(post.id);
      // 与 GET /api/v1/comments 同构（头像 / QQ / 博主徽标 / 删除权限）
      const shaped = rows.map(c => shapeComment(c, post.author_id, cmtViewer));
      const byId = {};
      rows.forEach((c, i) => { byId[c.id] = shaped[i]; });
      /* 原版 lib/helpers.php themerender_comment_tree() 输出的是「扁平列表」：
         所有评论按排序顺序逐条渲染，回复用 .comment-quote 引用父评论（父评论正文截断 42 字） */
      data.commentFlat = shaped.map((c, i) => {
        const pid = rows[i].parent_id;
        const p = pid && byId[pid] ? byId[pid] : null;
        let parentAuthor = '', parentText = '';
        if (p) {
          parentAuthor = p.author;
          parentText = String(p.content || '')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '$1')
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (parentText.length > 42) parentText = parentText.slice(0, 42) + '…';
        }
        return { ...c, parent_author: parentAuthor, parent_text: parentText, parent_ref: p ? p.id : 0 };
      });
      data.commentSort = cmtSort;
      /* 兼容 JSON 消费方（theme.js 的局部刷新与 /api/v1/comments 同构） */
      const items = rows.filter(r => !r.parent_id && r.status === 'approved');
      for (const c of items) c.replies = rows.filter(r => r.parent_id === c.id);
      data.comments = items.map(c => {
        const item = shapeComment(c, post.author_id, cmtViewer);
        item.replies = (c.replies || []).map(k => shapeComment(k, post.author_id, cmtViewer));
        item.reply_count = item.replies.length;
        return item;
      });
      data.commentMeta = { total };
      data.commentAllowed = post.comment_allowed !== 0;
    }
  } else if (type === 'archive') {
    const all = listPosts({ pageSize: 500, type: 'post' }).items;
    const posts = month ? all.filter(p => String(p.published_at || '').startsWith(month)) : all;
    const map = {};
    posts.forEach(p => { const ym = String(p.published_at || '').substring(0, 7) || '未知'; (map[ym] = map[ym] || []).push(p); });
    data.groups = Object.keys(map).sort().reverse().map(ym => ({ ym, count: map[ym].length, posts: map[ym] }));
    data.month = month;
    data.posts = posts;
    // 归档页统计视图模型（原版 archive.php 的年度/月度柱状图 + 分类/标签云 + 时间线）
    try {
      const yearMap = {};
      const monthMap = {};
      for (let i = 1; i <= 12; i++) monthMap[String(i)] = 0;
      posts.forEach(p => {
        const ym = String(p.published_at || '').substring(0, 7) || '未知';
        const y = ym.substring(0, 4) || '未知';
        yearMap[y] = (yearMap[y] || 0) + 1;
        const mn = String(Number(ym.substring(5, 7)));
        if (monthMap[mn] !== undefined) monthMap[mn] += 1;
      });
      const yBars = Object.keys(yearMap).sort().reverse().map(y => ({ year: y, count: yearMap[y] }));
      const mBars = Object.keys(monthMap).map(k => ({ month: k, count: monthMap[k] }));
      const yMax = Math.max(1, ...yBars.map(b => b.count));
      const mMax = Math.max(1, ...mBars.map(b => b.count));
      yBars.forEach(b => { b.pct = Math.max(2, Math.round(b.count / yMax * 1000) / 10); });
      mBars.forEach(b => { b.pct = Math.max(2, Math.round(b.count / mMax * 1000) / 10); });
      data.yearBars = yBars;
      data.monthBars = mBars;
      data.archTotal = posts.length;
      data.archMonthCount = data.groups.length;
      data.archYearCount = yBars.length;
      const tagMax = Math.max(1, ...(listTags().map(t => t.post_count) || [1]));
      data.tagMax = tagMax;
      data.archTags = listTags().slice().sort((a, b) => b.post_count - a.post_count).map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.post_count }));
      data.archCats = listCategories().slice().sort((a, b) => b.post_count - a.post_count).map(c => ({ name: c.name, slug: c.slug, url: c.url, count: c.post_count }));
      const yg = {};
      data.groups.forEach(g => {
        const y = String(g.ym || '').substring(0, 4) || '未知';
        const mm = String(g.ym || '').substring(5, 7);
        const mLabel = mm ? String(Number(mm)) : '';
        (yg[y] = yg[y] || { year: y, count: 0, months: [] });
        yg[y].count += g.count;
        yg[y].months.push({ ym: g.ym, month: mLabel, count: g.count, posts: g.posts });
      });
      data.archYearGroups = Object.keys(yg).sort().reverse().map(y => yg[y]);
      // 「约 N 字」：对齐原版 archive.php 的 $triArchWords（累加全部归档行正文 strip_tags 后的字符数）
      let words = 0;
      if (posts.length) {
        const ph = posts.map(() => '?').join(',');
        const rows = db.prepare(`SELECT html_content, content FROM posts WHERE id IN (${ph})`).all(...posts.map(pp => pp.id));
        rows.forEach(r => {
          const txt = String(r.html_content || r.content || '').replace(/<[^>]*>/g, '').trim();
          words += Array.from(txt).length;
        });
      }
      data.archWords = words;
      data.archWordsText = words >= 10000 ? (Math.round(words / 1000) / 10) + ' 万字' : words + ' 字';
    } catch (e) { console.warn('archive view model failed:', e.message); }
    pageInfo.title = month ? '归档：' + month : '归档';
  } else if (type === 'category') {
    const cat = cats.find(c => c.slug === slug) || null;
    if (!cat) return error(res, '分类不存在', 404);
    const d = listPosts({ categorySlug: slug, page, pageSize: perPage });
    data.category = cat; data.posts = d.items; data.pagination = d.meta;
    pageInfo.title = '分类 ' + cat.name;
  } else if (type === 'tag') {
    const tag = listTags().find(t => t.slug === slug) || null;
    if (!tag) return error(res, '标签不存在', 404);
    const d = listPosts({ tag: slug, page, pageSize: perPage });
    data.tag = tag; data.posts = d.items; data.pagination = d.meta;
    pageInfo.title = '标签 ' + tag.name;
  } else if (type === 'search') {
    const d = listPosts({ keyword: q, page, pageSize: perPage });
    data.keyword = q; data.posts = d.items; data.pagination = d.meta;
    pageInfo.title = q ? '搜索 ' + q : '搜索';
  } else if (type === 'index') {
    const d = listPosts({ page, pageSize: perPage, full: cfg.home_mode === 'full' });
    data.posts = d.items;
    data.pagination = d.meta;
    pageInfo.title = options.site_name || '首页';
  } else {
    pageInfo.title = '页面没找到';
    data.notFound = true;
  }

  const publicConfig = publicThemeConfig(cfg, activeThemeId);
  const coreView = {
    options: { ...options, theme_config: publicConfig },
    site: { name: options.site_name || 'lill 博客', description: options.site_description || '', url: (options.site_url || '').replace(/\/$/, ''), year: new Date().getFullYear() },
    theme: { ...publicConfig, ...pageView },
    themeId: options.active_theme || 'default',
    themeMeta: options.theme_meta || {},
    themeAssets: scanThemeAssets(activeThemeId, themesDir),
    pageTemplates: pageTemplatesList,
    nav,
    sidebar,
    page: pageInfo,
    data,
  };
  const extensionResult = await runThemeHook('extendBootstrap', coreView, { req, url, db, themeId: activeThemeId, config: cfg, themeRuntime }, {});
  const extension = extensionResult && typeof extensionResult === 'object'
    ? (extensionResult.extension && typeof extensionResult.extension === 'object' ? extensionResult.extension : extensionResult)
    : {};
  coreView.theme.extension = extension;
  json(res, coreView);
});


// 文章列表（支持分页、分类、标签、关键词搜索）
route('GET', '/api/v1/posts', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = parseInt(url.searchParams.get('page')) || 1;
  const pageSize = parseInt(url.searchParams.get('pageSize')) || 10;
  // 安全隔离:公共接口强制只返回已发布且公开的内容
  const typeFilter = url.searchParams.get('type') || 'post';
  const categoryId = url.searchParams.get('categoryId');
  const categorySlug = url.searchParams.get('categorySlug');
  const tag = url.searchParams.get('tag');
  const keyword = url.searchParams.get('keyword');
  const full = url.searchParams.get('full') === '1';

  let where = `WHERE ${PUBLIC_POST_WHERE} AND p.type = ?`;

  const params = [typeFilter];
  if (categoryId) { where += ' AND p.category_id = ?'; params.push(categoryId); }
  if (categorySlug) { where += ' AND p.category_id = (SELECT id FROM categories WHERE slug = ?)'; params.push(categorySlug); }
  if (tag) { where += ' AND p.id IN (SELECT post_id FROM post_tags WHERE tag_id = (SELECT id FROM tags WHERE slug = ?))'; params.push(tag); }
  if (keyword) { where += ' AND (p.title LIKE ? OR p.excerpt LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM posts p ${where}`).get(...params)).c;
  const items = db.prepare(`
    SELECT p.id, p.title, p.slug, p.excerpt, p.cover_image, p.view_count, p.sticky, p.published_at,
           u.nickname as author_nickname, c.name as category_name, c.slug as category_slug${full ? ', p.html_content' : ''}
    FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id
    ${where} ORDER BY p.sticky DESC, p.published_at DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  // 为每篇文章生成 permalink URL
  const catMap = {};
  db.prepare('SELECT id, slug FROM categories').all().forEach(c => catMap[c.id] = c.slug);
  items.forEach(p => { const r = getPermalinkUrl('post', p, p.category_id ? { slug: catMap[p.category_id] } : null); p.url = r.url; p.route = r.route; });
  json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
});

// 独立页面列表（导航菜单用）
route('GET', '/api/v1/pages', async (req, res) => {
  const pages = db.prepare(`SELECT p.id, p.title, p.slug, p.excerpt, p.created_at FROM posts p WHERE p.type = 'page' AND ${PUBLIC_POST_WHERE} ORDER BY p."order" ASC, p.created_at ASC`).all();
  json(res, pages);
});

// 归档（按年月分组，侧边栏 Widget）
route('GET', '/api/v1/archives', async (req, res) => {
  const rows = db.prepare(`SELECT strftime('%Y-%m', p.published_at) as ym, COUNT(*) as count FROM posts p WHERE p.type = 'post' AND ${PUBLIC_POST_WHERE} AND p.published_at IS NOT NULL GROUP BY ym ORDER BY ym DESC`).all();
  json(res, rows);
});

// 最新评论（侧边栏 Widget）
route('GET', '/api/v1/comments/recent', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit')) || 5;
  const items = db.prepare(`
    SELECT c.id, c.content, c.created_at, c.author_name, c.post_id,
           p.title as post_title, p.slug as post_slug, u.nickname, u.avatar
    FROM comments c LEFT JOIN posts p ON c.post_id = p.id LEFT JOIN users u ON c.user_id = u.id
    WHERE c.status = 'approved' AND ${PUBLIC_POST_WHERE}
    ORDER BY c.created_at DESC LIMIT ?
  `).all(limit);
  // 为每条评论生成 post_url 和 post_route
  items.forEach(c => {
    c.post_url = '/post/' + c.post_slug;
    c.post_route = '/post/' + c.post_slug;
  });
  json(res, items);
});

// 文章详情（含标签、上下篇导航）
route('GET', '/api/v1/posts/:slug', async (req, res, params) => {
  // 安全隔离:只返回已发布、公开且未设置密码的文章
  const post = db.prepare(`
    SELECT ${PUBLIC_POST_FIELDS},
           u.nickname as author_nickname, u.avatar as author_avatar,
           c.name as category_name, c.slug as category_slug
    FROM posts p
    LEFT JOIN users u ON p.author_id = u.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.slug = ? AND p.type = 'post' AND ${PUBLIC_POST_WHERE}
  `).get(params.slug);
  if (!post) return error(res, '文章不存在', 404);
  post.tags = db.prepare('SELECT t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?').all(post.id);
  post.prev = db.prepare(`SELECT title, slug FROM posts p WHERE p.type = ? AND ${PUBLIC_POST_WHERE} AND p.published_at < ? ORDER BY p.published_at DESC LIMIT 1`).get(post.type, post.published_at) || null;
  post.next = db.prepare(`SELECT title, slug FROM posts p WHERE p.type = ? AND ${PUBLIC_POST_WHERE} AND p.published_at > ? ORDER BY p.published_at ASC LIMIT 1`).get(post.type, post.published_at) || null;
  db.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').run(post.id);
  const postUrlResult = getPermalinkUrl('post', post, post.category_id ? { slug: post.category_slug } : null); post.url = postUrlResult.url; post.route = postUrlResult.route;
  /* 正文经主题短代码转换后与访客身份相关（如 {hide} 回复可见），不能沿用 60 秒公开缓存 */
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  {
    const viewer = await viewerContext(req, post);
    const out = await runThemeHook('transformContent', post.html_content, { req, post, viewer, db });
    if (typeof out === 'string') post.html_content = out;
  }
  json(res, post);
});

// RSS Feed is a core-only serialization of published posts; optional theme providers are not involved.
route('GET', '/api/v1/feed', async (req, res) => {
  const getOpt = (k, d) => { const r = db.prepare('SELECT value FROM options WHERE key = ?').get(k); return (r && r.value) || d; };
  const siteName = getOpt('site_name', 'lill 博客');
  const siteDesc = getOpt('site_description', '');
  const siteUrl = getOpt('site_url', '').replace(/\/$/, '');
  const posts = db.prepare(`SELECT p.title, p.slug, p.excerpt, p.published_at FROM posts p WHERE p.type = 'post' AND ${PUBLIC_POST_WHERE} ORDER BY p.published_at DESC LIMIT 20`).all();
  const x = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n';
  xml += '<title>' + x(siteName) + '</title>\n<link>' + x(siteUrl) + '</link>\n<description>' + x(siteDesc) + '</description>\n';
  xml += '<language>zh-CN</language>\n<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n';
  for (const post of posts) {
    const link = siteUrl + '/post/' + encodeURIComponent(post.slug);
    xml += '<item>\n<title>' + x(post.title) + '</title>\n<link>' + x(link) + '</link>\n<guid isPermaLink="true">' + x(link) + '</guid>\n';
    xml += '<description>' + x(post.excerpt || '') + '</description>\n';
    if (post.published_at) xml += '<pubDate>' + new Date(String(post.published_at).replace(' ', 'T') + 'Z').toUTCString() + '</pubDate>\n';
    xml += '</item>\n';
  }
  xml += '</channel></rss>';
  res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  res.end(xml);
});

route('GET', '/api/v1/categories', async (req, res) => {
  const cats = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM posts p WHERE p.category_id = c.id AND p.type = 'post' AND ${PUBLIC_POST_WHERE}) as post_count FROM categories c ORDER BY sort_order`).all();
  cats.forEach(c => { const r = getPermalinkUrl('category', null, c); c.url = r.url; c.route = r.route; });
  json(res, cats);
});

route('GET', '/api/v1/tags', async (req, res) => {
  const tags = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM post_tags pt JOIN posts p ON p.id = pt.post_id WHERE pt.tag_id = t.id AND ${PUBLIC_POST_WHERE}) as post_count FROM tags t ORDER BY t.name`).all();
  tags.forEach(t => { const r = getPermalinkUrl('tag', null, null, t); t.url = r.url; t.route = r.route; });
  json(res, tags);
});

route('GET', '/api/v1/options/public', async (req, res) => {
  const rows = db.prepare('SELECT key, value FROM options WHERE autoload = 1').all();
  const result = {};
  rows.forEach(x => { result[x.key] = x.value; });
  const activeTheme = db.prepare('SELECT * FROM themes WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get();
  if (activeTheme) {
    let saved = {};
    try { saved = JSON.parse(activeTheme.config || '{}'); } catch { saved = {}; }
    result.theme_config = publicThemeConfig(saved, activeTheme.theme_id);
    result.active_theme = activeTheme.theme_id;
    const manifest = themeRuntime?.manifest ? themeRuntime.manifest(activeTheme.theme_id) : readThemeManifest(activeTheme.theme_id);
    result.theme_meta = manifest ? {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
    } : {};
  }
  json(res, result);
});

/* ════════════════════════════════════════════════════════════════
   评论（文章）：列表 / 发表 / 点赞
   theme 弹窗式评论系统的数据端 —— 支持最新·最热排序、两级回复、
   QQ·邮箱头像、登录用户自动实名且免审核（游客仍走「评论审核」开关）。
   ════════════════════════════════════════════════════════════════ */

// 可选登录：带 Bearer 就解析，没有/失效按游客处理（不抛错）
async function optionalUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    const p = await authenticate(req);
    if (!p || !p.id) return null;
    const u = db.prepare('SELECT id, username, nickname, avatar, role, status FROM users WHERE id = ?').get(p.id);
    return (u && u.status === 'active') ? u : null;
  } catch (e) { return null; }
}

function commentModerationOn() {
  const moderation = db.prepare('SELECT value FROM options WHERE key = ?').get('comment_moderation');
  return !moderation || moderation.value !== 'false';
}

route('GET', '/api/v1/comments', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const postId = url.searchParams.get('postId');
  if (!postId) return error(res, '缺少 postId');
  const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
  const ps = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize')) || 20));
  // 排序取值与原版 helpers.php themecomment_sort() 对齐：desc（默认，最新在前）/ asc（最早在前）；
  // hot（按点赞）是 lill 原有扩展，保留以兼容旧调用
  const sortRaw = url.searchParams.get('sort') || '';
  const sort = (sortRaw === 'hot' || sortRaw === 'asc' || sortRaw === 'desc') ? sortRaw : 'desc';
  const post = db.prepare(`SELECT p.id, p.author_id FROM posts p WHERE p.id = ? AND ${PUBLIC_POST_WHERE}`).get(postId);
  if (!post) return error(res, '文章不存在', 404);
  const ownerId = post.author_id;

  const total = (db.prepare('SELECT COUNT(*) as c FROM comments WHERE post_id = ? AND status = ?').get(postId, 'approved')).c;
  const replyTotal = (db.prepare('SELECT COUNT(*) as c FROM comments WHERE post_id = ? AND status = ? AND parent_id IS NOT NULL').get(postId, 'approved')).c;
  const items = db.prepare(
    `SELECT c.*, u.email AS user_email, u.nickname, u.avatar FROM comments c LEFT JOIN users u ON c.user_id = u.id
     WHERE c.post_id = ? AND c.status = ? AND c.parent_id IS NULL
     ORDER BY ${orderBy(sort, 'c')} LIMIT ? OFFSET ?`
  ).all(postId, 'approved', ps, (page - 1) * ps);
  const kids = db.prepare(
    `SELECT c.*, u.email AS user_email, u.nickname, u.avatar FROM comments c LEFT JOIN users u ON c.user_id = u.id
     WHERE c.parent_id = ? AND c.status = ? ORDER BY c.created_at ASC`
  );
  const viewer = await optionalUser(req);
  const list = items.map(r => {
    const item = shapeComment(r, ownerId, viewer);
    item.replies = kids.all(r.id, 'approved').map(k => shapeComment(k, ownerId, viewer));
    item.reply_count = item.replies.length;
    return item;
  });
  json(res, {
    items: list,
    sort,
    meta: {
      total, replyTotal, page, pageSize: ps,
      totalPages: Math.max(1, Math.ceil(total / ps)),
      hasNext: page * ps < total, hasPrev: page > 1
    }
  });
});

route('POST', '/api/v1/comments', async (req, res) => {
  const body = await parseBody(req);
  validators.required(body.postId, '文章ID');
  validators.required(body.content, '评论内容');
  validators.string(body.content, '评论内容', 2000);
  const post = db.prepare(`SELECT p.id, p.author_id, p.comment_allowed FROM posts p WHERE p.id = ? AND ${PUBLIC_POST_WHERE}`).get(body.postId);
  if (!post) return error(res, '文章不存在', 404);
  if (post.comment_allowed === 0) return error(res, '该文章已关闭评论');

  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  /* 防刷限速（对照原版 comment-api.php 的 themecomment_rate_limit：
     同一 IP 60 秒内最多 spamRateMin 条、600 秒内最多 spamRateTen 条） */
  const rate = security.rateLimit(ip, 'comments');
  if (!rate.ok) return error(res, rate.msg, 429);

  let parentId = null;
  if (body.parentId) {
    const pr = db.prepare('SELECT id, parent_id FROM comments WHERE id = ? AND post_id = ?').get(body.parentId, body.postId);
    if (!pr) return error(res, '要回复的评论不存在');
    // 只保留两级：回复「回复」时挂到同一顶层评论下
    parentId = pr.parent_id || pr.id;
  }

  const user = await optionalUser(req);
  let authorName = '', authorEmail = '', authorUrl = '', authorQq = '';
  if (user) {
    authorName = user.nickname || user.username || '';
  } else {
    validators.required(body.authorName, '昵称');
    validators.string(body.authorName, '昵称', 50);
    if (body.authorEmail) validators.email(body.authorEmail, '邮箱');
    if (body.authorUrl) validators.url(body.authorUrl, '网站');
    authorName = String(body.authorName).trim();
    authorEmail = body.authorEmail || '';
    authorUrl = body.authorUrl || '';
    authorQq = normQQ(body.authorQq);
  }
  // 登录用户视为可信（与 theme 原版「博主自己评论免审核」一致的思路）；游客按开关
  let status = user ? 'approved' : (commentModerationOn() ? 'pending' : 'approved');

  /* ===== 垃圾评论过滤：规则引擎 + 豆包 AI（对照原版 comment-api.php 第 174-212 行） =====
     站长本人（文章作者或管理员）免检；否则先跑规则，再按范围跑 AI 语义层。
     AI 只「加刑」不「减刑」，配置类错误放行、网络超时转待审核。 */
  const isOwner = !!(user && (user.role === 'admin' || user.id === post.author_id));
  if (!isOwner) {
    const spamData = {
      text: String(body.content || ''),
      author: authorName,
      mail: authorEmail,
      ip,
      agent: ua,
      hp: String(body.hp || ''),
    };
    const r1 = security.spamCheck(spamData, 'comments');
    if (!r1.ok) {
      if (r1.silent) return json(res, { ok: true, silent: true, id: null, status: 'discarded' }, 201);
      if (r1.pending) status = 'pending';
      else return error(res, '评论未通过内容检查，请修改后重试', 400);
    }
    const s = security.spamSettings();
    if (s.aiEnable && (s.aiScope === 'all' || (status === 'approved' && r1.ok))) {
      try {
        const r2 = await security.spamAiCheck(spamData);
        if (r2 && !r2.ok) {
          if (r2.pending) status = 'pending';
          else return error(res, '评论未通过内容检查，请修改后重试', 400);
        }
      } catch (e) { /* AI 层异常不阻塞评论（原版同款兜底） */ }
    }
  }

  const id = uid();
  db.prepare(`INSERT INTO comments (id, content, post_id, parent_id, user_id, author_name, author_email, author_url, author_qq, user_agent, ip, status, likes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(id, body.content, body.postId, parentId, user ? user.id : null,
      authorName, authorEmail, authorUrl, authorQq,
      ua, ip, status);
  if (status === 'approved') {
    try { db.prepare('UPDATE posts SET comment_count = COALESCE(comment_count, 0) + 1 WHERE id = ?').run(post.id); } catch (e) {}
  }
  const row = db.prepare('SELECT c.*, u.email AS user_email, u.nickname, u.avatar FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?').get(id);

  /* 邮件通知（对照 themenotify_comment）：访客评论 → 站长；站长回复 → 被回复访客 */
  try {
    let parentMail = '', parentQq = '';
    if (parentId) {
      const p = db.prepare('SELECT author_email, author_qq FROM comments WHERE id = ?').get(parentId);
      if (p) { parentMail = p.author_email || ''; parentQq = p.author_qq || ''; }
    }
    const pageurl = String(body.pageurl || req.headers.referer || '');
    mail.notifyComment({
      author: authorName || (user ? (user.nickname || user.username) : '访客'),
      text: String(body.content || ''),
      created: new Date(),
      pageurl,
      status,
      parent: parentId ? 1 : 0,
      isOwner,
      parentMail,
      parentQq,
    }).catch(() => {});
  } catch (e) { /* 通知失败不影响评论提交 */ }

  /* 记录本次评论者邮箱：{hide} 回复可见在下次访问时据此判定（对照原版 Typecho 的
     remember('mail')）。登录用户走 users.email，无需此 cookie。 */
  if (authorEmail) {
    try {
      const enc = encodeURIComponent(authorEmail);
      const ck = 'lill_commenter_mail=' + enc + '; Path=/; Max-Age=31536000; SameSite=Lax';
      const prev = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', prev ? [].concat(prev, ck) : ck);
    } catch (e) { /* cookie 写失败不影响评论提交 */ }
  }
  try { if (typeof triggerHook === 'function') triggerHook('comment.saved', row, { isNew: true }); } catch {}
  json(res, { id, status, pending: status !== 'approved', comment: shapeComment(row, post.author_id, user) }, 201);
});

// 评论点赞 / 取消（是否已赞由前端按访客记忆，这里只维护计数）
route('POST', '/api/v1/comments/:id/like', async (req, res, params) => {
  const body = await parseBody(req);
  const action = body.action === 'unlike' ? 'unlike' : 'like';
  const row = db.prepare(`SELECT c.id, c.likes FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ? AND c.status = 'approved' AND ${PUBLIC_POST_WHERE}`).get(params.id);
  if (!row) return error(res, '评论不存在', 404);
  const next = Math.max(0, (row.likes || 0) + (action === 'unlike' ? -1 : 1));
  db.prepare('UPDATE comments SET likes = ? WHERE id = ?').run(next, params.id);
  json(res, { id: params.id, likes: next, action });
});

// 文章点赞 / 取消
route('POST', '/api/v1/posts/:id/like', async (req, res, params) => {
  const body = await parseBody(req);
  const action = body.action === 'unlike' ? 'unlike' : 'like';
  const row = db.prepare(`SELECT p.id, p.likes FROM posts p WHERE p.id = ? AND ${PUBLIC_POST_WHERE}`).get(params.id);
  if (!row) return error(res, '文章不存在', 404);
  const next = Math.max(0, (row.likes || 0) + (action === 'unlike' ? -1 : 1));
  db.prepare('UPDATE posts SET likes = ? WHERE id = ?').run(next, params.id);
  json(res, { id: params.id, likes: next, action });
});

// 删除评论（需登录）：博主可删自己文章下的任意评论，普通用户仅能删自己发的；其子回复一并删除
route('DELETE', '/api/v1/comments/:id', async (req, res, params) => {
  const user = await optionalUser(req);
  if (!user) return error(res, '请先登录', 401);
  const row = db.prepare('SELECT id, post_id, user_id FROM comments WHERE id = ?').get(params.id);
  if (!row) return error(res, '评论不存在', 404);
  const post = db.prepare('SELECT id, author_id FROM posts WHERE id = ?').get(row.post_id);
  const isOwner = !!(row.user_id && row.user_id === user.id);
  const isPostAuthor = !!(post && post.author_id === user.id);
  if (!isOwner && !isPostAuthor && user.role !== 'admin') return error(res, '没有权限删除该评论', 403);
  const kids = db.prepare('SELECT id FROM comments WHERE parent_id = ?').all(params.id);
  const del = db.prepare('DELETE FROM comments WHERE id = ?');
  kids.forEach(k => del.run(k.id));
  del.run(params.id);
  const total = (db.prepare('SELECT COUNT(*) as c FROM comments WHERE post_id = ? AND status = ?').get(row.post_id, 'approved')).c;
  json(res, { id: params.id, removed: 1 + kids.length, total });
}, true);

}
