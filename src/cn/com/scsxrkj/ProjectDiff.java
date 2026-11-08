package cn.com.scsxrkj;

import org.json.*;

import java.util.*;

/**
 * 项目变更视图和文件对比的计算核心。
 *
 * <p>要解决的问题：项目从云端同步下来、或者从 ZIP 导入进来之后，
 * 用户完全不知道「这次到底动了哪些文件」。只能一个个点开看，
 * 几百个文件根本看不过来。
 *
 * <p>数据从哪来：项目对象里的 {@code snapshots} 字段。每做一次同步、导入
 * 或者 AI 改代码，系统会把改之前的那份文件内容存成一个快照
 * （见 {@link CloudFiles#snapshot(JSONObject)} 和 {@link ProjectEdits#apply}）。
 * 于是「变更」就是当前文件跟最近一个快照比出来的差集。
 *
 * <p>对比分两个层次：
 * <ul>
 *   <li><b>文件级</b>（{@link #against}）：哪些文件新增了、删掉了、内容变了。
 *       比的是哈希，不读内容，几百个文件也是毫秒级。</li>
 *   <li><b>行级</b>（{@link #lines}）：某一个文件具体哪几行变了。
 *       这一层才需要把两份内容摊开做逐行比较。</li>
 * </ul>
 */
final class ProjectDiff {

    /**
     * 行级对比的规模上限（两边行数相乘）。
     *
     * <p>逐行 diff 用动态规划，内存是行数乘积的量级。
     * 3000 行的文件乘出来就是 900 万格，几十 MB 内存，
     * 在手机上足以让应用被系统杀掉。
     *
     * <p>超过这个上限就走{@link #roughLines 粗略模式}：
     * 结果仍然正确（该标红的还是标红），只是不会把相邻的改动拆得那么细。
     */
    private static final long DIFF_CELL_LIMIT = 1500000L;

    /**
     * 单个文件参与行级对比的最大字符数。
     *
     * <p>再大的文件（比如几 MB 的打包产物）本身就不适合在手机上逐行看，
     * 而且前端渲染几千行也会卡。超过就只告诉用户「整个文件都变了」。
     */
    private static final int DIFF_CHAR_LIMIT = 400000;

    private ProjectDiff() {
    }

