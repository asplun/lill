/**
 * 极简 ZIP 解压（仅依赖 node:zlib，支持 store / deflate）
 * 用途：后台「上传主题」安装 zip 包，避免引入第三方依赖。
 * 安全：拒绝绝对路径与 ../ 越界路径，防目录穿越（Zip Slip）。
 */
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

// 从尾部查找 EOCD（注释区最大 65535 字节）
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

export function listZipEntries(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);           // 中央目录偏移
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, rawSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function readZipEntry(buf, entry) {
  const p = entry.localOff;
  if (buf.readUInt32LE(p) !== SIG_LOC) throw new Error('ZIP 本地头损坏: ' + entry.name);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error('不支持的压缩方式: ' + entry.method);
}

// 规范化条目路径：剥离前导 / 与盘符，禁止 .. 越界
export function safeEntryPath(name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = [];
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;               // 越界 → 丢弃
    parts.push(seg);
  }
  if (!parts.length) return null;
  return parts.join('/');
}
