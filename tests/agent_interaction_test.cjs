/*
 * AGENT 交互行为测试。
 *
 * <p><b>测的是什么：</b>用户问「你能看到打开的项目吗」，一个正常的 AGENT
 * 应该先直接回答这个问题，再（如果需要）去调工具。
 * 而改造前，模型把「完成一次工具调用」当成了「回答用户」——
 * 屏幕上只有一排折叠条和一句「已保存到指定项目」，问题本身没被回答。
 *
 * <p>这里用 fixture 模拟三种真实模型行为，断言 Studio 的处理是对的：
 *
 * <ol>
 *   <li>模型直接回答（没调工具）→ 正文必须完整显示</li>
 *   <li>模型先说一句再调工具 → 那句话必须保留，不能被工具记录挤掉</li>
 *   <li>模型调完工具后说人话 → 人话必须在正文里，不能只在 JSON 里</li>
 * </ol>
 *
 * 运行：node tests/agent_interaction_test.cjs
 */
const fs=require('fs');
const path=require('path');

const root=process.cwd();
function readSrc(rel){
  try{return fs.readFileSync(path.join(root,rel),'utf8');}
  catch(e){return fs.readFileSync(path.resolve(__dirname,'..',rel),'utf8');}
}

let passed=0;const failures=[];
function check(cond,name,extra){
  if(cond){passed++;console.log('  PASS  '+name);}
  else{failures.push(name+(extra?' — '+extra:''));console.log('  FAIL  '+name+(extra?' — '+extra:''));}
}

/* ── 抽出前端的正文渲染函数 ─────────────────────────── */
const appJs=readSrc('assets/app.js');
const start=appJs.indexOf('function aiMessageBody(m)');
check(start>=0,'能定位 aiMessageBody');
let bodySrc=appJs.slice(start);
const nextFn=bodySrc.indexOf('\nfunction ');
if(nextFn>0)bodySrc=bodySrc.slice(0,nextFn);

function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
let render=null;
try{render=new Function('esc',bodySrc+'; return aiMessageBody;')(esc);}
catch(e){failures.push('aiMessageBody 执行失败: '+e.message);console.log('  FAIL  执行失败 — '+e.message);}

console.log('\n[1] 直接回答的场景（模型没调工具）');
if(render){
  const r=render({content:'能。当前项目有 318 个文件，用的是 Vite + React 19 + TypeScript + Tailwind 3。'});
  check(r.includes('能。当前项目有 318 个文件'),'回答完整显示');
  check(r.includes('Vite + React 19'),'技术栈信息没被截断');
  check(!r.includes('<details'),'没有多余的折叠块');
}

console.log('\n[2] 模型先说一句再调工具');
if(render){
  /*
   * 降级路径下，模型可能回「我先看下项目结构」+ JSON。
   * 这句话是给用户看的，不能被 JSON 剥掉。
   */
  const r=render({content:'我先看下项目结构。\n{"tools":[{"name":"list_files","args":{}}]}'});
  check(r.includes('我先看下项目结构'),'模型的开场白保留了下来');
  check(!r.includes('"tools"'),'工具参数 JSON 没有甩给用户看');
}

console.log('\n[3] 模型调完工具说人话');
if(render){
  const r=render({content:'我看完了：src 下面有 3 个文件，其中 main.js 是入口。'});
  check(r.includes('src 下面有 3 个文件'),'工具之后的结论显示出来了');
  check(r.includes('main.js 是入口'),'结论的细节完整');
}

console.log('\n[4] 回答 + 文件改动同时存在');
if(render){
  /*
   * 真实场景：模型先答了问题，又顺手改了文件。
   * 正文里可能同时有人话和 files JSON —— 人话要留下。
   */
  const r=render({content:'看到了，是个 Vite 项目。我把标题改成了「会议助手」。\n{"summary":"改了标题","files":{"index.html":"<title>会议助手</title>"}}'});
  check(r.includes('看到了，是个 Vite 项目'),'回答部分保留');
  check(r.includes('改了标题')||r.includes('会议助手'),'改动的说明也能看到');
  check(!r.includes('index.html\\":'),'文件内容没有甩给用户');
}

console.log('\n[5] 后端：最终文本和改动分开存');
const main=readSrc('src/cn/com/scsxrkj/MainActivity.java');
check(main.includes('.put("content",result.optString("text"))'),'正文存的是模型的人话回复');
check(main.includes('.put("edit",editForStore('),'改动单独存到 edit 字段');
/*
 * 这里必须是 editForStore 而不是旧的 editSummary。
 * editSummary 会把 files 换成 changedFiles，前端「审查并应用」就点不开了。
 */
check(!main.includes('editSummary'),'旧的 editSummary 已移除（它会让审查页变空）');
check(main.includes('.put("toolCalls",toolCallSummary('),'工具记录单独存到 toolCalls 字段');

console.log('\n[6] 后端：改动来源正确');
const agent=readSrc('src/cn/com/scsxrkj/DevAgent.java');
/* 原生路径：改动在 tool_calls 里，必须导出 */
check(agent.includes('response.put("stagedFiles",stagedChanges)'),'DevAgent 导出 stagedFiles');
/* 文本路径：改动在正文 JSON 里，也要能取到 */
const idxMain=main.indexOf('JSONObject changes=result.optJSONObject("stagedFiles")');
check(idxMain>=0,'MainActivity 从 stagedFiles 起步');
if(idxMain>=0){
  const around=main.slice(idxMain,idxMain+500);
  check(around.includes('ProjectEdits.parse(result.optString("text"))'),'没有改动时回退到解析正文');
  check(around.indexOf('stagedFiles')<around.indexOf('ProjectEdits.parse'),'stagedFiles 优先');
}

console.log('\n[7] 提示词教模型先答问题');
const tools=readSrc('src/cn/com/scsxrkj/LocalDevTools.java');
check(tools.includes('用户问的是问题，就先回答问题'),'提示词要求先回答问题');
check(tools.includes('动手之前先用一句话说明你要做什么'),'提示词要求动手前先说明');
check(tools.includes('干完用人话说结果'),'提示词要求干完用自然语言总结');
check(tools.includes('不要把 JSON、文件清单、工具参数原样甩给用户'),'提示词禁止甩 JSON');
/* 无项目时也要教 */
const noProj=tools.indexOf('本轮没有指定项目');
check(noProj>=0 && tools.slice(noProj,noProj+200).includes('先直接回答'),'无项目时的提示词也教了先回答');

console.log('\n[8] 工具一致性（原生路径调得到所有工具）');
const schema=readSrc('src/cn/com/scsxrkj/ToolSchema.java');
const schemaTools=[...schema.matchAll(/new Tool\("([a-z_]+)"/g)].map(m=>m[1]);
const implTools=[...new Set([
  ...[...tools.matchAll(/case "([a-z_]+)"/g)].map(m=>m[1]),
  ...[...tools.matchAll(/name\.equals\("([a-z_]+)"\)/g)].map(m=>m[1]),
])];
const missing=implTools.filter(n=>!schemaTools.includes(n));
check(missing.length===0,'实现里的工具全都在 schema 里',missing.join(', '));

console.log('\n────────────────────────────────');
console.log('通过 '+passed+' 项，失败 '+failures.length+' 项');
if(failures.length){
  failures.forEach(f=>console.log('  ✗ '+f));
  process.exit(1);
}
console.log('全部通过');
