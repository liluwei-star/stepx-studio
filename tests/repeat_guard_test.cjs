/*
 * 模型原地打转时，得有人拦住它。
 *
 * <p>熔断只管「整轮全败」。但模型最常见的空转不是失败，是<b>成功</b>：
 * 读同一个文件、搜同一个词，一遍又一遍，每轮都好好的。
 * 熔断永远不触发，40 轮就这么烧完，用户等几分钟，文件一个字没改。
 *
 * <p>所以按「工具名 + 参数」记住上一次的结果：连续两次拿到一模一样的结果，
 * 说明这次调用没带来任何新信息。第三次起不再重复贴全文，只回一句
 * 「结果和上次一样」—— 既省 token（大文件全文贴三遍能吃掉一整轮预算），
 * 又明确告诉模型该换做法了。
 *
 * <p>为什么不能只看参数判重复：改完文件再读同一个文件，参数一样但结果变了，
 * 那是完全正常的行为。按结果判断才不会误伤。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const tools=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/LocalDevTools.java'),'utf8');
const agent=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/DevAgent.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 原地打转要拦住 ─────────────────────────────────');

check(/JSONObject callOnce\(String name,JSONObject args\)/.test(tools),
 'there is a wrapper that watches for repeated calls');

check(/static boolean isReadOnly\(String n\)/.test(tools),
 'only read-only tools are watched');

check(/if\(now\.equals\(prev\)\)/.test(tools),
 'repetition is judged by the result, not by the arguments');

check(/unchanged/.test(tools),
 'a repeated call returns a marker instead of the whole payload');

check(/已经连续拿到 /.test(tools),
 'the model is told how many identical results it has seen');

check(/请换个做法/.test(tools),
 'the model is told to change approach');

check(/startLine\/lineCount 分段读/.test(tools),
 'the model is told how to get the full text if it really needs it');

check(/repeatHint/.test(tools),
 'the first repeat already carries a soft hint');

// 两条路径都得走 callOnce，不能有一条漏掉
check(/tools\.callOnce\(name,args\)/.test(agent),
 'the native path goes through callOnce');
check(/tools\.callOnce\(name,q\.optJSONObject\("args"\)/.test(agent),
 'the fallback path goes through callOnce');
check(!/tools\.call\(name/.test(agent),
 'no path still calls the unwrapped version');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
