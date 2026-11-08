/*
 * AGENT 失败恢复：错误消息必须让模型能自我纠正。
 *
 * <p>AGENT 和普通聊天机器人的分界线就在这儿：
 * 工具失败之后，模型能不能从错误里读出「下一步该干什么」。
 *
 * <p>三个具体的坑：
 * <ul>
 *   <li>工具名拼错 → 只说「不支持」→ 模型不知道正确名字，只能再猜 → 三轮熔断</li>
 *   <li>文件路径写错 → 只说「文件不存在」→ 模型不知道有哪些文件，只能瞎试</li>
 *   <li>搜索没命中 → 返回空数组 → 模型以为项目里没这段代码，得出错误结论</li>
 * </ul>
 *
 * <p>这三处修完，模型才有可能「失败一次就改对」，
 * 而不是「失败一次就卡死」。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const src=p=>fs.readFileSync(path.join(root,p),'utf8');
const tools=src('src/cn/com/scsxrkj/LocalDevTools.java');
const schema=src('src/cn/com/scsxrkj/ToolSchema.java');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 工具名写错时给出可用清单 ─────────────────────');
check(tools.includes('可用工具：'),
 'the unknown-tool error lists the available tools');
check(tools.includes('availableToolNames()'),
 'a helper provides the tool name list');
check(/static String availableToolNames\(\)/.test(tools),
 'the helper is declared as a static method');
// 清单必须真的来自 schema，不能写死一份会过期的列表
check(/for\(ToolSchema\.Tool st:ToolSchema\.all\(\)\)/.test(tools),
 'the tool list is generated from the schema, not hardcoded');
check(tools.includes('请从上面这些名字里选一个'),
 'the error tells the model how to recover');

console.log('\n── 文件路径写错时给出文件清单 ─────────────────────');
check(tools.includes('fileMissingMessage(path,files)'),
 'read_file reports a missing file through the new helper');
check(/static String fileMissingMessage\(String path,JSONObject files\)/.test(tools),
 'the helper is declared as a static method');
check(tools.includes('本项目现有文件：'),
 'the message names the files that do exist');
check(tools.includes('路径要完全一致'),
 'the message says the path has to match exactly');
// 清单必须有上限，否则大项目会把提示词撑爆
check(tools.includes('if(n>=40)'),
 'the file list is capped so the prompt cannot blow up');

console.log('\n── 搜索没命中时给出明确说明 ─────────────────────');
check(tools.includes('out.put("found",false)'),
 'a miss is reported explicitly');
check(tools.includes('搜索词'),
 'the message quotes the query that was searched');
check(tools.includes('searchedFiles'),
 'the message reports how many files were searched');
check(tools.includes('list_files'),
 'the message suggests a way to find the right file');

console.log('\n── 这些修复不能互相打架 ─────────────────────');
// 三处 helper 都要被真正调用，不能只定义不用
const helperCalls=(tools.match(/fileMissingMessage\(/g)||[]).length;
check(helperCalls>=2,'fileMissingMessage is both defined and called (found '+helperCalls+')');
const nameCalls=(tools.match(/availableToolNames\(\)/g)||[]).length;
check(nameCalls>=2,'availableToolNames is both defined and called (found '+nameCalls+')');

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (tool_recovery_test) '+pass+' 项');
