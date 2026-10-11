import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const source = readFileSync(join(ROOT, 'backend', 'routes', 'install.js'), 'utf8');

test('installation response includes the CSRF token needed by the first admin session', () => {
  assert.match(source, /generateCSRFToken/);
  assert.match(source, /csrfToken:\s*generateCSRFToken\(\)/);
});
