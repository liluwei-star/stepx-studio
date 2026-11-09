/*
 * 「变更」视图的差量存档要算对。
 *
 * <p><b>背景：</b>存档有两种形态。
 *
 * <ul>
 *   <li><b>全量</b> —— 里面是当时的全部文件；</li>
 *   <li><b>差量</b> —— 里面只有那次改动过的文件的旧内容，
 *       新建的文件用 null 标记（表示「存档时刻还不存在」）。</li>
 * </ul>
 *
 * <p>差量要先<b>叠回</b>当前文件表，才得到「改动前」的完整样子：
 * 用存档里的旧内容覆盖同名文件，其余保持当前值。
 *
 * <p><b>原来的前端算反了：</b>它把差量表里没有的文件一律当成「新增」，
 * 而差量表<b>本来就只记改动过的文件</b> —— 于是用户项目里几十个
 * 没动过的文件全被列成「新增」，真正被改掉的那个文件反倒显示「无修改」。
 *
 * <p>表现是：AI 改完 index.html，用户打开「变更」看到
 * 「新增 style.css / main.js / README.md …」，而 index.html 不在列表里。
 * 用户以为 AI 把项目搞乱了，其实只是前端算错了。
 *
 * <p>Java 侧（ProjectDiff.against）一直是对的 —— 也就是说
 * AI 自己看到的变更和用户看到的变更对不上，审查页也会跟着显示错。
 *
 * <p>这里直接从 assets/app.js 里抠出真实实现来测，不另抄一份。
 */
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('\n── 差量存档的叠回语义 ──────────────────────────────');

// 从 app.js 里抠出真实的 computeDiff
const start = app.indexOf('function computeDiff(');
if (start < 0) { console.log('  ✗ 找不到 app.js 里的 computeDiff'); process.exit(1); }
let src = app.slice(start);
const nextFn = src.indexOf('\nfunction ');
if (nextFn > 0) src = src.slice(0, nextFn);

// currentContent / snapshotFiles / fileContent 是 app.js 里别的函数，
// 这里按被测场景注入可控的替身。
function makeComputeDiff(snapFilesByIndex, currentByPath) {
  const snapshotFiles = (p, index) => snapFilesByIndex[index] || {};
  const currentContent = (p, path) => currentByPath[path];
  const fileContent = (p, path) => currentByPath[path];
  return new Function('snapshotFiles', 'currentContent', 'fileContent',
    src + '; return computeDiff;')(snapshotFiles, currentContent, fileContent);
}

console.log('\n── 场景：AI 改了 index.html、新增 a.js，项目还有 3 个没动过的文件 ──');
{
  // 差量存档：只记了改动过的两个文件。a.js 当时不存在 → null。
  const snapFiles = { 'index.html': 'OLD', 'a.js': null };
  const current = {
    'index.html': 'NEW',
    'a.js': 'brand new',
    'style.css': 'same css',
    'main.js': 'same main',
    'README.md': 'same readme',
  };
  const p = {
    id: 'p1',
    updated: 1,
    files: Object.fromEntries(Object.keys(current).map(k => [k, current[k]])),
    snapshots: [{ time: 1, delta: true, added: ['a.js'] }],
  };
  const computeDiff = makeComputeDiff({ 0: snapFiles }, current);
  const d = computeDiff(p);

  check(d.changed.length === 1 && d.changed[0] === 'index.html',
    'the file that was really modified is listed as modified (got: ' + JSON.stringify(d.changed) + ')');
  check(d.added.length === 1 && d.added[0] === 'a.js',
    'the newly created file is listed as added (got: ' + JSON.stringify(d.added) + ')');
  check(d.changed.indexOf('style.css') < 0 && d.changed.indexOf('main.js') < 0
    && d.changed.indexOf('README.md') < 0,
    'untouched files are not reported as modified');
  check(d.added.indexOf('style.css') < 0 && d.added.indexOf('main.js') < 0
    && d.added.indexOf('README.md') < 0,
    'untouched files are not reported as added (got: ' + JSON.stringify(d.added) + ')');
  check(d.same === 3,
    'the three untouched files count as unchanged (got: ' + d.same + ')');
  check(d.removed.length === 0,
    'nothing is reported as removed (got: ' + JSON.stringify(d.removed) + ')');
}

