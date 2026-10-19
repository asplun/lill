import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startApiServer } from './helpers/api-server.js';

const password = 'content-test-password-123';
let api, db, admin, sequence = 0;
const headers = session => ({ authorization: `Bearer ${session.token}`, 'x-csrf-token': session.csrfToken });
async function prepareEditorThemes(themesDir) {
  const themes = [
    {
      id: 'editor-fixture',
      editorFields: [
        { key: 'subtitle', label: '副标题', type: 'text', for: 'post', default: '默认副标题' },
        { key: 'layout', label: '版式', type: 'select', for: 'post', options: [{ value: 'wide', label: '宽屏' }, { value: 'normal', label: '常规' }] },
        { key: 'show_index', label: '加入目录', type: 'checkbox', for: 'post', default: true },
        { key: 'hero_title', label: '页面标题', type: 'text', for: 'page' },
      ],
    },
    {
      id: 'editor-other',
      editorFields: [{ key: 'other_caption', label: '另一主题字段', type: 'text', for: 'both' }],
    },
  ];
  for (const theme of themes) {
    const dir = join(themesDir, theme.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'theme.json'), JSON.stringify({ ...theme, name: theme.id }));
  }
}
const write = (method, path, body, session = admin) => api.request(method, path, { headers: headers(session), body });
const create = body => write('POST', '/api/v1/admin/posts', {
  title: `Content integrity ${++sequence}`, content: 'Original **body**', ...body,
});
const update = (id, body, session = admin) => write('PUT', `/api/v1/admin/posts/${id}`, body, session);
const data = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.payload));
  return response.payload.data;
};
const snapshot = () => Object.fromEntries(['posts', 'post_versions', 'tags', 'post_tags'].map(table => [
  table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
]));
async function makeTag(name, slug) {
  return data(await write('POST', '/api/v1/admin/tags', { name, slug }), 201);
}
async function account(role) {
  const username = `${role}-${++sequence}`;
  data(await write('POST', '/api/v1/admin/users', { username, password, role, email: `${username}@example.test` }), 201);
  return data(await api.request('POST', '/api/v1/auth/login', { body: { username, password } }));
}

before(async () => {
  api = await startApiServer({ prepareThemes: prepareEditorThemes });
  data(await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Content integrity', site_url: 'http://localhost',
    admin_username: 'admin', admin_password: password, admin_email: 'admin@example.test',
  } }));
  admin = data(await api.request('POST', '/api/v1/auth/login', { body: { username: 'admin', password } }));
  data(await write('POST', '/api/v1/admin/themes/editor-fixture/activate', {}));
  db = new DatabaseSync(api.dbPath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
});
after(async () => {
  db?.close();
  await api?.stop();
});

test('article, page and recent lists return the real type for editor round trips', async () => {
  const post = data(await create({ type: 'post' }), 201);
  const page = data(await create({ type: 'page' }), 201);
  for (const [path, item, type] of [
    ['/api/v1/admin/posts', post, 'post'],
    ['/api/v1/admin/pages', page, 'page'],
    ['/api/v1/admin/posts/recent', post, 'post'],
  ]) {
    const result = data(await api.request('GET', path, { headers: headers(admin) }));
    const listed = (result.items || result).find(row => row.id === item.id);
    assert.equal(listed?.type, type, path);
    assert.equal(data(await update(item.id, { title: `${item.title} edited`, type: listed.type })).type, type);
  }
});

test('editor field schema is authenticated, validates its query, and filters fields by content type', async () => {
  const unauthenticated = await api.request('GET', '/api/v1/admin/editor-fields?type=post');
  assert.equal(unauthenticated.status, 401);
  for (const type of ['post', 'page']) {
    const result = data(await api.request('GET', `/api/v1/admin/editor-fields?type=${type}`, { headers: headers(admin) }));
    assert.equal(result.themeId, 'editor-fixture');
    assert.ok(result.fields.every(field => field.for === type || field.for === 'both'));
    assert.deepEqual(result.fields.map(field => field.key), type === 'post'
      ? ['subtitle', 'layout', 'show_index']
      : ['hero_title']);
  }
  for (const role of ['editor', 'author', 'contributor']) {
    const session = await account(role);
    assert.equal((await api.request('GET', '/api/v1/admin/editor-fields?type=post', { headers: headers(session) })).status, 200, role);
  }
  for (const type of ['', 'comment', 'POST']) {
    const response = await api.request('GET', `/api/v1/admin/editor-fields?type=${encodeURIComponent(type)}`, { headers: headers(admin) });
    assert.equal(response.status, 400, JSON.stringify(response.payload));
  }
});

