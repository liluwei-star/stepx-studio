package cn.com.scsxrkj;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.util.Locale;

import android.util.Base64;

/**
 * 云端同步的大文件暂存区。
 *
 * <h3>为什么需要它</h3>
 * <p>云端同步的结果是通过 {@code evaluateJavascript} 的返回值传回原生的 ——
 * 那是一条 JSON 字符串管道。小文件（几 KB 的源码）走这条路没问题，
 * 但一个 83 MB 的语音识别模型会被 base64 编码成 110 MB 的字符串，
 * 再序列化成 JSON、再反序列化回 Java。全套下来内存峰值超过 300 MB，
 * 手机必然 OOM 崩溃。
 *
 * <p>所以改成：<b>大文件不进 JSON，直接落盘。</b>
 * <ul>
 *   <li>JS 侧把大文件分块（1 MB/块）传给原生，原生追加写到暂存目录</li>
 *   <li>JS 侧只回传文件清单和哈希，不回传内容</li>
 *   <li>Java 侧直接从暂存目录读文件，校验哈希后合并进项目</li>
 * </ul>
 *
 * <h3>暂存目录</h3>
 * <p>{@code filesDir/cloud-staging/<项目id>/<路径哈希>}。
 * 用路径哈希做文件名，避免路径里的斜杠和中文带来的问题，也顺带避免了
 * 路径穿越（路径在写入前已经校验过，这里再做一次哈希是双保险）。
 *
 * <h3>生命周期</h3>
 * <p>暂存区在每次同步开始时清空（{@link #clear}），同步结束后把用到的文件
 * 复制到项目的 binaryFiles 里。因为项目文件本身存在 workspace.json 里，
 * 大文件必须以独立文件形式存储 —— 详见 {@link CloudFiles}。
 */
final class CloudStaging {

    /** 单个分块的最大字节数。1 MB 是个平衡点：够快，又不会让内存峰值失控。 */
    static final int CHUNK = 1024 * 1024;

    /** 暂存区根目录。 */
    private final File root;

    CloudStaging(File filesDir) {
        root = new File(filesDir, "cloud-staging");
        if (!root.isDirectory() && !root.mkdirs()) throw new RuntimeException("无法创建云端暂存目录");
    }

    /**
     * 把路径映射成一个安全的文件名。
     *
     * <p>用 SHA-256 而不是直接用路径，是因为路径里可能有斜杠、中文、
     * 超长路径等问题。哈希后定长、安全、无冲突风险。
     *
     * @param path 项目内的相对路径
     * @return 暂存文件名
     */
    static String fileName(String path) throws Exception {
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        byte[] b = d.digest(path.getBytes("UTF-8"));
        StringBuilder s = new StringBuilder();
        for (byte v : b) s.append(String.format(Locale.ROOT, "%02x", v & 255));
        return s.substring(0, 32);
    }

    /** 某个项目在暂存区里的目录。 */
    File projectDir(String projectId) {
        File d = new File(root, projectId.replaceAll("[^A-Za-z0-9_-]", "_"));
        if (!d.isDirectory() && !d.mkdirs()) throw new RuntimeException("无法创建暂存子目录");
        return d;
    }

    /** 某个文件在暂存区里的完整路径。 */
    File fileOf(String projectId, String path) throws Exception {
        return new File(projectDir(projectId), fileName(path));
    }

    /**
     * 开始写一个新文件：清空同名旧文件，返回它以追加模式打开的句柄。
     *
     * @param projectId 云端项目 id
     * @param path      项目内的相对路径
     * @return 供 {@link #append} 使用的写入器
     */
    Writer begin(String projectId, String path) throws Exception {
        File f = fileOf(projectId, path);
        // 覆盖写：先清掉上一轮可能留下的残留
        try (FileOutputStream out = new FileOutputStream(f, false)) {
            out.flush();
        }
        return new Writer(f);
    }


    /**
     * 判断一个路径是不是「分片文件」。
     *
     * <p>云端会把大文件切成 {@code xxx.part0} / {@code xxx.part1} / ...
     * 这样的分片。本地要按顺序拼回 {@code xxx} 才能用。
     *
     * @param path 路径
     * @return 是分片返回 true
     */
    static boolean isShard(String path) {
        return path != null && path.matches(".*\\.part\\d+$");
    }

    /**
     * 取分片文件去掉 {@code .partN} 后的原始路径。
     *
     * @param path 分片路径
     */
    static String shardBase(String path) {
        return path.replaceFirst("\\.part\\d+$", "");
    }

    /**
     * 取分片的序号。{@code a.part0} → 0，{@code a.part12} → 12。
     *
     * <p>序号按数字比大小，不按字符串字典序 ——
     * 否则 part10 会排在 part2 前面，合并出来的文件就是坏的。
     *
     * @param path 分片路径
     */
    static int shardIndex(String path) {
        int i = path.lastIndexOf(".part");
        return Integer.parseInt(path.substring(i + 5));
    }

