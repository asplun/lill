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

export const renderMD = (md) => {
  if (!md) return '';
  return '<p>' + md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
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
