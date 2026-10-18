/**
 * lill HTTP 层：统一响应格式、请求体解析、输入验证、请求日志
 */

export const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: 0, message: 'ok', data }));
};

export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const inputError = message => new HttpError(message, 400);

export function boundedPagination(searchParams, defaultPageSize = 20, maxPageSize = 100) {
  const positive = (value, fallback) => {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) return fallback;
    const number = Number(text);
    if (!Number.isSafeInteger(number)) throw inputError('分页参数过大');
    return number > 0 ? number : fallback;
  };
  const page = positive(searchParams.get('page'), 1);
  const pageSize = Math.min(maxPageSize, positive(searchParams.get('pageSize'), defaultPageSize));
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw inputError('分页参数过大');
  return { page, pageSize, offset };
}

export const error = (res, msg, status = 400) => {
  // 错误响应一律不缓存：否则 404 会被浏览器/CDN 缓存，导致新内容"明明存在却打不开"
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.end(JSON.stringify({ code: 1, message: msg, data: null }));
};

export const parseBody = (req, maxBytes = 50 * 1024 * 1024) => new Promise((resolve, reject) => {
  let b = '';
  let size = 0;
  let tooLarge = false;
  req.on('data', c => {
    if (tooLarge) return;
    size += Buffer.byteLength(c);
    if (size > maxBytes) {
      tooLarge = true;
      b = '';
      return;
    }
    b += c;
  });
  req.on('end', () => {
    if (tooLarge) return reject(new HttpError('请求体过大', 413));
    try { resolve(b ? JSON.parse(b) : {}); }
    catch { reject(inputError('请求体不是有效 JSON')); }
  });
  req.on('error', reject);
});

export const validators = {
  required: (val, name) => {
    if (val === undefined || val === null || val === '' || (typeof val === 'string' && !val.trim())) {
      throw inputError(name + '不能为空');
    }
    return val;
  },
  string: (val, name, max = 500) => { if (typeof val !== 'string') throw inputError(name + '必须是字符串'); if (val.length > max) throw inputError(name + '不能超过' + max + '字符'); return val.trim(); },
  email: (val, name) => { if (val && (typeof val !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val))) throw inputError(name + '格式不正确'); return val; },
  url: (val, name) => { if (val && (typeof val !== 'string' || !/^https?:\/\/.+/.test(val))) throw inputError(name + '必须是有效URL'); return val; },
  boolean: (val) => val === 'true' || val === true || val === '1' || val === 1,
  int: (val, name, min = 0, max = 999999) => { const n = parseInt(val); if (isNaN(n) || n < min || n > max) throw inputError(name + '必须是' + min + '-' + max + '之间的整数'); return n; },
};

export function logRequest(method, path, status, duration) {
  const now = new Date().toISOString();
  const statusStr = status >= 500 ? '\x1b[31m' + status + '\x1b[0m' : status >= 400 ? '\x1b[33m' + status + '\x1b[0m' : '\x1b[32m' + status + '\x1b[0m';
  console.log(now + ' ' + method.padEnd(7) + ' ' + path.padEnd(50) + ' ' + statusStr + ' ' + duration + 'ms');
}

/**
 * 访客真实 IP：优先 X-Real-IP（nginx 用 $remote_addr 写入，客户端无法伪造），
 * 其次取 X-Forwarded-For 的**最后一段**（由最近的 nginx 追加，前面的段客户端可伪造），
 * 最后退到 socket 地址。评论限速 / IP 黑名单 / 重复评论检测都依赖它。
 */
export function clientIp(req) {
  try {
    const h = (req && req.headers) ? req.headers : {};
    const real = h['x-real-ip'];
    if (real) {
      const v = String(Array.isArray(real) ? real[0] : real).split(',')[0].trim();
      if (v) return v.replace(/^::ffff:/, '');
    }
    const xff = h['x-forwarded-for'];
    if (xff) {
      const parts = String(Array.isArray(xff) ? xff[0] : xff).split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1].replace(/^::ffff:/, '');
    }
    const ra = (req && req.socket && req.socket.remoteAddress) || (req && req.connection && req.connection.remoteAddress) || '';
    return String(ra).replace(/^::ffff:/, '');
  } catch (e) { return ''; }
}
