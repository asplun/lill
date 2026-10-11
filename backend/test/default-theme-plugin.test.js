import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const themeDir = join(ROOT, 'frontend', 'themes', 'default');

test('default theme exposes render targets for the Hello World announcement', () => {
  const header = readFileSync(join(themeDir, 'header.html'), 'utf8');
  const sidebar = readFileSync(join(themeDir, 'sidebar.html'), 'utf8');
  const footer = readFileSync(join(themeDir, 'footer.html'), 'utf8');
  const script = readFileSync(join(themeDir, 'theme.js'), 'utf8');

  assert.match(header, /data-lill-hello="top"/);
  assert.match(sidebar, /data-lill-hello="sidebar"/);
  assert.match(footer, /data-lill-hello="footer"/);
  assert.match(script, /\/api\/v1\/hello/);
});
