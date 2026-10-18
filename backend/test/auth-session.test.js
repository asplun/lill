import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuth } from '../lib/auth.js';

function expiry(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
}

test('login tokens honor the requested session lifetime', () => {
  const auth = createAuth('session-lifetime-test-secret');
  const before = Date.now();
  const short = auth.signJWT({ id: 'short' }, '2h');
  const long = auth.signJWT({ id: 'long' }, '30d');
  const after = Date.now();

  assert.ok(expiry(short) >= before + 2 * 60 * 60 * 1000);
  assert.ok(expiry(short) <= after + 2 * 60 * 60 * 1000);
  assert.ok(expiry(long) >= before + 30 * 24 * 60 * 60 * 1000);
  assert.ok(expiry(long) <= after + 30 * 24 * 60 * 60 * 1000);
});

test('an invalid token signature is rejected', () => {
  const auth = createAuth('session-signature-test-secret');
  const token = auth.signJWT({ id: 'user' }, '2h');
  const [header, payload] = token.split('.');
  assert.throws(() => auth.verifyJWT(`${header}.${payload}.invalid`), /Invalid/);
});

test('malformed CSRF headers are rejected instead of throwing', () => {
  const auth = createAuth('csrf-length-test-secret');
  const token = auth.generateCSRFToken();
  assert.equal(auth.verifyCSRFToken({ headers: { 'x-csrf-token': 'short' } }, token), false);
  assert.equal(auth.verifyCSRFToken({ headers: { 'x-csrf-token': token } }, token), true);
});
