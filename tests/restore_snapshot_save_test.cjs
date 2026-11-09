/*
 * 「恢复上一版」必须在提交前落盘，否则恢复只恢复一半。
 *
 * <p><b>背景：</b>原生的冲突检测是 {@code same(项目当前文件, base)}。
 * 前端传的 base 走 allFileContents —— 用 currentContent，
 * <b>包含编辑暂存</b>（editBuffer）；而项目当前文件只反映<b>已落盘</b>的内容。
 *
 * <p>编辑器的保存是 400 毫秒防抖。用户敲完字立刻点「恢复上一版」，
 * 那 400 毫秒还没到，项目里存的还是旧内容 ——
 * 两边一比，「文件已变化」，原生走抢救路径。
 *
 * <p>抢救路径只恢复「没被用户改过」的文件，于是恢复出来是<b>残缺的</b>：
 * 用户明明只想回到上一版，结果只回滚了一部分，
 * 而且界面上没有任何提示说明少了哪些。
 *
 * <p>applyCandidate（应用候选文件）早就修过这个问题 —— 先 saveProject()
 * 再提交。这里漏了同一个修复。
 *
 * <p>本测试验证：恢复动作提交前必须先落盘。
 */
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(ok, msg, detail) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (detail ? ' -> ' + detail : '')); }
}

const collab = read('assets/collab.js');
const appJs = read('assets/app.js');

console.log('\n── 恢复动作必须先落盘 ────────────────────────────');
{
  const i = collab.indexOf("case 'restoreSnapshot':");
  check(i > 0, 'the restoreSnapshot action exists');
  const seg = collab.slice(i, i + 1400);

  check(/saveProject\(\)/.test(seg),
    'the restore action saves the editor buffer before submitting',
    'no saveProject() found near the restore action');

  const saveAt = seg.indexOf('saveProject()');
  const sendAt = seg.indexOf("send('restoreProjectFiles'");
  check(saveAt > 0 && sendAt > 0 && saveAt < sendAt,
    'the save happens before the restore request is sent',
    'save at ' + saveAt + ', send at ' + sendAt);

  check(/base:allFileContents\(p\)/.test(seg),
    'the restore still sends the current file contents as the baseline');
}

console.log('\n── 落盘失败要中止恢复 ────────────────────────────');
{
  const i = collab.indexOf("case 'restoreSnapshot':");
  const seg = collab.slice(i, i + 1400);
  check(/catch\(e\)\{[^}]*notice\([^)]*未恢复/.test(seg),
    'a failed save aborts the restore and tells the user',
    seg.slice(0, 500));
  // 失败后不能还发请求
  const catchAt = seg.indexOf('catch(e)');
  const sendAt = seg.indexOf("send('restoreProjectFiles'");
  check(catchAt > 0 && sendAt > catchAt,
    'the request is not sent when the save failed');
}

console.log('\n── 与 applyCandidate 保持一致 ────────────────────');
{
  const i = collab.indexOf('function applyCandidate()');
  const seg = collab.slice(i, i + 1600);
  check(/saveProject\(\)/.test(seg),
    'applyCandidate still saves before applying');
}

console.log('\n── 基线语义一致 ──────────────────────────────────');
{
  check(/function allFileContents\(p\)/.test(appJs),
    'allFileContents exists');
  const i = appJs.indexOf('function allFileContents(p)');
  const seg = appJs.slice(i, i + 300);
  check(/currentContent\(p,n\)/.test(seg),
    'the baseline uses currentContent, so it includes the edit buffer');
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
