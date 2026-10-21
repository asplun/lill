/**
 * Typecho 导出导入路由。
 *
 * POST /api/v1/admin/import/typecho
 *   body { text: string, dryRun?: boolean = true }
 *   - dryRun 为 true（默认）时只返回 { posts, pages, categories, tags, skipped } 计数，不写库；
 *   - 落库时内容 id 固定为 typecho-<post_id>，已存在相同 id 或相同别名则跳过，不覆盖任何现有内容，
 *     因此同一份导出可以重复导入而不产生重复数据；
 *   - 分类按名称匹配、缺失则创建（slug 冲突追加 -2、-3…），标签同名复用；
 *   - 文章正文按 Markdown 原样保存并用 ctx.renderMD 生成 html_content；页面不挂分类；
 *   - 作者取当前登录账号，发布时间取 post_date（非 publish 状态一律存草稿且 published_at 为空）。
 */
import { parseTypechoExport } from '../../lib/typecho-import.js';
import { withTransaction } from './shared.js';

/** 单次导入文本上限；parseBody 默认 50MB，这里收得更紧，避免一次塞进整库 */
const MAX_TEXT_BYTES = 20 * 1024 * 1024;

/** 与 content.js 的 normalizeSlug 同口径：保留 Unicode 字母/数字，其余折叠为 - */
const normalizeSlug = raw => String(raw).trim().toLowerCase()
  .replace(/[\s_]+/g, '-')
  .replace(/[^\p{L}\p{N}-]+/gu, '-')
  .replace(/-{2,}/g, '-')
  .replace(/^-+|-+$/g, '');

