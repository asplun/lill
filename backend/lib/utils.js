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
  // 0. 先转义原始输入（防 XSS），之后所有转换都作用于已转义文本
  let html = String(md)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 1. 代码块（此时内容已转义，直接原样保留）
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code class="language-' + (lang || 'text') + '">' + code.replace(/\n$/, '') + '</code></pre>');
    return '\x00CODE' + idx + '\x00';
  });

  // 2. 行内代码
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 3. 标题
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 4. 粗体、斜体、删除线
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');

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

  // 10. 链接和图片
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // 11. 段落：按空行分块；块级标签与代码块占位符不再被 <p> 包裹
  const BLOCK = /^(<(h[1-6]|ul|ol|pre|blockquote|table|hr|div)\b|\x00CODE\d+\x00)/i;
  html = html.split(/\n{2,}/).map((block) => {
    const t = block.trim();
    if (!t) return '';
    if (BLOCK.test(t)) return t;
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).filter(Boolean).join('\n');

  // 12. 还原代码块
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

  return html;
};

export function plainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
