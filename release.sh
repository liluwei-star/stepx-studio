#!/usr/bin/env bash
# =============================================================================
# StepX Studio 一键发版
# -----------------------------------------------------------------------------
# 做四件事：升版本号 → 编译 → 提交推送 → 建 GitHub Release
#
# 用法：
#   ./release.sh                  # 补丁位 +1（0.0.0 → 0.0.1）
#   ./release.sh 0.1.0            # 指定版本
#   ./release.sh 0.1.0 "改动说明"  # 带发版说明
#   ./release.sh --dry-run 0.0.1  # 只预览，不实际执行
#
# 铁律（脚本会自动校验，失败即停）：
#   1. versionCode 必须递增（Android 靠它判断能否覆盖升级）
#   2. tag 必须等于 versionName（AppUpdater 按 tag 拼资产名）
#   3. 资产名必须是 StepXStudio-<version>-release.apk
#
# 任一校验失败会中止，不会留下半成品。
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

export JAVA_HOME="${JAVA_HOME:-C:/Users/llw/tools/jdk/jdk-21.0.2}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-C:/Users/llw/tools/androidsdk}"
export NEO_SIGNING_DIR="${NEO_SIGNING_DIR:-$HOME/.neo-signing-studio}"
GH_REPO="liluwei-star/stepx-studio"
MANIFEST="AndroidManifest.xml"

DRY_RUN=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
NEW_VERSION="${ARGS[0]:-}"
NOTES="${ARGS[1]:-}"

# ---------------------------------------------------------------- 读当前版本
read_versions() {
  python3 - "$MANIFEST" <<'PY'
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
vc = re.search(r'android:versionCode="(\d+)"', s)
vn = re.search(r'android:versionName="([^"]+)"', s)
print(vc.group(1) if vc else "", vn.group(1) if vn else "")
PY
}

read -r CUR_CODE CUR_NAME <<< "$(read_versions)"
if [ -z "$CUR_CODE" ] || [ -z "$CUR_NAME" ]; then
  echo "✗ 无法从 $MANIFEST 读取版本号" >&2; exit 1
fi

# ---------------------------------------------------------------- 计算新版本
if [ -z "$NEW_VERSION" ]; then
  IFS='.' read -r MA MI PA <<< "$CUR_NAME"
  NEW_VERSION="$MA.$MI.$((PA + 1))"
fi

# 校验语义版本
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'; then
  echo "✗ 版本号格式非法：$NEW_VERSION（需 X.Y.Z，纯数字）" >&2; exit 1
fi
# 必须比当前大
NEW_CODE=$((CUR_CODE + 1))
if [ "$NEW_VERSION" = "$CUR_NAME" ]; then
  echo "✗ 新版本与当前相同：$NEW_VERSION" >&2; exit 1
fi
if ! python3 -c "
import sys
a=[int(x) for x in '$NEW_VERSION'.split('.')]
b=[int(x) for x in '$CUR_NAME'.split('.')]
sys.exit(0 if a>b else 1)"; then
  echo "✗ 新版本 $NEW_VERSION 必须大于当前 $CUR_NAME" >&2; exit 1
fi

APK_NAME="StepXStudio-${NEW_VERSION}-release.apk"

echo "=== StepX Studio 发版 ==="
echo "  当前    : $CUR_NAME (versionCode $CUR_CODE)"
echo "  新版本  : $NEW_VERSION (versionCode $NEW_CODE)"
echo "  tag     : v$NEW_VERSION"
echo "  资产名  : $APK_NAME"
[ "$DRY_RUN" = "1" ] && echo "  模式    : 预览（不执行）"
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "预览结束。去掉 --dry-run 实际执行。"
  exit 0
fi

# ---------------------------------------------------------------- 前置检查
echo "[1/6] 前置检查"
if [ -n "$(git status --porcelain)" ]; then
  echo "  工作区有未提交改动，先提交或 stash："
  git status --short | head -10
  exit 1
fi
if [ ! -d "$NEO_SIGNING_DIR" ] || [ ! -f "$NEO_SIGNING_DIR/keystore.p12" ]; then
  echo "  ✗ 找不到签名 keystore：$NEO_SIGNING_DIR" >&2; exit 1
fi
echo "  工作区干净，keystore 就位"

