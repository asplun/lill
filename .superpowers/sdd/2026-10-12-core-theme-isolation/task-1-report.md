# Task 1 报告

## 实现内容

- 新增通用主题运行时 `theme-runtime.js`，集中处理主题 manifest 扫描、默认配置合并、`checkbox`/`number` 类型归一化、未知键过滤和 `private: true` 字段公开过滤。
- 将主题后端扩展扫描与激活主题路由隔离迁移到 runtime；扩展路由在激活主题切换后立即按当前主题返回，非激活主题返回 404。
- `server.js` 使用 `THEMES_DIR` 加载 runtime，并将 `ctx.themeRuntime` 注入路由上下文；保留 `ctx.themeExt` 和 `theme-ext.js` 旧导出兼容方式。
- 启动只扫描实际存在的主题目录，默认主题没有 `backend/index.js` 时仍可正常加载。
- 主题目录注册扫描改为使用 `THEMES_DIR`，避免核心启动隐式依赖固定路径。
- 新增 runtime、路由隔离和核心边界测试，并在架构测试中验证 runtime 装配。
- 已确认 runtime 初始化位于 `server.listen()` 之前，并且 `themeRuntime.extensions` 被复用于 `ctx.themeExt` 和路由注册，无无用的后置变量。

## 修改文件

- `backend/lib/theme-runtime.js`
- `backend/lib/theme-ext.js`
- `backend/server.js`
- `backend/test/theme-runtime.test.js`
- `backend/test/core-theme-boundary.test.js`
- `backend/test/architecture.test.js`

未修改数据库、上传文件、`.backup/` 或主工作区未跟踪文件；未引入第三方主题文件。

## 测试命令和结果

- 失败测试（TDD 红灯）：
  - `cd backend && /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/theme-runtime.test.js test/core-theme-boundary.test.js`
  - 结果：按预期失败，runtime 模块尚不存在；边界测试随后单独通过。
- Task 1 指定测试：
  - `cd backend && /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/theme-runtime.test.js test/core-theme-boundary.test.js test/architecture.test.js`
  - 结果：15/15 通过。
- 完整 backend 回归：
  - `/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/*.test.js`
  - 结果：67 个测试中 51 通过、16 失败。
  - 16 个失败全部是隔离工作区缺少 `frontend/themes/trim3` 文件导致的 `ENOENT`，涉及既有 trim3 回归/模板测试；这些文件不在本 Task 允许修改范围内，也未从其他工作区复制。
- `npm test`
  - 结果：当前环境 `npm` 不在 PATH，命令无法执行；使用简报指定的 pinned Node 完成了测试。
- `git diff --check`
  - 结果：通过。

## 提交

提交 hash：`4d14073`（`refactor: add generic theme runtime boundary`）。

## 未解决问题

- 当前隔离工作区没有第三方 `trim3` 主题文件，因此完整 backend 回归中的 16 个 trim3 测试无法运行通过。核心边界、runtime 和架构测试均已通过。
- `backend/server.js` 的既有 public 路由仍通过兼容的 `ctx.themeExt` 访问扩展；`ctx.themeRuntime` 已完成注入，后续任务可继续把更多主题配置读取统一迁移到 runtime。
