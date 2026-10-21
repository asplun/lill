# Plugin Editor Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Lill 插件增加可回收、可校验的编辑器字段、动作和前端挂载扩展，同时保留主题字段边界和历史数据。

**Architecture:** 服务端在现有插件上下文中维护按插件目录隔离的 editor registry；核心编辑器通过认证 API 获取当前启用插件的字段、动作和扩展清单。字段继续存入 `posts.fields` 的 `_lillPluginFields` 命名空间；动作由服务端 handler 返回白名单操作；前端扩展通过认证后加载的自包含模块挂载到核心提供的 `toolbar`/`sidebar` slot，并只使用稳定 editor bridge。

**Tech Stack:** Node.js native HTTP, SQLite JSON text column, Astro static admin, vanilla JavaScript, Node built-in test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-19-plugin-editor-extensions-design.md`

## Global Constraints

- 继续使用 Astro 静态管理端 + Node REST backend + SQLite，不引入新的前端框架或数据库表。
- 复用已有 `posts.fields`；插件数据只写 `_lillPluginFields`，不得覆盖通用字段或 `_lillThemeFields`。
- `ctx.registerEditorField(field)`、`ctx.registerEditorAction(action)` 和 `ctx.registerEditorExtension(extension)` 的注册项必须随插件停用、卸载和激活失败自动回收。
- 核心编辑器 DOM、CSS 类名和全局变量不是插件 API；插件只能使用声明的 slot 和 editor bridge。
- 动作结果只允许受限文本/字段操作，禁止可执行 HTML、脚本、任意 DOM 指令和任意服务器路径。
- 停用或卸载插件不删除历史插件字段值；公开内容 API 不自动暴露插件字段。
- 保留工作区现有未提交内容，不修改 Trim3，不部署，不回退无关改动。
- 每项实现先写失败测试，再写最小实现；使用仓库内置 Node 运行时。

## Review Focus

- 同一插件重复 key/ID、未知字段类型、未知 slot、非法资源路径：激活应失败且不留下任何注册项。测试归 Task 1。
- 激活成功后数据库持久化失败、`deactivate()` 抛错、另一个插件覆盖相同路由：editor 注册项必须与插件运行状态一致，不能复活已停用项。测试归 Task 1。
- 插件字段更新只改本插件 namespace，并保留通用字段、主题字段、其他插件字段和未知历史值。测试归 Task 2。
- 动作 handler 返回 HTML、脚本、超长文本或未知操作：请求应拒绝且正文不变；handler 抛错不能阻断编辑器。测试归 Task 2。
- 扩展资源加载失败、扩展初始化失败、编辑器扩展 API 请求失败：核心编辑器和其他扩展仍可用，卸载必须移除 slot 内容和监听。测试归 Task 3。

---

### Task 1: 插件编辑器注册表与生命周期回收

**Files:**
- Create: `backend/lib/plugin-editor-ext.js`
- Modify: `backend/lib/plugin-ext.js:120-315`
- Modify: `backend/server.js:400-440`
- Test: `backend/test/plugin-editor-ext.test.js`
- Test: `backend/test/install-plugin-integrity.test.js`

**Interfaces:**
- `normalizeEditorField(field, pluginDir) -> Field`
- `normalizeEditorAction(action, pluginDir) -> Action`
- `normalizeEditorExtension(extension, pluginDir) -> Extension`
- `createEditorRegistry() -> { fields, actions, extensions, registerField, registerAction, registerExtension, clearPlugin }`
- `createPluginContext(ctx, pluginDir)` exposes:
  - `registerEditorField(field) -> () => void`
  - `registerEditorAction(action) -> () => void`
  - `registerEditorExtension(extension) -> () => void`
- `ctx._editorRegistry` is the runtime registry consumed by admin routes.
- `clearPluginRegistrations()` clears all three editor registration kinds in addition to routes, hooks, and menus.

- [ ] **Step 1: Write failing registry tests**

Add tests for:

- Valid field normalization with `post`, `page`, `both`, six supported types, group/default/description, and plugin ownership.
- Rejection of invalid keys, reserved keys, duplicate keys, unsupported field types, malformed select options, empty labels, and oversized declarations.
- Action normalization requiring a stable `id`, label, allowed placement/content type, and function handler; handler is retained server-side but omitted from public metadata.
- Extension normalization requiring a stable `id`, relative `.js` entry, optional `.css` styles, `toolbar`/`sidebar` slots only, and `apiVersion: 1`.
- Duplicate IDs are rejected within one plugin; IDs from different plugins remain isolated.
- Registration returns an idempotent cleanup function and `clearPlugin(dir)` removes fields/actions/extensions only for that plugin.
- Activation failure after all three registrations leaves no registry entries; deactivation removes entries while historical database data is untouched.

- [ ] **Step 2: Run focused tests and confirm failure**

Run from `lill-v2/backend`:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/plugin-editor-ext.test.js test/install-plugin-integrity.test.js
```

