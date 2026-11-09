/*
 * 「只讨论项目」模式下，模型真动了文件，不能静默丢掉。
 *
 * 工具是跟着「本轮有没有目标项目」挂的 —— 只要项目绑定了，读文件改文件的
 * 工具就都在。用户选「只讨论」只是想先谈谈，但模型完全可能顺手调 write_files。
 *
 * 而写回分支原来要求 editMode 非空：只讨论模式下暂存区里的改动被直接丢掉，
 * 却没有任何提示。用户看到的是「AI 说改好了」，打开项目一个字没变 ——
 * 这是最伤信任的那种不一致：它嘴上说做了，实际没做，还不告诉你。
 *
 * 现在的规则：模型既然已经动手，就把它当成一次「待审查」交出来 ——
 * 不自动写，也不静默丢，用户点一下才落地，并且明说为什么会冒出一个待审查。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/MainActivity.java'), 'utf8')
  .replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 只讨论模式不会吞掉实际改动 ──────────────────');

ok('写回分支不再只认 editMode 非空',
  /String writeMode=editMode;/.test(main));
ok('先算改动、再决定写回（顺序不能反）',
  main.indexOf('JSONObject changes=new JSONObject();') < main.indexOf('String writeMode=editMode;'),
  '改动是在「决定写回」之后才算的，只讨论模式下会被跳过');
ok('有改动时只讨论模式转成待审查',
  /if\(writeMode\.isEmpty\(\)&&changes\.length\(\)>0\)writeMode="review";/.test(main));
ok('降级路径写在正文里的 files 也算改动',
  /changes=ProjectEdits\.parse\(result\.optString\("text"\)\)/.test(main)
  && main.indexOf('changes=ProjectEdits.parse') < main.indexOf('String writeMode=editMode;'));
ok('写回分支用的是 writeMode',
  /if\(result!=null&&baseline!=null&&!writeMode\.isEmpty\(\)\)\{/.test(main),
  '还在用 editMode，只讨论模式下整段写回被跳过');
/*
 * 自动应用只看 writeMode —— 但中间会插别的语句（比如删完文件顺手回收磁盘），
 * 所以不能要求 replaceProject 紧贴着 if。只要求：这个 if 里确实调了 replaceProject。
 */
ok('自动应用只看 writeMode',
  /if\(writeMode\.equals\("auto"\)\)\{[\s\S]{0,800}?replaceProject\(updated\);/.test(main));
ok('提示里说明为什么冒出待审查',
  /if\(editMode\.isEmpty\(\)\)baseMessage="这一轮是「只讨论」/.test(main));

/*
 * 反向检查：只讨论模式下不该有「自动应用」的口子。
 * 消息文案按 writeMode 分支，writeMode 是 review，所以走「等待审查应用」。
 */
ok('只讨论模式不会走「已保存到指定项目」这句',
  /writeMode\.equals\("auto"\)\?"已保存到指定项目/.test(main));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