test('theme fields persist in their namespace and detail reads retain the generic fields contract', async () => {
  const post = data(await create({
    fields: { legacyField: 'preserve me' },
    themeFields: { subtitle: '文章副标题', layout: 'wide', show_index: false },
  }), 201);
  const stored = JSON.parse(db.prepare('SELECT fields FROM posts WHERE id = ?').get(post.id).fields);
  assert.deepEqual(stored, {
    legacyField: 'preserve me',
    _lillThemeFields: {
      'editor-fixture': { subtitle: '文章副标题', layout: 'wide', show_index: false },
    },
  });
  const detail = data(await api.request('GET', `/api/v1/admin/posts/${post.id}`, { headers: headers(admin) }));
  assert.deepEqual(detail.themeFields, { subtitle: '文章副标题', layout: 'wide', show_index: false });
  assert.equal(typeof detail.fields, 'string');
  assert.deepEqual(JSON.parse(detail.fields), stored);

  const page = data(await create({ type: 'page', themeFields: { hero_title: '关于我们' } }), 201);
  assert.deepEqual(data(await api.request('GET', `/api/v1/admin/posts/${page.id}`, { headers: headers(admin) })).themeFields, {
    hero_title: '关于我们',
  });
});

test('invalid theme field writes return 400 before changing posts or creating versions', async () => {
  const post = data(await create({ themeFields: { subtitle: 'original' } }), 201);
  const invalidValues = [
    { unknown: 'field' },
    { subtitle: 42 },
    { layout: 'compact' },
    { show_index: 'true' },
    null,
    [],
    'not an object',
  ];
  for (const themeFields of invalidValues) {
    const beforeWrite = snapshot();
    const response = await update(post.id, { title: 'Must not persist', themeFields });
    assert.equal(response.status, 400, JSON.stringify(response.payload));
    assert.deepEqual(snapshot(), beforeWrite);
  }
  const beforeCreate = snapshot();
  const rejectedCreate = await create({ themeFields: { layout: 'compact' } });
  assert.equal(rejectedCreate.status, 400, JSON.stringify(rejectedCreate.payload));
  assert.deepEqual(snapshot(), beforeCreate);
});

test('partial and legacy updates preserve generic fields and every theme namespace', async () => {
  const post = data(await create({ themeFields: { subtitle: 'original' } }), 201);
  db.prepare('UPDATE posts SET fields = ? WHERE id = ?').run(JSON.stringify({
    legacy: { kept: true },
    _lillThemeFields: {
      'editor-fixture': { subtitle: 'original', retired: 'keep for later' },
      'editor-other': { other_caption: 'other theme value' },
    },
  }), post.id);

  data(await update(post.id, { themeFields: { subtitle: 'updated' } }));
  let stored = JSON.parse(db.prepare('SELECT fields FROM posts WHERE id = ?').get(post.id).fields);
  assert.deepEqual(stored, {
    legacy: { kept: true },
    _lillThemeFields: {
      'editor-fixture': { subtitle: 'updated', retired: 'keep for later' },
      'editor-other': { other_caption: 'other theme value' },
    },
  });

  data(await update(post.id, { title: 'Updated by an older client' }));
  stored = JSON.parse(db.prepare('SELECT fields FROM posts WHERE id = ?').get(post.id).fields);
  assert.deepEqual(stored, {
    legacy: { kept: true },
    _lillThemeFields: {
      'editor-fixture': { subtitle: 'updated', retired: 'keep for later' },
      'editor-other': { other_caption: 'other theme value' },
    },
  });

  data(await update(post.id, { fields: { replacement: 'generic update' } }));
  stored = JSON.parse(db.prepare('SELECT fields FROM posts WHERE id = ?').get(post.id).fields);
  assert.deepEqual(stored, {
    replacement: 'generic update',
    _lillThemeFields: {
      'editor-fixture': { subtitle: 'updated', retired: 'keep for later' },
      'editor-other': { other_caption: 'other theme value' },
    },
  });
});

test('switching active themes edits only that theme namespace and preserves values when switching back', async () => {
  const post = data(await create({ themeFields: { subtitle: 'fixture value' } }), 201);
  data(await write('POST', '/api/v1/admin/themes/editor-other/activate', {}));
  data(await update(post.id, { themeFields: { other_caption: 'other value' } }));
  let stored = JSON.parse(db.prepare('SELECT fields FROM posts WHERE id = ?').get(post.id).fields);
  assert.deepEqual(stored._lillThemeFields, {
    'editor-fixture': { subtitle: 'fixture value' },
    'editor-other': { other_caption: 'other value' },
  });

  data(await write('POST', '/api/v1/admin/themes/editor-fixture/activate', {}));
  const detail = data(await api.request('GET', `/api/v1/admin/posts/${post.id}`, { headers: headers(admin) }));
  assert.deepEqual(detail.themeFields, { subtitle: 'fixture value', layout: 'wide', show_index: true });
});

