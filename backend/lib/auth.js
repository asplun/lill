/**
 * lill 认证：密码哈希 + JWT 签发/校验
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

  return { hashPwd, verifyPwd, signJWT, verifyJWT, authenticate };
}
