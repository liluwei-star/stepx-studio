package cn.com.scsxrkj;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 出包前的清洗器：把平台专有痕迹和构建工具专有语法清干净。
 *
 * <p><b>为什么需要这一步</b>
 *
 * <p>从云端 Studio 同步下来的项目，带着一堆「只能在平台上跑」的东西：
 * 平台签名证书、平台后端配置、平台虚拟模块、Vite 专属语法。
 * 直接编译出来的 APK 会有三个问题：
 *
 * <ol>
 *   <li><b>上架被拒</b> —— 包里还留着别家的证书、配置、标识符，
 *       审核一眼就能看出不是你自己开发的</li>
 *   <li><b>功能缺失</b> —— {@code virtual:help-guide} 这种平台虚拟模块
 *       在本机编译器里根本解析不了，编译直接失败</li>
 *   <li><b>联网依赖</b> —— {@code .env.local} 里的后端地址是平台的，
 *       应用装上后连的是别人的服务器</li>
 * </ol>
 *
 * <p><b>清洗分三类</b>
 *
 * <ul>
 *   <li><b>删除</b> —— 整个文件或目录不要了（平台配置、平台文档、证书）</li>
 *   <li><b>改写</b> —— 文件留着但内容要改（替换平台标识、去掉虚拟模块引用）</li>
 *   <li><b>报告</b> —— 改了哪些、为什么改，全部列出来给用户看</li>
 * </ul>
 *
 * <p><b>设计原则</b>
 *
 * <p>清洗<b>不静默</b>。每一处改动都记进报告，用户在出包前能看到全部改动，
 * 也能选择跳过某些项。这条比清洗本身更重要 —— 静默清洗出包，
 * 用户根本不知道自己的项目被改成了什么样。
 */
final class ProjectCleaner {

    /**
     * 一条清洗记录。
     */
    static final class Item {
        final String kind;      // delete / rewrite / report
        final String path;      // 涉及的文件
        final String reason;    // 为什么
        String detail = "";     // 具体做了什么
        /** 删掉之后 PC 上构建会受什么影响；不受影响为 null。 */
        String pcImpact = null;

        Item(String kind, String path, String reason) {
            this.kind = kind;
            this.path = path;
            this.reason = reason;
        }
    }

    /**
     * 平台专有的文件与目录。
     *
     * <p>这些是「离开平台就没意义」的东西：平台签名证书、平台后端连接、
     * 平台构建脚本、平台文档、平台标记文件。
     */
    private static final String[] DROP_PATHS = {
            // 平台签名目录：放过 capsule.p12 和口令文件。
            // 留着等于用别家的证书签名，上架会被查出来。
            //
            // 注意只删这个子目录，不能删整个 capsule/ ——
            // capsule/manifest.json 还被 src/shared/bridge/mock.ts 直接 import 着，
            // 删了整个目录，mock 那一行就找不到文件，构建当场失败。
            "capsule/signing/",
            // 平台后端连接信息：Supabase 地址、anon key、项目 ID。
            // 留着的话应用会连到平台的后端，你的用户数据会跑到别人那里。
            ".env.local",
            ".env.production",
            // 平台能力声明：声明了 admin/supabase/payment 开关和支付连接器。
            // 你的应用没用这些，留着是误导。
            "capability.json",
            // 平台类型标记
            ".project-type",
            ".project-basekit",
            ".product-type",
            ".app-login",
            "pwa.config.json",
            // 平台验收报告
            ".admin-visual-review.json",
            "admin-browser-cases.json",
            // 平台给 AI 的工程约束文档，会把后续开发者带偏
            "AGENTS.md",
            "CLAUDE.md",
            // 平台构建产物报告
            "dist/build-report.json",
    };

    /**
     * 平台专有的目录（整个删掉）。
     *
     * <p>{@code supabase/functions} 是平台的云函数，只在平台后端跑，
     * 本地 APK 里用不到；但 {@code supabase/migrations} 是数据库表结构，
     * 自建后端时还要用，所以只删 functions。
     */
    private static final String[] DROP_DIRS = {
            // 后端云函数：只在平台服务器上跑，前端不 import 它。
            // 注意这里只留这一条 —— src/ 下的东西一条都不能删，见下面 dropReason 的判断。
            "supabase/functions/",
    };