# ---------------------------------------------------------------- 改版本号
echo "[2/6] 更新 $MANIFEST"
python3 - "$MANIFEST" "$NEW_VERSION" "$NEW_CODE" <<'PY'
import re, sys
path, ver, code = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding="utf-8").read()
s = re.sub(r'android:versionCode="\d+"', f'android:versionCode="{code}"', s)
s = re.sub(r'android:versionName="[^"]*"', f'android:versionName="{ver}"', s)
open(path, "w", encoding="utf-8").write(s)
print(f"  versionCode={code}  versionName={ver}")
PY

# ---------------------------------------------------------------- 编译
echo "[3/6] 编译"
rm -f "dist/${APK_NAME}"
if ! bash build-windows.sh release 2>&1 | grep -vE "WARNING: header mismatch|^\s*$|zip     :" | tail -8; then
  echo "  ✗ 编译失败，回滚版本号"
  git checkout -- "$MANIFEST"
  exit 1
fi

APK="dist/${APK_NAME}"
if [ ! -f "$APK" ]; then
  echo "  ✗ 编译未产出 $APK，回滚版本号" >&2
  git checkout -- "$MANIFEST"
  exit 1
fi

# ---------------------------------------------------------------- 验证 APK
echo "[4/6] 验证 APK"
BT="$ANDROID_SDK_ROOT/build-tools/36.0.0"
BADGE=$("$BT/aapt2.exe" dump badging "$(cygpath -w "$REPO/$APK")" 2>/dev/null | head -1)
GOT_NAME=$(echo "$BADGE" | grep -oE "versionName='[^']*'" | cut -d"'" -f2)
GOT_CODE=$(echo "$BADGE" | grep -oE "versionCode='[^']*'" | cut -d"'" -f2)
GOT_PKG=$(echo "$BADGE" | grep -oE "name='[^']*'" | head -1 | cut -d"'" -f2)
echo "  package=$GOT_PKG  versionName=$GOT_NAME  versionCode=$GOT_CODE"

if [ "$GOT_NAME" != "$NEW_VERSION" ]; then
  echo "  ✗ versionName 不符：期望 $NEW_VERSION，实际 $GOT_NAME" >&2
  git checkout -- "$MANIFEST"; exit 1
fi
if [ "$GOT_PKG" != "cn.com.scsxrkj" ]; then
  echo "  ✗ 包名不符：$GOT_PKG" >&2; exit 1
fi

# 验签
"$JAVA_HOME/bin/javac" -encoding UTF-8 \
  -cp "$(cygpath -w "$REPO/vendor/apksig-android-4.4.0.jar")" \
  -d "$(cygpath -w "$REPO/.release")" \
  "$(cygpath -w "$REPO/vendor/VerifyTool.java")" 2>/dev/null || true
VOUT=$("$JAVA_HOME/bin/java" -cp "$(cygpath -w "$REPO/.release");$(cygpath -w "$REPO/vendor/apksig-android-4.4.0.jar")" \
  VerifyTool "$(cygpath -w "$REPO/$APK")" 2>&1 || true)
if echo "$VOUT" | grep -q "verified=true"; then
  echo "  签名验证通过"
  echo "$VOUT" | grep "CERT_SHA256" | sed 's/^/  /'
else
  echo "  ✗ 签名验证失败" >&2; echo "$VOUT" | head -5; exit 1
fi

