# Security and Public Content Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unauthenticated destructive actions and private-content disclosure, and enforce current-user role and ownership checks across management APIs.

**Architecture:** Keep the existing Node HTTP server, router, SQLite database, and JSON envelope. Add isolated HTTP integration-test infrastructure, remove the anonymous reset route, apply one public-content policy to every public read path, and enforce admin API roles centrally with resource ownership checks at content operations. Use a temporary database per test process.

**Tech Stack:** Node.js >=22.5, built-in `node:test`, built-in `node:sqlite`, native HTTP.

**Spec:** `docs/superpowers/specs/2026-10-11-security-data-isolation-design.md`

## Global Constraints

- Do not add runtime dependencies.
- Preserve the `{ code, message, data }` API response envelope.
- Do not open, migrate, or modify `backend/data/lill.db` or the untracked root `data/` directory.
- Keep first-install status and installation available before the first administrator is created.
- Anonymous access to `/api/v1/install/reset` must return `404`; the route must not delete tables.
- Public content requires `status = 'published'` and `visibility = 'public'`; public responses must not serialize `password`.
- Use database-current user status and role for every authenticated request.
- Preserve existing uncommitted work; commit only files explicitly part of this plan if commits are requested by the execution workflow.

## Review Focus

- Anonymous destructive requests and spoofed forwarded-IP headers: test that reset is unavailable and no table/data changes.
- Explicit `status=draft` plus slug lookup: test that drafts never appear through any public API.
- Published private/password content and serialization: test that no content or password is returned.
- Stale JWT after disable/demotion: test that authorization follows the live database record.
- Nested resources and bulk operations: test ownership/role checks cannot be bypassed by alternate or batch routes.

## Files and Responsibilities

- Create `backend/test/helpers/api-server.js`: spawn the backend against a temporary DB and directories, wait for readiness, expose HTTP helpers, and guarantee process/temp-directory cleanup.
- Create `backend/test/security-api.test.js`: real HTTP regression tests for reset removal, public data isolation, authentication freshness, role policies, and ownership.
- Modify `backend/lib/router.js`: carry authorization policy metadata through route matching without changing path matching behavior.
- Modify `backend/server.js`: resolve active principals from SQLite, apply authentication/authorization before handlers, and map expired/disabled principals to `401`.
- Modify `backend/routes/install.js`: remove the destructive anonymous reset endpoint.
- Modify `backend/routes/admin.js`: declare route-role policies and enforce content ownership/status transitions and bulk-operation checks.
- Modify `backend/routes/public.js`: enforce the public visibility predicate and return explicit public fields across bootstrap and direct public endpoints.
- Modify `docs/API文档.md`: document management-role permissions and the removal of the reset route.

### Task 1: Isolated HTTP Test Harness and Reset Removal

**Interfaces:**
- `startApiServer()` returns `{ baseUrl, dbPath, request(method, path, options), stop() }`.
- `request` parses the existing JSON envelope and supports headers and JSON bodies.
- The harness launches `backend/server.js` with a temporary `DB_PATH`, `UPLOAD_DIR`, `THEMES_DIR`, `PLUGINS_DIR`, a fixed test-only `JWT_SECRET`, and an available local port.

- [ ] **Step 1: Write the failing test**