const invalidEnums = [
  ['type', 'undefined'], ['type', 'attachment'], ['type', ''], ['type', null], ['type', 1],
  ['status', 'undefined'], ['status', 'trash'], ['status', ''], ['status', null], ['status', {}],
];
for (const method of ['POST', 'PUT']) {
  for (const [field, value] of invalidEnums) {
    test(`${method} rejects invalid ${field} ${JSON.stringify(value)} without saving or creating a version`, async () => {
      const existing = method === 'PUT' ? data(await create({}), 201) : null;
      const beforeWrite = snapshot();
      const body = { title: `Rejected ${++sequence}`, content: 'Must not persist', [field]: value };
      const response = existing ? await update(existing.id, body) : await create(body);
      assert.equal(response.status, 400, JSON.stringify(response.payload));
      assert.match(response.payload.message, field === 'type' ? /类型|type/ : /状态|status/);
      assert.deepEqual(snapshot(), beforeWrite);
    });
  }
}

test('supported types and statuses save; omitted fields preserve existing values', async () => {
  for (const type of ['post', 'page']) {
    for (const status of ['draft', 'pending', 'published']) {
      const post = data(await create({ type, status }), 201);
      const saved = data(await update(post.id, { title: `${post.title} edited` }));
      assert.equal(saved.type, type);
      assert.equal(saved.status, status);
      assert.equal(saved.published_at, post.published_at);
    }
  }
  const defaults = data(await create({}), 201);
  assert.equal(defaults.type, 'post');
  assert.equal(defaults.status, 'draft');
});

test('clearing content clears rendered HTML and automatic excerpt while keeping the previous version', async () => {
  const post = data(await create({ status: 'published' }), 201);
  const saved = data(await update(post.id, { content: '' }));
  assert.equal(saved.content, '');
  assert.equal(saved.html_content, '');
  assert.equal(saved.excerpt, '');
  const version = db.prepare('SELECT * FROM post_versions WHERE post_id = ?').get(post.id);
  assert.equal(version.content, 'Original **body**');
  assert.equal(version.html_content, '<p>Original <strong>body</strong></p>');
  assert.equal(version.excerpt, 'Original body');
  const publicPost = data(await api.request('GET', `/api/v1/posts/${post.slug}`));
  assert.equal(publicPost.content, '');
  assert.equal(publicPost.html_content, '');
});

test('omitting content preserves rendering and explicit excerpts remain under caller control', async () => {
  const post = data(await create({ excerpt: 'Custom summary' }), 201);
  const saved = data(await update(post.id, { title: `${post.title} edited` }));
  assert.equal(saved.content, post.content);
  assert.equal(saved.html_content, post.html_content);
  assert.equal(saved.excerpt, 'Custom summary');
  assert.equal(data(await update(post.id, { content: '', excerpt: 'Keep this summary' })).excerpt, 'Keep this summary');
});

test('Chinese and custom-slug tags reuse the same names and IDs on create and repeated saves', async () => {
  const chinese = await makeTag('中文稳定标签', 'custom-chinese-tag');
  const english = await makeTag('Custom Name', 'unrelated-custom-slug');
  const tagNames = [chinese.name, english.name];
  const post = data(await create({ tagNames }), 201);
  for (let round = 0; round < 2; round++) {
    data(await update(post.id, { content: `Round ${round}`, tagNames }));
    const detail = data(await api.request('GET', `/api/v1/admin/posts/${post.id}`, { headers: headers(admin) }));
    assert.deepEqual(detail.tags.map(tag => tag.id).sort(), [chinese.id, english.id].sort());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE name IN (?, ?)').get(...tagNames).n, 2);
  }
});

test('new Chinese tags are reusable and different names with colliding slugs stay distinct', async () => {
  const post = data(await create({ tagNames: ['首次中文标签', 'C++', 'C#'] }), 201);
  const initial = db.prepare('SELECT t.* FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ? ORDER BY t.name').all(post.id);
  assert.deepEqual(initial.map(tag => tag.name), ['C#', 'C++', '首次中文标签']);
  assert.equal(new Set(initial.map(tag => tag.slug)).size, 3);
  data(await update(post.id, { tagNames: ['首次中文标签', 'C++', 'C#', 'C++'] }));
  assert.deepEqual(db.prepare('SELECT t.* FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ? ORDER BY t.name').all(post.id), initial);
});

