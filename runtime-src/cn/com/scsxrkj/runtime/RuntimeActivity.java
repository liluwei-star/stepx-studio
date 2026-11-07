package cn.com.scsxrkj.runtime;

import cn.com.scsxrkj.matrix.*;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 生成的 App 的运行壳。
 *
 * <p>这个类会被打进每一个由 StepX Studio「本机构建」产出的 APK。职责很单一：
 * 把纯前端项目（index.html / css / js）装进 WebView 跑起来，并给页面提供
 * 几个原生桥接——AI 请求、调试日志回传、文件导出、背屏点阵控制。
 *
 * <p>三个刻意的设计约束：
 * <ul>
 *   <li>不读取工作台（StepX Studio 本体）的任何私有数据，也不持有它的密钥。
 *       调试报告只有用户手动点「回传」时才通过显式 Intent 交给工作台。</li>
 *   <li>页面只能从虚拟域名 {@code app.neo.local} 加载，资源全部来自 APK 内的
 *       assets/project，不访问手机文件系统。</li>
 *   <li>所有来自页面的字符串在记录前都过一遍 {@link #redact} 打码，
 *       避免把 API Key 写进日志。</li>
 *   <li>兼容 Android 7.0（API 24）以上：系统栏相关的高版本 API 都放在
 *       {@code Build.VERSION.SDK_INT} 判断之后调用。</li>
 * </ul>
 */
public class RuntimeActivity extends Activity {

    /** 页面使用的虚拟域名。拦截该域名的请求，从 APK 内 assets 读取文件返回。 */
    static final String ORIGIN = "https://app.neo.local/";

    /** 页面宿主。 */
    WebView web;
    /** 读取自 assets/project.json 的元信息（id / name / version）。 */
    JSONObject meta;
    /** 运行日志环形缓冲，最多 100 条，供「查看运行日志」与调试回传使用。 */
    JSONArray logs = new JSONArray();
    /** 页面通过 NeoDev.test() 上报的自检结果，最多 50 条。 */
    JSONArray tests = new JSONArray();
    /** 页面触发 input[type=file] 时的回调，等系统选择器返回后回填。 */
    ValueCallback<Uri[]> chooser;
    /** 页面请求摄像头/麦克风时挂起的权限请求。 */
    PermissionRequest permission;
    /** 当前挂起请求涉及的资源类型（video / audio）。 */
    String[] mediaResources;
    /** 进行中的 AI 请求 id，保证同一时刻只有一个。 */
    String aiId;
    /** 用户是否在「⋯」菜单里开了调试模式。没开不允许回传报告。 */
    boolean debugMode;
    /** 待导出的字节，等用户选完保存位置后写入。 */
    byte[] saveBytes;

    @Override
    public void onCreate(Bundle b) {
        super.onCreate(b);

        // 背屏点阵服务若上次被异常终止，这里做一次状态恢复。
        MatrixDevice.recover(this);

        // 读项目元信息。读不到也不影响启动，后面字段都用 optString 兜底。
        try {
            meta = new JSONObject(read("project.json"));
        } catch (Exception e) {
            meta = new JSONObject();
        }

        buildUi();          // 先建界面并 setContentView
        applySystemBars();  // 再配系统栏：此时 decorView 已存在，getInsetsController() 不会返回 null
        configureWebView();

        web.loadUrl(ORIGIN + "index.html");
        addLog("lifecycle", "应用启动");
    }

    // ==================================================================
    // 界面构建
    // ==================================================================

    /**
     * 配置沉浸式系统栏：状态栏与导航栏透明，内容绘制到栏下方，
     * 再由 {@link #applyInsets} 补出安全边距。
     *
     * <p>API 30（Android 11）起用 setDecorFitsSystemWindows + WindowInsetsController；
     * 更早的版本用 systemUiVisibility 标志位。
     */
    @SuppressWarnings("deprecation")
    void applySystemBars() {
        Window w = getWindow();
        // 必须先取一次 decorView，否则在部分 ROM 上 getInsetsController() 返回 null
        // （实测 STEPX Neo / Android 16 会抛 NullPointerException）。
        w.getDecorView();
        // 两条栏都设透明。API 21 起可用，minSdk 24 不需要判断。
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= 30) {
            // 告诉系统「应用自己处理系统栏区域」，不再自动加内边距。
            w.setDecorFitsSystemWindows(false);
            // 关掉 Android 10 引入的导航栏对比蒙层，避免深色页面被加一层灰。
            w.setNavigationBarContrastEnforced(false);
            // 24 = APPEARANCE_LIGHT_STATUS_BARS(8) | APPEARANCE_LIGHT_NAVIGATION_BARS(16)
            // 含义是「浅色背景 + 深色图标」，保证白色主题下看得清。
            w.getInsetsController().setSystemBarsAppearance(24, 24);
        } else {
            // Android 7.0~10 的旧写法。
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (Build.VERSION.SDK_INT >= 23) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            w.getDecorView().setSystemUiVisibility(flags);
        }
    }

    /**
     * 搭出「顶部标题栏 + 下方 WebView」的两段式界面。
     * 标题取自 project.json 的 name 字段，右侧「⋯」按钮打开调试菜单。
     */
    void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xfff8fafc);
        setContentView(root);
        applyInsets(root);

        // --- 顶部标题栏 -------------------------------------------------
        LinearLayout bar = new LinearLayout(this);
        TextView title = new TextView(this);
        title.setText(meta.optString("name", "App"));
        title.setTextColor(0xff173d35);
        title.setPadding(dp(16), dp(6), 0, dp(6));
        title.setTextSize(16);
        // weight=1 让标题占满剩余宽度，「⋯」按钮固定在右边。
        bar.addView(title, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        // 右上角「⋯」按钮：打开应用与调试菜单。
        // 这里刻意去掉系统默认的按钮背景 —— 默认样式是灰色圆角方块，
        // 放在浅色页面上很突兀。改成透明背景 + 只显示文字，和整体风格一致。
        Button menu = new Button(this);
        menu.setText("⋯");
        menu.setTextSize(20);
        menu.setTextColor(0xff173d35);          // 和标题同色
        menu.setContentDescription("应用与调试");
        menu.setBackgroundColor(Color.TRANSPARENT);
        menu.setMinWidth(0);
        menu.setMinimumWidth(0);
        menu.setPadding(0, 0, 0, 0);
        menu.setStateListAnimator(null);        // 去掉按下时的高浮雕动画
        menu.setOnClickListener(v -> menu());
        bar.addView(menu, new LinearLayout.LayoutParams(dp(48), dp(48)));
        root.addView(bar);

        // --- 页面容器 ---------------------------------------------------
        web = new WebView(this);
        // weight=1 让 WebView 占满标题栏以下的全部空间。
        root.addView(web, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
    }

    /**
     * 给根布局注册 insets 监听，把状态栏、导航栏、刘海、输入法的高度转成内边距。
     * 不做这一步，页面顶部会被状态栏盖住、底部会被导航栏或键盘盖住。
     */
    void applyInsets(LinearLayout root) {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                // 系统栏与刘海取并集，输入法高度单独取。
                Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                // 底部取两者较大值：键盘弹起时让出键盘高度，否则让出导航栏高度。
                root.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                // 消费掉，避免子 View 再处理一次。
                return WindowInsets.CONSUMED;
            }
            // Android 7.0~10 的旧 WindowInsets getter（API 20 起可用）。
            int bottom = Math.max(insets.getSystemWindowInsetBottom(), insets.getStableInsetBottom());
            root.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), bottom);
            return insets.consumeSystemWindowInsets();
        });
    }

    /**
     * WebView 安全配置 + 三个回调。
     *
     * <p>安全上刻意关掉 file:// 访问、混合内容和自动播放：
     * 页面只能加载 APK 内资源，读不到手机上别的文件。
     */
    void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);          // 项目就是前端应用，必须开 JS
        s.setDomStorageEnabled(true);          // localStorage / sessionStorage
        s.setAllowFileAccess(false);           // 禁止 file:// 直接读文件
        s.setAllowContentAccess(true);         // 允许 content://（文件选择器需要）
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); // https 页面不许加载 http
        s.setMediaPlaybackRequiresUserGesture(true);                  // 音视频必须用户点过才播

        // 桥接对象：页面通过 window.NeoNative.* 调用下面的 NativeBridge 方法。
        web.addJavascriptInterface(new NativeBridge(), "NeoNative");

        // 只有 debug 版才开远程调试，正式包不能被 Chrome 远程检查。
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & 2) != 0);

        web.setWebViewClient(new WebViewClient() {

            /**
             * 拦截 app.neo.local 下的所有请求，从 APK 的 assets/project 取文件返回。
             * 这是「离线运行」的核心：页面以为在访问 https，其实读的是包内资源。
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                // 只接管自己的虚拟域名，其他请求一律不碰。
                if (!"app.neo.local".equals(u.getHost())) return null;
                try {
                    if (!"https".equals(u.getScheme())) throw new IOException();
                    String f = u.getPath().substring(1);
                    if (f.isEmpty()) f = "index.html";
                    if (!RuntimeAssets.path(f)) throw new IOException();

                    byte[] data;
                    if (f.equals("neo-runtime.js")) {
                        // 桥接脚本由 helper() 现场生成，不落盘。
                        data = helper().getBytes(StandardCharsets.UTF_8);
                    } else {
                        data = RuntimeAssets.read(getAssets(), f);
                        if (f.equals("index.html")) {
                            // 给用户页面自动注入桥接脚本，用户不必自己加 script 标签。
                            String text = new String(data, StandardCharsets.UTF_8);
                            String script = "<script src=\"/neo-runtime.js\"></script>";
                            text = text.contains("</head>")
                                    ? text.replace("</head>", script + "</head>")
                                    : script + text;
                            data = text.getBytes(StandardCharsets.UTF_8);
                        }
                    }

                    // 严格 CSP：禁外部脚本、禁 iframe、禁 object。
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Content-Security-Policy",
                            "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; "
                          + "style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
                          + "connect-src https: blob:; img-src 'self' data: blob: https:; "
                          + "media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'");
                    return new WebResourceResponse(RuntimeAssets.mime(f), "UTF-8", 200, "OK",
                            headers, new ByteArrayInputStream(data));
                } catch (Exception e) {
                    addLog("resource", "无法读取打包资源：" + u.getPath());
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found",
                            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
            }

            /**
             * 页面内链接点击。站内链接放行；站外 https 链接交给系统浏览器，
             * 避免陌生页面在应用内打开、拿到本应用的权限。
             */
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String url = r.getUrl().toString();
                if (ORIGIN.equals(url) || url.startsWith(ORIGIN)) return false;
                if (r.isForMainFrame() && "https".equals(r.getUrl().getScheme())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl()));
                    } catch (Exception ignored) {
                    }
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {

            /** 把页面里的 console.error 收进运行日志，方便排查白屏。 */
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    addLog("error", m.message());
                }
                return true;
            }

            /** 页面点「选择文件」时拉起系统文件选择器，结果在 onActivityResult 回填。 */
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (chooser != null) chooser.onReceiveValue(null);   // 丢掉上次没完成的
                chooser = cb;
                try {
                    startActivityForResult(p.createIntent().addCategory(Intent.CATEGORY_OPENABLE), 20);
                } catch (Exception e) {
                    cb.onReceiveValue(null);
                    chooser = null;
                }
                return true;
            }

            /** 页面调 getUserMedia 时先弹确认框，用户同意后再申请系统权限。 */
            @Override
            public void onPermissionRequest(PermissionRequest p) {
                runOnUiThread(() -> askMedia(p));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest p) {
                if (permission == p) permission = null;
            }
        });

        // 页面用 a[download] 触发 blob:/data: 链接时，交给 NeoNative.save() 走「另存为」。
        // 单文件上限 1MB，超出直接报错，避免内存被占满。
        web.setDownloadListener((url, ua, cd, mime, size) -> {
            if (url.startsWith("blob:")) {
                web.evaluateJavascript(
                        "fetch(" + JSONObject.quote(url) + ").then(r=>r.blob()).then(b=>{"
                      + "if(b.size>1048576)throw Error('文件超过1MB');"
                      + "let f=new FileReader();f.onload=()=>NeoNative.save(f.result,'neo-report.json');"
                      + "f.readAsDataURL(b)})", null);
            } else if (url.startsWith("data:")) {
                new NativeBridge().save(url, "neo-report.json");
            }
        });
    }

    // ==================================================================
    // 工具方法
    // ==================================================================

    /** 把 dp 换算成像素，保证不同屏幕密度下尺寸一致。 */
    int dp(int n) {
        return Math.round(getResources().getDisplayMetrics().density * n);
    }

    /** 读取 APK 内 assets 下的文本文件。 */
    String read(String f) throws Exception {
        try (InputStream in = getAssets().open(f);
             ByteArrayOutputStream o = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) != -1) o.write(b, 0, n);
            return o.toString("UTF-8");
        }
    }

    /**
     * 生成注入页面的桥接脚本，暴露 window.NeoDev。
     *
     * <p>页面可用能力：
     * <ul>
     *   <li>{@code NeoDev.info()} 取项目 id、包名、版本、系统 SDK</li>
     *   <li>{@code NeoDev.log(level, text)} 写运行日志</li>
     *   <li>{@code NeoDev.test(name, status, detail)} 记一条自检结果</li>
     *   <li>{@code NeoDev.ai(prompt)} 请求工作台里的 AI，返回 Promise</li>
     *   <li>{@code NeoDev.report()} 打开调试报告回传</li>
     * </ul>
     */
    String helper() {
        return "(()=>{const pending=new Map();"
             + "window.NeoDev={"
             + "info:()=>JSON.parse(NeoNative.info()),"
             + "log:(level,text)=>NeoNative.log(String(level),String(text)),"
             + "test:(name,status,detail='')=>NeoNative.test(String(name),String(status),String(detail)),"
             + "report:()=>NeoNative.report(),"
             + "ai:prompt=>new Promise((resolve,reject)=>{"
             + "const id=Date.now()+'-'+Math.random();"
             + "pending.set(id,{resolve,reject});"
             + "NeoNative.ai(id,String(prompt));})};"
             // Native 侧处理完 AI 请求后派发 neo-runtime 事件，这里按 id 找回对应 Promise
             + "window.addEventListener('neo-runtime',e=>{"
             + "let p=pending.get(e.detail.id);"
             + "if(p){pending.delete(e.detail.id);"
             + "e.detail.error?p.reject(Error(e.detail.error)):p.resolve(e.detail.result)}});"
             + "window.addEventListener('error',e=>NeoDev.log('error',e.message));"
             + "window.addEventListener('unhandledrejection',e=>NeoDev.log('error',String(e.reason)));"
             + "})();";
    }

    /**
     * 给日志内容打码，避免把密钥写进调试报告。
     * 命中 sk-xxxxxxxxxxxx 或 Bearer xxx 形式时替换成占位符。
     */
    String redact(String s) {
        return s.replaceAll("(?i)(sk-[A-Za-z0-9_-]{12,}|Bearer\\s+[A-Za-z0-9._-]+)", "[已隐藏密钥]");
    }

    /** 追加一条运行日志。超过 100 条丢最旧的，单条超过 1000 字会被截断。 */
    synchronized void addLog(String level, String text) {
        try {
            if (logs.length() >= 100) logs.remove(0);
            logs.put(new JSONObject()
                    .put("time", System.currentTimeMillis())
                    .put("level", level)
                    .put("text", redact(text.length() > 1000 ? text.substring(0, 1000) : text)));
        } catch (Exception ignored) {
        }
    }

    /** 组装调试报告：项目 id、包名、版本、全部日志与自检结果。 */
    JSONObject reportData() throws Exception {
        return new JSONObject()
                .put("schema", "neo-debug/1")
                .put("projectId", meta.optString("id"))
                .put("appId", getPackageName())
                .put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName)
                .put("time", System.currentTimeMillis())
                .put("events", logs)
                .put("tests", tests);
    }

    // ==================================================================
    // 调试菜单与报告回传
    // ==================================================================

    /** 「⋯」菜单：切换调试模式、看日志、回传报告、导出 JSON、重载页面。 */
    void menu() {
        new AlertDialog.Builder(this)
                .setTitle(meta.optString("name"))
                .setItems(new String[]{
                        debugMode ? "关闭调试模式" : "开启调试模式",
                        "查看运行日志",
                        "回传调试报告到 StepX Studio",
                        "导出调试报告 JSON",
                        "重新加载"
                }, (d, n) -> {
                    if (n == 0) {
                        debugMode = !debugMode;
                        toast(debugMode ? "调试模式已开启" : "调试模式已关闭");
                    }
                    if (n == 1) {
                        try {
                            new AlertDialog.Builder(this)
                                    .setMessage(reportData().toString(2))
                                    .setPositiveButton("关闭", null).show();
                        } catch (Exception ignored) {
                        }
                    }
                    if (n == 2) sendReport();
                    if (n == 3) {
                        try {
                            saveBytes = reportData().toString(2).getBytes(StandardCharsets.UTF_8);
                            savePicker("neo-debug.json");
                        } catch (Exception ignored) {
                        }
                    }
                    if (n == 4) web.reload();
                }).show();
    }

    /**
     * 把调试报告交给工作台（StepX Studio）。
     *
     * <p>走显式 Intent（指定包名与类名），只有装了工作台才会成功。
     * 报告不含照片、录音或 API Key——{@link #redact} 在写日志时已处理过。
     */
    void sendReport() {
        if (!debugMode) {
            toast("请先在菜单开启调试模式");
            return;
        }
        try {
            String report = reportData().toString();
            new AlertDialog.Builder(this)
                    .setTitle("回传调试报告")
                    .setMessage("将版本、自检与错误日志交给 StepX Studio。"
                              + "请先在“查看运行日志”中核对内容，不会发送照片、音频或 API Key。")
                    .setPositiveButton("回传", (d, n) -> {
                        try {
                            startActivityForResult(new Intent("cn.com.scsxrkj.DEBUG_REPORT")
                                    .setClassName("cn.com.scsxrkj", "cn.com.scsxrkj.IntegrationActivity")
                                    .putExtra("report", report), 31);
                        } catch (Exception e) {
                            toast("请安装 StepX Studio，或先导出 JSON");
                        }
                    })
                    .setNegativeButton("取消", null)
                    .show();
        } catch (Exception e) {
            toast("报告生成失败");
        }
    }

    // ==================================================================
    // 摄像头 / 麦克风权限
    // ==================================================================

    /**
     * 页面请求媒体权限时的处理：先校验来源域名，再弹自家确认框，
     * 用户同意后才申请系统权限。两道确认避免页面偷偷开摄像头。
     */
    void askMedia(PermissionRequest p) {
        // 只信任自己的虚拟域名。
        if (!"https".equals(p.getOrigin().getScheme())
                || !"app.neo.local".equals(p.getOrigin().getHost())) {
            p.deny();
            return;
        }

        List<String> resources = new ArrayList<>();
        List<String> perms = new ArrayList<>();
        for (String r : p.getResources()) {
            if (r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                resources.add(r);
                perms.add(Manifest.permission.CAMERA);
            }
            if (r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                resources.add(r);
                perms.add(Manifest.permission.RECORD_AUDIO);
            }
        }
        if (resources.isEmpty()) {
            p.deny();
            return;
        }

        permission = p;
        mediaResources = resources.toArray(new String[0]);

        String what = (perms.contains(Manifest.permission.CAMERA) ? "摄像头 " : "")
                + (perms.contains(Manifest.permission.RECORD_AUDIO) ? "麦克风" : "");
        new AlertDialog.Builder(this)
                .setTitle("申请设备权限")
                .setMessage("此应用希望使用" + what + "。是否继续？")
                .setPositiveButton("继续", (d, n) ->
                        requestPermissions(perms.toArray(new String[0]), 10))
                .setNegativeButton("拒绝", (d, n) -> {
                    p.deny();
                    permission = null;
                })
                .setOnCancelListener(d -> {
                    p.deny();
                    permission = null;
                })
                .show();
    }

    /** 系统权限结果回来后，把已授予的部分回填页面；一个都没给就整体拒绝。 */
    @Override
    public void onRequestPermissionsResult(int r, String[] p, int[] g) {
        super.onRequestPermissionsResult(r, p, g);
        if (r == 10 && permission != null) {
            List<String> granted = new ArrayList<>();
            for (String s : mediaResources) {
                String need = s.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                        ? Manifest.permission.CAMERA : Manifest.permission.RECORD_AUDIO;
                if (checkSelfPermission(need) == PackageManager.PERMISSION_GRANTED) {
                    granted.add(s);
                }
            }
            if (granted.isEmpty()) permission.deny();
            else permission.grant(granted.toArray(new String[0]));
            permission = null;
        }
    }

    // ==================================================================
    // 页面桥接
    // ==================================================================

    /**
     * 暴露给页面的原生接口，挂在 window.NeoNative 上。
     * 所有方法由 WebView 在 JS 线程调用，涉及 UI 的操作一律 post 到主线程。
     */
    final class NativeBridge {

        /** 当前设备是否支持背屏点阵（STEPX 系统服务是否就绪）。 */
        @JavascriptInterface
        public boolean matrixNative() {
            return MatrixDevice.available(RuntimeActivity.this);
        }

        /** 背屏播放状态，供页面判断是否正在播放。 */
        @JavascriptInterface
        public String matrixStatus() {
            return MatrixService.status(RuntimeActivity.this);
        }

        /**
         * 背屏控制入口。
         *
         * @param action  start 开始播放 / stop 停止 / settings 打开设置 / permissions 申请权限
         * @param payload start 时的参数（simulate 仅模拟不驱动硬件，keepLit 是否保持常亮）
         */
        @JavascriptInterface
        public void matrix(String action, String payload) {
            runOnUiThread(() -> {
                try {
                    if (action.equals("start")) {
                        JSONObject p = new JSONObject(payload);
                        MatrixService.start(RuntimeActivity.this,
                                read("project/neo-matrix.json"),
                                p.optBoolean("simulate"),
                                p.optBoolean("keepLit", true));
                    } else if (action.equals("stop")) {
                        startService(new Intent(RuntimeActivity.this, MatrixService.class)
                                .setAction("stop"));
                    } else if (action.equals("settings")) {
                        MatrixSettings.show(RuntimeActivity.this);
                    } else if (action.equals("permissions")) {
                        MatrixSettings.permissions(RuntimeActivity.this);
                    }
                } catch (Exception e) {
                    toast(e.getMessage());
                    addLog("matrix", e.getMessage());
                }
            });
        }

        /** 返回项目 id、包名、版本、系统 SDK 与构建来源，供页面展示或调试。 */
        @JavascriptInterface
        public String info() {
            try {
                return new JSONObject()
                        .put("projectId", meta.optString("id"))
                        .put("appId", getPackageName())
                        .put("version", getPackageManager()
                                .getPackageInfo(getPackageName(), 0).versionName)
                        .put("sdk", Build.VERSION.SDK_INT)
                        .put("buildRoute", "offline-device")
                        .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void log(String level, String text) {
            addLog(level, text);
        }

        /** 记录一条自检结果。名称限 100 字、详情限 1000 字，超出直接丢弃。 */
        @JavascriptInterface
        public void test(String name, String status, String detail) {
            if (name.length() > 100 || detail.length() > 1000) return;
            runOnUiThread(() -> {
                try {
                    if (tests.length() >= 50) tests.remove(0);
                    tests.put(new JSONObject()
                            .put("name", name)
                            .put("status", status)
                            .put("detail", redact(detail)));
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void report() {
            runOnUiThread(() -> sendReport());
        }

        /**
         * 页面请求 AI。转交工作台处理，结果通过 neo-runtime 事件异步回填。
         * 同一时刻只允许一个请求。
         *
         * @param id     请求标识，用来把结果对应回页面上的 Promise
         * @param prompt 提示词，限 4000 字
         */
        @JavascriptInterface
        public void ai(String id, String prompt) {
            runOnUiThread(() -> {
                if (prompt.length() > 4000 || aiId != null) {
                    reply(id, null, "请求过长或已有请求进行中");
                    return;
                }
                aiId = id;
                try {
                    startActivityForResult(new Intent("cn.com.scsxrkj.AI_REQUEST")
                            .setClassName("cn.com.scsxrkj", "cn.com.scsxrkj.IntegrationActivity")
                            .putExtra("projectId", meta.optString("id"))
                            .putExtra("prompt", prompt), 30);
                } catch (Exception e) {
                    aiId = null;
                    reply(id, null, "请先安装 StepX Studio 并配置 API");
                }
            });
        }

        /**
         * 页面导出文件：接收 data URL，解码后交给系统的「另存为」。
         *
         * @param data data URL（必须 base64 编码，上限约 1.5MB）
         * @param name 建议文件名，不合法时回退成 neo-export.json
         */
        @JavascriptInterface
        public void save(String data, String name) {
            if (data.length() > 1500000) return;
            runOnUiThread(() -> {
                try {
                    int c = data.indexOf(',');
                    if (c < 0 || !data.substring(0, c).endsWith(";base64")) throw new Exception();
                    saveBytes = android.util.Base64.decode(data.substring(c + 1), 0);
                    savePicker(name.matches("[A-Za-z0-9_.-]{1,80}") ? name : "neo-export.json");
                } catch (Exception e) {
                    toast("导出内容无效");
                }
            });
        }
    }

    /** 把 AI 请求结果派发回页面，由页面里的 Promise 接住。 */
    void reply(String id, JSONObject result, String error) {
        try {
            JSONObject e = new JSONObject().put("id", id);
            if (error != null) e.put("error", error);
            else e.put("result", result);
            web.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('neo-runtime',{detail:" + e + "}))", null);
        } catch (Exception ignored) {
        }
    }

    /** 拉起系统的「另存为」对话框。 */
    void savePicker(String name) {
        startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .setType("application/json")
                .addCategory(Intent.CATEGORY_OPENABLE)
                .putExtra(Intent.EXTRA_TITLE, name), 21);
    }

    /**
     * 系统选择器的回填入口。四个请求码：
     * <ul>
     *   <li>20 —— 页面选文件（input type=file）</li>
     *   <li>21 —— 导出文件（另存为）</li>
     *   <li>30 —— AI 请求返回</li>
     *   <li>31 —— 调试报告回传返回</li>
     * </ul>
     */
    @Override
    public void onActivityResult(int r, int code, Intent data) {
        super.onActivityResult(r, code, data);

        if (r == 20 && chooser != null) {
            chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(code, data));
            chooser = null;
        }
        if (r == 21 && code == RESULT_OK && data != null) {
            try (OutputStream o = getContentResolver().openOutputStream(data.getData())) {
                o.write(saveBytes);
                toast("已保存");
            } catch (Exception e) {
                toast("保存失败");
            }
        }
        if (r == 21) saveBytes = null;

        if (r == 30) {
            String id = aiId;
            aiId = null;
            try {
                if (code != RESULT_OK || data == null) {
                    reply(id, null, "请求取消");
                } else {
                    JSONObject res = new JSONObject(data.getStringExtra("result"));
                    reply(id, res, res.optString("error", null));
                }
            } catch (Exception e) {
                reply(id, null, "接口结果无效");
            }
        }
        if (r == 31) {
            toast(code == RESULT_OK ? "调试报告已交给 StepX Studio" : "回传未完成");
        }
    }

    void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }

    // ==================================================================
    // 生命周期
    // ==================================================================

    /** 退到后台时暂停页面并停掉摄像头/麦克风占用，避免后台偷录。 */
    @Override
    public void onPause() {
        if (web != null) {
            web.evaluateJavascript(
                    "window.dispatchEvent(new Event('blur'));"
                  + "document.querySelectorAll('video,audio').forEach(e=>{"
                  + "if(e.srcObject)e.srcObject.getTracks().forEach(t=>t.stop())});"
                  + "window.dispatchEvent(new Event('neo-background'))", null);
            web.onPause();
        }
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    /** 销毁时释放选择器回调、拒绝挂起的权限请求、断开 JS 桥并销毁 WebView。 */
    @Override
    public void onDestroy() {
        if (chooser != null) chooser.onReceiveValue(null);
        if (permission != null) permission.deny();
        if (web != null) {
            web.removeJavascriptInterface("NeoNative");
            web.destroy();
        }
        super.onDestroy();
    }
}
