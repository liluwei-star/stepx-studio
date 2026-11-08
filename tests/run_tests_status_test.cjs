/*
 * 「没有测试文件」不等于「测试通过」。
 *
 * <p>test-runner.js 原来在没有测试文件时写 {@code ok:true} ——
 * 理由大概是「没失败就是成功」。
 *
 * <p>但模型看到 ok:true 就会说「测试通过了」，而实际一个用例都没跑。
 * 这是<b>假阳性</b>，比明确报错更糟：它让人以为验证过了。
 *
 * <p>所以 ok 必须是 false，同时用 {@code ran:false} 说清「是没得跑」，
 * 让模型能把它和「跑挂了」区分开 —— 不区分的话，模型会去反复修一个没坏的东西。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const runner=fs.readFileSync(path.join(root,'assets/test-runner.js'),'utf8');
const java=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/ScriptRunner.java'),'utf8');
const schema=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/ToolSchema.java'),'utf8');
const tools=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/LocalDevTools.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 没有测试文件时不能报成功 ─────────────────────');
const emptyBranch=(runner.match(/if\(!testFiles\.length\)\{[\s\S]*?\n \}/)||[''])[0];
check(emptyBranch.length>0,'the no-test-file branch exists');
check(/ok:false/.test(emptyBranch),'ok is false when there is nothing to run');
check(/ran:false/.test(emptyBranch),'ran is false when there is nothing to run');
check(/passed:0,failed:0/.test(emptyBranch),'the counters are zero');
/* 注释里会提到「原来这里写的是 ok:true」，所以只看真正的赋值行 */
const emptyCode=emptyBranch.split('\n').filter(l=>!/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
check(!/ok:true/.test(emptyCode),'ok is never true in the empty branch');
check(/ok:false/.test(emptyCode),'the empty branch really assigns ok:false');
check(/不等于测试通过/.test(emptyBranch),'the note says this is not a pass');

console.log('\n── 跑过了才标 ran:true ─────────────────────────');
check(/ran:true/.test(runner),'a real run is marked ran:true');
check(/ok:failed===0&&errors\.length===0/.test(runner),
 'a real run is ok only when nothing failed and nothing broke');

console.log('\n── Java 侧要说清「没跑」不是「挂了」 ──────────────');
check(/未运行任何测试/.test(java),
 'the summary says nothing was run');
check(/这不是测试失败，是项目里没有测试文件/.test(java),
 'the summary distinguishes the two cases');
check(/共 \"/.test(java)||/共 \\\\"/.test(java)||java.includes('共 "'),
 'the summary reports the real pass count');

console.log('\n── 提示词和 schema 都要教模型区分 ───────────────');
check(/ran 是 false/.test(tools),'the prompt explains the ran flag');
check(/ran 是 false/.test(schema),'the tool description explains the ran flag');
check(/别当成代码有问题去反复改/.test(tools),
 'the prompt tells the model not to chase a phantom bug');

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (run_tests_status_test) '+pass+' 项');
