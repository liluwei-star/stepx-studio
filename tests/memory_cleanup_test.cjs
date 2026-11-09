/*
 * 删项目要连带删掉这个项目的记忆 —— 回归测试
 * ---------------------------------------------------------------
 * 要守住的行为：
 *   1. 彻底删除项目（purge）时，project-notes/<id>.md 要一起删掉。
 *   2. 记忆文件名规则只有一处定义（AiMemory 和 MainActivity 共用），
 *      两处各写一套的话，删除时就找不到那个文件，残留记忆会串进
 *      同 id 的新项目 —— 模型拿着别的项目的约定改代码，改出来的东西看着对、其实是错的。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'src/cn/com/scsxrkj/MainActivity.java');
const MEM = path.join(ROOT, 'src/cn/com/scsxrkj/AiMemory.java');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const main = fs.readFileSync(MAIN, 'utf8');
const mem = fs.readFileSync(MEM, 'utf8');

console.log('── 彻底删除要清项目记忆 ─────────────────────────────');
/* purge 分支里必须有删除 project-notes 的动作 */
const purgeStart = main.indexOf('action.equals("purge")');
ok(purgeStart > 0, '能定位 purge 分支');
const purgeBlock = main.slice(purgeStart, purgeStart + 2000);
ok(purgeBlock.includes('project-notes'), 'purge 分支处理 project-notes 目录');
ok(purgeBlock.includes('.delete()'), 'purge 分支真的删除了文件');
ok(purgeBlock.includes('safeNoteName(id)'), 'purge 用统一的项目记忆文件名规则');

console.log('\n── 文件名规则只有一处 ─────────────────────────────────');
ok(/static\s+String\s+safeNoteName\s*\(String\s+id\)/.test(main),
   'safeNoteName(id) 在 MainActivity 里定义');
ok(/MainActivity\.safeNoteName\s*\(projectId\)/.test(mem),
   'AiMemory.projectFile 复用同一个方法，不自己写一套');
ok(!/replaceAll\("\[\^A-Za-z0-9_-\]"/.test(mem),
   'AiMemory 里不再自己写一遍字符过滤');

console.log('\n── 规则本身要对 ─────────────────────────────────────');
function safeNoteName(id) {
  const safe = (id == null ? '' : String(id)).replace(/[^A-Za-z0-9_-]/g, '_');
  return safe === '' ? 'default' : safe;
}
ok(safeNoteName('abc123') === 'abc123', '普通 id 原样保留');
ok(safeNoteName('a/b') === 'a_b', '路径分隔符被替换（防目录穿越）');
/* '.' 也不在允许集里，所以点号同样被替换 —— 穿越路径彻底不成立 */
ok(safeNoteName('../etc') === '___etc', '点号和斜杠都被替换，穿越路径不成立');
ok(!safeNoteName('../../etc/passwd').includes('/'), '穿越路径里不含斜杠');
ok(!safeNoteName('../../etc/passwd').includes('.'), '穿越路径里不含点号');
ok(safeNoteName('') === 'default', '空 id 落到 default');
ok(safeNoteName(null) === 'default', 'null id 落到 default');
ok(safeNoteName('a b') === 'a_b', '空格被替换');

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '（' + pass + ' / ' + (pass + fail) + '）');
process.exit(fail === 0 ? 0 : 1);
