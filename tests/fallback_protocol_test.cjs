/*
 * 回归测试：降级路径（模型不支持原生 tools）下的协议识别。
 *
 * 背景（真实 BUG）：
 *   降级路径靠从模型正文里抠 JSON 来执行工具。但「抠得出 JSON」不等于
 *   「这是工具协议」—— 用户问「JSON 怎么写」，模型的回答里必然有花括号，
 *   于是：
 *     ① 解析成功但里面没有 tools/files/answer → 用户的示例被当成指令执行；
 *     ② 解析失败且文本里有 { → 正确答案被判成「格式错误」，
 *        触发重试，最后用户只看到「模型返回的内容无法解析」。
 *
 * 正确判据：整段文本是不是一个 JSON 对象。
 *   - 模型想发协议 → 整段就是一个 JSON → 算格式错误，让它重写；
 *   - 模型在讲代码 → JSON 只是其中一段，前后还有别的字 → 算正常回答。
 *
 * 本测试用 JS 复刻 DevAgent 的判定逻辑（原生是 Java，设备自测另有断言）。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'cn', 'com', 'scsxrkj');

function readSrc(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

/* ---------- 复刻 DevAgent 的两个判定 ---------- */

function indexOfJsonStart(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '{' || c === '[') return i;
  }
  return -1;
}

function endOfJsonObject(s, from) {
  let inString = false, escaped = false, depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s.charAt(i);
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function looksLikeProtocolText(text) {
  if (text == null) return false;
  const s = text.trim();
  if (!s) return false;
  const from = indexOfJsonStart(s);
  if (from < 0) return false;
  if (from > 0) return false;
  const to = endOfJsonObject(s, from);
  if (to >= 0) return s.substring(to + 1).trim().length === 0;
  /* 配不上对（JSON 写坏了）：只要整段只有一个 {，仍像是想发一份协议 */
  let braces = 0;
  for (let i = 0; i < s.length; i++) if (s.charAt(i) === '{') braces++;
  return braces === 1;
}

function isProtocolBody(body) {
  if (body == null) return false;
  const own = (k) => Object.prototype.hasOwnProperty.call(body, k);
  return own('tools') || own('files') || own('answer');
}

/* ---------- 1. 纯回答不该被当成协议 ---------- */

// 用户问 JSON 怎么写，模型回答里带花括号和示例
const teaching = 'JSON 对象用花括号包起来，比如 {"name":"张三","age":18}。';
assert.strictEqual(looksLikeProtocolText(teaching), false,
  '讲 JSON 语法的回答不该被当成协议');
assert.ok(!isProtocolBody({ name: '张三', age: 18 }),
  '普通对象的键不是协议字段');

// 回答里带代码块
const codeAnswer = '可以这样写：\n```js\nconst o = {a:1};\n```';
assert.strictEqual(looksLikeProtocolText(codeAnswer), false,
  '带代码块的回答不该被当成协议');

// CSS / 数学公式里的花括号
const cssAnswer = '按钮样式这样写：\n.button { color: red; }';
assert.strictEqual(looksLikeProtocolText(cssAnswer), false,
  'CSS 里的花括号不该被当成协议');

// 纯文字
assert.strictEqual(looksLikeProtocolText('项目里有 3 个文件。'), false,
  '纯文字回答不该被当成协议');

/* ---------- 2. 真协议应该被认出来 ---------- */

assert.strictEqual(looksLikeProtocolText('{"tools":[{"name":"list_files","args":{}}]}'), true,
  '完整的工具协议是协议');
assert.strictEqual(looksLikeProtocolText('{"files":{"index.html":"<h1>hi</h1>"}}'), true,
  '完整的文件协议是协议');
assert.strictEqual(looksLikeProtocolText('  {"answer":"好的"}  '), true,
  '前后有空白也算协议');
assert.strictEqual(looksLikeProtocolText('{"tools":['), true,
  '内容写坏了但整段是 JSON，也算「想发协议」→ 值得让它重写');

assert.ok(isProtocolBody({ tools: [] }), 'tools 是协议字段');
assert.ok(isProtocolBody({ files: {} }), 'files 是协议字段');
assert.ok(isProtocolBody({ answer: 'x' }), 'answer 是协议字段');
assert.ok(!isProtocolBody({}), '空对象不是协议');
assert.ok(!isProtocolBody(null), 'null 不是协议');

/* ---------- 3. 原生侧必须真的用了这两个判定 ---------- */

const agent = readSrc('DevAgent.java');

assert.ok(agent.includes('static boolean isProtocolBody(JSONObject body)'),
  'DevAgent 应有 isProtocolBody');
assert.ok(agent.includes('static boolean looksLikeProtocolText(String text)'),
  'DevAgent 应有 looksLikeProtocolText');
assert.ok(agent.includes('if(!isProtocolBody(body)){'),
  '解析成功后要先判断是不是协议');
assert.ok(agent.includes('if(!rawText.isEmpty()&&!looksLikeProtocolText(rawText)'),
  '解析失败时要先判断像不像协议');
assert.ok(!agent.includes("rawText.indexOf('{')<0"),
  '旧的「有没有花括号」判据必须去掉（会把正确回答当成格式错误）');

console.log('  ✓ 降级路径协议识别：18 项断言全部通过');
console.log('ALL PASS (fallback_protocol_test)');
