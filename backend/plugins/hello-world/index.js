/**
 * Hello World 示例插件
 * 演示插件系统的四大能力：
 *   1. ctx.route()      — 注册 REST 路由
 *   2. ctx.on()         — 监听 hook
 *   3. ctx.addAdminMenu() — 注册后台菜单
 *   4. ctx.getConfig()  — 读写插件配置
 */

export async function activate(ctx) {
  ctx.log('Hello World 插件已激活');

  // 1. 注册一个公开 API
  ctx.route('GET', '/api/v1/hello', (req, res) => {
    ctx.json(res, { message: 'Hello from plugin!', time: new Date().toISOString() });
  });

  // 2. 监听文章保存 hook
  ctx.on('post.saved', (post) => {
    ctx.log('文章已保存:', post.title);
  });

  // 3. 注册后台菜单项
  ctx.addAdminMenu({
    id: 'hello-world',
    title: 'Hello 插件',
    icon: '👋',
    order: 100
  });

  // 4. 读写配置
  const count = ctx.getConfig('activate_count', 0);
  ctx.setConfig('activate_count', count + 1);
  ctx.log('已激活次数:', count + 1);
}

export async function deactivate(ctx) {
  ctx.log('Hello World 插件已停用');
}