    /**
     * 平台构建脚本：只在平台服务器上跑，本地出包用不到。
     */
    private static final String[] DROP_SCRIPTS = {
            "scripts/build.mjs",
            "scripts/finalize-build.mjs",
            "scripts/finalize-pwa.mjs",
            "scripts/pwa-context.mjs",
            "scripts/pwa-context.d.mts",
            "scripts/check-pwa.mjs",
            "scripts/make-pwa-icons.mjs",
            "scripts/gen-debug-signing.mjs",
            "scripts/gen/",
            "scripts/ensure-deps.mjs",
            "scripts/gen-debug-signing.mjs",
            "vite.config.pwa.ts",
            "vite.config.admin.ts",
            "admin.html",
            "vite.shared.ts",
    };

    /**
     * 需要搬家的模型：构建产物里的路径 → 项目里的目标路径。
     *
     * <p>平台的语音识别权重在 {@code dist/client/web/asr/models/}，
     * 那是构建时切片写进去的（20 片共 79 MB）。
     * 源码里的 {@code public/asr/} 只有 wasm 和 tokens.txt。
     *
     * <p>代码找模型用的是相对路径 {@code ./asr/models/.../chunks.json}，
     * 而 {@code public/} 的内容在构建时会落到产物根目录 ——
     * 所以模型必须搬到 {@code public/asr/} 才找得到。
     *
     * <p>不搬的后果：应用装上后本地识别永远提示模型缺失，
     * 而离线识别是这个应用的核心卖点。
     */

    /**
     * 平台标识替换表：文件内容里的平台痕迹。
     *
     * <p>键是正则，值是替换文本。空字符串表示删掉。
     */
    private static final String[][] REPLACEMENTS = {
            // 平台项目 ID：p_47d628c24991b70e 出现在 package.json 的 name、
            // 产物里、以及各种配置中。改成你自己的应用标识。
            {"(?i)p-47d628c24991b70e", "app"},
            {"(?i)\\bai_p_47d628c24991b70e\\b", "com.scsxrkj.app"},
            {"(?i)\\bp_47d628c24991b70e\\b", "app"},
            // 平台后端域名
            {"(?i)https?://[a-z0-9.-]*\\.supabase\\.[a-z0-9.-]*", ""},
            {"(?i)https?://[a-z0-9.-]*aidap-global[a-z0-9.-]*", ""},
            // 平台壳 SDK 注入脚本：产物 index.html 末尾那行
            // <script src="/sdk/capsule.js"></script>
            // 不删的话每次启动都去请求平台服务器，离线直接 404，而且壳桥接不存在。
            {"(?i)<script[^>]*src=[\"']/sdk/capsule\\.js[\"'][^>]*>\\s*</script>", ""},
            {"(?i)appassets\\.[a-z0-9.-]*stepaos\\.com", "appassets.local"},
            {"(?i)t-stepos\\.com", "stepaos.local"},
    };

    /**
     * 清洗一个项目。
     *
     * @param p 项目对象（会被就地修改）
     * @return 清洗报告，{@code {items:[...], dropped:n, rewritten:n}}
     */
    static JSONObject clean(JSONObject p, java.io.File aFilesDir) throws Exception {
        return clean(p, aFilesDir, false);
    }

