import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startApiServer } from './helpers/api-server.js';

const adminPassword = 'post-visibility-admin-123';
let api, admin, author, publicPost, privatePost, passwordPost, otherPasswordPost;

const auth = session => ({ authorization: `Bearer ${session.token}` });
const write = (session, method, path, body) => api.request(method, path, {
  headers: { ...auth(session), 'x-csrf-token': session.csrfToken },
  body,
});
const data = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.payload));
  return response.payload.data;
};

before(async () => {
  api = await startApiServer();
  data(await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Post visibility', site_url: 'http://localhost',
    admin_username: 'admin', admin_password: adminPassword, admin_email: 'admin@example.test',
  } }));
  admin = data(await api.request('POST', '/api/v1/auth/login', { body: { username: 'admin', password: adminPassword } }));
  data(await write(admin, 'POST', '/api/v1/admin/users', {
    username: 'visibility-author', password: 'author-pass-123', role: 'author', email: 'visibility-author@example.test',
  }), 201);
  author = data(await api.request('POST', '/api/v1/auth/login', { body: {
    username: 'visibility-author', password: 'author-pass-123',
  } }));
  publicPost = data(await write(author, 'POST', '/api/v1/admin/posts', {
    title: 'Public visibility fixture', slug: 'visibility-public', content: 'PUBLIC-BODY',
    status: 'published', visibility: 'public',
  }), 201);
  privatePost = data(await write(author, 'POST', '/api/v1/admin/posts', {
    title: 'Private visibility fixture', slug: 'visibility-private', content: 'PRIVATE-BODY-MARKER',
    status: 'published', visibility: 'private',
  }), 201);
  passwordPost = data(await write(author, 'POST', '/api/v1/admin/posts', {
    title: 'Password visibility fixture', slug: 'visibility-password', content: 'PASSWORD-BODY-MARKER',
    status: 'published', visibility: 'password', password: 'open-sesame-123',
  }), 201);
  otherPasswordPost = data(await write(author, 'POST', '/api/v1/admin/posts', {
    title: 'Other password fixture', slug: 'visibility-password-other', content: 'OTHER-PASSWORD-BODY',
    status: 'published', visibility: 'password', password: 'other-pass-456',
  }), 201);
});

after(async () => { if (api) await api.stop(); });

test('admin writes private and password posts without returning plaintext passwords', () => {
  assert.equal(privatePost.visibility, 'private');
  assert.ok(privatePost.password === null || privatePost.password === '');
  assert.equal(passwordPost.visibility, 'password');
  assert.match(passwordPost.password, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.notEqual(passwordPost.password, 'open-sesame-123');
  assert.notEqual(otherPasswordPost.password, 'other-pass-456');
});

test('private posts are readable by the author and admin, but 404 for anonymous visitors', async () => {
  const owner = await api.request('GET', '/api/v1/posts/' + privatePost.slug, { headers: auth(author) });
  data(owner);
  assert.equal(owner.payload.data.id, privatePost.id);
  assert.equal('password' in owner.payload.data, false);

  const administrator = await api.request('GET', '/api/v1/posts/' + privatePost.slug, { headers: auth(admin) });
  data(administrator);
  assert.equal(administrator.payload.data.id, privatePost.id);

  const anonymous = await api.request('GET', '/api/v1/posts/' + privatePost.slug);
  assert.equal(anonymous.status, 404);
  assert.equal(anonymous.payload.message, '文章不存在');
  assert.equal(JSON.stringify(anonymous.payload).includes('PRIVATE-BODY-MARKER'), false);
});

test('password posts return post_password_required until the visitor unlocks them', async () => {
  const locked = await api.request('GET', '/api/v1/posts/' + passwordPost.slug);
  assert.equal(locked.status, 403);
  assert.equal(locked.payload.code, 'post_password_required');
  assert.equal(locked.payload.postId, passwordPost.id);
  assert.match(locked.payload.message, /密码保护/);
  assert.equal(JSON.stringify(locked.payload).includes('PASSWORD-BODY-MARKER'), false);

  const wrong = await api.request('POST', '/api/v1/posts/' + passwordPost.slug + '/unlock', {
    body: { password: 'definitely-wrong' },
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.payload.message, '密码错误');

  const unlocked = await api.request('POST', '/api/v1/posts/' + passwordPost.slug + '/unlock', {
    body: { password: 'open-sesame-123' },
  });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.payload.data.ok, true);
  const setCookie = unlocked.headers.get('set-cookie');
  assert.ok(setCookie, 'unlock must set a cookie');
  assert.match(setCookie, new RegExp('lill_post_' + passwordPost.id + '='));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=604800/);
  const cookie = setCookie.split(';')[0];

  const read = await api.request('GET', '/api/v1/posts/' + passwordPost.slug, { headers: { cookie } });
  data(read);
  assert.equal(read.payload.data.id, passwordPost.id);
  assert.equal('password' in read.payload.data, false);
});

