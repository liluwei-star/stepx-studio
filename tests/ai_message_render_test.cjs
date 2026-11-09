/*
 * AI 消息渲染的独立测试。
 *
 * 为什么要单独测：
 * 前端的渲染逻辑写在 assets/app.js 里，是一个巨大的模板字符串，
 * 塞在 Android 工程里没法直接跑单元测试（要 WebView、要设备）。
 * 所以把「正文怎么渲染」这段逻辑复制到 Node 里跑一遍。
 *
 * <p><b>复制的代价：</b>app.js 改了这里要同步改这里。
 * 这个风险靠下面第 0 条断言兜住：直接读 assets/app.js 的源文件，
 * 检查它确实调用了 aiMessageBody，且不再有「把正文包进 details」的老写法。
 *
 * 运行：node tests/ai_message_render_test.cjs
 */
const fs=require('fs');
const path=require('path');

/*
 * 注意：项目路径里含中文（StepX Neo 手机）。
 * Node 在某些环境下用绝对路径 readFileSync 会报 ENOENT ——
 * 文件明明在。所以这里统一用 process.cwd() 下的相对路径读，
 * 并且要求从项目根目录运行（package.json 里的 test 脚本会 cd 到根目录）。
 */
const root=process.cwd();
function readSrc(rel){
  try{return fs.readFileSync(path.join(root,rel),'utf8');}
  catch(e){
    /* 退回到 __dirname 拼的路径 */
    return fs.readFileSync(path.resolve(__dirname,'..',rel),'utf8');
  }
}
const appJs=readSrc('assets/app.js');

let passed=0;
const failures=[];
function check(cond,name,extra){
  if(cond){passed++;console.log('  PASS  '+name);}
  else{failures.push(name+(extra?' — '+extra:''));console.log('  FAIL  '+name+(extra?' — '+extra:''));}
}

/* ── 0. 源文件与本测试同步 ───────────────────────────── */
console.log('\n[0] 源文件与测试同步');
check(appJs.includes('function aiMessageBody(m)'),'app.js 定义了 aiMessageBody');
check(!appJs.includes('查看 AI 返回的代码与说明</summary><pre>${esc(typeof m.content'),
  'app.js 不再把正文包进「查看 AI 返回的代码与说明」折叠块');
check(appJs.includes('${aiMessageBody(m)}'),'app.js 渲染正文时调用 aiMessageBody');

/* ── 从 app.js 里抽出 aiMessageBody 的实现 ──────────── */
console.log('\n[1] 抽出实现');
const start=appJs.indexOf('function aiMessageBody(m)');
check(start>=0,'能定位 aiMessageBody');
let body=appJs.slice(start);
// 截到下一个顶层 function 定义
const nextFn=body.indexOf('\nfunction ');
if(nextFn>0)body=body.slice(0,nextFn);
check(body.includes('JSON.parse'),'实现里用了 JSON.parse 剥离 files JSON');

/* esc 是 app.js 里现成的转义函数，这里给一个等价实现 */
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* 把实现包进一个可调用的函数 */
let render;
try{
  /* eslint-disable no-new-func */
  render=new Function('esc',body+'; return aiMessageBody;')(esc);
}catch(e){
  failures.push('aiMessageBody 无法执行: '+e.message);
  console.log('  FAIL  aiMessageBody 无法执行 — '+e.message);
  render=null;
}

/* ── 2. 正文行为 ─────────────────────────────────────── */
console.log('\n[2] 正文渲染行为');