    /**
     * 清洗一个项目。
     *
     * @param p        项目对象
     * @param aFilesDir 应用私有目录
     * @param dryRun    true 只预演：算出会删什么、会改什么，一个字节都不动
     * @return 清洗报告，{@code {items:[...], dropped:n, rewritten:n, dryRun:bool}}
     */
    static JSONObject clean(JSONObject p, java.io.File aFilesDir, boolean dryRun) throws Exception {
        java.util.List<Item> items = new java.util.ArrayList<>();
        JSONObject files = p.getJSONObject("files");
        JSONObject bins = p.optJSONObject("binaryFiles");
        JSONObject hashes = p.optJSONObject("bigHashes");

        /*
         * 这里不做任何搬运。
         *
         * 早期设计把模型从 dist/client/web/asr/ 搬到 public/asr/，
         * 理由是「dist 整个要删，不搬就丢了」。现在删的范围收窄了
         * （见 dropReason：dist 下只删 asr/ 之外的构建产物），
         * 模型原地不动不会丢。
         *
         * 路径怎么对上交给打包和运行环节：它们把
         * dist/client/web/asr/ 和 public/asr/ 都映射到产物根，
         * 对所有项目一视同仁 —— 清洗器不该为某一个项目的目录结构写特例。
         */

// ── 第一步：删除整份文件 ──────────────────────────
        java.util.List<String> toRemove = new java.util.ArrayList<>();
        /*
         * 先把引用关系算出来。被源码 import 的东西一律不删 ——
         * 它可能确实带平台标识，但删了会让整个组件树断掉，
         * 而那种失败只显示一行「找不到本地文件」，极难定位。
         * 留着最多是多几行平台字样，改写规则会顺手清掉。
         */
        java.util.Set<String> referenced = collectReferenced(files);
        for (java.util.Iterator<String> it = files.keys(); it.hasNext(); ) {
            String n = it.next();
            String why = dropReason(n);
            if (why == null) continue;
            if (isReferenced(referenced, n)) {
                Item item = new Item("keep", n, why);
                item.detail = "有源码还在 import 它，删了会构建失败，所以保留";
                items.add(item);
                continue;
            }
            toRemove.add(n);
            Item item = new Item("delete", n, why);
            item.pcImpact = pcImpact(n);
            items.add(item);
        }
        if (bins != null) {
            for (java.util.Iterator<String> it = bins.keys(); it.hasNext(); ) {
                String n = it.next();
                String why = dropReason(n);
                if (why == null) continue;
                if (isReferenced(referenced, n)) {
                    Item item = new Item("keep", n, why);
                    item.detail = "有源码还在 import 它，删了会构建失败，所以保留";
                    items.add(item);
                    continue;
                }
                toRemove.add(n);
                Item item = new Item("delete", n, why);
                item.pcImpact = pcImpact(n);
                items.add(item);
            }
        }
        if (!dryRun) {
            for (String n : toRemove) {
                files.remove(n);
                if (bins != null) bins.remove(n);
            }
            // bigHashes 里对应的大文件哈希也要清掉，否则校验会对不上
            if (hashes != null) for (String n : toRemove) hashes.remove(n);
        }

        // ── 第二步：改写文件内容 ──────────────────────────
        int rewritten = 0;
        for (java.util.Iterator<String> it = files.keys(); it.hasNext(); ) {
            String n = it.next();
            String src = files.optString(n, "");
            if (src.isEmpty()) continue;
            String out = src;
            StringBuilder why = new StringBuilder();

            // 平台标识替换
            for (String[] r : REPLACEMENTS) {
                try {
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile(r[0]).matcher(out);
                    if (m.find()) {
                        out = m.replaceAll(java.util.regex.Matcher.quoteReplacement(r[1]));
                        if (why.length() > 0) why.append("；");
                        why.append("替换平台标识");
                    }
                } catch (Exception ignored) {
                }
            }

            /*
             * 这里不再改虚拟模块的 import。
             *
             * 曾经把 {@code 'virtual:help-guide'} 换成 {@code 'src/generated/help-guide.ts'}，
             * 理由是「本机编译器解析不了虚拟模块」。但这个判断是错的：
             * 编译器本来就支持它（local-runner.js 的 VIRTUAL_MODULES，
             * 内容从项目根的「使用说明.md」取）。
             *
             * 改了之后指向一个平台构建时才生成、源码里根本不存在的文件，
             * 构建直接失败。而清洗的职责是去平台痕迹，不是改源码的模块解析方式。
             */

            if (!out.equals(src)) {
                if (!dryRun) files.put(n, out);
                rewritten++;
                Item item = new Item("rewrite", n, why.toString());
                item.detail = "内容已改写";
                items.add(item);
            }
        }

        int dropped = toRemove.size();
        JSONObject report = new JSONObject()
                .put("items", toJson(items))
                .put("dropped", dropped)
                .put("rewritten", rewritten)
                .put("dryRun", dryRun)
                .put("time", System.currentTimeMillis());
        return report;
    }

