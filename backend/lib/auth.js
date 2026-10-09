/**
 * lill 认证：密码哈希 + JWT 签发/校验 + CSRF 防护
 */
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

export function createAuth(JWT_SECRET) {
  const b64url = (b) => Buffer.from(b).toString('base64url').replace(/=+$/g, '');

  const hashPwd = (p) => {
    const s = randomBytes(16).toString('hex');
    return s + ':' + scryptSync(p, s, 64).toString('hex');
  };

  const verifyPwd = (p, stored) => {
    const [salt, hash] = stored.split(':');
    return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(p, salt, 64));
  };

  const signJWT = (payload) => {
    const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const b = b64url(JSON.stringify({ ...payload, exp: Date.now() + 604800000 }));
    const s = b64url(createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest());
    return h + '.' + b + '.' + s;
  };

  const verifyJWT = (token) => {
    const [h, b, s] = token.split('.');
    if (b64url(createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest()) !== s) throw new Error('Invalid');
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (p.exp < Date.now()) throw new Error('Expired');
    return p;
  };

  const authenticate = async (req) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new Error('未登录');
    return verifyJWT(auth.slice(7));
  };

  // ═══ CSRF 防护 ═══
  // 登录时生成 CSRF token，前端在写操作中通过 X-CSRF-Token 头带回
  const generateCSRFToken = () => randomBytes(32).toString('hex');

  const verifyCSRFToken = (req, csrfToken) => {
    const header = req.headers['x-csrf-token'];
    if (!header || !csrfToken) return false;
    return timingSafeEqual(Buffer.from(header), Buffer.from(csrfToken));
  };

  return { hashPwd, verifyPwd, signJWT, verifyJWT, authenticate, generateCSRFToken, verifyCSRFToken };
}

// 验证码生成（纯 Node.js，SVG 格式）
export function generateCaptcha() {
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">' +
    '<rect width="120" height="40" fill="#f3f4f6"/>' +
    '<text x="60" y="28" font-size="24" font-family="monospace" text-anchor="middle" fill="#374151">' + code + '</text>' +
    '</svg>';
  return { code, svg };
}

// 验证码验证
export function verifyCaptcha(sessionCode, inputCode) {
  if (!sessionCode || !inputCode) return false;
  return sessionCode.toUpperCase() === inputCode.toUpperCase();
}

// 多因素认证 - TOTP 密钥生成
export function generateTOTPSecret() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  for (let i = 0; i < 16; i++) {
    secret += chars[Math.floor(Math.random() * chars.length)];
  }
  return secret;
}

// 多因素认证 - 验证 TOTP（简化版，实际应使用 otplib 库）
export function verifyTOTP(secret, token) {
  // 简化实现：实际生产环境应使用标准 TOTP 算法
  // 这里仅作为接口占位
  return secret && token && token.length === 6;
}
