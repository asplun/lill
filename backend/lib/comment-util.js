/**
 * 评论公共工具（文章评论 / 说说评论共用）
 * ────────────────────────────────────────────────────────────
 * 头像策略与 TriM3 原版一致（lib/helpers.php: tri3_comment_avatar / tri3_gravatar_url）：
 *   1. 已登录用户 → users.avatar
 *   2. 有 QQ 号（显式填写，或邮箱是数字@qq.com）→ q1.qlogo.cn QQ 头像
 *   3. 有邮箱 → Cravatar 邮箱头像（md5），主源 cn.cravatar.com，前端 onerror 依次降级
 *      weavatar.com / cravatar.cn
 * 说明：对外响应**不暴露** author_email（隐私），只给出算好的 avatar。
 */
import { createHash } from 'node:crypto';

/** 评论可用邮箱头像源（顺序即优先级，与原版 tri3_gravatar_hosts 一致） */
export const GRAVATAR_HOSTS = ['cn.cravatar.com/avatar/', 'weavatar.com/avatar/', 'cravatar.cn/avatar/'];

/** 从邮箱里猜 QQ 号：123456@qq.com → 123456 */
export function qqFromEmail(email) {
  const m = /^(\d{5,12})@qq\.com$/i.exec(String(email || '').trim());
  return m ? m[1] : '';
}

/** 规范化用户填写的 QQ（支持纯数字、qq:123、QQ 号带空格） */
export function normQQ(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().replace(/^qq[:：]?\s*/i, '');
  return /^\d{5,12}$/.test(s) ? s : '';
}

export function md5hex(s) {
  return createHash('md5').update(String(s), 'utf8').digest('hex');
}

/**
 * 计算评论者头像；返回 { avatar, avatarFallback[] }。
 * row 需含：avatar（users.avatar）/ author_qq / author_email（或 user_email 兜底）
 */
export function avatarOf(row) {
  row = row || {};
  const userAvatar = String(row.avatar || '').trim();
  if (userAvatar) return { avatar: userAvatar, avatarHosts: [] };

  // 邮箱优先级：评论自填邮箱 → 关联账号邮箱
  // （注册用户走前台评论时 author_email 常为空串，此时用 LEFT JOIN 带出的 u.email）
  const mail0 = String(row.author_email || '').trim() || String(row.user_email || '').trim();

  const qq = normQQ(row.author_qq) || qqFromEmail(mail0);
  if (qq) {
    return { avatar: 'https://q1.qlogo.cn/g?b=qq&nk=' + qq + '&s=100', avatarHosts: [] };
  }

  const mail = mail0.toLowerCase();
  if (mail) {
    const hash = md5hex(mail);
    return {
      avatar: 'https://' + GRAVATAR_HOSTS[0] + hash + '?d=mp&s=100',
      avatarHosts: GRAVATAR_HOSTS.slice(1).map(h => 'https://' + h + hash + '?d=mp&s=100')
    };
  }
  return { avatar: '', avatarHosts: [] };
}

/** 只保留 http(s) 的网址，避免 javascript: 之类进入 href */
export function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

/** 单条评论 → 前端结构（不暴露邮箱）
 *  ownerId：文章作者 / 说说所属人（用于「博主」徽标）
 *  viewer ：当前访客（可为 null），用于判断能否删除
 */
export function shapeComment(row, ownerId, viewer) {
  const av = avatarOf(row);
  const name = String(row.nickname || row.author_name || '').trim();
  const mine = !!(row.user_id && viewer && row.user_id === viewer.id);
  const isOwner = !!(row.user_id && ownerId && row.user_id === ownerId);
  const isAdmin = !!(viewer && viewer.role === 'admin');
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    created_at: row.created_at,
    // created_at 为 UTC（SQLite datetime('now')）；date 供模板 |date 过滤器使用
    date: row.created_at,
    likes: row.likes || 0,
    parent_id: row.parent_id || null,
    author: name || '匿名',
    author_url: safeUrl(row.author_url),
    avatar: av.avatar,
    avatar_hosts: av.avatarHosts,
    // 模板里不好遍历数组，另给一份换行分隔的字符串（前端 onerror 降级用）
    avatar_hosts_str: av.avatarHosts.join('\n'),
    is_owner: isOwner,
    is_blogger: isOwner,
    is_admin_user: !!row.user_id,
    is_mine: mine,
    can_delete: !!(viewer && (mine || isAdmin || (!!ownerId && viewer.id === ownerId)))
  };
}

/** 排序白名单 → ORDER BY 片段（hot = 点赞多的在前，其次最新） */
export function orderBy(sort, alias) {
  const c = (alias ? alias + '.' : '') + 'created_at';
  const l = (alias ? alias + '.' : '') + 'likes';
  if (sort === 'hot') return l + ' DESC, ' + c + ' DESC';
  /* 原版 helpers.php tri3_comment_sort()：默认倒序（最新在上），?commentSort=asc 时正序 */
  if (sort === 'asc') return c + ' ASC';
  return c + ' DESC';
}

/**
 * 组装两层评论树：顶层 + replies（replies 一律按时间正序，符合对话阅读习惯）
 * rows: 顶层行；childrenOf(parentId) → 子行数组
 */
export function buildTree(rows, childrenOf, ownerId, viewer) {
  return rows.map(r => {
    const item = shapeComment(r, ownerId, viewer);
    const kids = childrenOf(r.id) || [];
    item.replies = kids.map(k => shapeComment(k, ownerId, viewer));
    item.reply_count = item.replies.length;
    return item;
  });
}
