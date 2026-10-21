# 插件编辑器扩展接口设计

## 目标

为 Lill 插件提供正式、可持续的文章/页面编辑器扩展接口。插件可以增加内容字段、工具栏动作，也可以通过受支持的挂载点增加自己的编辑器 UI 和交互；不必依赖当前编辑器的私有 DOM 结构。

兼容当前 Astro 静态管理端、Node 插件运行时和 SQLite 内容模型。主题字段仍归主题管理；本设计只增加插件能力，不修改 Trim3。

## 当前状态

- 编辑器在 `frontend/public/admin/app.js` 中实现，目前没有插件前端扩展运行时。
- 插件 `activate(ctx)` 已支持路由、Hook 和后台菜单注册，并会在停用或激活失败时回收这些注册项。
- `posts.fields` 已用于通用字段和 `_lillThemeFields`；插件字段需要独立命名空间，不能与系统字段或主题字段混用。
- 现有 `ctx` 是服务端插件上下文，不能直接把函数回调序列化给浏览器。

## 方案

采用分层的插件编辑器 API：

1. 声明式字段和动作覆盖常见需求，便于核心统一渲染、校验和清理。
2. 插件可以注册一个前端扩展模块，并在核心提供的命名挂载点中创建自有 UI。
3. 扩展模块通过稳定的 `editor` API 读取和更新编辑器状态、操作选区、调用插件后端能力，并订阅编辑器生命周期事件。
4. 插件只能向已声明的扩展点添加内容；核心编辑器 DOM 结构不是公共 API，也不承诺兼容直接查询、重排、删除或替换核心节点的代码。

这不是安全沙箱。已启用插件代码按受信任的服务端/管理端代码运行；扩展 API 的职责是定义稳定兼容边界，减少升级时的脆弱耦合。

## 插件接口

### 字段

```js
ctx.registerEditorField({
  key: 'image_credit',
  label: '图片来源',
  type: 'text',
  for: 'post',
  group: '图片信息',
  description: '可选',
});
```

- 支持 `post`、`page`、`both` 内容范围；省略时为 `both`。
- 首期字段类型复用主题字段已有的 `text`、`textarea`、`number`、`checkbox`、`select`、`url`。
- 每个字段按插件目录名命名空间存储；插件只能读写自己声明的 key。
- 字段定义用于核心编辑器渲染与后端校验，不允许声明 HTML 或任意管理端脚本作为字段控件。

### 动作

```js
ctx.registerEditorAction({
  id: 'insert-image',
  label: '插入图片',
  placement: 'toolbar',
  for: 'post',
  handler: async ({ postId, contentType, selection }) => ({
    insertText: '![说明](https://example.test/image.webp)',
  }),
});
```

- 动作由核心工具栏/动作菜单渲染，运行时通过插件注册的处理器执行。
- API 只接受受限的编辑器操作结果，例如 `insertText`、`replaceSelection` 和写入本插件字段；动作不能返回可执行 HTML、内联脚本或任意 DOM 操作。
- 图片上传、复杂弹窗等交互由下面的前端扩展模块实现；需要持久化的文件操作仍走受认证和权限控制的后端 API。
- handler 由服务端插件运行时保留，不会出现在发给浏览器的动作 schema 中。

### 前端扩展模块

```js
ctx.registerEditorExtension({
  id: 'image-tools',
  entry: 'editor/index.js',
  styles: ['editor/styles.css'],
  for: ['post'],
  slots: ['toolbar', 'sidebar'],
  apiVersion: 1,
});
```

插件前端入口导出激活函数；扩展只在声明的 slot 容器中挂载，并返回卸载函数：

```js
export function activate({ editor, slots, plugin }) {
  const root = slots.sidebar.mount((container) => {
    // 在插件自己的挂载点中渲染控件。
  });

  const unsubscribe = editor.on('content:change', ({ content }) => {
    // 使用 editor API，而不是查找或改写核心编辑器节点。
  });

  return () => {
    unsubscribe();
    root.unmount();
  };
}
```

首期稳定 UI slot：

- `toolbar`：核心工具栏中的插件动作区域。
- `sidebar`：编辑器侧栏中的插件面板区域。

首期 editor bridge：

- `getDocument()`、`getContent()`：读取当前内容快照。
- `replaceContent(text)`、`insertText(text)`、`replaceSelection(text)`：通过核心状态更新正文。
- `getPluginFields()`、`setPluginField(key, value)`：访问当前插件自己的字段。
- `on('content:change' | 'save:before' | 'save:after', handler)`：订阅可公开的生命周期事件；订阅函数由扩展卸载时清理。
- `save:before` handler 按注册顺序串行执行，可返回 `{ content }` 作为下一 handler 的输入；无返回值表示不修改。抛出错误会取消本次保存并将错误显示给编辑者。`save:after` 仅用于通知，返回值忽略。
- `request(method, path, options)`：调用现有同源 API 客户端，沿用认证和 CSRF 行为。

未声明的 slot、API 方法或事件返回明确错误，不静默降级。新增 slot 或 bridge 方法按 `apiVersion` 演进。

参考模式为 WordPress Block Editor 的公开 SlotFill 扩展点，以及 Typecho Markdown 编辑器脚本中的 `markdownEditor` 插件钩子；Lill 采用自己的框架无关契约，不复制对方的 DOM、React 或内部 Hook API。

## 生命周期与路由

