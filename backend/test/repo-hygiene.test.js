import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(backendDir, '..');

test('root data directory is git-ignored', () => {
  const ignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
  assert.ok(/^\/data\/$/m.test(ignore), '.gitignore should ignore the repo-root /data/ directory');
});

test('PM2 config ships without a hardcoded JWT secret', () => {
  const config = readFileSync(join(backendDir, 'ecosystem.config.cjs'), 'utf8');
  const active = config
    .split('\n')
    .filter(line => !line.trim().startsWith('//'));
  assert.ok(!active.some(line => /JWT_SECRET/.test(line)), 'JWT_SECRET must stay commented out in the shipped config');
});

test('duplicate database and PM2 definitions are removed', () => {
  assert.ok(!existsSync(join(backendDir, 'db.js')), 'db.js duplicated the schema owned by server.js');
  assert.ok(!existsSync(join(backendDir, 'ecosystem.config.js')), 'ecosystem.config.js duplicated ecosystem.config.cjs');
});
