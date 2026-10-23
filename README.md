# lill 博客系统 v1.3.3

轻量、可扩展、前后端分离的博客系统。后端使用 Node.js 原生 `node:http` + `node:sqlite` 提供 REST API，前端使用 Astro 4 构建静态外壳，后台由原生 JavaScript 驱动。

[发布说明](docs/发布说明.md) · [更新日志](CHANGELOG.md) · [部署指南](docs/部署指南.md) · [API 文档](docs/API文档.md)

## 当前能力

- **内容写作**：Markdown 文章、独立页面、分类、标签、发布时间、置顶、单篇评论开关；独立页面支持父级层级与手动排序；文章支持主分类 + 附加分类、自定义字段（文本/数字/布尔，主题与插件的字段命名空间互相隔离），并带服务端自动草稿（停止输入 800ms 落库）与修订历史。摘要可自动生成或手填；自动模式遵循长度设置与 `<!--more-->`，HTML 摘要仅保留安全行内标签。
- **批量操作**：文章、页面、分类、标签、评论、附件、用户、插件、主题、小工具、日志、备份共 12 个列表页都支持多选批量（发布/转草稿/置顶/移动分类/启用/禁用/删除/恢复等），并逐条返回成功与跳过原因。
- **角色权限**：管理员、编辑、作者、投稿者、订阅者五种角色；后台菜单与默认入口按角色显示，接口独立检查权限。作者管理自己的内容，投稿者仅管理自己的草稿，订阅者无内容管理权限。
- **阅读与评论**：文章排序、分页、摘要、评论平铺/嵌套和分页设置接入公共读取；文章条数仅在主题显式保存覆盖值时优先使用主题配置。评论支持审核、回复、状态筛选、按文章筛选和批量操作。私密文章仅作者与管理员/编辑可读；密码文章由 `POST /api/v1/posts/:slug/unlock` 校验后下发 7 天 HttpOnly cookie，解锁前只返回解锁表单所需的最小视图模型。
- **永久链接**：文章、独立页面、分类、标签四组地址分别可配置，后台提供 Typecho 风格预设、自定义模板与实时预览（独立页面为 `page_pattern`）。文章可用 `{cid}` `{slug}` `{category}` `{year}` `{month}` `{day}`，分类与标签可用 `{mid}` `{slug}`，页面可用 `{slug}`；归档与搜索路径可改。`sitemap.xml`、`robots.txt` 与 RSS 由后端生成，列表、上下篇和 Feed 使用一致地址；Nginx 需将自定义路径回退到前台外壳。
- **主题与插件**：主题安装、切换、独立配置、声明式设置表单、主题自定义设置页和主题后端扩展；插件 ZIP 安装、启停、设置表单、路由、钩子和后台菜单。启用失败会回滚运行时注册；内置 Hello World 公告栏插件。
- **附件与备份**：附件上传、编辑（名称/缩略名/替代文本/描述）与原位替换，图片缩略图为引用原图的 SVG，并非压缩或裁剪图片。备份页可创建、列出、下载 SQLite 一致性快照与附件 ZIP（支持 WAL 数据），并对两者一键恢复：恢复数据库前自动生成安全快照，恢复附件包时拦截 zip-slip 与符号链接条目。另可导入 Typecho 导出的内容（默认 `dryRun` 预览，按原 ID 幂等，不覆盖已有内容）。
- **后台交互**：请求超时提示、失败重试、切页取消和浏览器本地草稿恢复；登录限流、接口角色校验，以及受保护写接口的 CSRF 请求头检查。

v1.3.2 补齐了 Typecho 1.3 对照清单里列出的全部差距：多分类、页面层级与排序、服务端草稿与修订、自定义字段、附件编辑替换、备份恢复以及 Typecho 导入，逐项状态见[功能对照与实现边界](docs/Typecho1.3功能对照.md)。

v1.3.3 新增插件自定义后台页，并明确插件后台路由必须显式鉴权的安全约定；后台成功写请求统一失效缓存，附宝塔八步部署教程，并兼容 Typecho 导入内容永久链接。

当前未默认注册 Service Worker，不承诺离线使用；多语言、CDN 和主题在线编辑器也不作为已完成能力。主题文件读写 API 已存在，界面流程需另行验证。

## 技术栈

| 层 | 技术 |
|---|------|
| 后端 | Node.js（`node:http` + `node:sqlite`） |
| 前台与后台 | Astro 4 静态外壳 + 原生 JavaScript |
| 数据库 | Node 内置 SQLite，无需外部数据库服务 |
| 部署 | Nginx / OpenResty + Node 进程管理（面板或 PM2） |

## 界面预览

以下截图使用演示数据，展示默认主题与独立后台；第三方主题自行控制前台样式。

**前台（默认主题）**

![前台首页](screenshots/front-home.png)

| 文章页 | 归档页 |
|:---:|:---:|
| ![文章页](screenshots/front-post.png) | ![归档页](screenshots/front-archive.png) |

**后台管理**（`/admin/`，与前台完全分离）

![后台控制台](screenshots/admin-dashboard.png)

| 文章管理 | 文章编辑器 |
|:---:|:---:|
| ![文章管理](screenshots/admin-posts.png) | ![文章编辑器](screenshots/admin-post-editor.png) |

| 外观 · 主题列表 | 外观 · 主题专属设置 |
|:---:|:---:|
| ![主题列表](screenshots/admin-themes.png) | ![主题设置](screenshots/admin-theme-settings.png) |

| 分类 | 标签 |
|:---:|:---:|
| ![分类](screenshots/admin-categories.png) | ![标签](screenshots/admin-tags.png) |

