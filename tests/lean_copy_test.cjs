#!/usr/bin/env node
/**
 * 回归测试：AI 工具循环用的项目副本，必须「隔离但不复制」。
 *
 * <p><b>两条要求互相拉扯，缺一不可：</b>
 *
 * <p>1. <b>隔离</b> —— 工具在 {@code staged} 上改文件，调用方的项目对象一个字都不能动。
 * 这是这个类的核心契约，自测里有一条专门守它
 * （{@code tool stages new files without overwriting original}）。
 * 所以不能直接把传入对象拿来用。
 *
 * <p>2. <b>不复制</b> —— 项目里最占地方的是 {@code files}（所有文本内容）。
 * 一个几十 MB 的工程，如果拷贝方式是 {@code new JSONObject(files.toString())}，
 * 内存里会同时存在「原表 + 这份完整 JSON 字符串 + 新表」三份，峰值直接翻倍。
 * 手机上的表现是「点发送之后应用直接退出」，而这条路径跟 AI 逻辑毫无关系，
 * 极难联想到是拷贝。
 *
 * <p>所以正确做法是浅拷贝：建一张新的映射表，值仍然指向原来那些 String。
 * String 不可变，两边共享同一个实例完全安全 ——
 * 谁要改内容都是往表里 put 一个新 String，不会影响另一张表。
 *
 * <p>本测试从源码取出真实的 leanCopy / shallowStrings 编译运行，
 * 用真的 JSONObject 替身验证三件事：隔离、内容一致、字符串共享。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(path.resolve(__dirname), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

function grabMethod(java, signature) {
  const start = java.indexOf(signature);
  if (start < 0) throw new Error('找不到方法：' + signature);
  let i = java.indexOf('{', start), depth = 0, state = 'code';
  for (; i < java.length; i++) {
    const c = java[i], n = java[i + 1];
    if (state === 'line') { if (c === '\n') state = 'code'; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i++; } continue; }
    if (state === 'str') { if (c === '\\') { i++; continue; } if (c === '"') state = 'code'; continue; }
    if (state === 'chr') { if (c === '\\') { i++; continue; } if (c === "'") state = 'code'; continue; }
    if (c === '/' && n === '/') { state = 'line'; i++; continue; }
    if (c === '/' && n === '*') { state = 'block'; i++; continue; }
    if (c === '"') { state = 'str'; continue; }
    if (c === "'") { state = 'chr'; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return java.slice(start, i + 1); }
  }
  throw new Error('方法没闭合：' + signature);
}

const tools = read('src/cn/com/scsxrkj/LocalDevTools.java');
const runner = read('src/cn/com/scsxrkj/LocalRunner.java');

const mLean = grabMethod(tools, 'static JSONObject leanCopy(JSONObject project)throws Exception{');
/*
 * 浅拷贝方法已经从 LocalDevTools 挪到 CloudFiles ——
 * 因为美术资源那条路（ArtManager）也要用同一份实现，
 * 放在 LocalDevTools 里会让 ArtManager 反过来依赖工具循环的类。
 */
const cloudFilesSrc = read('src/cn/com/scsxrkj/CloudFiles.java');
const mShallow = grabMethod(cloudFilesSrc, 'static JSONObject shallowStrings(JSONObject src)throws Exception{');
const mCopyProject = grabMethod(cloudFilesSrc, 'static JSONObject copyProject(JSONObject src)throws Exception{');