console.log('\n── 场景：AI 删掉了一个文件 ─────────────────────────');
{
  const snapFiles = { 'old.js': 'content of old.js' };
  const current = { 'index.html': 'same' };
  const p = {
    id: 'p2', updated: 1,
    files: { 'index.html': 'same' },
    snapshots: [{ time: 1, delta: true, added: [] }],
  };
  const computeDiff = makeComputeDiff({ 0: snapFiles }, current);
  const d = computeDiff(p);
  check(d.removed.length === 1 && d.removed[0] === 'old.js',
    'a deleted file is reported as removed (got: ' + JSON.stringify(d.removed) + ')');
  check(d.added.length === 0 && d.changed.length === 0,
    'the deletion is not also reported as added/modified');
}

console.log('\n── 场景：全量存档 ────────────────────────────────');
{
  const snapFiles = { 'index.html': 'OLD', 'style.css': 'same css' };
  const current = { 'index.html': 'NEW', 'style.css': 'same css' };
  const p = {
    id: 'p3', updated: 1,
    files: { 'index.html': 'NEW', 'style.css': 'same css' },
    snapshots: [{ time: 1 }],   // 没有 delta → 全量
  };
  const computeDiff = makeComputeDiff({ 0: snapFiles }, current);
  const d = computeDiff(p);
  check(d.changed.length === 1 && d.changed[0] === 'index.html',
    'a full snapshot reports the modified file');
  check(d.same === 1, 'a full snapshot counts the identical file as unchanged (got: ' + d.same + ')');
}

console.log('\n── 差量叠回的口径必须和 Java 侧一致 ──────────────');
{
  // Java 侧 ProjectDiff.against 的差量分支：oldFiles = nowFiles 起步，
  // 用存档旧内容覆盖，null 删掉，added 名单也删掉。
  const javaDelta = (nowFiles, snapFiles, addedLater) => {
    const oldFiles = Object.assign({}, nowFiles);
    for (const n of Object.keys(snapFiles)) {
      if (snapFiles[n] === null) delete oldFiles[n]; else oldFiles[n] = snapFiles[n];
    }
    for (const n of addedLater) delete oldFiles[n];
    const added = [], changed = [], removed = []; let same = 0;
    for (const n of Object.keys(nowFiles)) {
      if (!(n in oldFiles)) { added.push(n); continue; }
      if (oldFiles[n] === nowFiles[n]) same++; else changed.push(n);
    }
    for (const n of Object.keys(oldFiles)) if (!(n in nowFiles)) removed.push(n);
    return { added: added.sort(), changed: changed.sort(), removed: removed.sort(), same };
  };

  const nowFiles = { 'index.html': 'NEW', 'a.js': 'new', 'x.js': 'same', 'y.js': 'same', 'z.js': 'same' };
  const snapFiles = { 'index.html': 'OLD', 'a.js': null };
  const addedLater = ['a.js'];
  const p = {
    id: 'p4', updated: 1, files: nowFiles,
    snapshots: [{ time: 1, delta: true, added: addedLater }],
  };
  const computeDiff = makeComputeDiff({ 0: snapFiles }, nowFiles);
  const js = computeDiff(p);
  const java = javaDelta(nowFiles, snapFiles, addedLater);
  check(JSON.stringify(js.added) === JSON.stringify(java.added),
    'added list matches the Java side (' + JSON.stringify(js.added) + ' vs ' + JSON.stringify(java.added) + ')');
  check(JSON.stringify(js.changed) === JSON.stringify(java.changed),
    'changed list matches the Java side (' + JSON.stringify(js.changed) + ' vs ' + JSON.stringify(java.changed) + ')');
  check(JSON.stringify(js.removed) === JSON.stringify(java.removed),
    'removed list matches the Java side');
  check(js.same === java.same,
    'unchanged count matches the Java side (' + js.same + ' vs ' + java.same + ')');
}

