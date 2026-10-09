/**
 * ═══════════════════════════════════════════════════════════════
 *  lill 主题引擎 + 运行时（Typecho 式：主题 = 模板文件夹）
 * ═══════════════════════════════════════════════════════════════
 *  主题作者只写 HTML + 模板标签，不需要写任何 JS 适配器。
 *
 *  标签语法
 *    {$post.title}                 输出变量（自动 HTML 转义）
 *    {$post.html_content|raw}      输出原始 HTML
 *    {$post.published_at|date}     过滤器
 *    {if $post.sticky}…{elseif}…{else}…{/if}
 *    {loop $posts as $post}…{/loop}
 *    {loop $tags as $i => $tag}…{/loop}
 *    {include header}              引入同目录片段（共享作用域）
 *    {* 注释 *}
 *
 *  过滤器
 *    raw escape e date default truncate upper lower length count
 *    json nl2br urlencode strip number
 * ═══════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  /* ══════════════════ 一、模板引擎 ══════════════════ */

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function Safe(v) { this.v = String(v === null || v === undefined ? '' : v); }
  Safe.prototype.toString = function () { return this.v; };

  function fmtDate(v, fmt) {
    if (!v) return '';
    var s = String(v).replace(' ', 'T');
    if (!/[Zz]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
    var d = new Date(s);
    if (isNaN(d.getTime())) return String(v);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var m = { Y: d.getFullYear(), m: pad(d.getMonth() + 1), d: pad(d.getDate()), H: pad(d.getHours()), i: pad(d.getMinutes()), s: pad(d.getSeconds()) };
    if (!fmt || fmt === 'date') return m.Y + '-' + m.m + '-' + m.d;
    return String(fmt).replace(/[YmdHis]/g, function (k) { return m[k]; });
  }

  var FILTERS = {
    raw: function (v) { return new Safe(v); },
    safe: function (v) { return new Safe(v); },
    escape: esc,
    e: esc,
    date: fmtDate,
    'default': function (v, d) { return (v === undefined || v === null || v === '') ? d : v; },
    truncate: function (v, n, suffix) {
      var s = String(v === null || v === undefined ? '' : v).replace(/<[^>]*>/g, '').trim();
      n = parseInt(n) || 100;
      return s.length > n ? s.slice(0, n) + (suffix === undefined ? '…' : suffix) : s;
    },
    upper: function (v) { return String(v == null ? '' : v).toUpperCase(); },
    lower: function (v) { return String(v == null ? '' : v).toLowerCase(); },
    length: function (v) { return (v && v.length) ? v.length : 0; },
    count: function (v) { return (v && v.length) ? v.length : 0; },
    json: function (v) { return JSON.stringify(v === undefined ? null : v); },
    nl2br: function (v) { return new Safe(esc(v).replace(/\n/g, '<br>')); },
    urlencode: function (v) { return encodeURIComponent(v == null ? '' : v); },
    strip: function (v) { return String(v == null ? '' : v).replace(/<[^>]*>/g, ''); },
    number: function (v) { return parseInt(v) || 0; }
  };

  /* ── 1.1 解析：源码 → AST ── */
  function parse(src) {
    var root = { t: 'root', c: [] };
    var stack = [root];
    var i = 0, text = '';
    function cur() { return stack[stack.length - 1]; }
    function flush() { if (text) { cur().c.push({ t: 'text', v: text }); text = ''; } }

    while (i < src.length) {
      var ch = src.charAt(i);
      if (ch !== '{') { text += ch; i++; continue; }

      if (src.substr(i, 2) === '{*') {                       // 注释
        var ce = src.indexOf('*}', i + 2);
        if (ce < 0) { text += src.slice(i); break; }
        i = ce + 2; continue;
      }

      var e = src.indexOf('}', i + 1);
      if (e < 0) { text += src.slice(i); break; }
      var tag = src.slice(i + 1, e).trim();
      var ok = true;

      if (tag.charAt(0) === '$') {
        flush(); cur().c.push({ t: 'out', e: tag });

      } else if (/^if\s/.test(tag)) {
        flush();
        var nIf = { t: 'if', b: [{ cond: tag.slice(3).trim(), c: [] }], e: null };
        cur().c.push(nIf);
        // 压入「条件帧」：c 指向当前分支的正文数组，ifn 指回 if 节点
        stack.push({ c: nIf.b[0].c, ifn: nIf });

      } else if (/^else\s?if\s/.test(tag)) {
        var frIf = stack[stack.length - 1];
        if (stack.length < 2 || !frIf.ifn || frIf.ifn.e) { ok = false; }
        else {
          flush();
          var brIf = { cond: tag.replace(/^else\s?if\s+/, '').trim(), c: [] };
          frIf.ifn.b.push(brIf); frIf.c = brIf.c;
        }

      } else if (tag === 'else') {
        var feIf = stack[stack.length - 1];
        if (stack.length < 2 || !feIf.ifn || feIf.ifn.e) { ok = false; }
        else { flush(); feIf.ifn.e = []; feIf.c = feIf.ifn.e; }

      } else if (tag === '/if') {
        if (stack.length < 2 || !stack[stack.length - 1].ifn) { ok = false; } else { flush(); stack.pop(); }

      } else if (/^loop\s/.test(tag)) {
        var m = tag.slice(5).trim().match(/^(.+?)\s+as\s+(\$[\w$]+)\s*(?:=>\s*(\$[\w$]+))?$/);
        if (!m) { ok = false; }
        else {
          flush();
          var nLoop = { t: 'loop', e: m[1].trim(), val: m[2], key: m[3] || null, c: [] };
          cur().c.push(nLoop); stack.push(nLoop);
        }

      } else if (tag === '/loop') {
        if (stack.length < 2) { ok = false; } else { flush(); stack.pop(); }

      } else if (/^include\s/.test(tag)) {
        flush();
        cur().c.push({ t: 'inc', name: tag.slice(8).trim().replace(/^['"]|['"]$/g, '') });

      } else { ok = false; }

      if (ok) { i = e + 1; continue; }
      text += '{'; i++;   // 不是模板标签（例如 CSS 的 .a{color:red}）→ 当作文本
    }
    flush();
    return root;
  }

  /* ── 1.2 include 展开：把片段内联进 AST（天然共享作用域） ── */
  function expand(nodes, partials) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.t === 'inc') {
        var src = partials[n.name];
        if (src !== undefined) {
          var sub = expand(parse(src).c, partials);
          for (var j = 0; j < sub.length; j++) out.push(sub[j]);
        }
        continue;
      }
      if (n.t === 'if') {
        out.push({
          t: 'if',
          b: n.b.map(function (br) { return { cond: br.cond, c: expand(br.c, partials) }; }),
          e: n.e ? expand(n.e, partials) : null
        });
        continue;
      }
      if (n.t === 'loop') { out.push({ t: 'loop', e: n.e, val: n.val, key: n.key, c: expand(n.c, partials) }); continue; }
      out.push(n);
    }
    return out;
  }

  /* ── 1.3 收集模板引用到的片段名 ── */
  function collectIncludes(nodes, acc) {
    nodes.forEach(function (n) {
      if (n.t === 'inc') acc.push(n.name);
      else if (n.t === 'if') {
        collectIncludes(n.b.reduce(function (a, b) { return a.concat(b.c); }, []), acc);
        if (n.e) collectIncludes(n.e, acc);
      } else if (n.t === 'loop') collectIncludes(n.c, acc);
    });
    return acc;
  }

  /* ── 1.4 表达式 ── */
  function exprOf(s) {
    return String(s)
      .replace(/\s+and\s+/g, ' && ')
      .replace(/\s+or\s+/g, ' || ')
      .replace(/^\s*not\s+/, '!');
  }
  // 取值加保护：任意一层为 undefined 也不会中断整页渲染
  function guard(s) { return '__g(function(){return (' + exprOf(s) + ');})'; }

  function splitTop(s, sep) {
    var parts = [], depth = 0, q = null, cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(' || c === '[') { depth++; cur += c; continue; }
      if (c === ')' || c === ']') { depth--; cur += c; continue; }
      if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts;
  }

  function outputExpr(raw) {
    var parts = splitTop(raw, '|').map(function (p) { return p.trim(); });
    var v = guard(parts.shift());
    parts.forEach(function (p) {
      var m = p.match(/^([A-Za-z_]\w*)\s*(?::([\s\S]*))?$/);
      if (!m) return;
      var name = m[1], args = m[2];
      if (args === undefined || args === '') {
        v = '__f[' + JSON.stringify(name) + '](' + v + ')';
      } else {
        var list = splitTop(args, ':').map(function (a) { return guard(a); });
        v = '__f[' + JSON.stringify(name) + '](' + v + ',' + list.join(',') + ')';
      }
    });
    return v;
  }

  var seq = 0;
  function gen(nodes) {
    var s = '';
    nodes.forEach(function (n) {
      if (n.t === 'text') { s += '__h.push(' + JSON.stringify(n.v) + ');'; return; }
      if (n.t === 'out') { s += '__h.push(__o(' + outputExpr(n.e) + '));'; return; }
      if (n.t === 'if') {
        n.b.forEach(function (br, i) { s += (i === 0 ? 'if(' : 'else if(') + guard(br.cond) + '){' + gen(br.c) + '}'; });
        if (n.e) s += 'else{' + gen(n.e) + '}';
        return;
      }
      if (n.t === 'loop') {
        var id = ++seq;
        var arr = '__a' + id, idx = '__i' + id, key = '__k' + id, item = '__v' + id;
        s += 'var ' + arr + '=__iter(' + guard(n.e) + ');';
        s += 'for(var ' + idx + '=0;' + idx + '<' + arr + '.length;' + idx + '++){';
        s += 'var ' + key + '=' + arr + '[' + idx + '][0],' + item + '=' + arr + '[' + idx + '][1];';
        s += n.val + '=' + item + ';';
        if (n.key) s += n.key + '=' + key + ';';
        s += gen(n.c) + '}';
        return;
      }
    });
    return s;
  }

  function compile(nodes) {
    var src = 'with(__s){' + gen(nodes) + '}';
    try {
      return new Function('__s', '__h', '__o', '__g', '__f', '__iter', src);
    } catch (err) {
      throw new Error('模板语法错误：' + err.message);
    }
  }

  function iter(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(function (x, i) { return [i, x]; });
    if (typeof v === 'object') return Object.keys(v).map(function (k) { return [k, v[k]]; });
    return [];
  }

  // 只有 $ 开头的名字进入 with 作用域（模板变量），避免遮蔽引擎内部的 __h/__g 等
  function makeScope(obj) {
    var target = obj || {};
    return new Proxy(target, {
      has: function (t, k) { return typeof k === 'string' && k.charCodeAt(0) === 36; },
      get: function (t, k) {
        if (t[k] !== undefined) return t[k];
        return (typeof k === 'string' && k.charAt(0) === '$') ? t[k.slice(1)] : undefined;
      }
    });
  }

  var Engine = {
    esc: esc,
    fmtDate: fmtDate,
    filters: FILTERS,
    parse: parse,
    collectIncludes: collectIncludes,
    render: function (source, partials, scope) {
      var ast = expand(parse(source).c, partials || {});
      var fn = compile(ast);
      var out = [];
      fn(makeScope(scope || {}), out,
        function (v) { return (v instanceof Safe) ? v.v : esc(v); },
        function (f) { try { return f(); } catch (e) { return undefined; } },
        FILTERS, iter);
      return out.join('');
    }
  };

  window.LillEngine = Engine;

  /* ══════════════════ 二、运行时 ══════════════════ */

  var app = document.getElementById('lill-app');
  if (!app) return;

  var API = window.lillAPI;

  // 搜索防抖：输入停止 300ms 后才触发搜索
  var searchDebounceTimer = null;
  function debounceSearch(callback, delay) {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(callback, delay || 300);
  }
  var pageType = app.getAttribute('data-page') || 'index';
  var segs = location.pathname.split('/').filter(Boolean);
  var slug = (pageType === 'post' || pageType === 'page' || pageType === 'category' || pageType === 'tag') ? (segs[1] || '') : '';
  var qs = new URLSearchParams(location.search);
  var pageNum = parseInt(qs.get('page')) || 1;
  var keyword = qs.get('q') || '';
  var month = qs.get('month') || '';

  function setLoading() {
    app.innerHTML = '<div class="lill-loading"><span class="lill-spinner"></span></div>';
  }
  function fail(msg) {
    app.innerHTML = '<div class="lill-error"><h2>页面加载失败</h2><p>' + esc(msg) + '</p><p><a href="/">返回首页</a></p></div>';
  }
  function assetUrl(themeId, file) {
    return '/themes/' + encodeURIComponent(themeId) + '/' + file;
  }
  function fetchText(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      return r.ok ? r.text() : null;
    }).catch(function () { return null; });
  }

  // 递归加载模板 + 它引用到的所有片段
  function loadTemplate(themeId, name, partials, seen) {
    return fetchText(assetUrl(themeId, name + '.html')).then(function (src) {
      if (src === null) return null;
      partials[name] = src;   // ← 关键：把片段存入共享表，{include} 才能取到
      var incs = collectIncludes(parse(src).c, []);
      var jobs = [];
      incs.forEach(function (inc) {
        if (partials[inc] !== undefined || seen[inc]) return;
        seen[inc] = true;
        jobs.push(loadTemplate(themeId, inc, partials, seen));
      });
      return Promise.all(jobs).then(function () { return src; });
    });
  }

  var FALLBACK = { index: [], post: ['index'], page: ['index'], archive: ['index'], category: ['index'], tag: ['index'], search: ['index'], '404': ['index'] };

  function loadPageTemplate(themeId, type, extraFallback) {
    var names = [type].concat(extraFallback || []).concat(FALLBACK[type] || []);
    var partials = {}, seen = {};
    function attempt(idx) {
      if (idx >= names.length) return Promise.resolve(null);
      return loadTemplate(themeId, names[idx], partials, seen).then(function (src) {
        if (src === null) return attempt(idx + 1);
        return { src: src, partials: partials };
      });
    }
    return attempt(0);
  }

  function applyHead(boot) {
    var site = boot.site || {}, page = boot.page || {}, theme = boot.theme || {};
    var title = page.title || site.name || '';
    document.title = (page.type === 'index' || !title) ? (site.name || 'lill') : (title + ' - ' + (site.name || 'lill'));
    var md = document.querySelector('meta[name="description"]');
    if (md && site.description) md.setAttribute('content', site.description);
    if (theme.custom_css) {
      var st = document.createElement('style');
      st.id = 'lill-theme-custom-css';
      st.textContent = theme.custom_css;
      document.head.appendChild(st);
    }
    // head.html 支持：主题可在 head.html 中输出自定义 <head> 内容
    if (boot.head_html) {
      var headDiv = document.createElement('div');
      headDiv.innerHTML = boot.head_html;
      while (headDiv.firstChild) document.head.appendChild(headDiv.firstChild);
    }
    var assets = boot.themeAssets || {};
    if (!assets.head) return Promise.resolve();
    return fetchText(assetUrl(boot.themeId, 'head.html')).then(function (headSrc) {
      if (!headSrc) return;
      var html = Engine.render(headSrc, {}, { site: site, theme: theme, page: page, options: boot.options || {}, nav: boot.nav || [] });
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      Array.prototype.slice.call(tmp.childNodes).forEach(function (n) { document.head.appendChild(n); });
    });
  }

  function enhance() {
    // 评论表单：主题写 <form class="lill-comment-form" data-post-id="…">，运行时负责提交
    Array.prototype.slice.call(app.querySelectorAll('form.lill-comment-form')).forEach(function (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var msg = form.querySelector('.lill-comment-msg');
        var btn = form.querySelector('[type=submit]');
        var g = function (n) { var el = form.querySelector('[name=' + n + ']'); return el ? el.value : ''; };
        var body = { postId: form.getAttribute('data-post-id'), content: g('content'), authorName: g('authorName'), authorEmail: g('authorEmail'), authorUrl: g('authorUrl') };
        if (!body.content.trim()) { if (msg) { msg.className = 'lill-comment-msg is-error'; msg.textContent = '请填写评论内容'; } return; }
        if (btn) btn.disabled = true;
        API.post('/comments', body).then(function () {
          if (msg) { msg.className = 'lill-comment-msg is-ok'; msg.textContent = '评论已提交，审核通过后显示'; }
          form.reset();
        }).catch(function (err) {
          if (msg) { msg.className = 'lill-comment-msg is-error'; msg.textContent = err.message || '提交失败'; }
        }).then(function () { if (btn) btn.disabled = false; });
      });
    });
    // 深色模式开关：<button data-lill-toggle="dark">
    Array.prototype.slice.call(app.querySelectorAll('[data-lill-toggle="dark"]')).forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        var on = document.documentElement.classList.toggle('lill-dark');
        try { localStorage.setItem('lill_dark', on ? '1' : '0'); } catch (e) {}
      });
    });
  }

  function loadThemeScript(themeId, assets) {
    if (assets && assets.script === false) return Promise.resolve();
    return new Promise(function (resolve) {
      var url = assetUrl(themeId, 'theme.js');
      var s = document.createElement('script');
      s.src = url + '?_=' + Date.now();
      s.onload = resolve; s.onerror = resolve;
      document.body.appendChild(s);
    });
  }

  // 兼容旧版「shell.html + theme.js 适配器」主题
  function legacyRender(themeId, boot) {
    return fetchText(assetUrl(themeId, 'shell.html')).then(function (shell) {
      if (shell === null) return false;
      var site = boot.site || {};
      var html = shell
        .replace(/\{\{\s*site_name\s*\}\}/g, esc(site.name))
        .replace(/\{\{\s*site_description\s*\}\}/g, esc(site.description))
        .replace(/\{\{\s*content\s*\}\}/g, '<div class="lill-legacy-slot"></div>');
      app.innerHTML = html;
      if (!window.lillTheme) {
        var cfg = boot.theme || {};
        window.lillTheme = {
          esc: esc, fmtDate: fmtDate, cfg: cfg, opts: boot.options || {}, ready: Promise.resolve(),
          val: function (k, d) { var v = cfg[k]; return (v === undefined || v === null || v === '') ? (d === undefined ? '' : d) : v; },
          on: function (k, d) { var v = cfg[k]; if (v === undefined || v === null || v === '') v = d; return v === true || v === 'true'; },
          postCard: function () { return ''; }, renderNav: function () {}, renderSidebar: function () {}, applyConfig: function () {}
        };
      }
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = assetUrl(themeId, 'theme.css');
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = assetUrl(themeId, 'theme.js') + '?_=' + Date.now();
      document.body.appendChild(s);
      return true;
    });
  }

  function applyThemeBody(scope) {
    var t = scope.theme || {};
    if (t.layout) document.body.classList.add('layout-' + t.layout);
    if (t.content_width) document.body.classList.add('width-' + t.content_width);
    if (t.color) document.documentElement.style.setProperty('--primary', t.color);
  }

  function render(boot) {
    var themeId = boot.themeId || 'default';
    var scope = {
      site: boot.site || {}, theme: boot.theme || {}, page: boot.page || {},
      nav: boot.nav || [], sidebar: boot.sidebar || {}, options: boot.options || {},
      themeMeta: boot.themeMeta || {}, data: boot.data || {}
    };
    // data.* 平铺到顶层，模板里直接写 {$posts} / {$post} / {$comments}
    Object.keys(boot.data || {}).forEach(function (k) { scope[k] = boot.data[k]; });
    window.__LILL_SCOPE__ = scope;

    // 老式「shell.html + theme.js 适配器」主题：没有任何页面模板，
    // 直接走兼容渲染，避免对 index.html 之类的无意义 404 探测
    var tplList = (boot.themeAssets || {}).templates || [];
    var PAGE_TPL = ['index', 'post', 'page', 'archive', 'category', 'tag', 'search', '404'];
    var hasPageTpl = PAGE_TPL.some(function (n) { return tplList.indexOf(n) !== -1; });
    if (tplList.length > 0 && !hasPageTpl) {
      return legacyRender(themeId, boot).then(function (done) {
        if (!done) throw new Error('主题「' + themeId + '」缺少可识别的模板（既无 index.html，也无 shell.html）');
      });
    }

    // 独立页面自定义模板：后台为页面选了 page-xxx 模板时优先使用
    var tplName = pageType;
    if (pageType === 'page' && boot.data && boot.data.pageTemplate) tplName = boot.data.pageTemplate;

    return loadPageTemplate(themeId, tplName, tplName !== 'page' ? ['page'] : null).then(function (tpl) {
      if (!tpl) {
        return legacyRender(themeId, boot).then(function (done) {
          if (!done) throw new Error('主题「' + themeId + '」缺少 ' + tplName + '.html 模板');
        });
      }
      if (!boot.themeAssets || boot.themeAssets.style !== false) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = assetUrl(themeId, 'style.css') + '?v=' + encodeURIComponent((boot.themeMeta || {}).version || '1');
        document.head.appendChild(css);
      }

      var html;
      try { html = Engine.render(tpl.src, tpl.partials, scope); }
      catch (err) { throw new Error('主题模板渲染失败：' + err.message); }

      app.innerHTML = html;
      applyThemeBody(scope);
      enhance();
      return loadThemeScript(themeId, boot.themeAssets);
    });
  }

  setLoading();
  try { if (localStorage.getItem('lill_dark') === '1') document.documentElement.classList.add('lill-dark'); } catch (e) {}

  API.get('/site/bootstrap?type=' + encodeURIComponent(pageType) +
    '&slug=' + encodeURIComponent(slug) +
    '&page=' + pageNum +
    '&path=' + encodeURIComponent(location.pathname) +
    '&q=' + encodeURIComponent(keyword) +
    '&month=' + encodeURIComponent(month))
    .then(function (boot) {
      return applyHead(boot).then(function () { return render(boot); });
    })
    .catch(function (err) { fail(err && err.message ? err.message : '未知错误'); });
})();
