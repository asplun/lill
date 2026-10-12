import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROJECT_ROOT = join(BACKEND_ROOT, '..');
const files = [
  join(BACKEND_ROOT, 'server.js'),
  ...walk('routes'),
  ...walk('lib'),
  join(PROJECT_ROOT, 'frontend/themes/default/theme.json'),
  join(PROJECT_ROOT, 'deploy.sh'),
  join(PROJECT_ROOT, 'deploy/nginx.conf.example'),
];

function walk(relative) {
  const dir = join(BACKEND_ROOT, relative);
  return readdirSync(dir).filter(name => statSync(join(dir, name)).isFile())
    .map(name => join(dir, name));
}

test('core production boundary does not mention fixture theme names or private theme APIs', () => {
  const forbidden = [/fixture-a/i, /fixture-b/i, /themePrivateApi/i];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file} contains ${pattern}`);
  }
});
