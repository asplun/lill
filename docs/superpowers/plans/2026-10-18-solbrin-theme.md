# Solbrin Lill Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete, installable Solbrin theme for Lill with real data, a themed settings page, an immersive article-selecting homepage, and the remaining Lill page templates.

**Architecture:** Add a self-contained theme under `frontend/themes/solbrin/`. Lill owns data and comment submission; the theme owns presentation, settings UI, media selection, and client-side filtering. A one-function backend extension maps configured navigation keys to public bootstrap candidates.

**Tech Stack:** Lill HTML template syntax, CSS, classic JavaScript, Node test runner, Playwright, ZIP packaging.

**Spec:** `docs/superpowers/specs/2026-10-18-solbrin-theme-design.md`

## Global Constraints

- Theme directory and manifest ID are `solbrin`; display name is `Solbrin`.
- Do not modify Lill core, the default theme, or TriM3.
- Use real `$posts`, `$post`, `$sidebar`, `$nav`, `$category`, `$tag`, `$keyword`, and `$groups` data.
- Use returned URLs; do not hardcode article, category, or tag permalinks.
- Keep title and description together as one stacked left-aligned copy block.
- Keep article capsules 320 x 40 px and the collapsed stack 56 px high.
- Hover only unfolds; click selects. Touch unfolds first, then selects.
- Keep the bounded scene palette separate from the footer and later page modules.
- Support both bright and dark media.
- Preserve the Lill `.lill-comment-form` submission contract.
- Use native browser APIs only; no new runtime dependency.
- Do not require a remote video or download reference-site media.

## Review Focus

- A theme installed without saved settings must still render a complete default homepage.
- A saved video that fails to load must fall back without breaking title, description, capsules, or navigation.
- Custom permalink routes must still be used for every article, category, tag, and pagination link.
- A bright image must produce dark text while a dark image produces light text, including selected article titles.
- Touch, keyboard, reduced motion, and an open sidebar must remain usable without overlapping controls.

---

### Task 1: Manifest, Navigation Extension, and Theme Settings Page

**Files:**
- Create: `frontend/themes/solbrin/theme.json`
- Create: `frontend/themes/solbrin/backend/index.mjs`
- Create: `frontend/themes/solbrin/settings.html`
- Create: `backend/test/solbrin-settings.test.js`

**Interfaces:**
- Consumes: Lill `extendBootstrap(view, { config })`; `view.nav` candidate entries.
- Produces: `$theme.extension.navigation` array used by `header.html`; settings keys listed in the spec.

- [ ] Add a manifest test for required keys, defaults, navigation type, and `settingsPage`.
- [ ] Run it and observe failure because the theme does not exist.
- [ ] Add `theme.json` with navigation, media, sidebar, article display, footer, and custom CSS settings.
- [ ] Add the navigation extension returning selected `view.nav` entries as `{ navigation }`.
- [ ] Add an authenticated settings page using `/admin/themes/solbrin/settings`, grouped controls, a hero preview, dirty-state protection, and save status.
- [ ] Re-run the manifest test and assert that the settings page references the manifest keys.

### Task 2: Shared Templates and Page Contracts

**Files:**
- Create: `frontend/themes/solbrin/header.html`
- Create: `frontend/themes/solbrin/footer.html`
- Create: `frontend/themes/solbrin/sidebar.html`
- Create: `frontend/themes/solbrin/comments.html`
- Create: `frontend/themes/solbrin/pagination.html`
- Create: `frontend/themes/solbrin/post-card.html`
- Create: `frontend/themes/solbrin/post.html`
- Create: `frontend/themes/solbrin/page.html`
- Create: `frontend/themes/solbrin/archive.html`
- Create: `frontend/themes/solbrin/category.html`
- Create: `frontend/themes/solbrin/tag.html`
- Create: `frontend/themes/solbrin/search.html`
- Create: `frontend/themes/solbrin/404.html`
- Create: `backend/test/solbrin-templates.test.js`

