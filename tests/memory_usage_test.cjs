/*
 * 提示词说「会告诉你用量」，那就得真的告诉。
 *
 * <p>原来的提示词里写着：
 * <pre>
 *   update_memory(content, scope)：…… 条目太乱或者快满了
 *   （每轮提示词末尾会告诉你用量）时用它整理。
 * </pre>
 *
 * <p>可代码里从来没注入过任何用量 —— 这是一句空头承诺。
 *
 * <p>代价很实在：模型不知道还剩多少空间，只能照常 remember，
 * 撞到上限拿到「超过上限，请再精简」，再猜着删一点、再试一次，
 * 来回好几轮才把一句话存进去。用户看到的是「AI 记个东西都费劲」。
 *
 * <p>给出具体数字之后，模型能主动整理，而不是被动挨报错。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const mem=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/AiMemory.java'),'utf8');
const agent=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/DevAgent.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 记忆用量要真的告诉模型 ─────────────────────────');

check(/String usageFor\(String projectId\)/.test(mem),
 'AiMemory can describe how full the memory is');

check(/GLOBAL_CAP/.test(mem)&&/PROJECT_CAP/.test(mem),
 'the usage line uses the real caps');

check(/记忆用量/.test(mem),
 'the usage line has a heading the model can recognise');

check(/快满了，用 update_memory 整理压缩/.test(mem),
 'it tells the model what to do when nearly full');

check(/a\.memory\.usageFor\(projectId\)/.test(agent),
 'the usage line is injected into the system prompt every round');

// 空记忆不该白占 token
check(/if\(g==0&&\(p<=0\)\)return "";/.test(mem),
 'an empty memory adds nothing to the prompt');

// 注入位置必须在 contextFor 之后（先给内容，再给用量）
const ctxAt=agent.indexOf('a.memory.contextFor(projectId)');
const usageAt=agent.indexOf('a.memory.usageFor(projectId)');
check(ctxAt>0&&usageAt>ctxAt,
 'the usage line follows the memory contents');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
