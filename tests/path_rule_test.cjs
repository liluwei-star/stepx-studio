/*
 * 路径规则只能有一份。
 *
 * <p>之前 ProjectEdits.validate 和 CloudFiles.path 各写各的：
 *
 * <ul>
 *   <li>本地的正则 {@code [\p{L}\p{N}_-][\p{L}\p{N} ._/-]{0,199}}
 *       放行 {@code a//b}（中间空段）、放行 200~240 字符的路径</li>
 *   <li>云端的 CloudFiles.path 拒绝空段、限制 240 字符</li>
 * </ul>
 *
 * <p>结果就是：本地存进去的东西同步不出去。用户看到的只有
 * 「同步不包含此路径」—— 不知道是哪个文件，也不知道为什么。
 *
 * <p>而且方向是反的：应该由更严的那套说了算。
 *
 * <p>所以本轮改动的路径统一用 CloudFiles.path 过一遍。
 * 只查本轮改动、不查项目原有的 —— 老项目里本来就有几个怪路径的话，
 * 不该让 AI 从此再也改不动它。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const edits=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/ProjectEdits.java'),'utf8');
const cloud=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/CloudFiles.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 云端那套标准本身要够严 ───────────────────────');
const pathFn=(cloud.match(/static boolean path\(String p\)\{[\s\S]*?return true;\}/)||[''])[0];
check(pathFn.length>0,'CloudFiles.path exists');
check(/isEmpty\(\)\|\|s\.equals\("\."\)\|\|s\.equals\("\.\."\)/.test(pathFn),
 'an empty segment, a dot and a double-dot are all rejected');
check(/startsWith\("\/"\)/.test(pathFn),
 'an absolute path is rejected');
check(/length\(\)>240/.test(pathFn),
 'the path length is capped');
check(/x00/.test(pathFn)&&/x1f/.test(pathFn),
 'control characters are rejected');

console.log('\n── 本轮改动的路径必须走云端那套标准 ─────────────');
check(/CloudFiles\.path\(cn\)/.test(edits),
 'the changed paths go through CloudFiles.path');
check(/路径不合法（不能以 \/ 开头/.test(edits),
 'the error explains what is wrong with the path');
check(/路径不合法（不能以 \/ 开头[^"]*："\+cn/.test(edits),
 'the error names the offending file');

console.log('\n── 只查本轮改动，不查项目原有的 ─────────────────');
/*
 * 校验现在住在 mergeChecked 里：apply（提交）和 stage（暂存）都调它。
 * 这样提交和暂存走的是同一套规则，不会各写一份又慢慢跑偏。
 */
const applyIdx=edits.indexOf('static JSONObject apply(');
check(applyIdx>0,'apply exists');
check(/static JSONObject mergeChecked\(/.test(edits),'mergeChecked exists');
const checkIdx=edits.indexOf('static JSONObject mergeChecked(');
check(checkIdx>0,'the shared validation path exists');
check(/apply\([^)]*\)[^{]*\{[\s\S]{0,400}?mergeChecked\(/.test(edits),
 'apply goes through mergeChecked');
check(/static void stage\(JSONObject project,JSONObject changes\)[\s\S]{0,400}?mergeChecked\(/.test(edits),
 'stage goes through mergeChecked too');

const mergeBody=edits.slice(checkIdx, edits.indexOf('static JSONObject apply('));
check(/for\(Iterator<String> ci=changes\.keys\(\);ci\.hasNext\(\);\)/.test(mergeBody),
 'the strict check iterates over the changes');
check(!/for\(Iterator<String> ci=next\.keys\(\)/.test(mergeBody),
 'the strict check does not iterate over the whole project');

console.log('\n── 校验发生在落盘之前 ───────────────────────────');
const pathIdxInMerge=mergeBody.indexOf('CloudFiles.path(cn)');
check(pathIdxInMerge>0,'the path check exists');
check(/return next;/.test(mergeBody),'the merge returns the checked file table');
check(pathIdxInMerge < mergeBody.indexOf('return next;'),
 'the path check runs BEFORE the file table is handed back');

console.log('\n── 删除操作也要过路径校验 ───────────────────────');
/* changes 里的 NULL 表示删除，仍在 changes 里，会被查到 */
check(/for\(Iterator<String> ci=changes\.keys\(\)/.test(mergeBody),
 'deletions travel in the same changes object, so they are checked too');

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (path_rule_test) '+pass+' 项');
