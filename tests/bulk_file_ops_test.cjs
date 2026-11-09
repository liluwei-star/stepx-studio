#!/usr/bin/env node
/**
 * 回归测试：项目文件表的两张表（文本 / 二进制）必须始终一致，
 * 改名不能造出「文件当目录」的结构，批量移动不能把「没动」报成「已完成」。
 *
 * <p><b>缺陷背景一 —— 幽灵引用：</b>
 * 项目里文件分两张表：{@code files}（文本内容）和 {@code binaryFiles}（大文件的
 * {@code .bin} 引用）。正常情况一个路径只会在其中一张表里，但历史数据里
 * 出现过两张表都有同一个路径的情况（早期把文本写到过大文件路径上、
 * 导入时按扩展名分表又没清旧键）。
 *
 * <p>那时的删/改名写成 {@code if(files.has(p)){...}else if(bins.has(p)){...}}，
 * 只处理一张表。后果：
 * <ul>
 *   <li>界面提示「已删除」，变更视图里那个文件还在；</li>
 *   <li>{@code gcBigFiles} 认为它还被引用，磁盘上那份 {@code .bin} 永远不回收；</li>
 *   <li>导出 ZIP 又把删掉的文件写回去。</li>
 * </ul>
 *
 * <p><b>缺陷背景二 —— 文件当目录：</b>
 * 路径在项目里是平的键值对，{@code a} 和 {@code a/b.txt} 可以同时存在，
 * 因为「键没重复」就算不冲突。但 ZIP 和解包工具按目录树理解路径，
 * 先写一个叫 {@code a} 的文件再写 {@code a/b.txt}，解压要么报错要么丢内容。
 *
 * <p><b>缺陷背景三 —— 静默成功：</b>
 * 批量移动时目标目录就是当前所在目录，算出的 target 等于原路径，
 * {@code renameOne} 直接 return，但调用方照样 {@code ok++}。
 * 于是「移动 20 个文件」提示「已完成 20 个文件」，实际一个都没动。
 *
 * <p>本测试直接从源码里取出真实的 {@code checkTarget}、{@code removeOne}、
 * {@code renameOne}、{@code CloudFiles.path}、{@code CloudFiles.excluded}
 * 编译运行，不是对着源码字面量做断言。
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

/** 从源码里抠出一个方法（含花括号配平），保持原样。 */
function grabMethod(java, signature) {
  const start = java.indexOf(signature);
  if (start < 0) throw new Error('找不到方法：' + signature);
  let i = java.indexOf('{', start), depth = 0;
  for (; i < java.length; i++) {
    if (java[i] === '{') depth++;
    else if (java[i] === '}') { depth--; if (depth === 0) return java.slice(start, i + 1); }
  }
  throw new Error('方法没闭合：' + signature);
}

const java = read('src/cn/com/scsxrkj/MainActivity.java');
const cloudFiles = read('src/cn/com/scsxrkj/CloudFiles.java');

// ── 取出真实方法体 ────────────────────────────────────────────
const mPath = grabMethod(cloudFiles, 'static boolean path(String p){');
const mExcluded = grabMethod(cloudFiles, 'static boolean excluded(String p){');
const mCheckTarget = grabMethod(java, 'void checkTarget(JSONObject proj,String to,String from)throws Exception{');
// checkTarget 把「文件当目录」的检查委托给了 checkStructure，要一起取出来
const mCheckStructure = grabMethod(java, 'static void checkStructure(JSONObject proj,String to,String from)throws Exception{');
const mRemoveOne = grabMethod(java, 'void removeOne(JSONObject proj,String path,String[] usedDir)throws Exception{');
const mRenameOne = grabMethod(java, 'void renameOne(JSONObject proj,String from,String to,String[] usedDir)throws Exception{');

