#!/usr/bin/env node
/**
 * 回归测试：导入大文件的两条硬要求 —— 临时文件必须清干净，改名失败必须报错。
 *
 * <p><b>缺陷背景一 —— 改名失败当成功：</b>
 * 导入大文件时先写 {@code tmp-xxx.part}，整份读完才知道内容哈希，
 * 之后再把临时文件改名成 {@code <sha前32位>.bin}。原来的写法是：
 *
 * <pre>
 * if(!target.isFile()){
 *   if(!tmp.renameTo(target)) tmp.delete();
 * } else tmp.delete();
 * entries.put(name, new JSONObject().put(REF_MARK, ref)...);
 * </pre>
 *
 * <p>改名失败就把读好的内容删掉，然后<b>照样</b>往 {@code binaryFiles} 里写一个
 * 指向 {@code ref} 的引用，照样 {@code added++}，照样算进「补了 X MB」。
 * 备份恢复最常见的中断方式就是空间满、外置存储被拔，那时候 {@code renameTo}
 * 会返回 false —— 用户看到「补了 12 个文件」，其中几个点开是「内容缺失」，
 * 而磁盘上既没有内容也没有半成品，连重试都不知道该重试哪个。
 *
 * <p><b>缺陷背景二 —— 临时文件没人清：</b>
 * 原来只在「超过单文件上限」那一个分支里 {@code tmp.delete()}。
 * 包损坏导致读抛 IOException、写到一半磁盘满、读的过程中应用被系统回收，
 * 这三种情况都会留下几十兆的 {@code tmp-*.part}。
 * 而 {@code gcBigFiles} 只认 {@code .bin} 后缀，这些文件等于永久垃圾 ——
 * 用户「腾空间」越腾越少，界面上没有任何地方告诉他是谁占了。
 *
 * <p>本测试从源码里取出真实的 {@code importEntry} 编译运行，
 * 用真的 ZIP 流、真的文件系统，不是对着源码字面量做断言。
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
const mImportEntry = grabMethod(java, 'long importEntry(ZipInputStream z,String name,JSONObject entries)throws Exception{');
const mBigDir = grabMethod(cloudFiles, 'static File bigDir(File filesDir){');
const mHashFile = grabMethod(cloudFiles, 'static String hashFile(File f)throws Exception{');

/*
 * 探针里的 CloudFiles 常量与同名逻辑。
 * 前缀关系：被测方法里写的是 CloudFiles.xxx，探针类里改成本类的静态成员，
 * 所以下面要把引用逐个替换掉。
 */
const jBigDir = mBigDir.replace('static File bigDir(', 'static File bigDir(').replace('BIG_DIR', '"project-files"');

