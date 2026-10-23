#!/bin/bash
# lill 安全部署脚本
# 用法: SERVER=root@host REMOTE=/www/wwwroot/lill HEALTH_BASE_URL=https://example.com PM2_APP=lill-main ./deploy.sh
#
# 历史坑：旧版本用 `find ... | while read` 上传页面，而 scp/ssh 会读走循环的
# stdin，导致循环第一次迭代后就结束——除了首个 index.html，其余页面从未真正
# 上传过。现在改为 rsync 整目录同步 + 同步后 MD5 校验，不一致直接报错退出。
set -euo pipefail

SERVER="${SERVER:-}"
REMOTE="${REMOTE:-}"
PM2_APP="${PM2_APP:-lill-backend}"
if [ -z "$SERVER" ] || [ -z "$REMOTE" ]; then
  echo "用法: SERVER=root@host REMOTE=/www/wwwroot/lill HEALTH_BASE_URL=https://example.com ./deploy.sh" >&2
  exit 1
fi
LOCAL="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(dirname "$(command -v node 2>/dev/null || true)")}"
if [ -z "$NODE" ] || [ ! -x "$NODE/node" ]; then
  echo "❌ 未找到 node；请将 node 所在目录设置为 NODE，或加入 PATH" >&2
  exit 1
fi
PNPM="${PNPM:-$(command -v pnpm 2>/dev/null || true)}"
if [ -z "$PNPM" ] || [ ! -x "$PNPM" ]; then
  echo "❌ 未找到 pnpm；请将 pnpm 可执行文件设置为 PNPM，或加入 PATH" >&2
  exit 1
fi
if [ -z "${HEALTH_BASE_URL:-}" ]; then
  echo "❌ 必须设置 HEALTH_BASE_URL（例如 https://example.com）" >&2
  exit 1
fi

echo "▶ 1. 构建前端"
cd "$LOCAL/frontend"
PATH="$NODE:$PATH" "$PNPM" run build

cd "$LOCAL/frontend/dist"

echo "▶ 2. 收集所有页面引用的 CSS"
# pipefail 下 grep 无命中会以 1 结束整条管道，进而让 `set -e` 中止部署（本次就是被它卡住），
# 故末尾 `|| true` 兜住退出码；无命中时第 6 步整体跳过，避免把服务器上仍被引用的 _astro CSS 删光。
REFERENCED=$(grep -rho '_astro/[A-Za-z0-9._-]*\.css' . | sort -u | sed 's|_astro/||' || true)
if [ -n "$REFERENCED" ]; then
  echo "   引用文件: $REFERENCED"
else
  echo "   引用文件: （无引用的 _astro CSS，跳过第 6 步清理）"
fi

echo "▶ 3. 同步构建产物到服务器"
# 排除单独发布的主题目录、源码和缓存目录；主题由 THEME_IDS 清单单独同步
rsync -az --no-perms --no-owner --no-group \
  --exclude='/themes/' --exclude='/backend/' --exclude='/cache/' --exclude='/src/' --exclude='/public/' --exclude='/dist/' --exclude='/node_modules/' \
  ./ "$SERVER:$REMOTE/frontend/"

# 主题模板按显式清单同步，默认只发布官方 default。
# 第三方主题由其自己的发布包加入 THEME_IDS，不通过主题名称特判或覆盖。
THEME_IDS="${THEME_IDS:-default}"
for theme_id in $THEME_IDS; do
  if [[ ! "$theme_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]]; then
    echo "❌ 非法主题 ID: $theme_id"
    exit 1
  fi
  if [ ! -d "./themes/$theme_id" ]; then
    echo "❌ 主题目录不存在: ./themes/$theme_id"
    exit 1
  fi
  THEME_SOURCE="$LOCAL/frontend/themes/$theme_id"
  if [ ! -d "$THEME_SOURCE" ]; then
    echo "❌ 主题目录不存在: $THEME_SOURCE"
    exit 1
  fi
  echo "   同步主题包: $theme_id"
  # 从源主题目录同步，保留 backend/ 扩展；cache/ 是运行时数据，不由发布覆盖。
  rsync -az --no-perms --no-owner --no-group --delete --exclude='cache/' \
    "$THEME_SOURCE/" "$SERVER:$REMOTE/frontend/themes/$theme_id/"
done

echo "▶ 4. 校验页面是否全部落地（MD5 对比）"
# 只校验自己会同步的页面；主题目录由 THEME_IDS 单独同步
PAGES=$(find . \( -name 'index.html' -o -name '404.html' \) -not -path './themes/*' | sed 's|^\./||' | sort)
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
if [ -n "$REFERENCED" ]; then
  REMOTE_CSS=$(ssh "$SERVER" "ls $REMOTE/frontend/_astro/*.css 2>/dev/null | xargs -n1 basename || true")
  for f in $REMOTE_CSS; do
    if ! echo "$REFERENCED" | grep -q "^$f$"; then
      echo "   删除: $f"
      ssh "$SERVER" "rm -f $REMOTE/frontend/_astro/$f"
    fi
  done
else
  echo "   （无引用的 _astro CSS，跳过清理）"
fi

echo "▶ 7. 重启后端"
ssh "$SERVER" "pm2 restart $PM2_APP --update-env > /dev/null 2>&1"

echo "▶ 8. 健康检查"
sleep 2
check_health() (
  local path="$1" code attempt base_url="${HEALTH_BASE_URL%/}"
  for attempt in 1 2 3 4 5; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$base_url$path" || true)
    echo "   $path -> $code (attempt $attempt/5)"
    [ "$code" = "200" ] && return 0
    if [ "$code" != "500" ] || [ "$attempt" = "5" ]; then
      echo "❌ $path health check failed"
      return 1
    fi
    sleep 3
  done
)
for path in /api/v1/install/status /api/v1/posts /api/v1/site/bootstrap; do
  check_health "$path" || exit 1
done
for path in / /admin/ /admin/login/; do
  check_health "$path" || exit 1
done

echo "▶ 9. 校验公开主题引擎入口"
# 只比磁盘文件不能发现面板里遗留的 alias；按浏览器实际使用的 URL 再校验一次。
EXPECTED_ENGINE=$(shasum -a 256 "$LOCAL/frontend/dist/theme.js" | awk '{print $1}')
SERVED_ENGINE=$(curl --fail --silent --show-error --max-time 20 "${HEALTH_BASE_URL%/}/theme.js" | shasum -a 256 | awk '{print $1}')
if [ "$SERVED_ENGINE" != "$EXPECTED_ENGINE" ]; then
  echo "❌ /theme.js 未返回通用主题引擎，请删除 Nginx 中指向具体主题脚本的 alias。"
  exit 1
fi

echo "✅ 部署完成"
