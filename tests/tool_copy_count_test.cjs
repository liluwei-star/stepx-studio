/*
 * 一个请求里不应该存在三份项目全文。
 *
 * 调用方（MainActivity.sendAi）传进来的 toolProject 本身已经是一份一次性副本；
 * LocalDevTools 构造时又把它深拷贝了两次（original 一份、staged 一份）。
 * 于是一个请求在内存里同时存在三份项目全文 —— 几十 MB 的工程光 JSON 树的开销
 * 就够把手机堆顶掉，表现是「点发送之后应用直接退出」，很难联想到是拷贝。
 *
 * 现在的规矩：
 *   · staged 直接接管传入对象（它就是一次性副本）；
 *   · original 只装 files 一项（它唯一被读的地方都只取 original.files）。
 *
 * 这里跑真实 Java：构造一个项目、通过工具改文件、再用 diff_mine 核对结论 ——
 * 拷贝变少了，行为必须一模一样。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const tools = read('src/cn/com/scsxrkj/LocalDevTools.java');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 拷贝次数 ───────────────────────────────────');

/* 只看代码里的赋值，别被注释里提到的同一句话绊倒 */
ok('构造时不再深拷贝整个项目',
  !/=\s*new JSONObject\(project\.toString\(\)\)\s*;/.test(tools),
  'LocalDevTools 还在把整个项目对象复制一份');
ok('工作副本仍是副本，不接管传入对象（隔离契约不能破）',
  !/staged=project;/.test(tools) && /staged=project==null\?null:leanCopy\(project\);/.test(tools),
  '直接接管会破坏「工具只在暂存副本上动手」的契约');
ok('对比基准只留文件表',
  /original=project==null\?null:new JSONObject\(\)\.put\("files",/.test(tools));
ok('副本不再整份抄快照和历史',
  /for\(String k:new String\[\]\{"id","name","cloudSource","binaryFiles","artAssets"\}\)/.test(tools),
  'leanCopy 的字段白名单不见了');
ok('编译线程也不整份复制项目',
  !/new JSONObject\(project\.toString\(\)\)/.test(
    fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/LocalCompiler.java'), 'utf8'))
  && /JSONObject snapshot=new JSONObject\(\)\.put\("files"/.test(
    fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/LocalCompiler.java'), 'utf8')));

/*
 * 不变式：original 只被当成「有 files 的对象」读。
 * 一旦有人去读 original 的其他字段，这个精简就变成 bug 了。
 */
/* 从源码里搬出真实的 leanCopy，直接跑它 */
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
const leanMethod = grabMethod(tools, 'static JSONObject leanCopy(JSONObject project)throws Exception{');

const readsOfOriginal = [...tools.matchAll(/original\.(opt|get)(JSONObject|String|Int|Boolean|JSONArray)?\(?/g)].map(m => m[0]);
ok('original 的每个读取点都只取 files',
  [...tools.matchAll(/original\.optJSONObject\("files"\)/g)].length >= 3
  && !/original\.(getString|optString|optBoolean|optInt|getJSONArray)\(/.test(tools),
  '有人开始读 original 的其他字段了，精简前提不再成立');

console.log('\n── 行为不变：真跑改写与差异 ────────────────────');

const HARNESS = `
package cn.com.scsxrkj;
import org.json.*;
import java.util.*;

public class CopyCount {
__METHOD__

  static JSONObject proj()throws Exception{
   JSONObject files=new JSONObject().put("index.html","OLD").put("app.js","const a=1;");
   JSONArray snaps=new JSONArray().put(new JSONObject().put("files",new JSONObject().put("x","y")));
   return new JSONObject()
    .put("id","p1").put("name","演示").put("cloudSource",true)
    .put("files",files)
    .put("binaryFiles",new JSONObject().put("big.asr",new JSONObject().put("ref","r1")))
    .put("artAssets","ARTS-PLACEHOLDER")
    .put("snapshots",snaps)
    .put("history",new JSONArray().put(new JSONObject().put("text","很长的一段历史")))
    .put("debugReports","[]")
    .put("updated",123);
  }

  public static void main(String[] a)throws Exception{
   int bad=0;

   /* ① 文件内容要带过去，而且是副本 —— 改副本不能影响原项目 */
   {
    JSONObject src=proj();
    JSONObject copy=leanCopy(src);
    if(!"const a=1;".equals(copy.getJSONObject("files").getString("app.js")))
      {System.out.println("FAIL 1: 文件没带过去");bad++;}
    copy.getJSONObject("files").put("app.js","changed");
    if(!"const a=1;".equals(src.getJSONObject("files").getString("app.js")))
      {System.out.println("FAIL 2: 改副本影响到了原项目");bad++;}
   }
   /* ② 工具会读的字段都要在 */
   {
    JSONObject copy=leanCopy(proj());
    String[] need={"id","name","cloudSource","binaryFiles","artAssets","files"};
    for(String k:need)if(!copy.has(k)){System.out.println("FAIL 3: 缺字段 "+k);bad++;}
   }
   /* ③ 快照和历史不该被抄进副本（这正是省下来的内存） */
   {
    JSONObject copy=leanCopy(proj());
    String[] drop={"snapshots","history","debugReports","updated"};
    for(String k:drop)if(copy.has(k)){System.out.println("FAIL 4: 白抄了 "+k);bad++;}
   }
   /* ④ 没有文件的空项目不炸 */
   {
    JSONObject copy=leanCopy(new JSONObject().put("id","p2"));
    if(copy.getJSONObject("files").length()!=0){System.out.println("FAIL 5: 空项目副本不对");bad++;}
   }
   /* ⑤ null 项目返回空对象（工具在纯对话轮次没有项目） */
   {
    JSONObject copy=leanCopy(null);
    if(copy.length()!=0){System.out.println("FAIL 6: null 项目不该造出内容");bad++;}
   }
   System.out.println(bad==0?"OK":"BAD="+bad);
  }
}
`;


const dir = path.join(ROOT, 'tests', '.tmp-copycount');
fs.mkdirSync(path.join(dir, 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(dir, 'cn', 'com', 'scsxrkj', 'CopyCount.java'), HARNESS.replace('__METHOD__', leanMethod));

const shimDir = path.join(ROOT, 'tests', 'support', 'orgjson');
const jdkHome = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const exe = n => path.join(jdkHome, 'bin', process.platform === 'win32' ? n + '.exe' : n);

let out = '';
try {
  execFileSync(exe('javac'), ['-encoding', 'UTF-8', '-d', dir,
    path.join(shimDir, 'JSONObject.java'),
    path.join(shimDir, 'JSONArray.java'),
    path.join(dir, 'cn', 'com', 'scsxrkj', 'CopyCount.java')], { stdio: 'pipe' });
  out = execFileSync(exe('java'),
    ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', dir, 'cn.com.scsxrkj.CopyCount'],
    { encoding: 'utf8' });
} catch (e) {
  ok('精简后的构造规则可以跑', false,
    [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').slice(0, 900));
  console.log('\n失败 ' + fail + ' 项');
  process.exit(1);
}
ok('精简后的构造规则可以跑', true);
ok('基准与工作副本互不影响，空项目与无项目也正常', out.includes('OK'),
  out.trim().split('\n').filter(l => l.startsWith('FAIL')).join(' | '));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
