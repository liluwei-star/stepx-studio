/*
 * 模型得知道自己在看什么项目。
 *
 * <p>提示词里写着：「用户问『你能看到这个项目吗』，第一句就该是
 * 『能，有 318 个文件，是 Vite + React』」。
 *
 * <p>可模型<b>根本不知道</b>项目有 318 个文件 —— 项目概览从来没进过上下文。
 * 于是只剩两条路：先调 list_files（违背「先回答问题」，用户要等一轮才看到
 * 第一句话），或者<b>编一个数字</b>。
 *
 * <p>后者更糟：那是在骗用户。
 *
 * <p>所以项目概览必须像记忆、技能清单一样，每轮自动带进系统提示词，
 * 而且要反映<b>当前</b>状态 —— AI 改完文件新增了文件，概览也得跟着变。
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

console.log('\n── 概览要能从项目算出事实 ───────────────────────');
check(/static String overview\(JSONObject project\)/.test(tools),
 'there is an overview builder');
check(/project\.optJSONObject\("files"\)/.test(tools),
 'the overview reads the real file map');
check(/append\(count\)\.append\(" 个文件。"/.test(tools),
 'the overview states the real file count');
check(/files\.has\("index\.html"\)/.test(tools),
 'the overview finds the entry file');
check(/"package\.json"/.test(tools),
 'the overview looks at package.json');
check(/顶层分布/.test(tools),
 'the overview describes the top-level layout');

console.log('\n── 概览不能塞爆提示词 ─────────────────────────');
check(/Math\.min\(deps\.size\(\),20\)/.test(tools),
 'the dependency list is capped');
check(/shown\+\+>=8/.test(tools),
 'the directory list is capped');

console.log('\n── 没有项目时不能编内容 ───────────────────────');
check(/if\(project==null\)return "";/.test(tools),
 'no project means no overview');

console.log('\n── 提示词不再教模型编数字 ─────────────────────');
/* 318 只允许出现在解释问题的注释里，提示词正文中不能有 */
const promptBody=tools.slice(tools.indexOf('static String instructions(boolean'));
check(!/当前项目有 318 个文件/.test(promptBody),
 'the made-up example number is gone from the prompt');
check(!/有 318 个文件，是 Vite \+ React/.test(promptBody),
 'the made-up second example is gone from the prompt');
check(/有 42 个文件/.test(promptBody),
 'the prompt shows a concrete example instead');
check(/不要凭印象报数字/.test(tools),
 'the prompt tells the model not to guess numbers');
check(/不要凭空编一个数字/.test(tools),
 'the prompt tells the model not to invent numbers');

console.log('\n── 每轮都要带最新的概览 ───────────────────────');
check(/OVERVIEW_SLOT/.test(agent),
 'the system prompt carries an overview slot');
check(/systemTemplate\.replace\(OVERVIEW_SLOT,LocalDevTools\.overview\(/.test(agent),
 'the slot is filled in before each request');
check(/tools\.staged!=null\?tools\.staged:project/.test(agent),
 'the overview reads the staged area, not the original project');
const reqs=[...agent.matchAll(/client\.request\(/g)];
check(reqs.length>=2,'there are request call sites');
const agentBody=agent.slice(agent.indexOf('static JSONObject run('));
check(!/client\.request\(profile,key,messages,system,/.test(agentBody),
 'no request goes out with the unfilled system prompt');

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (project_overview_test) '+pass+' 项');
