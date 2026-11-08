/*
 * 模型不写字的时候，用户不该对着空白等。
 *
 * <p>模型调完工具直接结束、正文留空，是很常见的行为 ——
 * 一些模型在有 tool_calls 的轮次里根本不写 content。
 *
 * <p>原来的代码走到最后直接 {@code return response}，text 就是空串。
 * 用户点一次发送、等了两分钟，屏幕上什么都没有：
 * 不知道是出错了、卡住了，还是活干完了。只能再点一次，白花一次钱。
 *
 * <p>所以必须有兜底：按<b>实际发生了什么</b>说一句人话 ——
 * 改了几个文件、编译过没过、有没有工具失败。
 * 不替模型编解释，但也不让用户对着空白发呆。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const agent=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/DevAgent.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 空回复要有兜底 ─────────────────────────────────');

check(/static String summaryText\(JSONObject response,JSONArray trail\)/.test(agent),
 'there is a helper that writes a summary from what actually happened');

check(/if\(response\.optString\("text",""\)\.trim\(\)\.isEmpty\(\)\)\{\s*response\.put\("text",summaryText\(response,trail\)\);\s*\}/.test(agent),
 'an empty reply is filled before returning');

check(/已经改好 /.test(agent),
 'the summary names how many files changed');

check(/编译检查通过/.test(agent),
 'the summary reports a passing compile');

check(/编译检查没通过/.test(agent),
 'the summary reports a failing compile');

check(/次工具调用出错/.test(agent),
 'the summary reports failed tool calls');

check(/模型这一轮没有输出文字/.test(agent),
 'a round with nothing at all still says something');

// 兜底必须在导出 stagedFiles 之后，否则数不到改动
const stagedAt=agent.indexOf('response.put("stagedFiles"');
const summaryAt=agent.indexOf('response.put("text",summaryText(response,trail))');
check(stagedAt>0&&summaryAt>stagedAt,
 'the summary runs after the changed files are exported');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