test('an unlock cookie only opens the article it was issued for', async () => {
  const unlocked = await api.request('POST', '/api/v1/posts/' + passwordPost.slug + '/unlock', {
    body: { password: 'open-sesame-123' },
  });
  data(unlocked);
  const cookie = unlocked.headers.get('set-cookie').split(';')[0];
  const other = await api.request('GET', '/api/v1/posts/' + otherPasswordPost.slug, { headers: { cookie } });
  assert.equal(other.status, 403);
  assert.equal(other.payload.code, 'post_password_required');
});

test('public post lists exclude private and password posts', async () => {
  const response = await api.request('GET', '/api/v1/posts?pageSize=100');
  data(response);
  const ids = response.payload.data.items.map(item => item.id);
  assert.ok(ids.includes(publicPost.id));
  assert.equal(ids.includes(privatePost.id), false);
  assert.equal(ids.includes(passwordPost.id), false);
});

test('invalid visibility and missing or malformed passwords are rejected on create and update', async () => {
  const cases = [
    { visibility: 'hidden' },
    { visibility: 'password' },
    { visibility: 'password', password: 'abc' },
  ];
  for (const body of cases) {
    const created = await write(author, 'POST', '/api/v1/admin/posts', {
      title: 'Invalid visibility fixture', content: 'x', ...body,
    });
    assert.equal(created.status, 400, JSON.stringify(created.payload));
    assert.match(created.payload.message, /可见性无效|密码保护需要/);

    // 目标换成没有历史密码的 publicPost：新语义下「已有密码的文章只改可见性但不提交密码」是合法的。
    const updated = await write(author, 'PUT', '/api/v1/admin/posts/' + publicPost.id, body);
    assert.equal(updated.status, 400, JSON.stringify(updated.payload));
    assert.match(updated.payload.message, /可见性无效|密码保护需要/);
  }
});

test('bootstrap for a password post only exposes the unlock view model until unlocked', async () => {
  const locked = await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=' + passwordPost.slug);
  data(locked);
  const boot = locked.payload.data;
  assert.equal(boot.page.type, 'post');
  assert.equal(boot.page.title, passwordPost.title);
  assert.deepEqual(boot.data.post, {
    id: passwordPost.id, title: passwordPost.title, slug: passwordPost.slug, passwordRequired: true,
  });
  const serialized = JSON.stringify(boot);
  assert.equal(serialized.includes('PASSWORD-BODY-MARKER'), false);
  assert.equal(serialized.includes('html_content'), false);

  const unlocked = await api.request('POST', '/api/v1/posts/' + passwordPost.slug + '/unlock', {
    body: { password: 'open-sesame-123' },
  });
  data(unlocked);
  const cookie = unlocked.headers.get('set-cookie').split(';')[0];
  const full = await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=' + passwordPost.slug, {
    headers: { cookie },
  });
  data(full);
  const post = full.payload.data.data.post;
  assert.equal(post.id, passwordPost.id);
  assert.match(post.content, /PASSWORD-BODY-MARKER/);
  assert.equal('password' in post, false);
  assert.equal('passwordRequired' in post, false);
});

