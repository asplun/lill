import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function writeTheme(themesDir, id, migrationSource) {
  const dir = join(themesDir, id);
  await mkdir(join(dir, 'backend'), { recursive: true });
  await writeFile(join(dir, 'theme.json'), JSON.stringify({
    id,
    name: id,
    version: '1.0.0',
    settings: [],
  }));
  await writeFile(join(dir, 'backend', 'index.js'), migrationSource);
}

async function installAndLogin(api) {
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Migration Test',
    site_url: 'http://localhost',
    admin_username: 'migration-admin',
    admin_password: 'test-password-123',
    admin_email: 'migration@example.test',
  }});
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const login = await api.request('POST', '/api/v1/auth/login', { body: {
    username: 'migration-admin',
    password: 'test-password-123',
  }});
  assert.equal(login.status, 200, JSON.stringify(login.payload));
  return login.payload.data;
}

function activeTheme(dbPath) {
  const db = new DatabaseSync(dbPath);
  const active = db.prepare('SELECT theme_id FROM themes WHERE active = 1').get()?.theme_id;
  db.close();
  return active;
}

function hasTable(dbPath, name) {
  const db = new DatabaseSync(dbPath);
  const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  db.close();
  return !!found;
}

test('activating a theme runs its idempotent migration before returning success', async t => {
  const api = await startApiServer({
    prepareThemes: themesDir => writeTheme(themesDir, 'migration-fixture', `
      export function migrate(context) {
        context.db.exec('CREATE TABLE IF NOT EXISTS migration_fixture_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
        context.db.prepare('INSERT OR IGNORE INTO migration_fixture_state (id, value) VALUES (?, ?)').run('ready', context.themeId);
      }
    `),
  });
  t.after(api.stop);
  const session = await installAndLogin(api);
  const headers = { authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken };

  const first = await api.request('POST', '/api/v1/admin/themes/migration-fixture/activate', { headers, body: {} });
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  const second = await api.request('POST', '/api/v1/admin/themes/migration-fixture/activate', { headers, body: {} });
  assert.equal(second.status, 200, JSON.stringify(second.payload));

  assert.equal(activeTheme(api.dbPath), 'migration-fixture');
  assert.equal(hasTable(api.dbPath, 'migration_fixture_state'), true);
  const db = new DatabaseSync(api.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_fixture_state').get().count, 1);
  assert.equal(db.prepare('SELECT value FROM migration_fixture_state WHERE id = ?').get('ready').value, 'migration-fixture');
  db.close();
});

test('a failed theme migration leaves the previous theme active', async t => {
  const api = await startApiServer({
    prepareThemes: async themesDir => {
      await writeTheme(themesDir, 'broken-fixture', `
        export function migrate(context) {
          context.db.exec('CREATE TABLE IF NOT EXISTS broken_fixture_state (id TEXT PRIMARY KEY)');
          throw new Error('fixture migration failed');
        }
      `);
    },
  });
  t.after(api.stop);
  const session = await installAndLogin(api);
  const headers = { authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken };

  const response = await api.request('POST', '/api/v1/admin/themes/broken-fixture/activate', { headers, body: {} });
  assert.equal(response.status, 500, JSON.stringify(response.payload));
  assert.match(response.payload.message, /主题迁移失败/);
  assert.equal(activeTheme(api.dbPath), 'default');
  assert.equal(hasTable(api.dbPath, 'broken_fixture_state'), false);
});