for (const role of ['author', 'contributor']) {
  test(`${role} may reuse existing custom-slug tags by name but cannot create a different name with a matching slug`, async () => {
    const tag = await makeTag(`${role} 中文标签`, `${role}-custom-slug`);
    await makeTag(`${role}++`, role);
    const user = await account(role);
    const post = data(await write('POST', '/api/v1/admin/posts', {
      title: `${role} content`, status: 'draft', tagNames: [tag.name],
    }, user), 201);
    data(await update(post.id, { content: 'Edited by owner', tagNames: [tag.name] }, user));
    const beforeWrite = snapshot();
    const denied = await update(post.id, { content: 'Must not save', tagNames: [`${role}#`] }, user);
    assert.equal(denied.status, 403, JSON.stringify(denied.payload));
    assert.deepEqual(snapshot(), beforeWrite);
  });
}

for (const tagNames of ['not-an-array', null, [null], [{}], [1], [''], ['   ']]) {
  test(`invalid tagNames ${JSON.stringify(tagNames)} returns a client error before any write`, async () => {
    const post = data(await create({}), 201);
    for (const method of ['POST', 'PUT']) {
      const beforeWrite = snapshot();
      const response = method === 'POST'
        ? await create({ tagNames })
        : await update(post.id, { content: 'Must not save', tagNames });
      assert.equal(response.status, 400, JSON.stringify(response.payload));
      assert.deepEqual(snapshot(), beforeWrite);
    }
  });
}

test('a failed tag-link insert rolls back a newly created post and newly created tag', async () => {
  const beforeWrite = snapshot();
  db.exec("CREATE TRIGGER fail_create_link BEFORE INSERT ON post_tags BEGIN SELECT RAISE(ABORT, 'forced link failure'); END;");
  try {
    assert.equal((await create({ tagNames: ['Rollback newly created tag'] })).status, 500);
    assert.deepEqual(snapshot(), beforeWrite);
  } finally {
    db.exec('DROP TRIGGER fail_create_link');
  }
  data(await create({ tagNames: ['Rollback newly created tag'] }), 201);
});

test('a failed tag replacement rolls back content, version, new tags and old associations together', async () => {
  const tag = await makeTag('Original rollback tag', 'original-rollback-tag');
  const post = data(await create({ tagNames: [tag.name] }), 201);
  const beforeWrite = snapshot();
  db.exec(`CREATE TRIGGER fail_update_link BEFORE INSERT ON post_tags WHEN NEW.post_id = '${post.id}' BEGIN SELECT RAISE(ABORT, 'forced update link failure'); END;`);
  try {
    assert.equal((await update(post.id, {
      title: 'Must roll back', content: 'Must roll back', tagNames: ['Rollback replacement tag'],
    })).status, 500);
    assert.deepEqual(snapshot(), beforeWrite);
  } finally {
    db.exec('DROP TRIGGER fail_update_link');
  }
  data(await update(post.id, { content: 'Retry succeeds', tagNames: ['Rollback replacement tag'] }));
});

test('a failed post update does not leave a phantom version', async () => {
  const post = data(await create({}), 201);
  const beforeWrite = snapshot();
  db.exec(`CREATE TRIGGER fail_post_write BEFORE UPDATE ON posts WHEN OLD.id = '${post.id}' BEGIN SELECT RAISE(ABORT, 'forced post failure'); END;`);
  try {
    assert.equal((await update(post.id, { content: 'Must roll back' })).status, 500);
    assert.deepEqual(snapshot(), beforeWrite);
  } finally {
    db.exec('DROP TRIGGER fail_post_write');
  }
});

test('a duplicate post slug returns 409 without adding a version or changing tags', async () => {
  const first = data(await create({}), 201);
  const second = data(await create({}), 201);
  const beforeWrite = snapshot();
  assert.equal((await update(second.id, { slug: first.slug, tagNames: ['Must not create'] })).status, 409);
  assert.deepEqual(snapshot(), beforeWrite);
});

for (const body of [
  { visibility: 'private' }, { visibility: 'password' }, { visibility: 'hidden' },
  { visibility: '' }, { visibility: null }, { password: 'secret' },
  { password: ' ' }, { password: 123 }, { password: {} },
]) {
  test(`unsupported access settings ${JSON.stringify(body)} are explicitly rejected on create and update`, async () => {
    const post = data(await create({}), 201);
    for (const method of ['POST', 'PUT']) {
      const beforeWrite = snapshot();
      const response = method === 'POST'
        ? await create({ status: 'published', ...body })
        : await update(post.id, { status: 'published', content: 'Must not become public', ...body });
      assert.equal(response.status, 400, JSON.stringify(response.payload));
      assert.match(response.payload.message, /不支持|尚未支持/);
      assert.deepEqual(snapshot(), beforeWrite);
    }
  });
}