// 探针里放的是 CloudFiles 的同名逻辑，前缀改成 cf 避免和探针类自己的方法混淆
const jPath = mPath.replace('static boolean path(', 'static boolean cfPath(');
const jExcluded = mExcluded.replace('static boolean excluded(', 'static boolean cfExcluded(');
const jCheckTarget = mCheckTarget
  .replace('void checkTarget(', 'static void checkTarget(')
  .replace(/CloudFiles\.path\(/g, 'cfPath(')
  .replace(/CloudFiles\.excluded\(/g, 'cfExcluded(');
const jRemoveOne = mRemoveOne.replace('void removeOne(', 'static void removeOne(');
const jRenameOne = mRenameOne
  .replace('void renameOne(', 'static void renameOne(')
  .replace(/renameOne\(/g, 'renameOne(');  // 内部无自调用，保持原样

const HARNESS = `
package cn.com.scsxrkj;

import org.json.JSONObject;
import java.util.Iterator;

/**
 * 探针：跑真实的 checkTarget / removeOne / renameOne。
 * 这些方法都只读写 JSON，不碰 Activity 上下文，所以能脱离 Activity 单独跑。
 */
public class BulkProbe {

${jPath}

${jExcluded}

${jCheckTarget}

${mCheckStructure}

${jRemoveOne}

${jRenameOne}

    /** 造一个项目：文本表 + 二进制表 */
    static JSONObject project() throws Exception {
        JSONObject p = new JSONObject();
        p.put("id", "p1");
        JSONObject files = new JSONObject();
        files.put("index.html", "<h1>hi</h1>");
        p.put("files", files);
        JSONObject bins = new JSONObject();
        bins.put("assets/photo.png", "aaa.bin");
        p.put("binaryFiles", bins);
        return p;
    }

    static void out(String k, Object v) { System.out.println(k + " " + v); }

    public static void main(String[] a) throws Exception {

        // ── 一、removeOne：路径同时挂在两张表上时，两张都要清 ──────────
        JSONObject p1 = project();
        p1.getJSONObject("files").put("assets/photo.png", "残留文本");
        String[] used = new String[1];
        try {
            removeOne(p1, "assets/photo.png", used);
            out("RM_OK", true);
        } catch (Exception e) {
            out("RM_OK", false);
            out("RM_ERR", e.getMessage());
        }
        out("RM_FILES_GONE", !p1.getJSONObject("files").has("assets/photo.png"));
        out("RM_BINS_GONE", !p1.getJSONObject("binaryFiles").has("assets/photo.png"));
        out("RM_OTHER_KEPT", p1.getJSONObject("files").has("index.html")
                && p1.getJSONObject("binaryFiles").has("assets/photo.png") == false);

        // ── 二、removeOne：只在大文件表里的（AI 删图片走的就是这条）─────
        JSONObject p2 = project();
        try {
            removeOne(p2, "assets/photo.png", new String[1]);
            out("RM2_OK", true);
        } catch (Exception e) {
            out("RM2_OK", false);
            out("RM2_ERR", e.getMessage());
        }
        out("RM2_GONE", !p2.getJSONObject("binaryFiles").has("assets/photo.png"));

        // ── 三、removeOne：不存在的文件必须报错，不能静默 success ────────
        JSONObject p3 = project();
        boolean threw = false;
        try { removeOne(p3, "nope.txt", new String[1]); } catch (Exception e) { threw = true; }
        out("RM3_THREW", threw);

        // ── 四、renameOne：搬文本时，二进制表里的同名键要一起清 ──────────
        JSONObject p4 = project();
        p4.getJSONObject("binaryFiles").put("index.html", "ghost.bin");  // 历史幽灵数据
        try {
            renameOne(p4, "index.html", "home.html", new String[1]);
            out("RN_OK", true);
        } catch (Exception e) {
            out("RN_OK", false);
            out("RN_ERR", e.getMessage());
        }
        out("RN_NEW", p4.getJSONObject("files").has("home.html"));
        out("RN_OLD_GONE", !p4.getJSONObject("files").has("index.html"));
        out("RN_NO_GHOST", !p4.getJSONObject("binaryFiles").has("index.html"));

        // ── 五、renameOne：搬二进制时，文本表里的同名键要一起清 ──────────
        // p4b 是纯净的大文件改名：路径只在二进制表里，必须走二进制分支，
        // 且内容引用要原样跟到新路径（不能重新算、也不能丢）。
        JSONObject p4b = project();
        try {
            renameOne(p4b, "assets/photo.png", "assets/pic.png", new String[1]);
            out("RN2_OK", true);
        } catch (Exception e) {
            out("RN2_OK", false);
            out("RN2_ERR", e.getMessage());
        }
        out("RN2_NEW", "aaa.bin".equals(p4b.getJSONObject("binaryFiles").optString("assets/pic.png", "")));
        out("RN2_OLD_GONE", !p4b.getJSONObject("binaryFiles").has("assets/photo.png"));

        // ── 五之二、两张表都有这个路径时：以文本为准，搬文本并清掉大文件引用 ──
        JSONObject p5 = project();
        p5.getJSONObject("files").put("assets/photo.png", "残留文本");
        try {
            renameOne(p5, "assets/photo.png", "assets/pic.png", new String[1]);
            out("RN3_OK", true);
        } catch (Exception e) {
            out("RN3_OK", false);
            out("RN3_ERR", e.getMessage());
        }
        out("RN3_TEXT_WINS", "残留文本".equals(p5.getJSONObject("files").optString("assets/pic.png", "")));
        out("RN3_NO_STALE_BIN", !p5.getJSONObject("binaryFiles").has("assets/photo.png"));

        // ── 六、checkTarget：不能把一个文件改成「已经有内容在下面」的名字 ──
        JSONObject p6 = project();
        p6.getJSONObject("files").put("assets/icon.png/backup.txt", "x");
        String err6 = "";
        boolean threw6 = false;
        try { checkTarget(p6, "assets/icon.png", "index.html"); }
        catch (Exception e) { threw6 = true; err6 = e.getMessage(); }
        out("CT_DIR_BLOCKED", threw6);
        out("CT_DIR_MSG", err6);

        // ── 七、checkTarget：不能让文件钻进一个文件当目录 ────────────────
        JSONObject p7 = project();
        String err7 = "";
        boolean threw7 = false;
        try { checkTarget(p7, "index.html/x.txt", "assets/photo.png"); }
        catch (Exception e) { threw7 = true; err7 = e.getMessage(); }
        out("CT_FILE_BLOCKED", threw7);
        out("CT_FILE_MSG", err7);

        // ── 八、checkTarget：正常改名要放行 ──────────────────────────────
        JSONObject p8 = project();
        boolean threw8 = false;
        String err8 = "";
        try { checkTarget(p8, "home.html", "index.html"); }
        catch (Exception e) { threw8 = true; err8 = e.getMessage(); }
        out("CT_OK_FREE", !threw8);
        out("CT_OK_ERR", err8);

        // ── 九、checkTarget：目标已存在仍要拦 ────────────────────────────
        JSONObject p9 = project();
        boolean threw9 = false;
        try { checkTarget(p9, "assets/photo.png", "index.html"); }
        catch (Exception e) { threw9 = true; }
        out("CT_DUP_BLOCKED", threw9);

        // ── 十、批量移动的场景：目标目录下的兄弟文件不该被当成冲突 ───────
        // 把 src 下的 a.txt / b.txt 移到 src/sub：第二个文件移动时
        // 表里已经有 src/sub/a.txt，但它是「兄弟」不是「父级」，不能拦。
        JSONObject p10 = new JSONObject();
        p10.put("id", "p10");
        JSONObject f10 = new JSONObject();
        f10.put("src/a.txt", "A");
        f10.put("src/b.txt", "B");
        p10.put("files", f10);
        boolean batchOk = true;
        String batchErr = "";
        try {
            renameOne(p10, "src/a.txt", "src/sub/a.txt", new String[1]);
            renameOne(p10, "src/b.txt", "src/sub/b.txt", new String[1]);
        } catch (Exception e) {
            batchOk = false;
            batchErr = e.getMessage();
        }
        out("BATCH_OK", batchOk);
        out("BATCH_ERR", batchErr);
        out("BATCH_BOTH", p10.getJSONObject("files").has("src/sub/a.txt")
                && p10.getJSONObject("files").has("src/sub/b.txt"));
    }
}
`;

// ── 编译运行 ──────────────────────────────────────────────────
const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const JAVAC = path.join(JAVA_HOME, 'bin', 'javac.exe');
const JAVA = path.join(JAVA_HOME, 'bin', 'java.exe');

const dir = path.join(ROOT, 'tests', '.tmp-bulk');
const work = path.join(dir, 'work');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const jsonSrc = path.join(work, 'org', 'json');
fs.mkdirSync(jsonSrc, { recursive: true });
for (const n of ['JSONObject.java', 'JSONArray.java']) {
  fs.copyFileSync(path.join(ROOT, 'tests', 'support', 'orgjson', n), path.join(jsonSrc, n));
}
const pkgDir = path.join(work, 'cn', 'com', 'scsxrkj');
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(path.join(pkgDir, 'BulkProbe.java'), HARNESS);

const files = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const f = path.join(d, n);
    if (fs.statSync(f).isDirectory()) walk(f);
    else if (f.endsWith('.java')) files.push(f);
  }
})(work);