const jImportEntry = mImportEntry
  .replace(/getFilesDir\(\)/g, 'root')
  .replace(/CloudFiles\.bigDir\(/g, 'bigDir(')
  .replace(/CloudFiles\.REF_MARK/g, 'REF_MARK')
  .replace(/CloudFiles\.BIG_THRESHOLD/g, 'BIG_THRESHOLD')
  /*
   * 小文件分支不在本测试范围（它不落盘、没有临时文件），
   * 为了编译通过替换成最小实现，并去掉对 android.util.Base64 的依赖。
   */
  .replace(
    /byte\[\] data=head\.toByteArray\(\);\s*boolean text=CloudFiles\.text\(data\);\s*entries\.put\(name,CloudFiles\.entry\(\s*text\?new String\(data,StandardCharsets\.UTF_8\):android\.util\.Base64\.encodeToString\(data,android\.util\.Base64\.NO_WRAP\),\s*text\?"utf8":"base64"\)\);\s*return total;/,
    'byte[] data=head.toByteArray();putSmall(name,data);return total;');

const HARNESS = `
package cn.com.scsxrkj;

import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.zip.ZipInputStream;

/**
 * 探针：跑真实的 importEntry。
 * 这个方法的全部落盘行为都在 project-files 目录里，不碰 Activity，
 * 所以给它一个临时目录当 filesDir 就能独立跑。
 */
public class ImportProbe {

    static final String REF_MARK = "ref";
    static final int BIG_THRESHOLD = 256 * 1024;

    /*
     * 真机的单文件上限是 100 MB。测试里调到 2 MB，
     * 这样「超上限」用例不用真造 100 MB 数据就能触发同一条分支。
     */
    static final long MAX_IMPORT_FILE = 2L * 1024 * 1024;

    static final java.util.List<String> smalls = new java.util.ArrayList<>();

    /** 探针用的 filesDir，main 里指向临时目录 */
    static File root;

    /** 小文件分支的替身：只记下来，不校验内容 */
    static void putSmall(String name, byte[] data) throws Exception {
        smalls.add(name);
    }

${jBigDir}

${mHashFile}

${jImportEntry}

    // ── 造数据 ────────────────────────────────────────────────

    /** 造一个只含一个条目的 ZIP，返回其字节。 */
    static byte[] zip(String name, byte[] content) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream zo = new java.util.zip.ZipOutputStream(bo)) {
            zo.putNextEntry(new java.util.zip.ZipEntry(name));
            zo.write(content);
            zo.closeEntry();
        }
        return bo.toByteArray();
    }

    /** 固定内容，方便两次导入算出同一个内容哈希。 */
    static byte[] filler(int size) {
        byte[] b = new byte[size];
        for (int i = 0; i < size; i++) b[i] = (byte) ((i * 31 + 7) & 0xff);
        return b;
    }

    static String sha256(byte[] b) throws Exception {
        StringBuilder s = new StringBuilder();
        for (byte v : MessageDigest.getInstance("SHA-256").digest(b)) s.append(String.format(java.util.Locale.ROOT, "%02x", v & 255));
        return s.toString();
    }

    /** 数一下 project-files 里还剩几个 .part */
    static int parts(File root) {
        File d = new File(root, "project-files");
        File[] fa = d.listFiles();
        int n = 0;
        if (fa != null) for (File f : fa) if (f.getName().startsWith("tmp-") && f.getName().endsWith(".part")) n++;
        return n;
    }

    /** 数一下 project-files 里有几个 .bin */
    static int bins(File root) {
        File d = new File(root, "project-files");
        File[] fa = d.listFiles();
        int n = 0;
        if (fa != null) for (File f : fa) if (f.getName().endsWith(".bin")) n++;
        return n;
    }

    public static void main(String[] a) throws Exception {
        root = new File(a[0]);
        StringBuilder out = new StringBuilder();

        // ── 用例一：正常导入一个大文件 ──────────────────────────
        byte[] big = filler(500 * 1024);
        JSONObject one = new JSONObject();
        long total;
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip("assets/model.onnx", big)))) {
            z.getNextEntry();
            total = new ImportProbe().importEntry(z, "assets/model.onnx", one);
        }
        String ref = one.getJSONObject("assets/model.onnx").optString(REF_MARK, "");
        String sha = one.getJSONObject("assets/model.onnx").optString("sha256", "");
        File stored = new File(new File(root, "project-files"), ref);
        out.append("T1_TOTAL=").append(total).append('\\n');
        out.append("T1_REF_OK=").append(!ref.isEmpty() && ref.endsWith(".bin")).append('\\n');
        out.append("T1_SHA_OK=").append(sha.equals(sha256(big))).append('\\n');
        out.append("T1_EXISTS=").append(stored.isFile()).append('\\n');
        out.append("T1_SIZE=").append(stored.length()).append('\\n');
        out.append("T1_PARTS=").append(parts(root)).append('\\n');
        out.append("T1_SIZE_FIELD=").append(one.getJSONObject("assets/model.onnx").optLong("size", -1)).append('\\n');

        // ── 用例二：同样内容再导一次 ────────────────────────────
        JSONObject two = new JSONObject();
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip("copy/model.onnx", big)))) {
            z.getNextEntry();
            new ImportProbe().importEntry(z, "copy/model.onnx", two);
        }
        out.append("T2_PARTS=").append(parts(root)).append('\\n');
        out.append("T2_BINS=").append(bins(root)).append('\\n');
        out.append("T2_REF_SAME=").append(two.getJSONObject("copy/model.onnx").optString(REF_MARK, "").equals(ref)).append('\\n');

        // ── 用例三：改名失败必须报错 ────────────────────────────
        /*
         * 造一个真实的改名失败：把目标名先占成一个目录。
         * renameTo 到「已存在的目录」在 Windows 和 Linux 上都会返回 false，
         * 这正是空间满/外置存储拔出时 rename 表现出来的同一类失败。
         */
        byte[] ugly = filler(400 * 1024 + 1);
        String uglyRef = sha256(ugly).substring(0, 32) + ".bin";
        File blocker = new File(new File(root, "project-files"), uglyRef);
        blocker.mkdirs();
        String t3;
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip("assets/oops.bin", ugly)))) {
            z.getNextEntry();
            new ImportProbe().importEntry(z, "assets/oops.bin", new JSONObject());
            t3 = "NO_THROW";
        } catch (Exception e) {
            t3 = safe(e.getMessage());
        }
        out.append("T3_MSG=").append(t3).append('\\n');
        out.append("T3_PARTS=").append(parts(root)).append('\\n');
        blocker.delete();

        // ── 用例四：超单文件上限，临时文件要清 ──────────────────
        byte[] huge = filler(3 * 1024 * 1024);
        String t4;
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip("assets/huge.bin", huge)))) {
            z.getNextEntry();
            new ImportProbe().importEntry(z, "assets/huge.bin", new JSONObject());
            t4 = "NO_THROW";
        } catch (Exception e) {
            t4 = safe(e.getMessage());
        }
        out.append("T4_MSG=").append(t4).append('\\n');
        out.append("T4_PARTS=").append(parts(root)).append('\\n');

        // ── 用例五：读到一半流坏了，临时文件要清 ────────────────
        byte[] broken = zip("assets/broken.bin", filler(800 * 1024));
        final int[] calls = {0};
        String t5;
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(broken)) {
            @Override public int read(byte[] b, int off, int len) throws IOException {
                if (++calls[0] > 6) throw new IOException("模拟存储读取中断");
                return super.read(b, off, len);
            }
        }) {
            z.getNextEntry();
            new ImportProbe().importEntry(z, "assets/broken.bin", new JSONObject());
            t5 = "NO_THROW";
        } catch (Exception e) {
            t5 = safe(e.getMessage());
        }
        out.append("T5_MSG=").append(t5).append('\\n');
        out.append("T5_PARTS=").append(parts(root)).append('\\n');

        // ── 用例六：小文件不该产生临时文件 ──────────────────────
        byte[] small = filler(1024);
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip("a.txt", small)))) {
            z.getNextEntry();
            new ImportProbe().importEntry(z, "a.txt", new JSONObject());
        }
        out.append("T6_PARTS=").append(parts(root)).append('\\n');
        out.append("T6_SMALL=").append(smalls.size()).append('\\n');

        System.out.print(out);
    }

    /** 异常信息里可能有换行，压成一行方便解析 */
    static String safe(String s) { return s == null ? "" : s.replaceAll("[\\\\r\\\\n]+", " "); }
}
`;

const tmpDir = path.join(__dirname, '.tmp-import');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj'), { recursive: true });

// 复用项目已有的 JSONObject / JSONArray 测试替身
const supportDir = path.join(__dirname, 'support', 'orgjson');
fs.mkdirSync(path.join(tmpDir, 'src', 'org', 'json'), { recursive: true });
for (const f of fs.readdirSync(supportDir)) {
  fs.copyFileSync(path.join(supportDir, f), path.join(tmpDir, 'src', 'org', 'json', f));
}
fs.writeFileSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'ImportProbe.java'), HARNESS);

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const javac = path.join(JAVA_HOME, 'bin', 'javac.exe');
const javaBin = path.join(JAVA_HOME, 'bin', 'java.exe');

