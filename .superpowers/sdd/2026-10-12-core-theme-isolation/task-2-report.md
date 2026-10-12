# Task 2 阶段性进度报告

## 当前状态

Task 2 尚未完成生产代码改动。当前分支 `codex/core-theme-isolation` 基于 Task 1 提交 `c1746e0`，工作树在开始本阶段时干净。

## 已完成审查

- 已读取 Task 2 唯一需求简报。
- 已确认 Task 1 的 `backend/lib/theme-runtime.js` 已提供 manifest 字段声明、`private: true` 过滤、类型归一化和扩展加载；`server.js` 已通过 `ctx.themeRuntime` 注入。
- 已确认 `backend/routes/public.js` 仍包含重复的主题配置合并/公开过滤逻辑、第三方私密字段白名单、旧 `tri3_comment_mail` cookie、`moments`/`moment_categories`/`music_playlists` 访问，以及大量主题菜单/banner/music 数据组装。
- 已确认默认核心 schema 不创建上述主题专用表，因此这些访问会在默认主题相关请求路径中形成启动后的 500 或静默空数据风险。
- 已确认 `backend/lib/settings.js` 和 `backend/lib/theme-options.js` 存在重复的 manifest/config 合并逻辑，需要收敛到通用 runtime/settings 能力探测。
- 已确认评论通用能力仍需要保留，生产核心只应写入和读取 `lill_commenter_mail`。

## 测试基线

使用 pinned Node：

```text
/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
```

已运行：

```text
cd backend && /Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test test/security-api.test.js test/install-auth.test.js test/slug.test.js
```

结果：9/9 通过。

尚未写入 Task 2 的 `bootstrap-theme-isolation.test.js`，因此尚未产生本 Task 要求的失败测试红灯证据。

## 主要风险与下一步

`public.js` 约 1,200 行，通用 bootstrap 与历史主题视图模型交织。后续会按 TDD 顺序先增加 fixture 主题和临时数据库测试，验证：默认主题无主题表仍返回 200、manifest 私密字段不公开、扩展失败不泄露堆栈、评论 cookie 只使用通用名称；再以最小改动移除 core 中的主题专用查询和重复私有键名单，并运行指定测试和完整 backend 回归。

隔离工作区缺少 `frontend/themes/trim3` 第三方目录；完整测试中的既有 trim3 失败会单独记录，不复制该主题文件。

## 实现与验证结果

已完成 Task 2 的核心实现：

- `public.js` 的 bootstrap 只构建核心站点、导航、文章、页面、分类、标签、评论、归档、分页和 sidebar 数据；不再查询主题专用表。
- 主题扩展通过 `extendBootstrap` 返回的数据统一放入 `theme.extension`，扩展异常只记录日志，不影响核心 bootstrap 的 200 响应。
- 主题配置合并和公开过滤统一复用 `theme-runtime` 的 manifest 声明；`private: true` 字段不进入公开 options/bootstrap。
- 移除核心中的第三方私密字段白名单、旧主题 commenter cookie 别名和旧主题 bot 字段别名。
- 通用 commenter cookie 仅使用 `lill_commenter_mail`。
- `settings.js` 和 `theme-options.js` 复用通用配置合并规则，同时保留内部旧通用 provider 配置的读取能力。
- 测试辅助服务支持临时 fixture 主题，不依赖真实第三方主题目录。

Task 2 失败测试红灯已确认，之后运行：

```text
node --check routes/public.js server.js lib/theme-runtime.js
node --test test/bootstrap-theme-isolation.test.js test/security-api.test.js test/install-auth.test.js test/slug.test.js
```

结果：13/13 通过。
