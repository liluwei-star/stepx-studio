/*
 * 项目历史不能无限长。
 *
 * 每轮 AI 回复都往 project.history 追加一条，带着那一轮的完整正文。
 * 一天几十轮、用上几周，这个数组能涨到几千条、几 MB ——
 * 而整个 state 是整份读写的：每次保存都要把它序列化一遍，
 * 每次发消息也要把项目过一遍。用户感受到的是「越用越卡、越用越容易崩」。
 *
 * 更隐蔽的是单条长度：模型有时候会吐几千字的解释，
 * 一条历史就是十几 KB。留 120 条、每条上限 4000 字符，
 * 上限就是 480 KB —— 有界，可预期。
 *
 * 真回溯用的是快照（完整文件内容），历史只负责「我刚才让它改了什么」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const main = read('src/cn/com/scsxrkj/MainActivity.java');
const editsSrc = read('src/cn/com/scsxrkj/ProjectEdits.java');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 有明确的上限 ────────────────────────────────');
ok('单条正文有上限常量', /static final int HISTORY_TEXT_CAP=\d+/.test(main));
/*
 * 条数上限只有一处定义，在 ProjectEdits。
 * 它有两条写入路径：AI 请求收尾（MainActivity）和 AI 改动落地（ProjectEdits.apply）。
 * 两条路必须共用同一份上限，否则哪条漏了就会无限长 —— 所以断言「MainActivity 里没有第二份」。
 */
ok('条数有上限常量', /static final int HISTORY_KEEP=\d+/.test(editsSrc));
ok('MainActivity 不再定义第二份上限', !/static final int HISTORY_KEEP=/.test(main));
const cap = +(main.match(/HISTORY_TEXT_CAP=(\d+)/) || [])[1];
const keep = +(editsSrc.match(/HISTORY_KEEP=(\d+)/) || [])[1];
ok('上限是有限的、合理的数值', cap > 0 && cap <= 20000 && keep > 0 && keep <= 500,
  `cap=${cap} keep=${keep}`);

console.log('\n── 裁剪真的接在写入路径上 ──────────────────────');
ok('存在 trimHistory', /static JSONArray trimHistory\(JSONArray h\)/.test(editsSrc));
ok('写入历史时把正文截断', /put\("text",clip\(result\.optString\("text"\),HISTORY_TEXT_CAP\)\)/.test(main));
ok('写入之后调用 trimHistory', /project\.put\("history",ProjectEdits\.trimHistory\(h\)\);project\.put\("updated"/.test(main));
ok('AI 改动落地时也裁剪', /out\.put\("history",trimHistory\(h\)\)/.test(editsSrc));

console.log('\n── 裁剪保留的是最近的那些 ──────────────────────');
const iTrim = editsSrc.indexOf('static JSONArray trimHistory(JSONArray h)');
const body = iTrim >= 0 ? editsSrc.slice(iTrim, iTrim + 400) : '';
ok('从尾部取，保留最近的', /for\(int i=h\.length\(\)-HISTORY_KEEP;i<h\.length\(\);i\+\+\)/.test(body));
ok('不超过上限时不动', /h\.length\(\)<=HISTORY_KEEP\)return h;/.test(body));

console.log('\n── 快照仍然完整（回溯不靠历史）──────────────────');
ok('快照仍然记录改动前的内容', /delta\.put\(n,base\.optString\(n,""\)\)/.test(editsSrc));
ok('快照仍然有条数上限', /SNAP_KEEP/.test(read('src/cn/com/scsxrkj/CloudFiles.java')));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
