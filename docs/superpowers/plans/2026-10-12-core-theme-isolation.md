# lill 核心与第三方主题隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 Node.js + SQLite + Astro 技术栈、现有核心 API 和用户数据的前提下，让 lill 核心只提供通用博客能力，trim3 作为可选第三方主题独立提供自己的业务、迁移、兼容 API 和测试。

**Architecture:** 先建立通用主题运行时契约和核心边界测试，再把公开 bootstrap 的主题特有数据、主题私有路由和第三方服务迁回主题包。核心通过 manifest、能力探测和扩展钩子工作，不通过主题名称判断；trim3 迁移期间保留兼容适配层，但适配层放在主题包内。部署、测试和文档最终按核心/主题两套边界运行。

**Tech Stack:** Node.js >=22.5、内置 `node:test`、内置 `node:sqlite`、原生 HTTP、SQLite、Astro 静态前端；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-12-core-theme-isolation-design.md`

## Global Constraints

- 保留现有 Node.js + SQLite + 原生 HTTP 后端和 Astro 前端，不切换技术栈。
- 保留现有通用 `/api/v1/*` API 的方法、路径、状态码和 `{ code, message, data }` 响应外壳。
- 不打开、迁移、覆盖或删除 `backend/data/lill.db`、根目录 `data/`、上传目录和用户备份；测试只能使用临时数据库。
- 保留现有文章、页面、分类、标签、评论、媒体、用户、认证、插件和主题切换功能。
- 不删除 trim3 功能；trim3 历史数据、设置和前台调用通过主题包内兼容层继续工作。
- 核心源码、核心测试和核心部署配置不得依赖具体第三方主题名称、主题私有字段白名单或主题私有表。
- 不使用“按主题名排除”的发布逻辑；主题部署必须使用显式主题清单或通用目录规则。
- 保留当前工作区所有已有改动；不修改、不添加、不提交 `.backup/`，也不覆盖用户未跟踪文件。
- 每项迁移先写失败测试，再实现最小改动；每个任务完成后运行针对性测试并单独提交。
- 未经用户明确要求，不连接测试站、线上服务器、不上传、不重启、不 push。
- 第三方主题目录当前受 `.gitignore` 排除；实施时不得把它误加入 lill 核心提交。独立 trim3 包统一暂存到工作区外的 `/Users/lilun/Desktop/zhuti/trim3-theme/`，并在提交前核对两个目录的 `git status`。
- 已存在但未跟踪的 `backend/test/trim3-theme-schema.test.js` 是工作区保留项：不读取、不修改、不移动、不删除、不提交；核心验证命令需明确排除它。

## Review Focus

- **没有第三方主题目录时核心仍能启动。** 测试核心运行时只加载默认主题和最小 fixture，不因为 trim3 缺失而失败；归 Task 1。核心静态边界测试只扫描生产源码，测试文件的第三方迁移在 Task 4 验证。
- **同一个主题扩展重复注册或切换后路由串用。** 测试每个扩展路由只注册一次、激活时可访问、切换后 404；归 Task 1。
- **私密主题设置泄露。** 测试 manifest `private: true` 字段不出现在 bootstrap/options/public，普通字段和默认值仍出现；归 Task 2。
- **扩展失败拖垮通用博客 API。** 测试主题 hook 抛错时核心仍返回文章/页面 bootstrap，并记录可识别错误；归 Task 2。
- **旧 trim3 数据和 API 被迁移破坏。** 使用临时数据库测试已有主题表/字段、旧配置和兼容接口，验证数据不覆盖且切换默认主题后私有接口隔离；归 Task 4。

## 文件边界

### 核心仓库新增/修改

- Create: `backend/lib/theme-runtime.js` — 通用主题 manifest、配置合并、私密字段过滤、扩展加载和激活范围适配。
- Modify: `backend/lib/theme-ext.js` — 作为兼容入口转发到通用运行时，保留现有 `loadThemeExtensions`、`registerThemeExtensions` 调用契约，避免一次性破坏插件/主题 API。
- Modify: `backend/routes/public.js` — 删除主题专用 bootstrap 构建和 trim3 命名；只保留通用 view model、通用 hook 调用和通用主题配置处理。
- Modify: `backend/lib/settings.js` — 改为通用主题设置服务，移除第三方主题语义命名和注释，保留 `settings.opt/switchOpt/option/siteUrl/siteName/adminMail` 兼容方法。
- Modify: `backend/lib/theme-options.js` — 改为通用 manifest/config 工具，保留 trim3 扩展需要的通用导出名，但不包含第三方注释或字段。
- Modify: `backend/lib/mail.js`, `backend/lib/security.js`, `backend/lib/image-hosting.js`, `backend/lib/feed.js`, `backend/lib/comment-util.js`, `backend/lib/http.js` — 仅移除主题专用实现依赖/命名；通用功能若仍被核心评论或插件使用则保留，否则通过主题扩展注入。
- Modify: `backend/server.js` — 注入通用主题运行时上下文和主题迁移生命周期，不直接初始化只属于第三方主题的能力。
- Modify: `backend/routes/admin/themes.js` — 激活主题时执行通用 manifest 校验和主题 migration，失败回滚 active 标记；设置接口按 manifest 的 `private`/类型声明处理。
- Modify: `backend/test/architecture.test.js` — 增加核心边界、扩展激活隔离、无第三方主题启动测试。
- Create: `backend/test/theme-runtime.test.js` — 通用运行时单测。
- Create: `backend/test/core-theme-boundary.test.js` — 核心源码/部署/测试不依赖第三方主题的静态边界测试。
- Modify: `backend/test/repo-hygiene.test.js` — 仅在现有测试职责内补充核心仓库卫生规则，不扫描用户备份。
- Modify: `deploy.sh`, `deploy/nginx.conf.example`, `docs/部署指南.md`, `docs/API文档.md`, `docs/插件开发指南.md`, `docs/主题后端扩展开发指南.md`, `README.md` — 用通用主题清单和主题协议替代具体主题名的核心部署说明。
- Move/Delete only after test parity: 已跟踪的 `backend/test/trim3-theme-regressions.test.js`、`backend/test/trim3-theme-templates.test.js` 复制到独立主题包并从核心移除；未跟踪的 `backend/test/trim3-theme-schema.test.js` 不作任何处理。

### 独立 trim3 主题包

- Create/Move outside core repository: `/Users/lilun/Desktop/zhuti/trim3-theme/`（独立主题包，不加入 lill 核心 `git add`）。
- Move/Modify: `/Users/lilun/Desktop/zhuti/trim3-theme/backend/` 中的 `index.js`、`routes.js`、`routes-ext.js`、`routes-compat.js`、`lib/*` — 承载 trim3 原有 API、视图数据、组件、缓存、第三方服务和兼容层。
- Move/Modify outside core: 核心当前由 trim3 使用的 `backend/lib/feed.js`、`backend/lib/image-hosting.js`，迁入独立主题包的 `backend/providers/`；核心不再无条件初始化它们。
- Create: `/Users/lilun/Desktop/zhuti/trim3-theme/backend/migrations/index.js` — 幂等检查/补齐 `moments`、`albums`、`music_playlists`、`links` 等主题私有结构，不删除旧数据。
- Create: `/Users/lilun/Desktop/zhuti/trim3-theme/tests/*` — trim3 schema、模板、接口、设置和前台回归测试。
- Modify: `/Users/lilun/Desktop/zhuti/trim3-theme/theme.json` — 声明扩展入口、协议版本和 `private` 设置字段；旧键映射由 trim3 自己兼容。

## Interfaces

### `backend/lib/theme-runtime.js`

提供以下通用函数：

- `readThemeManifest(themeId, themesDir) -> object|null`
- `normalizeThemeConfig(saved, manifest) -> object`
- `publicThemeConfig(config, manifest) -> object`
- `loadThemeExtensions(themesDir, logger?) -> Promise<Map<string, object>>`
- `resolveActiveThemeId(db) -> string`
- `registerThemeExtensions(router, ctx, extensions, activeId, notFound) -> void`
- `runActiveThemeHook(extensions, activeId, hookName, args, fallback?) -> Promise<unknown>`
- `runThemeMigrations(extension, context) -> Promise<void>`

`publicThemeConfig` 只能根据 manifest 字段的 `private` 属性过滤，核心不得维护某个主题专用的敏感键名单。`registerThemeExtensions` 继续保留当前主题激活范围检查。

### 主题扩展入口

扩展可以导出：

- `register(runtime)`：注册主题私有路由；
- `migrate(context)`：幂等初始化/升级主题私有结构；
- `extendBootstrap(view, context)`：返回主题扩展命名空间数据；
- `transformContent(html, info)`：正文输出转换；
- `pageTemplate(key, info)`：自定义模板数据；
- `decorateWidgets(rawList)`：主题自己的小组件定义和归一化。

现有 `register(router, ctx)`、`pageTemplate`、`transformContent`、`decorateWidgets` 在迁移期保留兼容；新能力通过 runtime 传入，不从主题扩展导入核心路由文件。

---

### Task 1: 建立通用主题运行时与核心边界测试

**Files:**
- Create: `backend/lib/theme-runtime.js`
- Modify: `backend/lib/theme-ext.js`
- Modify: `backend/server.js`
- Create: `backend/test/theme-runtime.test.js`
- Modify: `backend/test/architecture.test.js`
- Create: `backend/test/core-theme-boundary.test.js`

**Interfaces:**
- Consumes: 当前 `themes` 表、`frontend/themes/<id>/theme.json`、旧 `loadThemeExtensions/registerThemeExtensions` 调用方式。
- Produces: 上述 runtime 函数；`ctx.themeRuntime` 提供给 public/admin 路由；已有主题扩展路由保持激活范围隔离。

- [ ] **Step 1: 写失败测试**
  - 在 `theme-runtime.test.js` 测试 manifest 默认值合并、`checkbox`/`number` 类型规整、`private: true` 字段过滤。
  - 测试没有 `backend/index.js` 的默认主题能被加载为无扩展主题。
  - 测试 fixture A/B 的路由在 A 激活时只有 A 可访问，切换 B 后 A 返回 404、B 可访问。
  - 在 `core-theme-boundary.test.js` 检查核心生产源码（`backend/server.js`、`backend/routes/`、`backend/lib/`）、默认主题、`deploy.sh`、`deploy/nginx.conf.example` 不包含具体主题名或主题私有 API；不扫描用户未跟踪测试文件。

- [ ] **Step 2: 运行失败测试**
  - Run: `cd backend && /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/theme-runtime.test.js test/core-theme-boundary.test.js`
  - Expected: 新 runtime 导出不存在或边界断言失败；不修改现有数据库。

- [ ] **Step 3: 实现通用 runtime**
  - 将当前 `theme-ext.js` 的扫描和激活隔离迁移到 `theme-runtime.js`。
  - 将 manifest 配置合并、类型归一化和公开过滤集中到 runtime；兼容没有 `private` 声明的旧主题时只按 manifest 声明的可公开字段返回，不把未知密钥整体下发。
  - 在 `server.js` 建立 `ctx.themeRuntime`，保留 `ctx.themeExt` 兼容对象；启动时只加载存在的主题目录，不要求 trim3 存在。
  - `runThemeMigrations` 只在显式调用时执行，不在核心启动时扫描/初始化主题专用表。

- [ ] **Step 4: 运行通过测试和核心回归**
  - Run: `cd backend && .../node --test test/theme-runtime.test.js test/core-theme-boundary.test.js test/architecture.test.js`
  - Expected: runtime/边界/路由注册测试通过。

- [ ] **Step 5: 提交**
  - `git add backend/lib/theme-runtime.js backend/lib/theme-ext.js backend/server.js backend/test/theme-runtime.test.js backend/test/architecture.test.js backend/test/core-theme-boundary.test.js`
  - `git commit -m "refactor: add generic theme runtime boundary"`

### Task 2: 把公开 bootstrap 和主题设置改成能力探测

**Files:**
- Modify: `backend/routes/public.js`
- Modify: `backend/lib/settings.js`
- Modify: `backend/lib/theme-options.js`
- Modify: `backend/lib/comment-util.js`, `backend/lib/http.js`
- Modify: `backend/test/security-api.test.js`, `backend/test/repo-hygiene.test.js`
- Create: `backend/test/bootstrap-theme-isolation.test.js`

**Interfaces:**
- Consumes: Task 1 的 `ctx.themeRuntime`、`runActiveThemeHook` 和 manifest `private` 字段。
- Produces: 通用 bootstrap；主题特有数据只出现在 `theme.extension`（兼容期由主题扩展自行扁平化）；默认主题不访问主题专用表。

- [ ] **Step 1: 写失败测试**
  - 使用临时数据库启动 API，激活默认主题，调用 `/api/v1/site/bootstrap?type=index`，断言响应包含通用 `site/page/data/sidebar`，且不会因 `moments`、`music_playlists` 等表不存在而 500。
  - 使用 fixture 主题 manifest 声明一个普通字段和一个 `private: true` 字段，调用 `/api/v1/options/public` 和 bootstrap，断言私密字段不出现、普通字段和默认值出现。
  - 让 fixture `extendBootstrap` 抛错，断言通用 bootstrap 仍返回 200，扩展错误不泄露堆栈。
  - 测试 commenter cookie 只使用通用 `lill_commenter_mail`；旧别名兼容由 trim3 扩展测试，不在核心中保留第三方 cookie 名。

- [ ] **Step 2: 运行失败测试**
  - Run: `cd backend && .../node --test test/bootstrap-theme-isolation.test.js test/security-api.test.js`
  - Expected: 当前 bootstrap 读取主题专用逻辑，边界或字段过滤断言失败。

- [ ] **Step 3: 实现通用设置与 bootstrap**
  - 将 `buildThemeOptions/publicThemeConfig/themeBoolKeys` 的通用部分收敛到 runtime/settings；删除 `THEME_PRIVATE_KEYS` 常量和任何第三方菜单、横幅、音乐、说说、主题专用 Cookie 解析。
  - public bootstrap 只构建站点、导航、文章、页面、分类、标签、评论、归档、分页、sidebar 通用数据；通过 `extendBootstrap` 追加 `theme.extension`。
  - `pageTemplate` 仅接收主题声明的模板 key，不在 core 根据 key 名称查询主题专用表。
  - 保持默认主题已有字段契约（如 `theme.show_*`、`sidebar.*`）由默认主题 manifest/扩展声明提供，不在核心写 trim3 兼容字段。
  - 通用评论保留邮箱/QQ 头像、审核、防刷和邮件通知能力，但移除 TriM3 注释、Cookie 和历史函数名；旧兼容由 trim3 扩展处理。

- [ ] **Step 4: 运行测试**
  - Run: `cd backend && .../node --test test/bootstrap-theme-isolation.test.js test/security-api.test.js test/install-auth.test.js test/slug.test.js`
  - Expected: 核心 bootstrap、私密字段、评论安全和文章别名测试通过。

- [ ] **Step 5: 提交**
  - `git add backend/routes/public.js backend/lib/settings.js backend/lib/theme-options.js backend/lib/comment-util.js backend/lib/http.js backend/test/security-api.test.js backend/test/repo-hygiene.test.js backend/test/bootstrap-theme-isolation.test.js`
  - `git commit -m "refactor: make public bootstrap theme agnostic"`

### Task 3: 把通用可选服务与主题私有服务分离

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/lib/mail.js`, `backend/lib/security.js`
- Create/Modify: `backend/lib/providers.js` (仅在重复依赖确实存在时创建)
- Modify: `backend/routes/public.js`, `backend/routes/admin/*`
- Move/Modify outside core: trim3 主题的 `backend/routes-ext.js`, `routes-compat.js`, `lib/feed.js`、`lib/image-hosting.js` 适配调用
- Create: trim3 主题包的 `backend/providers/` 或等价目录
- Test: `backend/test/optional-services.test.js`、trim3 主题包对应 provider tests

**Interfaces:**
- Consumes: 核心通用评论/媒体接口和 Task 1 runtime 注入的 `context.core`。
- Produces: 核心只初始化请求路径确实使用的通用 mail/security/media provider；天气、诗词、音乐、主题图床等不在 server 启动时作为 core 服务初始化。

- [ ] **Step 1: 写失败测试**
  - 测试默认主题启动时不会创建 `api_cache`、不会读取主题专用设置，也不会因为外部天气/诗词不可达而阻塞。
  - 测试评论防刷、邮件通知和本地媒体上传仍使用通用接口；外部服务失败返回明确错误而不挂死请求。
  - 测试 fixture 主题可以通过 context 获取自己的 provider，不会污染默认主题路由。

- [ ] **Step 2: 运行失败测试**
  - Run: `cd backend && .../node --test test/optional-services.test.js test/security-api.test.js`
  - Expected: 当前 server 无条件初始化 feed/image host，测试发现主题专用缓存或 provider 依赖。

- [ ] **Step 3: 实现 provider 隔离**
  - 保留核心必需的邮件通知、评论安全和本地媒体能力，但改用通用配置读取；将主题特有远程服务及历史图床适配移动到 trim3 扩展目录。
  - 主题扩展在 `register(runtime)` 中按需取得 provider；任何联网请求必须有超时、缓存和降级，不能阻塞核心通用 API。
  - 删除核心 `server.js` 对 trim3 专用 provider 的无条件初始化；如果某 provider 仍被核心接口使用，给出明确的通用接口名和测试。

- [ ] **Step 4: 运行测试**
  - Run: `cd backend && .../node --test test/optional-services.test.js test/security-api.test.js test/authorization.test.js`
  - Expected: 通用评论/安全/邮件/媒体回归通过，默认主题无第三方服务依赖。

- [ ] **Step 5: 提交**
  - `git add backend/server.js backend/lib/mail.js backend/lib/security.js backend/routes/public.js backend/routes/admin trim3-theme`（只添加独立主题仓库/路径的允许文件，绝不添加 `.backup/`）
  - `git commit -m "refactor: isolate optional theme services"`

### Task 4: 将 trim3 业务、迁移和兼容测试归还主题包

**Files:**
- Move/Modify outside core: `/Users/lilun/Desktop/zhuti/trim3-theme/backend/index.js`
- Move/Modify outside core: `/Users/lilun/Desktop/zhuti/trim3-theme/backend/routes.js`
- Move/Modify outside core: `/Users/lilun/Desktop/zhuti/trim3-theme/backend/routes-ext.js`
- Move/Modify outside core: `/Users/lilun/Desktop/zhuti/trim3-theme/backend/routes-compat.js`
- Move/Modify outside core: `/Users/lilun/Desktop/zhuti/trim3-theme/backend/lib/*`
- Create: `/Users/lilun/Desktop/zhuti/trim3-theme/backend/migrations/index.js`
- Modify: `/Users/lilun/Desktop/zhuti/trim3-theme/theme.json`
- Move: 已跟踪的 `backend/test/trim3-theme-regressions.test.js`、`backend/test/trim3-theme-templates.test.js` to trim3 theme tests；保留未跟踪的 `backend/test/trim3-theme-schema.test.js` 原位不动
- Test: trim3 package test command

**Interfaces:**
- Consumes: Task 1/2/3 的主题扩展 runtime、通用 `context.core` 和旧数据库。
- Produces: trim3 主题独立负责其主题表、私有路由、视图数据、旧 API、主题设置映射和回归测试；切换默认主题后 trim3 私有接口返回 404。

- [ ] **Step 1: 写/调整失败测试**
  - 在 trim3 独立测试中保留现有 schema/template/regression 断言，并补充主题迁移重复执行不会覆盖已有 `moments` 内容。
  - 补充切换默认主题后 trim3 私有 API 404、切回 trim3 后兼容 API 恢复的 HTTP 测试。
  - 核心测试中删除对 `frontend/themes/trim3` 的直接读取，只保留 fixture 主题协议测试。

- [ ] **Step 2: 运行迁移前测试**
  - Run: `cd backend && .../node --test test/trim3-theme-regressions.test.js test/trim3-theme-templates.test.js`
  - 不读取、不执行、不修改未跟踪的 `backend/test/trim3-theme-schema.test.js`；它不属于本次迁移基线。
  - Expected: 先记录当前主题包测试基线；不能将失败归因于核心重构，必须保留失败输出。

- [ ] **Step 3: 实现主题包迁移**
  - 将 public.js 中现有 trim3 菜单、banner、导航、说说、音乐、页面模板、融合首页等逻辑逐段移入 trim3 的 `extendBootstrap/extendPageTemplate`。
  - 将核心 routes-ext/routes-compat 使用的接口、缓存和第三方请求改为从主题 runtime context 获取核心能力，不直接 import 核心内部路由。
  - 在主题 manifest 中声明 backend entry/protocol/private 设置；旧配置键和旧 API 只在 trim3 兼容层处理。
  - 主题迁移只 `CREATE TABLE IF NOT EXISTS` 或 `ALTER TABLE ADD COLUMN`，保留所有已有数据；迁移失败必须阻止激活并恢复上一个主题。

- [ ] **Step 4: 运行 trim3 和核心测试**
  - Run: `cd /Users/lilun/Desktop/zhuti/trim3-theme && /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test tests/*.test.js`。
  - Run core tests with `git ls-files 'backend/test/*.test.js' | grep -v 'trim3-theme-'` so the pre-existing untracked schema test is not touched or included。
  - Expected: trim3 自己的测试通过；核心测试不需要 trim3 目录仍全部通过。

- [ ] **Step 5: 提交边界变更**
  - 核心仓库只提交核心测试删除/替换和协议文档；trim3 文件在独立主题仓库单独提交。
  - Core commit: `git commit -m "refactor: return trim3 features to theme package"`
  - Theme commit: `git commit -m "refactor: own trim3 services and migrations in theme"`

### Task 5: 移除部署/文档/仓库卫生中的具体主题耦合

**Files:**
- Modify: `deploy.sh`
- Modify: `deploy/nginx.conf.example`
- Modify: `docs/部署指南.md`
- Modify: `docs/API文档.md`
- Modify: `docs/插件开发指南.md`
- Modify: `docs/主题后端扩展开发指南.md`
- Modify: `README.md`
- Modify: `backend/test/core-theme-boundary.test.js`, `backend/test/repo-hygiene.test.js`

**Interfaces:**
- Consumes: Task 1-4 的主题清单、runtime 协议、独立测试命令。
- Produces: 核心部署只同步核心与显式选择的主题；文档说明主题独立后端扩展、迁移、私密设置和前后端边界。

- [ ] **Step 1: 写失败边界测试**
  - 断言 `deploy.sh` 使用 `THEMES`/主题清单或通用目录，不出现 `--exclude` 某个具体主题的逻辑。
  - 断言 Nginx 示例不将 `/theme.js` alias 到任何具体主题目录。
  - 断言部署和主题文档写明“第三方主题独立安装/升级”，而不是把它当作核心内置功能。

- [ ] **Step 2: 运行失败测试**
  - Run: `cd backend && .../node --test test/core-theme-boundary.test.js test/repo-hygiene.test.js`
  - Expected: 当前脚本/文档中的具体主题判断使边界测试失败。

- [ ] **Step 3: 更新部署与文档**
  - 将部署脚本改为显式 `THEME_IDS`/发布清单同步；默认只同步 default，额外主题由安装器或独立包进入同一 themes 目录，不通过名称特判。
  - 保留 `/theme.js` 通用回源说明，删除具体主题 alias 示例。
  - 更新 API/主题/插件文档，明确核心 API 与主题私有 API 的差异、`register/extendBootstrap/migrate` 接口、manifest private 字段和回滚方式。

- [ ] **Step 4: 运行文档/仓库卫生测试**
  - Run: `cd backend && .../node --test test/core-theme-boundary.test.js test/repo-hygiene.test.js`
  - Expected: 核心边界和仓库卫生通过，`.backup/` 与用户临时文件未被纳入提交。

- [ ] **Step 5: 提交**
  - `git add deploy.sh deploy/nginx.conf.example docs README.md backend/test/core-theme-boundary.test.js backend/test/repo-hygiene.test.js`
  - `git commit -m "docs: make theme deployment boundaries explicit"`

### Task 6: 全量验证与独立主题安装验收

**Files:**
- Modify only if verification finds a real defect: relevant core/theme files.
- Do not touch: database files, uploads, `.backup/`, credentials, unrelated untracked files.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: 可审计的核心/主题双边界、全量测试结果、路由快照和全新克隆启动结果。

- [ ] **Step 1: 执行静态检查**
  - Run: `cd backend && for f in server.js lib/theme-runtime.js lib/theme-ext.js routes/public.js routes/admin/*.js; do .../node --check "$f"; done`
  - Run: `git diff --check`
  - Run: `git status --short --branch`
  - Expected: 无语法错误、无空白错误、未跟踪用户文件仍未被 add。

- [ ] **Step 2: 执行核心全量测试**
  - Run the tracked core suite explicitly: `git ls-files 'backend/test/*.test.js' | grep -v 'trim3-theme-' | while read -r f; do /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test "$f" || exit 1; done`。
  - 不执行未跟踪的 `backend/test/trim3-theme-schema.test.js`。
  - Expected: 核心测试全部通过，不需要 trim3 目录中的源码或测试。

- [ ] **Step 3: 执行主题独立测试**
  - Run: `cd /Users/lilun/Desktop/zhuti/trim3-theme && /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test tests/*.test.js`。
  - Expected: trim3 schema、模板、路由、兼容 API 和迁移测试全部通过。

- [ ] **Step 4: 做全新克隆/无第三方主题启动检查**
  - 在临时目录复制/打包核心仓库，不复制 trim3 目录；使用临时 `DB_PATH`、`UPLOAD_DIR`、`THEMES_DIR` 启动后端，调用安装状态、默认主题 bootstrap、文章列表和健康接口。
  - Expected: 默认主题能启动、安装、登录、发布/读取 Hello World；不创建主题专用表，不请求外部主题服务。

- [ ] **Step 5: 做主题切换/回滚检查**
  - 使用临时数据库安装 fixture 主题和 trim3 包，激活 fixture/trim3，验证扩展路由；模拟迁移失败，确认 active 标记恢复原主题。
  - Expected: 非激活主题私有路由 404，通用 API 始终可用，失败不破坏已有数据。

- [ ] **Step 6: 最终审计与提交**
  - Run: `git grep -n -i -E "trim3|TriM3|moments|albums|music_playlists|tri3_" -- backend/server.js backend/routes backend/lib deploy.sh deploy frontend/themes/default README.md`；结果不得出现在核心实现和部署逻辑。不要用未跟踪文件扫描覆盖既有工作区改动。
  - 不对 `backend/test/trim3-theme-schema.test.js` 执行 `git add`，也不为它创建、删除或移动替代文件。
  - Review `git diff --stat`, `git diff --name-only`, `git status --short`，确认没有数据库、上传、凭据和 `.backup/`。
  - Commit only verified core changes; do not push or deploy unless user later explicitly requests.

## Completion Criteria

- 核心实现不识别 trim3/TriM3，不读取其专用表，不维护其专用字段白名单，不注册其私有 API。
- 默认主题在不存在第三方主题时可独立运行，核心全量测试通过。
- trim3 自己拥有私有业务、迁移、兼容 API、设置映射和测试；切换默认主题后其私有接口不生效。
- 主题设置的私密字段由 manifest 声明控制，核心不泄露未知私密配置。
- 部署脚本和 Nginx 示例不按具体主题名特判，不 alias 到具体主题。
- 核心和主题均有独立、可重复的测试与升级路径。
- 不修改用户数据库、备份、上传文件或无关未跟踪改动。
  - 将复制到独立主题包的测试中的仓库根路径改为主题包路径，并把模板路径改为主题包内的主题目录后再执行。
