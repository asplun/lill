import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createRouter } from '../lib/router.js';

test('plugin status/admin routes require explicit auth policy', () => {
  const router = createRouter();
  const handler = () => {};
  router.route('GET', '/api/v1/foo/status', handler);
  router.route('GET', '/api/v1/foo/admin', handler);
  router.route('GET', '/api/v1/foo/status-secure', handler, true);
  router.route('GET', '/api/v1/foo/admin-secure', handler, true);
  assert.equal(router.matchRoute('GET', '/api/v1/foo/status').auth, false);
  assert.equal(router.matchRoute('GET', '/api/v1/foo/admin').auth, false);
  assert.equal(router.matchRoute('GET', '/api/v1/foo/status-secure').auth, true);
  assert.equal(router.matchRoute('GET', '/api/v1/foo/admin-secure').auth, true);
});

test('plugin admin routes explicitly enable authentication', async t => {
  const pluginsDir = new URL('../plugins/', import.meta.url);
  let plugins;
  try { plugins = await readdir(pluginsDir, { withFileTypes: true }); }
  catch { t.skip('plugin directory is unavailable'); return; }
  const offenders = [];
  for (const plugin of plugins.filter(entry => entry.isDirectory())) {
    let source;
    try { source = await readFile(new URL(`../plugins/${plugin.name}/index.js`, import.meta.url), 'utf8'); }
    catch { continue; }
    const routePattern = /ctx\.route\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]*\/admin['"][\s\S]*?\n\s*\}\s*(,\s*true)?\);/g;
    for (const match of source.matchAll(routePattern)) {
      if (!match[1]) offenders.push(`${plugin.name}/index.js: ${match[0].replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
