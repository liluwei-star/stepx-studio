/*
 * 项目概览不能把上下文吃光，也不能让「点发送」卡住。
 *
 * 概览是每条带项目的 AI 消息都会附上的一段上下文。它有两个真实的坑：
 *
 * ① 逐字符数行 —— charAt 在 Java 里是解释执行的 O(n)，
 *    82 MB 的项目就是几千万次调用。这段跑在「用户点发送之后、
 *    请求发出之前」，表现是「点了没反应」。
 *
 * ② 大项目全量罗列 —— 331 个文件的路径清单就是几十 KB，
 *    和用户真正问的那句话一起发出去，注意力被稀释；
 *    而且 debugReports 能到几百 KB，每轮都重发一遍。
 *
 * 概览要回答的是「这是个什么形状的项目」，不是「把所有文件列一遍」。
 * 详细清单模型可以用 list_files 按需取 —— 那才是它该干的事。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const main = read('src/cn/com/scsxrkj/MainActivity.java');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 数行改用 indexOf，不再逐字符 ─────────────────');
const seg = main.slice(main.indexOf('JSONObject structure=new JSONObject();'),
                       main.indexOf('String activeFile=params.optString("activeFile"'));
ok('找得到概览构造段', seg.length > 200);
ok('用 indexOf 推进数行', /int nl=content\.indexOf\('\\n'\)/.test(seg));
ok('不再逐字符 charAt 扫全文', !/content\.charAt\(i\)==='\\n'/.test(seg),
  '仍在用 charAt 逐字符扫 —— 大项目会卡');

console.log('\n── 概览有条数上限 ──────────────────────────────');
ok('存在 OVERVIEW_MAX 上限', /final int OVERVIEW_MAX=\d+/.test(seg));
ok('超过上限时截断', /if\(n\+\+>=OVERVIEW_MAX\)continue;/.test(seg));
ok('截断时明确说明', /put\("truncated",true\)/.test(seg));
ok('截断时给出目录分布', /put\("topDirs"/.test(seg));
ok('告诉模型怎么拿完整清单', /需要完整清单用 list_files/.test(seg));
ok('总文件数仍然如实给出', /put\("totalFiles",total\)/.test(seg));

console.log('\n── 附加信息要有截断 ─────────────────────────────');
ok('存在 clip 工具方法', /static String clip\(String s,int cap\)/.test(main));
ok('调试报告被截断', /clip\(target\.optString\("debugReports","\[\]"\),\d+\)/.test(main));
ok('美术资源被截断', /clip\(target\.optString\("artAssets","\[\]"\),\d+\)/.test(main));
ok('截断会说明还剩多少', /后面还有 "/.test(main));

console.log('\n── 超限时仍然明确报错，不静默截断 ───────────────');
ok('上下文超限仍然显式失败',
  /项目内容超过本机传输限制/.test(main));
ok('历史+上下文一起算',
  /msgChars\+context\.length\(\)>limitChars/.test(main));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
