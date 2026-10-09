# lill API 文档

## 基础信息

- 基础 URL: `https://test.abohe.cn/api/v1`
- 认证方式: Bearer Token (JWT)
- 所有写操作需要 CSRF Token

## 认证

### POST /auth/login
登录
```json
{ "username": "admin", "password": "admin123", "rememberMe": false }
```

### GET /auth/me
获取当前用户信息

## 公开 API

### GET /public/bootstrap
获取站点初始化数据

### GET /public/posts
文章列表
- 参数: page, pageSize, categoryId, tagId, status

### GET /public/posts/:id
文章详情

### GET /public/categories
分类列表

### GET /public/tags
标签列表

### GET /public/comments
评论列表

### POST /public/comments
发表评论

### GET /public/search
搜索
- 参数: q

## 后台 API (需要认证)

### 文章管理
- GET /admin/posts - 文章列表
- POST /admin/posts - 创建文章
- PUT /admin/posts/:id - 更新文章
- DELETE /admin/posts/:id - 删除文章

### 页面管理
- GET /admin/pages - 页面列表
- POST /admin/pages - 创建页面
- PUT /admin/pages/:id - 更新页面
- DELETE /admin/pages/:id - 删除页面

### 分类管理
- GET /admin/categories - 分类列表
- POST /admin/categories - 创建分类
- PUT /admin/categories/:id - 更新分类
- DELETE /admin/categories/:id - 删除分类

### 标签管理
- GET /admin/tags - 标签列表
- POST /admin/tags - 创建标签
- PUT /admin/tags/:id - 更新标签
- DELETE /admin/tags/:id - 删除标签

### 评论管理
- GET /admin/comments - 评论列表
- PUT /admin/comments/:id - 更新评论
- DELETE /admin/comments/:id - 删除评论

### 媒体管理
- GET /admin/media - 媒体列表
- POST /admin/media/upload - 上传文件
- DELETE /admin/media/:id - 删除文件

### 用户管理
- GET /admin/users - 用户列表
- POST /admin/users - 创建用户
- PUT /admin/users/:id - 更新用户
- DELETE /admin/users/:id - 删除用户

### 主题管理
- GET /admin/themes - 主题列表
- POST /admin/themes/install - 安装主题
- PUT /admin/themes/:id/activate - 激活主题
- GET /admin/themes/settings - 主题设置
- PUT /admin/themes/settings - 保存主题设置

### 系统设置
- GET /admin/options - 获取设置
- PUT /admin/options - 保存设置

### 备份
- POST /admin/backup - 创建备份
- GET /admin/backup/:id/download - 下载备份
