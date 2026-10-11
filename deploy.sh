#!/bin/bash
# lill 安全部署脚本
# 用法: ./deploy.sh
#
# 历史坑：旧版本用 `find ... | while read` 上传页面，而 scp/ssh 会读走循环的
# stdin，导致循环第一次迭代后就结束——除了首个 index.html，其余页面从未真正
# 上传过。现在改为 rsync 整目录同步 + 同步后 MD5 校验，不一致直接报错退出。
set -euo pipefail

SERVER="root@1.15.71.117"
REMOTE="/www/wwwroot/lill-v2"
LOCAL="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
PNPM="/Users/lilun/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"

echo "▶ 1. 构建前端"
cd "$LOCAL/frontend"
PATH="$NODE:$PATH" "$PNPM" run build

cd "$LOCAL/frontend/dist"

echo "▶ 2. 收集所有页面引用的 CSS"
REFERENCED=$(grep -rho '_astro/[A-Za-z0-9._-]*\.css' . | sort -u | sed 's|_astro/||')
echo "   引用文件: ${REFERENCED:-（无）}"

echo "▶ 3. 同步构建产物到服务器"
# 排除服务器上独有的目录：主题（第三方主题在服务器手工维护）、源码、缓存的 dist
rsync -az --no-perms --no-owner --no-group \
  --exclude='/themes/' --exclude='/src/' --exclude='/public/' --exclude='/dist/' --exclude='/node_modules/' \
  ./ "$SERVER:$REMOTE/frontend/"

# 主题模板单独同步：只覆盖官方 default 主题。
# trim3 是第三方主题且在服务器上手工维护（含本地没有的 api/ 与 meting 依赖），绝不能覆盖。
if [ -d "./themes/default" ]; then
  rsync -az --no-perms --no-owner --no-group ./themes/default/ "$SERVER:$REMOTE/frontend/themes/default/"
fi

echo "▶ 4. 校验页面是否全部落地（MD5 对比）"
# 只校验自己会同步的文件；themes/trim3 由服务器维护，不参与对比
PAGES=$(find . \( -name 'index.html' -o -name '404.html' \) -not -path './themes/trim3/*' | sed 's|^\./||' | sort)
# md5sum 的输出格式与 printf 一致（两空格分隔），缺文件时直接少行，由下面 diff 捕获
LOCAL_SUM=$(for f in $PAGES; do printf '%s  %s\n' "$(md5 -q "$f")" "$f"; done)
PAGES_ARG=$(echo "$PAGES" | tr '\n' ' ')
REMOTE_SUM=$(ssh "$SERVER" "cd $REMOTE/frontend && md5sum $PAGES_ARG 2>/dev/null" || true)
if [ "$LOCAL_SUM" = "$REMOTE_SUM" ]; then
  echo "   ✓ $(echo "$PAGES" | wc -l | tr -d ' ') 个页面/404 全部一致"
else
  echo "   ❌ 以下页面未同步："
  diff <(echo "$LOCAL_SUM") <(echo "$REMOTE_SUM") | grep '^[<>]' | head -20
  exit 1
fi

echo "▶ 5. 上传后端"
scp -q "$LOCAL/backend/server.js" "$SERVER:$REMOTE/backend/server.js"
scp -q "$LOCAL/backend/routes/"*.js "$SERVER:$REMOTE/backend/routes/"
scp -q "$LOCAL/backend/lib/"*.js "$SERVER:$REMOTE/backend/lib/"

# 管理路由已拆分为 modules，整目录同步（排除本地备份文件）
if [ -d "$LOCAL/backend/routes/admin" ]; then
  rsync -az --delete --exclude='*.bak*' "$LOCAL/backend/routes/admin/" "$SERVER:$REMOTE/backend/routes/admin/"
fi

# 内置插件整目录同步
if [ -d "$LOCAL/backend/plugins" ]; then
  rsync -az --exclude='*.bak*' "$LOCAL/backend/plugins/" "$SERVER:$REMOTE/backend/plugins/"
fi

echo "▶ 6. 清理无引用的旧 CSS"
REMOTE_CSS=$(ssh "$SERVER" "ls $REMOTE/frontend/_astro/*.css 2>/dev/null | xargs -n1 basename || true")
for f in $REMOTE_CSS; do
  if ! echo "$REFERENCED" | grep -q "^$f$"; then
    echo "   删除: $f"
    ssh "$SERVER" "rm -f $REMOTE/frontend/_astro/$f"
  fi
done

echo "▶ 7. 重启后端"
ssh "$SERVER" "pm2 restart lill-backend --update-env > /dev/null 2>&1"

echo "▶ 8. 健康检查"
sleep 2
for path in /api/v1/install/status /api/v1/posts /api/v1/site/bootstrap; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://test.abohe.cn$path")
  echo "   $path -> $code"
  [ "$code" = "200" ] || { echo "❌ 健康检查失败: $path"; exit 1; }
done
for path in / /admin/ /admin/login/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://test.abohe.cn$path")
  echo "   $path -> $code"
  [ "$code" = "200" ] || { echo "❌ 页面异常: $path"; exit 1; }
done

echo "✅ 部署完成"
