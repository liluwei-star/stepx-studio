#!/usr/bin/env node
/**
 * 回归测试：AI 删/改二进制文件时，两张表必须一起处理。
 *
 * <p>缺陷背景：
 * 项目里文件分两张表 —— {@code files}（文本）和 {@code binaryFiles}（图片、字体、
 * 模型权重的引用）。{@code ProjectEdits} 以前只认 {@code files}，于是：
 *
 * <ul>
 *   <li><b>删不掉</b>：模型调 {@code write_files} 把图片路径写成 null，
 *       得到「不能删除不存在的文件」。文件明明在，只是存在另一张表里。
 *       模型反复重试同一句，或者放弃，图最后还在。</li>
 *   <li><b>幽灵引用</b>：模型把某个路径改成文本，{@code binaryFiles} 里那条旧引用
 *       没人清。同一路径同时出现在两张表里，导出、同步、构建各按各的理解走一遍。</li>
 *   <li><b>只删图等于没改</b>：{@code apply} 里先判「文本表有没有变」，
 *       只删一张图时文本表一个字都没变，于是直接 return，
 *       二进制那条删除悄悄没做。</li>
 * </ul>
 *
 * <p>本测试跑真实的 {@code ProjectEdits.stage/apply}。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(path.resolve(__dirname), '..');
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const JAVAC = path.join(JAVA_HOME, 'bin', 'javac.exe');
const JAVA = path.join(JAVA_HOME, 'bin', 'java.exe');
const ANDROID_JAR = (process.env.ANDROID_SDK_ROOT || 'C:/Users/llw/tools/androidsdk') +
  '/platforms/android-36/android.jar';

const dir = path.join(ROOT, 'tests', '.tmp-binedit');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// 替身的包名是 org.json，javac 要求目录结构跟包名一致，所以要摆成 org/json/
const work = path.join(dir, 'work');
fs.mkdirSync(work, { recursive: true });
const jsonSrc = path.join(work, 'org', 'json');
fs.mkdirSync(jsonSrc, { recursive: true });
for (const n of ['JSONObject.java', 'JSONArray.java']) {
  fs.copyFileSync(path.join(ROOT, 'tests', 'support', 'orgjson', n), path.join(jsonSrc, n));
}
fs.mkdirSync(path.join(work, 'android', 'util'), { recursive: true });
fs.writeFileSync(path.join(work, 'android', 'util', 'Base64.java'), `
package android.util;
/** 测试替身：只实现用到的几个方法。 */
public class Base64 {
    public static final int DEFAULT = 0;
    public static final int NO_WRAP = 2;
    public static byte[] decode(String s, int flags) {
        return java.util.Base64.getMimeDecoder().decode(s);
    }
    public static String encodeToString(byte[] b, int flags) {
        return java.util.Base64.getEncoder().encodeToString(b);
    }
}
`);

// ProjectEdits 带 package 声明，探针必须同包
fs.mkdirSync(path.join(work, 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(work, 'cn', 'com', 'scsxrkj', 'BinEditProbe.java'), `
package cn.com.scsxrkj;

import org.json.JSONObject;
import org.json.JSONArray;

/**
 * 测试探针：跑真实的 ProjectEdits.stage / apply，检查二进制表有没有被一起处理。
 */
public class BinEditProbe {

    /** 造一个带图片的项目 */
    static JSONObject project() throws Exception {
        JSONObject p = new JSONObject();
        p.put("id", "p1");
        JSONObject files = new JSONObject();
        files.put("index.html", "<h1>hi</h1>");
        p.put("files", files);
        JSONObject bins = new JSONObject();
        bins.put("assets/photo.png", "abc.bin");
        bins.put("assets/model.onnx", "def.bin");
        p.put("binaryFiles", bins);
        return p;
    }