try {
  execFileSync(javac, ['-encoding', 'UTF-8', '-nowarn', '-d', path.join(tmpDir, 'out'),
    path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'ImportProbe.java'),
    path.join(tmpDir, 'src', 'org', 'json', 'JSONObject.java'),
    path.join(tmpDir, 'src', 'org', 'json', 'JSONArray.java')], { stdio: 'pipe' });
} catch (e) {
  console.error('编译失败：\n' + (e.stdout || '').toString() + (e.stderr || '').toString());
  process.exit(1);
}

const dataDir = path.join(tmpDir, 'files');
fs.mkdirSync(dataDir, { recursive: true });
/*
 * 探针会把方法抛出的原始异常信息打出来，而那是中文。
 * Windows 控制台默认按 GBK 解码，混进来就是乱码，
 * 断言「报错里有没有说明原因」会假失败 —— 所以显式要求 UTF-8。
 */
const raw = execFileSync(javaBin,
  ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
    '-cp', path.join(tmpDir, 'out'), 'cn.com.scsxrkj.ImportProbe', dataDir],
  { encoding: 'utf8' });
const v = {};
for (const line of raw.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) v[m[1]] = m[2].trim();
}

console.log('\n── 正常导入：内容落盘、引用与哈希对得上 ────────');
ok('返回的字节数就是文件大小', v.T1_TOTAL === String(500 * 1024), 'total=' + v.T1_TOTAL);
ok('写出的引用是 .bin 名字', v.T1_REF_OK === 'true', v.T1_REF_OK);
ok('sha256 就是内容的哈希', v.T1_SHA_OK === 'true', v.T1_SHA_OK);
ok('磁盘上确实有这个文件', v.T1_EXISTS === 'true', v.T1_EXISTS);
ok('落盘大小与源一致', v.T1_SIZE === String(500 * 1024), 'size=' + v.T1_SIZE);
ok('条目里记的 size 也对', v.T1_SIZE_FIELD === String(500 * 1024), v.T1_SIZE_FIELD);
ok('导入成功后没有留下临时文件', v.T1_PARTS === '0', 'parts=' + v.T1_PARTS);

