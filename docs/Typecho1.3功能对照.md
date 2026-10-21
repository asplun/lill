# Typecho 1.3 功能对照与缺陷清单

审计日期：2026-10-18。

- 本轮修复基线：`0524f698feb92cc17164885bb49926eeff868aac`；首次审计基线为 `d9e17c6e06d1fd495423b08d11cf054c33fefdcd`。
- Typecho：官方 `v1.3.0`，提交 `e9f23304bf20c0c355ef1df9634d42148cbc53b5`。
- 对照官方完整源码，同时检查 lill 的界面、接口、数据库及公开读取路径。部分问题通过隔离 SQLite 内存数据库及真实处理函数复现；不代表已在线上触发。
- B01–B15 的已确认缺陷已实施修复；未实现的独立功能另列。防错处理不等于补齐全部 Typecho 功能。

P1 优先处理内容正确性、安全和基础可用性；P2 补齐日常管理流程。数据库有字段、接口接受参数，不等于用户能完整使用。

## 本轮处理的 15 项实际缺陷

| 编号 | 优先级 | 修复前已确认的问题 | 本轮处理 |
| --- | --- | --- | --- |
| B01 | P1 | 文章列表缺少 `type`，编辑时可能提交 `"undefined"` | 列表及最近文章返回真实类型；文章入口固定 `post` 兼容滚动升级；后端拒绝非法类型和状态。 |
| B02 | P1 | 清空正文后仍显示旧 HTML | 空正文同步重算；升级时也重新生成历史派生 HTML。 |
| B03 | P1 | 中文标签重复保存报错，文章可能部分更新 | 按名称复用标签，slug 冲突加后缀；正文、标签关联和旧版本快照同事务。 |
| B04 | P1 | 静默忽略保护参数，可能误公开 | 明确拒绝尚不支持的非公开可见性与非空密码；普通更新保留历史保护字段，公开查询仍排除受限内容。**已闭环。** 后台接受 public/private/password 三种可见性并校验 4-100 位密码，密码只存哈希；编辑已有密码文章时留空密码即保持原哈希，不必重填（`PUT /api/v1/admin/posts/:id`）；前台解锁表单位于 `frontend/public/theme.js` 的通用渲染层（`renderPasswordGate`），不依赖主题模板；bootstrap 对未解锁的密码文章只下发 `{id,title,slug,passwordRequired}`，历史遗留的「public + 有密码」行同样可解锁；列表、Feed、导航仍只含公开内容。 |
| B05 | P1 | 历史 `autoload=1` 插件配置可进入公开响应 | 公开 options/bootstrap 使用核心白名单；新插件配置强制私有，旧配置也不再随 autoload 暴露。未声称曾发现真实密钥泄漏。 |
| B06 | P1 | 备份使用推导路径，可能复制错库或遗漏 WAL | 使用实际 `DB_PATH/UPLOAD_DIR`、正式 SQLite 一致性快照及校验；失败不发布产物；后台可列表和下载。 |
| B07 | P1 | 并发首次安装可能创建多个管理员 | 在写事务内重新检查安装状态；可选插件失败仍返回已完成的安装/session，并同步停用失败插件、附警告。 |
| B08 | P1 | 所有登录用户绕过评论审核 | 仅管理员、编辑及作者本人对应文章可免审；普通订阅者和无关作者遵循审核，反垃圾检查仍保留。 |
| B09 | P1 | 永久链接只生成、不解析 | 生成/解析共享规则；后台拒绝非法规则；列表、热门文章、上下篇、Feed 使用一致地址；旧非法格式和内置地址重名时生成可访问的旧 slug 路由；Nginx 任意路径回退通用壳。 |
| B10 | P2 | 非管理员菜单和默认请求与权限不符 | 按角色显示菜单及默认入口；投稿者只显示草稿；作者的分类/标签只读；服务端权限仍为最终边界。 |
| B11 | P2 | 评论编辑/回复只找最新 100 条 | 使用当前分页的完整记录，无须重复读取最新 100 条。 |
| B12 | P2 | 批量发布缺少日期，未来内容提前公开 | 统一日期校验和 UTC 存储，首次发布补日期；公开文章、导航、Feed 和互动均检查生效时间。 |
| B13 | P2 | 摘要及排序设置不生效 | 自动/手填摘要分模式；自动模式遵循长度和 `<!--more-->`；HTML 摘要只允许安全行内标签；标题/日期排序接入读取。 |
| B14 | P2 | 全站/主题条数冲突，评论设置未统一消费 | 仅显式主题覆盖优先；评论 API 与 bootstrap 共用平铺/嵌套及分页规则；默认主题支持分页、返回和表单保留，不重复读取首屏评论。 |
| B15 | P2 | 插件启用失败后状态或注册残留 | 真正激活成功才持久化启用；失败清理 route/hook/menu；停用成功才卸载；覆盖同一路由的多个插件按任意顺序停用不复活旧入口。 |

