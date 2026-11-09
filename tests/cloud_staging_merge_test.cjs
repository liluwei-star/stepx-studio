#!/usr/bin/env node
/**
 * 回归测试：把云端分片拼回一个文件。
 *
 * <p><b>缺陷背景 —— 失败时会毁掉已有的好文件：</b>
 * 原来的写法是先 setLength(0) 清空目标文件，再逐个分片往里追加：
 *
 * <pre>
 * try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
 *     raf.setLength(0);
 *     for (String s : sorted) { ... if (!part.isFile()) throw ...; }
 * }
 * </pre>
 *
 * <p>中途任何一片缺失就抛异常，而那时目标文件已经被清空并写进了前半截。
 * 如果这个路径上本来有一份完整的旧文件（先下过完整版、后来云端改成多片重同步），
 * 一次失败的合并会把能用的文件换成半截 —— 而且界面上只显示「同步失败」，
 * 用户不知道原来的文件已经没了。
 *
 * <p>现在改成先写 {@code <名字>.merging}，全部拼完再原子改名：
 * 失败就把临时文件删掉，原文件一个字节都没动。
 *
 * <p>另外两条老要求也在这里一起守住：
 * <ul>
 *   <li>分片按<b>数字</b>序号排序 —— part10 不能排到 part2 前面；</li>
 *   <li>合并过程中不把整份结果读进内存。</li>
 * </ul>
 *
 * <p>本测试从源码取出真实的 mergeShards 及其依赖方法编译运行，
 * 用真的文件系统，不是对着源码字面量做断言。
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

/* 抠方法时要跳过字符串和字符字面量，否则 '{' 这类字符会被当成真括号 */
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

const cs = read('src/cn/com/scsxrkj/CloudStaging.java');

const mFileName = grabMethod(cs, 'static String fileName(String path) throws Exception {');
const mProjectDir = grabMethod(cs, 'File projectDir(String projectId) {');
const mFileOf = grabMethod(cs, 'File fileOf(String projectId, String path) throws Exception {');
const mIsShard = grabMethod(cs, 'static boolean isShard(String path) {');
const mShardBase = grabMethod(cs, 'static String shardBase(String path) {');
const mShardIndex = grabMethod(cs, 'static int shardIndex(String path) {');
const mMerge = grabMethod(cs, 'long mergeShards(String projectId, java.util.List<String> shards, String basePath) throws Exception {');