**Interfaces:**
- Consumes: Task 1 settings and navigation extension plus Lill bootstrap variables.
- Produces: `.sr-shell`, `.sr-main`, `.sr-post-card`, `.sr-sidebar`, `.sr-comments` contracts for CSS and JavaScript.

- [ ] Add a template-contract test that compiles every template with representative real-shaped scope data and asserts working article, category, pagination, comment, empty-state, and 404 links.
- [ ] Run it and observe failure because the templates do not exist.
- [ ] Add the shared shell with a narrow side rail, floating sidebar, search, theme switch, content slot, and footer.
- [ ] Add reusable article cards using `$post.url`, `$post.cover_image`, category and summary data.
- [ ] Add content templates for post, page, archive, category, tag, search, and 404 using actual Lill variables and `$page.url`.
- [ ] Add comment markup and the full `.lill-comment-form` contract.
- [ ] Re-run the template-contract test.

### Task 3: Homepage Composition

**Files:**
- Create: `frontend/themes/solbrin/index.html`
- Create: `frontend/themes/solbrin/style.css`

**Interfaces:**
- Consumes: `$site`, `$posts`, `$sidebar`, `$theme`, and `.sr-post-card` data.
- Produces: `.sr-scene`, `.sr-copy`, `.sr-deck`, `.sr-card-grid`, `[data-sr-*]` hooks for Task 4.

- [ ] Extend the template test with homepage assertions for a site title, complete copy group, up to three real capsule choices, direct card transition, and no redundant section headings.
- [ ] Run it and observe failure.
- [ ] Build the homepage with a bounded scene around hero and first article row; do not theme the page body or footer.
- [ ] Add responsive styles for the scene, long capsules, article cards, floating sidebar, content pages, forms, comments, and focus states.
- [ ] Check 320, 390, 844, 1024, 1440, and 1920 layouts for horizontal overflow and text containment.

### Task 4: Media, Selection, and Runtime Controls

**Files:**
- Create: `frontend/themes/solbrin/theme.js`
- Modify: `frontend/themes/solbrin/style.css`

**Interfaces:**
- Consumes: Task 3 hook attributes and Task 1 media settings rendered into the homepage.
- Produces: click, hover, keyboard, touch, sidebar, filtering, theme, reduced-motion, and surface-tone behavior.

- [ ] Add a browser test for selecting a real article, restoring the default scene, keyboard selection, touch unfolding, sidebar opening, filtering, and reduced motion.
- [ ] Run it and observe failure.
- [ ] Implement media source selection, poster fallback, video pause/resume, and fallback on load failure.
- [ ] Implement image/video lower-edge sampling and continuous scene-ground updates with light/dark text states.
- [ ] Implement pointer hover unfolding, click-only selection, interruptible transitions, touch two-step selection, keyboard controls, and restoration.
- [ ] Implement sidebar, mobile navigation, category filtering, mobile menu behavior, and comment reply/pagination support.
- [ ] Re-run the browser test with real assets and simulated video failure.

### Task 5: Assets, Integration Verification, and Package

**Files:**
- Create: `frontend/themes/solbrin/assets/home-mist.jpg`
- Create: `frontend/themes/solbrin/assets/home-landscape.jpg`
- Create: `frontend/themes/solbrin/assets/home-aurora.jpg`
- Create: `frontend/themes/solbrin/assets/avatar.png`
- Create: `backend/test/solbrin-integration.test.js`
- Create: `Solbrin.zip`

- [ ] Copy only approved local prototype assets into the theme.
- [ ] Add an integration test that installs the theme in a temporary Lill server, activates it, and checks home and article bootstrap data plus the themed settings API.
- [ ] Run all Solbrin tests, then the relevant existing theme tests.
- [ ] Use Playwright at desktop, mobile, short-screen, reduced-motion, and sidebar-open states; capture screenshots and inspect them visually.
- [ ] Package the theme with `theme.json` at the ZIP root and verify its file list.

