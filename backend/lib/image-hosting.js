/**
 * 图床上传（逐行对照原版 TriM3 lib/album.php）
 *
 *   tri_album_upload()        → upload()
 *   tri_album_upload_local()  → uploadLocal()
 *   tri_album_upload_remote() → uploadRemote()   （兰空 Lsky Pro v2 / Chevereto / 又拍云 / 通用 multipart）
 *   tri_album_upload_qiniu()  → uploadQiniu()    （七牛云 Kodo：服务端签凭证 + 表单直传）
 *   tri_album_dig()           → dig()
 *
 * 主题设置键（与 theme.json「图片处理」组一致）：
 *   albumApiType albumApiUrl albumApiToken albumApiFileField albumApiUrlPath albumApiDomain
 *   upyunTokenSecret upyunTokenTtl
 *   qiniuAccessKey qiniuSecretKey qiniuBucket qiniuRegion qiniuDomain qiniuPrefix qiniuTokenSecret qiniuTokenTtl
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'];
const IMG_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-ms-bmp'];
const MAX_SIZE = 20 * 1024 * 1024;   // 原版：20MB

/** 嗅探真实图片类型（对照原版 finfo / getimagesize 的“内容校验”） */
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return '';
  const b = buf;
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  return '';
}

/** tri_album_dig：按 "a.b.c" 路径取响应里的标量字符串 */
export function dig(arr, path) {
  let node = arr;
  for (const seg of String(path || '').split('.')) {
    if (node && typeof node === 'object' && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, seg)) node = node[seg];
    else if (Array.isArray(node) && /^\d+$/.test(seg)) node = node[Number(seg)];
    else return '';
  }
  return (node === null || node === undefined || typeof node === 'object') ? '' : String(node);
}

const base64urlKeepPad = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

