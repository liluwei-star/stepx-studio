/*
 * 编译检查不能只报「通过」。
 *
 * <p>编译能过 ≠ 项目是好的。
 *
 * <p>本机编译会收集一组 warnings，其中有几类是**真的坏了**：
 *   · 源码适配失败 —— 那个文件里的录音/选文件调用会直接报错
 *   · tsconfig 用了默认别名 —— import 指向了错的文件
 *
 * <p>这些如果只混在一句 note 里（用 · 拼起来），
 * 模型会当成正常信息，直接交付一份功能残缺的项目 ——
 * 「编译通过了」这句话就成了假消息。
 *
 * <p>所以：致命警告必须让 ok=false，环境限制（外部资源需联网之类）
 * 只当提示。全当失败会让 AGENT 为改不了的问题反复重试；
 * 全当成功等于把坏代码当成好的交出去。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const compiler=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/LocalCompiler.java'),'utf8');
const runner=fs.readFileSync(path.join(root,'assets/local-runner.js'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 警告要单独输出，不能只混在 note 里 ───────────');
check(/warnings:\[\.\.\.warnings\]/.test(runner),
 'the compiler emits warnings as a separate array');
check(/note:\[count\?'JS\/TSX 已编译':'静态网页',\.\.\.warnings\]\.join\(' · '\)/.test(runner),
 'the note still carries the human-readable summary');

console.log('\n── 致命警告与环境提示要分开 ─────────────────────');
check(/static boolean isFatalWarning\(String w\)/.test(compiler),
 'a helper classifies warnings');
const fatalBody=(compiler.match(/static boolean isFatalWarning\(String w\)\{[\s\S]*?\n \}/)||[''])[0];
check(/源码适配失败/.test(fatalBody),'a failed source adapter is fatal');
check(/tsconfig/.test(fatalBody),'a wrong path alias is fatal');
// 环境限制不该算致命
check(!/外部资源需手动开启联网/.test(fatalBody),
 'an offline-only resource hint is not fatal');
check(!/未执行 Vite 插件/.test(fatalBody),
 'a skipped vite plugin is not fatal');

console.log('\n── 致命警告必须让检查失败 ───────────────────────');
check(/fatal\.length\(\)==0/.test(compiler),
 'ok is false when there is a fatal warning');
check(/put\("fatalWarnings",fatal\)/.test(compiler),
 'the fatal warnings are returned separately');
check(/put\("hints",hints\)/.test(compiler),
 'the environment hints are returned separately');
check(/编译完成但有必须修的问题/.test(compiler),
 'the error message says what is actually broken');
check(/put\("warnings",all==null\?new JSONArray\(\):all\)/.test(compiler),
 'all warnings are still returned, nothing is hidden');

console.log('\n── 编译真的失败时依然要报错 ─────────────────────');
check(/catch\(Exception e\)\{return new JSONObject\(\)\.put\("ok",false\)\.put\("error",e\.getMessage\(\)\)/.test(compiler),
 'a real compile exception still returns ok=false with the error');

console.log('\n── check_project 走的是同一条路 ─────────────────');
const tools=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/LocalDevTools.java'),'utf8');
check(/case "check_project":return LocalCompiler\.check\(a,staged\);/.test(tools),
 'the check_project tool goes through the same check');
check(/case "run_preview"/.test(tools),
 'the preview tool still exists');

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (compile_warnings_test) '+pass+' 项');