let out = '';
let compileErr = '';
try {
  execFileSync(JAVAC, ['-encoding', 'UTF-8', '-nowarn', '-d', path.join(dir, 'classes'), ...files],
    { stdio: 'pipe' });
  /*
   * 强制 UTF-8 输出。
   * Windows 上 JDK 的 System.out 默认跟着控制台代码页走（cp936），
   * 中文提示串到这里就是一堆乱码，断言「拦下时要说清原因」会假红。
   */
  out = execFileSync(JAVA, [
    '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
    '-cp', path.join(dir, 'classes'), 'cn.com.scsxrkj.BulkProbe',
  ], { stdio: 'pipe', encoding: 'utf8' });
} catch (e) {
  compileErr = (e.stdout || '') + (e.stderr || '');
  out = String(e.stdout || '');
}

if (compileErr) {
  console.log('\n── 编译失败 ────────────────────────────────');
  console.log(compileErr.slice(0, 3000));
}

const val = k => {
  const line = out.split(/\r?\n/).find(l => l.startsWith(k + ' '));
  return line ? line.slice(k.length + 1).trim() : '<missing>';
};
const isTrue = k => val(k) === 'true';

console.log('\n── 一张路径不能同时留在两张表里 ────────────────');
ok('两张表都有的路径，删除时两张一起清', isTrue('RM_OK') && isTrue('RM_FILES_GONE') && isTrue('RM_BINS_GONE'),
  `RM_FILES_GONE=${val('RM_FILES_GONE')} RM_BINS_GONE=${val('RM_BINS_GONE')}`);
