/**
 * lill 通用工具：ID、slug、Markdown 渲染
 */
import { randomUUID } from 'node:crypto';

export const uid = () => randomUUID();

export const slugify = (t) => {
  const s = t.toString().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'item-' + Date.now().toString(36);
};

/**
 * 增强版 Markdown 渲染
 * 支持：标题、粗体、斜体、代码块（高亮）、行内代码、表格、有序/无序列表、引用、链接、图片、分割线
 */
export const renderMD = (md) => {
  if (!md) return '';
  const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttribute = value => escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const emphasis = value => value.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 私有占位符不能由输入伪造；代码与已生成的标签不再经过其他 Markdown 正则。
  const nonce = randomUUID().replace(/-/g, '');
  const tokens = [];
  const tokenPattern = new RegExp('\\x00(?:CODE|INLINE)' + nonce + '(\\d+)\\x00', 'g');
  const stash = (value, text, block = false) => {
    const index = tokens.push({ html: value, text }) - 1;
    return '\x00' + (block ? 'CODE' : 'INLINE') + nonce + index + '\x00';
  };
  const restore = value => value.replace(tokenPattern, (_, index) => tokens[Number(index)].html);
  const literal = value => value.replace(tokenPattern, (_, index) => tokens[Number(index)].text);

  // 1. 在转义之前隔离代码，但其输出内容只作为纯文本转义一次。
  const source = String(md);
  const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  let html = '', cursor = 0, fence;
  while ((fence = fences.exec(source))) {
    // 短 fence 不能提前结束长 fence；编辑中未闭合的代码也保护到文末。
    const closing = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}[ \\t]*(?=\\r?$)', 'gm');
    closing.lastIndex = fences.lastIndex;
    const end = closing.exec(source);
    const text = source.slice(fences.lastIndex, end ? end.index : source.length).replace(/\r?\n$/, '');
    const lang = fence[2].trim() || 'text';
    html += source.slice(cursor, fence.index) + stash('<pre><code class="language-' +
      escapeAttribute(lang) + '">' + escapeText(text) + '</code></pre>', text, true);
    cursor = end ? closing.lastIndex : source.length;
    fences.lastIndex = cursor;
  }
  html += source.slice(cursor);
  html = html.replace(/(?<!`)(`+)(?!`)([^\n]+?)\1(?!`)/g, (_, ticks, code) =>
    stash('<code>' + escapeText(code) + '</code>', code));
  // 摘要边界不是正文；代码示例已隔离，实体形式的示例仍作为文字显示。
  html = html.replace(/<!--\s*more\s*-->/gi, '');

  const safeUrl = (url, image) => {
    // 不通过删除/trim 控制字符来“修复”危险协议，也不解码 HTML 实体后再输出。
    if (!url || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(url)) return false;
    if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(url)) return false;
    if (/&#(?:x[0-9a-f]+|\d+);?|&(?:colon|tab|newline);/i.test(url)) return false;
    if (url.startsWith('//')) return false;
    try {
      const protocol = new URL(url, 'https://markdown.invalid/').protocol;
      return protocol === 'http:' || protocol === 'https:' || (!image && protocol === 'mailto:');
    } catch { return false; }
  };

  // 只扫描链接目标的配对括号及可选引号标题，不引入完整 Markdown 解析器。
  const readTarget = (source, start) => {
    let depth = 0, quote = '';
    for (let end = start; end < source.length; end++) {
      const char = source[end];
      if (char === '\\') { end++; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if ((char === '"' || char === "'") && /[ \t]/.test(source[end - 1] || '')) {
        quote = char;
        continue;
      }
      if (char === '(') depth++;
      if (char !== ')') continue;
      if (depth) { depth--; continue; }
      const target = source.slice(start, end);
      const titled = /^(.+?)[ \t]+(["'])([\s\S]*)\2[ \t]*$/.exec(target);
      const unescape = value => value.replace(/\\([\\()[\]"'])/g, '$1');
      return {
        end: end + 1,
        url: unescape(titled ? titled[1] : target),
        title: titled ? unescape(titled[3]) : null,
      };
    }
    return null;
  };
  const replaceLinks = (source, image) => {
    // 一层嵌套方括号用于图片 alt 中的文字链接；先处理图片，再处理外层链接。
    const pattern = new RegExp((image ? '!' : '') + '\\[((?:\\\\.|[^\\[\\]\\\\\\n]|\\[(?:\\\\.|[^\\[\\]\\\\\\n])*\\])*)\\]\\(', 'g');
    let output = '', cursor = 0, match;
    while ((match = pattern.exec(source))) {
      const target = readTarget(source, pattern.lastIndex);
      if (!target) continue;
      output += source.slice(cursor, match.index);
      const label = literal(match[1]);
      if (!safeUrl(target.url, image)) {
        output += stash(escapeText(label), label);
      } else {
        const title = target.title === null ? '' : ' title="' + escapeAttribute(literal(target.title)) + '"';
        const destination = escapeAttribute(target.url);
        const value = image
          ? '<img src="' + destination + '" alt="' + escapeAttribute(label) + '"' + title + ' loading="lazy">'
          : '<a href="' + destination + '"' + title + ' target="_blank" rel="noopener">' + restore(emphasis(escapeText(match[1]))) + '</a>';
        output += stash(value, label);
      }
      cursor = target.end;
      pattern.lastIndex = cursor;
    }
    return output + source.slice(cursor);
  };
  html = replaceLinks(html, true);
  html = replaceLinks(html, false);
  // 原始 HTML 始终是文本；只有上述受控生成的标签在最后一步还原。
  html = escapeText(html);

  // 3. 标题（标题内容已经按文本转义）
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 4. 粗体、斜体、删除线
  html = emphasis(html);

  // 5. 分割线
  html = html.replace(/^---+$/gm, '<hr>');

  // 6. 引用
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // 7. 表格
  html = html.replace(/((?:^\|.+\|\n)+)/gm, (match) => {
    const rows = match.trim().split('\n');
    if (rows.length < 2) return match;
    const header = rows[0].split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(s => s.trim());
    const body = rows.slice(2).map(r => r.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(s => s.trim()));
    let t = '<table><thead><tr>';
    for (const h of header) t += '<th>' + h + '</th>';
    t += '</tr></thead><tbody>';
    for (const row of body) {
      t += '<tr>';
      for (const c of row) t += '<td>' + c + '</td>';
      t += '</tr>';
    }
    t += '</tbody></table>';
    return t;
  });

  // 8. 无序列表
  html = html.replace(/(^|\n)((?:- .+\n?)+)/g, (_, prefix, list) => {
    const items = list.trim().split('\n').map(s => '<li>' + s.replace(/^- /, '') + '</li>').join('');
    return prefix + '<ul>' + items + '</ul>';
  });

  // 9. 有序列表
  html = html.replace(/(^|\n)((?:\d+\. .+\n?)+)/g, (_, prefix, list) => {
    const items = list.trim().split('\n').map(s => '<li>' + s.replace(/^\d+\. /, '') + '</li>').join('');
    return prefix + '<ol>' + items + '</ol>';
  });

  // 11. 段落：按空行分块；块级标签与代码块占位符不再被 <p> 包裹
  const BLOCK = /^(<(h[1-6]|ul|ol|pre|blockquote|table|hr|div)\b)/i;
  html = html.split(/\n{2,}/).map((block) => {
    const t = block.trim();
    if (!t) return '';
    if (BLOCK.test(t) || t.startsWith('\x00CODE' + nonce)) return t;
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).filter(Boolean).join('\n');

  // 12. 还原隔离片段，不再进行链接/图片转换或 HTML 实体解码。
  return restore(html);
};

export function plainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 短代码（{music .../}、{/music}、{tabs}、{x}、{hide} 等，含属性）不进入纯文本摘要
    .replace(/\{\/?[a-zA-Z][^{}]*\}/g, ' ')
    // BBCode 风格标记（[hide]…[/hide] 等）去标签、保留其中文字
    .replace(/\[\/?[a-zA-Z][\w-]*[^\]]*\]/g, ' ')
    .replace(/[#>*`_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
