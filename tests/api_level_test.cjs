/*
 * 源码里不能出现高于 minSdk 的 API。
 *
 * <p><b>背景：</b>本应用最低支持 API 24，构建脚本用
 * {@code d8 --min-api 24} 做 dex 转换，但<b>没有开核心库脱糖</b>
 * （core library desugaring）。也就是说：
 *
 * <p>源码里写 {@code "x".repeat(1000)}，javac 不会报错（用 JDK 21 编译），
 * d8 也不会报错（它只看 dex 指令，不查 java.lang 的 API 级别），
 * APK 照样打出来 —— 直到用户在一台 Android 7.0 的手机上点进自测，
 * 才抛 {@code NoSuchMethodError}。
 *
 * <p><b>真实案例：</b>{@code String.repeat} 是 API 33 才有的。
 * {@code SelfTest.java} 里有三处用了它，其中两处是早就存在的 ——
 * 也就是说 API 24 设备上的自测一直是崩的，只是我们手上这台是 SDK 36，
 * 从来没暴露过。
 *
 * <p><b>为什么这类 BUG 危险：</b>它不在编译期、不在打包期、不在测试期，
 * 只在<b>特定系统版本的真机上</b>才出现。发到应用商店后只有用户能发现。
 *
 * <p>这里用 SDK 自带的 {@code api-versions.xml} 作为权威版本表，
 * 扫出所有会用到高于 minSdk 的 API 的地方。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIN_SDK = 24;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

/* ------------------------------------------------------------------ *
 * 1. 定位 SDK 的 api-versions.xml —— 这是 Android 官方的版本表
 * ------------------------------------------------------------------ */
const SDK = process.env.ANDROID_SDK_ROOT || 'C:/Users/llw/tools/androidsdk';
const apiVersions = path.join(SDK, 'platforms', 'android-36', 'data', 'api-versions.xml');