test('explicit public visibility and empty passwords are compatible with ordinary writes', async () => {
  for (const password of ['', null]) {
    const post = data(await create({ visibility: 'public', password }), 201);
    const saved = data(await update(post.id, { visibility: 'public', password, content: 'Public body' }));
    assert.equal(saved.visibility, 'public');
    assert.ok(saved.password === null || saved.password === '');
  }
});

const invalidDates = [
  'not-a-date', '2026-02-29 10:00:00', '2024-02-30T10:00:00Z',
  '2026-13-01 10:00:00', '2026-10-18T24:00:00Z', '2026-10-18T10:60:00Z',
  '2026-10-18T10:00:60Z', '2026-10-18T10:00:00+25:00', '2026-10-18',
  1234567890, {},
];
for (const publishedAt of invalidDates) {
  test(`invalid publication date ${JSON.stringify(publishedAt)} is rejected without partial saves`, async () => {
    const post = data(await create({}), 201);
    for (const method of ['POST', 'PUT']) {
      const beforeWrite = snapshot();
      const response = method === 'POST'
        ? await create({ status: 'published', publishedAt })
        : await update(post.id, { status: 'published', content: 'Must not save', publishedAt });
      assert.equal(response.status, 400, JSON.stringify(response.payload));
      assert.match(response.payload.message, /发布时间|日期/);
      assert.deepEqual(snapshot(), beforeWrite);
    }
  });
}

test('valid SQL and ISO dates are normalized to comparable UTC timestamps on create and update', async () => {
  for (const [publishedAt, expected] of [
    ['2031-06-01 02:03:04', '2031-06-01 02:03:04'],
    ['2031-06-01T02:03', '2031-06-01 02:03:00'],
    ['2024-02-29T10:00:00Z', '2024-02-29 10:00:00'],
    ['2031-06-01T08:30:45.123+08:00', '2031-06-01 00:30:45'],
  ]) {
    const post = data(await create({ status: 'published', publishedAt }), 201);
    assert.equal(post.published_at, expected);
    assert.equal(data(await update(post.id, { publishedAt })).published_at, expected);
  }
});

test('single publish sets the first timestamp and does not erase or reset an existing publication date', async () => {
  const draft = data(await create({}), 201);
  assert.equal(draft.published_at, null);
  const published = data(await update(draft.id, { status: 'published' }));
  assert.match(published.published_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  const historical = data(await create({ status: 'published', publishedAt: '2001-02-03 04:05:06' }), 201);
  assert.equal(data(await update(historical.id, { status: 'published' })).published_at, '2001-02-03 04:05:06');
  assert.equal(data(await update(historical.id, { publishedAt: null })).published_at, '2001-02-03 04:05:06');
});

test('batch publish fills missing dates once and preserves existing dates through draft and republish', async () => {
  const missing = data(await create({}), 201);
  const empty = data(await create({}), 201);
  db.prepare("UPDATE posts SET published_at = '' WHERE id = ?").run(empty.id);
  const existing = data(await create({ publishedAt: '2001-02-03 04:05:06' }), 201);
  const ids = [missing.id, empty.id, existing.id];
  const beforePublish = Date.now() - 1000;
  data(await write('POST', '/api/v1/admin/posts/batch', { ids, action: 'publish' }));
  const saved = ids.map(id => db.prepare('SELECT status, published_at FROM posts WHERE id = ?').get(id));
  for (const row of saved) assert.equal(row.status, 'published');
  for (const row of saved.slice(0, 2)) {
    assert.match(row.published_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.ok(Date.parse(row.published_at.replace(' ', 'T') + 'Z') >= beforePublish);
    assert.ok(Date.parse(row.published_at.replace(' ', 'T') + 'Z') <= Date.now());
  }
  assert.equal(saved[2].published_at, '2001-02-03 04:05:06');
  data(await write('POST', '/api/v1/admin/posts/batch', { ids, action: 'draft' }));
  data(await write('POST', '/api/v1/admin/posts/batch', { ids, action: 'publish' }));
  assert.deepEqual(ids.map(id => db.prepare('SELECT status, published_at FROM posts WHERE id = ?').get(id)), saved);
});
