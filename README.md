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

- Node.js >= 18
- SQLite 3（Node.js 内置 `node:sqlite`）
- Nginx（生产环境）

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

```bash
# 1. 构建前端
cd frontend && pnpm run build

# 2. 配置 Nginx
# 将 frontend/dist/ 作为 root，/api/ 代理到后端 3000 端口

# 3. 启动后端（PM2）
cd ../backend
pm2 start ecosystem.config.cjs
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
│   ├── ecosystem.config.cjs  # PM2 配置
│   └── data/          # SQLite 数据库
├── frontend/          # Astro 前端
│   ├── src/           # 源码
│   ├── public/        # 静态资源
│   ├── themes/        # 主题目录
│   └── dist/          # 构建输出
├── docs/              # 文档
└── README.md
```

## 主题开发

见 [docs/主题开发指南.md](docs/主题开发指南.md)

## API 文档

见 [docs/API文档.md](docs/API文档.md)

## License

MIT
