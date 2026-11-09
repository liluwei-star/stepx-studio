#!/usr/bin/env node
/**
 * 回归测试：从模型回复里定位 JSON 的起点和终点。
 *
 * <p>这两个函数是「把模型的自然语言和机器协议拆开」的唯一手段：
 * 正文要原样显示给用户，工具调用 JSON 要交给执行器。
 * 拆错一次，要么用户看不见 AI 说的话，要么这一轮的工具调用整个丢掉。
 *
 * <p><b>缺陷背景 —— 只数深度不认括号类型：</b>
 * 原来的写法是
 *
 * <pre>
 * if (c == '{' || c == '[') depth++;
 * else if (c == '}' || c == ']') { depth--; if (depth == 0) return i; }
 * </pre>
 *
 * <p>{@code { } 和 [ ]} 被当成同一种东西，所以只要数量凑够就算配平。
 * 于是 {@code {"a":1]}} 这种括号写串的片段，会在 {@code ]} 处被判成「配平」，
 * 截出一个注定解析不了的半个字符串交给 JSON 解析器。
 *
 * <p>模型的输出并不总是合法 JSON：中文标点串进来、输出被截断、
 * 手写括号写错，都会出现这类情况。正确的处理是「配不平就别当成 JSON」，
 * 让上层按没有协议处理（继续说人话、或者走重试），
 * 而不是拿一段坏文本去撞解析器。
 *
 * <p>本测试从源码取出真实的两个方法编译运行，用真的字符串跑，
 * 不是对着源码字面量做断言。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(path.resolve(__dirname), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

/*
 * 抠方法时必须跳过字符串和字符字面量。
 *
 * <p>被抠的方法正文里会出现 '{'、'}' 这样的字符字面量（判断括号类型就是这么写的），
 * 只按字符配平会把这些当成真的花括号，于是截出来的方法体在错误位置收尾，
 * 编译报一堆莫名其妙的错 —— 而产品代码其实是对的。
 */
function grabMethod(java, signature) {
  const start = java.indexOf(signature);
  if (start < 0) throw new Error('找不到方法：' + signature);
  let i = java.indexOf('{', start), depth = 0, state = 'code';
  for (; i < java.length; i++) {
    const c = java[i], n = java[i + 1];
    if (state === 'line') { if (c === '\n') state = 'code'; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i++; } continue; }
    if (state === 'str') { if (c === '\\') { i++; continue; } if (c === '"') state = 'code'; continue; }
    if (state === 'chr') { if (c === '\\') { i++; continue; } if (c === "'") state = 'code'; continue; }
    if (c === '/' && n === '/') { state = 'line'; i++; continue; }
    if (c === '/' && n === '*') { state = 'block'; i++; continue; }
    if (c === '"') { state = 'str'; continue; }
    if (c === "'") { state = 'chr'; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return java.slice(start, i + 1); }
  }
  throw new Error('方法没闭合：' + signature);
}

const scan = read('src/cn/com/scsxrkj/JsonScan.java');
const mStart = grabMethod(scan, 'static int indexOfJsonStart(String s) {');
const mEnd = grabMethod(scan, 'static int endOfJsonObject(String s, int from) {');

/*
 * 样本用「输入 → 期望的结束下标」直接写在 Java 里。
 * 里面出现的"这里有个 } 括号"这种中文说明是故意的：要测字符串内括号不算配对。
 */
const HARNESS = `
package cn.com.scsxrkj;

/**
 * 探针：跑真实的 indexOfJsonStart / endOfJsonObject。
 */
public class ScanProbe {

${mStart}

${mEnd}

    /** 把一段文本的扫描结果打成一行：start 与 end，找不到用 -1 */
    static void probe(String label, String text) {
        int from = indexOfJsonStart(text);
        int to = from < 0 ? -1 : endOfJsonObject(text, from);
        System.out.println("S_" + label + "=" + from + "," + to);
    }

    public static void main(String[] a) {
        probe("PLAIN", "{\\"a\\":1}");
        probe("ARRAY", "[1,2,3]");
        probe("NESTED", "{\\"a\\":{\\"b\\":[1,2]}}");
        probe("OBJ_IN_ARRAY", "[{\\"a\\":1},{\\"b\\":2}]");

        // 字符串里的括号不能算配对
        probe("BRACE_IN_STRING", "{\\"text\\":\\"这里有个 } 符号\\"}");
        probe("BRACKET_IN_STRING", "{\\"text\\":\\"数组 [1,2] 写法\\"}");
        probe("ESCAPED_QUOTE", "{\\"a\\":\\"he said \\\\\\"hi\\\\\\"\\"}");

        // 前后有说明文字
        probe("WITH_PREFIX", "好的，我来改：{\\"tools\\":[]}  改完了");
        probe("TRAILING_TEXT", "{\\"answer\\":\\"完工\\"} 补充一句");

        // ── 本轮修复：括号类型必须配得上 ──
        probe("MISMATCH_1", "{\\"a\\":1]}");
        probe("MISMATCH_2", "[1,2}");
        probe("MISMATCH_3", "{\\"a\\":[1,2}");

        // 截断
        probe("TRUNCATED", "{\\"a\\":1");
        probe("TRUNCATED_STRING", "{\\"a\\":\\"没收尾");

        // 起点不是括号
        probe("NOT_BRACKET", "abc");
        probe("FROM_OUT_OF_RANGE", "{}");
        System.out.println("S_FROM_NEG=" + endOfJsonObject("{}", -1));
        System.out.println("S_FROM_PAST=" + endOfJsonObject("{}", 5));
        System.out.println("S_NULL=" + endOfJsonObject(null, 0));
        System.out.println("S_NULL_START=" + indexOfJsonStart(null));
    }
}
`;