- 激活插件时收集其字段、动作和前端扩展声明；字段 key、动作 ID、扩展 ID 在插件命名空间内必须唯一，schema 不合法则激活失败。
- 新增 `GET /api/v1/admin/editor-extensions?type=post|page`，返回当前启用插件的可序列化扩展清单；只返回当前用户有权编辑的内容类型。
- 扩展脚本和样式仅从对应启用插件的受限目录路径提供；拒绝路径穿越、绝对路径、非允许扩展名和停用插件资源。
- 编辑器只加载适用于当前内容类型的启用插件扩展。每个扩展初始化失败时单独记录错误并卸载该扩展，不影响核心编辑器或其他插件扩展。
- 插件停用、激活回滚或卸载时，字段/动作/扩展声明和后端 handler 一并撤销；停用后新打开的编辑器不再返回该插件扩展。
- 前端模块卸载时执行返回的 cleanup，并移除其 slot 内容与事件监听。

## 字段读写与存储

继续复用 `posts.fields`，新增独立保留命名空间：

```json
{
  "legacyField": "kept",
  "_lillThemeFields": {
    "solbrin": { "subtitle": "主题字段" }
  },
  "_lillPluginFields": {
    "image-tools": { "image_credit": "来源信息" }
  }
}
```

- 管理端内容读取响应提供当前启用插件已声明字段的 `pluginFields` 投影；停用插件的历史值不投影给编辑器。
- 创建/更新 API 接收 `pluginFields`，后端按当前启用插件 schema 校验插件目录名、字段 key 和值类型。
- 一次更新只修改请求中对应插件的 namespace；未提交的插件字段、未知旧值、主题字段和通用字段均保留。
- 停用或卸载插件不删除已保存字段值；重新启用后仍可恢复。
- 插件字段默认不进入公开内容响应。若插件需要公开输出，应通过已有插件公开 API/Hook 明确实现，不能因后台字段声明自动泄露。

## 兼容与失败处理

- 没有插件编辑器扩展时，编辑器的 HTML、控件、保存行为和性能与现状保持一致。
- 扩展清单 API 失败时，核心编辑器继续可用并显示非阻断提示。
- 单个插件的脚本加载、初始化或动作失败时，不影响其他扩展；错误写入插件日志/后台错误提示。
- 未知历史字段按不透明数据保留，不渲染、不删除。
- 由于扩展代码不是沙箱，管理员启用插件即信任其服务端代码及其声明加载的管理端脚本。接口文档必须明确该信任模型。

## 非目标

- 不让插件覆盖、替换或依赖核心编辑器内部 DOM、内部 CSS 类名和未声明的全局变量。
- 首期不提供完整的自定义编辑器引擎替换、任意 React/Vue 依赖注入、任意 HTML 控件或全局管理端样式覆盖。
- 不将主题 `editorFields` 转成插件字段，也不修改主题字段存储或 `theme_fields` 公开投影。
- 不修改 Trim3；`tri3_toc` 仍属于主题字段。图床上传、编辑器增强等适合使用插件扩展接口。
- 不增加新数据库表；不改变 Astro 静态管理端与 Node/SQLite REST API 的边界。

## 验收标准

1. 插件可声明文章/页面字段；字段正确渲染、校验、保存、重新加载，且不覆盖系统字段或主题字段。
2. 插件可注册核心工具栏动作；动作处理成功时只应用受限编辑器操作，处理失败时核心编辑器保持可用。
3. 插件前端模块可在声明的 toolbar/sidebar slot 挂载自定义 UI，并通过 editor bridge 插入文本、更新自有字段和订阅生命周期事件。
4. 插件停用、卸载或激活失败后，字段、动作、脚本、slot 内容和监听均不再生效；历史字段值保留。
5. 恶意字段 schema、重复 ID、未知 slot/API、路径穿越、非允许资源和非法动作结果均被拒绝。
6. 单个扩展加载失败不阻断核心编辑器或其他插件；扩展清单失败时核心编辑器仍可使用。
7. 公开 API 不因插件字段声明自动返回后台插件字段。
8. 既有主题 `editorFields`、内容读写、插件生命周期、认证/CSRF 和管理端编辑器测试保持通过。

## 主要改动边界

- `backend/lib/plugin-ext.js`：注册、校验和按插件生命周期回收编辑器字段/动作/扩展声明。
- `backend/routes/admin/plugins.js` 或专用 editor extension 路由：提供活动扩展清单、资源与动作执行入口。
- `backend/routes/admin/content.js`：插件字段读写和按激活 schema 校验。
- `backend/routes/admin/index.js`：明确新路由的角色策略。
- `frontend/public/admin/app.js`、`admin.css`：slot 容器、editor bridge、扩展加载/卸载、插件字段渲染。
- `backend/test/`：注册生命周期、隔离存储、授权、动作操作白名单和 API 测试。
- `backend/test/admin-editor.test.js`：插件字段/动作/扩展 slot 的编辑器行为及失败隔离测试。
- `docs/API文档.md`、`docs/插件开发指南.md`：插件接口、示例、版本兼容和插件信任边界。

## 实施约束

- 保留工作区现有全部未提交内容，不重写或覆盖主题字段规格/计划。
- 先补失败测试，再做最小实现；首期不引入新的前端框架或依赖。
- 先完成通用插件编辑器扩展能力并验证，不接入 Trim3；后续由主题/插件按其职责分别消费该能力。
