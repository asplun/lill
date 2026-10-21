# Theme Editor Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let themes declare safe per-post and per-page fields that the core editor renders, validates, stores, and exposes to the active theme.

**Architecture:** Add a pure theme-editor-fields module for schema normalization and namespaced JSON storage helpers. The active manifest supplies the schema through an authenticated admin API; content writes validate against it, and public content projects only the active theme's declared values as `theme_fields`. The Astro admin remains independent of themes and renders these declarations with its existing form and escaping conventions.

**Tech Stack:** Node.js native HTTP, SQLite JSON text column, Astro static admin, vanilla JavaScript, Node built-in test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-19-theme-editor-fields-design.md`

## Global Constraints

- Continue using Astro static admin + Node REST backend + SQLite.
- Reuse the existing `posts.fields` column; do not add a table or database migration.
- Preserve existing generic fields and values for inactive themes.
- Never execute theme-provided HTML or JavaScript in the admin.
- Do not modify trim3 or other existing third-party themes.
- Preserve all existing uncommitted changes; do not commit, push, or deploy.
- Write regression tests first and verify each failure before production changes.

## Review Focus

- Invalid or hostile manifest schema: reject malformed keys, unsupported types, duplicate keys, and invalid select options; keep the core editor usable. Test in `backend/test/theme-editor-fields.test.js` and the admin browser test.
- Wrong field value type or select choice: return 400 and leave both post and version rows unchanged. Test in `backend/test/content-write-integrity.test.js`.
- Theme switching or saving through an older client: retain generic fields and every theme namespace when current `themeFields` is omitted or only one theme is edited. Test in `backend/test/content-write-integrity.test.js`.
- Public data exposure: expose only the active theme's declared values and defaults, never stored values for inactive themes or undeclared keys. Test in `backend/test/bootstrap-theme-isolation.test.js`.
- Editor loading failure and user-controlled text: keep core writing controls usable, show a field-load warning, and render labels/values as text. Test in `backend/test/admin-ui.test.js`.

---

### Task 1: Theme Schema and Storage Helpers

**Files:**
- Create: `backend/lib/theme-editor-fields.js`
- Modify: `backend/lib/theme-runtime.js`
- Test: `backend/test/theme-editor-fields.test.js`
- Test: `backend/test/theme-runtime.test.js`

**Interfaces:**
- Produces `normalizeEditorFieldSchema(manifest, contentType) -> Field[]`; `contentType` is `post` or `page`. Each normalized field has `key`, `label`, `type`, `for`, `group`, `default`, `description`, and `options` when applicable.
- Produces `readThemeEditorFields(storedFields, themeId, schema) -> object`; input may be the existing JSON string or parsed object, and the result contains declared fields with stored values or normalized defaults.
- Produces `mergeThemeEditorFields(storedFields, themeId, submitted, schema) -> object`; validates submitted keys/types/options, updates only the named theme namespace, and preserves generic keys plus all other theme namespaces.
- `themeRuntime.editorFields(themeId, contentType) -> Field[]` reads the loaded manifest and delegates to the pure schema helper.

- [ ] **Step 1: Write failing unit tests**

Add tests for:
- Supported field types and `for` filtering, with omitted `for` applying to both content types.
- Rejection of duplicate/invalid keys, unsupported types, and empty or malformed `select` options.
- Checkbox, number, and select defaults being normalized and select defaults belonging to declared options.
- Reading JSON-string and object storage with defaults.
- Merging one theme's submitted fields without changing generic legacy data or another theme's values.
- Rejection of unknown submitted keys, invalid values, and non-object submissions.

- [ ] **Step 2: Run tests and confirm expected failures**

Run from `backend/`:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/theme-editor-fields.test.js test/theme-runtime.test.js
```

Expected: the new helper import or exports are missing; existing theme runtime tests remain green.

- [ ] **Step 3: Implement the pure schema and storage helpers**

Keep schema validation declarative and bounded to the spec's six field types. Treat stored values as data, never markup. Add `themeRuntime.editorFields(themeId, contentType)` without changing theme settings behavior.

- [ ] **Step 4: Re-run unit tests**

Run the same command. Expected: all new helper and existing runtime tests pass.

### Task 2: Admin API, Content Persistence, and Public Projection

**Files:**
- Modify: `backend/routes/admin/content.js`
- Modify: `backend/routes/admin/index.js`
- Modify: `backend/routes/admin/shared.js`
- Modify: `backend/routes/public.js`
- Modify: `backend/test/architecture.test.js`
- Modify: `backend/test/content-write-integrity.test.js`
- Modify: `backend/test/bootstrap-theme-isolation.test.js`