| 评论 | 附件 |
|:---:|:---:|
| ![评论](screenshots/admin-comments.png) | ![附件](screenshots/admin-media.png) |

| 用户 | 设置 |
|:---:|:---:|
| ![用户](screenshots/admin-users.png) | ![设置](screenshots/admin-settings.png) |

| 登录 | 日志 | 备份 |
|:---:|:---:|:---:|
| ![登录](screenshots/admin-login.png) | ![日志](screenshots/admin-logs.png) | ![备份](screenshots/admin-backup.png) |

| 插件管理 | 初次安装 |
|:---:|:---:|
| ![插件](screenshots/admin-plugins.png) | ![安装向导](screenshots/admin-install.png) |

| 手机后台 | 手机默认主题 |
|:---:|:---:|
| ![手机后台](screenshots/admin-mobile.png) | ![手机默认主题](screenshots/front-mobile.png) |

## 快速开始

### 环境要求

推荐 **Node.js 24 LTS**，最低 **22.13.0**，无需 `--experimental-sqlite`。生产环境使用 Nginx / OpenResty；附件备份需要系统 `zip` 命令，源码构建同步需要 `rsync`。

### 方式一：发布包部署

从 [GitHub Releases](https://github.com/asplun/lill/releases) 下载 `lill-v1.3.3.zip` 或 `lill-v1.3.3.tar.gz`。两者顶层目录均为 `lill/`，包含仓库跟踪的源码和直接位于 `frontend/` 的预构建静态文件，包内没有 `frontend/dist/`。

```bash
# 在空目录解压，勿覆盖运行中的站点
tar -xzf lill-v1.3.3.tar.gz
cd lill/backend
npm install --omit=dev
# 使用 pnpm 时改为：pnpm install --prod --frozen-lockfile
```

发布包无需安装前端依赖或执行 Astro 构建。仅附带 `themes/default`（含其后端扩展）和内置插件，不包含数据库、上传文件、依赖目录、密钥或第三方主题。

GitHub 自动生成的 `Source code` 归档是源码快照，需按下方源码流程安装依赖和构建。

### 方式二：源码部署

```bash
git clone https://github.com/asplun/lill.git
cd lill
git checkout v1.3.3
cd backend
npm install --omit=dev
# 后端也可使用：pnpm install --prod --frozen-lockfile
cd ../frontend
pnpm install --frozen-lockfile
pnpm run build
rsync -a --exclude='/themes/' dist/ ./
```

源码部署必须安装后端和前端两端依赖。构建后将 `dist/` 内容同步到 `frontend/`，保留原有 `themes/`，不要用构建副本覆盖主题后端扩展或已安装的第三方主题。

两种方式接下来均按[部署指南](docs/部署指南.md)设置固定 `JWT_SECRET`，启动 `backend/server.js`，并将 Nginx 的根目录指向 `frontend/`，代理 `/api/` 到后端。首次访问 `/admin/`，按向导填写站点地址和管理员账号。

### 生成发布包

维护者可在源码根目录使用[发布打包脚本](scripts/package-release.py)：

```bash
python3 scripts/package-release.py --ref v1.3.3 --output /tmp/lill-release
```

脚本从指定 Git 引用导出干净源码，仅构建默认主题，将静态产物合并到包内 `frontend/`，输出 ZIP、tar.gz 和 `SHA256SUMS`；运行脚本需要 Python 3、Node.js 和 pnpm，安装生成的发布包不需要构建。发布流程见[发布说明](docs/发布说明.md)。

## 目录结构

```
lill/
├── backend/           # Node.js 后端
│   ├── server.js      # 主服务
│   ├── ecosystem.config.cjs  # PM2 配置
│   ├── routes/        # 路由：public / auth / install，后台拆分在 routes/admin/
│   ├── lib/           # 核心库：认证、路由、主题、插件、安全…
│   ├── plugins/       # 插件目录（plugin.json + index.js）
│   ├── test/          # node:test 用例（架构/权限/安全/回归）
│   ├── data/          # 运行时数据库与备份，不随发布包分发
│   └── uploads/       # 运行时上传文件，不随发布包分发
├── frontend/          # Astro 前端
│   ├── src/           # 源码
│   ├── public/        # 静态资源
│   ├── themes/        # 主题目录
│   ├── index.html     # 发布包直接提供；源码需构建后同步
│   └── dist/          # 仅源码构建时产生，不进入发布包
├── scripts/           # 发布打包等维护工具
├── docs/              # 文档（部署/主题/插件/API）
├── CHANGELOG.md        # 更新日志
├── LICENSE            # MIT 许可证
└── README.md
```

## 文档

| 文档 | 内容 |
|---|---|
| [发布说明](docs/发布说明.md) | v1.3.3 变更、发布包与升级说明 |
| [更新日志](CHANGELOG.md) | 版本变更记录 |
| [部署指南](docs/部署指南.md) | 宝塔面板 / 1Panel 面板 / 裸机部署、升级维护、问题排查 |
| [主题开发指南](docs/主题开发指南.md) | 主题目录结构、`theme.json` 规范、模板标签、设置控件 |
| [主题后端扩展开发指南](docs/主题后端扩展开发指南.md) | `theme.json.backend.entry` 与扩展契约：私有接口、短代码、页面模板数据、小组件定义 |
| [API 文档](docs/API文档.md) | 公开 / 认证 / 安装 / 管理接口完整参考 |
| [插件开发指南](docs/插件开发指南.md) | 插件目录结构、`plugin.json` 规范、`ctx` API、系统钩子、打包安装 |
| [Typecho 1.3 功能对照](docs/Typecho1.3功能对照.md) | 已修复问题、功能差距与实现边界 |

## License

采用 [MIT 许可证](LICENSE)。