    public static void main(String[] a) throws Exception {
        // ── 一、删图片：stage 路径 ──────────────────────────────
        JSONObject p1 = project();
        JSONObject ch1 = new JSONObject();
        ch1.put("assets/photo.png", JSONObject.NULL);
        try {
            ProjectEdits.stage(p1, ch1);
            JSONObject b1 = p1.optJSONObject("binaryFiles");
            System.out.println("DEL_OK true");
            System.out.println("DEL_GONE " + (b1 == null || !b1.has("assets/photo.png")));
            System.out.println("DEL_KEPT_OTHER " + (b1 != null && b1.has("assets/model.onnx")));
        } catch (Exception e) {
            System.out.println("DEL_OK false");
            System.out.println("DEL_ERR " + e.getMessage());
        }

        // ── 二、删不存在的文件要报错（不能一律放行）────────────
        JSONObject p2 = project();
        JSONObject ch2 = new JSONObject();
        ch2.put("nope.txt", JSONObject.NULL);
        try {
            ProjectEdits.stage(p2, ch2);
            System.out.println("MISS_OK false");
        } catch (Exception e) {
            System.out.println("MISS_OK true");
        }

        // ── 三、把外置过的文本文件改回文本：旧引用要清掉 ────────
        // 用一个原本被外置成 .bin 的 .svg（大图标会被 externalizeBinaries 搬走）
        JSONObject p3 = project();
        p3.getJSONObject("binaryFiles").put("assets/icon.svg", "ghi.bin");
        JSONObject ch3 = new JSONObject();
        ch3.put("assets/icon.svg", "<svg/>");
        try {
            ProjectEdits.stage(p3, ch3);
            JSONObject b3 = p3.optJSONObject("binaryFiles");
            System.out.println("TXT_OK true");
            System.out.println("TXT_NOSTALE " + (b3 == null || !b3.has("assets/icon.svg")));
            System.out.println("TXT_CONTENT " + p3.getJSONObject("files").optString("assets/icon.svg"));
        } catch (Exception e) {
            System.out.println("TXT_OK false");
            System.out.println("TXT_ERR " + e.getMessage());
        }

        // ── 三之二、往图片路径塞文本要明确拒绝 ──────────────────
        JSONObject p3b = project();
        JSONObject ch3b = new JSONObject();
        ch3b.put("assets/photo.png", "not-an-image");
        try {
            ProjectEdits.stage(p3b, ch3b);
            System.out.println("PIC_REJECT false");
        } catch (Exception e) {
            System.out.println("PIC_REJECT true");
        }

        // ── 四、apply 路径：只删图，文本表没变，也要生效 ───────
        JSONObject p4 = project();
        JSONObject base4 = new JSONObject(p4.getJSONObject("files").toString());
        JSONObject ch4 = new JSONObject();
        ch4.put("assets/photo.png", JSONObject.NULL);
        try {
            JSONObject out4 = ProjectEdits.apply(p4, base4, ch4, "测试");
            JSONObject b4 = out4.optJSONObject("binaryFiles");
            System.out.println("APPLY_OK true");
            System.out.println("APPLY_GONE " + (b4 == null || !b4.has("assets/photo.png")));
            System.out.println("APPLY_KEPT " + (b4 != null && b4.has("assets/model.onnx")));
        } catch (Exception e) {
            System.out.println("APPLY_OK false");
            System.out.println("APPLY_ERR " + e.getMessage());
        }
    }
}
`);

const SRC = path.join(ROOT, 'src', 'cn', 'com', 'scsxrkj');
let compiled = false;
console.log('\n── 判据一：删除二进制文件要真的删得掉 ──────');
try {
  const srcs = [
    path.join(work, 'cn', 'com', 'scsxrkj', 'BinEditProbe.java'),
    path.join(SRC, 'ProjectEdits.java'),
    path.join(SRC, 'ProjectDiff.java'),
    path.join(SRC, 'CloudFiles.java'),
    path.join(jsonSrc, 'JSONObject.java'),
    path.join(jsonSrc, 'JSONArray.java'),
    path.join(work, 'android', 'util', 'Base64.java'),
  ];
  // 依赖的旁系源码：MatrixSpec 在 shared-src；JsonScan 是从 DevAgent 抽出来的
  // 纯字符串工具，不再需要把整个 DevAgent / MainActivity 拖进来。
  for (const extra of [
    path.join(ROOT, 'shared-src', 'cn', 'com', 'scsxrkj', 'matrix', 'MatrixSpec.java'),
    path.join(SRC, 'JsonScan.java'),
  ]) {
    if (fs.existsSync(extra)) srcs.push(extra);
  }
  execFileSync(JAVAC, ['-encoding', 'UTF-8', '-nowarn', '-cp', ANDROID_JAR, '-d', work, ...srcs],
    { stdio: 'pipe' });
  compiled = true;
  ok('探针编译通过', true);
} catch (e) {
  ok('探针编译通过', false, String(e.stderr || e.stdout || e).slice(0, 900));
}

if (compiled) {
  const out = execFileSync(JAVA, ['-cp', work, 'cn.com.scsxrkj.BinEditProbe'],
    { encoding: 'utf8' });
  const get = (k) => {
    const l = out.split('\n').find(x => x.startsWith(k + ' '));
    return l ? l.slice(k.length + 1).trim() : null;
  };
  ok('删除图片不报错', get('DEL_OK') === 'true', get('DEL_ERR') || '');
  ok('binaryFiles 里那条被删掉', get('DEL_GONE') === 'true');
  ok('同项目其他大文件不受影响', get('DEL_KEPT_OTHER') === 'true');

  console.log('\n── 判据二：删不存在的文件仍然要报错 ──────');
  ok('不存在路径依然拒绝', get('MISS_OK') === 'true');

  console.log('\n── 判据三：改成文本时不留幽灵引用 ──────');
  ok('改文本不报错', get('TXT_OK') === 'true', get('TXT_ERR') || '');
  ok('binaryFiles 里没有同名旧引用', get('TXT_NOSTALE') === 'true');
  ok('文本内容正确写入', get('TXT_CONTENT') === '<svg/>', 'got=' + get('TXT_CONTENT'));
  ok('往图片路径塞文本会被拒绝', get('PIC_REJECT') === 'true');

  console.log('\n── 判据四：只删图时 apply 也要生效 ──────');
  ok('apply 不报错', get('APPLY_OK') === 'true', get('APPLY_ERR') || '');
  ok('apply 后引用没了', get('APPLY_GONE') === 'true');
  ok('apply 后其他大文件还在', get('APPLY_KEPT') === 'true');
}

const mainSrc = fs.readFileSync(
  (ROOT + '/src/cn/com/scsxrkj/MainActivity.java').split(String.fromCharCode(92)).join('/'),
  'utf8');

console.log('\n── 判据五：删图之后要真去回收磁盘 ──────');
ok('AI 自动写回后调用 gcBigFiles', /if\(writeMode\.equals\("auto"\)\)\{[\s\S]{0,1500}?gcBigFiles\(\)/.test(mainSrc));
ok('恢复存档后也回收一次', /if\(bins!=null\)gcBigFiles\(\);/.test(mainSrc));
ok('只删图时状态不能报成「没有改动」',
   mainSrc.includes('boolean binsSame=') && mainSrc.includes('filesSame&&binsSame?"unchanged":"applied"'));

console.log('\n── 判据六：删图不能连累别的项目 ──────');
ok('删除单个文件不再自己删磁盘内容',
   !/String ref=bins\.getString\(path\);/.test(mainSrc) ||
   !/if\(ref\.endsWith\("\.bin"\)&&!stillReferenced/.test(mainSrc));
ok('删除单个文件后交给 gcBigFiles 统一回收',
   /else throw new Exception\("文件不存在"\);[\s\S]{0,1200}?gcBigFiles\(\);/.test(mainSrc));
ok('彻底删除项目后回收它独占的大文件',
   /if\(note\.exists\(\)&&!note\.delete\(\)\)cleanup=false;[\s\S]{0,1500}?gcBigFiles\(\);/.test(mainSrc));
ok('gcBigFiles 不再接受一个用不到的参数', !/void gcBigFiles\(JSONObject/.test(mainSrc));

console.log('\n── 判据七：回收站里的项目不能被误删大文件 ──────');
ok('回收时会数「最近删除」里的项目',
   /JSONArray trash=state\.optJSONArray\("projectTrash"\)/.test(mainSrc)
   && /box\.optJSONObject\("project"\)/.test(mainSrc));

ok('不再有「只看本项目引用」的 stillReferenced', !mainSrc.includes('stillReferenced'));


fs.rmSync(dir, { recursive: true, force: true });
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