if(render){
  /* 2.1 普通回答：直接显示，不折叠 */
  const plain=render({content:'能，当前项目有 318 个文件，是 Vite + React。'});
  check(plain.includes('能，当前项目有 318 个文件'),'普通回答的正文直接出现在输出里');
  check(!plain.includes('<details'),'普通回答不会被包进折叠块');
  check(plain.includes('ai-text'),'正文带 ai-text 样式类');

  /* 2.2 换行保留 */
  const multi=render({content:'第一行\n第二行'});
  check(multi.includes('<br>'),'正文里的换行转成 <br>');

  /* 2.3 降级路径：模型回的是 {"summary":...,"files":{...}} */
  const withFiles=render({content:'{"summary":"我改了 index.html 的标题","files":{"index.html":"<html></html>"}}'});
  check(withFiles.includes('我改了 index.html 的标题'),'JSON 回复里取出 summary 作为正文');
  check(!withFiles.includes('index.html\\":\\"<html>'),'正文里不再露出 files 的内容');
  check(!withFiles.includes('"files"'),'正文里不再出现 files 字样');

  /* 2.4 带代码围栏的 JSON */
  const fenced=render({content:'```json\n{"summary":"围栏里的说明","files":{"a.js":"x"}}\n```'});
  check(fenced.includes('围栏里的说明'),'代码围栏里的 JSON 也能取出 summary');

  /* 2.5 JSON 里没有 summary 时给出兜底说明，不能是空白 */
  const noSummary=render({content:'{"files":{"a.js":"x"}}'});
  check(noSummary.includes('已按要求修改项目文件'),'没有 summary 时有兜底说明，不是空白');

  /* 2.6 文本里带大括号但不是 JSON —— 不能被误剥 */
  const braces=render({content:'这个函数写成 {foo} 就好了'});
  check(braces.includes('这个函数写成 {foo} 就好了'),'普通文本里的大括号不会被误当成 JSON 剥掉');

  /* 2.7 HTML 转义，防注入 */
  const inject=render({content:'<img src=x onerror=alert(1)>'});
  check(!inject.includes('<img'),'正文里的 HTML 被转义，不会注入页面');

  /* 2.8 非字符串 content（对象）不崩 */
  const objContent=render({content:{a:1}});
  check(typeof objContent==='string'&&objContent.length>0,'content 是对象时也不崩');

  /* 2.9 content 为空 */
  const empty=render({content:''});
  check(typeof empty==='string','content 为空时也不崩');
}

/* ── 3. 提示词：教模型先答问题 ───────────────────────── */
console.log('\n[3] 提示词');
const tools=readSrc('src/cn/com/scsxrkj/LocalDevTools.java');
check(tools.includes('【怎么跟用户说话】'),'提示词里有「怎么跟用户说话」这一节');
check(tools.includes('用户问的是问题，就先回答问题'),'提示词明确要求先回答问题');
check(tools.includes('不要把 JSON、文件清单、工具参数原样甩给用户'),'提示词禁止把 JSON 甩给用户');

/* ── 4. 原生路径：改动导出 ───────────────────────────── */
console.log('\n[4] 原生 function calling 的改动导出');
const agent=readSrc('src/cn/com/scsxrkj/DevAgent.java');
check(agent.includes('stagedFiles'),'DevAgent 导出 stagedFiles');
check(agent.includes('tools.finalChanges(new JSONObject())'),'stagedFiles 来自暂存区的实际改动');

const main=readSrc('src/cn/com/scsxrkj/MainActivity.java');
const mIdx=main.indexOf('JSONObject stagedNow=result.optJSONObject("stagedFiles")');
check(mIdx>=0,'MainActivity 优先读 stagedFiles');
if(mIdx>=0){
  const around=main.slice(mIdx,mIdx+600);
  check(around.includes('ProjectEdits.parse(result.optString("text"))'),'stagedFiles 为空时回退到文本 JSON');
  check(mIdx<main.indexOf('applyAiChanges(target,baseline,changes,edit)'),'stagedFiles 的判断在写回之前');
}

const edits=readSrc('src/cn/com/scsxrkj/ProjectEdits.java');
check(edits.includes('DevAgent.indexOfJsonStart'),'ProjectEdits.parse 用健壮的 JSON 边界定位');

/* ── 汇总 ─────────────────────────────────────────────── */
console.log('\n────────────────────────────────');
console.log('通过 '+passed+' 项，失败 '+failures.length+' 项');
if(failures.length){
  failures.forEach(f=>console.log('  ✗ '+f));
  process.exit(1);
}
console.log('全部通过');
