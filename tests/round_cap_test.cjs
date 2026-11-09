/*
 * 跑满轮数不该把已经做好的活丢掉。
 *
 * <p>MainActivity 里原来写的是：
 * {@code if(cancelled || incomplete) throw ...}
 *
 * <p>两者一起拒掉。但 incomplete 有两个来源：
 *   · 用户中途取消 —— 该丢（他不要这个结果了）
 *   · 跑满 40 轮工具循环 —— <b>不该丢</b>
 *
 * <p>跑满轮数时丢掉有多亏：一个要改十几个文件的任务，
 * 前面 39 轮读文件、改文件、编译都真做了，第 40 轮被上限截住，
 * 结果一个字都没落盘，用户白等几分钟。
 *
 * <p>而且工具调用是独立的 API 字段，不受 text 截断影响 ——
 * 也就是说暂存区里的改动是完整的，丢掉它没有任何技术理由。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const main=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/MainActivity.java'),'utf8');
const agent=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/DevAgent.java'),'utf8');
const tools=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/LocalDevTools.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 只有取消才丢弃改动 ───────────────────────────');
check(/static boolean shouldRejectWrite\(boolean cancelled,boolean incomplete\)/.test(main),
 'the decision is in a testable method');
check(/return cancelled;/.test(main),
 'only an explicit cancel rejects the write');
check(!/return cancelled\|\|incomplete;/.test(main),
 'a round that hit the cap no longer rejects the write');
check(/shouldRejectWrite\(client\.cancelled/.test(main),
 'the call site uses the helper');
check(/if\(client\.cancelled\)throw new Exception\("已取消，没有写入文件"\)/.test(main)===false,
 'the old blanket throw is gone');

console.log('\n── 没做完要说清楚，但改动要留下 ─────────────────');
check(/edit\.put\("partial",true\)/.test(main),
 'the edit is marked as partial');
check(/partialNote/.test(main),
 'the partial edit explains itself');
check(/仍然写回/.test(main),
 'the note says the changes are kept');

console.log('\n── 上限提示不能说错 ─────────────────────────────');
/* 那句错话在注释里被引用了（作为「原来写的是」的对照），所以只看实际赋值的文案 */
/*
 * 上限提示现在走 appendNotice（追加，不是覆盖），所以匹配整块 if 语句。
 * 原来只匹配单行的 response.put(...).put("text", ...)。
 */
const limitText=(agent.match(/if\(round==MAX_ROUNDS-1\)[\s\S]{0,900}?appendNotice\([\s\S]{0,600}?\);\}/)||[''])[0];
check(limitText.length>0,'the limit message exists');
check(!/本轮未写回/.test(limitText),'the limit message no longer claims nothing was written');
check(/已经改好的文件仍然会写回项目/.test(agent),
 'the limit message says the changes are written back');
check(/要接着做请再发一条消息/.test(agent),
 'the limit message tells the user how to continue');
/* 原生路径以前根本没有上限提示 —— 现在两条路径都要有 */
const limitBlocks=(agent.match(/if\(round==MAX_ROUNDS-1\)/g)||[]).length;
check(limitBlocks>=2,
 '原生路径和降级路径都有轮数上限提示（实际 '+limitBlocks+' 处）');

console.log('\n── 提示词不要说假话 ─────────────────────────────');
check(!/轮数不限/.test(tools),
 'the prompt no longer claims unlimited rounds');
check(/最多可以连续调用工具 40 次/.test(tools),
 'the prompt states the real limit');
check(/工具调用最多 40 轮/.test(tools),
 'the no-project prompt states the real limit too');
check(/已达到本轮 \"\+MAX_ROUNDS\+\" 次工具调用循环上限/.test(agent),
 'the limit the agent enforces is the limit it advertises');
check(/static final int MAX_ROUNDS = 40;/.test(agent),
 'the enforced limit is 40');

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (round_cap_test) '+pass+' 项');
