/*
 * 推给前端的 AI 回复必须是瘦身的。
 *
 * <p>这一条是 OOM 的同一条路径，只是换了入口。
 *
 * <p>DevAgent 返回的 toolCalls 里存着工具的<b>完整结果</b> ——
 * read_file 读回来的整个文件就在里面。edit 已经瘦身了，
 * 但 toolCalls 漏了，于是每次 AI 回复都往 WebView 灌几 MB 字符串。
 * 一次对话几十轮，手机的堆就撑不住了。
 *
 * <p>前端只用 toolCalls 渲染一个可折叠的 JSON 列表，
 * 根本不读内容 —— 所以只留摘要就够。
 *
 * <p>但有个连带问题：判断「这轮画了图」用的是
 * {@code call.has("result")}，摘要里没有 result 字段。
 * 所以这个判断必须在瘦身<b>之前</b>做，结果用布尔字段带过去。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const main=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/MainActivity.java'),'utf8');
const app=fs.readFileSync(path.join(root,'assets/app.js'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── reply 事件里的 toolCalls 必须瘦身 ─────────────');
/* 找到 event("reply",...) 之前的那一段 */
const idx=main.indexOf('event("reply",result)');
check(idx>0,'the reply event exists');
const before=main.slice(Math.max(0,idx-4000),idx);
check(/result\.put\("toolCalls",toolCallSummary\(/.test(before),
 'the tool calls are summarised before being pushed');
check(!/result\.put\("toolCalls",result\.optJSONArray/.test(before),
 'the raw tool calls are not pushed as-is');

console.log('\n── 「画了图」的判断要在瘦身前 ───────────────────');
/* drewImage 的计算必须在 toolCallSummary 之前 */
const drewIdx=before.indexOf('result.put("drewImage"');
const sumIdx=before.indexOf('result.put("toolCalls",toolCallSummary');
check(drewIdx>0,'the drewImage flag is computed');
check(sumIdx>0,'the summary is applied');
check(drewIdx<sumIdx,'the flag is computed BEFORE the summary strips the result');
/* 判断写在循环里，位置在 drewImage 标记之前 —— 那段循环要读原始记录 */
const loopStart=before.lastIndexOf('JSONArray rawCalls=',sumIdx);
const loop=before.slice(loopStart,sumIdx);
check(/rawCalls\.optJSONObject\(i\)/.test(loop),
 'the flag reads the raw tool calls');
check(/c\.has\("result"\)/.test(loop),
 'the flag still looks at the raw result');
check(loopStart>=0&&loopStart<drewIdx,
 'the raw-read loop sits before the summary is applied');

console.log('\n── 后面用这个标志，不再翻原始记录 ───────────────');
const after=main.slice(idx,idx+4000);
check(/completed\.optBoolean\("drewImage",false\)/.test(after),
 'the image check reads the flag');
check(!/calls\.getJSONObject\(i\)\.has\("result"\)/.test(after),
 'the image check no longer reads the stripped records');
check(!/JSONArray calls=completed\.optJSONArray\("toolCalls"\)/.test(after),
 'the dead variable is gone');

console.log('\n── 前端确实不需要全文 ───────────────────────────');
check(/JSON\.stringify\(m\.toolCalls,null,2\)/.test(app),
 'the frontend only renders the tool calls as JSON');
check(!/toolCalls[^]{0,80}\.result\b/.test(app)||!/m\.toolCalls\?\..*\.result/.test(app),
 'the frontend does not read a result field out of tool calls');

console.log('\n── 存 state 的路径早就该是摘要 ───────────────────');
check(/put\("toolCalls",toolCallSummary\(result\.optJSONArray\("toolCalls"\)\)\)/.test(main),
 'the state save path uses the summary');

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (reply_slim_test) '+pass+' 项');
