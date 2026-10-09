/**
 * 邮件通知（对照原版 TriM3 lib/helpers.php 的邮件子系统，用 nodemailer 重写）
 *
 *   tri3_smtp_send()      → 本节 createTransport()
 *   tri3_send_mail()      → send()
 *   tri3_mail_tpl()       → mailTpl()   （HTML 模板逐行照搬原版，含变量名）
 *   tri3_notify_comment() → notifyComment()
 *
 * 主题设置键（与 theme.json「通知」组一致）：
 *   mailEnable mailMode smtpHost smtpPort smtpSecure smtpUser smtpPass
 *   mailFromName mailFromAddr mailAdminTo mailNotifyAdmin mailReplyNotify
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch {
  console.warn('⚠ nodemailer 未安装，邮件通知不可用（cd backend && npm install nodemailer）');
}

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const nl2br = (s) => String(s || '').replace(/\r\n|\r|\n/g, '<br />\n');

const emojiEncode = (s) => '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?=';

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

function fmtTime(d) {
  const x = d instanceof Date ? d : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

export function createMail({ settings }) {
  let cached = null;      // { key, transport }
  let lastError = '';

  /** 解析 SMTP 配置（对照 tri3_smtp_send 的取值与回退顺序） */
  function config() {
    const host = settings.opt('smtpHost', '').trim();
    let port = parseInt(settings.opt('smtpPort', '465'), 10);
    if (!port || port <= 0 || port > 65535) port = 465;
    const user = settings.opt('smtpUser', '').trim();
    const pass = settings.opt('smtpPass', '');
    const secure = settings.opt('smtpSecure', 'ssl');
    let from = settings.opt('mailFromAddr', '').trim();
    if (from === '') from = user !== '' ? user : settings.adminMail();
    const name = settings.opt('mailFromName', '').trim();
    const mode = settings.opt('mailMode', 'smtp');
    return { host, port, user, pass, secure, from, name, mode };
  }

  function transport() {
    const c = config();
    if (!nodemailer) { lastError = 'nodemailer 未安装'; return null; }
    if (c.mode === 'mail') {
      const key = 'sendmail:' + c.from;
      if (cached && cached.key === key) return cached.transport;
      const t = nodemailer.createTransport({ sendmail: true, newline: 'unix', encoding: 'utf-8' });
      cached = { key, transport: t };
      return t;
    }
    if (c.host === '' || c.from === '') { lastError = 'SMTP 未配置（smtpHost / 发件邮箱为空）'; return null; }
    const key = [c.host, c.port, c.user, c.pass, c.secure, c.from, c.name].join('\u0001');
    if (cached && cached.key === key) return cached.transport;
    const t = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure === 'ssl',                 // ssl → 直连 TLS，tls/none → 明文后 STARTTLS
      requireTLS: c.secure === 'tls',
      auth: (c.user !== '' && c.pass !== '') ? { user: c.user, pass: c.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 25000,
      tls: { rejectUnauthorized: false },
    });
    cached = { key, transport: t };
    return t;
  }

  /** 对照 tri3_send_mail：收件人非法直接 false；再从统一入口发信 */
  async function send(to, subject, html) {
    const rcpt = String(to || '').trim();
    if (rcpt === '' || !isEmail(rcpt)) return false;
    const c = config();
    const t = transport();
    if (!t) { lastError = lastError || '邮件通道不可用'; return false; }
    try {
      await t.sendMail({
        from: c.name !== '' ? { name: c.name, address: c.from } : c.from,
        to: rcpt,
        subject,
        html,
        headers: c.mode === 'mail' ? { 'X-Mailer': 'lill-trim3' } : undefined,
      });
      lastError = '';
      return true;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      console.warn('✉ 邮件发送失败:', lastError);
      return false;
    }
  }

  /** 邮件 HTML 模板：逐行对照 tri3_mail_tpl（MD3 风格卡片） */
  function mailTpl(kind, d = {}) {
    let pri = settings.opt('primaryColor', '#6750a4').trim();
    if (pri === '' || pri[0] !== '#') pri = '#6750a4';
    const site = settings.siteName();
    const siteUrl = settings.siteUrl();
    const author = esc(d.author || '访客');
    const content = nl2br(esc(d.content || ''));
    const time = esc(d.time || '');
    let link = String(d.link || '').trim();
    if (link === '') link = siteUrl;
    link = esc(link);
    const waitTip = d.waiting
      ? '<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:12px"><tr><td style="background:#fdf3e7;border:1px solid #f5d9b8;border-radius:12px;padding:11px 14px"><div style="font-size:13px;color:#9a6700;line-height:1.7">该评论当前为「待审核」状态，请前往后台审核后再公开展示。</div></td></tr></table>'
      : '';
    const isReply = kind === 'reply';
    const title = isReply ? '你的评论收到了新回复' : '收到一条新评论';
    const slogan = isReply ? '博主回复了你在本站的评论' : '有人在你站点留下了新的声音';
    const rawAuthor = String(d.author || '访客').replace(/<[^>]*>/g, '').trim();
    let siteChar = String(site || '').replace(/<[^>]*>/g, '').trim();
    siteChar = siteChar !== '' ? Array.from(siteChar)[0] : 'B';
    const siteLogo = settings.opt('logoUrl', '').trim();
    const iconBlock = siteLogo !== ''
      ? '<table cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="width:56px;height:56px;border-radius:14px;overflow:hidden"><img src="' + esc(siteLogo) + '" alt="" width="56" height="56" style="display:block;width:56px;height:56px;border:0;border-radius:14px"></td></tr></table>'
      : '<table cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="width:56px;height:56px;border-radius:14px;background:#f0f0f4;font-size:24px;font-weight:700;color:' + pri + ';line-height:56px">' + esc(siteChar) + '</td></tr></table>';

    return `<!DOCTYPE html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif">
<center role="presentation" style="width:100%;table-layout:fixed">
  <table width="100%" bgcolor="#f5f5f7" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="padding:40px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px">
      <tr><td style="padding:44px 40px 6px">
        <!-- 顶部图标 -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="padding-bottom:22px">
          ${iconBlock}
        </td></tr></table>
        <!-- 标题 -->
        <div style="text-align:center;font-size:24px;font-weight:700;color:#1d1d1f;letter-spacing:-.01em;line-height:1.35">${title}</div>
        <!-- 副标题 -->
        <div style="text-align:center;font-size:14px;color:#6e6e73;margin-top:8px;line-height:1.6">${slogan}</div>
        <!-- 作者 / 时间 -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:30px">
          <tr><td style="background:#fbfbfd;border:1px solid #e8e8ed;border-radius:14px;padding:13px 18px">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>
              <td style="font-size:15px;font-weight:600;color:#1d1d1f">${esc(rawAuthor)}</td>
              <td align="right" style="font-size:13px;color:#86868b">${time}</td>
            </tr></table>
          </td></tr>
        </table>
        <!-- 评论内容 -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:12px">
          <tr><td style="background:#fbfbfd;border:1px solid #e8e8ed;border-left:3px solid ${pri};border-radius:12px;padding:16px 18px">
            <div style="font-size:15px;line-height:1.75;color:#1d1d1f;word-break:break-word">${content}</div>
          </td></tr>
        </table>
        ${waitTip}
        <!-- 主按钮 -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:26px">
          <tr><td>
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>
              <td align="center" style="background:${pri};border-radius:12px">
                <a href="${link}" style="display:block;padding:13px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px">查看内容</a>
              </td>
            </tr></table>
          </td></tr>
        </table>
        <!-- 页脚 -->
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:36px;border-top:1px solid #ececf0">
          <tr><td align="center" style="padding:22px 0 36px">
            <div style="font-size:13px;color:#86868b;line-height:1.7">本邮件由 ${esc(site)} 自动发送，请勿直接回复</div>
            <div style="font-size:13px;line-height:1.7"><a href="${esc(siteUrl)}" style="color:${pri};text-decoration:none">${esc(siteUrl)}</a></div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr></table>
</center>
</body>
</html>`;
  }

  /**
   * 评论通知（对照 tri3_notify_comment）
   * c = { author, text, created(时间戳或字符串), pageurl, status, parent, isOwner, parentMail, parentQq }
   * 访客评论 → 通知站长；站长回复（parent>0 且已通过） → 通知被回复访客
   */
  async function notifyComment(c = {}) {
    if (!settings.switchOpt('mailEnable', '1')) return { sent: false, reason: 'disabled' };
    const isOwner = !!c.isOwner;
    const parent = parseInt(c.parent, 10) || 0;
    const status = String(c.status || 'approved');
    const when = c.created instanceof Date ? c.created : (typeof c.created === 'number' ? new Date(c.created * 1000) : new Date());

    if (!isOwner) {
      if (!settings.switchOpt('mailNotifyAdmin', '1')) return { sent: false, reason: 'admin-notify-off' };
      let to = settings.opt('mailAdminTo', '').trim();
      if (to === '') to = settings.adminMail();
      if (to === '') return { sent: false, reason: 'no-admin-mail' };
      const d = {
        author: String(c.author || '访客'),
        content: String(c.text || ''),
        time: fmtTime(when),
        link: String(c.pageurl || ''),
        waiting: status === 'waiting' || status === 'pending',
      };
      const ok = await send(to, '【' + settings.siteName() + '】收到一条新评论', mailTpl('new', d));
      return { sent: ok, to, kind: 'admin' };
    }

    if (parent > 0 && settings.switchOpt('mailReplyNotify', '1') && status === 'approved') {
      const pqq = String(c.parentQq || '').replace(/\D/g, '');
      let to = '';
      if (pqq !== '') to = pqq + '@qq.com';
      else if (isEmail(c.parentMail)) to = String(c.parentMail).trim();
      if (to === '') return { sent: false, reason: 'no-parent-mail' };
      const d = {
        author: String(c.author || '博主'),
        content: String(c.text || ''),
        time: fmtTime(when),
        link: String(c.pageurl || ''),
        waiting: false,
      };
      const ok = await send(to, '【' + settings.siteName() + '】您的评论收到了新回复', mailTpl('reply', d));
      return { sent: ok, to, kind: 'reply' };
    }
    return { sent: false, reason: 'nothing-to-notify' };
  }

  /** 后台「发送测试邮件」：返回可读的诊断信息 */
  async function sendTest(to) {
    const rcpt = String(to || '').trim() || settings.opt('mailAdminTo', '').trim() || settings.adminMail();
    const c = config();
    if (!nodemailer) return { ok: false, msg: 'nodemailer 未安装，请在 backend 目录执行 npm install nodemailer' };
    if (rcpt === '') return { ok: false, msg: '未指定收件人，且主题设置「通知邮箱」与系统管理员邮箱均为空' };
    if (!isEmail(rcpt)) return { ok: false, msg: '收件邮箱格式不正确：' + rcpt };
    if (c.mode !== 'mail' && c.host === '') return { ok: false, msg: '未配置 SMTP 服务器（smtpHost）' };
    const ok = await send(rcpt, '【' + settings.siteName() + '】邮件通知测试', mailTpl('new', {
      author: '测试邮件', content: '如果你收到这封邮件，说明主题的邮件通知配置是正确的。', time: fmtTime(new Date()), link: settings.siteUrl(), waiting: false,
    }));
    return { ok, to: rcpt, msg: ok ? '测试邮件已发送，请查收' : ('发送失败：' + (lastError || '未知错误')) };
  }

  return { config, send, mailTpl, notifyComment, sendTest, emojiEncode, available: () => !!nodemailer };
}
