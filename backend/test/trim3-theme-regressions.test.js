import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const THEME = join(ROOT, 'frontend', 'themes', 'trim3');

function source(name) {
  return readFileSync(join(THEME, name), 'utf8');
}

test('文章入口只负责进入文章汇总页，不触发首页 posts 模式切换', () => {
  const template = source('home-menu.html');
  const articleLinks = [...template.matchAll(/<a\b[^>]*data-posts-link[^>]*>/g)].map(match => match[0]);

  assert.ok(articleLinks.length >= 2, '默认态和文章态都应保留文章入口');
  articleLinks.forEach(link => assert.doesNotMatch(link, /data-home-mode="posts"/));
  assert.match(template, /href="\/page\/articles"[^>]*data-posts-link/);
});

test('首页横向导航保持单行横向滚动，不被主题补充 CSS 改成换行', () => {
  const css = source('style.css');
  const inner = css.match(/\.home-menu-inner\s*\{([\s\S]*?)\n\}/);

  assert.ok(inner, '主题补充 CSS 应声明 .home-menu-inner');
  assert.match(inner[1], /flex-wrap:\s*nowrap/);
  assert.match(inner[1], /overflow-x:\s*auto/);
  assert.doesNotMatch(inner[1], /flex-wrap:\s*wrap/);
});

test('播放器把自定义歌词按文本传给 Meting/播放器配置，默认显示开关单独读取', () => {
  const runtime = source('theme.js');

  // 歌词必须按「文本」读取，绝不能被布尔化
  assert.doesNotMatch(runtime, /lyric:\s*cfgBool\(['"]playerLyric['"]/);
  assert.match(runtime, /lyric:[^\n]*cfg\(['"]playerLyric['"]/);
  // 默认显示开关是 checkbox，后台/公共接口统一下发布尔，必须按布尔读取
  assert.match(runtime, /lyricDefault:\s*cfgBool\(['"]playerLyricDefault['"]/);
  assert.doesNotMatch(runtime, /lyricDefault:\s*cfg\(['"]playerLyricDefault['"]/);
});

test('历史脏数据：被误存为 true/false 的自定义歌词按空歌词处理', () => {
  const runtime = source('theme.js');
  const helper = runtime.match(/function lyricText\(v\)\s*\{([\s\S]*?)\n  \}/);

  assert.ok(helper, 'theme.js 应提供 lyricText() 过滤被布尔化的歌词脏值');
  const body = helper[1];
  ['true', 'false', '1', '0', 'on', 'off'].forEach(v => {
    assert.match(body, new RegExp(`['"]${v}['"]`), `lyricText 应把 '${v}' 视为非歌词`);
  });
});
