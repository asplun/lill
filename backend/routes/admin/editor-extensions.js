import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { validateEditorActionResult, validateEditorFieldValue } from '../../lib/plugin-editor-ext.js';

const CONTENT_TYPES = new Set(['post', 'page']);
const ASSET_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
]);
const MAX_SELECTION = 50000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicField(field) {
  const { plugin, ...meta } = field;
  return meta;
}

function activePlugin(ctx, dir) {
  return !!ctx._activePlugins?.has(dir) &&
    !!ctx.db.prepare('SELECT active FROM plugins WHERE dir = ?').get(dir)?.active;
}

function safeAssetPath(root, requested) {
  if (typeof requested !== 'string' || !requested || requested.startsWith('/') || requested.includes('\\') ||
      requested.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const target = resolve(root, requested);
  const base = realpathSync(root);
  let real;
  try { real = realpathSync(target); } catch { return null; }
  const rel = relative(base, real);
  if (rel.startsWith('..' + '/') || rel === '..' || resolve(base, rel) !== real) return null;
  return real;
}

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, authenticate, PLUGINS_DIR } = ctx;
  const { route, canManagePost } = helpers;
  const registry = ctx._editorRegistry;

  route('GET', '/api/v1/admin/editor-extensions', async (req, res) => {
    await authenticate(req);
    const type = new URL(req.url, `http://${req.headers.host}`).searchParams.get('type');
    if (!CONTENT_TYPES.has(type)) return error(res, '内容类型无效，仅支持 post/page', 400);
    if (!registry) return json(res, { extensions: [] });

    const plugins = new Map();
    for (const field of registry.fieldsFor(type)) {
      const entry = plugins.get(field.plugin) || { plugin: field.plugin, fields: [], actions: [], modules: [] };
      entry.fields.push(publicField(field));
      plugins.set(field.plugin, entry);
    }
    for (const action of registry.actionsFor(type)) {
      const entry = plugins.get(action.plugin) || { plugin: action.plugin, fields: [], actions: [], modules: [] };
      entry.actions.push(action.public);
      plugins.set(action.plugin, entry);
    }
    for (const extension of registry.extensionsFor(type)) {
      const entry = plugins.get(extension.plugin) || { plugin: extension.plugin, fields: [], actions: [], modules: [] };
      const asset = path => `/api/v1/admin/editor-assets/${encodeURIComponent(extension.plugin)}?path=${encodeURIComponent(path)}`;
      entry.modules.push({
        ...extension.public,
        entry: asset(extension.entry),
        styles: extension.styles.map(asset),
      });
      plugins.set(extension.plugin, entry);
    }
    json(res, { extensions: [...plugins.values()] });
  });

  route('GET', '/api/v1/admin/editor-assets/:dir', async (req, res, params) => {
    await authenticate(req);
    const dir = params.dir;
    if (!activePlugin(ctx, dir)) return error(res, '插件未启用', 404);
    const requested = new URL(req.url, `http://${req.headers.host}`).searchParams.get('path');
    const extension = registry?.extensionsFor('post').concat(registry?.extensionsFor('page') || [])
      .find(item => item.plugin === dir && (item.entry === requested || item.styles.includes(requested)));
    if (!extension) return error(res, '插件资源未声明', 404);
    const target = safeAssetPath(join(PLUGINS_DIR, dir), requested);
    const suffix = requested?.slice(requested.lastIndexOf('.')).toLowerCase();
    if (!target || !ASSET_TYPES.has(suffix) || !existsSync(target) || !statSync(target).isFile()) {
      return error(res, '插件资源路径无效', 400);
    }
    res.setHeader('Cache-Control', 'no-store');
    json(res, { content: readFileSync(target, 'utf8'), mime: ASSET_TYPES.get(suffix) });
  });

  route('POST', '/api/v1/admin/editor-actions/:plugin/:action', async (req, res, params) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    const contentType = body?.contentType;
    if (!CONTENT_TYPES.has(contentType)) return error(res, '内容类型无效，仅支持 post/page', 400);
    if (body.selection !== undefined && (typeof body.selection !== 'string' || body.selection.length > MAX_SELECTION)) {
      return error(res, '选区内容无效或过长', 400);
    }
    const action = registry?.getAction(params.plugin, params.action, contentType);
    if (!action) return error(res, '编辑器动作不存在或不适用于当前内容类型', 404);
    let post = null;
    if (body.postId !== undefined && body.postId !== null && body.postId !== '') {
      post = db.prepare('SELECT * FROM posts WHERE id = ?').get(body.postId);
      if (!post) return error(res, '文章不存在', 404);
      if (post.type !== contentType || !canManagePost(auth, post)) return error(res, '无权限', 403);
    }
    let result;
    try {
      result = await action.handler({
        postId: post?.id || null,
        contentType,
        selection: body.selection || '',
        user: { id: auth.id, role: auth.role },
      });
    } catch (e) {
      return error(res, e.message || '编辑器动作执行失败', 400);
    }
    let operation;
    try { operation = validateEditorActionResult(result); }
    catch (e) { return error(res, e.message, 400); }
    if (operation.setPluginField) {
      const field = registry.getField(params.plugin, operation.setPluginField.key, contentType);
      if (!field) return error(res, '动作只能写入本插件已声明字段', 400);
      try { validateEditorFieldValue(field, operation.setPluginField.value); }
      catch (validationError) { return error(res, validationError.message, 400); }
    }
    json(res, operation);
  });
}
