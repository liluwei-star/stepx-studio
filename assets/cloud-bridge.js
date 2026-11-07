/*
 * 云端同步的大文件通道 —— JavaScript 侧。
 *
 * <p>这个文件由原生侧（CloudProjects.execute）读出来，和同步脚本
 * 一起拼成一段 JavaScript 注入到 Studio 页面里执行。
 *
 * <h3>它解决什么问题</h3>
 * <p>原生的 @JavascriptInterface 方法是同步的，返回值直接给 JS。
 * 但分块写入必须「等这一块写完再发下一块」，否则顺序会乱。
 * 所以原生侧不直接返回结果，而是回调
 * {@code window.__neoCloudNativeCallbacks[id]}。
 *
 * <p>这里把原生方法包成 Promise，调用方就能 await：
 * <pre>
 * await window.NeoCloudNative.cloudBegin(projectId, path);
 * await window.NeoCloudNative.cloudAppend(projectId, path, base64);
 * </pre>
 *
 * <h3>为什么要单独放一个文件</h3>
 * <p>这段代码原本写在 Java 字符串里，转义层次多，一处引号或花括号
 * 写错就会让整段注入的脚本在解析期失败 —— 表现为同步永远卡在
 * 「连接云端」，而且 try/catch 接不住（语法错误发生在解析阶段）。
 * 放在独立文件里可以直接用 node --check 验证语法。
 *
 * <h3>关于重复注入</h3>
 * <p>这段代码会被反复注入到同一个页面里（每次同步一次）。
 * 所以：内部用 var 而不是 const，并且整体套一层 IIFE，
 * 既不会撞名，也不会污染页面全局作用域。
 */

/* eslint-disable no-unused-vars */
(function () {
    // 原生对象在网页上的名字。它在 WebView 创建时就通过
    // addJavascriptInterface 注册好了 —— 那一步必须在页面加载前完成，
    // 运行时再注册对已加载的页面无效。
    var RAW = 'NeoCloudRaw';

    if (!window[RAW]) return;

    // 回调表：原生完成一个调用后，通过这个表把结果送回来。
    window.__neoCloudNativeCallbacks = window.__neoCloudNativeCallbacks || {};

    /*
     * 调用一个原生方法，返回一个 Promise。
     *
     * @param m  原生方法名
     * @param a  参数列表
     */
    var call = function (m, a) {
        return new Promise(function (res, rej) {
            // 回调 id：随机串 + 时间戳，保证多次并发调用不会撞
            var id = 'cb' + Math.random().toString(36).slice(2) + Date.now();
            window.__neoCloudNativeCallbacks[id] = function (r) {
                delete window.__neoCloudNativeCallbacks[id];
                if (r && r.ok) res(r.result);
                else rej(new Error((r && r.error) || '原生调用失败'));
            };
            try {
                window[RAW][m].apply(window[RAW], [id].concat(a || []));
            } catch (e) {
                delete window.__neoCloudNativeCallbacks[id];
                rej(e);
            }
        });
    };

    // 对外的 Promise 化接口
    window.NeoCloudNative = {
        // 开始写一个大文件（清空同名旧文件）
        cloudBegin: function (pid, path) { return call('cloudBegin', [pid, path]); },
        // 追加一个分块（base64 编码的字节）
        cloudAppend: function (pid, path, b64) { return call('cloudAppend', [pid, path, b64]); },
        // 结束写入，关闭句柄，把缓冲刷到磁盘
        cloudEnd: function (pid, path) { return call('cloudEnd', [pid, path]); },
        // 查文件大小
        cloudSize: function (pid, path) { return call('cloudSize', [pid, path]); },
        // 读文件的一段，返回 base64
        cloudRead: function (pid, path, off, len) { return call('cloudRead', [pid, path, off, len]); },
        // 校验哈希
        cloudVerify: function (pid, path, expect) { return call('cloudVerify', [pid, path, expect]); },
        // 把一组分片按序号顺序合并成一个文件
        cloudMerge: function (pid, base, shards) { return call('cloudMerge', [pid, base, shards]); },
        // 算文件的 SHA-256
        cloudHash: function (pid, path) { return call('cloudHash', [pid, path]); }
    };
})();
