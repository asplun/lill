import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarOf } from '../lib/comment-util.js';

test('email avatar and fallback hosts use identicon at 40px', () => {
  const result = avatarOf({ author_email: 'visitor@example.com' });
  assert.match(result.avatar, /^https:\/\/cn\.cravatar\.com\/avatar\/[a-f0-9]{32}\?d=identicon&s=40$/);
  assert.deepEqual(result.avatarHosts.map(url => new URL(url).host), ['weavatar.com', 'cravatar.cn']);
  assert.ok(result.avatarHosts.every(url => url.endsWith('?d=identicon&s=40')));
});
