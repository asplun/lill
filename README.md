# lill 博客系统

> 轻量、可扩展、前后端分离的博客系统  
> 后端 Node.js + SQLite 纯 REST API，前端 Astro 静态站点，主题即模板。

## 特性

### 核心功能
- **前后端分离**：后端只处理 `/api/*`，前端静态文件由 Nginx 直接服务
- **主题系统**：主题放在 `frontend/themes/` 下，`theme.json` 声明元数据与设置项
- **插件系统**：预留插件接口，支持主题自定义设置、侧边栏 Widget
- **多用户**：支持多用户角色（管理员、编辑、作者）
- **评论分组**：评论按文章分组，支持审核、回复
- **永久链接**：自定义 URL 结构（`/archives/{cid}/`、`/category/{slug}/` 等）
- **REST API**：完整的 RESTful API，支持第三方客户端
- **文章版本控制**：自动保存历史版本，支持回滚
- **媒体管理**：上传时自动生成缩略图
- **小工具系统**：自定义 HTML 小工具，支持侧边栏位置

### 安全特性
- **CSRF 防护**：所有写操作自动携带 CSRF Token
- **登录验证码**：SVG 验证码，防止暴力破解
- **多因素认证**：TOTP 支持
- **速率限制**：API 请求频率限制
- **安全响应头**：X-Content-Type-Options、X-Frame-Options 等

### 性能优化
- **请求去重**：相同请求自动复用 Promise
- **请求重试**：网络错误自动重试
- **离线支持**：Service Worker 缓存
- **CDN 支持**：静态资源 CDN 加速
- **缓存策略**：智能缓存，减少服务器压力

### 开发体验
- **API 文档**：完整的 API 文档（`docs/api.md`）
- **多语言支持**：i18n 接口，支持多语言
- **主题在线编辑器**：后台直接编辑主题文件
- **安装日志**：安装过程日志记录
- **系统监控**：实时监控、日志分析

## 技术栈

| 层 | 技术 |
|---|------|
| 后端 | Node.js（`node:http` + `node:sqlite`） |
| 前端 | Astro（静态站点） |
| 数据库 | SQLite |
| 部署 | Nginx + PM2 |

## 快速开始

### 1. 环境要求

- **Node.js >= 22**（推荐 24 LTS，后端使用 `node:sqlite`，18/20 不支持）
- SQLite 3（Node.js 内置 `node:sqlite`，无需单独安装）
- Nginx / OpenResty（生产环境）

### 2. 安装

```bash
# 克隆仓库
git clone https://github.com/asplun/lill.git
cd lill

# 安装依赖
cd frontend && pnpm install

# 构建前端
pnpm run build

# 启动后端（开发）
cd ../backend
node server.js
```

### 3. 生产部署

详细步骤见 **[docs/部署指南.md](docs/部署指南.md)**，含：

- 🟢 **宝塔面板**部署（软件安装 → 建站 → Nginx 配置 → PM2 → SSL）
- 🟢 **1Panel 面板**部署（OpenResty → 反向代理 → Node 环境 → SSL）
- ⚙️ **裸机手动部署**
- 🔧 升级维护与常见问题排查

**快速版：**

```bash
# 1. 构建前端
cd frontend && pnpm install && pnpm run build

# 2. 启动后端（PM2）
cd ../backend
openssl rand -hex 32          # 生成的密钥填入 ecosystem.config.js 的 JWT_SECRET
pm2 start ecosystem.config.js && pm2 save

# 3. Nginx：root 指向 frontend/dist，/api/ 反代到 127.0.0.1:3000
#    完整配置模板见 docs/部署指南.md
```

### 4. 安装向导

首次访问后台 `/admin/` 会自动跳转到安装向导：

1. 环境检查
2. 站点信息（名称、描述、URL）
3. 管理员账号（用户名、密码、邮箱）
4. 数据库初始化（默认主题、Hello World 文章）

## 目录结构

```
lill/
├── backend/           # Node.js 后端
│   ├── server.js      # 主服务
│   ├── ecosystem.config.js   # PM2 配置
│   └── data/          # SQLite 数据库
├── frontend/          # Astro 前端
│   ├── src/           # 源码
│   ├── public/        # 静态资源
│   ├── themes/        # 主题目录
│   └── dist/          # 构建输出
├── docs/              # 文档（部署/主题/API）
└── README.md
```

## 文档

| 文档 | 内容 |
|---|---|
| [部署指南](docs/部署指南.md) | 宝塔面板 / 1Panel 面板 / 裸机部署、升级维护、问题排查 |
| [主题开发指南](docs/主题开发指南.md) | 主题目录结构、`theme.json` 规范、模板标签、设置控件 |
| [API 文档](docs/API文档.md) | 公开 / 认证 / 安装 / 管理接口完整参考 |

## License

MIT