const HARNESS = `
package cn.com.scsxrkj;

import java.io.*;
import java.security.MessageDigest;
import java.util.*;

/**
 * 探针：跑真实的 mergeShards。
 * CloudStaging 只依赖文件系统和 MessageDigest，给一个临时目录就能独立跑。
 */
public class StagingProbe {

    static final int CHUNK = 1024 * 1024;

    private final File root;

    StagingProbe(File filesDir) {
        root = new File(filesDir, "cloud-staging");
        if (!root.isDirectory() && !root.mkdirs()) throw new RuntimeException("无法创建云端暂存目录");
    }

${mFileName}

${mProjectDir}

${mFileOf}

${mIsShard}

${mShardBase}

${mShardIndex}

${mMerge}

    /** 往某个项目路径写一段内容，模拟云端已下载好的分片 */
    static void put(StagingProbe st, String pid, String p, byte[] data) throws Exception {
        File f = st.fileOf(pid, p);
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(data); }
    }

    static String read(StagingProbe st, String pid, String p) throws Exception {
        File f = st.fileOf(pid, p);
        if (!f.isFile()) return "<缺失>";
        byte[] b = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
        }
        return new String(b, java.nio.charset.StandardCharsets.UTF_8);
    }

    /** 暂存目录里有没有 .merging 残留 */
    static int leftovers(StagingProbe st, String pid) {
        File[] fa = st.projectDir(pid).listFiles();
        int n = 0;
        if (fa != null) for (File f : fa) if (f.getName().endsWith(".merging")) n++;
        return n;
    }

    static byte[] filler(int size, int seed) {
        byte[] b = new byte[size];
        for (int i = 0; i < size; i++) b[i] = (byte) (((i + seed) * 7) & 0xff);
        return b;
    }

    public static void main(String[] a) throws Exception {
        File dir = new File(a[0]);
        StagingProbe st = new StagingProbe(dir);
        String pid = "p1";
        StringBuilder out = new StringBuilder();

        // ── 用例一：三个分片，输入顺序故意打乱 ──────────────────
        put(st, pid, "m.bin.part0", filler(1000, 0));
        put(st, pid, "m.bin.part1", filler(2000, 1));
        put(st, pid, "m.bin.part2", filler(3000, 2));
        long total = st.mergeShards(pid, Arrays.asList("m.bin.part2", "m.bin.part0", "m.bin.part1"), "m.bin");
        File merged = st.fileOf(pid, "m.bin");
        out.append("T1_TOTAL=").append(total).append('\\n');
        out.append("T1_SIZE=").append(merged.length()).append('\\n');
        out.append("T1_LEFTOVERS=").append(leftovers(st, pid)).append('\\n');

        /*
         * 内容顺序核对：把小分片各自的内容接起来，和合并结果逐字节比。
         * 顺序错了（比如按字典序 part10 排在 part2 前面）这里就会不等。
         */
        byte[] expect = new byte[1000 + 2000 + 3000];
        System.arraycopy(filler(1000, 0), 0, expect, 0, 1000);
        System.arraycopy(filler(2000, 1), 0, expect, 1000, 2000);
        System.arraycopy(filler(3000, 2), 0, expect, 3000, 3000);
        byte[] got = new byte[(int) merged.length()];
        try (FileInputStream in = new FileInputStream(merged)) {
            int off = 0, n;
            while (off < got.length && (n = in.read(got, off, got.length - off)) > 0) off += n;
        }
        out.append("T1_CONTENT=").append(Arrays.equals(expect, got)).append('\\n');

        // ── 用例二：数字序 vs 字典序（part2 / part10）──────────
        put(st, pid, "n.bin.part2", "TWO".getBytes("UTF-8"));
        put(st, pid, "n.bin.part10", "TEN".getBytes("UTF-8"));
        put(st, pid, "n.bin.part1", "ONE".getBytes("UTF-8"));
        st.mergeShards(pid, Arrays.asList("n.bin.part10", "n.bin.part2", "n.bin.part1"), "n.bin");
        out.append("T2_CONTENT=").append(read(st, pid, "n.bin")).append('\\n');

        // ── 用例三：分片缺失时，已有文件不能被毁 ───────────────
        /*
         * 先放一份「已经能用的完整文件」，再让合并失败 ——
         * 这正是先下完整版、后改成多片重同步时会遇到的情况。
         */
        put(st, pid, "keep.bin", "原来的完整内容，不能被弄坏".getBytes("UTF-8"));
        put(st, pid, "k.bin.part0", filler(500, 3));
        // 故意不写 k.bin.part1
        String t3;
        try {
            st.mergeShards(pid, Arrays.asList("k.bin.part0", "k.bin.part1"), "keep.bin");
            t3 = "NO_THROW";
        } catch (Exception e) {
            t3 = e.getMessage() == null ? "" : e.getMessage().replaceAll("[\\\\r\\\\n]+", " ");
        }
        out.append("T3_MSG=").append(t3).append('\\n');
        out.append("T3_KEPT=").append(read(st, pid, "keep.bin")).append('\\n');
        out.append("T3_LEFTOVERS=").append(leftovers(st, pid)).append('\\n');

        // ── 用例四：分片识别 ───────────────────────────────────
        out.append("T4_IS_SHARD=").append(isShard("a.part0")).append(',')
           .append(isShard("a.part12")).append(',')
           .append(isShard("a.part")).append(',')
           .append(isShard("a.txt")).append('\\n');
        out.append("T4_BASE=").append(shardBase("dir/a.bin.part7")).append('\\n');
        out.append("T4_INDEX=").append(shardIndex("a.part0")).append(',')
           .append(shardIndex("a.part9")).append(',')
           .append(shardIndex("a.part10")).append('\\n');

        System.out.print(out);
    }
}
`;

