/*
 * AI 改完文件之后，编辑器里的内容必须跟着换。
 *
 * 这个测试盯的是一条真实的数据事故链：
 *
 *   editBuffer 是「编辑器里看到的内容」的权威来源 ——
 *   currentContent() 优先读它，输入框每次敲键也往它写。
 *
 *   AI 应用改动后，原生那边已经是新内容了，但 editBuffer 里
 *   还留着改之前的旧字符串。于是：
 *
 *     编辑器继续显示旧代码
 *        → 用户随手敲一个字（触发 saveProject）
 *        → 旧内容被整体写回原生
 *        → AI 刚写进去的改动被原样覆盖回去
 *
 * 而且没有任何提示，用户只会觉得「AI 又骗我，说改了其实没改」。
 *
 * 另外两条路必须一起修：
 *   ① 审查应用（filesApplied 事件）
 *   ② 自动应用（reply 事件里 edit.status === 'applied'）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8');
const collab = fs.readFileSync(path.join(ROOT, 'assets/collab.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 前提：editBuffer 确实是权威内容源 ──────────');
ok('currentContent 优先读 editBuffer',
  /function currentContent\(p,path\)\{\s*\n?\s*if\(editBuffer\[path\]!==undefined\)return editBuffer\[path\]/.test(app));
ok('输入框敲键会写 editBuffer',
  /editBuffer\[file\]=\$\('#code'\)\.value/.test(app));

console.log('\n── ① 审查应用路径（filesApplied）──────────────');
// 找到 filesApplied 分支的代码块
const iApplied = app.indexOf("type==='filesApplied'");
ok('存在 filesApplied 分支', iApplied >= 0);
const appliedBlock = iApplied >= 0 ? app.slice(iApplied, iApplied + 2000) : '';
ok('filesApplied 清空 editBuffer',
  /editBuffer=\{\};/.test(appliedBlock),
  appliedBlock.includes('editBuffer') ? '出现了 editBuffer 但没清空' : '完全没提到 editBuffer');

console.log('\n── ② 自动应用路径（reply + applied）──────────');
const iReply = app.indexOf("data.edit?.status==='applied'");
ok('存在自动应用刷新分支', iReply >= 0);
const replyBlock = iReply >= 0 ? app.slice(iReply, iReply + 900) : '';
ok('自动应用也清空 editBuffer',
  /editBuffer=\{\};/.test(replyBlock),
  replyBlock.includes('editBuffer') ? '出现了 editBuffer 但没清空' : '完全没提到 editBuffer');

console.log('\n── ③ 基线口径必须只有一份 ────────────────────');
/*
 * allFileContents 的返回值有两个用途：
 *   · 传给原生当 base 做冲突检测；
 *   · 审查页「当前文件」一侧的展示。
 * 如果它走 fileContent（只读已落盘），而展示走 currentContent（含暂存），
 * 两边看到的内容就不一样，冲突检测会误报或漏报。
 */
const iAll = app.indexOf('function allFileContents(p)');
ok('allFileContents 存在', iAll >= 0);
const allBlock = iAll >= 0 ? app.slice(iAll, iAll + 500) : '';
ok('allFileContents 走 currentContent，不走 fileContent',
  /out\[n\]=currentContent\(p,n\)/.test(allBlock),
  /out\[n\]=fileContent\(p,n\)/.test(allBlock) ? '仍在用 fileContent（口径不一致）' : '');

console.log('\n── ③b 换项目必须清暂存（editBuffer 不带项目 id）──');
const iOpen = app.indexOf("type==='projectOpen'");
ok('存在 projectOpen 分支', iOpen >= 0);
const openBlock = iOpen >= 0 ? app.slice(iOpen, iOpen + 700) : '';
ok('打开项目时清空 editBuffer',
  /editBuffer=\{\};/.test(openBlock),
  '没清 —— 两个项目都有 index.html 时会串内容');

console.log('\n── ③c 自动应用后清暂存，不管在哪个页面 ────────');
/*
 * 原来只在 page==='editor' 时清。可 AI 助手最常用的姿势是待在 AI 页聊，
 * 改完再切回编辑器 —— 那时看到的是改之前的内容，一保存就把改动覆盖了。
 */
const iReply2 = app.indexOf("data.edit?.status==='applied'");
const replyBlock2 = iReply2 >= 0 ? app.slice(iReply2, iReply2 + 1400) : '';
ok('自动应用不再以 page===\'editor\' 为前提',
  !/data\.edit\.projectId===projectId&&page==='editor'\)\{/.test(app));
ok('自动应用里仍然清 editBuffer', /editBuffer=\{\};/.test(replyBlock2));
ok('在 AI 页也会重绘', /if\(page==='editor'\)render\(\);else renderIfAi\(\);/.test(replyBlock2));

console.log('\n── ④ 应用前先把编辑暂存落盘 ──────────────────');
/*
 * 原生的冲突检测是 same(项目当前文件, base)。
 * base 含编辑暂存，项目当前文件只反映已落盘内容 ——
 * 不先落盘，刚敲过字的用户会被误报「文件已变化」。
 */
const iApply = collab.indexOf('function applyCandidate()');
ok('applyCandidate 存在', iApply >= 0);
const applyBlock = iApply >= 0 ? collab.slice(iApply, iApply + 2200) : '';
ok('应用前调用了 saveProject',
  /try\{saveProject\(\);/.test(applyBlock));
ok('落盘失败就不提交改动',
  /notice\('保存编辑内容失败，未应用改动：'/.test(applyBlock));
ok('落盘在 send(applyProjectFiles) 之前',
  applyBlock.indexOf('saveProject()') < applyBlock.indexOf("send('applyProjectFiles'"));

console.log('\n── ⑤ 编辑器渲染走 currentContent ──────────────');
/*
 * 用 fileContent 渲染，等于「撤销用户刚敲的字」：
 * 保存是异步的，两者之间有一段窗口不一致，
 * 期间任何一次重新渲染都会把输入框塞回磁盘上的旧内容。
 */
ok("编辑器渲染用 currentContent",
  /\$\('#code'\)\.value=currentContent\(p,file\)/.test(app),
  /\$\('#code'\)\.value=fileContent\(p,file\)/.test(app) ? '仍在用 fileContent' : '');

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
