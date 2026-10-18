import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from '../routes/admin/shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fakeDb() {
  const calls = [];
  return {
    calls,
    exec(sql) { calls.push(sql.trim()); },
  };
}

test('withTransaction commits when the callback succeeds', () => {
  const db = fakeDb();
  const result = withTransaction(db, () => 42);
  assert.equal(result, 42);
  assert.deepEqual(db.calls, ['BEGIN', 'COMMIT']);
});

test('withTransaction rolls back and rethrows when the callback fails', () => {
  const db = fakeDb();
  assert.throws(() => withTransaction(db, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(db.calls, ['BEGIN', 'ROLLBACK']);
});

test('withTransaction rolls back when commit itself fails', () => {
  const db = {
    calls: [],
    exec(sql) {
      this.calls.push(sql.trim());
      if (sql.trim() === 'COMMIT') throw new Error('disk full');
    },
  };
  assert.throws(() => withTransaction(db, () => 'ok'), /disk full/);
  assert.deepEqual(db.calls, ['BEGIN', 'COMMIT', 'ROLLBACK']);
});

test('server schema declares the hot-path composite indexes', () => {
  const source = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
  for (const index of [
    'idx_posts_author_status',
    'idx_comments_post_status',
    'idx_post_tags_tag',
    'idx_logs_created_at',
  ]) {
    assert.ok(source.includes(index), `missing index ${index}`);
  }
});

test('batch operations run inside a transaction', () => {
  const content = readFileSync(join(__dirname, '..', 'routes', 'admin', 'content.js'), 'utf8');
  const comments = readFileSync(join(__dirname, '..', 'routes', 'admin', 'comments.js'), 'utf8');
  assert.ok(content.includes('withTransaction'), 'posts batch should use withTransaction');
  assert.ok(comments.includes('withTransaction'), 'comments batch-status should use withTransaction');
});
