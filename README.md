# lill 博客系统

> 轻量、可扩展、前后端分离的博客系统  
> 后端 Node.js + SQLite 纯 REST API，前端 Astro 静态站点，主题即模板。

## 特性

- **前后端分离**：后端只处理 `/api/*`，前端静态文件由 Nginx 直接服务
- **主题系统**：主题放在 `frontend/themes/` 下，`theme.json` 声明元数据与设置项
- **插件就绪**：预留插件接口，支持主题自定义设置、侧边栏 Widget
- **多用户**：支持多用户角色（管理员、编辑、作者）
- **评论分组**：评论按文章分组，支持审核、回复
- **永久链接**：自定义 URL 结构（`/archives/{cid}/`、`/category/{slug}/` 等）
- **REST API**：完整的 RESTful API，支持第三方客户端

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