**Interfaces:**
- Adds authenticated `GET /api/v1/admin/editor-fields?type=post|page` returning `{ themeId, fields }`. Invalid or missing `type` returns 400. The route is available to the existing content roles.
- `GET /api/v1/admin/posts/:id` adds `themeFields` for the active theme while retaining the existing `fields` property.
- `POST /api/v1/admin/posts` and `PUT /api/v1/admin/posts/:id` accept optional `themeFields`; writes validate against the active theme schema and use Task 1's storage helper.
- Public content objects add `theme_fields`, containing only the active theme's declared fields plus defaults. Existing `fields` output is unchanged.

- [ ] **Step 1: Write failing API and integration tests**

Add tests proving:
- The schema route returns the active theme's fields filtered by post/page and has explicit content-role policy.
- Invalid content type queries return 400.
- Create/update persists `themeFields` in `_lillThemeFields`, and detail reads them back.
- Wrong types, unknown keys, invalid select options, and invalid objects return 400 without changing posts or versions.
- Omitting `themeFields` on update preserves it; updating one theme preserves generic and other-theme values.
- Public bootstrap and direct post reads expose the active theme's declared fields/defaults but not inactive-theme or undeclared values.

- [ ] **Step 2: Run tests and confirm expected failures**

Run from `backend/`:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/architecture.test.js test/content-write-integrity.test.js test/bootstrap-theme-isolation.test.js
```

Expected: new schema route and `themeFields`/`theme_fields` behavior fail; unrelated existing cases pass.

- [ ] **Step 3: Implement the authenticated schema route and route policy**

Register the endpoint once through the existing admin route composition. Give it the same content-role access as article/page editing, not theme-management access.

- [ ] **Step 4: Implement safe content read/write integration**

Validate provided `themeFields` before creating versions or writing posts. Merge only into `_lillThemeFields[activeThemeId]`; retain existing generic `fields` semantics while always preserving stored theme namespaces.

- [ ] **Step 5: Project active theme values into public content**

Add `theme_fields` to bootstrap detail/list content and direct public content responses. Return only keys in the active schema, with normalized defaults; leave `fields` untouched for compatibility.

- [ ] **Step 6: Re-run backend integration tests**

Run the same command. Expected: new API, compatibility, isolation, and architecture assertions pass.

### Task 3: Core Editor UI, Documentation, and Full Verification

**Files:**
- Modify: `frontend/public/admin/app.js`
- Modify: `frontend/public/admin/admin.css`
- Modify: `backend/test/admin-editor.test.js`
- Modify: `backend/test/admin-ui.test.js`
- Modify: `docs/主题开发指南.md`
- Modify: `docs/API文档.md`

**Interfaces:**
- The editor requests `/admin/editor-fields?type=<contentType>` alongside its existing independent prerequisites.
- It renders only the returned schema, reads values from `post.themeFields`, uses normalized defaults for new records, and submits current controls as `themeFields`.
- If schema loading fails, the core editor remains usable and displays a non-blocking warning.
- Theme authors read values using `{$post.theme_fields.<key>}` for both articles and pages.

- [x] **Step 1: Write failing editor tests**

Add unit tests for schema filtering/rendering, stored/default values, serialized `themeFields` in create/update payloads, safe escaping of labels/descriptions/values, and non-blocking schema request failure. Add a Playwright case that creates a post and page, verifies only matching fields appear, saves/reopens values, and checks that malicious-looking labels/values render as text.

- [x] **Step 2: Run focused tests and confirm expected failures**

Run from the repository root:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test backend/test/admin-editor.test.js
```

Run the new browser case using the repository's documented `LILL_UI_PLAYWRIGHT` and optional `LILL_UI_CHROME` environment variables. Expected: the current editor has no theme field controls.

- [x] **Step 3: Implement editor rendering, load, and save behavior**

Render only schema-generated controls with escaped text and stable IDs. Keep theme controls in a separate sidebar section, collect typed values, and retain the core editor if the schema request fails.

- [x] **Step 4: Add focused styling and author documentation**

Style the theme field group using current admin form tokens. Document the manifest schema, types, storage behavior, and template access in the theme guide; document the schema and content API properties in the API guide.

- [x] **Step 5: Run focused editor and browser regression tests**

Run:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test backend/test/admin-editor.test.js
LILL_UI_PLAYWRIGHT=/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs LILL_UI_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test backend/test/admin-ui.test.js
```

Expected: all existing and new editor/browser cases pass.

- [x] **Step 6: Run full verification**

Run from `backend/`:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test
```

Run from `frontend/`:

```bash
PATH=/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH pnpm run build
```

Also run `git diff --check`. Expected: zero test failures, successful Astro build, and no whitespace errors. Do not commit, push, or deploy as part of this plan.