    /**
     * 把当前项目和它的某个快照做文件级对比。
     *
     * @param p         项目对象
     * @param snapIndex 用第几个快照做基准；-1 表示最近一个
     * @return 对比结果。没有快照时 {@code hasSnapshot} 为 false
     */
    static JSONObject against(JSONObject p, int snapIndex) throws Exception {
        JSONObject out = new JSONObject();
        JSONArray snaps = p.optJSONArray("snapshots");

        // 没有快照就没得比 —— 前端会提示「还没有对比基准」，
        // 并引导用户去建一个。
        if (snaps == null || snaps.length() == 0) {
            out.put("hasSnapshot", false);
            out.put("added", new JSONArray());
            out.put("removed", new JSONArray());
            out.put("changed", new JSONArray());
            out.put("stats", new JSONObject().put("added", 0).put("removed", 0).put("changed", 0).put("same", 0));
            return out;
        }

        int idx = snapIndex < 0 ? snaps.length() - 1 : Math.max(0, Math.min(snapIndex, snaps.length() - 1));
        JSONObject snap = snaps.getJSONObject(idx);
        JSONObject snapFiles = snap.optJSONObject("files");
        if (snapFiles == null) snapFiles = new JSONObject();

        // 当前文本文件：直接从 p.files 取内容算哈希。
        JSONObject nowFiles = p.optJSONObject("files");
        if (nowFiles == null) nowFiles = new JSONObject();

        /*
         * 存档有两种形态：
         * · 全量 —— 里面就是当时的全部文件；
         * · 差量 —— 里面只有那次改动过的文件的旧内容。
         *
         * 差量要先「叠回」当前文件表，才得到改动前的完整样子：
         * 叠回去 = 用存档里的旧内容覆盖同名文件，其余保持当前值。
         */
        JSONObject oldFiles;
        if (snap.optBoolean("delta", false)) {
            /*
             * 差量：叠回当前文件表，得到「改动前」的样子。
             *
             * <p>值为 NULL 的条目表示「存档时刻这个文件还不存在」——
             * 叠回时应当**不存在**，而不是空字符串。
             * 用空字符串会把它算成「内容变了」，实际应该是「新增了」。
             */
            oldFiles = new JSONObject(nowFiles.toString());
            for (Iterator<String> it = snapFiles.keys(); it.hasNext(); ) {
                String n = it.next();
                if (snapFiles.isNull(n)) oldFiles.remove(n);
                else oldFiles.put(n, snapFiles.optString(n, ""));
            }
            // added 名单：存档时刻之后新建的文件，同样算「改动前不存在」
            JSONArray added = snap.optJSONArray("added");
            if (added != null) {
                for (int i = 0; i < added.length(); i++) oldFiles.remove(added.getString(i));
            }
        } else {
            oldFiles = snapFiles;
        }

        JSONArray added = new JSONArray(), removed = new JSONArray(), changed = new JSONArray();
        int same = 0;

        // 新增或改动
        for (Iterator<String> it = nowFiles.keys(); it.hasNext(); ) {
            String n = it.next();
            if (!oldFiles.has(n)) {
                added.put(n);
                continue;
            }
            String a = oldFiles.optString(n, "");
            String b = nowFiles.optString(n, "");
            if (a.equals(b)) same++;
            else changed.put(n);
        }

        // 删除
        for (Iterator<String> it = oldFiles.keys(); it.hasNext(); ) {
            String n = it.next();
            if (!nowFiles.has(n)) removed.put(n);
        }

        // 新增的二进制文件也单独提一下 —— 它们不在 files 里，
        // 但同步/导入时加进来的图片、模型属于「这次变了什么」的一部分。
        JSONObject bins = p.optJSONObject("binaryFiles");
        JSONObject oldBins = snap.optJSONObject("binaryFiles");
        JSONArray addedBin = new JSONArray();
        if (bins != null) {
            for (Iterator<String> it = bins.keys(); it.hasNext(); ) {
                String n = it.next();
                if (oldBins == null || !oldBins.has(n)) addedBin.put(n);
            }
        }

        sortStrings(added);
        sortStrings(removed);
        sortStrings(changed);
        sortStrings(addedBin);

        out.put("hasSnapshot", true);
        out.put("snapshotTime", snap.optLong("time", 0));
        out.put("snapshotIndex", idx);
        out.put("snapshotCount", snaps.length());
        out.put("added", added);
        out.put("removed", removed);
        out.put("changed", changed);
        out.put("addedBinary", addedBin);
        out.put("stats", new JSONObject()
                .put("added", added.length())
                .put("removed", removed.length())
                .put("changed", changed.length())
                .put("binary", addedBin.length())
                .put("same", same));
        return out;
    }

    /**
     * 把一个文件和它在最近快照里的旧版本做行级对比。
     *
     * @param p    项目对象
     * @param path 文件路径
     * @return {@code {path, exists, oldExists, tooBig, outOfDate, lines:[...], stats:{...}}}
     *         lines 里每项是 {@code {t, n, text}}，t 取值 {@code +} 新增 / {@code -} 删除 / {@code ' '} 未变
     */
    static JSONObject fileDiff(JSONObject p, String path) throws Exception {
        JSONObject out = new JSONObject().put("path", path);
        JSONObject nowFiles = p.optJSONObject("files");
        String now = nowFiles == null ? null : nowFiles.optString(path, null);
        String old = null;

        JSONArray snaps = p.optJSONArray("snapshots");
        if (snaps != null && snaps.length() > 0) {
            JSONObject oldFiles = snaps.getJSONObject(snaps.length() - 1).optJSONObject("files");
            if (oldFiles != null) old = oldFiles.optString(path, null);
        }

        out.put("exists", now != null);
        out.put("oldExists", old != null);

        // 两边都没有这个文件，没什么可比
        if (now == null && old == null) {
            out.put("lines", new JSONArray());
            out.put("stats", new JSONObject().put("add", 0).put("del", 0).put("same", 0));
            return out;
        }
        if (old == null) old = "";
        if (now == null) now = "";

        // 新文件或旧文件太大：不逐行拆，直接整体标出
        if (old.length() > DIFF_CHAR_LIMIT || now.length() > DIFF_CHAR_LIMIT) {
            out.put("tooBig", true);
            out.put("lines", new JSONArray());
            out.put("stats", new JSONObject()
                    .put("add", countLines(now))
                    .put("del", countLines(old))
                    .put("same", 0));
            return out;
        }

        out.put("tooBig", false);
        JSONArray lines = lines(old, now);
        out.put("lines", lines);

        int add = 0, del = 0, sameN = 0;
        for (int i = 0; i < lines.length(); i++) {
            String t = lines.getJSONObject(i).getString("t");
            if (t.equals("+")) add++;
            else if (t.equals("-")) del++;
            else sameN++;
        }
        out.put("stats", new JSONObject().put("add", add).put("del", del).put("same", sameN));
        return out;
    }