test('bootstrap for a private post follows the detail visibility rules', async () => {
  const anonymous = await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=' + privatePost.slug);
  assert.equal(anonymous.status, 404);
  assert.equal(anonymous.payload.message, '内容不存在');
  assert.equal(JSON.stringify(anonymous.payload).includes('PRIVATE-BODY-MARKER'), false);

  const owner = await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=' + privatePost.slug, {
    headers: auth(author),
  });
  data(owner);
  assert.equal(owner.payload.data.data.post.id, privatePost.id);
  assert.match(owner.payload.data.data.post.content, /PRIVATE-BODY-MARKER/);
});

test('legacy rows that kept a password on a public post stay unlockable', async () => {
  const db = new DatabaseSync(api.dbPath);
  const source = db.prepare('SELECT password, published_at, author_id FROM posts WHERE id = ?').get(passwordPost.id);
  assert.ok(source && source.password, 'fixture password post must have a stored hash');
  const legacyId = 'legacy-public-' + randomUUID();
  db.prepare(`
    INSERT INTO posts (id, title, slug, content, html_content, excerpt, type, status, visibility, password, published_at, author_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'post', 'published', 'public', ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    legacyId, 'Legacy public password fixture', 'visibility-password-legacy', 'LEGACY-PASSWORD-BODY',
    '<p>LEGACY-PASSWORD-BODY</p>', 'legacy', source.password, source.published_at, source.author_id,
  );
  db.close();

  const locked = await api.request('GET', '/api/v1/posts/visibility-password-legacy');
  assert.equal(locked.status, 403);
  assert.equal(locked.payload.code, 'post_password_required');
  assert.equal(JSON.stringify(locked.payload).includes('LEGACY-PASSWORD-BODY'), false);

  const boot = await api.request('GET', '/api/v1/site/bootstrap?type=post&slug=visibility-password-legacy');
  data(boot);
  assert.deepEqual(boot.payload.data.data.post, {
    id: legacyId, title: 'Legacy public password fixture',
    slug: 'visibility-password-legacy', passwordRequired: true,
  });

  const unlocked = await api.request('POST', '/api/v1/posts/visibility-password-legacy/unlock', {
    body: { password: 'open-sesame-123' },
  });
  data(unlocked);
  const cookie = unlocked.headers.get('set-cookie').split(';')[0];
  const read = await api.request('GET', '/api/v1/posts/visibility-password-legacy', { headers: { cookie } });
  data(read);
  assert.match(read.payload.data.content, /LEGACY-PASSWORD-BODY/);
});

test('editing a password post without resubmitting the password keeps the old hash', async () => {
  const renamed = await write(author, 'PUT', '/api/v1/admin/posts/' + passwordPost.id, {
    title: 'Password fixture renamed',
  });
  data(renamed);
  assert.equal(renamed.payload.data.title, 'Password fixture renamed');

  const stillOld = await api.request('POST', '/api/v1/posts/' + passwordPost.slug + '/unlock', {
    body: { password: 'open-sesame-123' },
  });
  data(stillOld);

  const rotated = await write(author, 'PUT', '/api/v1/admin/posts/' + passwordPost.id, {
    password: 'brand-new-pass-789',
  });
  data(rotated);

  const oldPassword = await api.request('POST', '/api/v1/posts/' + passwordPost.slug + '/unlock', {
    body: { password: 'open-sesame-123' },
  });
  assert.equal(oldPassword.status, 400);
  assert.equal(oldPassword.payload.message, '密码错误');

  const newPassword = await api.request('POST', '/api/v1/posts/' + passwordPost.slug + '/unlock', {
    body: { password: 'brand-new-pass-789' },
  });
  data(newPassword);
});