const tmpDir = path.join(__dirname, '.tmp-scan');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'ScanProbe.java'), HARNESS);

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
try {
  execFileSync(path.join(JAVA_HOME, 'bin', 'javac.exe'),
    ['-encoding', 'UTF-8', '-nowarn', '-d', path.join(tmpDir, 'out'),
      path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'ScanProbe.java')], { stdio: 'pipe' });
} catch (e) {
  console.error('编译失败：\n' + (e.stdout || '').toString() + (e.stderr || '').toString());
  process.exit(1);
}

const raw = execFileSync(path.join(JAVA_HOME, 'bin', 'java.exe'),
  ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', path.join(tmpDir, 'out'),
    'cn.com.scsxrkj.ScanProbe'], { encoding: 'utf8' });
const v = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) v[m[1]] = m[2].trim();
}

/*
 * 期望的结束下标 = 字符串长度 - 1。几个样本的字符数：
 *   {"a":{"b":[1,2]}}            17
 *   [{"a":1},{"b":2}]            17
 *   {"text":"这里有个 } 符号"}    20
 *   {"text":"数组 [1,2] 写法"}    22
 *   {"a":"he said \"hi\""}       22
 * 中文按一个字符算（Java 的 char 对 BMP 内汉字就是一个）。
 */
console.log('\n── 正常结构：起点终点都要准 ────────────────────');
ok('平坦对象', v.S_PLAIN === '0,6', v.S_PLAIN);
ok('数组', v.S_ARRAY === '0,6', v.S_ARRAY);
ok('嵌套对象', v.S_NESTED === '0,16', v.S_NESTED);
ok('数组里套对象', v.S_OBJ_IN_ARRAY === '0,16', v.S_OBJ_IN_ARRAY);

console.log('\n── 字符串里的括号不算配对 ──────────────────────');
ok('字符串里有 }', v.S_BRACE_IN_STRING === '0,19', v.S_BRACE_IN_STRING);
ok('字符串里有 [1,2]', v.S_BRACKET_IN_STRING === '0,21', v.S_BRACKET_IN_STRING);
ok('转义引号不影响判断', v.S_ESCAPED_QUOTE === '0,21', v.S_ESCAPED_QUOTE);

console.log('\n── 前后夹着自然语言 ────────────────────────────');
ok('前面有说明文字', v.S_WITH_PREFIX && v.S_WITH_PREFIX.startsWith('7,'), v.S_WITH_PREFIX);
ok('后面还有补充', v.S_TRAILING_TEXT && v.S_TRAILING_TEXT.startsWith('0,'), v.S_TRAILING_TEXT);

console.log('\n── 本轮修复：括号类型配不上时不能当 JSON ────────');
ok('{ 配 ] 判为配不平', v.S_MISMATCH_1 === '0,-1', '被当成配平了：' + v.S_MISMATCH_1);
ok('[ 配 } 判为配不平', v.S_MISMATCH_2 === '0,-1', '被当成配平了：' + v.S_MISMATCH_2);
ok('嵌套里配错也判为配不平', v.S_MISMATCH_3 === '0,-1', '被当成配平了：' + v.S_MISMATCH_3);

console.log('\n── 截断：一律判为配不平，不能截半个 ────────────');
ok('对象没闭合', v.S_TRUNCATED === '0,-1', v.S_TRUNCATED);
ok('字符串没收尾', v.S_TRUNCATED_STRING === '0,-1', v.S_TRUNCATED_STRING);

console.log('\n── 边界输入 ────────────────────────────────────');
ok('没有括号返回 -1', v.S_NOT_BRACKET === '-1,-1', v.S_NOT_BRACKET);
ok('起点为负数返回 -1', v.S_FROM_NEG === '-1', v.S_FROM_NEG);
ok('起点越界返回 -1', v.S_FROM_PAST === '-1', v.S_FROM_PAST);
ok('null 文本返回 -1', v.S_NULL === '-1', v.S_NULL);
ok('null 起点扫描返回 -1', v.S_NULL_START === '-1', v.S_NULL_START);

console.log('\n── 实现必须用栈，而不是只数深度 ────────────────');
const endBody = grabMethod(scan, 'static int endOfJsonObject(String s, int from) {');
ok('用栈记录括号', /ArrayDeque|Stack/.test(endBody), '没有用栈，只数深度就分不出 { 和 [');
ok('校验闭合符类型',
  endBody.includes('want') && endBody.includes("'['") && endBody.includes("'{'"),
  '没有比对期望的闭合符');
ok('不再用裸 depth 计数', endBody.indexOf('depth++') < 0, '还在用 depth++ 计数');

console.log('\n----------------------------------------------------');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED ' + fail) + ' (json_scan_test)  ' + pass + ' 项');
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
