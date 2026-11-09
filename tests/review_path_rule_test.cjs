/*
 * 审查页必须认得 AI 实际会改的文件。
 *
 * 这条 BUG 的现场是这样：
 *
 *   用户拿一个 React + TSX 工程让 AI 改 src/App.tsx —— AI 改好了，
 *   点「审查并应用」，页面只说一句「没有可应用的根目录文本文件」。
 *   改了跟没改一样。
 *
 * 原因在审查页自己的过滤规则：
 *   路径正则 /^[\p{L}\p{N}_-][\p{L}\p{N} ._-]{0,99}$/ 不含 /，
 *   所以 src/App.tsx 直接被过滤掉；
 *   扩展名白名单只有 html|css|js|json|md|txt|svg，没有 ts/tsx/jsx/mjs。
 *
 * 而后端 ProjectEdits.validate 明明接受子目录和这些扩展名 ——
 * 两套规则各写一份，前端这份把项目的绝大多数文件挡在外面。
 *
 * 规则只能有一份，而且必须是宽的那份。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const collab = read('assets/collab.js');
const edits = read('src/cn/com/scsxrkj/ProjectEdits.java');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 前端不再用「根目录专用」的路径正则 ───────────');
ok('旧的根目录正则已移除', collab.indexOf('{0,99}$/u.test(n)') < 0,
  '旧的 99 字符根目录正则还在');
ok('改成逐段校验的 reviewablePath',
  collab.indexOf('function reviewablePath(n)') >= 0);

console.log('\n── 扩展名覆盖编译器真正支持的源码 ──────────────');
/* 直接看那条白名单里有没有这个扩展名，别绕正则转义 */
const extLine = (collab.match(/const REVIEW_EXT=\/[^/]+\/i;/) || [''])[0];
for (const ext of ['html', 'css', 'js', 'jsx', 'mjs', 'ts', 'tsx', 'json', 'md', 'txt', 'svg']) {
  ok('前端认得 .' + ext, extLine.indexOf('|' + ext + '|') >= 0
    || extLine.indexOf('(' + ext + '|') >= 0
    || extLine.indexOf('|' + ext + ')') >= 0);
}
ok('后端也认得 ts/tsx/jsx/mjs',
  /html\|css\|js\|jsx\|mjs\|ts\|tsx\|json\|md\|txt\|svg/.test(edits));

console.log('\n── 危险路径仍然被挡住 ──────────────────────────');
ok('拒绝绝对路径', /startsWith\('\/'\)/.test(collab));
ok('拒绝 .. ', /includes\('\.\.'\)/.test(collab));
ok('拒绝反斜杠', /includes\('\\\\'\)/.test(collab));
ok('拒绝空段', /for\(const seg of n\.split\('\/'\)\)/.test(collab));
ok('路径长度仍然有上限', /n\.length>240/.test(collab));

console.log('\n── 审查应用仍走同一个提交口 ────────────────────');
ok('applyCandidate 仍然发 applyProjectFiles',
  /send\('applyProjectFiles'/.test(collab));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
