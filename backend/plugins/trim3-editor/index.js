/**
 * Trim3 编辑器扩展。
 *
 * 图片上传属于 Trim3 的图床能力，因此通过主题自己的 /api/v1/upload
 * 接口完成，不把图床配置或主题判断写入 Lill 核心。
 */
export function activate(ctx) {
  ctx.registerEditorExtension({
    id: 'trim3-image-upload',
    entry: 'editor/index.js',
    styles: ['editor/styles.css'],
    for: ['post', 'page'],
    slots: ['toolbar'],
    apiVersion: 1,
  });
}
