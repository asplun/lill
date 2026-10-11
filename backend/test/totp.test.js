import assert from 'node:assert/strict';
import test from 'node:test';
import { generateTOTPSecret, verifyTOTP } from '../lib/auth.js';

// RFC 6238 附录 B 测试密钥：ASCII "12345678901234567890" 的 Base32（SHA-1，8 位）
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

// RFC 6238 SHA-1 测试向量（8 位），6 位验证码取末 6 位
const vectors = [
  [59, '94287082', '287082'],
  [1111111109, '07081804', '081804'],
  [1111111111, '14050471', '050471'],
  [1234567890, '89005924', '005924'],
  [2000000000, '69279037', '279037'],
  [20000000000, '65353130', '353130'],
];

test('verifyTOTP matches the RFC 6238 SHA-1 test vectors', () => {
  for (const [seconds, expected8, expected6] of vectors) {
    const at = seconds * 1000;
    assert.equal(verifyTOTP(RFC_SECRET, expected8, { now: at, digits: 8 }), true, `8-digit @${seconds}`);
    assert.equal(verifyTOTP(RFC_SECRET, expected6, { now: at }), true, `6-digit @${seconds}`);
  }
});

test('verifyTOTP rejects wrong, malformed, and out-of-window codes', () => {
  const at = 1111111111 * 1000;
  assert.equal(verifyTOTP(RFC_SECRET, '050472', { now: at }), false, 'wrong code');
  assert.equal(verifyTOTP(RFC_SECRET, '000000', { now: at }), false, 'wrong code');
  assert.equal(verifyTOTP(RFC_SECRET, 'abcdef', { now: at }), false, 'non-numeric');
  assert.equal(verifyTOTP(RFC_SECRET, '12345', { now: at }), false, 'too short');
  assert.equal(verifyTOTP(RFC_SECRET, '1234567', { now: at }), false, 'too long');
  assert.equal(verifyTOTP(RFC_SECRET, '', { now: at }), false, 'empty');
  assert.equal(verifyTOTP('', '050471', { now: at }), false, 'missing secret');
  assert.equal(verifyTOTP(RFC_SECRET, null, { now: at }), false, 'missing token');
  assert.equal(verifyTOTP(RFC_SECRET, '050471', { now: at + 120000 }), false, 'outside ±1 step window');
});

test('verifyTOTP tolerates a one-step clock drift in both directions', () => {
  // T=37037037 所在的时间步，分别验证「验证器慢一步」和「验证器快一步」
  const stepStart = 37037037 * 30 * 1000;
  assert.equal(verifyTOTP(RFC_SECRET, '081804', { now: stepStart + 20000 }), true, 'tolerates the previous step');
  assert.equal(verifyTOTP(RFC_SECRET, '050471', { now: stepStart - 20000 }), true, 'tolerates the next step');
});

test('generateTOTPSecret returns unique, decodable Base32 secrets', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const secret = generateTOTPSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/, `unexpected secret: ${secret}`);
    seen.add(secret);
  }
  assert.equal(seen.size, 50, 'secrets must not repeat');
});
