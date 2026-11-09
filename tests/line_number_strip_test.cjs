/*
 * read_file 返回的内容每行带「12: 」这样的行号前缀。
 *
 * 那是给人看的定位信息，不是文件内容。
 *
 * 而模型最常见的动作是「读出来 → 改两行 → 整份写回」——
 * 它往往不会自己删掉那些前缀。结果就是行号被写进项目文件：
 * 每一行前面多一个「N: 」。更麻烦的是这种损坏经常还能编译通过
 * （在 JS 里就是一句标签 + 表达式），用户看到的是页面多了一堆数字，
 * 完全联系不到「上次让 AI 改过文件」。
 *
 * 所以写入前要剥。但剥错了同样危险 —— 真实内容可能恰好以「1: 」开头。
 * 判据必须严：所有非空行都符合「数字: 」，而且数字从 1 开始连续递增。
 *
 * 这个测试跑真实的剥号方法，不是查源码里有没有那行字。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
/* 工具源码只读一次，后面几段都要用（放太晚会被 TDZ 拦住） */
const tools = read('src/cn/com/scsxrkj/LocalDevTools.java');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

/*
 * 把 Java 里的 stripLineNumbers 抽出来，放进一个独立类里真跑。
 * 直接抄源码里的方法体 —— 源码改了而测试没改，这里会立刻暴露。
 */
/* 从源码里搬出一个方法，靠括号配平确定结尾 */
function grabMethod(java, signature) {
  const start = java.indexOf(signature);
  if (start < 0) throw new Error(signature + ' not found');
  let i = java.indexOf('{', start), depth = 0;
  for (; i < java.length; i++) {
    if (java[i] === '{') depth++;
    else if (java[i] === '}') { depth--; if (depth === 0) return java.slice(start, i + 1); }
  }
  throw new Error(signature + ' unterminated');
}

function loadStripper() {
  const java = read('src/cn/com/scsxrkj/LocalDevTools.java');
  /* 正则和两个换行辅助也是被测逻辑的一部分，一起搬过来 */
  const line = java.split('\n').find(l => l.includes('static final java.util.regex.Pattern STRIP_LINE='));
  if (!line) throw new Error('STRIP_LINE not found');
  const body = line + '\n'
    + grabMethod(java, 'static String[] splitKeepCr(String content){')
    + '\n' + grabMethod(java, 'static String withoutCr(String line){')
    + '\n' + grabMethod(java, 'static String stripLineNumbers(String content){')
    + '\n' + grabMethod(java, 'static String stripSnippetLineNumbers(String content){')
    + '\n' + grabMethod(java, 'static String stripSnippetLineNumbers(String content,int hintStart){');
  const dir = path.join(ROOT, 'tests', '.tmp-strip');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Strip.java'),
    'public class Strip{\n' + body + '\n' +
    /*
     * 必须原样读字节，不能用 readLine()。
     *
     * readLine() 会把行尾的 \r 一起吃掉 —— 于是「CRLF 文件也要能剥号」
     * 这条根本测不出来：喂进去的是 CRLF，方法看到的是 LF，永远是绿的。
     * 这正是那种「测试通过、真机翻车」的写法。
     */
    ' public static void main(String[] a)throws Exception{' +
    ' String in=new String(System.in.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);' +
    ' String mode=a.length>0?a[0]:"whole";' +
    ' int hint=a.length>1?Integer.parseInt(a[1]):0;' +
    ' System.out.print(mode.equals("snippet")?stripSnippetLineNumbers(in,hint):stripLineNumbers(in));' +
    '}}');
  // javac/java 不在 PATH 里（测试在 git-bash 下跑，SDK 里的 JDK 是绝对路径）
  const jdkHome = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
  const exe = n => path.join(jdkHome, 'bin', process.platform === 'win32' ? n + '.exe' : n);
  execFileSync(exe('javac'), ['-encoding', 'UTF-8', path.join(dir, 'Strip.java')], { stdio: 'pipe' });
  const run = (args, input) => execFileSync(exe('java'),
    ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstdin.encoding=UTF-8', '-cp', dir, 'Strip', ...args],
    { input, encoding: 'utf8' });
  const strip = (input) => run([], input);
  strip.snippet = (input, hint) => run(hint === undefined ? ['snippet'] : ['snippet', String(hint)], input);
  return strip;
}