console.log('\n── 判据一：能拿到官方 API 版本表 ──────');
const hasTable = fs.existsSync(apiVersions);
ok('找到 api-versions.xml', hasTable, apiVersions);
if (!hasTable) {
  console.log('  （跳过扫描：没有版本表就没法判定）');
} else {
  const xml = fs.readFileSync(apiVersions, 'utf8');

  /* ---------------------------------------------------------------- *
   * 2. 解析版本表
   *
   * <p>结构：{@code <class name="java/lang/String" since="1"> ... }
   * 里面的 {@code <method name="repeat(I)..." since="33"/>} 标明了
   * 这个方法从哪个 API 版本开始才有。
   * ---------------------------------------------------------------- */
  const classes = {};
  const classRe = /<class name="([^"]+)"(?:\s+since="(\d+)")?[^>]*>([\s\S]*?)<\/class>/g;
  let cm;
  while ((cm = classRe.exec(xml)) !== null) {
    const [, cname, csince, body] = cm;
    const methods = {};
    const mRe = /<method name="([^"]+)"[^>]*since="(\d+)"/g;
    let mm;
    while ((mm = mRe.exec(body)) !== null) {
      const sig = mm[1];
      const simple = sig.split('(')[0];
      // 同一个方法名有重载，取「最早引入」的那个 —— 只要有一个重载可用就不算违规
      if (methods[simple] === undefined || Number(mm[2]) < methods[simple]) {
        methods[simple] = Number(mm[2]);
      }
    }
    classes[cname] = { since: csince ? Number(csince) : 1, methods };
  }

  console.log('\n── 判据二：版本表解析出足够多的类 ──────');
  ok('解析出 java/lang/String', !!classes['java/lang/String']);
  ok('解析出 java/util/List', !!classes['java/util/List']);
  ok('String.repeat 被识别为 API 33', classes['java/lang/String'] &&
    classes['java/lang/String'].methods['repeat'] === 33,
    classes['java/lang/String'] ? String(classes['java/lang/String'].methods['repeat']) : 'no class');
  ok('String.join 被识别为 API 26', classes['java/lang/String'] &&
    classes['java/lang/String'].methods['join'] === 26,
    classes['java/lang/String'] ? String(classes['java/lang/String'].methods['join']) : 'no class');

  /* ---------------------------------------------------------------- *
   * 3. 扫源码
   * ---------------------------------------------------------------- */
  const ROOTS = ['src/cn/com/scsxrkj', 'shared-src', 'runtime-src'];

  /*
   * 需要单独盯的高版本 API 清单。
   *
   * <p>为什么不全靠版本表自动推：自动推要解决「方法调用在哪个类上」的问题，
   * 而源码里大量是 {@code someVar.repeat()} 这种静态类型看不出来的形式。
   * 人工列清单 + 版本表核对 API 号，两边都准确。
   */
  const SUSPECTS = [
    { token: '.repeat(', cls: 'java/lang/String', method: 'repeat', label: 'String.repeat' },
    { token: '.isBlank()', cls: 'java/lang/String', method: 'isBlank', label: 'String.isBlank' },
    { token: '.strip()', cls: 'java/lang/String', method: 'strip', label: 'String.strip' },
    { token: '.stripIndent()', cls: 'java/lang/String', method: 'stripIndent', label: 'String.stripIndent' },
    { token: '.formatted(', cls: 'java/lang/String', method: 'formatted', label: 'String.formatted' },
    { token: 'String.join(', cls: 'java/lang/String', method: 'join', label: 'String.join' },
    { token: 'List.of(', cls: 'java/util/List', method: 'of', label: 'List.of' },
    { token: 'Set.of(', cls: 'java/util/Set', method: 'of', label: 'Set.of' },
    { token: 'Map.of(', cls: 'java/util/Map', method: 'of', label: 'Map.of' },
    { token: 'List.copyOf(', cls: 'java/util/List', method: 'copyOf', label: 'List.copyOf' },
    { token: 'Map.copyOf(', cls: 'java/util/Map', method: 'copyOf', label: 'Map.copyOf' },
  ];

  function collectFiles() {
    const out = [];
    for (const r of ROOTS) {
      const dir = path.join(ROOT, r);
      if (!fs.existsSync(dir)) continue;
      const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.java')) out.push(full);
        }
      };
      walk(dir);
    }
    return out;
  }

  /*
   * 判断某一行是不是在注释里 —— 注释里提到 API 名字是说明文，不是调用。
   */
  function isCommentLine(line) {
    const s = line.trim();
    if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*')) return true;
    // 「不用 String.join —— 那是 API 26」这类说明
    if (/API\s*\d+/.test(line)) return true;
    if (/不(用|要|能)用/.test(line)) return true;
    return false;
  }

  console.log('\n── 判据三：源码没有用到高于 minSdk(' + MIN_SDK + ') 的 API ──────');
  const files = collectFiles();
  ok('扫到 Java 源文件', files.length > 0, String(files.length));

  const violations = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      if (isCommentLine(line)) return;
      for (const s of SUSPECTS) {
        if (!line.includes(s.token)) continue;
        const info = classes[s.cls];
        if (!info) continue;
        const since = info.methods[s.method];
        if (since === undefined) continue;
        if (since > MIN_SDK) {
          violations.push({
            file: path.relative(ROOT, f).replace(/\\/g, '/'),
            line: idx + 1,
            label: s.label,
            since,
            code: line.trim().slice(0, 90),
          });
        }
      }
    });
  }

  if (violations.length) {
    for (const v of violations) {
      console.log('    ' + v.file + ':' + v.line + '  ' + v.label +
        ' 需要 API ' + v.since + '  <<' + v.code + '>>');
    }
  }
  ok('没有高于 minSdk 的 API 调用', violations.length === 0,
    violations.length + ' 处违规');

  /* ---------------------------------------------------------------- *
   * 4. 顺带验一条：构建脚本确实是 --min-api 24 且没开脱糖
   *
   * <p>如果哪天有人改用 Gradle 并开了脱糖，这条规则就该放宽。
   * 这里先按现状断言，变了会提醒重新评估。
   * ---------------------------------------------------------------- */
  console.log('\n── 判据四：构建配置与本测试的前提一致 ──────');
  const buildSh = fs.readFileSync(path.join(ROOT, 'build-windows.sh'), 'utf8');
  ok('构建用 d8 --min-api 24', /--min-api\s+24/.test(buildSh));
  ok('构建没有开核心库脱糖（所以版本检查是必要的）',
    !/core-library-desugaring|--desugaring-lib|desugar_jdk_libs/.test(buildSh));
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