export function createImageHost({ settings, uploadDir, siteUrl = '' }) {
  const opt = (k, d = '') => settings.opt(k, d);

  /** 本机存储：<上传根>/albums/YYYYMM/HHMMSS_<8hex>.<ext>（对照 tri_album_upload_local） */
  function uploadLocal(buffer, ext) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ym = `${now.getFullYear()}${pad(now.getMonth() + 1)}`;
    const dir = join(uploadDir, 'albums', ym);
    mkdirSync(dir, { recursive: true });
    const fname = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${randomBytes(4).toString('hex')}.${ext}`;
    const fp = join(dir, fname);
    writeFileSync(fp, buffer);
    /* 原版返回 siteUrl + '/usr/uploads/albums/...'；lill 的上传目录为 /uploads（nginx alias + 后端静态路由），
       这里按 lill 惯例返回站内相对地址，避免 site_url 配成 http 时前台 https 页面出现混合内容。 */
    return { ok: true, url: `/uploads/albums/${ym}/${fname}`, msg: '', host: 'local', file: fp };
  }

  /** 又拍云 _upt Token 防盗链签名（对照原版 upyunTokenSecret 分支） */
  function upyunSign(url) {
    const secret = opt('upyunTokenSecret', '').trim();
    if (secret === '') return url;
    let ttl = parseInt(opt('upyunTokenTtl', '86400'), 10);
    if (!ttl || ttl < 60) ttl = 86400;
    const etime = Math.floor(Date.now() / 1000) + ttl;
    let uri = '';
    try { uri = new URL(url).pathname; } catch { uri = ''; }
    if (uri === '') return url;
    const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
    const upt = md5(secret + etime + uri).slice(12, 20) + etime;
    return url + (url.includes('?') ? '&' : '?') + '_upt=' + upt;
  }

  /** 图床 API（对照 tri_album_upload_remote） */
  async function uploadRemote(buffer, { name, mime }) {
    const apiUrl = opt('albumApiUrl', '').trim();
    if (apiUrl === '') return { ok: false, url: '', msg: '未配置图床上传地址' };
    let type = opt('albumApiType', '').trim();
    if (type === '') type = 'lsky';
    const token = opt('albumApiToken', '').trim();
    let field = opt('albumApiFileField', '').trim();
    if (field === '') field = (type === 'chevereto') ? 'source' : 'file';
    let urlPath = opt('albumApiUrlPath', '').trim();
    if (urlPath === '') urlPath = (type === 'chevereto') ? 'image.url' : 'data.links.url';
    const domain = opt('albumApiDomain', '').trim().replace(/\/+$/, '');

    const fd = new FormData();
    fd.append(field, new Blob([buffer], { type: mime || 'application/octet-stream' }), name || 'upload');
    if (type === 'chevereto' && token !== '') fd.append('key', token);

    const headers = {};
    let upyunAuth = '';
    if (type === 'upyun' && token !== '') {
      const idx = token.indexOf(':');
      if (idx > 0) {
        const operator = token.slice(0, idx).trim();
        const password = token.slice(idx + 1).trim();
        let bucket = '';
        try { bucket = decodeURIComponent(new URL(apiUrl).pathname || '').replace(/^\/+|\/+$/g, '').replace(/\/.*$/, ''); } catch { bucket = ''; }
        if (operator !== '' && password !== '' && bucket !== '') {
          const policy = Buffer.from(JSON.stringify({
            bucket,
            'save-key': '/{year}/{mon}/{day}/{random32}.{suffix}',
            expiration: Math.floor(Date.now() / 1000) + 600,
          }), 'utf8').toString('base64');
          const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
          const sign = md5(md5(password) + '&' + policy);
          fd.append('policy', policy);
          fd.append('signature', sign);
          upyunAuth = 'UPYUN ' + operator + ':' + sign;
        }
      }
    }
    if (upyunAuth !== '') headers.Authorization = upyunAuth;
    else if (token !== '' && type !== 'chevereto') headers.Authorization = 'Bearer ' + token;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let body = '', code = 0;
    try {
      const resp = await fetch(apiUrl, { method: 'POST', body: fd, headers, signal: ac.signal });
      code = resp.status;
      body = await resp.text();
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, url: '', msg: '图床请求失败：' + ((e && e.message) || e) };
    }
    clearTimeout(timer);

    let js = null;
    try { js = JSON.parse(body); } catch { js = null; }
    if (!js || typeof js !== 'object') return { ok: false, url: '', msg: '图床返回非 JSON（HTTP ' + code + '）' };

    if (type === 'upyun') {
      if (js.code !== undefined && Number(js.code) !== 200) {
        return { ok: false, url: '', msg: '又拍云错误：' + String(js.message || ('HTTP ' + code)) };
      }
      let url = String(js.url || '');
      if (url === '') return { ok: false, url: '', msg: '未能从又拍云响应中解析图片地址' };
      url = upyunSign(url);
      return { ok: true, url, msg: '', host: 'upyun' };
    }
    if (js.status_code !== undefined && Number(js.status_code) !== 200 && js.error && js.error.message) {
      return { ok: false, url: '', msg: '图床错误：' + String(js.error.message) };
    }
    if (js.status !== undefined && Number(js.status) !== 200 && js.message) {
      return { ok: false, url: '', msg: '图床错误：' + String(js.message) };
    }
    if (js.code !== undefined && Number(js.code) !== 0 && js.msg) {
      return { ok: false, url: '', msg: '图床错误：' + String(js.msg) };
    }
    let url = dig(js, urlPath);
    if (url === '') url = dig(js, 'image.url');
    if (url === '') url = dig(js, 'url');
    if (url === '') url = dig(js, 'data.url');
    if (url === '') return { ok: false, url: '', msg: '未能从图床响应中解析图片地址' };
    if (!url.startsWith('http') && domain !== '') url = domain + '/' + url.replace(/^\/+/, '');
    return { ok: true, url, msg: '', host: type };
  }

  /** 七牛云 Kodo（对照 tri_album_upload_qiniu） */
  async function uploadQiniu(buffer, { name, mime }) {
    const ak = opt('qiniuAccessKey', '').trim();
    const sk = opt('qiniuSecretKey', '').trim();
    const bucket = opt('qiniuBucket', '').trim();
    if (ak === '' || sk === '' || bucket === '') {
      return { ok: false, url: '', msg: '七牛云未配置完整：请填写 AccessKey / SecretKey / 存储空间' };
    }
    let domain = opt('qiniuDomain', '').trim().replace(/\/+$/, '');
    if (domain === '') return { ok: false, url: '', msg: '七牛云未配置 CDN 访问域名' };
    if (!domain.startsWith('http')) domain = 'https://' + domain;
    const ext = extname('x.' + String(name || '').split('.').pop()).replace('.', '').toLowerCase();
    if (!IMG_EXT.includes(ext)) return { ok: false, url: '', msg: '不支持的图片格式' };

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const prefix = opt('qiniuPrefix', '').trim();
    let key = prefix !== '' ? prefix.replace(/\/+$/, '') + '/' : '';
    key += `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}/`;
    key += `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${randomBytes(4).toString('hex')}.${ext}`;

    /* 上传凭证：base64url 必须保留 '=' 填充（与七牛官方 SDK 一致），去掉会导致 401 bad token */
    const policy = JSON.stringify({ scope: bucket, deadline: Math.floor(Date.now() / 1000) + 3600 });
    const encPolicy = base64urlKeepPad(policy);
    const encSign = createHmac('sha1', sk).update(encPolicy).digest().toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const uploadToken = ak + ':' + encSign + ':' + encPolicy;

    const hosts = {
      z0: 'https://upload.qiniup.com',
      z1: 'https://upload-z1.qiniup.com',
      z2: 'https://upload-z2.qiniup.com',
      na0: 'https://upload-na0.qiniup.com',
      as0: 'https://upload-as0.qiniup.com',
    };
    const uploadUrl = hosts[opt('qiniuRegion', '').trim()] || hosts.z0;

    const fd = new FormData();
    fd.append('token', uploadToken);
    fd.append('key', key);
    fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), name || 'upload');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let body = '', code = 0;
    try {
      const resp = await fetch(uploadUrl, { method: 'POST', body: fd, signal: ac.signal });
      code = resp.status;
      body = await resp.text();
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, url: '', msg: '七牛云请求失败：' + ((e && e.message) || e) };
    }
    clearTimeout(timer);

    let js = null;
    try { js = JSON.parse(body); } catch { js = null; }
    if (!js || typeof js !== 'object') return { ok: false, url: '', msg: '七牛云返回非 JSON（HTTP ' + code + '）' };
    if (js.error) {
      const em = (typeof js.error === 'object' ? String(js.error.message || '') : String(js.error));
      const ec = String(js.error_code || '');
      let tip = '';
      if (code === 401 && (em === 'bad token' || ec === 'BadToken')) tip = '；AccessKey/SecretKey 无效或已被关闭，请在七牛控制台重新确认/创建密钥';
      else if (em === 'incorrect region' || ec === 'IncorrectRegion') tip = '；存储空间不在所选区域，请核对后台「区域」设置';
      else if (em === 'no such bucket' || ec === 'NoSuchBucket') tip = '；存储空间名不存在，请核对「存储空间(Bucket)」';
      else if (code === 403) tip = '；空间访问被拒绝，请检查空间权限与防盗链设置';
      return { ok: false, url: '', msg: '七牛云错误：' + (em !== '' ? em : ('HTTP ' + code)) + tip };
    }
    const rkey = String(js.key || '');
    if (rkey === '') return { ok: false, url: '', msg: '未能从七牛云响应中解析资源 key' };
    /* 存原始 URL（不带签名）：防盗链签名由输出层按每次请求动态生成，避免固化后过期 403 */
    return { ok: true, url: domain + '/' + rkey, msg: '', host: 'qiniu' };
  }

  /**
   * 上传入口（对照 tri_album_upload）
   * @param {Buffer} buffer 图片二进制
   * @param {{name?:string, mime?:string}} meta
   * @returns {Promise<{ok:boolean,url:string,msg:string,host?:string}>}
   */
  async function upload(buffer, meta = {}) {
    if (!buffer || !buffer.length) return { ok: false, url: '', msg: '未收到文件' };
    const size = buffer.length;
    if (size > MAX_SIZE) return { ok: false, url: '', msg: '文件大小超出限制（20MB）' };
    const ext = String(meta.name || '').split('.').pop().toLowerCase();
    if (!IMG_EXT.includes(ext)) return { ok: false, url: '', msg: '不支持的图片格式' };
    /* 内容校验：避免仅改后缀的非图片文件入库 */
    const sniffed = sniffImage(buffer);
    const declared = String(meta.mime || '').toLowerCase();
    const okSniff = IMG_MIME.includes(sniffed);
    const okDeclared = IMG_MIME.includes(declared);
    if (!okSniff && !okDeclared) return { ok: false, url: '', msg: '文件内容不是有效图片' };
    const mime = okSniff ? sniffed : declared;

    const type = opt('albumApiType', '').trim();
    if (type === 'qiniu') return uploadQiniu(buffer, { name: meta.name, mime });
    const apiUrl = opt('albumApiUrl', '').trim();
    if (apiUrl !== '') return uploadRemote(buffer, { name: meta.name, mime });
    return uploadLocal(buffer, ext);
  }

  /** 当前生效的图床（供后台/接口展示） */
  function activeHost() {
    const type = opt('albumApiType', '').trim();
    if (type === 'qiniu') return 'qiniu';
    if (opt('albumApiUrl', '').trim() !== '') return (type || 'lsky');
    return 'local';
  }

  /* ══════════════════════════════════════════════════════════════════
     输出层 CDN 防盗链动态签名（逐行对照原版 lib/helpers.php tri3_qiniu_sign_url）
     两个分支（原版即为二选一）：
       A. 多吉云 Type A 签名：配置 dogyunKey 且 URL 主机命中
          qiniuDomain / albumApiDomain / img.<站点域> / test.<站点域> 时启用；
          同时按后台设置追加七牛图片处理参数 imageView2/0/w/<宽>/q/<质>[/format/webp]。
       B. 七牛时间戳防盗链：配置 qiniuTokenSecret + qiniuDomain 时启用，输出
          <域名><urlencode(path)>?sign=<md5(密钥+path+hex到期)> & t=<hex到期>。
     未配置密钥时原样返回（线上当前配置即如此，行为与不签名完全一致）。
     另含 tri3_sign_content_imgs() → signContentImgs()：对 HTML 里的 <img src>/<a href> 签名。
     ══════════════════════════════════════════════════════════════════ */
  function imgProxyOn() { return opt('imgProxyEnable', '1').trim() === '1'; }
  function imgWebpOn() { return opt('imgWebpEnable', '1').trim() === '1'; }
  function imgDefaultW() {
    const n = parseInt(opt('imgDefaultW', '800'), 10);
    return Math.max(32, Math.min(n > 0 ? n : 800, 2000));
  }
  function imgDefaultQ() {
    const n = parseInt(opt('imgDefaultQ', '80'), 10);
    return Math.max(30, Math.min(n > 0 ? n : 80, 95));
  }
  /** 原版 tri3_img_view2_params()：宽/质/WebP 一律取后台设置 */
  function view2Params(w, crop) {
    const width = w > 0 ? Math.max(32, Math.min(w, 2000)) : imgDefaultW();
    return 'imageView2/' + (crop ? 1 : 0) + '/w/' + width + '/q/' + imgDefaultQ() + (imgWebpOn() ? '/format/webp' : '');
  }
  /** PHP parse_url 的最小等价物：{host, path, query}；相对路径 host 为空串 */
  function parseUrl(u) {
    const s = String(u == null ? '' : u);
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(s);
    if (m) return { host: m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, ''), path: m[2] || '', query: m[3] || '' };
    const p = /^([^?#]*)(?:\?([^#]*))?/.exec(s);
    return { host: '', path: (p && p[1]) || '', query: (p && p[2]) || '' };
  }
  function hostOnly(v) {
    return String(v == null ? '' : v).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^[^@]*@/, '').toLowerCase();
  }
  /** PHP rawurlencode：RFC3986，额外编码 ! * ' ( ) */
  function rawUrlEncode(s) {
    return encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  const md5hex = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');

  /** 单个 URL 动态签名；nowSec 仅用于测试注入（默认当前秒），不影响线上行为 */
  function signUrl(url, nowSec) {
    let u = String(url == null ? '' : url).trim();
    if (u === '') return u;
    const now = (typeof nowSec === 'number') ? nowSec : Math.floor(Date.now() / 1000);

    /* ── 分支 A：多吉云 Type A ── */
    const dogeKey = opt('dogyunKey', '').trim();
    if (dogeKey !== '') {
      const h = parseUrl(u).host.toLowerCase();
      if (h !== '') {
        const doms = [];
        for (const d of [opt('qiniuDomain', ''), opt('albumApiDomain', '')]) {
          const t = String(d || '').trim();
          if (t === '') continue;
          const dh = parseUrl(t.indexOf('//') === -1 ? '//' + t : t).host.toLowerCase();
          if (dh !== '') doms.push(dh);
        }
        const siteHost = hostOnly(settings.siteUrl ? settings.siteUrl() : '');
        if (siteHost !== '') { doms.push('img.' + siteHost); doms.push('test.' + siteHost); }
        if (doms.includes(h)) {
          const dogeUid = '0';
          const dogeTtl = 604800;   /* 7 天：HTML 会被 CDN 缓存，签名必须活得比缓存久 */
          const path = parseUrl(u).path;
          if (path === '' || path === '/') return u;
          let query = parseUrl(u).query;
          if (query.indexOf('auth_key=') !== -1) return u;
          if (imgProxyOn() && /\.(jpe?g|png|webp)$/i.test(path) && query.indexOf('imageView2') === -1) {
            u += (query !== '' ? '&' : '?') + view2Params();
            query = parseUrl(u).query;
          }
          const win = 3600;   /* 1 小时对齐窗口：同一小时内 URL 稳定，CDN 才缓存得住 */
          const ts = Math.floor((now + dogeTtl) / win) * win;
          const rand = md5hex(path).slice(0, 24);
          const raw = path + '-' + ts + '-' + rand + '-' + dogeUid + '-' + dogeKey;
          return u + (query !== '' ? '&' : '?') + 'auth_key=' + ts + '-' + rand + '-' + dogeUid + '-' + md5hex(raw);
        }
      }
    }

    /* ── 分支 B：七牛时间戳防盗链 ── */
    if (u.indexOf('data:') === 0 || u.indexOf('img.php') !== -1) return u;
    const secret = opt('qiniuTokenSecret', '').trim();
    const domain = opt('qiniuDomain', '').trim().replace(/\/+$/, '');
    if (secret === '' || domain === '') return u;
    const p = parseUrl(u);
    if (p.path === '' || p.path === '/') return u;
    const domHost = parseUrl(domain).host;
    if (domHost !== '' && p.host.toLowerCase() !== domHost.toLowerCase()) return u;
    let ttl = parseInt(opt('qiniuTokenTtl', '86400'), 10);
    if (!(ttl >= 60)) ttl = 86400;
    const win = 600;
    const qT = (Math.floor((now + ttl) / win) * win).toString(16);
    const qEnc = rawUrlEncode(p.path).replace(/%2F/g, '/');
    const qSign = md5hex(secret + qEnc + qT);
    let out = domain + qEnc;
    /* 保留原 query（仅剥离已有的 sign / t，防二次签名，不改动其余编码） */
    if (p.query !== '') {
      const keep = [];
      for (const kv of p.query.split('&')) {
        const t = kv.trim();
        if (t === '') continue;
        const k = t.split('=')[0];
        if (k === 'sign' || k === 't') continue;
        keep.push(t);
      }
      if (keep.length) out += '?' + keep.join('&');
    }
    out += (out.indexOf('?') !== -1 ? '&' : '?') + 'sign=' + qSign + '&t=' + qT;
    return out;
  }

  /** 对 HTML 里的 <img src> / <a href> 做动态签名（对照 tri3_sign_content_imgs） */
  function signContentImgs(html) {
    let s = String(html == null ? '' : html);
    if (s === '' || (s.indexOf('<img') === -1 && s.indexOf('<a') === -1)) return s;
    s = s.replace(/(<img[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'][^>]*>)/gi, (m, a, src, b) => a + signUrl(src) + b);
    s = s.replace(/(<a[^>]*?\bhref\s*=\s*["'])([^"']+)(["'][^>]*>)/gi, (m, a, href, b) => a + signUrl(href) + b);
    return s;
  }

  /** 递归对所有输出串签名（原版在各输出点逐个调用；此处统一在响应层做，等价且不漏） */
  function signDeep(value, depth) {
    const d = depth || 0;
    if (value == null || d > 10) return value;
    if (typeof value === 'string') return (value.indexOf('<') !== -1) ? signContentImgs(value) : signUrl(value);
    if (Array.isArray(value)) return value.map((v) => signDeep(v, d + 1));
    if (typeof value === 'object') {
      const o = {};
      for (const k of Object.keys(value)) o[k] = signDeep(value[k], d + 1);
      return o;
    }
    return value;
  }

  return { upload, uploadLocal, uploadRemote, uploadQiniu, upyunSign, activeHost, signUrl, signContentImgs, signDeep, view2Params, MAX_SIZE };
}
