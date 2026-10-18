import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createSettings } from '../lib/settings.js';

test('theme manifest updates invalidate provider defaults without a restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lill-settings-cache-'));
  const themeDir = join(root, 'fixture');
  await mkdir(themeDir, { recursive: true });
  const manifest = join(themeDir, 'theme.json');
  await writeFile(manifest, JSON.stringify({ id: 'fixture', name: 'Fixture', settings: [
    { key: 'greeting', type: 'text', default: 'first' },
  ] }));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE themes (id TEXT PRIMARY KEY, theme_id TEXT, name TEXT, version TEXT, active INTEGER, config TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE options (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO themes (id, theme_id, name, version, active, config) VALUES ('1', 'fixture', 'Fixture', '1.0.0', 1, '{}');`);
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const settings = createSettings(db, { themesDir: root });
  assert.equal(settings.opt('greeting'), 'first');
  await writeFile(manifest, JSON.stringify({ id: 'fixture', name: 'Fixture', settings: [
    { key: 'greeting', type: 'text', default: 'second' },
  ] }));
  await utimes(manifest, new Date('2031-01-01T00:00:00Z'), new Date('2031-01-01T00:00:00Z'));
  settings.invalidate();
  assert.equal(settings.opt('greeting'), 'second');
});
