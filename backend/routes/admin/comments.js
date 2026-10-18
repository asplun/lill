/** Comment moderation and reply routes. */
import { withTransaction } from './shared.js';
import { boundedPagination } from '../../lib/http.js';

export function register(router, ctx, helpers) {
  const { db, json, error, parseBody, validators, uid, authenticate, triggerHook } = ctx;
  const { route, logAction } = helpers;
  const statuses = ['approved', 'pending', 'spam', 'trash'];
  const findComment = id => db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  const commentIds = value => {
    if (!Array.isArray(value) || !value.length ||
        value.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('缺少有效的评论ID列表');
    }
    return [...new Set(value)];
  };

  route('GET', '/api/v1/admin/comments/export', async (req, res) => {
    const auth = await authenticate(req);
    if (!['admin', 'editor'].includes(auth.role)) return error(res, '权限不足', 403);
    const items = db.prepare('SELECT c.*, p.title as post_title, u.username FROM comments c LEFT JOIN posts p ON c.post_id = p.id LEFT JOIN users u ON c.user_id = u.id ORDER BY c.created_at DESC').all();
    const header = 'ID,内容,文章,作者,邮箱,状态,日期\n';
    const rows = items.map(c => {
      const esc = s => '"' + String(s || '').replace(/"/g, '""') + '"';
      return [c.id, esc(c.content), esc(c.post_title), esc(c.author_name || c.username), esc(c.author_email), c.status, c.created_at].join(',');
    }).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="comments.csv"' });
    res.end('\uFEFF' + header + rows);
  });

  route('GET', '/api/v1/admin/comments', async (req, res) => {
    await authenticate(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { page, pageSize, offset } = boundedPagination(url.searchParams, 20, 100);
    const status = url.searchParams.get('status');
    const postId = url.searchParams.get('postId');
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND c.status = ?'; params.push(status); }
    if (postId) { where += ' AND c.post_id = ?'; params.push(postId); }
    const total = db.prepare(`SELECT COUNT(*) as c FROM comments c ${where}`).get(...params).c;
    const items = db.prepare(`SELECT c.*, p.title as post_title, u.username FROM comments c LEFT JOIN posts p ON c.post_id = p.id LEFT JOIN users u ON c.user_id = u.id ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
    json(res, { items, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize), hasNext: page * pageSize < total, hasPrev: page > 1 } });
  });

  route('PATCH', '/api/v1/admin/comments/:id/status', async (req, res, params) => {
    const auth = await authenticate(req);
    const { status } = await parseBody(req);
    if (!statuses.includes(status)) return error(res, '无效状态');
    if (!findComment(params.id)) return error(res, '评论不存在', 404);
    db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(status, params.id);
    logAction(auth.id, 'comment.status', '评论状态更新: ' + params.id + ' -> ' + status, req);
    try { triggerHook('comment.status', { id: params.id, status }); } catch {}
    json(res, { id: params.id, status });
  });

  route('DELETE', '/api/v1/admin/comments/:id', async (req, res, params) => {
    const auth = await authenticate(req);
    if (!['admin', 'editor'].includes(auth.role)) return error(res, '权限不足', 403);
    const gone = findComment(params.id);
    if (!gone) return error(res, '评论不存在', 404);
    db.prepare('DELETE FROM comments WHERE id = ?').run(params.id);
    logAction(auth.id, 'comment.delete', '删除评论: ' + params.id, req);
    try { triggerHook('comment.deleted', gone || { id: params.id }); } catch {}
    json(res, { id: params.id });
  });

  route('GET', '/api/v1/admin/comments/recent', async (req, res) => {
    await authenticate(req);
    const items = db.prepare('SELECT c.id, c.content, c.status, c.created_at, p.title as post_title, c.author_name FROM comments c LEFT JOIN posts p ON c.post_id = p.id ORDER BY c.created_at DESC LIMIT 5').all();
    json(res, items);
  });

  route('POST', '/api/v1/admin/comments/:id/reply', async (req, res, params) => {
    const auth = await authenticate(req);
    const body = await parseBody(req);
    validators.required(body.content, '回复内容');
    body.content = validators.string(body.content, '回复内容', 5000);
    const parent = db.prepare('SELECT * FROM comments WHERE id = ?').get(params.id);
    if (!parent) return error(res, '评论不存在', 404);
    const id = uid();
    db.prepare('INSERT INTO comments (id, content, status, author_name, author_email, post_id, user_id, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.content, 'approved', auth.nickname || auth.username, auth.email || '', parent.post_id, auth.id, parent.id);
    json(res, db.prepare('SELECT * FROM comments WHERE id = ?').get(id), 201);
  });

  route('PUT', '/api/v1/admin/comments/:id', async (req, res, params) => {
    await authenticate(req);
    if (!findComment(params.id)) return error(res, '评论不存在', 404);
    const body = await parseBody(req);
    if (body.content !== undefined) {
      validators.required(body.content, '评论内容');
      body.content = validators.string(body.content, '评论内容', 5000);
    }
    if (body.status !== undefined && !statuses.includes(body.status)) return error(res, '无效状态', 400);
    if (body.author_name !== undefined) body.author_name = validators.string(body.author_name, '评论者昵称', 100);
    if (body.author_email !== undefined) {
      body.author_email = validators.string(body.author_email, '评论者邮箱', 254);
      if (body.author_email !== '') validators.email(body.author_email, '评论者邮箱');
    }
    const updates = [];
    const args = [];
    for (const field of ['content', 'status', 'author_name', 'author_email']) {
      if (body[field] !== undefined) { updates.push(field + ' = ?'); args.push(body[field]); }
    }
    if (updates.length) {
      args.push(params.id);
      db.prepare('UPDATE comments SET ' + updates.join(', ') + ' WHERE id = ?').run(...args);
    }
    json(res, db.prepare('SELECT * FROM comments WHERE id = ?').get(params.id));
  });

  route('PATCH', '/api/v1/admin/comments/batch-status', async (req, res) => {
    await authenticate(req);
    const body = await parseBody(req);
    let selected;
    try { selected = commentIds(body.ids); }
    catch (e) { return error(res, e.message, 400); }
    if (!statuses.includes(body.status)) return error(res, '无效状态');
    for (const id of selected) if (!findComment(id)) return error(res, `评论不存在：${id}`, 404);
    withTransaction(db, () => {
      const stmt = db.prepare('UPDATE comments SET status = ? WHERE id = ?');
      for (const id of selected) stmt.run(body.status, id);
    });
    json(res, { updated: selected.length });
  });
}