let strip;
try {
  strip = loadStripper();
  ok('剥号方法可以编译并运行', true);
} catch (e) {
  ok('剥号方法可以编译并运行', false, String(e.message || e).slice(0, 200));
  console.log('\n失败 ' + fail + ' 项（编译不过，后面的断言无法进行）');
  process.exit(1);
}

console.log('\n── 该剥的必须剥掉 ──────────────────────────────');
const numbered = '1: <html>\n2: <body>hi</body>\n3: </html>';
ok('带行号的整份内容被剥干净',
  strip(numbered) === '<html>\n<body>hi</body>\n</html>',
  JSON.stringify(strip(numbered)));

const numberedJs = '1: const a=1;\n2: const b=2;\n3: export default a+b;';
ok('JS 内容同样能剥',
  strip(numberedJs) === 'const a=1;\nconst b=2;\nexport default a+b;');

const withBlank = '1: a\n2: \n3: b';
ok('中间空行不影响判断并保留空行',
  strip(withBlank) === 'a\n\nb', JSON.stringify(strip(withBlank)));

console.log('\n── 不该剥的一个字都不能动 ──────────────────────');
const realCode = 'const a=1;\nconsole.log(a);';
ok('普通代码原样返回', strip(realCode) === realCode);

/*
 * 这一条是「判据的代价」，写清楚比装作没有好：
 * 如果一份真实文件恰好每行都以连续的「N: 」开头，它会被当成行号副本剥掉。
 * 这种情况在真实源码里几乎不存在（那本身就是 read_file 的输出格式），
 * 而反过来「不剥」的代价是文件被写进一堆行号，且往往能编译通过 —— 更难发现。
 * 所以这里的取舍是：只要格式完全吻合就剥。
 */
const numberedChinese = '1: 第一行\n2: 第二行';
ok('中文内容也能正确剥',
  strip(numberedChinese) === '第一行\n第二行', JSON.stringify(strip(numberedChinese)));

/* 不是从 1 开始的连续序列 → 不剥 */
const timeLike = '2: 00 开始\n3: 30 结束';
ok('行号不是从 1 开始时不动',
  strip(timeLike) === timeLike, JSON.stringify(strip(timeLike)));

const gaps = '1: a\n3: b';
ok('行号不连续时不剥', strip(gaps) === gaps, JSON.stringify(strip(gaps)));

const oneLine = '1: only one line';
ok('只有一行时不剥（判据不足，宁可不动）',
  strip(oneLine) === oneLine, JSON.stringify(strip(oneLine)));

/* 前导零按数字比较：01/02 就是 1/2，属于同一种行号格式，照样剥 */
const leadingZero = '01: a\n02: b';
ok('带前导零的行号也算行号（01 就是第 1 行）',
  strip(leadingZero) === 'a\nb', JSON.stringify(strip(leadingZero)));

const mixed = '1: a\nrandom line';
ok('混入非行号行时不剥', strip(mixed) === mixed);

console.log('\n── CRLF 文件（Windows 导入 / 云端同步 / ZIP 解压）──');
/*
 * (.*)$ 里的 . 不匹配 \r，而 matches() 要求整串吃完 ——
 * 于是「12: code\r」永远匹配不上：行号剥离对 CRLF 文件整个失效，
 * 号照样被写进文件，偏偏这类文件多在 Windows 上编辑，看着还挺正常。
 */
const crlf = '1: a\r\n2: b\r\n3: c\r\n';
ok('CRLF 的整份内容也能剥',
  strip(crlf) === 'a\r\nb\r\nc\r\n', JSON.stringify(strip(crlf)));
ok('CRLF 的片段也能剥',
  strip.snippet('12: a\r\n13: b\r\n') === 'a\r\nb\r\n',
  JSON.stringify(strip.snippet('12: a\r\n13: b\r\n')));
ok('CRLF 的普通代码一个字节都不动',
  strip('const a=1;\r\nconsole.log(a);\r\n') === 'const a=1;\r\nconsole.log(a);\r\n');
/* 以换行结尾的内容剥完号不能平白多出一行 */
ok('末尾有换行时不多出空行',
  strip('1: a\n2: b\n') === 'a\nb\n', JSON.stringify(strip('1: a\n2: b\n')));
