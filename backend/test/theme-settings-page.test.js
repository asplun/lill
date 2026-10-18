import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

test('theme settings advertise only existing public HTML pages within their own theme', async t => {
  const cases = [
    ['custom', 'settings/editor.html', '/themes/custom/settings/editor.html'],
    ['schema', undefined, ''],
    ['missing', 'missing.html', ''],
    ['traversal', '../custom/settings/editor.html', ''],
    ['absolute', '/settings/editor.html', ''],
    ['remote', 'https://example.test/settings.html', ''],
    ['protocol-relative', '//example.test/settings.html', ''],
    ['encoded', '%2e%2e/custom/settings/editor.html', ''],
    ['backslash', 'settings\\editor.html', ''],
    ['script', 'settings/editor.js', ''],
    ['query', 'settings/editor.html?next=/admin/', ''],
    ['fragment', 'settings/editor.html#tab', ''],
    ['private', 'backend/editor.html', ''],
    ['unpublished', 'admin/editor.html', ''],
    ['hidden', '.private/editor.html', ''],
    ['directory', 'folder.html', ''],
    ['symlink', 'settings/editor.html', ''],
  ];
  const api = await startApiServer({ prepareThemes: async themesDir => {
    for (const [id, settingsPage] of cases) {
      const dir = join(themesDir, id);
      await mkdir(join(dir, 'settings'), { recursive: true });
      await writeFile(join(dir, 'theme.json'), JSON.stringify({
        id, name: id, version: '1.0.0', settingsPage,
        settings: id === 'custom' ? [] : [{ key: 'accent', type: 'text', default: 'blue' }],
      }));
      await writeFile(join(dir, 'settings/editor.html'), '<!doctype html><title>Theme settings</title>');
      if (id === 'private' || id === 'unpublished' || id === 'hidden') {
        const target = join(dir, settingsPage);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, '<!doctype html>');
      }
      if (id === 'directory') await mkdir(join(dir, 'folder.html'));
    }
    const external = join(dirname(themesDir), 'outside.html');
    await writeFile(external, '<!doctype html>');
    await symlink(external, join(themesDir, 'symlink', 'linked.html'));
    await writeFile(join(themesDir, 'symlink', 'theme.json'), JSON.stringify({
      id: 'symlink', name: 'symlink', settingsPage: 'linked.html', settings: [],
    }));
  } });
  t.after(api.stop);
  const install = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Settings page test', site_url: api.baseUrl,
    admin_username: 'settings-admin', admin_email: 'settings@example.test',
    admin_password: 'settings-test-password-123',
  } });
  assert.equal(install.status, 200);
  const headers = { authorization: 'Bearer ' + install.payload.data.token };
  const list = await api.request('GET', '/api/v1/admin/themes', { headers });
  assert.equal(list.status, 200);
  for (const [id, , expected] of cases) {
    const result = await api.request('GET', '/api/v1/admin/themes/' + id + '/settings', { headers });
    assert.equal(result.status, 200, id + ': ' + JSON.stringify(result.payload));
    assert.equal(result.payload.data.settingsUrl, expected, id);
    const theme = list.payload.data.find(item => item.theme_id === id);
    assert.equal(theme.settingsUrl, expected, id + ' list URL');
    assert.equal(theme.hasSettings, id !== 'symlink', id + ' keeps schema settings available');
    if (id === 'schema') {
      assert.equal(result.payload.data.schema[0].key, 'accent');
      assert.deepEqual(result.payload.data.values, {});
    }
  }
  const anonymous = await api.request('GET', '/api/v1/admin/themes/custom/settings');
  assert.equal(anonymous.status, 401);
});
