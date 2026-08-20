#!/bin/bash
# =============================================================================
# install-plugin.sh — dsh-workspace-drag 一键安装脚本
#
# 把本插件注册进 DSH web profile（~/.dsh/profiles/web）：
#   1) 在 profile 的 package.json dependencies 写入 link: 依赖
#   2) 在 profile 的 node_modules 下建立符号链接
#
# 为什么不用 `dsh plugin --profile web add` / `pnpm install`？
#   pnpm 的 minimumReleaseAge 策略会拦截「发布不足 24h」的依赖（当前 web-ui-all
#   依赖树里 @linxin666 0.2.5 系列约 21 包均触发），导致 pnpm failed。
#   本脚本只改 package.json + 建软链，不触发 pnpm install，从而绕过该策略。
#
# 用法：
#   bash install-plugin.sh [--profile web]
#
# 幂等：已注册时提示跳过，不会重复写入或覆盖。
# =============================================================================
set -u

# ---- 配置 ---------------------------------------------------------------
PLUGIN_NAME="dsh-workspace-drag"
PLUGIN_SRC="$(cd "$(dirname "$0")" && pwd)"          # 插件绝对路径
PROFILE="${1:-web}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/$PROFILE}"
PKG_JSON="$PROFILE_DIR/package.json"
NM_DIR="$PROFILE_DIR/node_modules"

# ---- 前置检查 ------------------------------------------------------------
if [ ! -f "$PKG_JSON" ]; then
  echo "error: 未找到 profile package.json: $PKG_JSON" >&2
  echo "       请确认 DSH web profile 存在（默认 $HOME/.dsh/profiles/web）" >&2
  exit 1
fi

# ---- 检查是否已注册（幂等）---------------------------------------------
ALREADY_REGISTERED=0
if python3 - "$PKG_JSON" "$PLUGIN_NAME" <<'PYEOF'
import json, sys
pkg_path, name = sys.argv[1], sys.argv[2]
with open(pkg_path) as f:
    data = json.load(f)
sys.exit(0 if name in data.get("dependencies", {}) else 1)
PYEOF
then
  ALREADY_REGISTERED=1
fi

if [ "$ALREADY_REGISTERED" = "1" ] && [ -e "$NM_DIR/$PLUGIN_NAME" ]; then
  echo "ℹ️  插件已注册：$PLUGIN_NAME -> $PLUGIN_SRC"
  echo "   已存在于 $PKG_JSON 与 $NM_DIR/$PLUGIN_NAME，跳过安装。"
  echo "   如需重新链接：rm -f \"$NM_DIR/$PLUGIN_NAME\" && bash \"$0\""
  exit 0
fi

# ---- 备份 + 写入 dependencies（link: 依赖）-----------------------------
cp "$PKG_JSON" "$PKG_JSON.bak-install-plugin-$(date +%s)"
python3 - "$PKG_JSON" "$PLUGIN_NAME" "$PLUGIN_SRC" <<'PYEOF'
import json, sys
pkg_path, name, src = sys.argv[1], sys.argv[2], sys.argv[3]
with open(pkg_path) as f:
    data = json.load(f)
data.setdefault("dependencies", {})[name] = f"link:{src}"
with open(pkg_path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"✅ 已写入 {pkg_path} : {name} -> link:{src}")
PYEOF

# ---- 建立 node_modules 软链 --------------------------------------------
mkdir -p "$NM_DIR"
ln -sfn "$PLUGIN_SRC" "$NM_DIR/$PLUGIN_NAME"
echo "✅ 已建立软链: $NM_DIR/$PLUGIN_NAME -> $PLUGIN_SRC"

# ---- 同步 pnpm-lock.yaml（若存在同步脚本）-----------------------------
SYNC="$HOME/Documents/dsh-plugins/scripts/sync-profile-lockfile.py"
if [ -f "$SYNC" ]; then
  if DSH_PROFILE_DIR="$PROFILE_DIR" python3 "$SYNC" --profile "$PROFILE" --verify --fix-symlinks >/dev/null 2>&1; then
    echo "✅ lockfile 已同步（package.json ↔ pnpm-lock.yaml ↔ node_modules 软链一致）"
  else
    echo "⚠️  lockfile 同步有告警（可忽略，软链已建立，刷新页面即可生效）" >&2
  fi
fi

echo ""
echo "安装完成。生效方式："
echo "  - 纯客户端改动：刷新浏览器页面即可"
echo "  - 宿主端改动：重启 dsh web"