Create `backend/test/security-api.test.js` with a test named `anonymous reset endpoint is unavailable and leaves the database intact`. Start a clean server, install an administrator, attempt `POST /api/v1/install/reset` with `{ "confirm": "RESET" }`, assert HTTP `404`, then verify login still succeeds and the installed marker remains.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/security-api.test.js` from `backend/`.
Expected: the reset request currently succeeds or otherwise differs from `404`.

- [ ] **Step 3: Implement the minimal test harness and remove reset**

Create the child-process test helper with readiness polling and `finally` cleanup. Remove only the `/api/v1/install/reset` route and its now-unused imports/helpers from `backend/routes/install.js`.

- [ ] **Step 4: Run the focused test**

Run: `node --test test/security-api.test.js`.
Expected: reset returns `404`; the installed account remains usable; the child process exits and temporary files are removed.

### Task 2: Public Content Isolation

**Interfaces:**
- Public SQL predicates require both published status and public visibility.
- Public response objects are projections, not unrestricted `SELECT *` database rows.

- [ ] **Step 1: Add failing public API tests**

Add table-driven tests named `public list ignores requested non-published statuses`, `public detail hides draft/private/password posts`, and `bootstrap excludes private content and secret fields`. Seed a public published post, a draft, a published private post, and a published password-bearing post in the temporary database. Exercise `/api/v1/posts`, `/api/v1/posts/:slug`, `/api/v1/pages`, `/api/v1/site/bootstrap`, and `/api/v1/feed` where relevant. Assert only public published records are exposed and no response contains the `password` field/value.

- [ ] **Step 2: Run focused tests and confirm expected failures**

Run: `node --test test/security-api.test.js`.
Expected: explicit status and slug requests expose currently restricted records or fields.

- [ ] **Step 3: Implement shared public filtering and safe projections**

Update `backend/routes/public.js` so list helpers, bootstrap route resolution, direct list/detail endpoints, page listings, archive/feed data, and category/tag counts consistently exclude non-public records. Remove private fields from every public response shape. Do not add password-verification behavior.

- [ ] **Step 4: Run focused and existing tests**

Run: `node --test test/security-api.test.js test/*.test.js` from `backend/`.
Expected: new isolation tests and the existing suite pass.

### Task 3: Current-Account Authentication and Central Route Authorization

**Interfaces:**
- A matched route can express authentication-only access or an explicit allowed-role set.
- `authenticate(req)` returns the current active user loaded from SQLite; token claims do not grant stale role/status.
- Authorization failures use `401` for missing/invalid/expired/inactive accounts and `403` for authenticated users lacking permission.

- [ ] **Step 1: Add failing auth freshness and role tests**

Add tests named `inactive user token is rejected`, `role changes take effect for an existing token`, and `management routes enforce role matrix`. Use the installed admin to create editor, author, contributor, and subscriber accounts through the API; login each account; exercise representative read/write operations across content, categories/tags, comments, media, users, settings, themes, plugins, and backups. Assert allowed and denied status codes and ensure denied writes leave state unchanged.

- [ ] **Step 2: Run focused tests and confirm expected failures**

Run: `node --test test/security-api.test.js`.
Expected: authenticated non-admin users can currently reach admin-only endpoints, and stale JWT role/status remains effective.

- [ ] **Step 3: Add route policy metadata and current-user resolution**

Extend `backend/lib/router.js` to retain route patterns and allowed-role metadata. In `backend/server.js`, resolve each bearer token to an active database user before invoking protected handlers, enforce route roles before body parsing or side effects, and map invalid/expired/inactive credentials to `401`. Preserve public plugin routes while requiring policies for management routes.

- [ ] **Step 4: Apply role policy and ownership rules to admin routes**

In `backend/routes/admin.js`, classify every `/api/v1/admin/*` endpoint according to the approved role matrix. Restrict user/system/theme/plugin/backup/log management to administrators; permit editors to manage taxonomies, all comments, and all media; permit authors/contributors to upload and manage only their own media; enforce content ownership; prevent contributors from publishing; validate each item in bulk operations before mutation.

- [ ] **Step 5: Run focused tests and inspect route coverage**

Run: `node --test test/security-api.test.js`.
Expected: role and ownership cases return the specified status codes with no unauthorized state changes. Add an assertion that every registered `/api/v1/admin/` route has an explicit policy.

### Task 4: API Contract Documentation and Full Verification

- [ ] **Step 1: Update API documentation**

Update `docs/API文档.md` with the exact role matrix, `401`/`403` behavior, author/contributor ownership and publishing limits, public content visibility rules, and the fact that no install reset API exists.

- [ ] **Step 2: Run the full backend test suite**

Run: `node --test` from `backend/`.
Expected: all existing and new tests pass, with temporary test resources cleaned up.

- [ ] **Step 3: Run syntax and whitespace checks**

Run: `node --check server.js`, `node --check routes/admin.js`, `node --check routes/public.js`, `node --check lib/router.js`, `node --check routes/install.js`, and `git diff --check`.
Expected: all checks exit successfully.

- [ ] **Step 4: Review the final diff and remaining risk**

Confirm no database files, credentials, uploads, or unrelated worktree changes were staged or altered. Report any untested deployment assumptions separately; do not claim the live site was checked.