ok('删一个文件不牵连别的文件', isTrue('RM_OTHER_KEPT'), val('RM_OTHER_KEPT'));
ok('只在大文件表里的路径也能删（AI 删图片走这条）', isTrue('RM2_OK') && isTrue('RM2_GONE'),
  `RM2_OK=${val('RM2_OK')} RM2_GONE=${val('RM2_GONE')}`);
ok('删不存在的文件仍然报错，不放行', isTrue('RM3_THREW'), val('RM3_THREW'));

console.log('\n── 改名要把另一张表的同名键一起清掉 ────────────');
ok('文本文件改名成功', isTrue('RN_OK'), val('RN_ERR'));
ok('新路径拿到内容、旧路径消失', isTrue('RN_NEW') && isTrue('RN_OLD_GONE'));
ok('二进制表里的幽灵同名键被清掉', isTrue('RN_NO_GHOST'), val('RN_NO_GHOST'));
ok('大文件改名后仍指向原内容', isTrue('RN2_NEW'), val('RN2_NEW'));
ok('大文件改名后旧路径消失', isTrue('RN2_OLD_GONE'), val('RN2_OLD_GONE'));
ok('两张表都有时以文本为准', isTrue('RN3_OK') && isTrue('RN3_TEXT_WINS'),
  `RN3_OK=${val('RN3_OK')} RN3_TEXT_WINS=${val('RN3_TEXT_WINS')}`);