本轮额外收紧 Markdown 正文与后台预览的 URL、属性转义和代码片段边界；真实 `<!--more-->` 不再显示在全文，代码示例保留。旧站按 `md_renderer_v3_security` 标记一次性重算派生 HTML。
慢备份另设 150 秒请求期限，ZIP 可取消，超时/断连清理暂存；迟到处理函数不再二次响应并导致 API 退出。普通 API 保留 20 秒兜底，代理和客户端期限见部署指南。

主要源码证据：

- B01–B04、B12：[内容路由](../backend/routes/admin/content.js)、[列表查询及权限](../backend/routes/admin/shared.js)、[编辑器与列表](../frontend/public/admin/app.js)、[slug 工具](../backend/lib/utils.js)。
- B05、B08、B09、B13、B14：[公共读取与评论](../backend/routes/public.js)、[插件配置](../backend/routes/admin/plugins.js)、[前台路径识别](../frontend/public/theme.js)。
- B06：[备份实现](../backend/routes/admin/system.js)、[数据库与上传路径配置](../backend/server.js)。
- B07：[首次安装](../backend/routes/install.js)。
- B10：[角色策略](../backend/routes/admin/shared.js)、[路由权限元数据](../backend/routes/admin/index.js)、[后台菜单](../frontend/src/pages/admin/index.astro)。
- B11：[评论管理界面](../frontend/public/admin/app.js) 的 `replyCmt/editCmt` 与[评论路由](../backend/routes/admin/comments.js)。
- B15：[插件状态路由](../backend/routes/admin/plugins.js)、[插件运行时](../backend/lib/plugin-ext.js)。

## 对照 Typecho 尚未闭环的细节功能

