/*
 * 大文件不能因为「两个项目里有同名路径」就互相覆盖。
 *
 * <p><b>背景：</b>大文件（超过 256 KB 的模型、图片、字体）不存进 workspace.json，
 * 而是拆成独立文件放在 {@code project-files/} 目录里，项目里只留一个引用名。
 *
 * <p>关键前提：<b>这个目录是所有项目共用的</b>。所以引用名就是文件在磁盘上的唯一身份 ——
 * 一旦两个项目算出同一个名字，后写的就把先写的覆盖掉。
 *
 * <p><b>原来的 BUG：</b>引用名是「路径的 SHA-256 前 16 位」。
 * 而项目内路径在不同项目里会重名 —— 两个项目都有 {@code assets/model.onnx} 时，
 * 算出来是同一个文件名。
 *
 * <p><b>症状（很阴）：</b>
 * <ul>
 *   <li>项目 A 的模型内容被项目 B 的顶掉；</li>
 *   <li>素材体检说分片都齐了（因为文件名对得上、大小对得上），</li>
 *   <li>但装上去就是认不出来 —— 内容根本不是自己的；</li>
 *   <li>而且<b>全程没有任何报错</b>，只是内容不对。</li>
 * </ul>
 *
 * <p>还有一个同源的问题：同一项目里内容改了、路径没变，名字也不变 ——
 * 旧内容被新内容覆盖，而 {@code bigHashes} 里记的哈希和新内容对不上，
 * 下次同步会被判成「两边都改了」而报冲突。
 *
 * <p><b>修法：</b>引用名改成<b>按内容定名</b>（内容寻址）。
 * 内容不同 → 名字不同 → 绝不会撞名；内容相同 → 名字相同 → 天然复用一份磁盘。
 *
 * <p>这里跑真实的 Java 方法，验证「两个项目写同名路径、不同内容」之后，
 * 两份内容都还在，且互不覆盖。
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

const dir = path.join(ROOT, 'tests', '.tmp-bigname');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

/* ------------------------------------------------------------------ *
 * 造一个只依赖 CloudFiles 的最小环境
 *
 * <p>CloudFiles 依赖 android.util.Base64，所以编译时要带上 android.jar，
 * 运行时要提供 org.json —— android.jar 里的 org.json 是 stub，
 * 跑不起来，所以这里用测试自带的替身。
 * ------------------------------------------------------------------ */
// 用正斜杠拼路径：Windows 上 Node 对反斜杠长路径有时会缓存旧状态，
// 正斜杠是 Node 在 Windows 上稳定支持的写法。
const srcDir = (ROOT + '/src/cn/com/scsxrkj').split(String.fromCharCode(92)).join('/');
const work = path.join(dir, 'work');
fs.mkdirSync(work, { recursive: true });

// 替身的包名是 org.json，javac 要求目录结构跟包名一致，所以要摆成 org/json/
const jsonSrc = path.join(work, 'org', 'json');
fs.mkdirSync(jsonSrc, { recursive: true });
for (const n of ['JSONObject.java', 'JSONArray.java']) {
  fs.copyFileSync(path.join(ROOT, 'tests', 'support', 'orgjson', n), path.join(jsonSrc, n));
}

// android.util.Base64 的替身：只实现 CloudFiles 用到的那几个方法
fs.mkdirSync(path.join(work, 'android', 'util'), { recursive: true });
fs.writeFileSync(path.join(work, 'android', 'util', 'Base64.java'), `
package android.util;
/** 测试替身：只实现 CloudFiles 用到的那几个常量和方法。 */
public class Base64 {
    public static final int DEFAULT = 0;
    public static final int NO_WRAP = 2;
    public static byte[] decode(String s, int flags) throws IllegalArgumentException {
        return java.util.Base64.getMimeDecoder().decode(s);
    }
    public static String encodeToString(byte[] b, int flags) {
        return java.util.Base64.getEncoder().encodeToString(b);
    }
}
`);

