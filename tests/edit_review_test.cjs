/*
 * 回归测试：AI 改动的「审查并应用」链路。
 *
 * 背景（真实 BUG）：
 *   前端「审查并应用」按钮读的是消息里的 edit.files（这次改了什么），
 *   而原生在构造聊天消息时用的是 editSummary()，它把 files 换成了
 *   changedFiles、把 base 换成了 baseHash。
 *   结果：点开审查页是空的 —— 或者更糟，AI 刚回复完时能点，
 *   任何一次 state 刷新后就点不了了（时好时坏，最难查的一类）。
 *
 * 本测试断言原生侧的契约：
 *   1. editForStore 保留 files（审查要用），去掉 base（几 MB 的 OOM 源）；
 *   2. editForStore 幂等（saveState 会重复调用）；
 *   3. 改动过大时降级为 changedFiles + filesOmitted，且不丢 changedFiles；
 *   4. editForUi 不带 base；
 *   5. 前端 reviewAiFiles 能在 filesOmitted 时给出提示而不是空审查页。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'cn', 'com', 'scsxrkj');

function readSrc(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}
function readAsset(name) {
  return fs.readFileSync(path.join(ROOT, 'assets', name), 'utf8');
}

/* ---------- 1. 原生：editForStore 的行为 ---------- */

const main = readSrc('MainActivity.java');

assert.ok(main.indexOf('JSONObject editForStore(JSONObject edit)') !== -1,
  'MainActivity 应有 editForStore');
assert.ok(main.indexOf('JSONObject editForUi(JSONObject edit)') !== -1,
  'MainActivity 应有 editForUi');
assert.strictEqual(main.indexOf('editSummary'), -1,
  '旧的 editSummary 应已移除（它会把 files 换成 changedFiles，正是审查失效的根因）');

/* editForStore 必须保留 files、排除 base */
const storeBody = main.slice(
  main.indexOf('JSONObject editForStore(JSONObject edit)'),
  main.indexOf('JSONObject editForStore(JSONObject edit)') + 2200);
assert.ok(/if\("base"\.equals\(k\)\|\|"files"\.equals\(k\)\)continue;/.test(storeBody),
  'editForStore 应排除 base 和 files 字段本身');
assert.ok(/out\.put\("files",files\);/.test(storeBody),
  'editForStore 应把 files 原样保留下来（审查要靠它）');
assert.ok(/out\.put\("changedFiles",names\);/.test(storeBody),
  'editForStore 应同时保留 changedFiles 名单');
assert.ok(/filesOmitted/.test(storeBody),
  'editForStore 应在改动过大时标记 filesOmitted');
assert.ok(/MAX_EDIT_FILES_CHARS/.test(storeBody),
  'editForStore 应受 MAX_EDIT_FILES_CHARS 体积上限约束');

/* editForUi 必须去掉 base */
const uiBody = main.slice(
  main.indexOf('JSONObject editForUi(JSONObject edit)'),
  main.indexOf('JSONObject editForUi(JSONObject edit)') + 900);
assert.ok(/if\("base"\.equals\(k\)\)continue;/.test(uiBody),
  'editForUi 应排除 base');

/* 构造消息与 reply 事件都必须用 editForStore，不能再用旧摘要 */
assert.ok(main.indexOf('.put("edit",editForStore(result.optJSONObject("edit")))') !== -1,
  '构造聊天消息时应用 editForStore');
assert.ok(/result\.put\("edit",editForStore\(editOut\)\)/.test(main),
  '推给 WebView 的 reply 事件也要瘦身');
assert.ok(main.indexOf('editSummary(result.optJSONObject("edit"))') === -1,
  'reply 事件不应再走旧摘要路径');

/* ---------- 2. 前端：审查按钮拿到 files 就能用 ---------- */

const app = readAsset('app.js');

const reviewCase = app.slice(app.indexOf("case 'reviewAiFiles'"),
  app.indexOf("case 'reviewAiFiles'") + 900);
assert.ok(reviewCase.length > 0, '前端应有 reviewAiFiles 处理分支');
assert.ok(/candidateFiles=edit\.files/.test(reviewCase),
  'reviewAiFiles 必须把 edit.files 交给审查页');
assert.ok(/candidateBase=allFileContents\(project\(\)\)/.test(reviewCase),
  'reviewAiFiles 应用当前项目内容作基线（edit.base 已不再下发）');
assert.ok(/edit\.filesOmitted/.test(reviewCase),
  'reviewAiFiles 必须处理 filesOmitted（改动太大时给提示，而不是空审查页）');
assert.ok(!/candidateBase=edit\.base/.test(reviewCase),
  'reviewAiFiles 不应再依赖 edit.base（原生已不下发该字段）');

/* 审查页确实只依赖 candidateFiles 的值是字符串或 null */
const collab = readAsset('collab.js');
assert.ok(/Object\.entries\(candidateFiles\)/.test(collab),
  '审查页应遍历 candidateFiles');
assert.ok(/c===null\?'删除'/.test(collab),
  '审查页应支持删除（值为 null 的文件）');

/* ---------- 3. 幂等性模拟：editForStore 跑两遍结果一致 ---------- */

/*
 * 这里用 JS 复刻 editForStore 的语义做一次幂等检查 ——
 * 原生是 Java，跑在设备上；但保存流程确实会重复调用它
 * （构造消息一次、saveState 清理一次），必须幂等。
 */
function editForStoreModel(edit, limit) {
  const out = {};
  for (const k of Object.keys(edit)) {
    if (k === 'base' || k === 'files') continue;
    out[k] = edit[k];
  }
  const files = edit.files;
  if (files) {
    const names = Object.keys(files);
    let size = 0;
    for (const n of names) size += n.length + String(files[n] == null ? '' : files[n]).length;
    out.changedFiles = names;
    if (size <= limit) out.files = files;
    else { out.filesOmitted = true; out.filesSize = size; }
  }
  if (edit.base) out.baseHash = 'hash';
  return out;
}

const LIMIT = 512 * 1024;
const sample = { status: 'review', message: '建议已生成', projectId: 'p1', base: { 'a.js': 'x' }, files: { 'a.js': 'y' } };

const once = editForStoreModel(sample, LIMIT);
const twice = editForStoreModel(once, LIMIT);
assert.deepStrictEqual(twice, once, 'editForStore 必须幂等');
assert.ok(once.files && once.files['a.js'] === 'y', '一次调用后 files 仍在');
assert.strictEqual(once.base, undefined, 'base 必须被去掉');
assert.ok(once.changedFiles && once.changedFiles[0] === 'a.js', 'changedFiles 名单要保留');

/* 超大改动降级 */
const big = { status: 'review', files: { 'a.js': 'z'.repeat(LIMIT + 10) } };
const bigOut = editForStoreModel(big, LIMIT);
assert.strictEqual(bigOut.files, undefined, '超大改动不应保留 files');
assert.strictEqual(bigOut.filesOmitted, true, '超大改动应标记 filesOmitted');
assert.ok(bigOut.changedFiles, '超大改动仍应保留 changedFiles');
/* 降级后再跑一次，仍然稳定 */
assert.deepStrictEqual(editForStoreModel(bigOut, LIMIT), bigOut, '降级后仍幂等');

console.log('  ✓ edit 审查链路：12 项断言全部通过');
console.log('ALL PASS (edit_review_test)');
