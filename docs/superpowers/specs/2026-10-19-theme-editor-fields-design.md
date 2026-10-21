# 主题声明式内容字段设计

## 目标

为主题提供 Typecho `themeFields` 风格的文章/页面自定义字段。主题只声明字段结构；lill 核心后台负责渲染、读写和校验，主题不注入脚本，也不接管核心编辑器。

## 当前边界

- 文章和页面编辑器由独立管理端 `frontend/public/admin/app.js` 渲染。
- `posts.fields` 已是 JSON 存储位，但编辑界面尚未提供主题字段表单。
- 主题 manifest 已声明全站 `settings`；这与单篇内容字段是不同用途。
- 主题扩展负责主题专属前台数据和 API，不提供后台编辑器覆写钩子。
- 数据库已有 `posts.fields`，本功能不新增表或数据库迁移。

## 设计

### Manifest 契约

主题可在 `theme.json` 声明 `editorFields`：

```json
{
  "editorFields": [
    {
      "key": "subtitle",
      "label": "副标题",
      "type": "text",
      "for": "post",
      "group": "文章信息",
      "default": "",
      "description": "显示在文章标题下方"
    },
    {
      "key": "show_toc",
      "label": "显示目录",
      "type": "checkbox",
      "for": "post",
      "default": true
    },
    {
      "key": "hero_variant",
      "label": "页面样式",
      "type": "select",
      "for": "page",
      "default": "standard",
      "options": [
        { "value": "standard", "label": "标准" },
        { "value": "wide", "label": "宽屏" }
      ]
    }
  ]
}
```

- `for` 可取 `post`、`page`、`both`，省略时按 `both` 处理。
- 首期支持 `text`、`textarea`、`number`、`checkbox`、`select`、`url`。
- 每个字段有稳定的 `key` 和 `label`；`select` 必须声明非空 `options`。
- `group`、`default`、`description` 可选；相同 group 在后台归为一个主题字段面板。
- key 在单个主题内唯一，并建议带主题前缀，避免不同主题作者使用相同语义键。
- 不支持自定义 HTML、任意属性或管理端 JavaScript。

### 后台编辑器

- 编辑器加载时并行读取内容、分类/模板/站点选项和当前主题字段 schema；字段 schema 请求失败时，保留核心编辑器可用并显示明确的主题字段错误提示。
- 仅显示当前激活主题声明且匹配当前内容类型的字段。
- 新建时显示声明的默认值；编辑时显示该主题已保存值，缺失值回退到默认值。
- 主题字段放在核心发布/别名/分类等控件之后的独立分组中，不覆盖核心字段。
- 保存时以 `themeFields` 作为专用 API 属性提交；已有标题、正文、摘要、别名等保存行为不变。
- 主题没有 `editorFields` 时，不显示空面板，编辑器行为与现状一致。

### API 与校验

- 新增管理员接口 `GET /api/v1/admin/editor-fields?type=post|page`，返回当前主题 ID 和按内容类型筛选后的声明 schema。
- `GET /api/v1/admin/posts/:id` 在兼容现有返回字段的同时提供当前主题的 `themeFields` 值。
- `POST /api/v1/admin/posts` 与 `PUT /api/v1/admin/posts/:id` 接收可选 `themeFields` 对象。
- 后端以当前激活主题 manifest 为准校验字段 key 和值类型；`select` 值必须属于声明选项，非法值返回 400，不写入内容。
- 旧客户端不提交 `themeFields` 时，更新操作不得清空任何既有主题字段。
- 所有输入均按纯文本处理；管理端转义字段值，不将 manifest 内容作为 HTML 执行。

### 存储和主题切换

- 继续复用 `posts.fields` JSON 列，在保留旧有通用字段的前提下使用保留命名空间 `_lillThemeFields`，按主题 ID 保存：

```json
{
  "legacyField": "kept",
  "_lillThemeFields": {
    "solbrin": {
      "subtitle": "一段副标题"
    }
  }
}
```

- 编辑并保存当前主题字段时，只更新当前主题命名空间；未知旧字段和其他主题的值必须原样保留。
- 公开 bootstrap 和内容读取 API新增 `theme_fields`：只投影当前主题声明的字段，并合并默认值；现有 `fields` 返回契约不变。
- 文章和独立页面模板均通过 `{$post.theme_fields.<key>}` 读取当前主题字段；`$page` 是路由信息对象。
- 切换主题不会迁移或删除字段。切回原主题后，原值仍可读取；未声明字段不暴露给当前主题。

## 非目标

- 不替换 Markdown 编辑器，不提供任意 React/Vue 组件注册。
- 不允许主题在管理端执行脚本、注入 HTML 或修改侧边栏核心控件。
- 不增加媒体选择器、字段重复项、条件显示、字段关系、字段组嵌套或复杂富文本字段。
- 不修改任何现有第三方主题（包括 trim3）；演示字段仅用于默认主题或隔离测试 fixture。
- 不改变 Astro 管理端与 Node/SQLite REST API 的前后端分离边界。

## 验收标准

1. 默认主题未声明字段时，文章和页面编辑器不出现空字段面板。
2. 测试主题声明不同文章/页面字段后，后台只显示对应内容类型的字段。
3. 新建、编辑和重新打开内容时，默认值和已保存值正确显示。
4. 主题字段经 API 写入 `posts.fields`，前台只收到当前主题声明的 `theme_fields`。
5. 切换主题并编辑内容不会清除原主题字段、通用旧字段或其他主题字段。
6. 非法 key、类型或 select 选项被后端拒绝且数据库内容不变。
7. 字段标签、说明和值含 HTML/脚本文本时只作为文本显示。
8. 既有编辑器、角色权限、主题切换和公开内容测试保持通过。

## 主要改动边界

- `backend/lib/theme-runtime.js`：读取和规范化主题编辑字段 schema。
- `backend/routes/admin/themes.js` 或对应管理路由：提供认证 schema API。
- `backend/routes/admin/content.js`：读写主题字段并在后端按 manifest 校验。
- `backend/routes/public.js`：向当前主题投影安全的 `theme_fields`。
- `backend/routes/admin/index.js`：显式登记新路由策略。
- `frontend/public/admin/app.js` 与 `admin.css`：声明式字段渲染、加载、保存和错误反馈。
- `docs/主题开发指南.md`、`docs/API文档.md`：补充 manifest、模板访问和 API 契约。
- 测试覆盖 schema 规范化、内容读写与角色权限、主题切换保留、真实浏览器编辑流程。

## 实施约束

- 延续现有 Astro 静态管理端 + Node REST 后端 + SQLite 架构。
- 先补失败测试，再做最小实现。
- 保留工作区现有所有未提交改动；不触碰 trim3，不提交、不推送、不部署。
