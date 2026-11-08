/*
 * 模型参数写坏了，必须让它知道是参数坏了。
 *
 * <p>原来的写法：
 *
 * <pre>
 * try { args = new JSONObject(rawArgs); }
 * catch (Exception e) { args = new JSONObject(); }
 * </pre>
 *
 * <p>静默变成空对象。于是：
 *   1. 工具拿着 {} 去执行，报一句「path 不能为空」；
 *   2. 模型收到的是<b>工具层的错</b>，它以为自己参数发对了，只是路径不对；
 *   3. 下一轮照原样再发一次 —— 一直转到 40 轮跑满。
 *
 * <p>这是「助手明明能用却总在原地打转」最典型的一种成因：
 * 错误信息传错了对象，模型永远学不会。
 *
 * <p>正确做法有三层：
 *   1. 先试着补全（被 max_tokens 截断时多半只差收尾括号）；
 *   2. 补不回来就把<b>原文</b>交回给模型，明说「不是合法 JSON，工具没被调用」；
 *   3. 历史里回传模型自己发过的原文，不能回传解析后的空对象 ——
 *      否则模型在历史里看到自己「发过空参数」，跟记忆对不上，会更困惑。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const stream=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/StreamResponse.java'),'utf8');
const agent=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/DevAgent.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 参数坏了要说清楚 ───────────────────────────────');

check(!/catch\(Exception e\)\{args=new JSONObject\(\);\}/.test(stream),
 'a broken argument string is no longer silently swallowed');

check(/static String repairTruncatedJson\(String raw\)/.test(stream),
 'there is a repair step for truncated JSON');

check(/argsError/.test(stream),
 'the raw text is kept when parsing fails');

check(/argsRepaired/.test(stream),
 'a repaired call is marked as repaired');

check(/String argsError=call\.optString\("argsError",""\)/.test(agent),
 'the agent reads the argument error');

check(/工具没有被调用/.test(agent),
 'the model is told the tool was not called at all');

check(/请重新输出一遍完整、合法的 JSON 参数/.test(agent),
 'the model is told how to fix it');

check(/分成几步写/.test(agent),
 'a truncated long payload is answered with "write it in steps"');

check(/argsRepaired/.test(agent),
 'a repaired call tells the model its payload was cut off');

// 历史回传必须是原文
check(/String argsText=call\.optString\("argsError",""\)/.test(agent),
 'the history replays the raw arguments, not the empty object');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
