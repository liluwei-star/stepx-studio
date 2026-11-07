#!/usr/bin/env bash
# =============================================================================
# 在 Windows 上构建 StepX Studio（stepx-studio）工作台自身
# -----------------------------------------------------------------------------
# 背景：仓库自带的 build.sh 是按 macOS/Linux 写的，在 Windows + Git Bash 下有多处
#       硬伤（原生程序不认 MSYS 路径、class 版本不匹配、通配符不展开）。
#       这个脚本是 Windows 专版修正。
#
# 依赖（本机已就位或脚本自动准备）：
#   JDK 21+        litertlm 是 Java 21 编译的（class 版本 65），
#                  JDK 17 会报 "文件版本 65.0，应为 61.0"
#   Android SDK 36 build-tools + platform-36
#   apktool.jar    C:/Users/llw/tools/apktool.jar
#
# 用法：
#   ANDROID_SDK_ROOT=<sdk> JAVA_HOME=<jdk21> ./build-windows.sh [debug|release]
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

MODE="${1:-release}"
TOOLS="C:/Users/llw/tools"
export JAVA_HOME="${JAVA_HOME:?Set JAVA_HOME to a JDK 21+}"
SDK="${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT}"

# ---------------------------------------------------------------------------
# 中文路径陷阱：aapt2 / aapt / zipalign / apksigner 是原生 Windows 程序，
# 对非 ASCII 路径会报 "failed to open directory"。仓库若放在含中文的目录
# （如 "StepX Neo 手机"）下，构建必须先同步到纯 ASCII 的影子目录。
# ---------------------------------------------------------------------------
if echo "$REPO" | grep -qP '[^\x00-\x7F]'; then
  SHADOW="$TMPDIR/stepx-build-$$"
  rm -rf "$SHADOW"; mkdir -p "$SHADOW"
  echo "  [路径] 仓库含非 ASCII 字符，构建副本 -> $SHADOW"
  # 排除构建产物与版本库，只同步构建所需内容
  for item in AndroidManifest.xml runtime-manifest.xml build.sh build-runtime.sh \
              prepare-local-ai.py res runtime-res assets src shared-src runtime-src vendor; do
    [ -e "$REPO/$item" ] && cp -r "$REPO/$item" "$SHADOW/"
  done
  BUILD_ROOT="$SHADOW"
  trap 'rm -rf "$SHADOW"' EXIT
else
  BUILD_ROOT="$REPO"
fi

# 原生 Windows 程序只认 Windows 路径 —— 全部转换
SDKW="$(cygpath -w "$SDK")"
BTW="$SDKW/build-tools/36.0.0"
PW="$(cygpath -w "$BUILD_ROOT")"
KEYW="$(cygpath -w "${NEO_SIGNING_DIR:-$HOME/.neo-signing-studio}")"

