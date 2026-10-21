import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const systemUrl = new URL('../routes/admin/system.js', import.meta.url).href;
const password = 'backup-test-password-123';
const sessionHeaders = session => ({
  authorization: 'Bearer ' + session.token,
  'x-csrf-token': session.csrfToken,
});

async function startBackupApi(t, {
  legacyPaths = false, brokenZip = false, legacySqlite = false, emptyUploads = false,
  slowZip = false, guardClock = '', lateHandler = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lill-backup-test-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const dbPath = legacyPaths ? join(root, 'data', 'lill.db') : join(root, 'runtime " $(touch injected-db) \' data', 'site.sqlite');
  const uploadsDir = join(root, legacyPaths ? 'uploads' : 'attachments " $(touch injected-upload) \' files');
  // Legacy inference points here, deliberately separate from both runtime paths.
  const themesDir = join(root, 'theme-package', 'themes');
  for (const dir of [dirname(dbPath), uploadsDir, themesDir, join(root, 'data'), join(root, 'uploads')]) {
    await mkdir(dir, { recursive: true });
  }
  if (!legacyPaths) {
    const decoy = new DatabaseSync(join(root, 'data', 'lill.db'));
    decoy.exec('CREATE TABLE decoy (value TEXT); INSERT INTO decoy VALUES (\'wrong database\')');
    decoy.close();
  }
  if (!emptyUploads) await writeFile(join(root, 'uploads', 'decoy.txt'), 'wrong attachments');

  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOAD_DIR: uploadsDir, THEMES_DIR: themesDir,
    PLUGINS_DIR: join(root, 'plugins'), JWT_SECRET: 'backup-test-only-secret',
  };
  if (brokenZip || slowZip) {
    const bin = join(root, 'bin');
    await mkdir(bin);
    if (brokenZip) await writeFile(join(bin, 'zip'), '#!/bin/sh\nexit 9\n', { mode: 0o755 });
    else {
      const realZip = execFileSync('which', ['zip'], { encoding: 'utf8' }).trim();
      // Delay only the external command, then create a real archive.
      // The wrapper is a shell script because a `#!` line cannot point at an
      // interpreter whose own path contains spaces (common for bundled Node).
      const script = join(root, 'fake-zip.mjs');
      await writeFile(script, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
writeFileSync(${JSON.stringify(join(root, 'zip.pid'))}, String(process.pid));
setTimeout(() => {
  const child = spawn(${JSON.stringify(realZip)}, process.argv.slice(2), { stdio: 'inherit' });
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
}, ${typeof slowZip === 'number' ? slowZip : 900});
`);
      await writeFile(join(bin, 'zip'),
        '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(script) + ' "$@"\n',
        { mode: 0o755 });
    }
    env.PATH = bin + ':' + process.env.PATH;
  }
  const args = [];
  if (guardClock) {
    const clock = join(root, 'guard-clock.mjs');
    // Run the real guard in hundreds of ms, not repeated 20/150-second waits.
    await writeFile(clock, `
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...args) => schedule(fn,
  delay === 20000 ? ${guardClock === 'disconnect' ? 3000 : 400}
    : delay === 150000 ? ${guardClock === 'timeout' ? 400 : 3000} : delay, ...args);
`);
    args.push('--import', clock);
  }
  if (legacySqlite || lateHandler) {
    // Test instrumentation stays in the child loader, never in production routes.
    const loader = join(root, 'legacy-sqlite-loader.mjs');
    await writeFile(loader, `
export function resolve(specifier, context, nextResolve) {
  if (${legacySqlite} && specifier === 'node:sqlite' && context.parentURL === ${JSON.stringify(systemUrl)}) {
    return { url: 'data:text/javascript,' + encodeURIComponent("export { DatabaseSync } from 'node:sqlite';"), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (${lateHandler} && url === ${JSON.stringify(new URL('../server.js', import.meta.url).href)}) {
    return { ...loaded, source: String(loaded.source) + "\\nrouter.route('GET', '/api/v1/test-late-response', async (_req, res) => { await new Promise(resolve => setTimeout(resolve, 900)); json(res, { late: true }); });\\n" };
  }
  return loaded;
}
`);
    args.push('--experimental-loader', loader);
  }
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  env.PORT = String(probe.address().port);
  await new Promise(resolve => probe.close(resolve));
  const baseUrl = 'http://127.0.0.1:' + env.PORT;
  env.FRONTEND_URL = baseUrl;
  child = spawn(process.execPath, [...args, serverPath], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const request = async (method, path, options = {}) => {
    const headers = { ...options.headers };
    const response = await fetch(baseUrl + path, {
      method, headers, signal: options.signal || AbortSignal.timeout(15000),
      ...(options.body === undefined ? {} : {
        body: JSON.stringify(options.body),
        headers: { ...headers, 'content-type': 'application/json' },
      }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let payload;
    try { payload = JSON.parse(bytes.toString()); } catch { payload = null; }
    return { status: response.status, headers: response.headers, payload, bytes };
  };
  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, output);
    try { ready = (await request('GET', '/api/v1/install/status')).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const installed = await request('POST', '/api/v1/install', { body: {
    site_name: 'Backup integrity', site_url: baseUrl,
    admin_username: 'backup-admin', admin_email: 'backup@example.test', admin_password: password,
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  return {
    root, dbPath, uploadsDir, request, headers: sessionHeaders(session),
    exitCode: () => child.exitCode, output: () => output,
  };
}

async function createBackup(api) {
  const result = await api.request('POST', '/api/v1/admin/backup', { headers: api.headers, body: {} });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.code, 0);
  return result.payload.data;
}

async function writePost(api, title) {
  const result = await api.request('POST', '/api/v1/admin/posts', {
    headers: api.headers, body: { title, content: 'Recent WAL content', status: 'published' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  return result.payload.data;
}

async function waitUntil(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

test('backup uses runtime paths, restores recent data and attachments, and shares list/download location', async t => {
  const api = await startBackupApi(t);
  const post = await writePost(api, 'Custom path post');
  const fileContent = 'Recent attachment bytes — 附件';
  const uploaded = await api.request('POST', '/api/v1/admin/media/upload', {
    headers: api.headers,
    body: { name: 'notes.txt', mime: 'text/plain', data: Buffer.from(fileContent).toString('base64') },
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.payload));
  await mkdir(join(api.uploadsDir, 'nested'));
  await writeFile(join(api.uploadsDir, 'nested', 'quote \' file.txt'), 'nested file');
  const backup = await createBackup(api);
  assert.equal(dirname(backup.path), join(dirname(api.dbPath), 'backups'));
  assert.equal((await stat(dirname(backup.path))).mode & 0o077, 0);
  for (const path of [backup.path, backup.uploads.path]) assert.equal((await stat(path)).mode & 0o077, 0);
  const restored = new DatabaseSync(backup.path, { readOnly: true });
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.ok(restored.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'posts'").get());
    assert.equal(restored.prepare('SELECT content FROM posts WHERE id = ?').get(post.id).content, 'Recent WAL content');
    assert.equal(restored.prepare('SELECT name FROM media WHERE id = ?').get(uploaded.payload.data.id).name, 'notes.txt');
  } finally { restored.close(); }
  const uploadName = basename(uploaded.payload.data.path);
  assert.equal(execFileSync('unzip', ['-p', backup.uploads.path, uploadName], { encoding: 'utf8' }), fileContent);
  assert.equal(execFileSync('unzip', ['-p', backup.uploads.path, 'nested/quote \' file.txt'], { encoding: 'utf8' }), 'nested file');
  for (const marker of ['injected-db', 'injected-upload']) {
    await assert.rejects(stat(join(api.root, marker)), { code: 'ENOENT' });
  }
  const listed = await api.request('GET', '/api/v1/admin/backup/list', { headers: api.headers });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.payload.data.map(item => item.name).sort(), [basename(backup.path), basename(backup.uploads.path)].sort());
  for (const path of [backup.path, backup.uploads.path]) {
    const downloaded = await api.request('GET', '/api/v1/admin/backup/' + encodeURIComponent(basename(path)) + '/download', { headers: api.headers });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-disposition'), /attachment;/);
    assert.deepEqual(downloaded.bytes, await readFile(path));
  }
});

for (const legacySqlite of [false, true]) {
  test((legacySqlite ? 'VACUUM INTO fallback' : 'online backup') + ' includes committed WAL rows while an older reader stays open', async t => {
    const api = await startBackupApi(t, { legacyPaths: true, legacySqlite, emptyUploads: true });
    const reader = new DatabaseSync(api.dbPath);
    t.after(() => reader.close());
    reader.exec('PRAGMA wal_checkpoint(TRUNCATE); BEGIN;');
    reader.prepare('SELECT COUNT(*) FROM posts').get(); // Pin an older WAL snapshot.
    const title = legacySqlite ? 'Fallback WAL post' : 'Latest WAL post';
    const post = await writePost(api, title);
    assert.ok((await stat(api.dbPath + '-wal')).size > 32);
    assert.equal(reader.prepare('SELECT id FROM posts WHERE id = ?').get(post.id), undefined);
    const backup = await createBackup(api);
    const restored = new DatabaseSync(backup.path, { readOnly: true });
    try {
      assert.equal(restored.prepare('SELECT title FROM posts WHERE id = ?').get(post.id)?.title, title);
      assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.ok(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table'").get().n >= 10);
    } finally { restored.close(); }
    reader.exec('ROLLBACK');
  });
}

test('archive failure returns an error and leaves no published backup or success audit entry', async t => {
  const api = await startBackupApi(t, { brokenZip: true });
  await writeFile(join(api.uploadsDir, 'attachment.txt'), 'must be archived');
  const failed = await api.request('POST', '/api/v1/admin/backup', { headers: api.headers, body: {} });
  assert.equal(failed.status, 500, JSON.stringify(failed.payload));
  assert.notEqual(failed.payload.code, 0);
  const list = await api.request('GET', '/api/v1/admin/backup/list', { headers: api.headers });
  assert.equal(list.status, 200);
  assert.deepEqual(list.payload.data, []);
  const live = new DatabaseSync(api.dbPath, { readOnly: true });
  try { assert.equal(live.prepare("SELECT COUNT(*) AS n FROM logs WHERE action = 'backup.create'").get().n, 0); }
  finally { live.close(); }
});

test('backup timeout cancels archiving without late files, success logs or a process crash', async t => {
  const api = await startBackupApi(t, { slowZip: true, guardClock: 'timeout' });
  await writeFile(join(api.uploadsDir, 'attachment.txt'), 'must not be published after timeout');
  const result = await api.request('POST', '/api/v1/admin/backup', { headers: api.headers, body: {} });
  assert.equal(result.status, 503, JSON.stringify(result.payload));
  // The old implementation finishes the delayed archive and crashes here.
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(api.exitCode(), null, api.output());
  assert.equal((await api.request('GET', '/api/v1/install/status')).status, 200);
  const listed = await api.request('GET', '/api/v1/admin/backup/list', { headers: api.headers });
  assert.deepEqual(listed.payload.data, []);
  assert.deepEqual(await readdir(join(dirname(api.dbPath), 'backups')), []);
  const live = new DatabaseSync(api.dbPath, { readOnly: true });
  try { assert.equal(live.prepare("SELECT COUNT(*) AS n FROM logs WHERE action = 'backup.create'").get().n, 0); }
  finally { live.close(); }
  assert.doesNotMatch(api.output(), /ERR_HTTP_HEADERS_SENT|ERR_STREAM_WRITE_AFTER_END/);
});

test('backup progress reports active stages and terminal state; progress requires authentication', async t => {
  const api = await startBackupApi(t, { slowZip: 900, emptyUploads: false });
  await writeFile(join(api.uploadsDir, 'attachment.txt'), 'progress attachment');
  const unauthorized = await api.request('GET', '/api/v1/admin/backup/progress');
  assert.equal(unauthorized.status, 401);
  const pending = api.request('POST', '/api/v1/admin/backup', { headers: api.headers, body: {} });
  await waitUntil(async () => {
    const result = await api.request('GET', '/api/v1/admin/backup/progress', { headers: api.headers });
    return result.status === 200 && result.payload.data.status === 'running' && result.payload.data.progress >= 5;
  }, 'backup progress did not enter running state');
  const running = await api.request('GET', '/api/v1/admin/backup/progress', { headers: api.headers });
  assert.ok(['running', 'done'].includes(running.payload.data.status));
  assert.ok(Number.isFinite(running.payload.data.progress) && running.payload.data.progress >= 0 && running.payload.data.progress <= 100);
  const completed = await pending;
  assert.equal(completed.status, 200);
  const final = await api.request('GET', '/api/v1/admin/backup/progress', { headers: api.headers });
  assert.equal(final.payload.data.status, 'done');
  assert.equal(final.payload.data.progress, 100);
});

test('disconnecting during an active ZIP cancels the child and cleans the staged backup', async t => {
  const api = await startBackupApi(t, { slowZip: 3000, guardClock: 'disconnect' });
  await writeFile(join(api.uploadsDir, 'attachment.txt'), 'disconnected backup');
  const controller = new AbortController();
  const pending = api.request('POST', '/api/v1/admin/backup', {
    headers: api.headers, body: {}, signal: controller.signal,
  });
  let pid;
  await waitUntil(async () => {
    try { pid = Number(await readFile(join(api.root, 'zip.pid'), 'utf8')); return pid > 0; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'the real archive child did not start');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  await waitUntil(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'archive child survived the disconnected request instead of being cancelled', 1000);
  await waitUntil(async () => (await readdir(join(dirname(api.dbPath), 'backups'))).length === 0,
    'disconnected backup left temporary or published files');
  assert.equal((await api.request('GET', '/api/v1/install/status')).status, 200);
  const live = new DatabaseSync(api.dbPath, { readOnly: true });
  try { assert.equal(live.prepare("SELECT COUNT(*) AS n FROM logs WHERE action = 'backup.create'").get().n, 0); }
  finally { live.close(); }
});

test('slow backup outlives the normal request guard and returns a restorable database and archive', async t => {
  const api = await startBackupApi(t, { slowZip: true, guardClock: 'extended' });
  await writeFile(join(api.uploadsDir, 'attachment.txt'), 'slow but successful backup');
  const post = await writePost(api, 'Slow archive WAL row');
  const backup = await createBackup(api);
  const restored = new DatabaseSync(backup.path, { readOnly: true });
  try { assert.equal(restored.prepare('SELECT title FROM posts WHERE id = ?').get(post.id)?.title, 'Slow archive WAL row'); }
  finally { restored.close(); }
  assert.equal(execFileSync('unzip', ['-p', backup.uploads.path, 'attachment.txt'], { encoding: 'utf8' }), 'slow but successful backup');
  assert.equal((await api.request('GET', '/api/v1/install/status')).status, 200);
  assert.doesNotMatch(api.output(), /ERR_HTTP_HEADERS_SENT|ERR_STREAM_WRITE_AFTER_END/);
});

test('a late handler after the normal request guard cannot crash the API with a second response', async t => {
  const api = await startBackupApi(t, { guardClock: 'extended', lateHandler: true });
  const result = await api.request('GET', '/api/v1/test-late-response');
  assert.equal(result.status, 503, JSON.stringify(result.payload));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(api.exitCode(), null, api.output());
  assert.equal((await api.request('GET', '/api/v1/install/status')).status, 200);
});

test('empty uploads are a valid database-only backup and rapid requests do not overwrite each other', async t => {
  const api = await startBackupApi(t, { emptyUploads: true });
  const backups = await Promise.all([createBackup(api), createBackup(api)]);
  assert.notEqual(backups[0].path, backups[1].path);
  for (const backup of backups) assert.equal(backup.uploads, null);
  const list = await api.request('GET', '/api/v1/admin/backup/list', { headers: api.headers });
  assert.equal(list.payload.data.length, 2);
  assert.deepEqual((await readdir(join(dirname(api.dbPath), 'backups'))).sort(), backups.map(backup => basename(backup.path)).sort());
});

test('backup creation, listing and download require an administrator and writes require CSRF', async t => {
  const api = await startBackupApi(t, { emptyUploads: true });
  const backup = await createBackup(api);
  const download = '/api/v1/admin/backup/' + encodeURIComponent(basename(backup.path)) + '/download';
  for (const [method, path] of [['POST', '/api/v1/admin/backup'], ['GET', '/api/v1/admin/backup/list'], ['GET', download]]) {
    assert.equal((await api.request(method, path)).status, 401);
  }
  assert.equal((await api.request('POST', '/api/v1/admin/backup', {
    headers: { authorization: api.headers.authorization }, body: {},
  })).status, 403);
  for (const role of ['editor', 'author', 'contributor', 'subscriber']) {
    const created = await api.request('POST', '/api/v1/admin/users', {
      headers: api.headers, body: { username: role, email: role + '@example.test', password, role },
    });
    assert.equal(created.status, 201);
    const login = await api.request('POST', '/api/v1/auth/login', { body: { username: role, password } });
    assert.equal(login.status, 200, JSON.stringify(login.payload));
    const headers = sessionHeaders(login.payload.data);
    for (const [method, path] of [['POST', '/api/v1/admin/backup'], ['GET', '/api/v1/admin/backup/list'], ['GET', download]]) {
      assert.equal((await api.request(method, path, { headers, body: method === 'POST' ? {} : undefined })).status, 403, role + ' ' + path);
    }
  }
});

test('backup list/download do not expose traversal paths, directories or symlinks', async t => {
  const api = await startBackupApi(t, { emptyUploads: true });
  const backup = await createBackup(api);
  const dir = dirname(backup.path);
  await mkdir(join(dir, 'lill-backup-directory.db'));
  const outside = join(api.root, 'private.db');
  await writeFile(outside, 'must not be downloaded');
  await symlink(outside, join(dir, 'lill-backup-link.db'));
  const list = await api.request('GET', '/api/v1/admin/backup/list', { headers: api.headers });
  assert.deepEqual(list.payload.data.map(item => item.name), [basename(backup.path)]);
  for (const name of ['../private.db', '..\\private.db', 'lill-backup-directory.db', 'lill-backup-link.db', 'missing.db']) {
    const result = await api.request('GET', '/api/v1/admin/backup/' + encodeURIComponent(name) + '/download', { headers: api.headers });
    assert.ok([400, 404].includes(result.status), name + ': ' + result.status);
  }
});

test('backup restore replaces live data and keeps a pre-restore safety copy', async t => {
  const api = await startBackupApi(t);
  await writePost(api, 'Kept before backup');
  const backup = await createBackup(api);
  const backupName = basename(backup.path);
  const later = await writePost(api, 'Written after backup');

  const restore = await api.request('POST', '/api/v1/admin/backup/restore', { headers: api.headers, body: { name: backupName } });
  assert.equal(restore.status, 200, JSON.stringify(restore.payload));
  assert.equal(restore.payload.data.restored, backupName);
  assert.ok(restore.payload.data.tables >= 10);

  const listed = await api.request('GET', '/api/v1/admin/posts?page=1&pageSize=50', { headers: api.headers });
  const titles = (listed.payload.data.items || []).map(item => item.title);
  assert.ok(titles.includes('Kept before backup'), titles.join(','));
  assert.ok(!titles.includes('Written after backup'), titles.join(','));

  const safety = new DatabaseSync(join(dirname(api.dbPath), 'backups', restore.payload.data.safetyBackup), { readOnly: true });
  try { assert.ok(safety.prepare('SELECT id FROM posts WHERE id = ?').get(later.id)); }
  finally { safety.close(); }

  for (const name of ['../private.db', 'lill-uploads-x.zip', 'missing.db', '']) {
    const bad = await api.request('POST', '/api/v1/admin/backup/restore', { headers: api.headers, body: { name } });
    // A missing but well-formed .zip name now reaches the restore branch and must be reported as 404.
    assert.ok([400, 404].includes(bad.status), name + ': ' + bad.status);
  }
});

test('uploads restore puts archived attachments back, snapshots the current uploads and refuses traversal entries', async t => {
  const api = await startBackupApi(t);
  const attachment = join(api.uploadsDir, 'restore-me.txt');
  await writeFile(attachment, 'attachment captured by backup');
  await mkdir(join(api.uploadsDir, 'nested'), { recursive: true });
  await writeFile(join(api.uploadsDir, 'nested', 'deep.txt'), 'nested attachment');
  const backup = await createBackup(api);
  assert.ok(backup.uploads, JSON.stringify(backup));
  const zipName = basename(backup.uploads.path);
  assert.match(zipName, /^lill-uploads-[\w-]+\.zip$/);
  // Remove one attachment while leaving another one in place, so the pre-restore snapshot has content.
  await rm(attachment);

  const restore = await api.request('POST', '/api/v1/admin/backup/restore', { headers: api.headers, body: { name: zipName } });
  assert.equal(restore.status, 200, JSON.stringify(restore.payload));
  assert.equal(restore.payload.data.restored, zipName);
  assert.ok(restore.payload.data.files >= 2, JSON.stringify(restore.payload));
  assert.match(restore.payload.data.message, /附件已从备份恢复/);
  assert.match(restore.payload.data.safetyBackup, /^lill-uploads-before-restore-[\w-]+\.zip$/);
  assert.equal(await readFile(attachment, 'utf8'), 'attachment captured by backup');
  assert.equal(await readFile(join(api.uploadsDir, 'nested', 'deep.txt'), 'utf8'), 'nested attachment');

  const listed = await api.request('GET', '/api/v1/admin/backup/list', { headers: api.headers });
  const names = listed.payload.data.map(item => item.name);
  assert.ok(names.includes(restore.payload.data.safetyBackup), names.join(','));
  const live = new DatabaseSync(api.dbPath, { readOnly: true });
  try { assert.equal(live.prepare("SELECT COUNT(*) AS n FROM logs WHERE action = 'backup.restore.uploads'").get().n, 1); }
  finally { live.close(); }

  const rollback = await api.request('POST', '/api/v1/admin/backup/restore', { headers: api.headers, body: { name: restore.payload.data.safetyBackup } });
  assert.equal(rollback.status, 200, JSON.stringify(rollback.payload));
  assert.equal(await readFile(attachment, 'utf8'), 'attachment captured by backup');

  let hasPython = true;
  try { execFileSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' }); } catch { hasPython = false; }
  if (hasPython) {
    const evilName = 'lill-uploads-evil.zip';
    execFileSync('python3', ['-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as archive:\n    archive.writestr("../escaped.txt", "must never be written")\n', join(dirname(backup.path), evilName)]);
    const evil = await api.request('POST', '/api/v1/admin/backup/restore', { headers: api.headers, body: { name: evilName } });
    assert.equal(evil.status, 400, JSON.stringify(evil.payload));
    assert.match(evil.payload.message, /非法路径/);
    await assert.rejects(stat(join(dirname(api.uploadsDir), 'escaped.txt')), { code: 'ENOENT' });
  }
});

test('uploads restore rejects ZIP symbolic links before extracting them', async t => {
  const api = await startBackupApi(t);
  const backup = await createBackup(api);
  const symlinkName = 'lill-uploads-symlink.zip';
  execFileSync('python3', ['-c', 'import sys, zipfile\nzi = zipfile.ZipInfo("link.txt"); zi.external_attr = (0o120777 << 16)\nzipfile.ZipFile(sys.argv[1], "w").writestr(zi, "/etc/passwd")\n', join(dirname(backup.path), symlinkName)]);

  const result = await api.request('POST', '/api/v1/admin/backup/restore', {
    headers: api.headers, body: { name: symlinkName },
  });
  assert.equal(result.status, 400, JSON.stringify(result.payload));
  assert.match(result.payload.message, /符号链接/);
  await assert.rejects(stat(join(api.uploadsDir, 'link.txt')), { code: 'ENOENT' });
});
