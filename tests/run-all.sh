#!/usr/bin/env bash
#
# 跑所有不需要手机的自动化测试。
#
# <p>为什么要有这个入口：
#
# <p>以前测试散在 tests/ 目录里，每个都得手动敲命令跑。
# 结果就是——改了东西，测什么全凭记性，回归就漏。
#
# <p>这些测试不碰手机、不碰网络，几秒钟就能跑完，
# 所以它们应该在「改完代码 → 装机」之间跑，而不是发版前才想起来。
#
# 用法：bash tests/run-all.sh
#
set -u
cd "$(dirname "$0")/.." || exit 1

FAILED=""
PASSED=0

echo "═══════════════════════════════════════════"
echo "  Studio 自动化测试（不需要手机）"
echo "═══════════════════════════════════════════"
echo ""

# Node 测试：tests/*.test.mjs 和 tests/*.cjs
# 排除 device 相关的（那些是 .py，需要真机）。
for f in tests/*.test.mjs tests/*_test.cjs tests/*-test.cjs; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  echo "── $name ─────────────────────────────"
  # 注意：不能用 `node "$f" | tail -6` —— 管道的退出码是 tail 的，
  # 永远是 0，测试失败会被当成通过（这坑踩过一次）。
  # 要用 PIPESTATUS 或者先存输出再看。
  out=$(node "$f" 2>&1)
  rc=$?
  echo "$out" | tail -6
  if [ $rc -eq 0 ]; then
    PASSED=$((PASSED+1))
  else
    FAILED="$FAILED $name"
    echo "  ^^ $name 失败（退出码 $rc）"
  fi
  echo ""
done

echo "═══════════════════════════════════════════"
if [ -n "$FAILED" ]; then
  echo "  失败：$FAILED"
  echo "═══════════════════════════════════════════"
  exit 1
fi
echo "  全部通过（$PASSED 个测试文件）"
echo "═══════════════════════════════════════════"