| 功能 | lill 现状 | Typecho 1.3 对照与建议 |
| --- | --- | --- |
| 自定义内容字段 | **已闭环**：编辑器侧栏「自定义字段」按行增删键值对，随文章保存到 `posts.fields`；字段名限 `[A-Za-z_][A-Za-z0-9_]{0,63}` 且不能以下划线开头，最多 50 个，值只收文本/数字/布尔，非法键与超限返回 400；主题命名空间 `_lillThemeFields` 与插件命名空间 `_lillPluginFields` 在通用字段保存时一并保留 | Typecho 有字符、整数、小数、JSON 字段编辑。lill 以「通用键值 + 命名空间隔离」实现同等能力；JSON 复合值不开放给通用字段，需要结构的业务字段仍由主题/插件声明。 |
| 一篇文章多个分类 | **已闭环**：新增 `post_categories` 关联表（建表+索引，老库启动时把 `category_id` 回填进去），编辑器侧栏「主分类」下拉 +「附加分类」复选框（`name="pe-cat-extra"`），保存 `categoryIds` 数组且首项写入 `category_id` 作为主分类（供 `{category}` 永久链接）；公开分类页/分类计数/后台筛选与计数都按关系表匹配，并兼容只写 `category_id` 的旧数据（`COUNT(DISTINCT p.id)`）；文章详情返回 `post.categories`，`PUT categoryIds: []` 可解绑，非法分类 id 返回 400。测试锁在 `backend/test/multi-category.test.js` | Typecho 使用多选分类和关联表；lill 用等价关联表实现多分类，同时保留单值 `category_id` 作为主分类，旧永久链接不变。 |
| 页面层级 | **已闭环**：`posts` 新增 `parent_id`（含历史库 `ensureColumn` 升级与 `idx_posts_parent` 索引），编辑器侧栏「父级页面」下拉排除自身与后代；公开路径按祖先 slug 拼目录（如 `/docs/install/linux`），有子页面的父级自动用 `/docs` 形式，未设父级的页面仍走 `page_pattern`；导航下发 `depth`，后台页面列表按层级缩进并显示 `a/b` 路径；删除父级时子页面提升为顶层，保存拒绝自指、成环、父级不存在或父级不是页面（`parentId` 走 `POST/PUT /api/v1/admin/posts`） | Typecho 独立页面支持父子层级与 `/父/子.html` 目录路径。lill 已对齐层级、目录路由与旧 `/page/<slug>` 别名；不同处是父级页面 URL 会随「获得子页面」变为目录形式（旧地址仍可访问）。 |
| 服务端自动草稿与修订草稿 | **已闭环**：新增 `post_drafts` 表（`post_id` 唯一，一篇文章一条草稿），编辑已有文章时停止输入 800ms 后 `POST /api/v1/admin/posts/:id/autosave` 落库，失败静默不打断写作；保存成功或恢复修订后 `DELETE .../autosave` 清理。打开文章时 `GET .../autosave`，与现值不同则在编辑器顶部显示「有服务器草稿（时间），点击恢复」提示条，一键回填标题/正文/摘要（摘要自动切手动）。侧栏「修订历史」列最近 50 条快照（`GET /posts/:id/versions`，详情 `GET .../versions/:versionId`），点「恢复」二次确认后 `POST .../versions/:versionId/restore`：先把当前值写入 `post_versions` 再覆盖 `posts` 并重载编辑器；跨文章 versionId 返回 404，无权限 403，超长草稿 400。测试锁在 `backend/test/post-autosave-revisions.test.js` | Typecho 可将已发布文章的修改保存为独立草稿并自动保存到服务器。lill 用「服务器草稿表 + 修订快照恢复」对齐：草稿独立于发布内容、跨浏览器可找回，恢复前旧值仍留历史；差别是草稿只保留每篇最新一份而非多份并行草稿。 |
| 单篇其他权限 | **已闭环**：允许评论已接通；私密文章仅作者与管理员/编辑可读（bootstrap 与详情同口径，其余身份 404）；密码文章通过 `POST /api/v1/posts/:slug/unlock` 校验后下发 7 天 HttpOnly cookie（`lill_post_<id>`），详情接口在解锁前返回 `post_password_required`，bootstrap 未解锁时只返回解锁表单所需的最小视图模型；前台解锁表单在 `theme.js` 通用渲染层渲染、不套主题模板，失败提示「密码错误」；解锁判定只看「行上是否有密码」，历史 public+password 数据同样可解锁。单篇 Feed 可用 `allowFeed` 关闭：`/api/v1/feed` 与 `/api/v1/sitemap.xml` 的文章查询过滤 `p.allow_feed != 0`（列默认 1），编辑器侧栏「输出到 Feed」复选框，保存走 `POST/PUT /api/v1/admin/posts` 的 `allowFeed` 布尔（非布尔 400）；`allowPing` 仅存开关（`posts.allow_ping`，默认 1，编辑器「允许引用」复选框），lill 无 trackback/pingback 接收端。测试锁在 `backend/test/post-permissions.test.js` | Typecho 每篇有 `allowPing`/`allowFeed`。lill 已对齐单篇 Feed 输出控制；引用协议本身无接收端，`allowPing` 作为兼容字段保留，不引入 trackback/pingback 处理。 |
| 内容列表筛选与批量操作 | **已闭环**：文章/页面列表具备状态筛选、关键词与分类筛选、全选与本页选择，批量动作覆盖发布、转草稿、删除、移动分类、置顶/取消置顶，并给出逐条结果反馈（成功/跳过/失败计数） | Typecho 列表同样支持筛选与批量动作；lill 已在同一工具条内实现，无额外设计差异。 |
| 评论按文章查看 | **已闭环**：评论页筛选区新增「文章」下拉（`app.js` 的 `commentPostId`，请求带 `postId=`），与状态、关键词筛选可组合，重置会一并清空 | Typecho 支持针对某篇内容管理评论；lill 用筛选下拉实现同等入口，不引入折叠式分组布局。 |
| 附件编辑与替换 | **已闭环**：后台附件页可编辑文件名、缩略名、替代文本、描述，并原位替换文件（保留原链接与扩展名，重算尺寸与缩略图）；接口为 `PUT /api/v1/admin/media/:id` 与 `POST /api/v1/admin/media/:id/replace`，`media` 表补 `slug`/`description` 列（含历史库 `ensureColumn` 升级） | Typecho 可编辑标题、缩略名、描述，并原位替换文件。lill 已对齐编辑与替换流程；不含 WP 裁图等额外需求。 |
| 备份恢复 | **已闭环（数据库）**：备份页对 `.db` 备份提供「恢复」，二次确认 + 输入「恢复」后才执行；`POST /api/v1/admin/backup/restore` 先 `quick_check` 校验来源、要求 `users` 表存在，再自动生成 `lill-backup-before-restore-*.db` 安全快照，按表列交集在单事务内覆盖；附件需手工解压对应 `lill-uploads-*.zip` | Typecho 可恢复自身内容备份，但不等同于完整站点快照；跨数据库和附件的原子快照、Typecho 格式导入仍未实现（lill 目前只恢复数据库，附件目录需另行解压覆盖）。 |

