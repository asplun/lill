/** Backend management route composition root. */
import { register as registerLegacy } from '../admin.js';
import { register as registerContent } from './content.js';
import { register as registerTaxonomy } from './taxonomy.js';
import { register as registerComments } from './comments.js';
import { register as registerMedia } from './media.js';
import { register as registerUsers } from './users.js';
import { register as registerSettings } from './settings.js';
import { register as registerThemes } from './themes.js';
import { register as registerPlugins } from './plugins.js';
import { register as registerSystem } from './system.js';
import { register as registerWidgets } from './widgets.js';
import { register as registerEditorExtensions } from './editor-extensions.js';
import { createAdminHelpers } from './shared.js';

const SKIPPED_ROUTES = new Set([
  'GET:/api/v1/admin/posts', 'GET:/api/v1/admin/pages', 'GET:/api/v1/admin/page-templates', 'GET:/api/v1/admin/editor-fields',
  'POST:/api/v1/admin/posts', 'PUT:/api/v1/admin/posts/:id', 'GET:/api/v1/admin/posts/:id',
  'DELETE:/api/v1/admin/posts/:id', 'GET:/api/v1/admin/posts/recent', 'POST:/api/v1/admin/posts/batch',
  'GET:/api/v1/admin/categories', 'POST:/api/v1/admin/categories', 'PUT:/api/v1/admin/categories/:id', 'DELETE:/api/v1/admin/categories/:id', 'POST:/api/v1/admin/categories/reorder',
  'GET:/api/v1/admin/tags', 'POST:/api/v1/admin/tags', 'PUT:/api/v1/admin/tags/:id', 'DELETE:/api/v1/admin/tags/:id', 'POST:/api/v1/admin/tags/reorder',
  'GET:/api/v1/admin/comments/export', 'GET:/api/v1/admin/comments', 'PATCH:/api/v1/admin/comments/:id/status', 'DELETE:/api/v1/admin/comments/:id',
  'GET:/api/v1/admin/comments/recent', 'POST:/api/v1/admin/comments/:id/reply', 'PUT:/api/v1/admin/comments/:id', 'PATCH:/api/v1/admin/comments/batch-status',
  'POST:/api/v1/admin/media/upload', 'GET:/api/v1/admin/media', 'DELETE:/api/v1/admin/media/:id',
  'GET:/api/v1/admin/users', 'GET:/api/v1/admin/users/:id', 'POST:/api/v1/admin/users', 'PUT:/api/v1/admin/users/:id', 'DELETE:/api/v1/admin/users/:id',
  'GET:/api/v1/admin/options', 'PUT:/api/v1/admin/options',
  'GET:/api/v1/admin/themes', 'POST:/api/v1/admin/themes/:themeId/activate', 'GET:/api/v1/admin/themes/:themeId/settings',
  'PUT:/api/v1/admin/themes/:themeId/settings', 'POST:/api/v1/admin/themes/install', 'DELETE:/api/v1/admin/themes/:themeId', 'POST:/api/v1/admin/themes/batch',
  'GET:/api/v1/admin/themes/files', 'GET:/api/v1/admin/themes/file', 'PUT:/api/v1/admin/themes/file',
  'GET:/api/v1/admin/plugins', 'POST:/api/v1/admin/plugins/toggle', 'GET:/api/v1/admin/plugin-menus',
  'GET:/api/v1/admin/plugins/:dir/config', 'PUT:/api/v1/admin/plugins/:dir/config', 'POST:/api/v1/admin/plugins/install', 'DELETE:/api/v1/admin/plugins/:dir', 'POST:/api/v1/admin/plugins/batch',
  'GET:/api/v1/admin/stats/dashboard', 'GET:/api/v1/admin/stats/system', 'GET:/api/v1/admin/logs', 'GET:/api/v1/admin/logs/stats',
  'DELETE:/api/v1/admin/logs', 'POST:/api/v1/admin/logs/batch', 'POST:/api/v1/admin/backup', 'GET:/api/v1/admin/backup/list', 'DELETE:/api/v1/admin/backup', 'GET:/api/v1/admin/backup/:name/download',
  'GET:/api/v1/admin/backup/progress', 'GET:/api/v1/admin/system/version', 'GET:/api/v1/admin/system/health', 'GET:/api/v1/admin/system/monitor',
  'GET:/api/v1/admin/sites',
  'GET:/api/v1/admin/widgets', 'POST:/api/v1/admin/widgets', 'PUT:/api/v1/admin/widgets/:id', 'DELETE:/api/v1/admin/widgets/:id',
]);

export function register(router, ctx) {
  registerLegacy(router, ctx, { skip: SKIPPED_ROUTES });
  const helpers = createAdminHelpers(ctx, router);
  registerContent(router, ctx, helpers);
  registerEditorExtensions(router, ctx, helpers);
  registerTaxonomy(router, ctx, helpers);
  registerComments(router, ctx, helpers);
  registerMedia(router, ctx, helpers);
  registerUsers(router, ctx, helpers);
  registerSettings(router, ctx, helpers);
  registerThemes(router, ctx, helpers);
  registerPlugins(router, ctx, helpers);
  registerSystem(router, ctx, helpers);
  registerWidgets(router, ctx, helpers);
}
