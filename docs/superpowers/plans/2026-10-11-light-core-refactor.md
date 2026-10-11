# lill 轻核心架构重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 在不改变现有 API、数据库、Astro 前端、主题和插件协议的前提下，把后台路由从单体文件拆成职责清晰的模块，并为后续轻核心服务层重构建立稳定边界。

**Architecture:** 保留当前 Node 原生 HTTP、SQLite 和 JSON envelope。第一阶段按资源拆分后台路由，使用唯一的 `routes/admin/index.js` 统一注册；第二阶段抽取已被多个模块使用的认证、内容归属、媒体和扩展服务；第三阶段只隔离可选能力，不删除功能或引入新的运行时依赖。

**Tech Stack:** Node.js >=22.5、内置 `node:test`、内置 `node:sqlite`、原生 HTTP、Astro 前端。

**Spec:** `docs/superpowers/specs/2026-10-11-light-core-refactor-design.md`

## Global Constraints

- 保留所有现有未提交改动，不使用 `git reset`、`git checkout` 或清理命令。
- 不打开、迁移或修改 `backend/data/lill.db` 和根目录 `data/`。
- 不连接测试站、线上服务器，不上传、不部署、不 push。
- 不新增运行时依赖，不切换 Node、SQLite、Astro 或原生 HTTP 技术栈。
- 保留所有现有 `/api/v1/*` 路径、HTTP 方法、状态码和 `{ code, message, data }` 响应结构。
- 保留当前公开内容隔离、实时账号认证、角色权限、资源归属、批量操作和 CSRF 行为。
- 保留默认主题、TriM3 第三方主题、Hello World 插件和主题/插件扩展协议。
- 每次移动代码后先运行失败/通过测试，再继续下一个模块；不得借重构机会修改业务行为。
- 使用 `/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` 执行测试和语法检查。

## Review Focus

- 路由拆分后同一路径不能被重复注册或覆盖，参数路由优先级必须保持不变。
- 新模块不能丢失旧的 CSRF、角色和资源归属检查；尤其是批量文章和媒体操作。
- `ctx` 中的运行时依赖必须保持兼容，插件 `ctx.route` 和主题扩展不能因后台注册入口变化而失效。
- 新鲜安装和已有数据库都必须能启动；不能把 `post_versions`、媒体字段等现有初始化修复移出启动路径。
- 可选服务未被请求时不能新增数据库查询、网络请求或文件扫描；默认主题和第三方主题的 bootstrap 数据结构必须不变。

## 文件边界

### 第一阶段：后台路由拆分

- Create: `backend/routes/admin/index.js`，后台路由唯一注册入口。
- Create: `backend/routes/admin/shared.js`，仅保存跨模块的后台辅助函数和依赖工厂。
- Create: `backend/routes/admin/content.js`，文章、独立页面、页面模板、最近文章、批量文章。
- Create: `backend/routes/admin/taxonomy.js`，分类和标签。
- Create: `backend/routes/admin/comments.js`，后台评论列表、导出、状态、回复、编辑、删除和批量状态。
- Create: `backend/routes/admin/media.js`，媒体上传、列表和删除。
- Create: `backend/routes/admin/users.js`，用户列表、创建、更新和删除。
- Create: `backend/routes/admin/settings.js`，站点选项、主题列表、激活和主题设置。
- Create: `backend/routes/admin/extensions.js`，主题文件、插件、插件菜单和小工具。
- Create: `backend/routes/admin/system.js`，日志、备份、统计、系统信息、健康、监控和单站点信息。
- Modify: `backend/server.js`，改为导入 `registerAdmin` from `routes/admin/index.js`。
- Delete only after verification: `backend/routes/admin.js`。

### 第二阶段：服务边界