Expected: the new registry module/context methods are missing; existing plugin lifecycle assertions remain green.

- [ ] **Step 3: Implement pure normalization and registry**

Create `plugin-editor-ext.js` with bounded declarative validation. Store registrations as `Map<pluginDir, Map<id, registration>>`; return cloned serializable metadata from query helpers. Keep action handlers and cleanup callbacks out of public metadata. Use the existing plugin context as the only registration entry point.

- [ ] **Step 4: Integrate lifecycle cleanup**

Add `_editorRegistry` to the server context, pass it through `createPluginContext`, and clear the plugin's editor registrations from the same rollback path used for routes/hooks/menus. Ensure cleanup runs for activation rejection, persistence failure rollback, normal deactivation, and uninstall.

- [ ] **Step 5: Re-run focused tests**

Run the command from Step 2. Expected: registry validation, isolation, activation rollback, and deactivation cleanup pass.

---

### Task 2: Editor metadata, plugin field persistence, and action execution API

**Files:**
- Create: `backend/routes/admin/editor-extensions.js`
- Modify: `backend/routes/admin/content.js`
- Modify: `backend/routes/admin/shared.js`
- Modify: `backend/routes/admin/index.js`
- Modify: `backend/server.js:400-440`
- Test: `backend/test/plugin-editor-api.test.js`
- Test: `backend/test/content-write-integrity.test.js`
- Test: `backend/test/architecture.test.js`

**Interfaces:**
- `GET /api/v1/admin/editor-extensions?type=post|page` returns:

```json
{
  "extensions": [
    {
      "plugin": "image-tools",
      "fields": [],
      "actions": [{ "id": "insert-image", "label": "插入图片", "placement": "toolbar", "for": ["post"] }],
      "modules": [{ "id": "image-tools", "entry": "/api/v1/admin/editor-assets/image-tools?path=editor/index.js", "styles": [], "slots": ["toolbar", "sidebar"], "apiVersion": 1 }]
    }
  ]
}
```

- `GET /api/v1/admin/editor-assets/:dir?path=<relative-file>` returns `{ content, mime }` for only an active plugin's declared `.js`/`.css` asset, with path traversal, absolute path, symlink escape, and undeclared asset rejection. Returning JSON keeps it compatible with the existing authenticated `lillAPI.request` wrapper; the browser converts `content` to a Blob URL.
- `POST /api/v1/admin/editor-actions/:plugin/:action` accepts `{ postId, contentType, selection }`, verifies content ownership through the same content-role policy, calls the registered handler, and returns only a validated operation object.
- `GET /api/v1/admin/posts/:id` adds `pluginFields` projected from active plugin schemas while retaining `fields` and `themeFields`.
- `POST /api/v1/admin/posts` and `PUT /api/v1/admin/posts/:id` accept `pluginFields: { [pluginDir]: { [key]: value } }`; only active, declared fields are accepted.

- [ ] **Step 1: Write failing API and persistence tests**

Add tests proving:

