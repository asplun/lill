/** Media upload and library routes. */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createThumbnailOnUpload } from '../../lib/thumbnail.js';

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, uid, authenticate, triggerHook, core, UPLOAD_DIR } = ctx;
  // Keep route registration compatible with lightweight integrations while the server uses core.media.
  const mediaProvider = core?.media || { uploadDir: UPLOAD_DIR, publicUrl: fileName => '/uploads/' + fileName };
  const { route, managesAll } = helpers;

  route('POST', '/api/v1/admin/media/upload', async (req, res) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    if (!body.data || !body.name) return error(res, '缺少文件数据', 400);
    const ext = (body.name.match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf', '.txt', '.md', '.zip'].includes(ext) ? ext : '';
    const filename = Date.now().toString(36) + '-' + randomBytes(4).toString('hex') + safeExt;
    const fp = join(mediaProvider.uploadDir, filename);
    const fileBuf = Buffer.from(body.data, 'base64');
    const mimeMap = [
      { ext: '.jpg', magic: [0xFF, 0xD8, 0xFF] }, { ext: '.jpeg', magic: [0xFF, 0xD8, 0xFF] },
      { ext: '.png', magic: [0x89, 0x50, 0x4E, 0x47] }, { ext: '.gif', magic: [0x47, 0x49, 0x46, 0x38] },
      { ext: '.webp', magic: [0x52, 0x49, 0x46, 0x46] }, { ext: '.pdf', magic: [0x25, 0x50, 0x44, 0x46] },
      { ext: '.zip', magic: [0x50, 0x4B, 0x03, 0x04] },
    ];
    const mimeCheck = mimeMap.find(item => item.ext === safeExt);
    if (mimeCheck && !mimeCheck.magic.every((byte, index) => fileBuf[index] === byte)) return error(res, '文件类型与扩展名不符', 400);
    writeFileSync(fp, fileBuf);
    const id = uid();
    const url = mediaProvider.publicUrl(filename);
    let width = null;
    let height = null;
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(safeExt)) {
      try {
        if (safeExt === '.png') {
          width = fileBuf.readUInt32BE(16);
          height = fileBuf.readUInt32BE(20);
        } else if (safeExt === '.gif') {
          width = fileBuf.readUInt16LE(6);
          height = fileBuf.readUInt16LE(8);
        } else if (safeExt === '.jpg' || safeExt === '.jpeg') {
          let offset = 2;
          while (offset < fileBuf.length - 9) {
            if (fileBuf[offset] === 0xFF) {
              const marker = fileBuf[offset + 1];
              if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
                height = fileBuf.readUInt16BE(offset + 5);
                width = fileBuf.readUInt16BE(offset + 7);
                break;
              }
              offset += 2 + fileBuf.readUInt16BE(offset + 2);
            } else offset++;
          }
        }
      } catch { /* invalid dimensions do not reject a valid upload */ }
    }
    const thumbnailUrl = createThumbnailOnUpload(fp, safeExt);
    db.prepare('INSERT INTO media (id, name, path, url, mime_type, size, width, height, alt, thumbnail_url, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, fp, url, body.mime || 'application/octet-stream', fileBuf.length, width, height, body.alt || null, thumbnailUrl, auth.id);
    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
    try { triggerHook('media.uploaded', media, { isNew: true }); } catch {}
    json(res, media, 201);
  });

  route('GET', '/api/v1/admin/media', async (req, res) => {
    const auth = await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const pageSize = parseInt(url.searchParams.get('pageSize')) || 20;
    const where = managesAll(auth) ? '' : ' WHERE m.uploader_id = ?';
    const args = managesAll(auth) ? [] : [auth.id];
    const total = db.prepare(`SELECT COUNT(*) as c FROM media m${where}`).get(...args).c;
    const items = db.prepare(`SELECT m.*, u.username as uploader_name FROM media m LEFT JOIN users u ON m.uploader_id = u.id${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
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
}