    /**
     * 复制文件（分块，不把整个文件读进内存）。
     */
    static void copyFile(java.io.File src, java.io.File dst) throws Exception {
        try (java.io.FileInputStream in = new java.io.FileInputStream(src);
             java.io.FileOutputStream out = new java.io.FileOutputStream(dst)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
    }

    /**
     * 这个文件删掉以后，PC 上还能不能构建。
     *
     * <p>上架只需要 APK，本机编译器也不读 Vite 配置，所以删这些不影响出包。
     * 但用户以后可能想回 PC 用 Vite 继续开发，删之前得让他知道会失去什么 ——
     * 有几项是致命的：{@code vite.config.ts} 直接 import {@code vite.shared}，
     * package.json 的每条脚本都挂在 {@code scripts/} 下。
     *
     * @param n 项目内路径
     * @return 影响说明；对 PC 构建无影响返回 null
     */
    static String pcImpact(String n) {
        if (n.equals("vite.shared.ts"))
            return "vite.config.ts 直接引用它，删了连 vite dev 都起不来";
        if (n.equals("scripts/ensure-deps.mjs"))
            return "npm run dev / preview / typecheck 都靠它做前置检查";
        if (n.equals("scripts/build.mjs"))
            return "npm run build 的入口脚本";
        if (n.startsWith("vite.config."))
            return "只有构建 PWA / 管理端的那几条命令失效";
        if (n.equals("admin.html"))
            return "管理端入口页没了";
        if (n.startsWith("scripts/gen/"))
            return "平台生成的契约代码，源码引用它的话会编译失败";
        if (n.startsWith("scripts/"))
            return "对应的 npm 脚本失效";
        if (n.startsWith("supabase/functions/"))
            return "自建后端时要参考这些云函数；前端构建不受影响";
        return null;
    }

    /** 匹配 `from '...'` 和 `import '...'` 里的模块路径。 */
    private static final java.util.regex.Pattern IMPORT_SPEC =
            java.util.regex.Pattern.compile("(?:from|import)\\s+['\"]([^'\"\\n]+)['\"]");

    /**
     * 算出「源码还在 import 的文件」。
     *
     * <p>删文件不删 import，构建当场断掉，而界面上只显示一行「找不到本地文件」。
     * 这类问题已经踩过五次（pwa/、dev-report.ts、help-guide、capsule/manifest.json），
     * 靠一条条补规则永远补不完 —— 每换一个项目就会有新的引用关系。
     *
     * <p>所以反过来做：先把引用关系算出来，凡是被 import 的，一律不删。
     * 只处理相对路径，包名（react、lucide-react）不归这里管。
     *
     * @param files 项目的文本文件表
     * @return 被引用的项目内路径集合
     */
    static java.util.Set<String> collectReferenced(JSONObject files) {
        java.util.Set<String> out = new java.util.HashSet<>();
        if (files == null) return out;
        for (java.util.Iterator<String> it = files.keys(); it.hasNext(); ) {
            String n = it.next();
            // 只看源码：配置文件里的路径不是 import，不构成依赖
            if (!n.startsWith("src/")) continue;
            String src;
            try {
                src = files.getString(n);
            } catch (Exception e) {
                continue;
            }
            java.util.regex.Matcher m = IMPORT_SPEC.matcher(src);
            while (m.find()) {
                String spec = m.group(1);
                String resolved = null;
                if (spec.startsWith(".")) {
                    // 相对路径：./types、../bridge/loader
                    resolved = resolveSpec(n, spec);
                } else if (spec.startsWith("@/")) {
                    // 别名：@/shared/speech/generate
                    // 绝大多数 Vite 工程把 @/ 指向 src/，这个项目也是。
                    // 认错最多是少保护一个文件，不会误删。
                    resolved = "src/" + spec.substring(2);
                }
                if (resolved == null || resolved.isEmpty()) continue;
                out.add(resolved);
                // import 常常省略扩展名（./types 实际是 types.ts），
                // 两个版本都记下来，删文件时才认得出来
                String stripped = stripExt(resolved);
                if (stripped != null) out.add(stripped);
            }
        }
        return out;
    }

    /** 去掉末尾的脚本扩展名；没有扩展名返回 null。 */
    static String stripExt(String n) {
        for (String ext : new String[]{".tsx", ".ts", ".jsx", ".js", ".json", ".mjs", ".css"}) {
            if (n.endsWith(ext)) return n.substring(0, n.length() - ext.length());
        }
        return null;
    }

    /**
     * 这个路径有没有被源码引用。
     *
     * <p>同时比对带扩展名和不带扩展名的形式：
     * import 写的是 {@code ./types}，实际文件叫 {@code types.ts}。
     */
    static boolean isReferenced(java.util.Set<String> referenced, String n) {
        if (referenced.contains(n)) return true;
        String stripped = stripExt(n);
        return stripped != null && referenced.contains(stripped);
    }

    /**
     * 把 from 文件里的相对路径解析成项目根路径。
     *
     * <p>不用 {@code String.join} —— minSdk 24 上没有这个方法。
     *
     * @param from 引用发起方（项目内路径）
     * @param spec 相对路径，如 {@code ../../../capsule/manifest.json}
     * @return 解析后的项目内路径；越出项目根返回 null
     */
    static String resolveSpec(String from, String spec) {
        String dir = from.contains("/") ? from.substring(0, from.lastIndexOf('/')) : "";
        String full = dir.isEmpty() ? spec : dir + "/" + spec;
        java.util.ArrayDeque<String> stack = new java.util.ArrayDeque<>();
        for (String seg : full.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) {
                if (stack.isEmpty()) return null;
                stack.removeLast();
            } else {
                stack.addLast(seg);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (String seg : stack) {
            if (sb.length() > 0) sb.append('/');
            sb.append(seg);
        }
        return sb.toString();
    }

    /**
     * 判断一个路径该不该删；不该删返回 null，该删返回原因。
     *
     * <p>补全素材也会调它：从完整包里补文件时，平台专属的那些不能补回来 ——
     * 用户刚清洗掉的签名证书和凭据，补一次等于白洗一遍。
     */
    static String dropReason(String n) {
        /*
         * src/ 下的源码一律不删。
         *
         * 曾经删过两处看似「平台专属」的模块：src/shared/pwa/（PWA 支持）
         * 和 src/shared/bridge/dev-report.ts（调试报告）。理由是它们只在平台壳里有用。
         * 结果构建直接失败 —— main.tsx 还在 import PwaProvider，
         * bridge/index.ts 还在 import dev-report。删文件不删 import，
         * 组件树当场断掉，而界面上只显示一行「找不到本地文件」。
         *
         * 判断标准不是「这个文件是不是平台写的」，而是「还有没有人在 import 它」。
         * 源码层留着不影响上架：审核看的是 APK 的行为，不是源码目录名。
         */
        if (n.startsWith("src/")) return null;
        for (String d : DROP_DIRS) if (n.startsWith(d)) return "平台专有模块，不进 APK";
        for (String d : DROP_SCRIPTS) if (n.equals(d) || n.startsWith(d)) return "平台构建脚本，本地出包用不到";
        for (String d : DROP_PATHS) {
            if (d.endsWith("/")) {
                if (n.startsWith(d)) return "平台配置与证书，出包前必须清掉";
            } else if (n.equals(d)) {
                return "平台配置，出包前必须清掉";
            }
        }
        /*
         * 平台构建产物整个删掉，但模型权重必须留。
         *
         * dist/client/web/ 下的成品是平台用 Vite 打的（那份 index.html 里就挂着
         * /sdk/capsule.js，JS 里也带着平台项目 ID），我们的本机编译会重新生成，
         * 留着纯粹是痕迹加几十兆死重量。
         *
         * 但 dist/client/web/asr/ 里是构建时从网络下载、切片写进去的语音模型，
         * 源码里没有、node_modules 里也没有，删了就再也回不来了。
         */
        if (n.startsWith("dist/client/web/asr/")) return null;
        if (n.startsWith("dist/")) return "平台构建产物，本机会重新生成";
        return null;
    }

    /**
     * 清洗项列表转成 JSON 数组。
     */
    private static JSONArray toJson(java.util.List<Item> items) throws Exception {
        JSONArray out = new JSONArray();
        for (Item it : items) {
            out.put(new JSONObject()
                    .put("kind", it.kind)
                    .put("path", it.path)
                    .put("reason", it.reason)
                    .put("detail", it.detail)
                    .put("pcImpact", it.pcImpact == null ? JSONObject.NULL : it.pcImpact));
        }
        return out;
    }
}
