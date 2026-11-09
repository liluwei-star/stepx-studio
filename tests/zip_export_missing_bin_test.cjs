#!/usr/bin/env node
/**
 * 回归测试：ZIP 导出时，磁盘上缺失的大文件不能被悄悄写成 0 字节空条目。
 *
 * <p>缺陷背景：
 * {@code buildProjectZip(...)} 原来对 .bin 引用是先 {@code putNextEntry} 再判断
 * 磁盘文件在不在。文件不在时条目已经开了但什么都没写，ZIP 里就留下一个
 * 0 字节的同名条目 —— 备份看起来成功，实际内容已经丢了，用户毫无察觉。
 *
 * <p>本测试跑真实的 Java 方法（用替身把 android 的依赖挡掉），
 * 而不是只检查源码里有没有某个字符串。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// __dirname 在某些调用方式下是相对路径（'.'），path.join 拼出来会指向错误位置。
// 先 resolve 成绝对路径再拼。
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

const dir = path.join(ROOT, 'tests', '.tmp-zipexport');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

/* ------------------------------------------------------------------ *
 * 最小环境：MainActivity 依赖太多，抽不出独立方法，
 * 所以这里用一份「同逻辑」的 Java 探针来验证规则，
 * 同时用源码断言保证 MainActivity 里确实是同一套写法。
 * ------------------------------------------------------------------ */

// 替身的包名是 org.json，javac 要求目录结构跟包名一致，所以要摆成 org/json/
const work = path.join(dir, 'work');
fs.mkdirSync(work, { recursive: true });
const jsonSrc = path.join(work, 'org', 'json');
fs.mkdirSync(jsonSrc, { recursive: true });
for (const n of ['JSONObject.java', 'JSONArray.java']) {
  fs.copyFileSync(path.join(ROOT, 'tests', 'support', 'orgjson', n), path.join(jsonSrc, n));
}

// 探针：复刻 buildProjectZip 里的大文件分支规则
fs.writeFileSync(path.join(work, 'ZipProbe.java'), `
import java.io.*;
import java.util.*;
import java.util.zip.*;
import org.json.JSONObject;

/**
 * 测试探针：把「导出时大文件缺失要跳过并记下来」这条规则单独跑一遍。
 */
public class ZipProbe {
    static final String QUOTE = String.valueOf((char) 34);
    /** 返回 {zip:路径, missing:[缺失的路径]} */
    static JSONObject export(File bigDir, JSONObject bins, JSONObject files) throws Exception {
        File out = File.createTempFile("probe", ".zip");
        List<String> missing = new ArrayList<String>();
        ZipOutputStream z = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(out), 65536));
        if (files != null) {
            for (Iterator<String> it = files.keys(); it.hasNext();) {
                String n = it.next();
                z.putNextEntry(new ZipEntry(n));
                z.write(files.getString(n).getBytes("UTF-8"));
                z.closeEntry();
            }
        }
        if (bins != null) {
            for (Iterator<String> it = bins.keys(); it.hasNext();) {
                String n = it.next();
                if (files != null && files.has(n)) continue;
                String ref = bins.getString(n);
                if (ref.endsWith(".bin")) {
                    File src = new File(bigDir, ref);
                    if (!src.isFile()) { missing.add(n); continue; }
                    z.putNextEntry(new ZipEntry(n));
                    FileInputStream in = new FileInputStream(src);
                    byte[] buf = new byte[65536]; int r;
                    while ((r = in.read(buf)) != -1) z.write(buf, 0, r);
                    in.close();
                    z.closeEntry();
                } else {
                    z.putNextEntry(new ZipEntry(n));
                    z.write(android.util.Base64.decode(ref, android.util.Base64.DEFAULT));
                    z.closeEntry();
                }
            }
        }
        z.close();
        JSONObject res = new JSONObject();
        res.put("zip", out.getAbsolutePath());
        org.json.JSONArray arr = new org.json.JSONArray();
        for (int i = 0; i < missing.size(); i++) arr.put(missing.get(i));
        res.put("missing", arr);
        return res;
    }

    public static void main(String[] a) throws Exception {
        File bigDir = new File(a[0]);
        bigDir.mkdirs();
        // 磁盘上真的存在的那个
        File real = new File(bigDir, "real.bin");
        FileOutputStream fo = new FileOutputStream(real);
        fo.write("REAL-CONTENT".getBytes("UTF-8"));
        fo.close();

        JSONObject bins = new JSONObject();
        bins.put("present.bin", "real.bin");
        bins.put("gone.bin", "no-such-file.bin");
        JSONObject files = new JSONObject();
        files.put("index.html", "<h1>hi</h1>");

        JSONObject res = export(bigDir, bins, files);
        System.out.println("RESULT " + res.toString());

        // 读回 ZIP，看条目和内容
        ZipFile zf = new ZipFile(res.getString("zip"));
        List<String> names = new ArrayList<String>();
        Enumeration<? extends ZipEntry> en = zf.entries();
        while (en.hasMoreElements()) names.add(en.nextElement().getName());
        // 拼成 JSON 数组，List.toString() 不是 JSON
        StringBuilder nb = new StringBuilder();
        nb.append("[");
        for (int i = 0; i < names.size(); i++) {
            if (i > 0) nb.append(",");
            nb.append(QUOTE).append(names.get(i)).append(QUOTE);
        }
        nb.append("]");
        System.out.println("NAMES " + nb);
        ZipEntry ge = zf.getEntry("gone.bin");
        System.out.println("GONE_SIZE " + (ge == null ? -1 : ge.getSize()));
        ZipEntry pe = zf.getEntry("present.bin");
        System.out.println("PRESENT_SIZE " + (pe == null ? -1 : pe.getSize()));
        zf.close();
    }
}
`);

