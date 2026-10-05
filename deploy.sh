#!/bin/bash
# lill 安全部署脚本
# 用法: ./deploy.sh
# 特点: 自动对比每个页面的 CSS 引用，只删除真正无引用的文件
set -e

SERVER="root@1.15.71.117"
REMOTE="/www/wwwroot/lill-v2"
LOCAL="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
PNPM="/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"

echo "▶ 1. 构建前端"
cd "$LOCAL/frontend"
PATH="$NODE:$PATH" "$PNPM" run build

echo "▶ 2. 收集所有页面引用的 CSS"
cd "$LOCAL/frontend/dist"
REFERENCED=$(grep -rho '_astro/[A-Za-z0-9._-]*\.css' . | sort -u | sed 's|_astro/||')
echo "   引用文件: $REFERENCED"

echo "▶ 3. 上传所有被引用的 CSS"
for css in $REFERENCED; do
  scp "dist/_astro/$css" "$SERVER:$REMOTE/frontend/_astro/" 2>/dev/null || scp "_astro/$css" "$SERVER:$REMOTE/frontend/_astro/"
done

echo "▶ 4. 上传页面 HTML"
cd "$LOCAL/frontend/dist"
for dir in "" admin archive category page post search tag; do
  if [ -z "$dir" ]; then
    scp index.html "$SERVER:$REMOTE/frontend/index.html"
  elif [ -f "$dir/index.html" ]; then
    ssh "$SERVER" "mkdir -p $REMOTE/frontend/$dir"
    scp "$dir/index.html" "$SERVER:$REMOTE/frontend/$dir/index.html"
  fi
done

echo "▶ 5. 上传静态资源"
cd "$LOCAL/frontend/public"
scp api.js theme.js logo.svg favicon.svg "$SERVER:$REMOTE/frontend/"
scp admin/app.js "$SERVER:$REMOTE/frontend/admin/app.js"

echo "▶ 6. 上传后端"
scp "$LOCAL/backend/server.js" "$SERVER:$REMOTE/backend/server.js"
scp "$LOCAL/backend/routes/"*.js "$SERVER:$REMOTE/backend/routes/"
scp "$LOCAL/backend/lib/"*.js "$SERVER:$REMOTE/backend/lib/"

echo "▶ 7. 清理无引用的旧 CSS"
REMOTE_CSS=$(ssh "$SERVER" "ls $REMOTE/frontend/_astro/*.css 2>/dev/null | xargs -n1 basename")
for f in $REMOTE_CSS; do
  if ! echo "$REFERENCED" | grep -q "^$f$"; then
    echo "   删除: $f"
    ssh "$SERVER" "rm -f $REMOTE/frontend/_astro/$f"
  fi
done

echo "▶ 8. 重启后端"
ssh "$SERVER" "pm2 restart lill-backend > /dev/null 2>&1"

echo "✅ 部署完成"
