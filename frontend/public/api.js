/**
 * lill 统一 API 封装（前台 + 后台共用）
 * 统一错误处理、token 管理、401 跳转、请求超时、切页取消旧请求
 */
window.lillAPI = (() => {
  const BASE = '/api/v1';
  const DEFAULT_TIMEOUT = 15000; // 15s 兜底，避免请求挂起导致界面一直转圈

  // 当前页面渲染作用域：切换页面时取消上一页未完成的 GET 请求，避免竞态和"永久转圈"
  let renderScope = null;

  function newRenderScope() {
    if (renderScope) renderScope.abort();
    renderScope = new AbortController();
    return renderScope.signal;
  }

  function getToken() { return localStorage.getItem('lill_token'); }

  function setToken(token) {
    if (token) localStorage.setItem('lill_token', token);
    else localStorage.removeItem('lill_token');
  }

  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    // GET 默认绑定当前渲染作用域（切页自动取消）；写操作不绑定，避免误取消
    const scope = options.signal || (method === 'GET' ? (renderScope && renderScope.signal) : null);
    const timeoutMs = options.timeout || DEFAULT_TIMEOUT;

    const controller = new AbortController();
    const onScopeAbort = () => controller.abort();
    if (scope) {
      if (scope.aborted) throw new Error('请求已取消');
      scope.addEventListener('abort', onScopeAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const config = { method, headers, signal: controller.signal };
    if (options.body !== undefined) config.body = JSON.stringify(options.body);

    let res;
    try {
      res = await fetch(BASE + path, config);
    } catch (e) {
      if (scope && scope.aborted) throw new Error('请求已取消');
      if (e.name === 'AbortError') throw new Error('请求超时，请重试');
      throw new Error('网络错误，请检查连接');
    } finally {
      clearTimeout(timer);
      if (scope) scope.removeEventListener('abort', onScopeAbort);
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('服务器返回异常 (HTTP ' + res.status + ')');
    }

    if (data.code !== 0) {
      if (res.status === 401) {
        setToken(null);
        if (!location.pathname.startsWith('/admin/login')) {
          location.href = '/admin/login';
        }
      }
      throw new Error(data.message || '请求失败');
    }
    return data.data;
  }

  return {
    request,
    newRenderScope,
    get: (path, o) => request(path, o),
    post: (path, body, o) => request(path, { method: 'POST', body, ...o }),
    put: (path, body, o) => request(path, { method: 'PUT', body, ...o }),
    patch: (path, body, o) => request(path, { method: 'PATCH', body, ...o }),
    del: (path, o) => request(path, { method: 'DELETE', ...o }),
    getToken,
    setToken,
  };
})();
