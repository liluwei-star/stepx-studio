#!/usr/bin/env node
/**
 * 回归测试：存档必须连二进制引用一起拍，否则「恢复上一版」是空头支票。
 *
 * <p>缺陷背景：
 * 图片、字体、模型权重都在 {@code binaryFiles} 这张表里，真实内容在
 * {@code project-files/*.bin}。以前的存档只拍 {@code files}（文本），于是：
 *
 * <ol>
 *   <li>用户删掉一张图 → {@code binaryFiles} 里那条引用消失；</li>
 *   <li>{@code gcBigFiles} 看到没人引用，把磁盘上的 {@code .bin} 也删了；</li>
 *   <li>用户点「恢复上一版」→ 文本回来了，图永远回不来。</li>
 * </ol>
 *
 * <p>本测试跑真实的 {@code CloudFiles.snapshot(...)}，检查存档里带不带引用。
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

const dir = path.join(ROOT, 'tests', '.tmp-snapbins');
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

// CloudFiles 带 package 声明，探针必须同包，否则调不到
fs.mkdirSync(path.join(work, 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(work, 'cn', 'com', 'scsxrkj', 'SnapBinsProbe.java'), `
package cn.com.scsxrkj;

import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;

/**
 * 测试探针：直接调 CloudFiles.snapshot(...)，看存档里有没有二进制引用。
 */
public class SnapBinsProbe {
    public static void main(String[] a) throws Exception {
        File filesDir = new File(a[0]);
        filesDir.mkdirs();

        JSONObject proj = new JSONObject();
        proj.put("id", "p1");
        JSONObject files = new JSONObject();
        files.put("index.html", "<h1>hi</h1>");
        files.put("assets/photo.png", "");   // 二进制在 binaryFiles 里，files 只有空串占位
        proj.put("files", files);

        JSONObject bins = new JSONObject();
        bins.put("assets/photo.png", "abc123.bin");
        proj.put("binaryFiles", bins);

        CloudFiles.snapshot(proj);

        JSONArray snaps = proj.optJSONArray("snapshots");
        System.out.println("SNAPCOUNT " + snaps.length());
        JSONObject s = snaps.optJSONObject(snaps.length() - 1);
        JSONObject b = s.optJSONObject("bins");
        System.out.println("HASBINS " + (b != null));
        if (b != null) {
            System.out.println("REF " + b.optString("assets/photo.png", ""));
        }
        // 文本也要照旧存
        JSONObject sf = s.optJSONObject("files");
        System.out.println("TEXT " + (sf != null && sf.has("index.html")));
    }
}
`);

console.log('\n── 判据一：存档里要带二进制引用 ──────');
let compiled = false;
try {
  execFileSync(JAVAC, [
    '-encoding', 'UTF-8', '-nowarn',
    '-cp', ANDROID_JAR,
    '-d', work,
    path.join(work, 'cn', 'com', 'scsxrkj', 'SnapBinsProbe.java'),
    path.join(ROOT, 'src', 'cn', 'com', 'scsxrkj', 'CloudFiles.java'),
    path.join(jsonSrc, 'JSONObject.java'),
    path.join(jsonSrc, 'JSONArray.java'),
    path.join(work, 'android', 'util', 'Base64.java'),
  ], { stdio: 'pipe' });
  compiled = true;
  ok('探针编译通过', true);
} catch (e) {
  ok('探针编译通过', false, String(e.stderr || e.stdout || e).slice(0, 900));
}

if (compiled) {
  const out = execFileSync(JAVA, ['-cp', work, 'cn.com.scsxrkj.SnapBinsProbe', path.join(dir, 'app')],
    { encoding: 'utf8' });
  const get = (k) => {
    const l = out.split('\n').find(x => x.startsWith(k + ' '));
    return l ? l.slice(k.length + 1).trim() : null;
  };
  ok('存档确实生成了', get('SNAPCOUNT') === '1', 'count=' + get('SNAPCOUNT'));
  ok('存档里有 bins 表', get('HASBINS') === 'true');
  ok('bins 里保留了原引用', get('REF') === 'abc123.bin', 'ref=' + get('REF'));
  ok('文本文件仍然照旧存', get('TEXT') === 'true');
}

console.log('\n── 判据二：恢复和回收的逻辑要配套 ──────');
const mainSrc = fs.readFileSync(
  (ROOT + '/src/cn/com/scsxrkj/MainActivity.java').split(String.fromCharCode(92)).join('/'),
  'utf8');
ok('恢复存档时会读存档里的 bins', mainSrc.includes('JSONObject snapBins=last.optJSONObject("bins")'));
ok('恢复时把 bins 一起交下去', mainSrc.includes('q.put("bins",new JSONObject(snapBins.toString()))'));
ok('应用改动时整张 binaryFiles 换回去',
   mainSrc.includes('changed.put("binaryFiles",new JSONObject(bins.toString()))'));
ok('回收时把存档里的引用也算活引用',
   mainSrc.includes('JSONObject sb=s.optJSONObject("bins")'));
ok('回收时兼容老存档的 binaryFiles 字段',
   mainSrc.includes('JSONObject sb2=s.optJSONObject("binaryFiles")'));
ok('云端分支也认新存档的 bins',
   mainSrc.includes('JSONObject lastBins=last.optJSONObject("bins")'));
ok('云端分支兼容老存档的 binaryFiles',
   mainSrc.includes('if(lastBins==null)lastBins=last.optJSONObject("binaryFiles")'));
ok('推给前端的快照带上二进制路径清单',
   mainSrc.includes('.put("binNames",binList)'));



fs.rmSync(dir, { recursive: true, force: true });
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
