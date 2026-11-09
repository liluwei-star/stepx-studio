/*
 * 用户点「删文件」，文件必须真的被删掉。
 *
 * <p><b>背景：</b>前端的保存走的是「合并」语义 —— 原生
 * {@code saveProjectFrom} 收到 files 清单后，只把内容 put 进去，
 * <b>从不做删除</b>。这是对的：files 是「路径 → 内容」的增量清单，
 * 没提到的路径就该保持原样（不然每存一次都会把其他文件清空）。
 *
 * <p><b>但删文件走的是同一条路。</b>前端做了：
 * <pre>
 *   delete p.files[file];   // 从前端清单里删掉
 *   delete editBuffer[file];
 *   saveProject();          // 把剩下的清单发过去
 * </pre>
 * 原生看到的是「这个文件不在清单里了」，于是<b>原样保留</b>。
 *
 * <p>结果：界面上的文件树里没了，磁盘上还在。
 * 用户删掉一个 200 KB 的文件，重开项目它又回来了；
 * 编译时那个文件还在参与构建（import 报错指向一个「已经删掉」的文件）；
 * 同步到云端也照样带着它 —— 因为云端拿的是同一份没删掉的内容。
 *
 * <p>更隐蔽的是：前端 {@code p.files[file]=0} 之后，
 * 状态清单里这个文件的「字节数」变成了 0，看起来像「空文件」，
 * 而实际内容还在。用户完全看不出哪里不对。
 *
 * <p>这里验证两件事：
 * <ol>
 *   <li>原生保存路径必须能表达「删除这个文件」；</li>
 *   <li>前端删文件时必须把删除意图传过去。</li>
 * </ol>
 */
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(ok, msg, detail) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (detail ? ' -> ' + detail : '')); }
}

const java = read('src/cn/com/scsxrkj/MainActivity.java');
const appJs = read('assets/app.js');

console.log('\n── 原生保存路径要能表达删除 ──────────────────────');

check(/void saveProjectFrom\(JSONObject incoming\)/.test(java),
  'saveProjectFrom exists');

/*
 * 原生这一段必须真的执行删除。
 * 这里跑真实的 Java：把 saveProjectFrom 的核心逻辑搬出来跑，
 * 验证「清单里少了一个文件 → 原生那边真的把它删了」。
 *
 * saveProjectFrom 依赖 MainActivity，搬不动；
 * 所以这里把它的合并逻辑原样抽出来（正则抠源码里的删除分支），
 * 断言源码里存在真正的删除动作。
 */
const saveBody = java.slice(java.indexOf('void saveProjectFrom(JSONObject incoming)'));
const saveEnd = saveBody.indexOf('\n }');
const saveSeg = saveBody.slice(0, saveEnd > 0 ? saveEnd : 2000);

check(/deletedFiles|removedFiles/.test(saveSeg),
  'the save path can carry a list of files to delete',
  'no delete channel in saveProjectFrom');

const delHelper = (() => {
  const i = java.indexOf('static void applyDeletes(');
  if (i < 0) return '';
  const j = java.indexOf('\n }', i);
  return java.slice(i, j > 0 ? j : i + 2000);
})();
check(delHelper.length > 0 && /\.remove\(/.test(delHelper),
  'the delete helper really removes a file from the merged table');

console.log('\n── 前端删文件必须把删除意图传过去 ────────────────');
{
  const i = appJs.indexOf("case 'deleteFile':");
  const seg = appJs.slice(i, i + 400);
  check(i > 0, 'the deleteFile action exists');
  check(/pendingDeletes\.push\(file\)/.test(seg),
    'the delete action records the path for the native side',
    seg.slice(0, 220));
  check(/delete p\.files\[file\]/.test(seg),
    'the file is still dropped from the frontend list');
}

console.log('\n── 删除清单不能被合并逻辑忽略 ─────────────────────');
{
  // merged 的构造必须把 deletedFiles 应用到 dst 上
  check(/dst\.remove\(/.test(saveSeg) || /\.remove\(n\)/.test(saveSeg)
    || (/\.remove\(/.test(delHelper) && /applyDeletes\(merged,del\)/.test(saveSeg)),
    'the merged table drops the deleted paths');
  // 前端保存时必须把待删清单发出去
  const si = appJs.indexOf('function saveProject(');
  const sSeg = appJs.slice(si, si + 1600);
  check(/payload\.deletedFiles\s*=\s*pendingDeletes\.slice\(\)/.test(sSeg),
    'saveProject ships the pending delete list to the native side');
  check(/pendingDeletes=\[\]/.test(sSeg),
    'the pending delete list is cleared after a successful save');
}

console.log('\n── 二进制引用和大文件也要跟着清 ───────────────────');
{
  check(/binaryFiles/.test(saveSeg) || /binaryFiles/.test(delHelper),
    'the delete path also drops the binary reference');
  // gcBigFiles 现在不带参数：它拿整个 state 算存活集合（内容寻址后同一份 .bin
  // 可能被多个项目共用），参数那个版本是个用不到的形参。
  check(/gcBigFiles\(\)/.test(saveSeg),
    'unreferenced big files are reclaimed after a delete');
}

console.log('\n── 待删清单不能串项目 ───────────────────────────');
{
  const si = appJs.indexOf('function saveProject(');
  const sSeg = appJs.slice(si, si + 1800);
  // 归属检查必须在「发送删除清单」之前
  const chk = sSeg.indexOf('pendingDeleteProject!==p.id');
  const ship = sSeg.indexOf('payload.deletedFiles');
  check(chk > 0, 'the pending delete list is bound to a project');
  check(chk > 0 && ship > chk,
    'the project check happens before the delete list is shipped',
    'check at ' + chk + ', ship at ' + ship);
  // 换项目时清空
  const oi = appJs.indexOf("type==='projectOpen'");
  const oSeg = appJs.slice(oi, oi + 900);
  check(/pendingDeletes=\[\]/.test(oSeg),
    'opening another project clears the pending delete list');
}

console.log('\n── 云端项目同样要能删文件 ────────────────────────');
{
  const i = appJs.indexOf("case 'deleteFile':");
  const seg = appJs.slice(i, i + 400);
  check(/cloudSource/.test(seg),
    'the delete action still handles cloud projects (validSourcePath etc.)');
  check(!/cloudSource[^;]*return/.test(seg),
    'the delete action does not bail out early for cloud projects');
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
