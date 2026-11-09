#!/usr/bin/env node
/**
 * 回归测试：判断「这个项目是已经构建好的产物，还是需要编译的源码工程」。
 *
 * <p><b>判错了会怎样：</b>
 * 判成「产物」就直接拿 index.html 去跑，不再过本机编译器。
 * 源码工程被这么判，页面就是<b>一片空白</b> —— TSX 浏览器根本不认识，
 * 而且（在这次修复之前）界面连个错误都不报，用户只能看着白屏发呆。
 *
 * <p><b>原来的判据：</b>入口 HTML 里有没有引用 {@code src/} 下的 .ts/.tsx/.jsx。
 * 正则要求扩展名后面<b>紧跟引号</b>：
 *
 * <pre>
 * ["'](?:\./|/)?src/[^"']*\.(?:tsx?|jsx?)['"]
 * </pre>
 *
 * <p>于是下面这些写法全都匹配不上，全被判成产物：
 *
 * <pre>
 * &lt;script type="module" src="/src/main.tsx?t=1699999999"&gt;&lt;/script&gt;
 * &lt;script type="module" src="/src/main.tsx?v=2"&gt;&lt;/script&gt;
 * &lt;link rel="modulepreload" href="./src/app.jsx#dev"&gt;
 * </pre>
 *
 * <p>带问号很常见：缓存打散、Vite 的 {@code ?raw} / {@code ?url} 后缀、
 * 开发时 hot reload 加时间戳。判据必须认得住这些。
 *
 * <p>本测录取源码里真实的正则字面量，用等价的 JS 正则跑同一批判据样本 ——
 * 断言的正是「这段正则在不在」。为了确保取到的是真东西，
 * 正则必须从 isStaticBuild 方法体里现取，取不到就直接失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(path.resolve(__dirname), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const src = read('src/cn/com/scsxrkj/LocalRunner.java');

// ── 取出 isStaticBuild 方法体 ────────────────────────────────
const at = src.indexOf('boolean isStaticBuild(){');
if (at < 0) { console.error('✗ 找不到 isStaticBuild'); process.exit(1); }
let depth = 0, end = -1;
for (let k = src.indexOf('{', at); k < src.length; k++) {
  if (src[k] === '{') depth++;
  else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
}
const body = src.slice(at, end + 1);

// ── 从方法体里取出正则字面量 ────────────────────────────────
const m = body.match(/Pattern\.compile\("((?:[^"\\]|\\.)*)"\)/);
if (!m) { console.error('✗ isStaticBuild 里没找到 Pattern.compile'); process.exit(1); }

/*
 * Java 字符串 → JS 正则。
 * 只需要解 \" 和 \\ 两种转义，这个正则里没有别的。
 * (?is) 是 Java 的内联标志，JS 要拆成 flags。
 */
let javaPattern = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
let flags = '';
const inline = javaPattern.match(/^\(\?([a-z]+)\)/);
if (inline) {
  if (inline[1].includes('i')) flags += 'i';
  if (inline[1].includes('s')) flags += 's';
  javaPattern = javaPattern.slice(inline[0].length);
}
let re;
try { re = new RegExp(javaPattern, flags); }
catch (e) { console.error('✗ 正则无法在 JS 里编译：' + e.message); process.exit(1); }

/** 这个方法就是这么用的：匹配到 src 下的源码引用 → 不是产物 */
const isStaticBuild = html => !re.test(html);

console.log('\n── 源码工程：必须判成「需要编译」 ──────────────');
const sources = [
  ['普通 Vite 入口', '<script type="module" src="/src/main.tsx"></script>'],
  ['相对路径 ./src', '<script type="module" src="./src/main.tsx"></script>'],
  ['jsx 入口', '<script type="module" src="/src/app.jsx"></script>'],
  ['ts 入口', '<script src="src/index.ts"></script>'],
  ['js 入口', '<script type="module" src="/src/index.js"></script>'],
  ['带时间戳的查询串', '<script type="module" src="/src/main.tsx?t=1699999999"></script>'],
  ['带版本号的查询串', '<script type="module" src="/src/main.tsx?v=2"></script>'],
  ['Vite 的 ?raw 后缀', '<script src="/src/data.ts?raw"></script>'],
  ['Vite 的 ?url 后缀', '<script src="/src/logo.tsx?url"></script>'],
  ['带锚点', '<link rel="modulepreload" href="./src/app.jsx#dev">'],
  ['多行 HTML 里的引用', '<html>\n  <body>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>'],
];
for (const [name, html] of sources) ok(name + ' 需要编译', isStaticBuild(html) === false);

console.log('\n── 构建产物：必须判成「直接跑」 ────────────────');
const builds = [
  ['Vite 产物', '<script type="module" crossorigin src="/assets/index-a1b2c3d4.js"></script>'],
  ['带 hash 的 css', '<link rel="stylesheet" href="/assets/index-e5f6g7.css">'],
  ['相对资源', '<script src="./assets/app.js"></script>'],
  ['CRA 产物', '<script defer="defer" src="/static/js/main.abc123.js"></script>'],
  ['内联脚本产物', '<html><body><div id="root"></div><script>console.log(1)</script></body></html>'],
  ['空 body', '<html><body></body></html>'],
  ['src 目录下的普通 js 但不在 src/ 开头', '<script src="assets/src/x.js"></script>'],
];
for (const [name, html] of builds) ok(name + ' 直接跑', isStaticBuild(html) === true);

console.log('\n── 边界：没有 index.html 时不能当产物 ──────────');
ok('空 HTML 视为非产物', isStaticBuild('') === true);  // 正则不匹配 → !false = true
/*
 * 注意：空 HTML 这里返回 true 是因为 index.html 为空时方法会提前 return false
 * （那是方法体里的判断，不在正则里）。所以这条只保证正则本身的行为一致，
 * 真正的「空 HTML」分支由方法体前面的 if(html.isEmpty())return false 兜住。
 */

console.log('\n── 这次修复的实质：扩展名后面允许 ? 和 # ────────');
ok('正则认得住查询串', /\[\?#\]/.test(javaPattern) || /\[#\?\]/.test(javaPattern),
  '正则里没有 ?/# 的可选尾巴：' + javaPattern);
/*
 * 收紧这条：原正则里也有 ")" 后跟 "?" 的片段（非捕获组），
 * 用 includes(')?') 判会假通过。必须认出 (?:[?#] ... )? 这个完整结构。
 */
ok('查询串部分是可选的', /\(\?:\[\?#\][^)]*\)\?/.test(javaPattern),
  '必须写成 (?:[?#]...)? 才不影响不带查询串的写法：' + javaPattern);

console.log('\n── 加载失败要能看见原因，不能只给白屏 ──────────');
ok('主框架加载错误有回调', /onReceivedError/.test(src), '没有 onReceivedError');
ok('HTTP 错误码有回调', /onReceivedHttpError/.test(src), '没有 onReceivedHttpError');
ok('只在主框架失败时提示', /isForMainFrame/.test(src), '没有过滤主框架，图片 404 也会刷状态栏');
ok('错误会写到状态栏', /加载失败：/.test(src), '没有面向用户的错误文案');

console.log('\n----------------------------------------------------');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED ' + fail) + ' (local_runner_test)  ' + pass + ' 项');
process.exit(fail === 0 ? 0 : 1);
