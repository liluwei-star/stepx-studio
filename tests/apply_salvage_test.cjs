/*
 * 基线漂移时不能把整轮改动扔掉。
 *
 * 场景：用户让 AI 改十几个文件，AI 跑了三分钟；这期间用户在编辑器里
 * 保存了一次 index.html。ProjectEdits.apply 一比对基线和此刻的项目，
 * 发现不一样，直接抛「文件已变化，本轮建议未写入」——
 * 那十几个文件一个都不落盘，用户白等三分钟，屏幕上只有一行红字。
 *
 * 需要保护的只有「用户也动过的那几个文件」。其余文件在基线之后没人碰，
 * AI 的内容就是唯一正确答案。所以按文件三方判断，能救的救回来，
 * 真正冲突的跳过并点名。
 *
 * 这里跑真实的 Java（把 applyAiChanges 抽出来，配一个假的 ProjectEdits），
 * 验证抢救逻辑本身，而不是查源码里有没有那行字。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const main = read('src/cn/com/scsxrkj/MainActivity.java');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

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

/*
 * 假的 ProjectEdits：只实现 apply 的两种行为 ——
 * 基线和项目不一致就抛冲突，一致就把 changes 合进去。
 * 这样能在没有整套 Android 环境的情况下真跑抢救逻辑。
 */
const STUB = `
package cn.com.scsxrkj;
import org.json.*;
import java.util.*;

public class Salvage {
__METHOD__

  /** 和真实现同名同语义：基线不一致就抛，一致就合并。 */
  static class ProjectEdits{
   static JSONObject apply(JSONObject p,JSONObject base,JSONObject changes,String source)throws Exception{
    if(!same(p.getJSONObject("files"),base))throw new Exception("文件已变化，本轮建议未写入；请基于最新文件重新发送");
    JSONObject out=copy(p);
    JSONObject files=copy(p.getJSONObject("files"));
    for(Iterator<String> it=changes.keys();it.hasNext();){
     String n=it.next();
     Object v=changes.opt(n);
     if(v==JSONObject.NULL)files.remove(n);
     else files.put(n,String.valueOf(v));
    }
    out.put("files",files);
    return out;
   }
   /** 浅拷贝：测试自带的最小 org.json 不提供解析器，也就用不着绕 toString。 */
   static JSONObject copy(JSONObject o){
    JSONObject out=new JSONObject();
    for(Iterator<String> it=o.keys();it.hasNext();){
     String k=it.next();
     out.put(k,o.opt(k));
    }
    return out;
   }
   static boolean same(JSONObject a,JSONObject b){
    if(a.length()!=b.length())return false;
    for(Iterator<String> it=a.keys();it.hasNext();){
     String k=it.next();
     if(!b.has(k))return false;
     if(!String.valueOf(a.opt(k)).equals(String.valueOf(b.opt(k))))return false;
    }
    return true;
   }
  }

  static JSONObject project(String[][] files)throws Exception{
   JSONObject f=new JSONObject();
   for(String[] kv:files)f.put(kv[0],kv[1]);
   return new JSONObject().put("files",f);
  }

  public static void main(String[] a)throws Exception{
   int bad=0;
   /* ① 用户在 AI 跑期间改了 index.html，AI 也改了它 —— 不能覆盖用户 */
   {
    JSONObject base=project(new String[][]{{"index.html","OLD-A"},{"app.js","OLD-B"}});
    /* AI 跑的时候用户把 index.html 改成了 USER-A */
    JSONObject live=project(new String[][]{{"index.html","USER-A"},{"app.js","OLD-B"}});
    JSONObject changes=new JSONObject().put("index.html","AI-A").put("app.js","AI-B");
    JSONObject edit=new JSONObject();
    JSONObject out=applyAiChanges(live,base.getJSONObject("files"),changes,edit);
    JSONObject files=out.getJSONObject("files");
    if(!"USER-A".equals(files.getString("index.html"))){System.out.println("FAIL 1: 用户改动被覆盖");bad++;}
    if(!"AI-B".equals(files.getString("app.js"))){System.out.println("FAIL 2: 无冲突文件没写进去");bad++;}
    if(!edit.has("heldBack")||edit.getJSONArray("heldBack").length()!=1
       ||!"index.html".equals(edit.getJSONArray("heldBack").getString(0)))
      {System.out.println("FAIL 3: heldBack 没说清哪个文件");bad++;}
    if(!edit.optString("salvage","").contains("index.html"))
      {System.out.println("FAIL 4: 提示里没点名");bad++;}
    if(!edit.has("base")){System.out.println("FAIL 5: 没更新基线");bad++;}
    /* 更新后的基线必须是「抢救那一刻的项目」，否则审查页应用又会失败 */
    else if(!"USER-A".equals(edit.getJSONObject("base").getString("index.html")))
      {System.out.println("FAIL 6: 基线还是旧的");bad++;}
   }
   /* ② 整轮都撞在用户改过的文件上 —— 只能老老实实报冲突 */
   {
    JSONObject base=project(new String[][]{{"index.html","OLD"}});
    JSONObject live=project(new String[][]{{"index.html","USER"}});
    boolean threw=false;
    try{applyAiChanges(live,base.getJSONObject("files"),new JSONObject().put("index.html","AI"),new JSONObject());}
    catch(Exception e){threw=String.valueOf(e.getMessage()).contains("没有写入");}
    if(!threw){System.out.println("FAIL 7: 全冲突时没有报错");bad++;}
   }
   /* ③ 新增文件（基线和项目里都没有）不算冲突 */
   {
    JSONObject base=project(new String[][]{{"index.html","OLD"}});
    JSONObject live=project(new String[][]{{"index.html","USER"}});
    JSONObject out=applyAiChanges(live,base.getJSONObject("files"),new JSONObject().put("new.js","X"),new JSONObject());
    if(!"X".equals(out.getJSONObject("files").getString("new.js")))
      {System.out.println("FAIL 8: 新增文件被当成冲突丢了");bad++;}
   }
   /* ④ 没有冲突时走原路，不该平白塞 salvage */
   {
    JSONObject base=project(new String[][]{{"index.html","OLD"}});
    JSONObject live=project(new String[][]{{"index.html","OLD"}});
    JSONObject edit=new JSONObject();
    JSONObject out=applyAiChanges(live,base.getJSONObject("files"),new JSONObject().put("index.html","NEW"),edit);
    if(!"NEW".equals(out.getJSONObject("files").getString("index.html")))
      {System.out.println("FAIL 9: 正常路径没写进去");bad++;}
    if(edit.has("salvage")){System.out.println("FAIL 10: 正常路径也报了抢救");bad++;}
   }
   System.out.println(bad==0?"OK":"BAD="+bad);
  }
}
`;

