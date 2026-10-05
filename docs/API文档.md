# lill API 文档

> 版本：v2.0.0 ｜ 后端：Node.js 原生 HTTP + SQLite ｜ 前端：Astro 静态站点
>
> 前后端分离：后端只暴露 `/api/*`，前端静态文件由 Nginx 直接服务。

---

## 目录

- [1. 通用约定](#1-通用约定)
- [2. 公开 API（无需登录）](#2-公开-api无需登录)
- [3. 认证 API](#3-认证-api)
- [4. 安装 API](#4-安装-api)
- [5. 管理 API（需登录）](#5-管理-api需登录)
- [6. 错误码](#6-错误码)
- [7. 主题开发相关](#7-主题开发相关)

---

## 1. 通用约定

### 1.1 Base URL

```
https://your-domain.com/api/v1
```

本地开发默认后端端口：`http://localhost:3000/api/v1`

### 1.2 统一响应格式

**成功：**

```json
{
  "code": 0,
  "message": "ok",
  "data": { }
}
```

**失败：**

```json
{
  "code": 1,
  "message": "错误描述",
  "data": null
}
```

> 所有接口都包在 `{ code, message, data }` 里，前端取数据统一用 `res.data`。

### 1.3 认证方式

管理类接口需要在请求头携带 JWT：

```
Authorization: Bearer <token>
```

token 通过 [`POST /auth/login`](#31-登录) 或 [`POST /install`](#42-执行安装) 获取，默认有效期见后端配置。

### 1.4 分页格式

列表类接口统一返回：

```json
{
  "items": [],
  "meta": {
    "total": 100,
    "page": 1,
    "pageSize": 10,
    "totalPages": 10,
    "hasNext": true,
    "hasPrev": false
  }
}
```

通用查询参数：`page`（默认 1）、`pageSize`（默认 10~50）。

### 1.5 时间格式

所有时间字段为 `YYYY-MM-DD HH:MM:SS`（UTC）或 ISO 8601 字符串。

---

## 2. 公开 API（无需登录）

### 2.1 文章列表

```
GET /api/v1/posts
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `page` | int | 1 | 页码 |
| `pageSize` | int | 10 | 每页数量 |
| `status` | string | `published` | 文章状态 |
| `type` | string | `post` | `post` 文章 / `page` 独立页面 |
| `categoryId` | string | - | 按分类 ID 过滤 |
| `categorySlug` | string | - | 按分类别名过滤 |
| `tag` | string | - | 按标签别名过滤 |
| `keyword` | string | - | 标题/摘要关键词搜索 |
| `full` | `0`/`1` | 0 | 是否返回 `html_content` 全文 |

**示例：**

```bash
curl "https://your-domain.com/api/v1/posts?page=1&pageSize=10&categorySlug=tech"
```

**响应 `data`：**

```json
{
  "items": [
    {
      "id": "pmusfm3c1ffc9372b870d",
      "title": "Hello World",
      "slug": "hello-world",
      "excerpt": "欢迎使用 lill……",
      "cover_image": null,
      "view_count": 12,
      "sticky": 0,
      "published_at": "2026-10-05 10:00:00",
      "author_nickname": "管理员",
      "category_name": "未分类",
      "category_slug": "uncategorized",
      "url": "https://your-domain.com/archives/pmusfm3c1ffc9372b870d/",
      "route": "/post/hello-world"
    }
  ],
  "meta": { "total": 1, "page": 1, "pageSize": 10, "totalPages": 1, "hasNext": false, "hasPrev": false }
}
```

> `url` 是按「永久链接」设置生成的正式地址；`route` 是 Astro 静态页路由，主题可直接用。

### 2.2 文章详情

```
GET /api/v1/posts/:slug
```

按 `slug` 获取文章，返回内容含 `tags`、`prev`、`next`，并自动累加 `view_count`。

**响应 `data`（节选）：**

```json
{
  "id": "pmusfm3c1ffc9372b870d",
  "title": "Hello World",
  "slug": "hello-world",
  "content": "Markdown 原文",
  "html_content": "<p>渲染后的 HTML</p>",
  "view_count": 13,
  "author_nickname": "管理员",
  "category_name": "未分类",
  "tags": [{ "name": "公告", "slug": "notice" }],
  "prev": { "title": "上一篇", "slug": "prev-post" },
  "next": { "title": "下一篇", "slug": "next-post" },
  "url": "https://your-domain.com/archives/pmusfm3c1ffc9372b870d/",
  "route": "/post/hello-world"
}
```

### 2.3 独立页面列表

```
GET /api/v1/pages
```

返回所有已发布的独立页面（用于导航菜单）。

```json
[{ "id": "p1", "title": "关于", "slug": "about", "excerpt": "……", "created_at": "2026-10-05 10:00:00" }]
```

### 2.4 归档（按年月分组）

```
GET /api/v1/archives
```

```json
[{ "ym": "2026-10", "count": 5 }]
```

### 2.5 分类列表

```
GET /api/v1/categories
```

```json
[
  {
    "id": "c1", "name": "技术", "slug": "tech", "description": null,
    "parent_id": null, "sort_order": 0, "post_count": 5,
    "url": "https://your-domain.com/category/tech/",
    "route": "/category/tech"
  }
]
```

### 2.6 标签列表

```
GET /api/v1/tags
```

```json
[{ "id": "t1", "name": "JavaScript", "slug": "javascript", "post_count": 3, "url": "…", "route": "/tag/javascript" }]
```

### 2.7 最新评论（侧边栏 Widget）

```
GET /api/v1/comments/recent?limit=5
```

```json
[
  {
    "id": "cm1", "content": "写得很好", "created_at": "2026-10-05 10:00:00",
    "author_name": "访客", "post_id": "p1", "post_title": "Hello World",
    "post_slug": "hello-world", "nickname": null, "avatar": null,
    "post_url": "/post/hello-world", "post_route": "/post/hello-world"
  }
]
```

### 2.8 某文章的评论列表

```
GET /api/v1/comments?postId=<postId>&page=1&pageSize=20
```

只返回 `approved` 状态的顶级评论，每条评论带 `replies` 子数组（楼中楼）。

```json
{
  "items": [
    { "id": "cm1", "content": "不错", "author_name": "访客", "replies": [] }
  ],
  "meta": { "total": 1, "page": 1, "pageSize": 20, "totalPages": 1, "hasNext": false, "hasPrev": false }
}
```

### 2.9 发表评论

```
POST /api/v1/comments
Content-Type: application/json
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `postId` | ✅ | 文章 ID |
| `content` | ✅ | 评论内容，最长 2000 字 |
| `parentId` | - | 父评论 ID（回复） |
| `authorName` | - | 昵称，最长 50 |
| `authorEmail` | - | 邮箱（需合法） |
| `authorUrl` | - | 网站（需合法 URL） |

**响应（201）：**

```json
{ "id": "cm2", "status": "pending" }
```

> 是否需审核由后台「评论设置 → 评论审核」控制。开启时 `status` 为 `pending`。

### 2.10 站点公开配置

```
GET /api/v1/options/public
```

返回所有 `autoload = 1` 的站点配置，并合并当前主题的默认值与已保存值：

```json
{
  "site_name": "我的 lill 博客",
  "site_description": "记录技术与生活",
  "site_url": "https://your-domain.com",
  "permalink": "/archives/{cid}/",
  "active_theme": "default",
  "theme_config": { "show_sidebar": "1", "accent_color": "#4f46e5" },
  "theme_meta": { "name": "默认主题", "version": "1.1.0", "author": "lill" }
}
```

> **主题开发者注意**：前台只需读这一个接口即可拿到站点信息 + 主题设置，无需再单独请求主题设置接口。

### 2.11 RSS Feed

```
GET /api/v1/feed
```

返回 `application/rss+xml`，非 JSON 包装。默认输出最新 20 篇已发布文章。

---

## 3. 认证 API

### 3.1 登录

```
POST /api/v1/auth/login
Content-Type: application/json

{ "username": "admin", "password": "admin123" }
```

`username` 字段也接受邮箱。

**成功响应：**

```json
{
  "token": "eyJhbGciOi...",
  "user": { "id": "u1", "username": "admin", "nickname": "管理员", "email": "a@b.com", "role": "admin" }
}
```

**失败：** `401`，并在 `message` 中提示剩余尝试次数。同一 IP 连续失败会被锁定 15 分钟（返回 `429`）。

### 3.2 当前用户

```
GET /api/v1/auth/me
Authorization: Bearer <token>
```

```json
{ "id": "u1", "username": "admin", "nickname": "管理员", "email": "a@b.com", "avatar": null, "bio": null, "role": "admin" }
```

### 3.3 更新个人资料

```
PUT /api/v1/auth/profile
Authorization: Bearer <token>
```

可传字段：`nickname`、`email`、`avatar`、`bio`、`password`（至少 6 位）。返回更新后的用户信息。

### 3.4 注册（受后台开关控制）

```
POST /api/v1/auth/register
Content-Type: application/json

{ "username": "newuser", "password": "secret123", "email": "new@example.com" }
```

> 仅当后台「设置 → 阅读/基本 → 允许注册」为 `true` 时可用，否则返回 `403`。注册用户角色为 `subscriber`。

---

## 4. 安装 API

### 4.1 安装状态

```
GET /api/v1/install/status
```

无需登录，前端安装向导用于判断是否已安装 + 环境检查。

```json
{
  "installed": false,
  "checks": [
    { "name": "Node.js 版本", "pass": true, "detail": "v24.19.0" },
    { "name": "SQLite 支持", "pass": true, "detail": "3.53.3" },
    { "name": "数据目录权限", "pass": true, "detail": "可写" },
    { "name": "数据库连接", "pass": true, "detail": "正常" }
  ]
}
```

> `installed` 判定规则：`options.installed === 'true'` **或** 已存在任意用户（兼容旧站点）。

### 4.2 执行安装

```
POST /api/v1/install
Content-Type: application/json
```

| 字段 | 必填 | 约束 |
|---|---|---|
| `site_name` | ✅ | 最长 60 |
| `site_description` | - | 最长 200 |
| `site_url` | - | 需以 `http://` 或 `https://` 开头 |
| `admin_username` | ✅ | 3-30 位，仅字母/数字/下划线/短横线 |
| `admin_password` | ✅ | 至少 6 位 |
| `admin_email` | ✅ | 合法邮箱 |

**成功响应：**

```json
{
  "installed": true,
  "token": "eyJhbGciOi...",
  "user": { "id": "u1", "username": "admin", "nickname": "admin", "email": "a@b.com", "role": "admin" }
}
```

**行为说明：**

- 事务化执行，失败自动回滚
- 创建：管理员账号、站点配置、默认分类「未分类」、默认主题、Hello World 文章
- 已安装时返回 `403`；同一 IP 每分钟最多 10 次尝试（超出返回 `429`）

---

## 5. 管理 API（需登录）

> 以下接口均需请求头 `Authorization: Bearer <token>`。

### 5.1 文章 / 页面

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/posts` | 文章列表（分页） |
| GET | `/admin/pages` | 独立页面列表 |
| POST | `/admin/posts` | 新建文章/页面 |
| GET | `/admin/posts/:id` | 文章详情（含标签） |
| PUT | `/admin/posts/:id` | 更新文章 |
| DELETE | `/admin/posts/:id` | 删除文章 |
| POST | `/admin/posts/batch` | 批量操作 |

**新建 / 更新字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 标题（必填，最长 200） |
| `slug` | string | 别名，留空自动生成 |
| `content` | string | Markdown 原文（最长 50000） |
| `excerpt` | string | 摘要，留空自动截取 |
| `coverImage` | string | 封面图 URL |
| `type` | string | `post` / `page` |
| `status` | string | `draft` / `published` |
| `sticky` | bool | 是否置顶 |
| `order` | int | 页面排序 |
| `publishedAt` | string | 发布时间，发布时留空自动填充 |
| `categoryId` | string | 分类 ID |
| `tagNames` | string[] | 标签名数组（自动创建不存在的标签） |
| `fields` | object | 自定义字段（主题可扩展） |

**批量操作：**

```json
POST /admin/posts/batch
{ "ids": ["p1", "p2"], "action": "publish" }
```

`action` 取值：`publish` / `draft` / `delete`。

### 5.2 分类

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/categories` | 分类列表（含 `post_count`、`parent_name`） |
| POST | `/admin/categories` | 新建分类 |
| PUT | `/admin/categories/:id` | 更新分类 |
| DELETE | `/admin/categories/:id` | 删除分类（该分类下文章转为未分类） |

**字段：** `name`（必填）、`slug`、`description`、`parentId`、`sortOrder`。

### 5.3 标签

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/tags` | 标签列表（分页，含 `post_count`） |
| POST | `/admin/tags` | 新建标签 |
| PUT | `/admin/tags/:id` | 更新标签 |
| DELETE | `/admin/tags/:id` | 删除标签 |

### 5.4 评论

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/comments` | 评论列表，支持 `status`、`postId` 过滤 |
| PATCH | `/admin/comments/:id/status` | 修改单条状态 |
| PUT | `/admin/comments/:id` | 编辑评论内容 |
| DELETE | `/admin/comments/:id` | 删除评论 |
| POST | `/admin/comments/:id/reply` | 管理员回复（自动 approved） |
| PATCH | `/admin/comments/batch-status` | 批量改状态 |

**状态值：** `approved`（已通过）/ `pending`（待审核）/ `spam`（垃圾）/ `trash`（回收站）

```json
PATCH /admin/comments/batch-status
{ "ids": ["cm1", "cm2"], "status": "approved" }
```

### 5.5 媒体文件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/media` | 文件列表（分页） |
| POST | `/admin/media/upload` | 上传文件（Base64） |
| DELETE | `/admin/media/:id` | 删除文件（同时删除物理文件） |

**上传格式：**

```json
POST /admin/media/upload
{ "name": "photo.png", "data": "iVBORw0KGgo...", "mime": "image/png", "alt": "描述" }
```

允许扩展名：`.jpg .jpeg .png .gif .webp .svg .pdf .txt .md .zip`
返回 `url` 形如 `/uploads/xxxx.png`，可直接用于文章封面或正文。

### 5.6 用户

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/users` | 用户列表（分页，含 `post_count`） |
| POST | `/admin/users` | 新建用户 |
| PUT | `/admin/users/:id` | 更新用户 |
| DELETE | `/admin/users/:id` | 删除用户 |

**字段：** `username`（必填）、`email`（必填）、`password`、`nickname`、`role`、`status`、`avatar`、`bio`。

**角色：** `admin`（管理员）/ `editor`（编辑）/ `author`（作者）/ `contributor`（贡献者）/ `subscriber`（订阅者）

> `contributor` 只能编辑/删除自己的文章。

### 5.7 站点设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/options` | 获取全部配置项 |
| PUT | `/admin/options` | 批量更新配置 |

**更新格式（数组）：**

```json
PUT /admin/options
[
  { "key": "site_name", "value": "我的博客", "autoload": true },
  { "key": "posts_per_page", "value": "10" }
]
```

### 5.8 主题

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/themes` | 主题列表（含 `hasSettings`、清单同步后的名称/版本/作者） |
| POST | `/admin/themes/:themeId/activate` | 启用主题 |
| GET | `/admin/themes/:themeId/settings` | 获取主题设置结构 + 当前值 |
| PUT | `/admin/themes/:themeId/settings` | 保存主题设置 |

**获取主题设置响应：**

```json
{
  "theme": { "theme_id": "default", "name": "默认主题", "version": "1.1.0", "active": 1, "config": "{}" },
  "schema": [
    { "key": "accent_color", "label": "主题色", "type": "color", "default": "#4f46e5" },
    { "key": "show_sidebar", "label": "显示侧边栏", "type": "switch", "default": true }
  ],
  "values": { "accent_color": "#4f46e5" }
}
```

> `schema` 来自主题目录下的 `theme.json` 的 `settings` 字段，详见 [主题开发指南](./主题开发指南.md)。

**保存主题设置：**

```json
PUT /admin/themes/default/settings
{ "accent_color": "#ae1986", "show_sidebar": true }
```

### 5.9 统计 / 日志 / 备份

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/stats/dashboard` | 控制台概览数据 |
| GET | `/admin/stats/system` | 系统信息（版本、运行时间、各表数量） |
| GET | `/admin/posts/recent` | 最近文章 |
| GET | `/admin/comments/recent` | 最近评论 |
| GET | `/admin/logs` | 操作日志（分页） |
| POST | `/admin/backup` | 备份数据库（复制 `data/lill.db`） |

**控制台概览响应：**

```json
{
  "overview": {
    "postCount": 2, "pageCount": 0, "commentCount": 2,
    "pendingCommentCount": 0, "userCount": 2
  }
}
```

**系统信息响应：**

```json
{
  "nodeVersion": "v24.21.0", "platform": "linux", "uptime": 3600,
  "dbVersion": "3.53.4", "postCount": 2, "pageCount": 0, "commentCount": 2,
  "categoryCount": 1, "tagCount": 0, "mediaCount": 0, "userCount": 2
}
```

---

## 6. 错误码

| HTTP | `code` | 含义 |
|---|---|---|
| 200 | 0 | 成功 |
| 201 | 0 | 创建成功 |
| 400 | 1 | 参数错误（`message` 说明具体字段） |
| 401 | 1 | 未登录 / 用户名密码错误 |
| 403 | 1 | 无权限 / 站点已安装 / 注册未开放 |
| 404 | 1 | 资源不存在 |
| 409 | 1 | 冲突（用户名或邮箱已存在） |
| 429 | 1 | 请求过于频繁（登录锁定 / 安装限流） |
| 500 | 1 | 服务器内部错误 |

**前端处理建议：**

```js
const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
const body = await res.json();
if (body.code !== 0) throw new Error(body.message);
// 使用 body.data
```

---

## 7. 主题开发相关

主题只需要调用 **公开 API**，无需接触管理接口：

| 用途 | 接口 |
|---|---|
| 站点信息 + 主题设置 | `GET /options/public` |
| 文章列表 / 搜索 / 分类 / 标签过滤 | `GET /posts` |
| 文章详情 | `GET /posts/:slug` |
| 独立页面（导航） | `GET /pages` |
| 分类 / 标签云 | `GET /categories`、`GET /tags` |
| 归档 Widget | `GET /archives` |
| 最新评论 Widget | `GET /comments/recent` |
| 文章评论 + 发评论 | `GET /comments?postId=`、`POST /comments` |

完整的主题目录结构、`theme.json` 规范、模板标签与设置控件类型，见 **[主题开发指南](./主题开发指南.md)**。

---

*本文档随代码同步维护。接口有变动时请同时更新本文件。*