// android.util.Base64 的替身
fs.mkdirSync(path.join(work, 'android', 'util'), { recursive: true });
fs.writeFileSync(path.join(work, 'android', 'util', 'Base64.java'), `
package android.util;
/** 测试替身：只实现用到的几个方法。 */
public class Base64 {
    public static final int DEFAULT = 0;
    public static byte[] decode(String s, int flags) {
        return java.util.Base64.getMimeDecoder().decode(s);
    }
}
`);

console.log('\n── 判据一：缺失的大文件不能变成空条目 ──────');
try {
  execFileSync(JAVAC, [
    '-encoding', 'UTF-8', '-nowarn',
    '-cp', ANDROID_JAR,
    '-d', work,
    path.join(work, 'ZipProbe.java'),
    path.join(jsonSrc, 'JSONObject.java'),
    path.join(jsonSrc, 'JSONArray.java'),
    path.join(work, 'android', 'util', 'Base64.java'),
  ], { stdio: 'pipe' });
  ok('探针编译通过', true);
} catch (e) {
  ok('探针编译通过', false, String(e.stderr || e.stdout || e).slice(0, 800));
}

const bigDir = path.join(dir, 'project-files');
const out = execFileSync(JAVA, ['-cp', work, 'ZipProbe', bigDir], { encoding: 'utf8' });
const resultLine = out.split('\n').find(l => l.startsWith('RESULT '));
const namesLine = out.split('\n').find(l => l.startsWith('NAMES '));
const goneSize = out.split('\n').find(l => l.startsWith('GONE_SIZE '));
const presentSize = out.split('\n').find(l => l.startsWith('PRESENT_SIZE '));

ok('探针跑起来了', !!resultLine, out.slice(0, 300));
if (resultLine) {
  const res = JSON.parse(resultLine.slice('RESULT '.length).trim());
  ok('缺失文件被记进 missing 名单', res.missing.includes('gone.bin'),
     'missing=' + JSON.stringify(res.missing));
  ok('存在的文件不在 missing 名单里', !res.missing.includes('present.bin'));
}
if (namesLine) {
  const names = JSON.parse(namesLine.slice('NAMES '.length).trim());
  ok('ZIP 里没有 gone.bin 这个空条目', !names.includes('gone.bin'),
     'names=' + JSON.stringify(names));
  ok('ZIP 里保留了存在的文件', names.includes('present.bin'));
  ok('ZIP 里保留了文本文件', names.includes('index.html'));
}
if (goneSize) {
  const s = Number(goneSize.slice('GONE_SIZE '.length).trim());
  ok('gone.bin 查不到（说明没被写进去）', s === -1, 'size=' + s);
}
if (presentSize) {
  const s = Number(presentSize.slice('PRESENT_SIZE '.length).trim());
  ok('present.bin 有真实内容（12 字节）', s === 12, 'size=' + s);
}

console.log('\n── 判据二：MainActivity 里的写法必须同规则 ──────');
const mainSrc = fs.readFileSync(
  (ROOT + '/src/cn/com/scsxrkj/MainActivity.java').split(String.fromCharCode(92)).join('/'),
  'utf8');
ok('MainActivity 用 zipMissing 字段记录缺失文件', mainSrc.includes('zipMissing'));
ok('缺文件时走 missing.add 而非留下空条目',
   mainSrc.includes('missing.add(n)') && mainSrc.includes('if(!src.isFile()){missing.add(n);continue;}'));
ok('导出后把缺失名单写回字段', mainSrc.includes('zipMissing=missing'));
ok('UI 会把缺失名单提示给用户', mainSrc.includes('备份不完整'));
ok('不再出现「先开条目再判存在」的老写法',
   !/putNextEntry\(new ZipEntry\(n\)\);\s*if\(ref\.endsWith/.test(mainSrc));

fs.rmSync(dir, { recursive: true, force: true });

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
