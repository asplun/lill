/** Media upload and library routes. */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createThumbnailOnUpload } from '../../lib/thumbnail.js';
import { boundedPagination } from '../../lib/http.js';
import { withTransaction } from './shared.js';

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, uid, authenticate, triggerHook, core, UPLOAD_DIR } = ctx;
  // Keep route registration compatible with lightweight integrations while the server uses core.media.
  const mediaProvider = core?.media || { uploadDir: UPLOAD_DIR, publicUrl: fileName => '/uploads/' + fileName };
  const { route, managesAll } = helpers;
  const mimeMap = [
    { ext: '.jpg', magic: [0xFF, 0xD8, 0xFF], mime: 'image/jpeg' }, { ext: '.jpeg', magic: [0xFF, 0xD8, 0xFF], mime: 'image/jpeg' },
    { ext: '.png', magic: [0x89, 0x50, 0x4E, 0x47], mime: 'image/png' }, { ext: '.gif', magic: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
    { ext: '.webp', magic: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' }, { ext: '.pdf', magic: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
    { ext: '.zip', magic: [0x50, 0x4B, 0x03, 0x04], mime: 'application/zip' },
  ];
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const dimensions = (fileBuf, ext) => {
    let width = null, height = null;
    if (imageExts.includes(ext)) {
      try {
        if (ext === '.png') { width = fileBuf.readUInt32BE(16); height = fileBuf.readUInt32BE(20); }
        else if (ext === '.gif') { width = fileBuf.readUInt16LE(6); height = fileBuf.readUInt16LE(8); }
        else if (ext === '.jpg' || ext === '.jpeg') {
          let offset = 2;
          while (offset < fileBuf.length - 9) {
            if (fileBuf[offset] === 0xFF) {
              const marker = fileBuf[offset + 1];
              if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) { height = fileBuf.readUInt16BE(offset + 5); width = fileBuf.readUInt16BE(offset + 7); break; }
              offset += 2 + fileBuf.readUInt16BE(offset + 2);
            } else offset++;
          }
        }
      } catch {}
    }
    return { width, height };
  };

  route('POST', '/api/v1/admin/media/upload', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req, 40 * 1024 * 1024);
    if (!body.data || !body.name) return error(res, '缺少文件数据', 400);
    const ext = (body.name.match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf', '.txt', '.md', '.zip'].includes(ext) ? ext : '';
    const filename = Date.now().toString(36) + '-' + randomBytes(4).toString('hex') + safeExt;
    const fp = join(mediaProvider.uploadDir, filename);
    const fileBuf = Buffer.from(body.data, 'base64');
    const mimeCheck = mimeMap.find(item => item.ext === safeExt);
    if (mimeCheck && !mimeCheck.magic.every((byte, index) => fileBuf[index] === byte)) return error(res, '文件类型与扩展名不符', 400);
    writeFileSync(fp, fileBuf);
    const id = uid();
    const url = mediaProvider.publicUrl(filename);
    const { width, height } = dimensions(fileBuf, safeExt);
    const thumbnailUrl = createThumbnailOnUpload(fp, safeExt);
    db.prepare('INSERT INTO media (id, name, path, url, mime_type, size, width, height, alt, thumbnail_url, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, fp, url, body.mime || 'application/octet-stream', fileBuf.length, width, height, body.alt || null, thumbnailUrl, auth.id);
    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
    try { triggerHook('media.uploaded', media, { isNew: true }); } catch {}
    json(res, media, 201);
  });

  route('PUT', '/api/v1/admin/media/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(params.id);
    if (!media) return error(res, '文件不存在', 404);
    if (!managesAll(auth) && media.uploader_id !== auth.id) return error(res, '权限不足', 403);
    const body = await parseBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const slug = body.slug == null ? '' : String(body.slug).trim();
    const alt = body.alt == null ? '' : String(body.alt).trim();
    const description = body.description == null ? '' : String(body.description).trim();
    if (!name) return error(res, '文件名不能为空', 400);
    if (name.length > 255) return error(res, '文件名不能超过 255 个字符', 400);
    if (slug.length > 120 || (slug && !/^[a-z0-9-]+$/.test(slug))) return error(res, '缩略名格式无效', 400);
    if (alt.length > 500) return error(res, '替代文本不能超过 500 个字符', 400);
    if (description.length > 2000) return error(res, '描述不能超过 2000 个字符', 400);
    db.prepare('UPDATE media SET name = ?, slug = ?, alt = ?, description = ? WHERE id = ?').run(name, slug || null, alt || null, description || null, media.id);
    json(res, db.prepare('SELECT * FROM media WHERE id = ?').get(media.id));
  });

  route('POST', '/api/v1/admin/media/:id/replace', async (req, res, params) => {
    const auth = await authenticate(req);
    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(params.id);
    if (!media) return error(res, '文件不存在', 404);
    if (!managesAll(auth) && media.uploader_id !== auth.id) return error(res, '权限不足', 403);
    const body = await parseBody(req, 40 * 1024 * 1024);
    if (!body.data || !body.name) return error(res, '缺少文件数据', 400);
    const ext = extname(media.name).toLowerCase();
    const replacementExt = extname(String(body.name)).toLowerCase();
    if (!mimeMap.some(item => item.ext === ext) && !['.svg', '.txt', '.md'].includes(ext)) return error(res, '不支持替换此文件类型', 400);
    if (replacementExt !== ext) return error(res, '替换文件扩展名必须与原文件一致', 400);
    const fileBuf = Buffer.from(body.data, 'base64');
    const mimeCheck = mimeMap.find(item => item.ext === ext);
    if (mimeCheck && !mimeCheck.magic.every((byte, index) => fileBuf[index] === byte)) return error(res, '文件类型与扩展名不符', 400);
    writeFileSync(media.path, fileBuf);
    const { width, height } = dimensions(fileBuf, ext);
    const thumbnailUrl = createThumbnailOnUpload(media.path, ext);
    const mime = mimeCheck?.mime || (ext === '.svg' ? 'image/svg+xml' : ext === '.txt' ? 'text/plain' : 'text/markdown');
    db.prepare('UPDATE media SET size = ?, width = ?, height = ?, mime_type = ?, thumbnail_url = ? WHERE id = ?')
      .run(fileBuf.length, width, height, mime, thumbnailUrl, media.id);
    json(res, db.prepare('SELECT * FROM media WHERE id = ?').get(media.id));
  });

  route('GET', '/api/v1/admin/media', async (req, res) => {
    const auth = await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { page, pageSize, offset } = boundedPagination(url.searchParams, 20, 100);
    const rawKeyword = (url.searchParams.get('keyword') || '').trim();
    const keyword = rawKeyword.length >= 1 && rawKeyword.length <= 100 ? rawKeyword : '';
    const conditions = [];
    const args = [];
    if (!managesAll(auth)) { conditions.push('m.uploader_id = ?'); args.push(auth.id); }
    if (keyword) { conditions.push('(m.name LIKE ? OR m.alt LIKE ?)'); args.push(`%${keyword}%`, `%${keyword}%`); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) as c FROM media m${where}`).get(...args).c;
    const items = db.prepare(`SELECT m.*, u.username as uploader_name FROM media m LEFT JOIN users u ON m.uploader_id = u.id${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset);
    json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
  });

  route('DELETE', '/api/v1/admin/media/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(params.id);
    if (!media) return error(res, '文件不存在', 404);
    if (!managesAll(auth) && media.uploader_id !== auth.id) return error(res, '权限不足', 403);
    try { const { unlinkSync } = await import('node:fs'); unlinkSync(media.path); } catch {}
    db.prepare('DELETE FROM media WHERE id = ?').run(params.id);
    try { triggerHook('media.deleted', media); } catch {}
    json(res, { id: params.id });
  });

  route('POST', '/api/v1/admin/media/batch', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!['delete', 'alt'].includes(body.action)) return error(res, '无效操作', 400);
    if (!Array.isArray(body.ids) || !body.ids.length) return error(res, '缺少文件ID列表', 400);
    const ids = [...new Set(body.ids.filter(id => typeof id === 'string' && id.trim()))];
    if (!ids.length) return error(res, '缺少文件ID列表', 400);
    const files = [];
    for (const id of ids) {
      const media = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
      if (!media) return error(res, '文件不存在：' + id, 404);
      if (!managesAll(auth) && media.uploader_id !== auth.id) return error(res, '权限不足', 403);
      files.push(media);
    }
    if (body.action === 'alt') {
      const alt = body.alt == null ? '' : String(body.alt).trim();
      if (alt.length > 500) return error(res, '替代文本不能超过 500 个字符', 400);
      withTransaction(db, () => {
        const update = db.prepare('UPDATE media SET alt = ? WHERE id = ?');
        for (const media of files) update.run(alt, media.id);
      });
      return json(res, { updated: files.length, alt });
    }
    const { unlinkSync } = await import('node:fs');
    for (const media of files) {
      try { unlinkSync(media.path); } catch {}
      db.prepare('DELETE FROM media WHERE id = ?').run(media.id);
      try { triggerHook('media.deleted', media); } catch {}
    }
    json(res, { deleted: files.length });
  });
}
