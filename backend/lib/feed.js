/**
 * 小组件数据源：天气 / 一言 / 今日诗词（对照原版 TriM3）
 *
 *   天气：lib/widgets.php  tri_widgets_weather_get() + tri_widgets_weather_refresh()
 *         + tri_widgets_amap_city() / tri_widgets_amap_refresh()
 *   一言：原版由前台直连 https://v1.hitokoto.cn/（assets/js/widgets.js），此处收归后端代理
 *   诗词：api/widget-api.php  case 'poem'（jinrishici token → sentence），缓存 600 秒
 *
 * 缓存策略与原版一致：
 *   天气 2700 秒（原版 redis group=weather + cache/weather/*.json）
 *   诗词 600 秒（原版 redis group=widgets + cache/poem.json）
 *   高德 IP 定位 2700 秒
 * lill 无 redis，统一落到 sqlite 表 api_cache（key → data/ts），另加一层内存缓存。
 */
const TTL_WEATHER = 2700;
const TTL_POEM = 600;
const TTL_HITOKOTO = 300;
const TTL_AMAP = 2700;

const UA = 'TriM3/1.0';

export function createFeed({ db, settings }) {
  /* ── 通用缓存（sqlite + 内存两级） ── */
  db.exec(`CREATE TABLE IF NOT EXISTS api_cache (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, ts INTEGER NOT NULL);`);
  const stmtGet = db.prepare('SELECT data, ts FROM api_cache WHERE cache_key = ?');
  const stmtPut = db.prepare('INSERT INTO api_cache (cache_key, data, ts) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET data = excluded.data, ts = excluded.ts');
  const mem = new Map();

  function cacheGet(key, ttl) {
    const now = Date.now();
    const m = mem.get(key);
    if (m && now - m.ts < ttl * 1000) return m.data;
    try {
      const row = stmtGet.get(key);
      if (row && now - Number(row.ts) * 1000 < ttl * 1000) {
        let data = null;
        try { data = JSON.parse(row.data); } catch { data = null; }
        if (data !== null) { mem.set(key, { data, ts: Number(row.ts) * 1000 }); return data; }
      }
    } catch { /* 缓存读取失败不影响主流程 */ }
    return null;
  }
  function cacheSet(key, data) {
    const now = Date.now();
    mem.set(key, { data, ts: now });
    try { stmtPut.run(key, JSON.stringify(data), Math.floor(now / 1000)); } catch { /* ignore */ }
  }
  /* 过期兜底：数据取不到时的陈旧值（原版 $triHas ? $triC : null 的同款思路） */
  function cacheGetStale(key) {
    const m = mem.get(key);
    if (m) return m.data;
    try {
      const row = stmtGet.get(key);
      if (row) { try { return JSON.parse(row.data); } catch { return null; } }
    } catch { /* ignore */ }
    return null;
  }

  const fetchJson = async (url, headers = {}, timeoutMs = 5000) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ac.signal });
      const t = await r.text();
      try { return JSON.parse(t); } catch { return null; }
    } catch { return null; } finally { clearTimeout(timer); }
  };

  /* ── 和风天气凭据：查询参数 → 主题设置 qweatherKey/qweatherHost → 天气小组件设置 ── */
  function weatherCred(qKey, qHost) {
    let key = String(qKey || '').trim();
    let host = String(qHost || '').trim();
    if (key === '') key = settings.opt('qweatherKey', '').trim();
    if (host === '') host = settings.opt('qweatherHost', '').trim();
    if (key === '' || host === '') {
      const lists = [settings.widgetList('leftWidgets'), settings.widgetList('rightWidgets')];
      for (const list of lists) {
        for (const w of list) {
          if (!w || !w.settings) continue;
          if (w.type !== 'weather' && w.type !== 'todayweather') continue;
          if (key === '') key = String(w.settings.apikey || '').trim();
          if (host === '') host = String(w.settings.host || '').trim();
        }
        if (key !== '' && host !== '') break;
      }
    }
    return { key, host };
  }

  /**
   * 联网取数（对照 tri_widgets_weather_refresh）
   * 新版 host 含 qweatherapi.com → 请求头 X-QW-Api-Key + /geo/v2/city/lookup
   * 旧版 → query key= + /v2/city/lookup（geoapi / devapi）
   */
  async function weatherRefresh(key, loc, host) {
    host = String(host || '').trim();
    const isNew = host !== '' && host.includes('qweatherapi.com');
    const geoHost = isNew ? host : 'geoapi.qweather.com';
    const apiHost = isNew ? host : 'devapi.qweather.com';
    const hdr = isNew ? { 'X-QW-Api-Key': key } : {};
    const q = isNew ? '' : ('key=' + encodeURIComponent(key));

    let id = String(loc || '');
    if (!/^\d{9}$/.test(id)) {
      const geoPath = isNew ? '/geo/v2/city/lookup' : '/v2/city/lookup';
      const geo = await fetchJson(`https://${geoHost}${geoPath}?location=${encodeURIComponent(loc)}${q ? '&' + q : ''}`, hdr, 3000);
      if (geo && geo.code === '200' && geo.location && geo.location[0] && geo.location[0].id) id = String(geo.location[0].id);
      else return null;
    }

    const [nowJ, d7J] = await Promise.all([
      fetchJson(`https://${apiHost}/v7/weather/now?location=${id}${q ? '&' + q : ''}`, hdr, 3000),
      fetchJson(`https://${apiHost}/v7/weather/7d?location=${id}${q ? '&' + q : ''}`, hdr, 3000),
    ]);
    if (!nowJ || nowJ.code !== '200' || !nowJ.now) return null;

    const result = {
      now: {
        temp: String(nowJ.now.temp ?? ''),
        text: String(nowJ.now.text ?? ''),
        icon: String(nowJ.now.icon ?? ''),
        feels: String(nowJ.now.feelsLike ?? ''),
        hum: String(nowJ.now.humidity ?? ''),
        wind: String(nowJ.now.windDir ?? '').trim() + ' ' + String(nowJ.now.windScale ?? ''),
      },
      days: [],
    };
    if (d7J && d7J.code === '200' && d7J.daily && d7J.daily.length) {
      result.days = d7J.daily.slice(0, 7).map(d => ({
        week: weekName(d.fxDate),
        text: String(d.textDay ?? ''),
        icon: String(d.iconDay ?? ''),
        tempMin: String(d.tempMin ?? ''),
        tempMax: String(d.tempMax ?? ''),
        sunrise: String(d.sunrise ?? ''),
        sunset: String(d.sunset ?? ''),
      }));
    }
    return result;
  }

  function weekName(dateStr) {
    const d = new Date(String(dateStr || '').replace(/-/g, '/'));
    if (isNaN(d.getTime())) return '';
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }

  /**
   * 天气（对外统一出口）
   * 返回 lill 前台契约的扁平字段 + 原版 tri_widgets 的 now/days + 和风原始 now/daily
   */
  async function weather(city, { key: qKey, host: qHost } = {}) {
    const loc = String(city || '').trim() || '北京';
    const blank = {
      ok: false, source: 'none', city: loc,
      temperature: '', weather: '', humidity: '', wind: '',
      now: {}, days: [], daily: [],
      updated: Math.floor(Date.now() / 1000),
    };
    const { key, host } = weatherCred(qKey, qHost);
    if (key === '') {
      return { ...blank, msg: '未配置和风天气 Key：请在天气组件里填写「和风 API Key」与「API Host」' };
    }
    const ck = 'weather:' + JSON.stringify([key.slice(-6), host, loc]);
    let data = cacheGet(ck, TTL_WEATHER);
    if (!data) {
      const fresh = await weatherRefresh(key, loc, host);
      if (fresh) { cacheSet(ck, fresh); data = fresh; }
      else data = cacheGetStale(ck);   // 取数失败时退回旧缓存
    }
    if (!data) {
      return { ...blank, source: 'error', msg: '天气数据获取失败，请核对「和风 API Key / API Host / 城市名」是否正确' };
    }

    const now = data.now || {};
    return {
      ok: true,
      source: 'qweather',
      city: loc,
      /* lill 前台 /weather?city= 的扁平契约 */
      temperature: now.temp,
      weather: now.text,
      humidity: now.hum,
      wind: now.wind,
      /* 原版 tri_widgets_weather_get 结构 */
      now,
      days: data.days || [],
      /* 和风原生字段（供 R.weather / R.todayweather 渲染 7 天预报） */
      daily: (data.days || []).map(d => ({
        fxDate: '', iconDay: d.icon, textDay: d.text, tempMin: d.tempMin, tempMax: d.tempMax,
        sunrise: d.sunrise, sunset: d.sunset, week: d.week,
      })),
      updated: Math.floor(Date.now() / 1000),
    };
  }

  /** 高德 IP 定位（对照 tri_widgets_amap_refresh） */
  async function amapCity(amapKey, ip) {
    const key = String(amapKey || '').trim();
    const addr = String(ip || '').trim();
    if (key === '' || addr === '') return '';
    const ck = 'amap:' + addr;
    const cached = cacheGet(ck, TTL_AMAP);
    if (cached) return cached;
    const j = await fetchJson('https://restapi.amap.com/v3/ip?key=' + encodeURIComponent(key) + '&ip=' + encodeURIComponent(addr), {}, 3000);
    let out = '';
    if (j && String(j.status) === '1') {
      let c = j.city;
      if (Array.isArray(c)) c = '';
      c = String(c || '').trim();
      if (c === '' || c === '[]') {
        let p = j.province;
        if (Array.isArray(p)) p = '';
        c = String(p || '').trim();
      }
      if (c !== '' && c !== '[]') out = c.replace(/市辖区|省直辖/g, '');
    }
    if (out !== '') cacheSet(ck, out);
    return out;
  }

  /** 一言（原版前台直连 v1.hitokoto.cn，这里改由后端代理并缓存） */
  async function hitokoto(cat) {
    const c = String(cat || '').trim();
    const ck = 'hitokoto:' + c;
    let data = cacheGet(ck, TTL_HITOKOTO);
    if (!data) {
      const url = 'https://v1.hitokoto.cn/?encode=json' + (c ? '&c=' + encodeURIComponent(c) : '');
      const j = await fetchJson(url, {}, 5000);
      if (j && j.hitokoto) {
        data = {
          hitokoto: String(j.hitokoto),
          content: String(j.hitokoto),
          from: String(j.from || ''),
          from_who: String(j.from_who || ''),
          cat: String(j.type || c || ''),
          uuid: String(j.uuid || ''),
        };
        cacheSet(ck, data);
      } else {
        data = cacheGetStale(ck);
      }
    }
    if (!data) data = { hitokoto: '但行好事，莫问前程。', content: '但行好事，莫问前程。', from: '一言', from_who: '', cat: c, uuid: '' };
    return data;
  }

  /** 今日诗词（对照 api/widget-api.php case 'poem'） */
  async function poem() {
    const ck = 'poem';
    let data = cacheGet(ck, TTL_POEM);
    if (data && data.ok && data.content) return data;
    const tokJ = await fetchJson('https://v2.jinrishici.com/token', {}, 10000);
    const tok = (tokJ && typeof tokJ.data === 'string') ? tokJ.data : '';
    let out = { ok: false };
    if (tok !== '') {
      const s = await fetchJson('https://v2.jinrishici.com/sentence', { 'X-User-Token': tok }, 10000);
      if (s && s.data && s.data.content) {
        out = {
          ok: true,
          content: String(s.data.content),
          origin: s.data.origin && s.data.origin.title ? String(s.data.origin.title) : '',
          author: s.data.origin && s.data.origin.author ? String(s.data.origin.author) : '',
        };
        cacheSet(ck, out);
      }
    }
    if (!out.ok) {
      const stale = cacheGetStale(ck);
      if (stale && stale.ok && stale.content) return stale;
      return { ok: false, content: '', origin: '', author: '' };
    }
    return out;
  }

  /** 清理过期缓存（供后台“清理缓存”用） */
  function purge(prefix) {
    try {
      if (prefix) db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(prefix + '%');
      else db.prepare('DELETE FROM api_cache').run();
      mem.clear();
      return true;
    } catch { return false; }
  }

  return { weather, hitokoto, poem, amapCity, weatherRefresh, purge, weatherCred };
}
