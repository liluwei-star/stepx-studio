/*
 * 校验只该管「这次改了什么」，不该管「项目里本来有什么」。
 *
 * 原来的实现把整张合并后的文件表逐个查扩展名白名单。后果：
 * 项目里只要已经存在一个 .csv / .xml / .py / .webp（导入的、云端同步来的、
 * 早期版本留下的），这个项目就再也改不动了 —— AI 每次动手都收到
 * 「无效的文本文件路径：data.csv」，而它压根没碰那个文件，重试也没用。
 *
 * 这里跑真实的 Java 校验方法，验证：
 *   · 没改动的文件不管扩展名，一律放行；
 *   · AI 新写进来的文件仍然按白名单拦。
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

const edits = read('src/cn/com/scsxrkj/ProjectEdits.java');
const method = grabMethod(edits, 'static void validate(JSONObject files,JSONObject base)throws Exception{');

const HARNESS = `
package cn.com.scsxrkj;
import org.json.*;
import java.util.*;

public class Paths {
__METHOD__

  static JSONObject files(Object... kv)throws Exception{
   JSONObject o=new JSONObject();
   for(int i=0;i<kv.length;i+=2)o.put(String.valueOf(kv[i]),kv[i+1]);
   return o;
  }

  static boolean passes(JSONObject f,JSONObject b){
   try{validate(f,b);return true;}catch(Exception e){return false;}
  }
  static String why(JSONObject f,JSONObject b){
   try{validate(f,b);return "";}catch(Exception e){return String.valueOf(e.getMessage());}
  }

  public static void main(String[] a)throws Exception{
   int bad=0;

   /* ① 项目里本来就有 data.csv —— 只改 index.html 必须放行 */
   {
    JSONObject base=files("index.html","OLD","data.csv","a,b\\n1,2");
    JSONObject next=files("index.html","NEW","data.csv","a,b\\n1,2");
    if(!passes(next,base)){System.out.println("FAIL 1: 原有 .csv 把整个项目锁死了 "+why(next,base));bad++;}
   }
   /* ② 项目原有 .xml / .py / .webp 同样不该拦 */
   {
    JSONObject base=files("index.html","OLD","a.xml","<x/>","b.py","print(1)","c.webp","BIN");
    JSONObject next=files("index.html","NEW","a.xml","<x/>","b.py","print(1)","c.webp","BIN");
    if(!passes(next,base)){System.out.println("FAIL 2: 其它扩展名也被拦了 "+why(next,base));bad++;}
   }
   /* ③ AI 新写一个 .csv —— 还是要拦 */
   {
    JSONObject base=files("index.html","OLD");
    JSONObject next=files("index.html","NEW","out.csv","a,b");
    if(passes(next,base)){System.out.println("FAIL 3: 新写 .csv 没被拦住");bad++;}
   }
   /* ④ 改已有文件的内容，扩展名不在白名单 —— 也要拦（这是本轮改动） */
   {
    JSONObject base=files("index.html","OLD","data.csv","a,b");
    JSONObject next=files("index.html","OLD","data.csv","c,d");
    if(passes(next,base)){System.out.println("FAIL 4: 改动 .csv 没被拦住");bad++;}
   }
   /* ⑤ index.html 仍然必须有 */
   {
    JSONObject base=files("index.html","OLD");
    JSONObject next=files("main.js","x");
    if(passes(next,base)){System.out.println("FAIL 5: 删掉入口没被拦住");bad++;}
   }
   /* ⑥ 路径穿越仍然要拦（新文件） */
   {
    JSONObject base=files("index.html","OLD");
    JSONObject next=files("index.html","OLD","../evil.js","x");
    if(passes(next,base)){System.out.println("FAIL 6: ../ 没被拦住");bad++;}
   }
   /* ⑦ 子目录 + tsx 允许 */
   {
    JSONObject base=files("index.html","OLD");
    JSONObject next=files("index.html","NEW","src/App.tsx","export default 1");
    if(!passes(next,base)){System.out.println("FAIL 7: 子目录 tsx 被拦了 "+why(next,base));bad++;}
   }
   System.out.println(bad==0?"OK":"BAD="+bad);
  }
}
`;

console.log('── 路径校验：只查本轮改动 ──────────────────────');

const dir = path.join(ROOT, 'tests', '.tmp-paths');
fs.mkdirSync(path.join(dir, 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(dir, 'cn', 'com', 'scsxrkj', 'Paths.java'), HARNESS.replace('__METHOD__', method));

const shimDir = path.join(ROOT, 'tests', 'support', 'orgjson');
const sources = [
  path.join(shimDir, 'JSONObject.java'),
  path.join(shimDir, 'JSONArray.java'),
  path.join(dir, 'cn', 'com', 'scsxrkj', 'Paths.java'),
];
const jdkHome = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const exe = n => path.join(jdkHome, 'bin', process.platform === 'win32' ? n + '.exe' : n);

let out = '';
try {
  execFileSync(exe('javac'), ['-encoding', 'UTF-8', '-d', dir].concat(sources), { stdio: 'pipe' });
  out = execFileSync(exe('java'),
    ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', dir, 'cn.com.scsxrkj.Paths'],
    { encoding: 'utf8' });
} catch (e) {
  ok('校验方法可以编译并运行', false,
    [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').slice(0, 1000));
  console.log('\n失败 ' + fail + ' 项');
  process.exit(1);
}
ok('校验方法可以编译并运行', true);
ok('项目里原有的非白名单文件不会把 AI 锁死，新写的仍然被拦', out.includes('OK'),
  out.trim().split('\n').filter(l => l.startsWith('FAIL')).join(' | '));

console.log('\n── 大项目不该被反复整份复制 ────────────────────');
/*
 * CloudFiles.entries 只读 files 和 binaryFiles。
 * 为了调它而复制整个项目对象，等于每改一次文件就全量拷一遍，
 * 四十轮工具循环下来是几十次无谓拷贝。
 */
ok('云端校验不再整份复制项目对象',
  !/new JSONObject\(project\.toString\(\)\)/.test(edits),
  'mergeChecked 里还在 new JSONObject(project.toString())');
ok('只装 entries 真正会读的字段',
  /new JSONObject\(\)\.put\("files",next\);/.test(edits)
  && /Object binaries=project\.opt\("binaryFiles"\);/.test(edits));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
