/**
 * lill HTTP 层：统一响应格式、请求体解析、输入验证、请求日志
 */

export const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: 0, message: 'ok', data }));
};

export const error = (res, msg, status = 400) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
