import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROJECT_ROOT = join(BACKEND_ROOT, '..');

function walk(relative) {
  const dir = join(BACKEND_ROOT, relative);
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [join(BACKEND_ROOT, path)] : [];
  });
}

const productionFiles = [
  join(BACKEND_ROOT, 'server.js'),
  ...walk('routes'),
  ...walk('lib'),
  join(PROJECT_ROOT, 'frontend/themes/default/theme.json'),
  join(PROJECT_ROOT, 'deploy.sh'),
  join(PROJECT_ROOT, 'deploy/nginx.conf.example'),
];

function productionSource(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '');
}

// Task 1 locks the new generic runtime boundary. The legacy public bootstrap and
// providers are Task 2/3 migration targets and are intentionally not judged here.
const runtimeBoundaryFiles = [
  join(BACKEND_ROOT, 'server.js'),
  join(BACKEND_ROOT, 'lib/theme-runtime.js'),
  join(BACKEND_ROOT, 'lib/theme-ext.js'),
  join(BACKEND_ROOT, 'routes/admin/themes.js'),
];


test('core production boundary recursively excludes concrete theme and private API coupling', () => {
  const forbidden = [
    ...readdirSync(join(PROJECT_ROOT, 'frontend/themes'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'default')
      .map(entry => new RegExp(`\\b${entry.name}\\b`, 'i')),
    /\b(?:metingCookieNetease|metingCookieTencent|smtpPass|qiniuSecretKey|upyunTokenSecret)\b/,
    /\b(?:music_playlists|theme_private_|theme_[a-z0-9]+_private)\b/i,
  ];
  for (const file of runtimeBoundaryFiles) {
    const source = productionSource(file);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file} contains ${pattern}`);
  }
});

test('boundary scanner includes nested production modules but excludes test fixtures', () => {
  assert.ok(productionFiles.some(file => file.endsWith('/routes/admin/themes.js')));
  assert.equal(productionFiles.some(file => file.includes('/test/')), false);
});