## 2026-10-21 补齐记录（在这些差距行之上新增）

| 项 | 本轮落点 |
| --- | --- |
| 后台批量操作 | 文章/页面支持 发布、转草稿、删除、移动分类、置顶/取消置顶；分类/标签/附件/用户/小工具/主题支持批量操作；评论支持批量审核与批量删除；日志、备份、插件页补批量入口。接口集中在 `backend/routes/admin/{content,taxonomy,media,users,widgets,themes,comments,system}.js`，前端在 `frontend/public/admin/app.js` 的 `update*Selection` / `batch*` 系列。 |
| 永久链接设置 | 分文章/独立页面/分类/标签四组预设 + 自定义，附变量说明、实时预览、恢复默认、冲突提示与粘贴 URL 试解析（`POST /api/v1/admin/permalinks/resolve`）；新增 `page_pattern`（独立页面路径）与 `archive_path`/`search_path`。 |
| 附件编辑与替换 | 见上表该行；测试锁在 `backend/test/batch-operations.test.js` 的 media editor 用例。 |

本表用于确认差距和实现边界，不表示所有差异都已补齐，也不是穷尽所有差异的功能承诺。

已新增的编辑细节：可编辑发布时间（本地显示、UTC 存储）、单篇允许评论、页面顺序、自动/手填摘要。旧摘要首次迁移时，手填内容若恰好等于旧自动摘要无法无损区分，可在编辑器切回手填；明确保存的模式不会重复猜测。

## 本轮验证与部署记录

- 2026-10-18：Astro 构建成功；后端项目完整测试 **496 项通过，0 失败、0 跳过**，包含真实 Chrome 中的后台和默认主题用例。
- 定向回归覆盖内容写事务、旧数据升级、摘要/Markdown 安全、安装并发、配置公开边界、评论审核、永久链接生成/解析、插件激活/停用回滚、WAL 备份、慢归档与客户端取消。所有站点写入测试使用隔离数据库。
- 部署仅替换明确清单中的 21 个运行文件；提前创建数据库一致性快照及文件/Nginx 备份；仅重启 `lill-backend`，Nginx 校验成功后重载。
- 测试站继续启用 trim3，部署前后校验 **3239 个第三方主题文件完全一致**，没有把第三方主题加入核心仓库。
- 线上只读验收 13 个后台目的页（文章、页面、评论、分类、标签、媒体、主题、插件、用户、设置、日志、备份、控制台），当前主题与插件设置可打开，未记录到后台页面脚本错误或 API 失败。
- 正式 `/archives/<cid>/` 路径经 Nginx 通用壳及真实 bootstrap 解析到同一篇内容；不存在内容的 API 返回 404，缺失主题脚本返回 404。静态壳本身仍可能 HTTP 200，不属于 SSR 状态保证。
- 线上未执行内容编辑、备份创建或插件切换等写操作；这些操作由本地临时 SQLite/真实 API/Chrome 回归验证。以上验收不承诺任意第三方主题自行实现的全部交互。