const nowPublishedAt = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, uid, slugify, renderMD, plainText, authenticate, triggerHook } = ctx;
  const { route, logAction } = helpers;

  route('POST', '/api/v1/admin/import/typecho', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(res, '请求参数必须是对象', 400);
    if (typeof body.text !== 'string' || !body.text.trim()) return error(res, '请粘贴 Typecho 导出文件内容', 400);
    if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES) return error(res, '导入内容不能超过 20MB', 413);
    const dryRun = body.dryRun === undefined ? true : body.dryRun;
    if (typeof dryRun !== 'boolean') return error(res, 'dryRun 必须是布尔值', 400);

    let items;
    try {
      items = parseTypechoExport(body.text);
    } catch (err) {
      return error(res, err?.message || '不是有效的 Typecho 导出文件', 400);
    }

    // 所有 prepare 都在请求期执行：注册期只登记路由，architecture.test 的 db 桩不提供真实 prepare。
    const postById = db.prepare('SELECT id FROM posts WHERE id = ?');
    const postBySlug = db.prepare('SELECT id FROM posts WHERE slug = ?');
    const categoryByName = db.prepare('SELECT id FROM categories WHERE name = ?');
    const categoryBySlug = db.prepare('SELECT id FROM categories WHERE slug = ?');
    const insertCategory = db.prepare('INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)');
    const tagByName = db.prepare('SELECT id FROM tags WHERE name = ?');
    const tagBySlug = db.prepare('SELECT id FROM tags WHERE slug = ?');
    const insertTag = db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)');
    // 只写必要列，其余交给 posts 表默认值（visibility=public、comment_allowed=1 等）。
    const insertPost = db.prepare('INSERT INTO posts (id, title, slug, content, html_content, excerpt, excerpt_auto, type, status, published_at, author_id, category_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)');
    const linkTag = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)');
    const linkCategory = db.prepare('INSERT OR IGNORE INTO post_categories (post_id, category_id) VALUES (?, ?)');

    const categoryCache = new Map();
    const tagCache = new Map();
    const plannedIds = new Set();
    const plannedSlugs = new Set();
    const counts = { posts: 0, pages: 0, categories: 0, tags: 0, skipped: 0 };
    const importedIds = [];

    const ensureCategory = name => {
      if (categoryCache.has(name)) return categoryCache.get(name);
      const existing = categoryByName.get(name);
      if (existing) {
        categoryCache.set(name, existing.id);
        return existing.id;
      }
      let id;
      if (dryRun) {
        id = 'dry-category-' + (categoryCache.size + 1);
      } else {
        const base = normalizeSlug(name) || slugify(name) || 'category-' + uid();
        let slug = base;
        let suffix = 2;
        while (categoryBySlug.get(slug)) slug = base + '-' + suffix++;
        id = uid();
        insertCategory.run(id, name, slug);
      }
      counts.categories++;
      categoryCache.set(name, id);
      return id;
    };

    const ensureTag = name => {
      if (tagCache.has(name)) return tagCache.get(name);
      const existing = tagByName.get(name);
      if (existing) {
        tagCache.set(name, existing.id);
        return existing.id;
      }
      let id;
      if (dryRun) {
        id = 'dry-tag-' + (tagCache.size + 1);
      } else {
        const base = slugify(name) || 'tag-' + uid();
        let slug = base;
        let suffix = 2;
        while (tagBySlug.get(slug)) slug = base + '-' + suffix++;
        id = uid();
        insertTag.run(id, name, slug);
      }
      counts.tags++;
      tagCache.set(name, id);
      return id;
    };

    const slugTaken = slug => Boolean(postBySlug.get(slug)) || plannedSlugs.has(slug);
    const autoSlug = title => {
      const base = normalizeSlug(title) || 'post-' + Date.now().toString(36);
      let candidate = base;
      let suffix = 2;
      while (slugTaken(candidate)) candidate = base + '-' + suffix++;
      return candidate;
    };

    const importAll = () => {
      for (const item of items) {
        const id = 'typecho-' + item.id;
        if (postById.get(id) || plannedIds.has(id)) {
          counts.skipped++;
          continue;
        }
        // 导出里自带别名时按别名去重：与现有内容撞别名就整条跳过，不覆盖。
        let slug = '';
        if (item.slug) {
          const explicit = normalizeSlug(item.slug);
          if (explicit) {
            if (slugTaken(explicit)) {
              counts.skipped++;
              continue;
            }
            slug = explicit;
          }
        }
        if (!slug) slug = autoSlug(item.title);
        plannedIds.add(id);
        plannedSlugs.add(slug);

        const isPage = item.type === 'page';
        const categoryIds = [];
        if (!isPage) {
          for (const name of item.categories) {
            const categoryId = ensureCategory(name);
            if (!categoryIds.includes(categoryId)) categoryIds.push(categoryId);
          }
        }
        const tagIds = [...new Set(item.tags.map(name => ensureTag(name)))];

        if (!dryRun) {
          const status = item.status === 'published' ? 'published' : 'draft';
          const publishedAt = status === 'published' ? (item.date || nowPublishedAt()) : null;
          const content = item.content;
          insertPost.run(
            id, item.title, slug, content, renderMD(content),
            plainText(content).substring(0, 200), isPage ? 'page' : 'post', status,
            publishedAt, auth.id, isPage ? null : (categoryIds[0] || null),
          );
          for (const tagId of tagIds) linkTag.run(id, tagId);
          for (const categoryId of categoryIds) linkCategory.run(id, categoryId);
          importedIds.push(id);
        }
        if (isPage) counts.pages++;
        else counts.posts++;
      }
      return counts;
    };

    try {
      if (dryRun) importAll();
      else withTransaction(db, importAll);
    } catch (err) {
      return error(res, '导入失败：' + (err?.message || '未知错误'), 500);
    }

    if (!dryRun) {
      for (const id of importedIds) {
        try {
          if (typeof triggerHook === 'function') triggerHook('post.saved', db.prepare('SELECT * FROM posts WHERE id = ?').get(id), { isNew: true });
        } catch { /* 钩子异常不能回滚已提交的导入 */ }
      }
      if (typeof logAction === 'function') {
        try { logAction(auth.id, 'import.typecho', '导入 Typecho：文章 ' + counts.posts + '、页面 ' + counts.pages + '、跳过 ' + counts.skipped, req); } catch { /* 日志失败不影响导入结果 */ }
      }
    }

    json(res, {
      dryRun,
      total: items.length,
      posts: counts.posts,
      pages: counts.pages,
      categories: counts.categories,
      tags: counts.tags,
      skipped: counts.skipped,
    });
  });
}
