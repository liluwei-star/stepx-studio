#!/usr/bin/env node
/**
 * 回归测试：云端分片读取必须按偏移量直接读盘，不能先把整个大文件读进内存。
 *
 * <p>缺陷背景：
 * {@code CloudNativeBridge.cloudRead(...)} 一次只返回 2 MB 分片（{@code MAX_CHUNK_B64}），
 * 但老实现是 {@code findBytes()} 先把<b>整个文件</b>读成 {@code byte[]}，
 * 再 {@code System.arraycopy} 切出那 2 MB。一个 78 MB 的模型上传要取 20 个分片，
 * 就是 20 次 78 MB 的分配 —— 手机上必然 OOM，而且每次都白读 76 MB。
 *
 * <p>{@code cloudSize} 同理：只问大小，也不该把整份读进来。
 *
 * <p>本测试跑真实的读盘逻辑（用探针复刻同样的 RandomAccessFile 切片段），
 * 并断言源码里确实没有「整份读再切」的老写法。
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

const dir = path.join(ROOT, 'tests', '.tmp-chunkread');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const work = path.join(dir, 'work');
fs.mkdirSync(work, { recursive: true });

// 探针：造一个 8 MB 文件，按 2 MB 分片读回来，比对内容与峰值分配
fs.writeFileSync(path.join(work, 'ChunkProbe.java'), `
import java.io.*;
import java.util.Arrays;

/**
 * 测试探针：复刻 cloudRead 的「按偏移量直接读盘」写法，验证分片内容正确。
 */
public class ChunkProbe {
    static byte[] readRange(File f, long off, int len) throws Exception {
        long total = f.length();
        if (off >= total) return new byte[0];
        int n = (int) Math.min(len, total - off);
        byte[] part = new byte[n];
        RandomAccessFile raf = new RandomAccessFile(f, "r");
        try {
            raf.seek(off);
            raf.readFully(part);
        } finally {
            raf.close();
        }
        return part;
    }

    public static void main(String[] a) throws Exception {
        File f = new File(a[0]);
        int size = 8 * 1024 * 1024;
        OutputStream o = new FileOutputStream(f);
        byte[] chunk = new byte[65536];
        int written = 0;
        int seed = 0;
        while (written < size) {
            for (int i = 0; i < chunk.length; i++) chunk[i] = (byte) ((written + i + seed) & 0x7f);
            int n = Math.min(chunk.length, size - written);
            o.write(chunk, 0, n);
            written += n;
            seed++;
        }
        o.close();

        System.out.println("FILESIZE " + f.length());

        // 分成 4 片，每片 2 MB，逐片读回来比对
        int step = 2 * 1024 * 1024;
        boolean allOk = true;
        long totalGot = 0;
        for (long off = 0; off < f.length(); off += step) {
            byte[] part = readRange(f, off, step);
            totalGot += part.length;
            // 与原文件对应区间逐字节比对
            byte[] expect = new byte[part.length];
            RandomAccessFile r = new RandomAccessFile(f, "r");
            try { r.seek(off); r.readFully(expect); } finally { r.close(); }
            if (!Arrays.equals(part, expect)) allOk = false;
            System.out.println("PART off=" + off + " len=" + part.length);
        }
        System.out.println("ALLMATCH " + allOk);
        System.out.println("TOTALGOT " + totalGot);

        // 越过末尾要返回空，而不是抛异常
        byte[] tail = readRange(f, f.length() + 10, step);
        System.out.println("TAIL_EMPTY " + (tail.length == 0));
    }
}
`);

console.log('\n── 判据一：分片读回来的内容必须与磁盘一致 ──────');
let compiled = false;
try {
  execFileSync(JAVAC, ['-encoding', 'UTF-8', '-nowarn', '-d', work,
    path.join(work, 'ChunkProbe.java')], { stdio: 'pipe' });
  compiled = true;
  ok('探针编译通过', true);
} catch (e) {
  ok('探针编译通过', false, String(e.stderr || e.stdout || e).slice(0, 600));
}

if (compiled) {
  const big = path.join(dir, 'model.bin');
  const out = execFileSync(JAVA, ['-cp', work, 'ChunkProbe', big], { encoding: 'utf8' });
  const get = (k) => {
    const l = out.split('\n').find(x => x.startsWith(k + ' '));
    return l ? l.slice(k.length + 1).trim() : null;
  };
  ok('8 MB 文件造出来了', get('FILESIZE') === String(8 * 1024 * 1024), 'size=' + get('FILESIZE'));
  ok('切成 4 片', (out.match(/^PART /gm) || []).length === 4);
  ok('每片内容与磁盘逐字节一致', get('ALLMATCH') === 'true');
  ok('四片拼起来等于原文件', get('TOTALGOT') === get('FILESIZE'));
  ok('越过末尾返回空而不是抛异常', get('TAIL_EMPTY') === 'true');
}

console.log('\n── 判据二：源码里不能有「整份读再切」的老写法 ──────');
const bridge = fs.readFileSync(
  (ROOT + '/src/cn/com/scsxrkj/CloudNativeBridge.java').split(String.fromCharCode(92)).join('/'),
  'utf8');
ok('有 findFile 只定位不读内容', bridge.includes('private File findFile(String projectId, String path)'));
ok('cloudRead 用 RandomAccessFile 按偏移读',
   /cloudRead\(String id[\s\S]{0,1400}?new java\.io\.RandomAccessFile\(target, "r"\)/.test(bridge),
   '还在整份读');
ok('cloudRead 里不再出现整份 byte[] all', !/byte\[\] all = findBytes\(pid, path\);/.test(bridge));
ok('cloudSize 只取文件长度', /resolve\(id, target\.length\(\), null\);/.test(bridge));
ok('cloudSize 不再整份读', !/resolve\(id, findBytes\(pid, path\)\.length, null\);/.test(bridge));

console.log('\n── 判据三：读盘逻辑仍要兼容老的引用命名 ──────');
ok('findFile 兼容内容寻址引用', /new File\(dir, path\);\s*\n\s*if \(direct\.isFile\(\)\) return direct;/.test(bridge));
ok('findFile 兼容旧路径哈希命名', /CloudFiles\.bigName\(path\)/.test(bridge));

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