const jLean = mLean.replace(/CloudFiles\.shallowStrings\(/g, 'shallowStrings(');
const jCopyProject = mCopyProject.replace(/CloudFiles\.shallowStrings\(/g, 'shallowStrings(');

const HARNESS = `
package cn.com.scsxrkj;

import org.json.JSONObject;
import org.json.JSONArray;
import java.util.Iterator;

/**
 * 探针：跑真实的 leanCopy / shallowStrings。
 */
public class LeanProbe {

${mShallow}

${jCopyProject}

${jLean}

    public static void main(String[] a) throws Exception {
        StringBuilder out = new StringBuilder();

        // 造一个项目和它的副本
        JSONObject files = new JSONObject();
        files.put("index.html", "<h1>hi</h1>");
        String big = new String(new char[100000]).replace('\\0', 'x') + "尾巴";
        files.put("big.js", big);
        JSONObject bins = new JSONObject();
        bins.put("assets/a.png", "aaa.bin");
        JSONArray art = new JSONArray();
        art.put(new JSONObject().put("id", "art1").put("path", "assets/a.png"));

        JSONObject project = new JSONObject()
                .put("id", "p1").put("name", "项目")
                .put("files", files).put("binaryFiles", bins)
                .put("artAssets", art)
                .put("snapshots", new JSONArray().put(new JSONObject().put("t", 1)));

        JSONObject copy = leanCopy(project);

        // ── 内容一致 ──
        out.append("C_SAME_INDEX=").append("<h1>hi</h1>".equals(copy.getJSONObject("files").optString("index.html"))).append('\\n');
        out.append("C_SAME_BIG=").append(big.equals(copy.getJSONObject("files").optString("big.js"))).append('\\n');
        out.append("C_COUNT=").append(copy.getJSONObject("files").length()).append('\\n');
        out.append("C_BINS=").append(copy.optJSONObject("binaryFiles").optString("assets/a.png")).append('\\n');

        // ── 字符串本体是共享的（证明没有复制内容）──
        out.append("S_SHARED_INDEX=").append(
                files.optString("index.html") == copy.getJSONObject("files").optString("index.html")).append('\\n');
        out.append("S_SHARED_BIG=").append(
                files.optString("big.js") == copy.getJSONObject("files").optString("big.js")).append('\\n');

        // ── 表本身是两张，改副本不动原文 ──
        copy.getJSONObject("files").put("index.html", "被改了");
        copy.getJSONObject("files").put("new.txt", "新增");
        out.append("I_ORIG_INDEX=").append(files.optString("index.html")).append('\\n');
        out.append("I_ORIG_HAS_NEW=").append(files.has("new.txt")).append('\\n');
        out.append("I_COPY_INDEX=").append(copy.getJSONObject("files").optString("index.html")).append('\\n');

        // ── 删除也不影响原文 ──
        copy.getJSONObject("files").remove("big.js");
        out.append("I_ORIG_BIG_STILL=").append(files.has("big.js")).append('\\n');

        // ── binaryFiles 同样隔离 ──
        copy.getJSONObject("binaryFiles").put("assets/a.png", "改了指纹");
        out.append("I_BINS_ORIG=").append(bins.optString("assets/a.png")).append('\\n');

        // ── 容器字段（artAssets）要深拷贝，改副本不动原文 ──
        copy.getJSONArray("artAssets").put(new JSONObject().put("id", "art2"));
        out.append("I_ART_ORIG_LEN=").append(art.length()).append('\\n');
        out.append("I_ART_COPY_LEN=").append(copy.getJSONArray("artAssets").length()).append('\\n');

        // ── 不该搬过来的字段 ──
        out.append("N_SNAPSHOTS=").append(copy.has("snapshots")).append('\\n');
        out.append("N_ID=").append(copy.optString("id")).append('\\n');

        /*
         * copyProject：用来「改动前先留一份、失败了整份换回去」的副本。
         * 它要保留全部字段（回滚时一个都不能少），但对字符串不复制，
         * 对容器必须深拷贝（否则往副本里加东西会串到原对象）。
         *
         * 这一段用 println 而不是拼换行符 —— 这段代码本身长在 JS 模板里，
         * 再套一层 Java 的转义很容易写错，直接一行一个输出最省事。
         */
        JSONObject full = new JSONObject()
                .put("id", "p1")
                .put("files", files)
                .put("binaryFiles", bins)
                .put("artAssets", art)
                .put("snapshots", new JSONArray().put(new JSONObject().put("t", 1)))
                .put("history", new JSONArray())
                .put("updated", 123);
        JSONObject rollback = copyProject(full);
        rollback.getJSONObject("files").put("index.html", "被改了");
        System.out.println("CP_ORIG_INDEX=" + full.getJSONObject("files").optString("index.html"));
        System.out.println("CP_SHARED_BIG=" + (files.optString("big.js") == rollback.getJSONObject("files").optString("big.js")));
        rollback.getJSONArray("snapshots").put(new JSONObject().put("t", 2));
        System.out.println("CP_SNAP_ORIG=" + full.getJSONArray("snapshots").length());
        System.out.println("CP_SNAP_COPY=" + rollback.getJSONArray("snapshots").length());
        System.out.println("CP_ALL_FIELDS=" + (rollback.has("history") && rollback.has("snapshots") && rollback.has("updated")));
        System.out.println("CP_ID=" + rollback.optString("id"));
        System.out.println("CP_NULL=" + copyProject(null).length());

        System.out.print(out);
    }
}
`;

const tmpDir = path.join(__dirname, '.tmp-lean');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'org', 'json'), { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, 'support', 'orgjson'))) {
  fs.copyFileSync(path.join(__dirname, 'support', 'orgjson', f), path.join(tmpDir, 'src', 'org', 'json', f));
}
fs.writeFileSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'LeanProbe.java'), HARNESS);

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
try {
  execFileSync(path.join(JAVA_HOME, 'bin', 'javac.exe'),
    ['-encoding', 'UTF-8', '-nowarn', '-d', path.join(tmpDir, 'out'),
      path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'LeanProbe.java'),
      path.join(tmpDir, 'src', 'org', 'json', 'JSONObject.java'),
      path.join(tmpDir, 'src', 'org', 'json', 'JSONArray.java')], { stdio: 'pipe' });
} catch (e) {
  console.error('编译失败：\n' + (e.stdout || '').toString() + (e.stderr || '').toString());
  process.exit(1);
}