# 作者标识残留检查
# 旧标识符用 base64 存储：仓库里不出现明文，但扫描时解码回来精确匹配。
# 同时匹配 ASCII 与 UTF-16LE 两种编码（AXML 的字符串池可能是 UTF-16）。
RESIDUE=$(python3 - "$APK" <<'PY'
import base64, zipfile, sys

_B64 = [
    "c3R1ZGlvLmppYXl1Lm5lbw==", "c3R1ZGlvLmppYXl1Lm1hdHJpeA==",
    "c3R1ZGlvLmppYXl1LnJ1bnRpbWU=", "c3R1ZGlvLmppYXl1LnRlbXBsYXRl",
    "c3R1ZGlvL2ppYXl1L25lbw==", "c3R1ZGlvL2ppYXl1L21hdHJpeA==",
    "c3R1ZGlvL2ppYXl1L3J1bnRpbWU=", "amlheXU=",
    "SmlheXU=", "SklBWVU=", "SmlheXVTdHVkaW8=",
    "TmVvIFN0dWRpbw==", "TmVvU3R1ZGlv", "U3RlcFgtTmVvLVN0dWRpbw==",
    "U3RlcFggTmVvIFN0dWRpbw==", "TmVvIEFwcA==",
    "Q049TmVvIExvY2FsIERldmVsb3Blcg==", "TmVvIExvY2FsIERldmVsb3Blcg==",
    "SklBWVUgU1RVRElP", "cmExbnp6eg==",
]

needles = []
for b in _B64:
    raw = base64.b64decode(b)
    needles.append(raw)
    needles.append(raw.decode("utf-8").encode("utf-16-le"))

z = zipfile.ZipFile(sys.argv[1])
hits = []
for e in z.namelist():
    try:
        d = z.read(e)
    except Exception:
        continue
    for n in needles:
        if n in d:
            hits.append((e, n))
print(len(hits))
PY
)
if [ "$RESIDUE" != "0" ]; then
  echo "  ⚠ APK 内有 $RESIDUE 处作者标识残留（不影响功能，但应清理）" >&2
else
  echo "  作者标识残留：0"
fi

# ---------------------------------------------------------------- 提交推送
echo "[5/6] 提交并推送"
git add -A
git commit -q -m "Release $NEW_VERSION" 2>/dev/null || echo "  （无文件变化，跳过提交）"
push_ok=0
TOKEN=$(gh auth token 2>/dev/null || true)
# 只重试 2 次，每次 60 秒硬超时。
# 之前没有 timeout、重试 5 次，网络半通的时候会卡在 git push 上几十分钟，
# 日志停在「推送失败，第 2 次重试...」再也不动 —— API 兜底永远走不到。
# 这条网络上 git push 本来成功率就低，早点降级比死等强。
for attempt in 1 2; do
  if timeout 60 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 push origin main 2>&1 | tail -2 | grep -q "main"; then
    push_ok=1; break
  fi
  if [ -n "$TOKEN" ]; then
    if timeout 60 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 \
        push "https://x-access-token:${TOKEN}@github.com/${GH_REPO}.git" main 2>&1 \
        | sed "s/${TOKEN}/***/g" | tail -2 | grep -q "main"; then
      push_ok=1; break
    fi
  fi
  echo "  推送失败，第 $attempt 次（最多 2 次，之后走 API）..."
  sleep 5
done
if [ "$push_ok" != "1" ]; then
  # ── 兜底：走 GitHub Git Data API 推送 ──────────────────────
  #
  # git push 在这条网络上经常连不上（Recv failure: Connection was reset），
  # 但 gh api 是通的。走 API 上传也能得到完全一样的仓库内容。
  #
  # 关键坑：<b>要传仓库里的 blob 字节，不是工作区文件字节。</b>
  # 工作区被 autocrlf 改成 CRLF，blob SHA 与远端对不上，文件会一直显示「已修改」。
  # 所以每个文件用 `git cat-file blob <sha>` 取原始内容。
  echo "  git push 不通，改走 GitHub Git Data API 推送..."
  if python3 "$REPO/tools/push-via-api.py" "$GH_REPO" "main"; then
    push_ok=1
    echo "  已通过 API 推送到 main"
  else
    echo "  ✗ 推送连续失败（git 与 API 两条路都不通）。" >&2
    echo "    版本号已改并编译完成，可稍后手动 git push。" >&2
    exit 1
  fi
fi
echo "  已推送到 main"

# ---------------------------------------------------------------- 建 Release
echo "[6/6] 创建 Release v$NEW_VERSION"
if [ -z "$NOTES" ]; then
  NOTES="StepX Studio $NEW_VERSION

版本 $NEW_VERSION（versionCode $NEW_CODE）。

安装：adb install -r $APK_NAME"
fi

# 已存在的 tag 先删（Release 依附 tag，一并重建）
# 幂等：同名 tag/release 已存在则先清掉（Release 依附 tag，删 tag 会连带删 Release）
timeout 60 gh release delete "v$NEW_VERSION" --repo "$GH_REPO" --yes >/dev/null 2>&1 \
  && echo "  已删除同名旧 Release" || true
