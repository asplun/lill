import assert from 'node:assert/strict';
import test from 'node:test';
import { startApiServer } from './helpers/api-server.js';

async function setup(t) {
  const api = await startApiServer();
  t.after(api.stop);
  const installed = await api.request('POST', '/api/v1/install', { body: {
    site_name: 'Taxonomy workflow test',
    site_url: api.baseUrl,
    admin_username: 'taxonomy-admin',
    admin_email: 'taxonomy-admin@example.test',
    admin_password: 'taxonomy-password-123',
  } });
  assert.equal(installed.status, 200, JSON.stringify(installed.payload));
  const session = installed.payload.data;
  return {
    api,
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-csrf-token': session.csrfToken,
    },
  };
}

const createCategory = (api, headers, body) =>
  api.request('POST', '/api/v1/admin/categories', { headers, body });

test('category parents cannot be missing, self-referential or cyclic', async t => {
  const { api, headers } = await setup(t);
  const first = await createCategory(api, headers, { name: 'First', slug: 'first' });
  const second = await createCategory(api, headers, { name: 'Second', slug: 'second', parentId: first.payload.data.id });
  const third = await createCategory(api, headers, { name: 'Third', slug: 'third', parentId: second.payload.data.id });
  assert.equal(third.status, 201, JSON.stringify(third.payload));

  const self = await api.request('PUT', `/api/v1/admin/categories/${first.payload.data.id}`, {
    headers,
    body: { name: 'First', slug: 'first', parentId: first.payload.data.id },
  });
  assert.equal(self.status, 400);

  const cycle = await api.request('PUT', `/api/v1/admin/categories/${first.payload.data.id}`, {
    headers,
    body: { name: 'First', slug: 'first', parentId: third.payload.data.id },
  });
  assert.equal(cycle.status, 400);

  const missingParent = await createCategory(api, headers, { name: 'Orphan', slug: 'orphan', parentId: 'missing' });
  assert.equal(missingParent.status, 400);
});

test('category and tag mutations reject missing records and duplicate identities', async t => {
  const { api, headers } = await setup(t);
  const category = await createCategory(api, headers, { name: 'Duplicate', slug: 'duplicate' });
  assert.equal(category.status, 201, JSON.stringify(category.payload));
  assert.equal((await createCategory(api, headers, { name: 'Duplicate', slug: 'other' })).status, 409);
  assert.equal((await createCategory(api, headers, { name: 'Other', slug: 'duplicate' })).status, 409);

  const missingCategory = await api.request('PUT', '/api/v1/admin/categories/missing', {
    headers,
    body: { name: 'Missing', slug: 'missing' },
  });
  assert.equal(missingCategory.status, 404);
  assert.equal((await api.request('DELETE', '/api/v1/admin/categories/missing', { headers })).status, 404);

  const tag = await api.request('POST', '/api/v1/admin/tags', { headers, body: { name: 'Tag', slug: 'tag' } });
  assert.equal(tag.status, 201, JSON.stringify(tag.payload));
  assert.equal((await api.request('POST', '/api/v1/admin/tags', { headers, body: { name: 'Tag', slug: 'other-tag' } })).status, 409);
  assert.equal((await api.request('PUT', '/api/v1/admin/tags/missing', { headers, body: { name: 'Missing' } })).status, 404);
  assert.equal((await api.request('DELETE', '/api/v1/admin/tags/missing', { headers })).status, 404);
});

test('deleting a category with children is rejected instead of orphaning them', async t => {
  const { api, headers } = await setup(t);
  const parent = await createCategory(api, headers, { name: 'Parent', slug: 'parent' });
  assert.equal(parent.status, 201, JSON.stringify(parent.payload));
  const child = await createCategory(api, headers, {
    name: 'Child', slug: 'child', parentId: parent.payload.data.id,
  });
  assert.equal(child.status, 201, JSON.stringify(child.payload));

  const removed = await api.request('DELETE', `/api/v1/admin/categories/${parent.payload.data.id}`, { headers });
  assert.equal(removed.status, 409);
  const categories = await api.request('GET', '/api/v1/admin/categories', { headers });
  assert.ok(categories.payload.data.some(item => item.id === parent.payload.data.id));
  assert.equal(categories.payload.data.find(item => item.id === child.payload.data.id).parent_id, parent.payload.data.id);
});