    /**
     * 把一组分片按序号顺序拼接成一个文件。
     *
     * <p>用 {@link RandomAccessFile} 逐个追加，不把整个结果读进内存。
     *
     * @param projectId 云端项目 id
     * @param shards    分片路径列表（顺序不限，内部会排序）
     * @param basePath  合并后的目标路径
     * @return 合并后的字节数
     */
    long mergeShards(String projectId, java.util.List<String> shards, String basePath) throws Exception {
        // 按序号排序
        java.util.List<String> sorted = new java.util.ArrayList<>(shards);
        java.util.Collections.sort(sorted, (a, b) -> Integer.compare(shardIndex(a), shardIndex(b)));

        File out = fileOf(projectId, basePath);
        long total = 0;
        try (RandomAccessFile raf = new RandomAccessFile(out, "rw")) {
            raf.setLength(0);
            for (String s : sorted) {
                File part = fileOf(projectId, s);
                if (!part.isFile()) throw new Exception("分片缺失：" + s);
                try (java.io.FileInputStream in = new java.io.FileInputStream(part)) {
                    byte[] buf = new byte[CHUNK];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        raf.write(buf, 0, n);
                        total += n;
                    }
                }
            }
        }
        return total;
    }

    /**
     * 一个正在写入的文件。
     *
     * <p>用 {@link RandomAccessFile} 而不是 {@link FileOutputStream}，
     * 是为了能在不重写整个文件的情况下往指定位置追加分块。
     */
    final class Writer implements AutoCloseable {
        private final File file;
        private final RandomAccessFile raf;
        private long written;

        Writer(File f) throws IOException {
            file = f;
            raf = new RandomAccessFile(f, "rw");
            raf.setLength(0);
            written = 0;
        }

        /**
         * 追加一个分块。
         *
         * @param b64 base64 编码的字节
         * @return 累计写入的字节数
         */
        long append(String b64) throws Exception {
            byte[] b = Base64.decode(b64, Base64.NO_WRAP);
            raf.seek(written);
            raf.write(b);
            written += b.length;
            return written;
        }

        /** 已写入的字节数。 */
        long size() {
            return written;
        }

        @Override
        public void close() throws IOException {
            raf.close();
        }
    }

    /**
     * 读回暂存区里的一个文件。
     *
     * @param projectId 云端项目 id
     * @param path      项目内的相对路径
     * @return 文件内容
     */
    byte[] read(String projectId, String path) throws Exception {
        File f = fileOf(projectId, path);
        if (!f.isFile()) throw new IOException("暂存文件不存在：" + path);
        long len = f.length();
        // 防御：单个文件超过 200 MB 就不读了，防止把内存撑爆
        if (len > 200L * 1024 * 1024) throw new IOException("暂存文件过大：" + path);
        byte[] out = new byte[(int) len];
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            r.readFully(out);
        }
        return out;
    }

    /** 暂存文件的大小；不存在返回 -1。 */
    long size(String projectId, String path) throws Exception {
        File f = fileOf(projectId, path);
        return f.isFile() ? f.length() : -1L;
    }

    /**
     * 校验暂存文件的 SHA-256。
     *
     * @param projectId 云端项目 id
     * @param path      项目内的相对路径
     * @param expect    期望的哈希（小写十六进制）
     * @return true 表示一致
     */
    boolean verify(String projectId, String path, String expect) throws Exception {
        File f = fileOf(projectId, path);
        if (!f.isFile()) return false;
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[1024 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) d.update(buf, 0, n);
        }
        StringBuilder s = new StringBuilder();
        for (byte v : d.digest()) s.append(String.format(Locale.ROOT, "%02x", v & 255));
        return s.toString().equalsIgnoreCase(expect);
    }

    /**
     * 算暂存文件的 SHA-256。
     *
     * <p>大文件的内容只在原生手里，JS 侧拿不到也没必要拿 ——
     * 哈希在这里算完，只回传一个 64 字符的字符串。
     *
     * @param projectId 云端项目 id
     * @param path      项目内的相对路径
     * @return 小写十六进制哈希；文件不存在返回空串
     */
    String hashOf(String projectId, String path) throws Exception {
        File f = fileOf(projectId, path);
        if (!f.isFile()) return "";
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[1024 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) d.update(buf, 0, n);
        }
        StringBuilder s = new StringBuilder();
        for (byte v : d.digest()) s.append(String.format(Locale.ROOT, "%02x", v & 255));
        return s.toString();
    }

    /** 删除某个项目的整个暂存目录。 */
    void clear(String projectId) {
        File d = new File(root, projectId.replaceAll("[^A-Za-z0-9_-]", "_"));
        deleteTree(d);
    }

    /** 清空整个暂存区。 */
    void clearAll() {
        deleteTree(root);
        if (!root.isDirectory() && !root.mkdirs()) throw new RuntimeException("无法重建暂存目录");
    }

    /** 递归删除一个目录。 */
    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