timeout 60 gh api -X DELETE "repos/${GH_REPO}/git/refs/tags/v${NEW_VERSION}" >/dev/null 2>&1 \
  && echo "  已删除同名旧 tag" || true

timeout 180 gh release create "v$NEW_VERSION" \
  "$APK#${APK_NAME}" \
  --repo "$GH_REPO" --title "StepX Studio $NEW_VERSION" \
  --notes "$NOTES" --target main --latest 2>&1 | tail -2

# gh 在 tag 状态不一致时可能建出草稿版；AppUpdater 会忽略草稿，必须显式发布
DRAFT=$(timeout 40 gh api "repos/${GH_REPO}/releases/tags/v${NEW_VERSION}" --jq '.draft' 2>/dev/null || echo "")
if [ "$DRAFT" = "true" ]; then
  echo "  检测到草稿版，正在发布..."
  timeout 60 gh release edit "v$NEW_VERSION" --repo "$GH_REPO" --draft=false --latest >/dev/null 2>&1 || true
fi
# tag 必须指向 main HEAD（gh 有时把 tag 建在旧 commit 上，导致 release 与源码错位）
HEAD_SHA=$(git rev-parse HEAD)
TAG_SHA=$(timeout 40 gh api "repos/${GH_REPO}/git/refs/tags/v${NEW_VERSION}" --jq '.object.sha' 2>/dev/null || echo "")
if [ -n "$TAG_SHA" ] && [ "$TAG_SHA" != "$HEAD_SHA" ]; then
  echo "  tag 指向 $TAG_SHA，应为 $HEAD_SHA，正在移动..."
  # 用 PATCH 移动，而不是删了重建 —— 删 tag 会连带删掉 Release
  timeout 60 gh api -X PATCH "repos/${GH_REPO}/git/refs/tags/v${NEW_VERSION}" \
    -f sha="$HEAD_SHA" -F force=true >/dev/null 2>&1 \
    && echo "  tag 已移动到 HEAD" || echo "  ⚠ tag 移动失败，请手动检查"
fi

# 清掉同 tag 的历史孤儿草稿
timeout 40 gh api "repos/${GH_REPO}/releases?per_page=50" \
  --jq ".[] | select(.draft==true and .tag_name==\"v${NEW_VERSION}\") | .id" 2>/dev/null \
  | while read -r rid; do [ -n "$rid" ] && timeout 40 gh api -X DELETE "repos/${GH_REPO}/releases/${rid}" >/dev/null 2>&1; done

# ---------------------------------------------------------------- 收尾校验
echo
echo "=== 校验更新链路 ==="
python3 - "$GH_REPO" "$NEW_VERSION" "$APK_NAME" <<'PY'
import json, sys, urllib.request
repo, ver, apk = sys.argv[1], sys.argv[2], sys.argv[3]
def req(u):
    r = urllib.request.Request(u, headers={"Accept": "application/vnd.github+json",
                                           "User-Agent": "StepXStudio-Updater"})
    return json.load(urllib.request.urlopen(r, timeout=25))
rel = req(f"https://api.github.com/repos/{repo}/releases/latest")
ok = True
if rel["tag_name"].lstrip("v") != ver:
    print(f"  ✗ latest tag = {rel['tag_name']}，期望 v{ver}"); ok = False
sel = next((a for a in rel["assets"] if a["name"] == apk and a["state"] == "uploaded"), None)
if not sel:
    print(f"  ✗ 资产 {apk} 未找到；实际 {[a['name'] for a in rel['assets']]}"); ok = False
elif not (sel["digest"].startswith("sha256:") and len(sel["digest"]) == 71):
    print("  ✗ digest 格式不合法"); ok = False
else:
    print(f"  ✓ tag=v{ver}  资产={apk}  {sel['size']} bytes")
print("  ✓ 更新链路可用" if ok else "  ✗ 更新链路有问题")
PY

echo
echo "=== 完成 ==="
echo "  版本    : $NEW_VERSION (versionCode $NEW_CODE)"
echo "  APK     : $APK"
echo "  Release : https://github.com/$GH_REPO/releases/tag/v$NEW_VERSION"
echo
echo "  装到手机：adb install -r \"$APK\""