- Create: `backend/services/auth-service.js`，当前数据库用户解析和角色辅助。
- Create: `backend/services/content-service.js`，内容归属、文章写入前校验和批量预校验。
- Create: `backend/services/media-service.js`，媒体权限筛选和物理文件操作。
- Create: `backend/services/extension-service.js`，主题/插件运行时的稳定适配函数。
- Modify: 第一阶段后台路由模块，逐步改为调用服务函数。
- Test: `backend/test/architecture.test.js`，边界和注册覆盖测试。

### 第三阶段：可选能力

- Modify only when concrete dependency boundary is demonstrated: `backend/lib/mail.js`, `backend/lib/security.js`, `backend/lib/image-hosting.js`, `backend/lib/feed.js` and extension loaders.
- Do not move or delete optional features merely to make the directory tree look cleaner.

## Task 1: 建立路由注册快照和共享边界

**Interfaces:**
- Consumes: current `backend/routes/admin.js` registration behavior and `createRouter()` metadata.
- Produces: `routes/admin/index.js`, `routes/admin/shared.js`, an ordered registration contract consumed by later tasks.

- [ ] **Step 1: Write failing architecture tests**

Create `backend/test/architecture.test.js` with these behaviors:

- importing the admin registration entry registers every current `/api/v1/admin/*` method/path exactly once;
- every registered management route has `auth: true`, a non-empty role list, and a stable pattern;
- parameter matches return the same params as before;
- the old module and new module cannot both be registered in the same router.

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run from `backend/`:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/architecture.test.js
```

Expected: the new admin entry is missing or does not yet expose the complete route set.

- [ ] **Step 3: Define the shared admin helper contract**

Create `routes/admin/shared.js` with a factory such as `createAdminHelpers(ctx, router)` that returns only helpers used by at least two modules: `route`, `activeThemeId`, `normalizePageTemplate`, `logAction`, `managesAll`, `canManagePost`, `validatePostWrite`, and the content-list helper. Keep policy assignment in one place and preserve current role matrix values.

Create `routes/admin/index.js` that calls the modules in the old registration order. It must not contain resource SQL or request handlers.

- [ ] **Step 4: Run the architecture test and the existing suite**

Run:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/architecture.test.js
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test
```

Expected: the architecture test passes; existing behavior remains green before the old file is removed.

## Task 2: Split content, taxonomy, comments, and media routes

**Interfaces:**
- Consumes: `createAdminHelpers(ctx, router)` and the ordered registration contract from Task 1.
- Produces: four independent `register(router, ctx, helpers)` modules with unchanged route paths and behavior.

- [ ] **Step 1: Add route parity tests before moving handlers**

Extend `architecture.test.js` with an exact list of the old content, taxonomy, comment, and media methods/paths. Assert that the new modules register that list once and no other module registers those paths.

Add HTTP assertions using `startApiServer()` for one allowed and one denied case per resource, including author/contributor ownership, mixed article batch rejection, editor comment moderation, and media list filtering.

- [ ] **Step 2: Run the focused tests and observe the parity failure**