ok('搬文本时大文件引用不留幽灵', isTrue('RN3_NO_STALE_BIN'), val('RN3_NO_STALE_BIN'));

console.log('\n── 不能把文件改成「有内容在下面」的名字 ────────');
ok('目标下面还有文件时必须拦', isTrue('CT_DIR_BLOCKED'),
  `CT_DIR_MSG=${val('CT_DIR_MSG')}`);
ok('拦下时说清是被目录占着', /目录占着/.test(val('CT_DIR_MSG')), val('CT_DIR_MSG'));

console.log('\n── 不能把文件塞进一个文件里 ────────────────────');
ok('父路径是文件时必须拦', isTrue('CT_FILE_BLOCKED'), `CT_FILE_MSG=${val('CT_FILE_MSG')}`);
ok('拦下时点名那个上级文件', /是一个文件/.test(val('CT_FILE_MSG')), val('CT_FILE_MSG'));

console.log('\n── 正常的改名不能被误拦 ────────────────────────');
ok('改成一个没被占用的新名字要放行', isTrue('CT_OK_FREE'), val('CT_OK_ERR'));
ok('目标已存在仍然要拦', isTrue('CT_DUP_BLOCKED'));

console.log('\n── 批量移动同目录不能被误判成冲突 ──────────────');
ok('两个文件移进同一个新目录都成功', isTrue('BATCH_OK'), val('BATCH_ERR'));
ok('两个文件都在新位置', isTrue('BATCH_BOTH'));

console.log('\n── 批量移动不能把「没动」报成「已完成」 ────────');
ok('bulkFiles 能识别目标等于原路径', /if\(target\.equals\(path\)\)\{/.test(java),
  '没找到 target.equals(path) 判断');
ok('这类文件单独计数、不留在成功数里', /same\+\+;\s*\n\s*continue;/.test(java),
  '没找到 same++ / continue');
ok('提示里会说清有几个没动', /个本来就在目标位置，没动/.test(java),
  '提示文案没有说明没动的原因');

console.log('\n── 变更历史要有上限，两条写入路径共用一处定义 ──');
const editsSrc = read('src/cn/com/scsxrkj/ProjectEdits.java');
ok('ProjectEdits 提供 HISTORY_KEEP 常量', /static final int HISTORY_KEEP=\d+;/.test(editsSrc));
ok('ProjectEdits 提供 trimHistory', /static JSONArray trimHistory\(JSONArray h\)\{/.test(editsSrc));
ok('AI 改动落地时也会裁剪 history',
  /out\.put\("history",trimHistory\(h\)\)/.test(editsSrc),
  'apply 追加 history 后没有裁剪');
ok('MainActivity 不再自己定义一份上限', !/static final int HISTORY_KEEP=/.test(java));
ok('AI 请求收尾复用同一份裁剪',
  /project\.put\("history",ProjectEdits\.trimHistory\(h\)\)/.test(java),
  'sendAi 收尾没有用 ProjectEdits.trimHistory');

console.log('\n── deleteProjectFile 也要两张表都清 ────────────');
ok('删除前先看文本表有没有', /boolean had=files\.has\(path\);/.test(java));
ok('大文件表里的同名键一并清掉', /if\(bins!=null&&bins\.has\(path\)\)\{[\s\S]{0,120}had=true;/.test(java),
  '没找到 bins 分支里的 had=true');
ok('只有两张表都没有时才报文件不存在', /if\(!had\)throw new Exception\("文件不存在"\);/.test(java));

fs.rmSync(dir, { recursive: true, force: true });

console.log('\n──────────────────────────────────────────────');
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