- Content roles can read the extension manifest; subscribers and unauthorized users cannot.
- Metadata excludes action handlers and inactive plugins, filters fields/actions/modules by `post`/`page`, and returns stable asset URLs.
- Asset endpoint serves declared JavaScript/CSS only, rejects undeclared files, traversal, absolute paths, inactive plugins, and non-allowed extensions.
- Action execution receives `postId`, `contentType`, and selection context; accepts `{ insertText }`, `{ replaceSelection }`, and namespaced field updates; rejects unknown keys, HTML/script payloads, overlong values, malformed objects, and wrong content type.
- Action errors return a non-success response without mutating the post.
- Plugin fields are stored below `_lillPluginFields[pluginDir]`, read back with defaults, and never overwrite generic fields or `_lillThemeFields`.
- Omitting plugin fields on update preserves them; updating one plugin preserves other plugin namespaces and unknown historical values.
- Invalid plugin field values return 400 before creating a post version or changing the post.
- Stopping a plugin removes its metadata projection but leaves its stored values available after reactivation.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/plugin-editor-api.test.js test/content-write-integrity.test.js test/architecture.test.js
```

Expected: the new routes and `_lillPluginFields` behavior fail; existing theme-field tests remain green.

- [ ] **Step 3: Implement plugin-field storage helpers**

Add pure helpers in `plugin-editor-ext.js`:

- `readPluginEditorFields(storedFields, registry, contentType) -> { [pluginDir]: fields }`
- `mergePluginEditorFields(storedFields, submitted, registry, contentType) -> object`

Accept JSON text or objects, validate only active declarations, preserve all unrelated namespaces, and treat unknown historical values as opaque data.

- [ ] **Step 4: Implement extension metadata and asset routes**

Register the routes through the existing admin route composition with `contentRoles` policy. Query the live registry, filter by content type, and serialize only safe metadata. Resolve assets under the real plugin directory with `realpath` containment checks; return correct JavaScript/CSS content types and `Cache-Control: no-store`.

- [ ] **Step 5: Implement action execution**

Look up the live action by plugin/action ID, verify the authenticated editor can access the target post/page, call the handler with a plain context object, and validate exactly one operation before responding:

- `{ insertText: string }`
- `{ replaceSelection: string }`
- `{ setPluginField: { key: string, value: scalar } }`

Limit inserted/replacement text to the existing 50,000-character content ceiling, require `setPluginField.key` to be declared by the same plugin, and reject markup/script-looking operation keys or unknown properties. Do not execute or persist the operation on the server; the browser applies it through the editor bridge.

- [ ] **Step 6: Integrate content read/write**

Extend `content.js` validation and transaction assembly so plugin fields are validated before versions/writes. Preserve existing generic/theme field behavior. Add `pluginFields` to admin detail reads only; do not add plugin fields to public bootstrap or public post responses.

- [ ] **Step 7: Re-run focused API tests**

Run the command from Step 2. Expected: metadata, resource security, action whitelist, role policy, persistence isolation, and lifecycle assertions pass.

---

### Task 3: Core editor bridge, slots, plugin fields, and actions

**Files:**
- Modify: `frontend/public/admin/app.js`
- Modify: `frontend/public/admin/admin.css`
- Test: `backend/test/admin-editor.test.js`
- Test: `backend/test/admin-ui.test.js`

**Interfaces:**
- The editor requests `/admin/editor-extensions?type=<contentType>` alongside the existing editor prerequisites.
- `createEditorBridge({ post, type, pluginDir, fieldSchema, textarea })` exposes:
  - `getDocument()`, `getContent()`
  - `replaceContent(text)`, `insertText(text)`, `replaceSelection(text)`
  - `getPluginFields()`, `setPluginField(key, value)`
  - `on(event, handler)` for `content:change`, `save:before`, `save:after`
  - `request(method, path, options)`
- `createEditorSlots(root)` exposes only `toolbar.mount(render)` and `sidebar.mount(render)`; `mount` returns `{ unmount() }`.
- `loadEditorExtensions(manifest, context)` fetches authenticated modules/styles, calls `activate({ editor, slots, plugin })`, and records cleanup; failures are isolated per extension.
- Core save runs `save:before` handlers serially, applies returned `{ content }`, then saves; it emits `save:after` only after a successful response.

- [ ] **Step 1: Write failing editor unit tests**

Extend the fake DOM harness and add tests for:

- Loading plugin field schemas and rendering isolated groups with safe escaping and defaults.
- Serializing `pluginFields` while preserving existing theme field payloads.
- Rendering action buttons only for the declared content type and applying valid `insertText`/`replaceSelection` results.
- Creating toolbar/sidebar slot roots without exposing core DOM selectors.
- Bridge methods updating content and plugin-owned fields; unknown field keys and unsupported events fail clearly.
- `save:before` handlers running in order, transforming content, and cancelling save on errors; `save:after` fires only after success.
- Extension/module failure leaves the editor usable and cleans all mounted roots/listeners.

- [ ] **Step 2: Run focused editor tests and confirm failure**

Run:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test backend/test/admin-editor.test.js
```

