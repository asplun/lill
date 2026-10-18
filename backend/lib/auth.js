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
    // 调用方未必做过类型校验，这里做最后一道防线，避免抛错而不是返回 false
    if (typeof p !== 'string' || typeof stored !== 'string') return false;
    const [salt, hash] = stored.split(':');
    if (!salt || !hash || !/^[0-9a-f]+$/i.test(hash)) return false;
    const expected = Buffer.from(hash, 'hex');
    const actual = scryptSync(p, salt, 64);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };

  const durationMs = value => {
    const match = /^(\d+)([smhd])$/.exec(String(value || ''));
    if (!match) throw new Error('无效的会话时长');
    return Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]);
  };

  const signJWT = (payload, expiresIn = '7d') => {
    const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const now = Date.now();
    const b = b64url(JSON.stringify({ ...payload, iat: now, exp: now + durationMs(expiresIn) }));
    const s = b64url(createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest());
    return h + '.' + b + '.' + s;
  };

  const verifyJWT = (token) => {
    const [h, b, s] = token.split('.');
    const expected = b64url(createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest());
    const actualBuffer = Buffer.from(String(s || ''));
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new Error('Invalid');
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
    const actual = Buffer.from(String(header));
    const expected = Buffer.from(String(csrfToken));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
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
// ── 多因素认证（TOTP，RFC 4226 / RFC 6238）─────────────────
// 纯 node:crypto 实现，无第三方依赖；兼容 Google Authenticator / 1Password 等验证器
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) throw new Error('无效的 Base32 密钥');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 生成 160 位随机密钥的 Base32 编码（RFC 4226 推荐长度，32 位无填充）。 */
export function generateTOTPSecret() {
  let bits = 0, value = 0, secret = '';
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { secret += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) secret += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return secret;
}

function hotp(secretBytes, counter, digits) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secretBytes).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

/**
 * 校验 TOTP 验证码（RFC 6238）。
 * @param {string} secret  用户的 Base32 密钥
 * @param {string} token   验证器显示的验证码
 * @param {{now?: number, stepSeconds?: number, window?: number, digits?: number}} [options]
 * @returns {boolean}
 */
export function verifyTOTP(secret, token, { now = Date.now(), stepSeconds = 30, window = 1, digits = 6 } = {}) {
  if (!secret || token === undefined || token === null) return false;
  const candidate = String(token).trim();
  if (candidate.length !== digits || !/^\d+$/.test(candidate)) return false;
  let secretBytes;
  try { secretBytes = base32Decode(secret); } catch { return false; }
  if (!secretBytes.length) return false;
  const counter = Math.floor(now / 1000 / stepSeconds);
  const candidateBuffer = Buffer.from(candidate);
  for (let drift = -window; drift <= window; drift++) {
    const at = counter + drift;
    if (at < 0) continue;
    const expected = hotp(secretBytes, at, digits);
    if (timingSafeEqual(Buffer.from(expected), candidateBuffer)) return true;
  }
  return false;
}
