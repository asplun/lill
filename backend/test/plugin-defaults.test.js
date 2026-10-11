import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pluginRuntime from '../lib/plugin-ext.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS_DIR = join(ROOT, 'backend', 'plugins');

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE plugins (
      id TEXT PRIMARY KEY,
      dir TEXT UNIQUE NOT NULL,
      name TEXT,
      version TEXT,
      description TEXT,
      active INTEGER DEFAULT 0
    )
  `);
  return db;
}

test('registers the built-in hello-world plugin as active on first startup', () => {
  const db = createDb();

  assert.equal(typeof pluginRuntime.ensureBuiltinPlugin, 'function');
  const created = pluginRuntime.ensureBuiltinPlugin(db, PLUGINS_DIR, 'hello-world');

  assert.equal(created, true);
  assert.deepEqual({ ...db.prepare('SELECT dir, name, version, active FROM plugins WHERE dir = ?').get('hello-world') }, {
    dir: 'hello-world',
    name: 'Hello World 公告栏',
    version: '1.1.0',
    active: 1
  });
});

test('does not override an administrator-disabled built-in plugin', () => {
  const db = createDb();
  db.prepare('INSERT INTO plugins (id, dir, name, version, description, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run('existing', 'hello-world', '旧名称', '0.0.1', '旧描述', 0);

  const created = pluginRuntime.ensureBuiltinPlugin(db, PLUGINS_DIR, 'hello-world');

  assert.equal(created, false);
  assert.equal(db.prepare('SELECT active FROM plugins WHERE dir = ?').get('hello-world').active, 0);
});