Run:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/architecture.test.js test/authorization.test.js
```

Expected: the new module imports/route registrations are absent or incomplete.

- [ ] **Step 3: Move handlers without behavior changes**

Move route blocks from `admin.js` into `content.js`, `taxonomy.js`, `comments.js`, and `media.js`. Move only module-specific imports with each block. Shared helpers must come from `shared.js`; do not duplicate SQL or silently broaden permissions.

Keep the following behavior exactly: live principal lookup, contributor draft-only rules, author ownership, pre-validation of all batch IDs, editor-only comment management, media ownership filtering, and existing version/thumbnail schema initialization in `server.js`.

- [ ] **Step 4: Run focused and full tests**

Run the architecture, authorization, security, theme regression, and full backend suites. Expected: all pass with the same route count and no duplicate paths.

## Task 3: Split users, settings, extensions, and system routes

**Interfaces:**
- Consumes: route factory and shared helpers from Task 1; existing modules from Task 2.
- Produces: `users.js`, `settings.js`, `extensions.js`, and `system.js` registered through `admin/index.js`.

- [ ] **Step 1: Add parity tests for remaining management routes**

Pin all remaining old paths, including users, options, themes, theme files, plugins, plugin configuration/install, widgets, logs, backups, system endpoints, and site switching. Assert route count and method/path equality.

- [ ] **Step 2: Run the parity test and observe failure**

Run the architecture test. Expected: the new module set is incomplete.

- [ ] **Step 3: Move handlers by responsibility**

Move code without changing request or response behavior. Keep filesystem safety checks, backup path behavior, plugin activation hooks, active-theme scoping, and admin-only policies. `admin/index.js` only imports and calls `register`.

- [ ] **Step 4: Switch server registration and remove the monolith**

Change only the server import to `routes/admin/index.js`. Remove `routes/admin.js` after the old route set has been compared programmatically and all tests pass. Do not keep a compatibility wrapper that registers handlers a second time.

- [ ] **Step 5: Run full verification**

Run:

```bash
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test
for f in server.js routes/admin/index.js routes/admin/shared.js routes/admin/content.js routes/admin/taxonomy.js routes/admin/comments.js routes/admin/media.js routes/admin/users.js routes/admin/settings.js routes/admin/extensions.js routes/admin/system.js; do /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check "$f"; done
git diff --check
```

Expected: all tests pass and every split module parses successfully.

## Task 4: Extract only stable shared services

**Interfaces:**
- Consumes: split modules from Task 3.
- Produces: small service functions with explicit inputs and no route registration side effects.

- [ ] **Step 1: Add service-level failing tests**

Add unit tests for `auth-service`, `content-service`, and `media-service`: current active user resolution, ownership decisions, contributor publish rejection, atomic batch pre-validation, media owner filtering, and missing-media handling.

- [ ] **Step 2: Run focused tests and confirm they fail before extraction**

Run the new service tests. Expected: service modules/functions do not yet exist.

- [ ] **Step 3: Implement minimal services**

Extract only repeated logic with stable contracts. Services must receive `{ db, ... }` explicitly, must not import route modules, must not write HTTP responses, and must not depend on a global request object. Route handlers retain validation and response formatting.

- [ ] **Step 4: Migrate route modules incrementally**

Replace duplicated inline ownership and media logic with service calls. Preserve all SQL results and error status behavior. Do not extract one-off handlers or theme-specific logic.

- [ ] **Step 5: Run unit, HTTP, and full suites**

Expected: all service, security, authorization, theme/plugin, and full backend tests pass.

## Task 5: Document the lean-core boundary and finalize review

**Interfaces:**
- Consumes: verified split modules and services.
- Produces: updated API/developer documentation and an auditable final diff.

- [ ] **Step 1: Update documentation**

Update `docs/API文档.md`, `docs/插件开发指南.md`, and `README.md` with the new backend module boundaries. Explicitly state that API paths are unchanged, TriM3 is third-party, and optional services remain compatible extensions.

- [ ] **Step 2: Run full verification and inspect the diff**

Run the full suite, syntax checks, `git diff --check`, and a route parity script. Confirm that no database files, credentials, uploads, or unrelated user changes are staged or modified.

- [ ] **Step 3: Final review**

Review for duplicate registrations, circular imports, accidental behavior changes, extra dependencies, and server startup regressions. Record any deferred optional-module extraction rather than forcing it into the core refactor.

## Completion Criteria

- `backend/routes/admin.js` is removed only after all handlers are represented exactly once in `routes/admin/`.
- No individual admin route module contains unrelated resource handlers.
- `server.js` does not define product route handlers.
- Existing API paths, status codes, response envelopes, theme data and plugin hooks remain compatible.
- Full backend tests pass, including authorization, public isolation, default theme, TriM3, plugin and architecture tests.
- No live server, production database, untracked root data, or external GitHub state is touched.
