# lill API 入口

本文是 v1.4.0 的简短入口，接口约定、权限、参数及响应请以 [API 文档](API文档.md)为准。发行版本为 v1.4.0，API 基础路径仍是 `/api/v1`。

以下示例假设已按[部署指南](部署指南.md)完成安装，站点地址为 `https://blog.example.com`。公开路由没有 `/public` 前缀。

## 站点引导数据

```bash
curl 'https://blog.example.com/api/v1/site/bootstrap?path=%2F'
```

实际路由为 `GET /api/v1/site/bootstrap`。`path` 传前台实际路径，用于解析自定义永久链接；也可使用 `type`、`slug`、`page` 等参数，详见权威文档。

## 文章列表

```bash
curl 'https://blog.example.com/api/v1/posts?page=1&pageSize=10'
```

`GET /api/v1/posts` 仅返回当前可公开阅读的内容，支持 `categoryId`、`categorySlug`、`tag`、`keyword` 等筛选；详情路由为 `GET /api/v1/posts/:slug`。

## 登录

```bash
curl 'https://blog.example.com/api/v1/auth/login' \
  -H 'Content-Type: application/json' \
  --data '{"username":"your-admin","password":"your-password","rememberMe":false}'
```

请替换为安装时创建的账号。成功响应中的 `data` 含 `token`、`csrfToken` 和 `user`；登录接口本身无需 Bearer 或 CSRF 请求头。

受保护接口携带 `Authorization: Bearer <token>`，其中写操作还需 `X-CSRF-Token: <csrfToken>`。权限由服务端按当前账号角色检查，完整管理接口见 [API 文档](API文档.md)。