ok('中间空行连 CRLF 一起保留',
  strip('1: a\r\n2: \r\n3: b\r\n') === 'a\r\n\r\nb\r\n',
  JSON.stringify(strip('1: a\r\n2: \r\n3: b\r\n')));
/*
 * 但「换成 CRLF」之前必须先把行尾统一 —— 模型是从 read_file 复制的片段，
 * CRLF 文件读出来每行带 \r，贴回来的 newContent 已经有 \r\n；
 * 再换一次就成 \r\r\n，每行多一个回车（比混进 LF 行严重）。
 */
ok('patch 前先把行尾统一成 \\n，换成 CRLF 才是幂等的',
  tools.indexOf('String nc=newContent.replace("\\r\\n","\\n").replace("\\r","\\n");') >= 0,
  '缺了归一化，CRLF 文件会被写成 \\r\\r\\n');

/* patch 进 CRLF 文件的新内容，行尾也要是 CRLF，不能把文件弄成两种行尾 */
ok('patch_file 会跟着文件的 CRLF 走',
  /if\(crLines\*2>list\.size\(\)\)nc=nc\.replace\("\\n","\\r\\n"\);/.test(tools),
  'CRLF 文件被 patch 之后会混进 LF 行');

console.log('\n── 片段：行号不从 1 开始也要剥（patch_file 用）──');
ok('中间几行的行号片段被剥',
  strip.snippet('12: a\n13: b\n14: c') === 'a\nb\nc',
  JSON.stringify(strip.snippet('12: a\n13: b\n14: c')));
ok('片段行号不连续时不剥',
  strip.snippet('12: a\n14: b') === '12: a\n14: b');
ok('片段里有非行号行时不剥',
  strip.snippet('12: a\nzzz') === '12: a\nzzz');
/* 单行只能靠「行号正好等于这段的起始行」这个外部线索判断 */
ok('单行片段的行号正好等于起始行时剥',
  strip.snippet('7: hello', 7) === 'hello');
ok('单行片段的行号不等于起始行时不动',
  strip.snippet('7: hello', 12) === '7: hello');
ok('没有位置提示时单行一律不动',
  strip.snippet('7: hello') === '7: hello');

console.log('\n── 写入路径已经接上 ────────────────────────────');
ok('write_files 会剥行号', /wfFiles\.put\(n,clean\);stripped\.put\(n\);/.test(tools));
ok('降级路径 finalChanges 也会剥',
  /changes\.put\(n,stripLineNumbers\(\(String\)v\)\)/.test(tools));
ok('patch_file 的 newContent 用片段版剥离',
  /if\(!numberedFile\)newContent=stripSnippetLineNumbers\(newContent,start\);/.test(tools));
/*
 * 有些文件本来就每行都是「行号: 内容」（数据文件、导出清单）。
 * 对它们剥号等于把内容改坏，所以先看这一行现在是不是就长这样。
 */
ok('要改的那一行自己就带行号时，一个字符都不动',
  /numberedFile=currentLine\.startsWith\(start\+"\: "\);/.test(tools),
  '缺少「文件本来就是带行号的数据文件」的护栏');
ok('剥完会告诉模型原因', /strippedLineNumbers/.test(tools));
ok('剥完提示改用 patch_file', /改用 patch_file 只改指定几行/.test(tools));

console.log('\n── 一开始就别让模型带上行号 ────────────────────');
ok('read_file 的说明里讲清了行号不是内容',
  /每行开头的「行号: 」是定位标记，不是文件内容/.test(tools));
ok('提示词的工具清单也写了这一条',
  /返回内容每行开头的「行号: 」只是定位标记/.test(tools));

console.log('\n── replace_text 也不能把行号写进文件 ────────────');
/* 路径为空却报「文件不存在」，会让模型以为路径写错而反复重试 */
ok('先判 path 为空，再判文件存在',
  tools.indexOf('缺少 path —— 要改哪个文件') < tools.indexOf('文件不存在："+editPath'),
  '顺序反了：模型漏传 path 会看到「文件不存在」');
ok('oldText 带行号时会先剥一次再匹配',
  /String maybe=stripSnippetLineNumbers\(oldText\);/.test(tools));
ok('newText 的剥号带上了所在行号作为线索',
  /String cleanedNew=stripSnippetLineNumbers\(newText,editLine\);/.test(tools));
ok('剥完告诉模型下次不要带',
  /以后直接给原文即可/.test(tools));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