Expected: current editor still supports theme fields but has no plugin field/action/slot/bridge behavior.

- [ ] **Step 3: Implement editor state bridge and slots**

Add small vanilla-JS helpers adjacent to the existing editor helpers. Keep slot containers owned by core, pass each extension a plugin-scoped bridge, and never expose or require internal editor element IDs beyond the bridge implementation.

- [ ] **Step 4: Load metadata, render fields/actions, and wire save**

Fetch extension metadata with the same abort signal as the editor load. Render plugin fields in a separate plugin-owned section, render actions in the declared toolbar slot, and submit plugin fields only when their schema loaded. If metadata fails, show a non-blocking warning and preserve the core editor.

- [ ] **Step 5: Load and unload extension modules**

Fetch each declared module through `lillAPI.request` (the asset response is `{ content, mime }`), create a Blob URL for the self-contained module, inject declared stylesheet text into a plugin-owned style node, call `activate`, and retain cleanup. On navigation or editor replacement, invoke cleanup, revoke Blob URLs, remove style nodes, clear slot roots, and unsubscribe bridge listeners.

- [ ] **Step 6: Run browser regression coverage**

Extend `admin-ui.test.js` fixtures with:

- one plugin declaring a post field/action and a sidebar module;
- one plugin declaring a page-only field;
- one failing module and one invalid action.

Verify desktop editor behavior, save/reopen persistence, action insertion, page/post filtering, module failure isolation, plugin disable cleanup, and no script execution from labels/values.

Run:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test backend/test/admin-editor.test.js
LILL_UI_PLAYWRIGHT=/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs LILL_UI_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test backend/test/admin-ui.test.js
```

Expected: all existing theme-field editor cases and new plugin extension cases pass.

---

### Task 4: Plugin developer documentation and compatibility contract

**Files:**
- Modify: `docs/插件开发指南.md`
- Modify: `docs/API文档.md`
- Modify: `docs/主题开发指南.md`
- Test: `backend/test/repo-hygiene.test.js` (only if documentation links/paths are already covered there)

**Interfaces:**
- Document the exact `ctx.registerEditorField`, `ctx.registerEditorAction`, and `ctx.registerEditorExtension` signatures.
- Document field namespace/storage, content-role policy, action operation whitelist, `toolbar`/`sidebar` slots, bridge events, `apiVersion: 1`, cleanup contract, and trusted-plugin model.
- Document `/admin/editor-extensions`, `/admin/editor-assets/:dir`, and `/admin/editor-actions/:plugin/:action`.
- Explicitly state that `theme.json.editorFields` remains theme-owned and `tri3_toc` is not migrated to a plugin.

- [ ] **Step 1: Add documentation examples**

Add one complete plugin example with `plugin.json`, `index.js`, an editor field, a toolbar action, and a self-contained sidebar module. Include activation/deactivation behavior and failure semantics.

- [ ] **Step 2: Add API and security reference**

Document request/response shapes, roles, CSRF requirements, operation limits, asset path rules, and that enabled plugins execute trusted server/admin code.

- [ ] **Step 3: Run link/text checks**

Run:

```bash
rg -n "registerEditorField|registerEditorAction|registerEditorExtension|editor-extensions|editor-assets|editor-actions|_lillPluginFields" docs/插件开发指南.md docs/API文档.md docs/主题开发指南.md
git diff --check
```

Expected: all required names and boundaries are present; no whitespace errors.

---

### Task 5: Full verification and handoff

**Files:**
- No product-file changes expected; inspect all modified files from Tasks 1-4.

- [ ] **Step 1: Run the full backend suite**

Run from `lill-v2/backend`:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test
```

Expected: zero failures. If an unrelated pre-existing test is flaky, record its exact name and output instead of weakening the assertion.

- [ ] **Step 2: Build the frontend**

Run from `lill-v2/frontend`:

```bash
PATH=/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm run build
```

Expected: Astro build completes successfully.

- [ ] **Step 3: Review the diff and boundaries**

Run:

```bash
git diff --check
git status --short
```

Inspect that no Trim3 files, theme editor-field spec/plan, generated assets, or unrelated user changes were modified.

- [ ] **Step 4: Report verification**

Report the exact test/build commands and results, list any skipped Playwright cases and why, and link the changed spec/plan. Do not deploy or claim the test site was updated as part of this plan.
