#!/usr/bin/env bash
# 重建 assets/runtime-template.apk —— 生成的 App 所用的运行壳
#
# 运行壳是独立预编译的 APK，不会随 build-windows.sh 自动重建。
# 改过 runtime-src/ 或 shared-src/ 之后必须单独跑这个脚本。
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT}"
JDK="${JAVA_HOME:?Set JAVA_HOME}"
BT="$SDK/build-tools/36.0.0"

# 原生 Windows 工具只认 Windows 路径，classpath 分隔符是 ;
SDKW="$(cygpath -w "$SDK")"
BTW="$(cygpath -w "$BT")"
JDKW="$(cygpath -w "$JDK")"
CP="$SDKW\\platforms\\android-36\\android.jar;$BTW\\core-lambda-stubs.jar"

echo "[1/5] 编译资源"
rm -rf out/runtime
mkdir -p out/runtime/classes out/runtime/dex
"$BT/aapt2.exe" compile --dir runtime-res -o out/runtime/res.zip

echo "[2/5] 链接基础 APK"
"$BT/aapt2.exe" link -o out/runtime/base.apk \
  -I "$SDKW/platforms/android-36/android.jar" \
  --manifest runtime-manifest.xml out/runtime/res.zip

echo "[3/5] 编译 Java"
# 关键：不要用 -source 8 -target 8 -bootclasspath。
# JDK 21 在 Windows 上会报「平台类路径上找不到 java.lang」，改用 android.jar 当 classpath。
"$JDKW\\bin\\javac.exe" -classpath "$CP" -encoding UTF-8 -source 17 -target 17 -nowarn \
  -d "$(cygpath -w out/runtime/classes)" \
  runtime-src/cn/com/scsxrkj/runtime/*.java shared-src/cn/com/scsxrkj/matrix/*.java
echo "      class 文件：$(find out/runtime/classes -name '*.class' | wc -l)"

echo "[4/5] D8 转 dex"
find out/runtime/classes -name '*.class' -print0 | xargs -0 \
  "$JDKW\\bin\\java.exe" -cp "$(cygpath -w vendor/tools/r8-9.5.26.jar)" \
  com.android.tools.r8.D8 --min-api 30 \
  --lib "$SDKW/platforms/android-36/android.jar" --output out/runtime/dex

echo "[5/5] 打包 assets/runtime-template.apk"
python3 - <<'PY'
from pathlib import Path
import shutil, zipfile
shutil.copyfile('out/runtime/base.apk', 'assets/runtime-template.apk')
with zipfile.ZipFile('assets/runtime-template.apk', 'a', zipfile.ZIP_DEFLATED) as z:
    for p in Path('out/runtime/dex').glob('*.dex'):
        z.write(p, p.name)
print(f"      写出 assets/runtime-template.apk（{Path('assets/runtime-template.apk').stat().st_size} 字节）")
PY

echo "完成"
