/**
 * 评论反垃圾 / 安全引擎（逐条对照原版 TriM3 lib/helpers.php）
 *
 *   tri3_spam_settings()     → spamSettings()
 *   tri3_spam_check()        → spamCheck()
 *   tri3_spam_ai_check()     → spamAiCheck()
 *   tri3_comment_rate_limit()→ rateLimit()
 *
 * 设计原则（原版原话）：宁可放过，不可误杀 —— 命中默认「待审核」而非直接拒绝，
 * 高置信命中（蜜罐 / IP / 邮箱黑名单）才直接丢弃。
 *
 * 主题设置键（与 theme.json「评论」组一致）：
 *   spamEnable spamMode spamKeywords spamMaxLinks spamMinLen spamHp spamIpList spamMailList
 *   spamAction spamRateEnable spamRateMin spamRateTen
 *   spamAiEnable spamAiKey spamAiModel spamAiEndpoint spamAiScope spamAiAction spamAiTimeout
 *
 * ⚠ 与原版的一处刻意差异（已在交付文档中说明）：
 *   原版 spam_check 第 7 条 `if (preg_match(...))` 的右花括号写在了第 12 条之后
 *   （helpers.php 行 2047 开、行 2077 闭），导致第 10/11/12 条（纯链接评论、
 *   重复字符轰炸、重复评论）被嵌进了第 7 条的判真分支里，实际永不执行（死代码）。
 *   从缩进与注释编号可见作者本意是三条独立规则，故此处按**本意**实现为顶层规则。
 *   三条都是「转待审核」级，不会误杀放行，安全性只增不减。
 */

