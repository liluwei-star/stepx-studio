/*
 * 降级到文本 JSON 协议时，模型必须真的收到「协议更正」。
 *
 * <p>原来那句更正拼在 {@code system} 上，而每轮实际发的是
 * {@code systemTemplate} 派生的 {@code systemNow}。更正从来没进过请求，
 * 于是降级后模型收到的还是原生协议说明（要它直接调工具、别写 JSON），
 * 而服务端只认 JSON —— 模型照原生规矩来，正文里不写工具请求，
 * 一条工具都没跑起来，整轮白跑。
 *
 * <p>这个测试直接检查「更正落在真正被发送的那个字符串上」。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const src=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/DevAgent.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 降级协议更正要真的发出去 ───────────────────────');

// 找出降级分支的位置
const degradeAt=src.indexOf('looksLikeToolsUnsupported(e)){');
check(degradeAt>0,'the downgrade branch exists');

const branch=src.slice(degradeAt,degradeAt+3000);

// 更正不能再拼到裸的 system 上
check(!/system\+="\\n\\n【协议更正】/.test(branch),
 'the correction is not appended to the bare system string');

// 必须落在 systemTemplate 上
check(/systemTemplate=systemTemplate\+"\\n\\n【协议更正】/.test(branch),
 'the correction is appended to systemTemplate, which is what actually gets sent');

// 降级重试必须用重算过的模板，不能用旧的 systemNow
check(/client\.request\(profile,key,messages,degradedSystem,debug,null\)/.test(branch),
 'the retry sends the recomputed degraded system, not the stale one');

// systemNow 每轮从 systemTemplate 重算，所以改模板后续轮自动生效
check(/String systemNow=systemTemplate\.replace\(OVERVIEW_SLOT/.test(src),
 'systemNow is recomputed from systemTemplate every round');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