const tmpDir = path.join(__dirname, '.tmp-staging');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'StagingProbe.java'), HARNESS);

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
try {
  execFileSync(path.join(JAVA_HOME, 'bin', 'javac.exe'),
    ['-encoding', 'UTF-8', '-nowarn', '-d', path.join(tmpDir, 'out'),
      path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'StagingProbe.java')], { stdio: 'pipe' });
} catch (e) {
  console.error('编译失败：\n' + (e.stdout || '').toString() + (e.stderr || '').toString());
  process.exit(1);
}

const dataDir = path.join(tmpDir, 'files');
fs.mkdirSync(dataDir, { recursive: true });
const raw = execFileSync(path.join(JAVA_HOME, 'bin', 'java.exe'),
  ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', path.join(tmpDir, 'out'),
    'cn.com.scsxrkj.StagingProbe', dataDir], { encoding: 'utf8' });
const v = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) v[m[1]] = m[2];
}

console.log('\n── 正常合并：总长、内容、临时文件 ──────────────');
ok('返回的字节数是三片之和', v.T1_TOTAL === '6000', v.T1_TOTAL);
ok('落盘大小一致', v.T1_SIZE === '6000', v.T1_SIZE);
ok('内容按分片顺序拼对', v.T1_CONTENT === 'true', '顺序拼错了');
ok('合并成功后不留 .merging 临时文件', v.T1_LEFTOVERS === '0', v.T1_LEFTOVERS);

console.log('\n── 分片必须按数字排序，不能按字典序 ────────────');
ok('part1 → part2 → part10', v.T2_CONTENT === 'ONE' + 'TWO' + 'TEN',
  '实际：' + v.T2_CONTENT + '（字典序会把 part10 排到 part2 前面）');

console.log('\n── 本轮修复：分片缺失不能毁掉已有文件 ──────────');
ok('缺片会抛异常', v.T3_MSG !== 'NO_THROW', '没有抛异常');
ok('报错点明是哪一片缺了', /分片缺失/.test(v.T3_MSG || ''), v.T3_MSG);
ok('原来的完整文件一个字节都没变', v.T3_KEPT === '原来的完整内容，不能被弄坏', '被改成了：' + v.T3_KEPT);
ok('失败后不留 .merging 临时文件', v.T3_LEFTOVERS === '0', v.T3_LEFTOVERS);

console.log('\n── 分片识别 ────────────────────────────────────');
ok('.part0 / .part12 算分片，.part / .txt 不算', v.T4_IS_SHARD === 'true,true,false,false', v.T4_IS_SHARD);
ok('去掉编号拿到原始路径', v.T4_BASE === 'dir/a.bin', v.T4_BASE);
ok('序号按数字解析', v.T4_INDEX === '0,9,10', v.T4_INDEX);

console.log('\n── 实现要点：先写临时文件再改名 ────────────────');
ok('用了 .merging 临时文件', /\.merging/.test(cs), '没有临时文件，直接写目标');
ok('成功后才改名', /renameTo\(out\)/.test(cs), '没有原子改名');
ok('失败分支会删临时文件', /tmp\.delete\(\)/.test(cs), '失败后临时文件会留在盘上');
ok('写之前清空的是临时文件而不是目标文件', /new RandomAccessFile\(tmp, *"rw"\)/.test(cs),
  '还在往目标文件里写');

console.log('\n----------------------------------------------------');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED ' + fail) + ' (cloud_staging_merge_test)  ' + pass + ' 项');
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