const MULTILANG_EN = /(?:\bbet\b|\bcasino\b|\bbonus\b|\bpromo\b|\blottery\b|\bgambl|\baffiliate\b|\bvip\b|earn money|make money|sign ?up|free credit|deposit)/i;
const MULTILANG_RU = ['работа', 'заработ', 'онлайн школа', 'онлайн-школа', 'ваканси', 'заработать', 'деньги', 'курс', 'казино', 'ставки', 'заработок'];
const MULTILANG_TR = ['bukmeker', 'mərc', 'bahis', 'kumar', 'deneme bonusu', 'canlı bahis', 'qazan', 'pul qazan'];
const OBFUSCATED = /(?:eval\s*\(\s*function|unescape\s*\(|fromCharCode\s*\(|<script[\s>]|document\.cookie|String\.fromCharCode)/i;
const BOT_AGENT = /(curl|wget|python-requests|Go-http-client|scrapy|okhttp|Java\/|libwww|httpunit|masscan)/i;
const CYRILLIC_ETC = /[\u0400-\u052F\u0600-\u06FF\u0590-\u05FF\u10A0-\u10FF\u0530-\u058F]/gu;

const mbLen = (s) => Array.from(String(s || '')).length;
const mbLower = (s) => String(s || '').toLowerCase();
const splitList = (s) => String(s || '').split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean);

export function createSecurity({ db, settings }) {
  /** 对照 tri3_spam_settings()：统一默认值，旧配置自动兼容 */
  function spamSettings() {
    let m = settings.opt('spamMode', 'normal');
    if (!['loose', 'normal', 'strict'].includes(m)) m = 'normal';
    let act = settings.opt('spamAction', 'pending');
    if (!['pending', 'reject'].includes(act)) act = 'pending';
    let aiAct = settings.opt('spamAiAction', 'pending');
    if (!['pending', 'reject'].includes(aiAct)) aiAct = 'pending';
    let aiScope = settings.opt('spamAiScope', 'suspicious');
    if (!['suspicious', 'all'].includes(aiScope)) aiScope = 'suspicious';
    const int = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
    const aiModel = settings.opt('spamAiModel', '').trim() || 'doubao-seed-2-1-pro-260628';
    const aiEndpoint = settings.opt('spamAiEndpoint', '').trim() || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    let aiTimeout = int(settings.opt('spamAiTimeout', '15'));
    aiTimeout = Math.max(2, Math.min(30, aiTimeout || 15));
    return {
      enable: int(settings.opt('spamEnable', '1')),
      mode: m,
      keywords: settings.opt('spamKeywords', '').trim(),
      maxLinks: Math.max(0, int(settings.opt('spamMaxLinks', '3'))),
      minLen: Math.max(0, int(settings.opt('spamMinLen', '2'))),
      hp: int(settings.opt('spamHp', '1')),
      ipList: settings.opt('spamIpList', '').trim(),
      mailList: settings.opt('spamMailList', '').trim(),
      action: act,
      rateEnable: int(settings.opt('spamRateEnable', '1')),
      rateMin: Math.max(0, int(settings.opt('spamRateMin', '3'))),
      rateTen: Math.max(0, int(settings.opt('spamRateTen', '10'))),
      aiEnable: int(settings.opt('spamAiEnable', '0')),
      aiKey: settings.opt('spamAiKey', '').trim(),
      aiModel,
      aiEndpoint,
      aiScope,
      aiAction: aiAct,
      aiTimeout,
    };
  }

  const pass = { ok: true, pending: false, reason: '', silent: false };
  const hit = (reason, { pending = true, silent = false } = {}) => ({ ok: false, pending, reason, silent });

  /**
   * 规则引擎（对照 tri3_spam_check）
   * @param {object} d { text, author, mail, ip, agent, hp }
   * @param {string} table 重复评论检测所用表（comments / moment_comments）
   */
  function spamCheck(d = {}, table = 'comments') {
    const s = spamSettings();
    if (!s.enable) return pass;
    const text = String(d.text || '');
    const author = String(d.author || '');
    const mail = String(d.mail || '');
    const ip = String(d.ip || '');
    const agent = String(d.agent || '');
    const hp = String(d.hp || '');

    /* 1) 蜜罐：隐藏字段被填 → 高置信 bot，静默丢弃 */
    if (s.hp && hp !== '') return hit('honeypot', { silent: true });

    /* 2) IP 黑名单（精确匹配） */
    if (s.ipList !== '' && ip !== '') {
      for (const one of splitList(s.ipList)) if (one && ip === one) return hit('ip_blacklist', { pending: false });
    }

    /* 3) 邮箱域名黑名单（精确域名或子域名） */
    if (s.mailList !== '' && mail !== '') {
      let dom = '';
      const at = mail.lastIndexOf('@');
      dom = at >= 0 ? mail.slice(at + 1) : mail;
      dom = mbLower(dom).trim();
      for (const raw of splitList(s.mailList)) {
        const one = mbLower(raw);
        if (one === '' || dom === '') continue;
        if (dom === one || dom.slice(-(one.length + 1)) === '.' + one) return hit('mail_blacklist', { pending: false });
      }
    }

    /* 4) 黑名单关键词：正文 / 昵称命中 */
    if (s.keywords !== '') {
      for (const kw of splitList(s.keywords)) {
        if (mbLower(text).includes(mbLower(kw)) || mbLower(author).includes(mbLower(kw))) {
          return hit('keyword:' + Array.from(kw).slice(0, 20).join(''), { pending: s.action === 'pending' });
        }
      }
    }

    /* 5) 链接数量超阈值 */
    if (s.maxLinks > 0) {
      const urls = text.match(/https?:\/\/\S+/gi) || [];
      if (urls.length > s.maxLinks) return hit('too_many_links');
    }

    /* 6) 最短长度（去空白） */
    if (s.minLen > 0) {
      const plain = text.replace(/\s+/g, '').trim();
      const len = mbLen(plain);
      if (len > 0 && len < s.minLen) return hit('too_short');
    }

    /* 7) 恶意代码 / 混淆脚本特征 */
    if (OBFUSCATED.test(text)) return hit('obfuscated_code');

    /* 10) 纯链接评论（去掉 http(s) 链接后无实质文字） */
    const noUrl = text.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, '').trim();
    if (noUrl === '' && /https?:\/\//i.test(text)) return hit('link_only');

    /* 11) 重复字符轰炸（如 aaaa.../9999...） */
    if (mbLen(text) > 16 && /(.)\1{11,}/u.test(text)) return hit('repeated_chars');

    /* 12) 重复评论：同一 IP 近 10 分钟提交过相同正文 */
    const plain2 = text.trim();
    if (plain2 !== '' && ip !== '') {
      try {
        const row = db.prepare(
          `SELECT id FROM ${table} WHERE ip = ? AND content = ? AND created_at > datetime('now','-600 seconds') LIMIT 1`
        ).get(ip, plain2);
        if (row) return hit('duplicate');
      } catch { /* 表结构差异不阻塞评论 */ }
    }

    /* 13) 内置多语言垃圾特征（英文 / 俄语 / 突厥语系 / 西里尔等字符占比） */
    let langHit = false;
    if (MULTILANG_EN.test(text)) langHit = true;
    const lower = mbLower(text);
    if (!langHit) {
      for (const w of MULTILANG_RU) if (w && lower.includes(w)) { langHit = true; break; }
    }
    if (!langHit) {
      for (const w of MULTILANG_TR) if (w && lower.includes(w)) { langHit = true; break; }
    }
    if (!langHit) {
      const m = text.match(CYRILLIC_ETC);
      const cyr = m ? m.length : 0;
      const len3 = mbLen(text);
      if (len3 >= 20 && cyr > 0 && cyr / len3 > 0.25) langHit = true;
    }
    if (langHit) return hit('multilang_spam');

    /* 严格模式附加规则（默认不启用，避免误杀） */
    if (s.mode === 'strict') {
      /* 8) 空 UA / 明显爬虫 UA */
      if (agent === '' || BOT_AGENT.test(agent)) return hit('bot_agent');
      /* 9) 链接密度：链接字符占比 > 50% 且总长 > 20 */
      const urls2 = text.match(/https?:\/\/\S+/gi) || [];
      let linkChars = 0;
      urls2.forEach(u => { linkChars += u.length; });
      const total = Buffer.byteLength(text, 'utf8');
      if (total > 20 && linkChars > total * 0.5) return hit('link_dense');
      /* 10) 连续重复字符 ≥ 20 */
      if (/(.)\1{19,}/u.test(text)) return hit('repeated');
    }

    return pass;
  }

  /**
   * 评论全局限速（对照 tri3_comment_rate_limit）
   * 60 秒内最多 rateMin 条；600 秒内最多 rateTen 条。
   * 本机调试 IP 不限制。
   */
  function rateLimit(ip, table = 'comments') {
    const s = spamSettings();
    if (!s.rateEnable) return { ok: true, msg: '' };
    const addr = String(ip || '');
    if (addr === '' || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost') return { ok: true, msg: '' };
    const min = s.rateMin;
    const ten = s.rateTen;
    if (min <= 0 && ten <= 0) return { ok: true, msg: '' };
    const count = (sec) => {
      try {
        const row = db.prepare(
          `SELECT COUNT(*) AS c FROM ${table} WHERE ip = ? AND created_at > datetime('now', ?)`
        ).get(addr, `-${sec} seconds`);
        return row ? Number(row.c) || 0 : 0;
      } catch { return 0; }
    };
    try {
      if (min > 0 && count(60) >= min) return { ok: false, msg: '评论太频繁了，稍后再试' };
      if (ten > 0 && count(600) >= ten) return { ok: false, msg: '评论太频繁了，稍后再试' };
    } catch { return { ok: true, msg: '' }; }
    return { ok: true, msg: '' };
  }

  /**
   * 豆包 AI 语义过滤（对照 tri3_spam_ai_check）
   * 未启用 / 未填 Key / 非垃圾 / 边缘分数 → null（放行）
   * AI 只「加刑」不「减刑」；配置类错误放行，网络超时转待审核。
   */
  async function spamAiCheck(d = {}) {
    const s = spamSettings();
    if (!s.enable || !s.aiEnable || s.aiKey === '') return null;
    let text = String(d.text || '').trim();
    if (text === '') return null;
    text = Array.from(text).slice(0, 600).join('');
    const author = Array.from(String(d.author || '')).slice(0, 50).join('');

    const payload = {
      model: s.aiModel,
      messages: [
        {
          role: 'system',
          content: '你是博客评论内容审核助手。判断用户评论是否为垃圾评论。垃圾评论包括：广告推广、引流、博彩、色情、代写、SEO 外链、刷屏灌水、无意义内容，不限于中文——任何语言（英语、俄语、阿塞拜疆语、土耳其语、阿拉伯语等）的博彩、招聘、网赚、课程、促销推广都是垃圾。注意：1. 评论者昵称也是重要判断依据：昵称包含品牌名或推广关键词（如 1xbet、casino、bonus、promo、school、online、rabota、вакансии 等）并带随机字母/数字后缀，是典型垃圾评论特征；2. 软广告常伪装成个人经历叙述（如"我在很多博彩公司玩过""犹豫要不要换学校然后发现某在线学校""朋友推荐了一个工作平台"），内容围绕推广某个品牌或服务（博彩公司、在线学校、招聘平台、理财课程等）就属于垃圾，即使没有网址；3. 正常交流、提问、讨论（无论何种语言）一律 spam=false。只输出 JSON，格式：{"spam":true或false,"score":0到100的整数,"reason":"简短中文原因"}。推广意图明确时坚决拦截，勿因语言障碍放过。',
        },
        { role: 'user', content: `评论者昵称：${author}\n评论内容：\n${text}` },
      ],
      temperature: 0.1,
      max_tokens: 80,
      stream: false,
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), s.aiTimeout * 1000);
    let respText = '';
    try {
      const resp = await fetch(s.aiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.aiKey },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      respText = await resp.text();
    } catch (e) {
      clearTimeout(timer);
      const msg = e && e.name === 'AbortError' ? ('请求超时（' + s.aiTimeout + 's）') : String((e && e.message) || e);
      console.warn('🤖 AI 垃圾过滤请求失败:', msg);
      return { ok: false, pending: true, reason: 'ai_timeout', error: 'AI 请求失败（网络错误/超时）：' + msg + '（已转待审核，可适当调大「AI 超时」）' };
    }
    clearTimeout(timer);

    let j = null;
    try { j = JSON.parse(respText); } catch { j = null; }
    if (j && j.error) {
      const em = String((j.error && j.error.message) || JSON.stringify(j.error)).slice(0, 120);
      console.warn('🤖 AI 接口错误:', em);
      return { ok: true, pending: false, reason: '', error: 'AI 接口错误：' + em };
    }
    const content = String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    if (content.trim() === '') {
      return { ok: false, pending: true, reason: 'ai_empty', error: 'AI 返回内容为空（模型名/接入点可能无效），已转待审核' };
    }
    let cj = null;
    try { cj = JSON.parse(content.trim()); } catch { cj = null; }
    if (!cj || typeof cj !== 'object') {
      const m = content.match(/\{(?:[^{}]|"[^"]*")*\}/s);
      if (m) { try { cj = JSON.parse(m[0]); } catch { cj = null; } }
    }
    if (!cj || typeof cj !== 'object' || !('spam' in cj)) {
      return { ok: false, pending: true, reason: 'ai_parse', error: 'AI 返回格式无法解析，已转待审核' };
    }
    const isSpam = !!cj.spam;
    const score = Math.max(0, Math.min(100, parseInt(cj.score, 10) || 0));
    if (!isSpam && score < 70) return { ok: true, pending: false, reason: '' };
    if (isSpam || score >= 85) {
      let reason = String(cj.reason || '疑似垃圾评论');
      reason = Array.from(reason).slice(0, 40).join('');
      return { ok: false, pending: s.aiAction === 'pending', reason: 'ai:' + reason };
    }
    return null;
  }

  return { spamSettings, spamCheck, rateLimit, spamAiCheck };
}
