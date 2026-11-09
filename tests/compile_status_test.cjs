/*
 * 编译失败不能显示成成功。
 *
 * <p>自动验证编译失败时，结果里带的是 {ok:false, error:"..."}，
 * 不是 toolCalls 的 error 字段。原来按「有没有 error 字段」判成功，
 * 于是编译明明没过，工具记录里却写着 ok:true ——
 * 用户看到「验证编译 通过」，装到手机上才发现跑不起来。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const main=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/MainActivity.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 编译失败要显示为失败 ───────────────────────────────');

const i=main.indexOf('JSONArray toolCallSummary(');
check(i>0,'the tool call summary exists');
const seg=main.slice(i,i+2600);

check(/res\.has\("ok"\)/.test(seg),
 'the summary looks at the result\'s own ok field');

check(/brief\.put\("ok",res\.optBoolean\("ok",false\)\)/.test(seg),
 'the summary takes ok from the compile result');

check(/编译检查没通过/.test(seg),
 'a failed compile says so instead of staying silent');

check(/brief\.put\("error"/.test(seg),
 'a failed compile carries the error text through');

// 不能因为改了就丢掉原本的错误字段
check(/c\.optString\("error",""\)/.test(seg),
 'tool errors are still reported');

// UI 文案要跟实际轮数一致
const app=fs.readFileSync(path.join(root,'assets/app.js'),'utf8');
check(/每轮最多40次工具循环/.test(app),
 'the UI says the real round limit');
check(!/每轮最多6次工具循环/.test(app),
 'the old round limit is gone from the UI');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
