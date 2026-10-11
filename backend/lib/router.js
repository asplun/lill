/**
 * lill 路由表：注册 + 匹配（支持 /a/:id 参数）
 * 注意：匹配按注册顺序遍历，路由注册顺序会影响优先级
 */
export function createRouter() {
  const routes = new Map();

  function route(method, path, fn, policy = false) {
    const management = path === '/api/v1/admin' || path.startsWith('/api/v1/admin/');
    const declared = typeof policy === 'object' && policy !== null ? policy : { auth: !!policy };
    const roles = declared.roles || (management ? ['admin'] : null);
    routes.set(method + ':' + path, { fn, auth: management || !!declared.auth || !!roles, roles, pattern: path });
  }

  function removeRoute(method, path) {
    return routes.delete(method + ':' + path);
  }

  function matchRoute(method, path) {
    const exact = method + ':' + path;
    if (routes.has(exact)) return { ...routes.get(exact), params: {} };
    for (const [key, definition] of routes) {
      const ci = key.indexOf(':');
      const m = key.slice(0, ci);
      const p = key.slice(ci + 1);
      if (m !== method) continue;
      const names = [];
      const re = new RegExp('^' + p.replace(/:([^/]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
      const match = path.match(re);
      if (match) {
        const params = {};
        names.forEach((n, i) => params[n] = match[i + 1]);
        return { ...definition, params };
      }
    }
    return null;
  }

  return { route, removeRoute, matchRoute, routes };
}