# 每次调用都把通配符展开成显式列表（Windows 的 java 不认 shell 通配符）
CP="$SDKW/platforms/android-36/android.jar;$BTW/core-lambda-stubs.jar;$PW/vendor/apksig-android-4.4.0.jar"
for j in "$BUILD_ROOT"/vendor/local-ai/*.jar; do CP="$CP;$(cygpath -w "$j")"; done

echo "=== 构建 StepX Studio（$MODE）==="
echo "  JAVA_HOME : $JAVA_HOME"
echo "  SDK       : $SDK"
echo "  keystore  : $KEYW"
echo

# --- 0. 端侧 AI 依赖 --------------------------------------------------------
echo "[0/6] 准备端侧 AI 依赖（校验 SHA-256）"
cd "$BUILD_ROOT" && python prepare-local-ai.py

# --- 1. 签名材料 ------------------------------------------------------------
mkdir -p "$NEO_SIGNING_DIR" 2>/dev/null || true
mkdir -p "$KEYW"
if [ ! -f "$NEO_SIGNING_DIR/keystore.p12" ]; then
  echo "[1/6] 生成工作台签名 keystore"
  ( umask 077; python3 -c "import secrets;print(secrets.token_hex(24))" > "$NEO_SIGNING_DIR/password" )
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KEYW/keystore.p12" -storetype PKCS12 \
    -storepass:file "$KEYW/password" -keypass:file "$KEYW/password" \
    -alias neo -keyalg RSA -keysize 3072 -validity 10000 \
    -dname 'CN=StepX Studio, O=scsxrkj, C=CN' >/dev/null 2>&1
  echo "      已生成：$NEO_SIGNING_DIR/keystore.p12"
else
  echo "[1/6] 复用已有 keystore"
fi

# --- 2. 资源编译 ------------------------------------------------------------
echo "[2/6] aapt2 编译资源"
rm -rf out; mkdir -p out/classes out/dex out/gen
cp "$BUILD_ROOT/AndroidManifest.xml" "$BUILD_ROOT/out/AndroidManifest.xml"
if [ "$MODE" = "debug" ]; then
  python - <<'PY'
from pathlib import Path
p = Path('out/AndroidManifest.xml')
s = p.read_text(encoding='utf-8')
s = s.replace('android:usesCleartextTraffic="false"',
              'android:usesCleartextTraffic="true" android:debuggable="true"')
p.write_text(s, encoding='utf-8')
PY
fi
mkdir -p "$PW/out"
"$BTW/aapt2.exe" compile --dir "$PW/res" -o "$PW/out/compiled.zip"
"$BTW/aapt2.exe" link -o "$PW/out/resources.apk" \
  -I "$SDKW/platforms/android-36/android.jar" \
  --manifest "$PW/out/AndroidManifest.xml" --java "$PW/out/gen" \
  -A "$PW/assets" "$PW/out/compiled.zip"

# --- 3. Java 编译 -----------------------------------------------------------
# 关键：不能加 -source 8 -target 8 —— litertlm 是 Java 21 字节码
#       （class 版本 65），低版本 target 会直接拒绝加载。
echo "[3/6] javac 编译 Java 源码"
"$JAVA_HOME/bin/javac" -classpath "$CP" -encoding UTF-8 -source 17 -target 17 -nowarn \
  -d "$PW/out/classes" \
  "$PW/src/cn/com/scsxrkj/"*.java "$PW/shared-src/cn/com/scsxrkj/matrix/"*.java
echo "      class 文件：$(find out/classes -name '*.class' | wc -l)"

# --- 4. dex -----------------------------------------------------------------
echo "[4/6] D8 转 dex"
find out/classes -name '*.class' -print0 | xargs -0 \
  "$JAVA_HOME/bin/java" -cp vendor/tools/r8-9.5.26.jar com.android.tools.r8.D8 \
  --min-api 24 --lib "$SDKW/platforms/android-36/android.jar" \
  --output out/dex vendor/apksig-android-4.4.0.jar vendor/local-ai/*.jar

# --- 5. 打包 ----------------------------------------------------------------
echo "[5/6] 打包 + 对齐"
python - <<'PY'
from pathlib import Path
import zipfile, shutil
shutil.copyfile('out/resources.apk', 'out/unaligned.apk')
with zipfile.ZipFile('out/unaligned.apk', 'a', zipfile.ZIP_DEFLATED) as z:
    for p in Path('out/dex').glob('*.dex'):
        z.write(p, p.name)
    for p in Path('vendor/local-ai/jni/arm64-v8a').glob('*.so'):
        z.write(p, 'lib/arm64-v8a/' + p.name)
PY
"$BTW/zipalign.exe" -f 4 "$PW/out/unaligned.apk" "$PW/out/aligned.apk"

# --- 6. 签名 ----------------------------------------------------------------
echo "[6/6] 签名 + 验证"
mkdir -p "$REPO/dist"
OUT="StepXStudio-$(python3 -c "
import re;print(re.search(r'versionName=\"([^\"]+)\"',open('AndroidManifest.xml',encoding='utf-8').read()).group(1))")-$MODE.apk"
"$BTW/apksigner.bat" sign --ks "$KEYW/keystore.p12" --ks-key-alias neo \
  --ks-pass "file:$KEYW/password" --out "$PW/out/final.apk" "$PW/out/aligned.apk"
"$BTW/apksigner.bat" verify --verbose "$PW/out/final.apk" | head -6
mkdir -p "$REPO/dist"
cp "$PW/out/final.apk" "$REPO/dist/$(basename "$OUT")"
( cd "$REPO/dist" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

echo
echo "  APK : $REPO/dist/$(basename "$OUT")"
echo "  SHA : $(cut -d' ' -f1 "$REPO/dist/$(basename "$OUT").sha256")"
echo
echo "  安装到手机：adb install -r \"$REPO/dist/$(basename "$OUT")\""