## 已有能力与合理差异

- 主题列表、切换、按主题独立保存配置、声明式设置表单、页面自定义模板已有通路；本次未将它们重复列为缺失。任意第三方主题是否消费自己的每个设置，需要单独验证。
- 主题后端扩展与 REST API 可以保留前后端分离，无须复刻 PHP 的执行方式。
- Typecho 的 XML-RPC/Pingback 开关与 lill 自身依赖的 REST API 不等价，不应机械增加“关闭所有 API”选项。
- Typecho 1.3 核心的文章、页面、评论删除为永久删除，不能把 WordPress 回收站当作 Typecho 必须具备的功能。lill 若展示回收站，仍需兑现自己的界面承诺。
- 个人资料页此前已被用户列为不需要，保留为可选差异，不为追求对齐强加该页面。
- 第三方 trim3 的布局、业务设置和资源不属于 lill 核心。本次不迁入、删除或发布该主题。

## 上一轮后台交互修复记录

以下保留基线 `0524f69` 已交付的交互修复与测量记录，不代替本轮验证：

- 编辑器独立的文章、分类、模板、永久链接读取改为并行。
- 重复点击当前菜单不再取消并重启相同加载，失败页面仍可重试。
- 主题、插件、文章、分类、用户子页面统一处理请求取消；重试保留失败的具体子页面。
- 评论勾选、全选、取消选择只更新本地界面，不重新请求并替换整张表。
- 后台写入可在切页后完成，但旧操作不会夺回当前页面；同页并发写入仍各自刷新结果。
- 删除编辑器长期选项缓存，重新打开时读取当前设置。
- 评论回复、编辑的初始请求被取消时不再产生未捕获拒绝；B11 的最新 100 条限制已在本轮继续修复。

对应[浏览器回归测试](../backend/test/admin-ui.test.js)已在真实浏览器和临时 API/SQLite 环境运行；独立审查指出的重试、同页并发刷新与旧缓存问题也已加入回归。

上一轮验证：构建成功，完整测试 129 项通过、0 项跳过；后台浏览器专项包含 21 个子用例。2026-10-18 已部署后台相关四个文件，保留测试站当时启用的 trim3，部署前后校验 3221 个第三方主题文件一致。

线上只读测量得到以下两次快照，受当时网络和运行环境影响，不作为所有页面的性能保证：

| 新建页面编辑器 | 修复前 | 修复后 |
| --- | --- | --- |
| 普通网络 | 314 ms | 105 ms |
| 每个 API 请求人为附加 180 ms 延迟 | 818 ms | 322 ms |

三个前置 API 已并行发出；修复后的这次线上测量没有记录到页面脚本错误或超过 50 ms 的主线程长任务。该历史验收仅覆盖当时的后台交互。

## 官方参考

以下链接固定到 Typecho 1.3.0 提交，避免后续主分支变化影响对照：

- [文章编辑与高级选项](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/admin/write-post.php)
- [页面模板、顺序与父页面](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/admin/write-page.php)
- [通用内容字段](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/admin/custom-fields.php)
- [草稿、分类与标签处理](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/var/Widget/Contents/EditTrait.php)
- [内容访问条件与未来时间过滤](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/var/Widget/Archive.php)
- [评论管理](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/admin/manage-comments.php)
- [评论权限及审核](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/var/Widget/Feedback.php)
- [附件编辑](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/var/Widget/Contents/Attachment/Edit.php)
- [永久链接规则](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/var/Widget/Options/Permalink.php)
- [主题配置](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/var/Widget/Themes/Config.php)
- [插件激活与配置](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/var/Widget/Plugins/Edit.php)
- [内容备份与恢复](https://github.com/typecho/typecho/blob/e9f23304bf20c0c355ef1df9634d42148cbc53b5/var/Widget/Backup.php)

后续建议优先复用现有接口补齐列表筛选/批量操作与按文章管理评论，再处理自定义字段、附件编辑等独立功能；多分类、层级与服务端修订草稿已按上表闭环，剩余项不为对齐名称引入重型框架。