const raw = execFileSync(path.join(JAVA_HOME, 'bin', 'java.exe'),
  ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', path.join(tmpDir, 'out'),
    'cn.com.scsxrkj.LeanProbe'], { encoding: 'utf8' });
const v = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) v[m[1]] = m[2];
}

console.log('\n── 副本内容必须和项目一致 ──────────────────────');
ok('小文件内容一致', v.C_SAME_INDEX === 'true', v.C_SAME_INDEX);
ok('大文件内容一致', v.C_SAME_BIG === 'true', v.C_SAME_BIG);
ok('文件数量一致', v.C_COUNT === '2', v.C_COUNT);
ok('二进制索引带过来了', v.C_BINS === 'aaa.bin', v.C_BINS);

console.log('\n── 字符串本体是共享的，没有复制内容 ────────────');
ok('小文件的 String 是同一个实例', v.S_SHARED_INDEX === 'true',
  '不值 → 说明内容被复制了一份');
ok('10 万字符的大文件也是同一个实例', v.S_SHARED_BIG === 'true',
  '不值 → 说明大文件内容被复制了一份，这正是 OOM 的来源');

console.log('\n── 隔离：改副本不能动到原项目 ──────────────────');
ok('改副本里的文件，原文不变', v.I_ORIG_INDEX === '<h1>hi</h1>', v.I_ORIG_INDEX);
ok('副本新增的文件不会出现在原文', v.I_ORIG_HAS_NEW === 'false', v.I_ORIG_HAS_NEW);
ok('副本里的改动确实生效了', v.I_COPY_INDEX === '被改了', v.I_COPY_INDEX);
ok('副本里删文件，原文还在', v.I_ORIG_BIG_STILL === 'true', v.I_ORIG_BIG_STILL);
ok('binaryFiles 也是隔离的', v.I_BINS_ORIG === 'aaa.bin', v.I_BINS_ORIG);

console.log('\n── 容器字段要深拷贝 ────────────────────────────');
ok('往副本加美术资源，原文长度不变', v.I_ART_ORIG_LEN === '1', v.I_ART_ORIG_LEN);
ok('副本里确实加上了', v.I_ART_COPY_LEN === '2', v.I_ART_COPY_LEN);

console.log('\n── 不该带的东西不能带 ──────────────────────────');
ok('快照没有搬进副本', v.N_SNAPSHOTS === 'false', '快照被搬进来了，几十 MB 白抄一遍');
ok('标识字段带过来了', v.N_ID === 'p1', v.N_ID);

console.log('\n── 实现要点：不许再整表序列化 ──────────────────');
ok('LocalDevTools 里没有 files.toString() 深拷贝',
  !/new JSONObject\(files *== *null *\? *"\{\}" *: *files\.toString\(\)\)/.test(tools),
  '还在用整表序列化');
ok('CloudFiles 提供了 shallowStrings', /static JSONObject shallowStrings\(JSONObject src\)/.test(cloudFilesSrc), '没有浅拷贝方法');
ok('CloudFiles 提供了 copyProject', /static JSONObject copyProject\(JSONObject src\)/.test(cloudFilesSrc), '没有可回滚副本方法');
ok('leanCopy 用的是浅拷贝', /out\.put\("files", *CloudFiles\.shallowStrings\(files\)\)/.test(tools), 'leanCopy 还在深拷贝');
ok('original 也用浅拷贝', /original=.*put\("files", *CloudFiles\.shallowStrings\(files\)\)/.test(tools), 'original 还在深拷贝');
ok('LocalRunner 也改成了浅拷贝',
  /CloudFiles\.shallowStrings\(source\.getJSONObject\("files"\)\)/.test(runner),
  'LocalRunner 还在 new JSONObject(files.toString())');

console.log('\n── copyProject：回滚副本要全字段但不抄字符串 ────');
ok('改副本不动原文', v.CP_ORIG_INDEX === '<h1>hi</h1>', v.CP_ORIG_INDEX);
ok('大文件字符串仍然共享', v.CP_SHARED_BIG === 'true', '回滚副本把源码又抄了一遍');
ok('往副本加快照，原文长度不变', v.CP_SNAP_ORIG === '1', v.CP_SNAP_ORIG);
ok('副本里确实加上了', v.CP_SNAP_COPY === '2', v.CP_SNAP_COPY);
ok('回滚副本保留全部字段', v.CP_ALL_FIELDS === 'true', '少字段会让回滚丢数据');
ok('标识字段也在', v.CP_ID === 'p1', v.CP_ID);
ok('null 输入返回空对象', v.CP_NULL === '0', v.CP_NULL);

console.log('\n----------------------------------------------------');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED ' + fail) + ' (lean_copy_test)  ' + pass + ' 项');
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