console.log('\n── 差量存档不能把没动过的文件算成新增 ────────────');
{
  // 直接盯住判据：差量表里没有的文件，不是「新增」，
  // 因为差量表本来就只记改动过的文件。
  const snapFiles = { 'index.html': 'OLD' };
  const current = { 'index.html': 'NEW', 'keep.js': 'unchanged' };
  const p = {
    id: 'p5', updated: 1,
    files: { 'index.html': 'NEW', 'keep.js': 'unchanged' },
    snapshots: [{ time: 1, delta: true, added: [] }],
  };
  const computeDiff = makeComputeDiff({ 0: snapFiles }, current);
  const d = computeDiff(p);
  check(d.added.length === 0,
    'a file absent from the delta is not treated as added (got: ' + JSON.stringify(d.added) + ')');
  check(d.changed.length === 1 && d.changed[0] === 'index.html',
    'the changed file is still detected');
}

console.log('\n── 场景：二进制引用存在 bins 下（新存档格式）────────');
{
  const snapFiles = { 'index.html': 'same' };
  const current = { 'index.html': 'same' };
  const p = {
    id: 'p4', updated: 1,
    files: { 'index.html': 'same' },
    binaryFiles: { 'assets/a.png': 'aaa.bin', 'assets/b.png': 'bbb.bin' },
    snapshots: [{ time: 1, delta: true, added: [], bins: { 'assets/a.png': 'aaa.bin' } }],
  };
  const computeDiff = makeComputeDiff({ 0: snapFiles }, current);
  const d = computeDiff(p);
  /*
   * 新存档把二进制引用存在 bins 下。只读 binaryFiles 的话 oldBins 恒为空，
   * 已有的图会被全部列成「新增」—— 变更视图看着像项目被塞满了图。
   */
  check(d.addedBinary.length === 1 && d.addedBinary[0] === 'assets/b.png',
    'only the genuinely new binary is listed (got: ' + JSON.stringify(d.addedBinary) + ')');
}

console.log('\n── 场景：老存档把二进制引用存在 binaryFiles 下 ────────');
{
  const snapFiles = { 'index.html': 'same' };
  const current = { 'index.html': 'same' };
  const p = {
    id: 'p5', updated: 1,
    files: { 'index.html': 'same' },
    binaryFiles: { 'assets/a.png': 'aaa.bin' },
    snapshots: [{ time: 1, delta: true, added: [], binaryFiles: { 'assets/a.png': 'aaa.bin' } }],
  };
  const computeDiff = makeComputeDiff({ 0: snapFiles }, current);
  const d = computeDiff(p);
  check(d.addedBinary.length === 0,
    'an unchanged binary is not reported as new (got: ' + JSON.stringify(d.addedBinary) + ')');
}

console.log('\n── 场景：原生推给前端的瘦身快照（只有路径名）────────');
{
  const snapFiles = { 'index.html': 'same' };
  const current = { 'index.html': 'same' };
  const p = {
    id: 'p6', updated: 1,
    files: { 'index.html': 'same' },
    binaryFiles: { 'assets/a.png': 'aaa.bin', 'assets/b.png': 'bbb.bin' },
    snapshots: [{ time: 1, delta: true, added: [], binNames: ['assets/a.png'] }],
  };
  const computeDiff = makeComputeDiff({ 0: snapFiles }, current);
  const d = computeDiff(p);
  /*
   * 原生推给前端的快照是瘦身版：只有「存档当时有哪些二进制路径」，
   * 没有引用名。这条不通的话，用户在真机上看到的就是
   * 「所有图都是新增」。
   */
  check(d.addedBinary.length === 1 && d.addedBinary[0] === 'assets/b.png',
    'only the genuinely new binary is listed (got: ' + JSON.stringify(d.addedBinary) + ')');
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
