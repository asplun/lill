/**
 * lill HTTP 层：统一响应格式、请求体解析、输入验证、请求日志
 */

/**
 * 响应数据变换钩子：由 server.js 注入「输出层 CDN 签名」（对照原版 TriM3 在每次输出
 * 时调用 tri3_qiniu_sign_url 的做法）。未注入或抛错时原样输出，绝不影响接口可用性。
 */
let jsonTransform = null;
export function setJsonTransform(fn) { jsonTransform = (typeof fn === 'function') ? fn : null; }

export const json = (res, data, status = 200) => {
  if (jsonTransform) { try { data = jsonTransform(data); } catch (e) { /* 签名失败不影响响应 */ } }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: 0, message: 'ok', data }));
};

export const error = (res, msg, status = 400) => {
  // 错误响应一律不缓存：否则 404 会被浏览器/CDN 缓存，导致新内容"明明存在却打不开"
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.end(JSON.stringify({ code: 1, message: msg, data: null }));
};

export const parseBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); }
  });
  req.on('error', reject);
});

export const validators = {
  required: (val, name) => { if (val === undefined || val === null || val === '') throw new Error(name + '不能为空'); return val; },
  string: (val, name, max = 500) => { if (typeof val !== 'string') throw new Error(name + '必须是字符串'); if (val.length > max) throw new Error(name + '不能超过' + max + '字符'); return val.trim(); },
  email: (val, name) => { if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) throw new Error(name + '格式不正确'); return val; },
  url: (val, name) => { if (val && !/^https?:\/\/.+/.test(val)) throw new Error(name + '必须是有效URL'); return val; },
  boolean: (val) => val === 'true' || val === true || val === '1' || val === 1,
  int: (val, name, min = 0, max = 999999) => { const n = parseInt(val); if (isNaN(n) || n < min || n > max) throw new Error(name + '必须是' + min + '-' + max + '之间的整数'); return n; },
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
