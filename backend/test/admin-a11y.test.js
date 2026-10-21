import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(root, '../../frontend/public/admin/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, '../../frontend/public/admin/admin.css'), 'utf8');

test('admin table headers declare column scope', () => {
  for (const match of app.matchAll(/<th(?=\s|>)/g)) {
    assert.match(app.slice(match.index, match.index + 40), /^<th scope="col"/);
  }
});

test('toast announces status and errors to assistive technology', () => {
  const toastBody = app.match(/function toast\(msg, type = 'success'\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(toastBody, /role/);
  assert.match(toastBody, /aria-live/);
});

test('renderMedia lazily loads attachment images', () => {
  const mediaBody = app.match(/async function renderMedia\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const imageTag = mediaBody.match(/<img[^>]*>/)?.[0] || '';
  assert.match(imageTag, /loading="lazy"/);
});

test('attachment image styles reserve their aspect ratio', () => {
  assert.match(css, /aspect-ratio/);
});
