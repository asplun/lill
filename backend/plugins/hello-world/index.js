/**
 * Hello World 公告栏 — lill 默认示例插件
 *
 * 它同时是一个「真正能用」的小工具，而不只是一个空壳：
 *   1. 后台「扩展 → 插件管理 → 设置」可配置公告文字 / 位置 / 配色
 *   2. 前台主题调用 GET /api/v1/hello 即可拿到公告内容并渲染
 *   3. 监听文章 / 评论 / 换主题事件并计数，后台设置页能看到统计
 *
 * 演示的插件能力：
 *   ctx.route()           注册 REST 路由
 *   ctx.on()              监听系统钩子
 *   ctx.addAdminMenu()    注册后台菜单（page 指向插件设置页）
 *   ctx.getConfig()       读取插件配置（后台设置表单写入的就是它）
 *   ctx.setConfig()       写入插件配置
 */

export async function activate(ctx) {
  ctx.log('Hello World 公告栏已激活');

  // ── 1. 公开接口：主题读取公告内容 ────────────────────────────
  // 主题里这样用：
  //   const r = await fetch('/api/v1/hello'); const { data } = await r.json();
  //   if (data.enabled) renderBanner(data.text, data.position, data.bg_color, data.text_color);
  ctx.route('GET', '/api/v1/hello', (req, res) => {
    const shows = ctx.getConfig('show_count', 0);
    const maxShows = Number(ctx.getConfig('max_shows', 0)) || 0;
    const withinLimit = maxShows === 0 || shows < maxShows;

    const payload = {
      enabled: !!ctx.getConfig('enabled', true) && withinLimit,
      text: ctx.getConfig('text', '欢迎来到 lill 博客系统！'),
      position: ctx.getConfig('position', 'top'),
      bg_color: ctx.getConfig('bg_color', '#4f46e5'),
      text_color: ctx.getConfig('text_color', '#ffffff'),
      plugin: 'hello-world'
    };

    if (payload.enabled) ctx.setConfig('show_count', shows + 1);
    ctx.json(res, payload);
  });

  // ── 2. 后台接口：插件统计（需登录）────────────────────────────
  ctx.route('GET', '/api/v1/hello/stats', (req, res) => {
    ctx.json(res, {
      show_count: ctx.getConfig('show_count', 0),
      post_count: ctx.getConfig('post_count', 0),
      comment_count: ctx.getConfig('comment_count', 0),
      theme_switches: ctx.getConfig('theme_switches', 0),
      last_event: ctx.getConfig('last_event', null),
      activated_at: ctx.getConfig('activated_at', null)
    });
  }, true);

  // ── 3. 监听系统事件 ──────────────────────────────────────────
  const track = (key) => {
    if (!ctx.getConfig('track_events', true)) return;
    ctx.setConfig(key, (ctx.getConfig(key, 0) || 0) + 1);
    ctx.setConfig('last_event', { key, at: new Date().toISOString() });
  };

  ctx.on('post.saved', (post) => { track('post_count'); ctx.log('文章已保存:', post.title); });
  ctx.on('comment.saved', () => track('comment_count'));
  ctx.on('theme.activated', ({ themeId }) => { track('theme_switches'); ctx.log('主题已切换:', themeId); });

  // ── 4. 后台菜单：直接指向本插件的设置页 ───────────────────────
  // page 用 plugin-settings:<目录名> 即可打开自动生成的设置表单；
  // 不写 page 则回退到 plugin:<id>，不写 url 也不会跳转到外部地址。
  ctx.addAdminMenu({
    id: 'hello-world',
    title: '公告栏',
    icon: '📣',
    order: 100,
    page: 'plugin-settings:hello-world'
  });

  // ── 5. 首次激活时间 ─────────────────────────────────────────
  if (!ctx.getConfig('activated_at', null)) ctx.setConfig('activated_at', new Date().toISOString());
  ctx.setConfig('activate_count', (ctx.getConfig('activate_count', 0) || 0) + 1);
}

export async function deactivate(ctx) {
  ctx.log('Hello World 公告栏已停用');
}