console.log('── 抢救逻辑：真的跑一遍 Java ────────────────────');

const method = grabMethod(main, 'static JSONObject applyAiChanges(JSONObject target,JSONObject baseline,JSONObject changes,JSONObject edit)throws Exception{');
const dir = path.join(ROOT, 'tests', '.tmp-salvage');
fs.mkdirSync(path.join(dir, 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(dir, 'cn', 'com', 'scsxrkj', 'Salvage.java'),
  STUB.replace('__METHOD__', method));

/*
 * org.json 用 tests/support/orgjson 里的最小实现。
 *
 * 不能用 android.jar —— 那里面 org.json 的每个方法体都是
 * 「throw new RuntimeException("Stub!")」，编译能过、一跑就炸。
 */
const shimDir = path.join(ROOT, 'tests', 'support', 'orgjson');
const sources = ['JSONObject.java', 'JSONArray.java']
  .map(f => path.join(shimDir, f))
  .concat([path.join(dir, 'cn', 'com', 'scsxrkj', 'Salvage.java')]);
const jdkHome = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const exe = n => path.join(jdkHome, 'bin', process.platform === 'win32' ? n + '.exe' : n);

let out = '';
try {
  for (const f of sources) if (!fs.existsSync(f)) throw new Error('缺文件：' + f);
  execFileSync(exe('javac'), ['-encoding', 'UTF-8', '-d', dir].concat(sources), { stdio: 'pipe' });
  out = execFileSync(exe('java'),
    ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', dir,
      'cn.com.scsxrkj.Salvage'], { encoding: 'utf8' });
} catch (e) {
  const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').slice(0, 1200);
  ok('抢救逻辑可以编译并运行', false, detail);
  console.log('\n失败 ' + fail + ' 项');
  process.exit(1);
}
ok('抢救逻辑可以编译并运行', true);
ok('用户改过的文件没有被 AI 覆盖，其余文件照常写回', out.includes('OK'),
  out.trim().split('\n').filter(l => l.startsWith('FAIL')).join(' | '));

console.log('\n── 接线上不能漏 ────────────────────────────────');
ok('调用点已经换成抢救版本',
  /JSONObject updated=applyAiChanges\(target,baseline,changes,edit\);/.test(main));
ok('抢救时必须用「此刻的项目」当基线',
  /JSONObject liveBase=new JSONObject\(live\.toString\(\)\);/.test(main));
ok('审查页「应用」也走同一条抢救规则',
  /JSONObject changed=applyAiChanges\(p,q\.getJSONObject\("base"\),q\.getJSONObject\("files"\),note\);/.test(main),
  'applyProjectFiles 仍然直接调 ProjectEdits.apply，基线一变整批拒绝');
ok('跳过哪些文件会明确告诉用户',
  /if\(heldBack!=null&&heldBack\.length\(\)>0\)toast\(note\.optString\("salvage"/.test(main));
ok('抢救时不会拿旧 changes/base 覆盖',
  /if\(!edit\.has\("files"\)\)edit\.put\("files",changes\);/.test(main)
  && /if\(!edit\.has\("base"\)\)edit\.put\("base",baseline\);/.test(main));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