console.log('\n── 判据一：两个项目写同名路径、不同内容，谁都别覆盖谁 ──────');
{
  // CloudFiles 依赖 MainActivity 里的一些静态方法，整体编译太重。
  // 这里只把 bigNameFor / writeBig 这两个纯函数抠出来测 ——
  // 它们才是决定「文件在磁盘上叫什么名字」的地方。
  const cf = fs.readFileSync(path.join(srcDir, 'CloudFiles.java'), 'utf8');

  // bigNameFor：按内容定名
  const m1 = cf.match(/static String bigNameFor\(byte\[\] content\)throws Exception\{[\s\S]*?\n \}/);
  ok('CloudFiles 里有按内容定名的 bigNameFor', !!m1);

  // writeBig(File, byte[])
  const m2 = cf.match(/static JSONObject writeBig\(File filesDir,byte\[\] raw\)throws Exception\{[\s\S]*?\n \}/);
  ok('CloudFiles 里有按内容写盘的 writeBig(File,byte[])', !!m2);

  // bigName(path) 只按路径算 —— 旧的命名方式，必须不再被用来写盘
  const m3 = cf.match(/static String bigName\(String path\)throws Exception\{[^}]*\}/);
  ok('仍然保留 bigName(path) 作为旧数据的兼容查找', !!m3);

  if (m1 && m2) {
    const probe = `
package cn.com.scsxrkj;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/** 抠出来的最小复现：只测「文件在磁盘上叫什么名字」。 */
public class BigNameProbe {
${m1[0]}
${m2[0]}
    static String hash(byte[] b) throws Exception {
        StringBuilder s = new StringBuilder();
        for (byte v : MessageDigest.getInstance("SHA-256").digest(b))
            s.append(String.format(java.util.Locale.ROOT, "%02x", v & 255));
        return s.toString();
    }
    static String bigDir(File filesDir) throws Exception {
        File d = new File(filesDir, "project-files");
        d.mkdirs();
        return d.getPath();
    }
    static String REF_MARK = "ref";

    public static void main(String[] args) throws Exception {
        File filesDir = new File(args[0]);
        // 两个项目，同名路径，不同内容
        byte[] a = ("项目A的模型内容".repeat(500)).getBytes(StandardCharsets.UTF_8);
        byte[] b = ("项目B的模型内容".repeat(500)).getBytes(StandardCharsets.UTF_8);

        JSONObject ra = writeBig(filesDir, a);
        JSONObject rb = writeBig(filesDir, b);
        String na = ra.getString(REF_MARK), nb = rb.getString(REF_MARK);

        System.out.println("nameA=" + na);
        System.out.println("nameB=" + nb);
        System.out.println("sameName=" + na.equals(nb));

        // A 的内容还在吗？
        File fa = new File(new File(filesDir, "project-files"), na);
        boolean aIntact = fa.isFile();
        String aContent = "";
        if (aIntact) {
            byte[] got = new byte[(int) fa.length()];
            try (RandomAccessFile in = new RandomAccessFile(fa, "r")) { in.readFully(got); }
            aContent = new String(got, StandardCharsets.UTF_8);
        }
        System.out.println("aIntact=" + aIntact);
        System.out.println("aContentOk=" + aContent.equals(new String(a, StandardCharsets.UTF_8)));

        // B 的内容对吗？
        File fb = new File(new File(filesDir, "project-files"), nb);
        byte[] got = new byte[(int) fb.length()];
        try (RandomAccessFile in = new RandomAccessFile(fb, "r")) { in.readFully(got); }
        System.out.println("bContentOk=" + new String(got, StandardCharsets.UTF_8).equals(new String(b, StandardCharsets.UTF_8)));

        // 相同内容 → 同一个引用（省磁盘）
        JSONObject rc = writeBig(filesDir, a);
        System.out.println("sameContentSameRef=" + rc.getString(REF_MARK).equals(na));

        // 磁盘上到底有几份
        String[] list = new File(filesDir, "project-files").list();
        System.out.println("fileCount=" + (list == null ? 0 : list.length));
    }
}
`;
    fs.writeFileSync(path.join(work, 'BigNameProbe.java'), probe);
    // JSONObject 替身没有 put(String,boolean) 之类？先编译看看
    try {
      execFileSync(JAVAC, [
        '-encoding', 'UTF-8', '-nowarn',
        '-d', path.join(dir, 'classes'),
        '-cp', ANDROID_JAR,
        path.join(work, 'BigNameProbe.java'),
        path.join(jsonSrc, 'JSONObject.java'),
        path.join(jsonSrc, 'JSONArray.java'),
        path.join(work, 'android', 'util', 'Base64.java'),
      ], { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      console.log('  ✗ 编译探针失败');
      console.log(String(e.stdout || '').slice(0, 2000));
      console.log(String(e.stderr || '').slice(0, 2000));
      fail++;
      throw new Error('probe compile failed');
    }

    const out = execFileSync(JAVA, [
      '-cp', path.join(dir, 'classes'),
      'cn.com.scsxrkj.BigNameProbe',
      path.join(dir, 'fs'),
    ], { encoding: 'utf8' });

    const nameA = (out.match(/nameA=(\S+)/) || [])[1];
    const nameB = (out.match(/nameB=(\S+)/) || [])[1];
    const sameName = /sameName=true/.test(out);
    const aIntact = /aIntact=true/.test(out);
    const aContentOk = /aContentOk=true/.test(out);
    const bContentOk = /bContentOk=true/.test(out);
    const sameContentSameRef = /sameContentSameRef=true/.test(out);
    const fileCount = parseInt((out.match(/fileCount=(\d+)/) || [])[1] || '-1');

    ok('两个项目的同名文件算出不同的引用名', !sameName, 'A=' + nameA + ' B=' + nameB);
    ok('A 的文件还在磁盘上', aIntact);
    ok('A 的内容没被 B 覆盖', aContentOk);
    ok('B 的内容正确', bContentOk);
    ok('相同内容复用同一个引用（不重复占磁盘）', sameContentSameRef);
    ok('磁盘上只有 2 份文件（不是 3 份）', fileCount === 2, 'count=' + fileCount);
    ok('引用名以 .bin 结尾', /\.bin$/.test(nameA || ''), String(nameA));
  }
}

console.log('\n── 判据二：写盘路径不再用「只按路径算名字」的老方法 ──────');
{
  const cf = fs.readFileSync(path.join(srcDir, 'CloudFiles.java'), 'utf8');
  const ma = fs.readFileSync(path.join(srcDir, 'MainActivity.java'), 'utf8');
  const mp = fs.readFileSync(path.join(srcDir, 'CloudProjects.java'), 'utf8');

  // assign 里的大文件分支必须走内容寻址
  const assignBlock = cf.match(/static void assign\([\s\S]*?\n p\.put\("files"/);
  ok('assign 的大文件分支用 writeBig(filesDir,raw)', assignBlock &&
    /writeBig\(filesDir,raw\)/.test(assignBlock[0]) &&
    !/bigName\(/.test(assignBlock[0]));

  // externalizeBinaries 同理
  const extBlock = cf.match(/static long externalizeBinaries\([\s\S]*?\n \}/);
  ok('externalizeBinaries 走内容寻址', extBlock &&
    /writeBig\(filesDir,raw\)/.test(extBlock[0]) &&
    !/bigName\(/.test(extBlock[0]));

  // 重命名/移动/复制不再搬文件（搬文件会中途失败留下坏引用）
  ok('MainActivity 里不再用 bigName(to) 造新名', !/CloudFiles\.bigName\(to\)/.test(ma));
  ok('MainActivity 里不再调用 moveBigFile', !/moveBigFile\(/.test(ma));
  ok('MainActivity 里不再调用 copyBigFile', !/copyBigFile\(/.test(ma));

  // 云端同步搬暂存区大文件
  ok('CloudProjects 里不再用 bigName', !/CloudFiles\.bigName\(/.test(mp));
  ok('CloudProjects 走内容寻址的 writeBig', /writeBig\(a\.getFilesDir\(\),raw\)/.test(mp));

  // 导入大文件：先写临时文件、算完哈希再改名
  ok('导入大文件时先写临时名', /tmp-.*\.part/.test(ma));
  ok('导入大文件按内容哈希定名', /sha\.substring\(0,32\)\+"\.bin"/.test(ma));
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
