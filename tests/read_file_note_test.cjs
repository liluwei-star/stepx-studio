/*
 * 工具返回的提示不能被后写的覆盖掉。
 *
 * <p><b>背景：</b>read_file 会往结果里放一条 note，提醒模型
 * 「每行开头的『行号: 』是定位标记，不是文件内容；写回时不要带上」。
 *
 * <p>这条提示是防行号污染的第一道闸 —— 模型最容易犯的错就是把
 * read_file 的结果原样写回去，于是项目里每一行前面多一个「12: 」。
 * 而且这种损坏经常还能编译通过，用户只看到页面多了堆数字。
 *
 * <p><b>原来的 BUG：</b>read_file 在部分读取时又 put 了一次 note，
 * 把前一条整条盖掉。于是：
 * <ul>
 *   <li>读整个文件 → 有「行号不是内容」的提示；</li>
 *   <li>读一部分（startLine/lineCount）→ 提示消失，只剩「后面还有 N 行」。</li>
 * </ul>
 *
 * <p>模型偏偏最爱分段读（文件大，怕撑爆上下文），
 * 于是<b>越是认真读文件，越拿不到这条警告</b> ——
 * 恰好在最需要的时候把提示丢了。
 *
 * <p>这里跑真实的 Java 方法，验证两条提示同时存在。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const JAVAC = path.join(JAVA_HOME, 'bin', 'javac.exe');
const JAVA = path.join(JAVA_HOME, 'bin', 'java.exe');

/*
 * read_file 的提示拼装逻辑抽成一个独立方法更干净，
 * 但当前源码里是内联在 case 里的。
 * 所以这里用真实 Java 复现「连续两次 put(note)」的覆盖行为：
 * 直接测 org.json 的 JSONObject.put 语义 —— 后写的同名字段覆盖先写的。
 */
console.log('\n── 判据：同一个 key 连写两次，后者覆盖前者 ──────');
{
  const dir = path.join(ROOT, 'tests', '.tmp-note');
  fs.rmSync(dir, { recursive: true, force: true });
  // android.jar 里的 org.json 全是 throw Stub!，用项目自带的测试替身。
  // 替身源码在 support/orgjson/，但包名是 org.json ——
  // javac 要求目录结构跟包名一致，所以要摆成 org/json/ 再编译。
  const srcDir = path.join(dir, 'src', 'org', 'json');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const n of ['JSONObject.java', 'JSONArray.java']) {
    fs.copyFileSync(path.join(ROOT, 'tests', 'support', 'orgjson', n), path.join(srcDir, n));
  }
  fs.writeFileSync(path.join(dir, 'Note.java'),
    'public class Note{' +
    ' public static void main(String[] a)throws Exception{' +
    '  org.json.JSONObject o=new org.json.JSONObject();' +
    '  o.put("note","第一条");' +
    '  o.put("note","第二条");' +
    '  System.out.print(o.optString("note"));' +
    '}}');
  execFileSync(JAVAC, ['-encoding', 'UTF-8', '-d', dir,
    path.join(dir, 'Note.java'), path.join(srcDir, 'JSONObject.java'), path.join(srcDir, 'JSONArray.java')],
    { stdio: 'pipe' });
  const got = execFileSync(JAVA, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', dir, 'Note'],
    { encoding: 'utf8' });
  ok('后写的 note 确实会覆盖先写的（所以源码里就是覆盖）', got === '第二条', got);
}

console.log('\n── read_file 的两条提示必须同时在场 ──────────────');
{
  const java = read('src/cn/com/scsxrkj/LocalDevTools.java');
  const i = java.indexOf('case "read_file"');
  const seg = java.slice(i, java.indexOf('case "search_code"', i));

  const notes = [...seg.matchAll(/\.put\("note"\s*,\s*(.*)$/gm)].map(m => m[1]);
  ok('read_file 里只有一处 put("note")', notes.length === 1, '找到 ' + notes.length + ' 条');

  // 判据：不能再有「无条件 put note」覆盖前面那条的情况。
  // 正确写法是把两条提示攒进列表，最后一次性 put。
  ok('部分读取那条提示没有把行号提示整条盖掉',
    !/if\(end<lines\.length\)\s*\n?\s*out\.put\("note"/.test(seg),
    '源码里仍是无条件覆盖');

  ok('两条提示都进了列表', /notes\.add\("每行开头的/.test(seg) && /notes\.add\("这次只读到第/.test(seg));
  ok('最后一次性 put 出去', /out\.put\("note",joinNotes\(notes\)\)/.test(seg));
  ok('行号提示仍然存在', /「行号: 」/.test(seg));
}

console.log('\n── 其他工具的 note 不得互相覆盖 ────────────────');
{
  const java = read('src/cn/com/scsxrkj/LocalDevTools.java');
  // 只讨论 read_file：其余 note 都是互斥分支或不同工具
  const others = java.replace(/case "read_file"[\s\S]*?case "search_code"/, '');
  const dupWithinCase = [];
  const cases = [...others.matchAll(/case "([a-z_]+)"\{/g)];
  for (let k = 0; k < cases.length; k++) {
    const start = cases[k].index;
    const end = k + 1 < cases.length ? cases[k + 1].index : others.length;
    const body = others.slice(start, end);
    if ((body.match(/\.put\("note"/g) || []).length > 1) dupWithinCase.push(cases[k][1]);
  }
  ok('没有别的工具在同一分支里写两次 note', dupWithinCase.length === 0, dupWithinCase.join(','));
}

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
