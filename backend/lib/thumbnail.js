// 缩略图生成工具（纯 Node.js，无外部依赖）
// 生成 SVG 引用式缩略图，浏览器自动缩放
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * 生成 SVG 引用式缩略图
 */
export function generateThumbnail(srcPath, destPath, maxWidth = 300, maxHeight = 200) {
  try {
    const srcUrl = srcPath.replace(/\\/g, '/').replace(/^\//, '');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + maxWidth + '" height="' + maxHeight + '" viewBox="0 0 ' + maxWidth + ' ' + maxHeight + '">' +
      '<defs><style>.thumb-img{max-width:100%;max-height:100%;object-fit:contain;}</style></defs>' +
      '<image class="thumb-img" xlink:href="/' + srcUrl + '" x="0" y="0" width="' + maxWidth + '" height="' + maxHeight + '" preserveAspectRatio="xMidYMid meet"/>' +
      '</svg>';
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, svg, 'utf8');
    return true;
  } catch (e) {
    console.error('缩略图生成失败:', e.message);
    return false;
  }
}

/**
 * 上传时自动生成缩略图
 */
export function createThumbnailOnUpload(filePath, ext) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  if (!imageExts.includes(ext)) return null;
  const thumbName = 'thumb-' + filePath.split('/').pop().replace(/\.[^.]+$/, '') + '.svg';
  const thumbPath = join(dirname(filePath), thumbName);
  if (generateThumbnail(filePath, thumbPath)) {
    return '/uploads/' + thumbName;
  }
  return null;
}
