/** Article and page management routes. */
import { withTransaction } from './shared.js';
import { mergeThemeEditorFields, normalizeEditorFieldSchema, readThemeEditorFields } from '../../lib/theme-editor-fields.js';
import { mergePluginEditorFields, readPluginEditorFields } from '../../lib/plugin-editor-ext.js';

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, validators, uid, slugify, renderMD, plainText, authenticate, triggerHook, hashPwd } = ctx;
  const { route, canManagePost, validatePostWrite, logAction, activeThemeId, normalizePageTemplate, listPostsHandler } = helpers;
  const { THEMES_DIR } = ctx;
  const themeRuntime = ctx.themeRuntime;
  const editorRegistry = ctx._editorRegistry;
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const schemaFor = type => themeRuntime?.editorFields
    ? themeRuntime.editorFields(activeThemeId(), type)
    : normalizeEditorFieldSchema(null, type);
  const genericFieldsInput = value => {
    if (!isRecord(value)) return value;
    const result = { ...value };
    delete result._lillThemeFields;
    delete result._lillPluginFields;
    return result;
  };
  const GENERIC_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const GENERIC_RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
  /** 通用自定义字段：名称受限于标识符，值只接受文本、数字、布尔，命名空间键由主题/插件独占 */
  const normalizeGenericFields = value => {
    if (!isRecord(value)) throw new TypeError('自定义字段必须是对象');
    const entries = Object.entries(value);
    if (entries.length > 50) throw new TypeError('自定义字段最多 50 个');
    const result = {};
    for (const [rawKey, rawValue] of entries) {
      const key = String(rawKey).trim();
      if (!GENERIC_KEY.test(key) || GENERIC_RESERVED.has(key)) {
        throw new TypeError('自定义字段名「' + rawKey + '」无效：只能使用字母、数字和下划线，且不能以下划线开头或使用保留字');
      }
      if (rawValue === undefined || rawValue === null) continue;
      if (typeof rawValue === 'string') {
        if (rawValue.length > 50000) throw new TypeError('自定义字段「' + key + '」的内容过长');
        result[key] = rawValue;
      } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        result[key] = rawValue;
      } else if (typeof rawValue === 'boolean') {
        result[key] = rawValue;
      } else {
        throw new TypeError('自定义字段「' + key + '」的值只能是文本、数字或布尔值');
      }
    }
    return result;
  };
  const replaceGenericFields = (storedValue, submittedValue) => {
    let stored = storedValue;
    if (typeof stored === 'string') {
      try { stored = JSON.parse(stored); }
      catch { throw new TypeError('存储的自定义字段不是有效 JSON'); }
    }
    const submitted = genericFieldsInput(submittedValue);
    const themes = isRecord(stored) && isRecord(stored._lillThemeFields) ? stored._lillThemeFields : null;
    const plugins = isRecord(stored) && isRecord(stored._lillPluginFields) ? stored._lillPluginFields : null;
    if (!themes && !plugins) return isRecord(submitted) ? normalizeGenericFields(submitted) : submitted;
    if (!isRecord(submitted)) throw new TypeError('更新通用字段时必须提交对象，才能保留主题字段和插件字段');
    return {
      ...normalizeGenericFields(submitted),
      ...(themes ? { _lillThemeFields: themes } : {}),
      ...(plugins ? { _lillPluginFields: plugins } : {}),
    };
  };
  const fieldsForWrite = (storedValue, genericValue, themeFields, pluginFields, type, themeId) => {
    let next;
    try { next = genericValue === undefined ? storedValue : replaceGenericFields(storedValue, genericValue); }
    catch (validationError) { return { error: validationError.message, status: 400 }; }
    if (next === undefined || next === null || next === '') next = {};
    if (themeFields !== undefined) {
      let schema;
      try {
        schema = themeRuntime?.editorFields
          ? themeRuntime.editorFields(themeId, type)
          : normalizeEditorFieldSchema(null, type);
      } catch {
        return { error: '当前主题内容字段定义无效', status: 500 };
      }
      try {
        next = mergeThemeEditorFields(next, themeId, themeFields, schema);
      } catch (validationError) {
        return { error: validationError.message, status: 400 };
      }
    }
    if (pluginFields !== undefined) {
      try {
        next = mergePluginEditorFields(next, pluginFields, editorRegistry, type);
      } catch (validationError) {
        return { error: validationError.message, status: 400 };
      }
    }
    return { value: next };
  };
  const activeFieldsForRead = (post) => {
    const themeId = activeThemeId();
    try {
      return readThemeEditorFields(post.fields, themeId, schemaFor(post.type));
    } catch {
      return {};
    }
  };
  const activePluginFieldsForRead = (post) => {
    try { return readPluginEditorFields(post.fields, editorRegistry, post.type); }
    catch { return {}; }
  };

  /** 规范自定义别名：保留字母（含中文等 Unicode 字母）、数字与连字符，其余折叠为 - */
  const normalizeSlug = (raw) => String(raw).trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const slugTaken = (slug, excludeId) => !!db.prepare(
    excludeId ? 'SELECT id FROM posts WHERE slug = ? AND id != ?' : 'SELECT id FROM posts WHERE slug = ?'
  ).get(...(excludeId ? [slug, excludeId] : [slug]));
  /** 自动别名：优先使用标题，重复时追加 -2、-3…（对齐 WordPress/Typecho 习惯） */
  const autoSlug = (title, excludeId) => {
    const base = normalizeSlug(title) || 'post-' + Date.now().toString(36);
    let candidate = base, n = 2;
    while (slugTaken(candidate, excludeId)) candidate = base + '-' + n++;
    return candidate;
  };
  /** 解析请求里的别名：留空则自动生成，自定义则校验格式与唯一性 */
  const resolveSlug = (raw, title, excludeId) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return { slug: autoSlug(title, excludeId) };
    if (String(raw).trim().length > 200) return { error: '别名长度不能超过 200 个字符' };
    const slug = normalizeSlug(raw);
    if (!slug) return { error: '别名无效：请使用字母、数字、中文或连字符' };
    if (slugTaken(slug, excludeId)) return { error: '别名「' + slug + '」已被占用，请换一个', taken: true };
    return { slug };
  };
  // 统一存储为 SQLite 可直接比较的 UTC 时间；拒绝 Date 自动进位的非法日期。
  const normalizePublishedAt = value => {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
    if (!match) return null;
    const wallTime = `${match[1]}T${match[2]}:${match[3] || '00'}`;
    const wallDate = new Date(wallTime + 'Z');
    if (!Number.isFinite(wallDate.getTime()) || wallDate.toISOString().slice(0, 19) !== wallTime) return null;
    const date = new Date(wallTime + (match[4] || '') + (match[5] || 'Z'));
    if (!Number.isFinite(date.getTime())) return null;
    const iso = date.toISOString();
    return iso.length === 24 ? iso.slice(0, 19).replace('T', ' ') : null;
  };
  const nowPublishedAt = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const validateWrite = (body, existing) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return '内容参数必须是对象';
    if (body.themeFields !== undefined && (!body.themeFields || typeof body.themeFields !== 'object' || Array.isArray(body.themeFields))) {
      return '主题字段必须是对象';
    }
    if (body.pluginFields !== undefined && (!body.pluginFields || typeof body.pluginFields !== 'object' || Array.isArray(body.pluginFields))) {
      return '插件字段必须是对象';
    }
    if (body.type !== undefined && !['post', 'page'].includes(body.type)) return '无效内容类型，仅支持 post/page';
    if (body.status !== undefined && !['draft', 'published', 'pending'].includes(body.status)) return '无效内容状态，仅支持 draft/published/pending';
    if (body.visibility !== undefined && !['public', 'private', 'password'].includes(body.visibility)) return '可见性无效，仅支持 public、private 或 password';
    const passwordValid = typeof body.password === 'string' && body.password.length >= 4 && body.password.length <= 100;
    // 编辑已有密码文章时，未提交密码（undefined/null/''）视为「保持原密码」，不强制重填。
    const keepPassword = !!existing && existing.visibility === 'password'
      && typeof existing.password === 'string' && existing.password.length > 0
      && (body.password === undefined || body.password === null || body.password === '');
    if (body.password !== undefined && body.password !== null && body.password !== ''
      && !passwordValid) {
      return '密码保护需要 4-100 位密码';
    }
    if (body.visibility === 'password' && !passwordValid && !keepPassword) {
      return '密码保护需要 4-100 位密码';
    }
    if (body.commentAllowed !== undefined && typeof body.commentAllowed !== 'boolean') return '允许评论必须为布尔值';
    if (body.allowPing !== undefined && typeof body.allowPing !== 'boolean') return '允许引用必须为布尔值';
    if (body.allowFeed !== undefined && typeof body.allowFeed !== 'boolean') return '输出到 Feed 必须为布尔值';
    if (body.order !== undefined && !Number.isSafeInteger(body.order)) return '页面顺序必须为整数';
    if (body.excerptAuto !== undefined && typeof body.excerptAuto !== 'boolean') return '自动摘要必须为布尔值';
    if (body.publishedAt !== undefined) {
      if (body.publishedAt === null || body.publishedAt === '') body.publishedAt = null;
      else {
        const date = normalizePublishedAt(body.publishedAt);
        if (!date) return '发布时间格式无效，请使用有效日期时间（YYYY-MM-DD HH:mm:ss 或 ISO 8601）';
        body.publishedAt = date;
      }
    }
    if (body.tagNames !== undefined) {
      if (!Array.isArray(body.tagNames) || body.tagNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 100)) return '标签必须是非空名称数组，每个名称不超过 100 个字符';
      body.tagNames = [...new Set(body.tagNames.map(name => name.trim()))];
    }
    return null;
  };
  // 必须在文章事务内调用；名称是标签身份，slug 冲突只影响新标签的 URL。
  const replaceTags = (postId, names) => {
    const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
    const slugExists = db.prepare('SELECT id FROM tags WHERE slug = ?');
    const insertTag = db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)');
    const linkTag = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)');
    db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(postId);
    for (const name of names) {
      let tag = findTag.get(name);
      if (!tag) {
        const base = slugify(name) || 'tag-' + uid();
        let slug = base, suffix = 2;
        while (slugExists.get(slug)) slug = base + '-' + suffix++;
        tag = { id: uid() };
        insertTag.run(tag.id, name, slug);
      }
      linkTag.run(postId, tag.id);
    }
  };
  route('GET', '/api/v1/admin/posts', (req, res) => listPostsHandler(req, res));
  route('GET', '/api/v1/admin/pages', (req, res) => listPostsHandler(req, res, 'page'));
  route('POST', '/api/v1/admin/pages/reorder', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    const items = Array.isArray(body) ? body : body?.items;
    if (!Array.isArray(items) || !items.length || items.length > 500) return error(res, '页面顺序必须是非空数组', 400);
    if (items.some(item => !item || typeof item.id !== 'string' || !Number.isSafeInteger(item.order) || item.order < 0)) return error(res, '页面顺序数据无效', 400);
    const ids = [...new Set(items.map(item => item.id))];
    if (ids.length !== items.length) return error(res, '页面ID不能重复', 400);
    for (const item of items) {
      const page = db.prepare('SELECT * FROM posts WHERE id = ?').get(item.id);
      if (!page || page.type !== 'page') return error(res, '页面不存在：' + item.id, 404);
      if (!canManagePost(auth, page)) return error(res, '无权限', 403);
    }
    withTransaction(db, () => {
      const update = db.prepare('UPDATE posts SET "order" = ? WHERE id = ? AND type = \'page\'');
      for (const item of items) update.run(item.order, item.id);
    });
    logAction(auth.id, 'page.reorder', '调整页面顺序: ' + items.length + ' 个', req);
    json(res, { updated: items.length });
  });
  route('GET', '/api/v1/admin/editor-fields', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const type = url.searchParams.get('type');
    if (!['post', 'page'].includes(type)) return error(res, '内容类型无效，仅支持 post/page', 400);
    try {
      json(res, { themeId: activeThemeId(), fields: schemaFor(type) });
    } catch {
      error(res, '当前主题内容字段定义无效', 500);
    }
  });
  route('GET', '/api/v1/admin/page-templates', async (req, res) => {
    await authenticate(req);
    const themeId = activeThemeId();
    json(res, { theme: themeId, templates: (await import('../../lib/themes.js')).scanPageTemplates(themeId, THEMES_DIR) });
  });
  /**
   * 页面父子关系校验：只有独立页面能挂父级，禁止自指与环，父级必须存在。
   * 返回 { skip } 表示请求未提交该字段，{ value } 为可写入的 parent_id，{ error } 为拒绝原因。
   */
  const resolvePageParent = (type, parentId, selfId = null) => {
    if (parentId === undefined) return { skip: true };
    if (parentId === null || parentId === '') return { value: null };
    if (typeof parentId !== 'string') return { error: '父级页面无效', status: 400 };
    if (type !== 'page') return { error: '只有独立页面可以设置父级页面', status: 400 };
    if (selfId && parentId === selfId) return { error: '页面不能以自身作为父级', status: 400 };
    const parent = db.prepare('SELECT id, type FROM posts WHERE id = ?').get(parentId);
    if (!parent || parent.type !== 'page') return { error: '父级页面不存在', status: 400 };
    const seen = new Set(selfId ? [selfId] : []);
    let cursor = parent.id;
    while (cursor) {
      if (seen.has(cursor)) return { error: '不能把页面移动到它自己的子页面之下', status: 400 };
      seen.add(cursor);
      cursor = db.prepare('SELECT parent_id FROM posts WHERE id = ?').get(cursor)?.parent_id || null;
    }
    return { value: parent.id };
  };
  /**
   * 多分类校验：接受分类 id 数组，去重、限制数量并确认分类存在。
   * 数组第一个分类同时写入 posts.category_id，作为 {category} 永久链接使用的主分类。
   */
  const normalizeCategoryIds = (value) => {
    if (value === undefined || value === null) return { ids: [] };
    if (!Array.isArray(value)) return { error: '分类列表必须是数组', status: 400 };
    const ids = [];
    for (const raw of value) {
      if (typeof raw !== 'string' || !raw.trim()) return { error: '分类ID无效', status: 400 };
      const id = raw.trim();
      if (ids.includes(id)) continue;
      if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(id)) return { error: '分类不存在：' + id, status: 400 };
      ids.push(id);
    }
    if (ids.length > 20) return { error: '一篇文章最多关联 20 个分类', status: 400 };
    return { ids };
  };
  const syncPostCategories = (postId, categoryIds) => {
    db.prepare('DELETE FROM post_categories WHERE post_id = ?').run(postId);
    const insert = db.prepare('INSERT OR IGNORE INTO post_categories (post_id, category_id) VALUES (?, ?)');
    for (const categoryId of categoryIds) insert.run(postId, categoryId);
  };
  route('POST', '/api/v1/admin/posts', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    const invalid = validateWrite(body);
    if (invalid) return error(res, invalid, 400);
    const denied = validatePostWrite(auth, body);
    if (denied) return error(res, denied, 403);
    validators.required(body.title, '标题');
    validators.string(body.title, '标题', 200);
    if (body.content !== undefined) validators.string(body.content, '内容', 50000);
    const id = uid();
    const slugResult = resolveSlug(body.slug, body.title);
    if (slugResult.error) return error(res, slugResult.error, slugResult.taken ? 409 : 400);
    const slug = slugResult.slug;
    const status = body.status ?? 'draft';
    const visibility = body.visibility ?? 'public';
    const passwordHash = visibility === 'password' ? hashPwd(body.password) : null;
    const publishedAt = body.publishedAt || (status === 'published' ? nowPublishedAt() : null);
    const automaticExcerpt = body.excerptAuto ?? !body.excerpt;
    const excerpt = automaticExcerpt ? plainText(body.content || '').substring(0, 200) : (body.excerpt || '');
    const tpl = normalizePageTemplate(body.type || 'post', body.template);
    const themeId = activeThemeId();
    const contentFields = fieldsForWrite(
      '{}', body.fields || {}, body.themeFields, body.pluginFields, body.type || 'post', themeId,
    );
    if (contentFields.error) return error(res, contentFields.error, contentFields.status);
    const fieldsValue = contentFields.value;
    const parentResult = resolvePageParent(body.type || 'post', body.parentId);
    if (parentResult.error) return error(res, parentResult.error, parentResult.status);
    const parentId = parentResult.value ?? null;
    const categoryResult = normalizeCategoryIds(body.categoryIds !== undefined
      ? body.categoryIds
      : (body.categoryId ? [body.categoryId] : []));
    if (categoryResult.error) return error(res, categoryResult.error, categoryResult.status);
    const categoryIds = categoryResult.ids;
    withTransaction(db, () => {
      db.prepare('INSERT INTO posts (id, title, slug, content, html_content, excerpt, cover_image, type, status, visibility, password, sticky, published_at, author_id, category_id, fields, template, comment_allowed, allow_ping, allow_feed, "order", excerpt_auto, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, body.title, slug, body.content || '', renderMD(body.content || ''), excerpt, body.coverImage || null, body.type || 'post', status, visibility, passwordHash, body.sticky ? 1 : 0, publishedAt, auth.id, categoryIds[0] || null, JSON.stringify(fieldsValue), tpl, body.commentAllowed === false ? 0 : 1, body.allowPing === false ? 0 : 1, body.allowFeed === false ? 0 : 1, body.order ?? 0, automaticExcerpt ? 1 : 0, parentId);
      if (body.tagNames !== undefined) replaceTags(id, body.tagNames);
      syncPostCategories(id, categoryIds);
    });
    logAction(auth.id, 'post.create', '创建文章: ' + body.title, req);
    const created = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    try { triggerHook('post.saved', created, { isNew: true }); } catch {}
    json(res, created, 201);
  });
  route('PUT', '/api/v1/admin/posts/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    const exist = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    if (!exist) return error(res, '文章不存在', 404);
    if (!canManagePost(auth, exist)) return error(res, '无权限', 403);
    const body = await parseBody(req);
    const invalid = validateWrite(body, exist);
    if (invalid) return error(res, invalid, 400);
    const denied = validatePostWrite(auth, body);
    if (denied) return error(res, denied, 403);
    if (body.title !== undefined) validators.string(body.title, '标题', 200);
    if (body.content !== undefined) validators.string(body.content, '内容', 50000);
    const updates = [], args = [];
    const fields = [['title','title'],['content','content'],['coverImage','cover_image'],['type','type'],['status','status'],['sticky','sticky'],['order','"order"']];
    // 自定义别名单独处理：留空保持原值，避免误改导致旧链接失效
    if (body.slug !== undefined && String(body.slug).trim() !== '') {
      const slugResult = resolveSlug(body.slug, exist.title, exist.id);
      if (slugResult.error) return error(res, slugResult.error, slugResult.taken ? 409 : 400);
      updates.push('slug = ?'); args.push(slugResult.slug);
    }
    if (body.template !== undefined) { updates.push('template = ?'); args.push(normalizePageTemplate(body.type || exist.type, body.template)); }
    for (const [f, d] of fields) if (body[f] !== undefined) { updates.push(d + ' = ?'); args.push(f === 'sticky' ? (body[f] ? 1 : 0) : body[f]); }
    // 可见性与密码成对维护：切到 public/private 清空密码；切到 password 时只有提交新密码才覆盖，
    // 留空（undefined/null/''）保留原哈希——编辑已有密码文章不必重填密码。
    if (body.visibility !== undefined) {
      updates.push('visibility = ?');
      args.push(body.visibility);
      if (body.visibility === 'password') {
        if (typeof body.password === 'string' && body.password !== '') {
          updates.push('password = ?');
          args.push(hashPwd(body.password));
        }
      } else {
        updates.push('password = ?');
        args.push(null);
      }
    } else if (body.password !== undefined) {
      // 未同时提交可见性时，非空字符串重置密码，password:''/null 视为清除；
      // 但保持 password 可见性时留空表示「不修改」，避免把受保护文章变成无密码公开。
      const keepExisting = exist.visibility === 'password' && (body.password === '' || body.password === null);
      if (!keepExisting) {
        updates.push('password = ?');
        args.push(body.password === '' || body.password === null ? null : hashPwd(body.password));
      }
    }
    if (body.content !== undefined) updates.push('html_content = ?'), args.push(renderMD(body.content));
    if (body.commentAllowed !== undefined) updates.push('comment_allowed = ?'), args.push(body.commentAllowed ? 1 : 0);
    if (body.allowPing !== undefined) updates.push('allow_ping = ?'), args.push(body.allowPing ? 1 : 0);
    if (body.allowFeed !== undefined) updates.push('allow_feed = ?'), args.push(body.allowFeed ? 1 : 0);
    const automaticExcerpt = body.excerptAuto ?? (body.excerpt !== undefined ? !body.excerpt : exist.excerpt_auto === 1);
    if (body.excerpt !== undefined || body.excerptAuto !== undefined || (automaticExcerpt && body.content !== undefined)) {
      updates.push('excerpt = ?', 'excerpt_auto = ?');
      args.push(automaticExcerpt ? plainText(body.content ?? exist.content).slice(0, 200) : (body.excerpt ?? exist.excerpt ?? ''), automaticExcerpt ? 1 : 0);
    }
    const status = body.status ?? exist.status;
    if (body.publishedAt !== undefined || (status === 'published' && !exist.published_at)) {
      updates.push('published_at = ?');
      args.push(body.publishedAt || (status === 'published' ? (exist.published_at || nowPublishedAt()) : null));
    }
    const parentResult = resolvePageParent(body.type || exist.type, body.parentId, exist.id);
    if (parentResult.error) return error(res, parentResult.error, parentResult.status);
    if (parentResult.value !== undefined) { updates.push('parent_id = ?'); args.push(parentResult.value); }
    // 多分类：传 categoryIds 用数组，传 categoryId 视为单分类，两者都写关系表并把第一个设为主分类。
    let categoryIds = null;
    if (body.categoryIds !== undefined || body.categoryId !== undefined) {
      const requested = body.categoryIds !== undefined ? body.categoryIds : (body.categoryId ? [body.categoryId] : []);
      const categoryResult = normalizeCategoryIds(requested);
      if (categoryResult.error) return error(res, categoryResult.error, categoryResult.status);
      categoryIds = categoryResult.ids;
      updates.push('category_id = ?');
      args.push(categoryIds[0] || null);
    }
    const themeId = activeThemeId();
    if (body.fields || body.themeFields !== undefined || body.pluginFields !== undefined) {
      const contentFields = fieldsForWrite(
        exist.fields, body.fields || undefined, body.themeFields, body.pluginFields, body.type || exist.type, themeId,
      );
      if (contentFields.error) return error(res, contentFields.error, contentFields.status);
      const fieldsValue = contentFields.value;
      updates.push('fields = ?');
      args.push(JSON.stringify(fieldsValue));
    }
    withTransaction(db, () => {
      db.prepare('INSERT INTO post_versions (id, post_id, title, content, html_content, excerpt, status, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uid(), exist.id, exist.title, exist.content, exist.html_content, exist.excerpt, exist.status, exist.author_id);
      if (updates.length) { args.push(params.id); db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`).run(...args); }
      if (body.tagNames !== undefined) replaceTags(params.id, body.tagNames);
      if (categoryIds) syncPostCategories(params.id, categoryIds);
    });
    logAction(auth.id, 'post.update', '更新文章: ' + (body.title || exist.title), req);
    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    try { triggerHook('post.saved', updated, { isNew: false }); } catch {}
    json(res, updated);
  });
  route('GET', '/api/v1/admin/posts/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    if (!post) return error(res, '文章不存在', 404);
    if (!canManagePost(auth, post)) return error(res, '无权限', 403);
    const tags = db.prepare('SELECT t.id, t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?').all(params.id);
    const categories = db.prepare('SELECT c.id, c.name, c.slug FROM categories c JOIN post_categories pc ON pc.category_id = c.id WHERE pc.post_id = ? ORDER BY c.sort_order, c.name').all(params.id);
    json(res, { ...post, tags, categories, categoryIds: categories.map(item => item.id), themeFields: activeFieldsForRead(post), pluginFields: activePluginFieldsForRead(post) });
  });
  route('DELETE', '/api/v1/admin/posts/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    const exist = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    if (!exist) return error(res, '文章不存在', 404);
    if (!canManagePost(auth, exist)) return error(res, '无权限', 403);
    withTransaction(db, () => {
      // 删除父级页面时把子页面提升为顶层，避免留下悬空引用。
      db.prepare('UPDATE posts SET parent_id = NULL WHERE parent_id = ?').run(params.id);
      db.prepare('DELETE FROM post_categories WHERE post_id = ?').run(params.id);
      db.prepare('DELETE FROM posts WHERE id = ?').run(params.id);
    });
    logAction(auth.id, 'post.delete', '删除文章: ' + exist.title, req);
    try { triggerHook('post.deleted', exist); } catch {}
    json(res, { id: params.id });
  });
  // ── 服务器自动草稿（对标 Typecho「保存为草稿」）──
  // 一篇文章只保留一条草稿（post_drafts.post_id UNIQUE），编辑器自动保存时覆盖，正式保存后清除。
  const loadDraft = postId => db.prepare('SELECT id, post_id, title, content, excerpt, author_id, updated_at FROM post_drafts WHERE post_id = ?').get(postId) || null;
  const requireManageablePost = (res, auth, postId) => {
    const post = db.prepare('SELECT id, author_id, status FROM posts WHERE id = ?').get(postId);
    if (!post) { error(res, '文章不存在', 404); return null; }
    if (!canManagePost(auth, post)) { error(res, '无权限', 403); return null; }
    return post;
  };
  route('POST', '/api/v1/admin/posts/:id/autosave', async (req, res, params) => {
    const auth = await authenticate(req);
    if (!requireManageablePost(res, auth, params.id)) return;
    const body = await parseBody(req);
    const title = body.title === undefined ? null : validators.string(body.title, '标题', 200);
    const content = body.content === undefined ? null : validators.string(body.content, '内容', 50000);
    const excerpt = body.excerpt === undefined ? null : validators.string(body.excerpt, '摘要', 500);
    db.prepare(`INSERT INTO post_drafts (id, post_id, title, content, excerpt, author_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(post_id) DO UPDATE SET
        title = COALESCE(excluded.title, post_drafts.title),
        content = COALESCE(excluded.content, post_drafts.content),
        excerpt = COALESCE(excluded.excerpt, post_drafts.excerpt),
        author_id = excluded.author_id,
        updated_at = datetime('now')`)
      .run(uid(), params.id, title, content, excerpt, auth.id);
    json(res, { draft: loadDraft(params.id) });
  });
  route('GET', '/api/v1/admin/posts/:id/autosave', async (req, res, params) => {
    const auth = await authenticate(req);
    if (!requireManageablePost(res, auth, params.id)) return;
    json(res, { draft: loadDraft(params.id) });
  });
  route('DELETE', '/api/v1/admin/posts/:id/autosave', async (req, res, params) => {
    const auth = await authenticate(req);
    if (!requireManageablePost(res, auth, params.id)) return;
    db.prepare('DELETE FROM post_drafts WHERE post_id = ?').run(params.id);
    json(res, { draft: null });
  });
  // ── 修订历史：列表倒序（同一秒写入的版本按 rowid 兜底排序），详情含正文，恢复前把现值再存一版 ──
  route('GET', '/api/v1/admin/posts/:id/versions', async (req, res, params) => {
    const auth = await authenticate(req);
    if (!requireManageablePost(res, auth, params.id)) return;
    const items = db.prepare('SELECT id, post_id, title, excerpt, status, author_id, created_at FROM post_versions WHERE post_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(params.id);
    json(res, { items });
  });
  route('GET', '/api/v1/admin/posts/:id/versions/:versionId', async (req, res, params) => {
    const auth = await authenticate(req);
    if (!requireManageablePost(res, auth, params.id)) return;
    const version = db.prepare('SELECT * FROM post_versions WHERE id = ? AND post_id = ?').get(params.versionId, params.id);
    if (!version) return error(res, '修订版本不存在', 404);
    json(res, version);
  });
  route('POST', '/api/v1/admin/posts/:id/versions/:versionId/restore', async (req, res, params) => {
    const auth = await authenticate(req);
    const exist = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    if (!exist) return error(res, '文章不存在', 404);
    if (!canManagePost(auth, exist)) return error(res, '无权限', 403);
    const version = db.prepare('SELECT * FROM post_versions WHERE id = ? AND post_id = ?').get(params.versionId, params.id);
    if (!version) return error(res, '修订版本不存在', 404);
    const restoredContent = version.content ?? '';
    withTransaction(db, () => {
      // 恢复前先给当前值留快照，恢复本身也可回退。
      db.prepare('INSERT INTO post_versions (id, post_id, title, content, html_content, excerpt, status, author_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uid(), exist.id, exist.title, exist.content, exist.html_content, exist.excerpt, exist.status, exist.author_id);
      db.prepare("UPDATE posts SET title = ?, content = ?, html_content = ?, excerpt = ?, excerpt_auto = 1, updated_at = datetime('now') WHERE id = ?")
        .run(version.title ?? exist.title, restoredContent, renderMD(restoredContent), plainText(restoredContent).slice(0, 200), exist.id);
    });
    logAction(auth.id, 'post.restore', '恢复修订: ' + (version.title || exist.title), req);
    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(params.id);
    try { triggerHook('post.saved', updated, { isNew: false }); } catch {}
    json(res, updated);
  });
  route('GET', '/api/v1/admin/posts/recent', async (req, res) => {
    const auth = await authenticate(req);
    let where = helpers.managesAll(auth) ? '' : ' AND p.author_id = ?';
    if (auth.role === 'contributor') where += " AND p.status = 'draft'";
    const args = helpers.managesAll(auth) ? [] : [auth.id];
    const items = db.prepare(`SELECT p.id, p.title, p.slug, p.type, p.status, p.created_at, u.username as author_name, c.name as category_name FROM posts p LEFT JOIN users u ON p.author_id = u.id LEFT JOIN categories c ON p.category_id = c.id WHERE p.type = ? ${where} ORDER BY p.created_at DESC LIMIT 5`).all('post', ...args);
    json(res, items);
  });
  route('POST', '/api/v1/admin/posts/batch', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!body.ids || !Array.isArray(body.ids)) return error(res, '缺少文章ID列表', 400);
    if (!['publish', 'draft', 'delete', 'category', 'sticky', 'unsticky'].includes(body.action)) return error(res, '无效操作');
    if (auth.role === 'contributor' && body.action === 'publish') return error(res, '投稿者不能发布文章', 403);
    // 批量移动分类：目标分类必须存在，避免把文章挂到已删除的分类上。
    let targetCategory = null;
    if (body.action === 'category') {
      targetCategory = typeof body.categoryId === 'string' ? body.categoryId.trim() : '';
      if (!targetCategory) return error(res, '请选择目标分类', 400);
      if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(targetCategory)) return error(res, '目标分类不存在', 404);
    }
    for (const id of body.ids) {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
      if (!post) return error(res, '文章不存在', 404);
      if (!canManagePost(auth, post)) return error(res, '无权限', 403);
    }
    withTransaction(db, () => {
      if (body.action === 'delete') {
        const dropLinks = db.prepare('DELETE FROM post_categories WHERE post_id = ?');
        const stmt = db.prepare('DELETE FROM posts WHERE id = ?');
        for (const id of body.ids) { dropLinks.run(id); stmt.run(id); }
      } else if (body.action === 'category') {
        // 批量移动按「替换为单一分类」处理：清空旧关系后只保留目标分类。
        const clearLinks = db.prepare('DELETE FROM post_categories WHERE post_id = ?');
        const link = db.prepare('INSERT OR IGNORE INTO post_categories (post_id, category_id) VALUES (?, ?)');
        const stmt = db.prepare('UPDATE posts SET category_id = ? WHERE id = ?');
        for (const id of body.ids) { stmt.run(targetCategory, id); clearLinks.run(id); link.run(id, targetCategory); }
      } else if (body.action === 'sticky' || body.action === 'unsticky') {
        const stmt = db.prepare('UPDATE posts SET sticky = ? WHERE id = ?');
        const sticky = body.action === 'sticky' ? 1 : 0;
        for (const id of body.ids) stmt.run(sticky, id);
      } else {
        const status = body.action === 'publish' ? 'published' : 'draft';
        const stmt = db.prepare(body.action === 'publish'
          ? "UPDATE posts SET status = ?, published_at = COALESCE(NULLIF(published_at, ''), ?) WHERE id = ?"
          : 'UPDATE posts SET status = ? WHERE id = ?');
        const publishedAt = nowPublishedAt();
        for (const id of body.ids) stmt.run(...(body.action === 'publish' ? [status, publishedAt, id] : [status, id]));
      }
    });
    json(res, { updated: body.ids.length });
  });
  route('POST', '/api/v1/admin/pages/batch', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!Array.isArray(body.ids) || !body.ids.length) return error(res, '缺少页面ID列表', 400);
    if (!['publish', 'draft', 'delete'].includes(body.action)) return error(res, '无效操作');
    if (auth.role === 'contributor' && body.action === 'publish') return error(res, '投稿者不能发布页面', 403);
    const ids = [...new Set(body.ids.filter(id => typeof id === 'string' && id.trim()))];
    if (!ids.length) return error(res, '缺少页面ID列表', 400);
    for (const id of ids) {
      const page = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
      if (!page || page.type !== 'page') return error(res, '页面不存在：' + id, 404);
      if (!canManagePost(auth, page)) return error(res, '无权限', 403);
    }
    withTransaction(db, () => {
      if (body.action === 'delete') {
        const dropLinks = db.prepare('DELETE FROM post_categories WHERE post_id = ?');
        const stmt = db.prepare('DELETE FROM posts WHERE id = ?');
        for (const id of ids) { dropLinks.run(id); stmt.run(id); }
      } else {
        const status = body.action === 'publish' ? 'published' : 'draft';
        const stmt = db.prepare(body.action === 'publish'
          ? "UPDATE posts SET status = ?, published_at = COALESCE(NULLIF(published_at, ''), ?) WHERE id = ?"
          : 'UPDATE posts SET status = ? WHERE id = ?');
        const publishedAt = nowPublishedAt();
        for (const id of ids) stmt.run(...(body.action === 'publish' ? [status, publishedAt, id] : [status, id]));
      }
    });
    logAction(auth.id, 'page.batch-' + body.action, '批量' + body.action + '页面: ' + ids.length + ' 个', req);
    json(res, { updated: ids.length });
  });
}