console.log('\n── 同内容再导入：不重复落盘，也不留临时文件 ────');
ok('重复导入后临时文件仍然为 0', v.T2_PARTS === '0', 'parts=' + v.T2_PARTS);
ok('同内容只存一份', v.T2_BINS === '1', 'bins=' + v.T2_BINS);
ok('两个路径指向同一份内容', v.T2_REF_SAME === 'true', v.T2_REF_SAME);

console.log('\n── 改名失败：必须报错，不能假装成功 ────────────');
ok('改名失败会抛出异常', v.T3_MSG !== 'NO_THROW', '没有抛异常，被当成成功了');
ok('报错说明了写入失败', /写入大文件失败/.test(v.T3_MSG || ''), v.T3_MSG);
ok('失败后不留下临时文件', v.T3_PARTS === '0', 'parts=' + v.T3_PARTS);

console.log('\n── 超过单文件上限：报错并清临时文件 ────────────');
ok('超上限会抛出异常', v.T4_MSG !== 'NO_THROW', '没有抛异常');
ok('报错点明单个文件超限', /单个文件超过/.test(v.T4_MSG || ''), v.T4_MSG);
ok('超限后不留下临时文件', v.T4_PARTS === '0', 'parts=' + v.T4_PARTS);

console.log('\n── 读到一半流坏了：也要清临时文件 ──────────────');
ok('流中断会抛出异常', v.T5_MSG !== 'NO_THROW', '没有抛异常');
ok('流中断后不留下临时文件', v.T5_PARTS === '0', 'parts=' + v.T5_PARTS);

console.log('\n── 小文件走内存，不该碰磁盘 ────────────────────');
ok('小文件不产生临时文件', v.T6_PARTS === '0', 'parts=' + v.T6_PARTS);
ok('小文件进入了文本分支', v.T6_SMALL === '1', 'smalls=' + v.T6_SMALL);

/*
 * ── 兜底回收 ────────────────────────────────────────────────
 * importEntry 的 finally 会清掉自己产生的临时文件，但那管不了
 * 「进程被强杀」和「旧版本留下的残留」。gcBigFiles 是唯一的定期清道夫，
 * 它如果不认识 .part，这些文件就永远在盘上。
 */
console.log('\n── gcBigFiles 要认得中断导入的临时文件 ─────────');
const gc = grabMethod(java, 'void gcBigFiles(){');
ok('gcBigFiles 会扫 tmp- 开头的文件', /nm\.startsWith\("tmp-"\)/.test(gc), '没有处理 tmp- 前缀');
ok('只清超过一小时的临时文件', /3600000L/.test(gc), '没有时间窗，可能删掉正在导入的');
ok('清理临时文件后不参与 .bin 的存活判断', /continue;/.test(gc), '临时文件没有跳过后续逻辑');

console.log('\n----------------------------------------------------');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED ' + fail) + ' (import_bigfile_test)  ' + pass + ' 项');
process.exit(fail === 0 ? 0 : 1);