    /**
     * 对两段文本做逐行比较，返回带行号的变更列表。
     *
     * <p>算法是经典的最长公共子序列：先把相同的行找出来当锚点，
     * 两个锚点之间夹着的就是删掉的行和新增的行。
     * 这样能保住行号，用户看得出「第 42 行改了」。
     *
     * <p>行号用 {@code n} 表示：新增行给新文件里的行号，
     * 删除行给旧文件里的行号，未变的行两个文件里行号相同。
     *
     * @param oldText 旧内容
     * @param newText 新内容
     * @return {@code [{t,n,text}]}
     */
    static JSONArray lines(String oldText, String newText) throws Exception {
        String[] a = splitLines(oldText);
        String[] b = splitLines(newText);

        // 超大文件退化成粗略结果，避免把内存打爆
        if ((long) a.length * b.length > DIFF_CELL_LIMIT) return roughLines(a, b);

        int n = a.length, m = b.length;
        // lcs[i][j] = a[i..] 和 b[j..] 的最长公共子序列长度
        int[][] lcs = new int[n + 1][m + 1];
        for (int i = n - 1; i >= 0; i--) {
            for (int j = m - 1; j >= 0; j--) {
                if (a[i].equals(b[j])) lcs[i][j] = lcs[i + 1][j + 1] + 1;
                else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }

        JSONArray out = new JSONArray();
        int i = 0, j = 0;
        while (i < n && j < m) {
            if (a[i].equals(b[j])) {
                out.put(new JSONObject().put("t", " ").put("n", j + 1).put("text", b[j]));
                i++;
                j++;
            } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
                out.put(new JSONObject().put("t", "-").put("n", i + 1).put("text", a[i]));
                i++;
            } else {
                out.put(new JSONObject().put("t", "+").put("n", j + 1).put("text", b[j]));
                j++;
            }
        }
        while (i < n) {
            out.put(new JSONObject().put("t", "-").put("n", i + 1).put("text", a[i]));
            i++;
        }
        while (j < m) {
            out.put(new JSONObject().put("t", "+").put("n", j + 1).put("text", b[j]));
            j++;
        }
        return out;
    }

    /**
     * 超大文件的降级对比：剥掉首尾相同的行，中间整段当成重写。
     *
     * <p>结果不如 LCS 精细（中间可能有些行其实没变），
     * 但至少能让用户知道「从第几行到第几行被动了」，不会一片红。
     */
    private static JSONArray roughLines(String[] a, String[] b) throws Exception {
        JSONArray out = new JSONArray();
        int head = 0;
        while (head < a.length && head < b.length && a[head].equals(b[head])) {
            out.put(new JSONObject().put("t", " ").put("n", head + 1).put("text", b[head]));
            head++;
        }
        int tail = 0;
        while (tail < a.length - head && tail < b.length - head
                && a[a.length - 1 - tail].equals(b[b.length - 1 - tail])) {
            tail++;
        }
        for (int i = head; i < a.length - tail; i++) {
            out.put(new JSONObject().put("t", "-").put("n", i + 1).put("text", a[i]));
        }
        for (int j = head; j < b.length - tail; j++) {
            out.put(new JSONObject().put("t", "+").put("n", j + 1).put("text", b[j]));
        }
        for (int i = a.length - tail; i < a.length; i++) {
            out.put(new JSONObject().put("t", " ").put("n", i + 1).put("text", a[i]));
        }
        return out;
    }

    /** 按换行切分，保留空行（末尾的换行不算多一行）。 */
    private static String[] splitLines(String s) {
        if (s == null || s.isEmpty()) return new String[0];
        // 统一换行符，避免 CRLF 文件每行都被判成改动
        String norm = s.replace("\r\n", "\n").replace("\r", "\n");
        return norm.split("\n", -1);
    }

    /** 数一下有多少行，给「文件太大不拆」的情况用。 */
    private static int countLines(String s) {
        return splitLines(s).length;
    }

    /** JSONArray 没有排序方法，转成 List 排完再放回去。 */
    private static void sortStrings(JSONArray arr) throws Exception {
        List<String> list = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) list.add(arr.getString(i));
        Collections.sort(list);
        while (arr.length() > 0) arr.remove(0);
        for (String s : list) arr.put(s);
    }
}
