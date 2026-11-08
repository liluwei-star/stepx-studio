/*
 * 工具结果截断与协议措辞的回归测试。
 *
 * <p>这三件事以前各自悄悄坏掉过：
 * <ol>
 *   <li>工具结果全文回灌上下文，几十轮就能撑爆；</li>
 *   <li>请求前只查项目上下文、不查历史消息，纯问答毫无保护；</li>
 *   <li>提示词里「直接调工具」和「返回 JSON」同时出现，
 *       模型在原生路径下也会去写 JSON，绕开暂存区与校验。</li>
 * </ol>
 *
 * <p>跑法：node tests/agent_context_guard_test.cjs
 */
const fs=require('fs');
const path=require('path');

const ROOT=process.cwd();
const SRC=path.join(ROOT,'src','cn','com','scsxrkj');

function read(name){
  const p=path.join(SRC,name);
  if(!fs.existsSync(p))throw new Error('找不到源文件：'+p);
  return fs.readFileSync(p,'utf8');
}

let pass=0,fail=0;
function check(desc,cond,detail){
  if(cond){pass++;console.log('  PASS  '+desc);}
  else{fail++;console.log('  FAIL  '+desc+(detail?'\n        '+detail:''));}
}

const agent=read('DevAgent.java');
const tools=read('LocalDevTools.java');
const edits=read('ProjectEdits.java');
const main=read('MainActivity.java');

console.log('\n── 工具结果截断 ─────────────────────────────────');
check('定义了单条工具结果上限',/MAX_TOOL_RESULT_CHARS\s*=\s*\d+\s*\*/.test(agent)||/MAX_TOOL_RESULT_CHARS\s*=\s*\d+/.test(agent),
  'DevAgent 里应能找到 MAX_TOOL_RESULT_CHARS');
check('上限在 8 KB ~ 64 KB 之间（够读完一个函数，又不至于爆）',
  (function(){
    const m=agent.match(/MAX_TOOL_RESULT_CHARS\s*=\s*(\d+)\s*\*\s*1024/);
    if(!m)return false;
    const v=Number(m[1])*1024;
    return v>=8*1024&&v<=64*1024;
  })(),'应形如 MAX_TOOL_RESULT_CHARS = 24*1024');
check('有 clampToolResult 实现',/static String clampToolResult\s*\(/.test(agent));
check('截断保留头尾（不是简单砍尾）',
  /clampToolResult[\s\S]{0,1200}substring\(0,\s*head\)/.test(agent)&&
  /clampToolResult[\s\S]{0,1600}substring\(body\.length\(\)-tail\)/.test(agent));
check('截断时明确告诉模型内容被省略了',
  /已省略中间/.test(agent)&&/共\s*"\s*\+\s*body\.length\(\)/.test(agent));
check('截断提示模型可以分段读取',/read_file 分段读取/.test(agent));
check('OpenAI 协议的工具结果走截断',
  /role.*tool.*tool_call_id/.test(agent)&&
  (function(){
    const seg=agent.slice(agent.indexOf('out.put(new JSONObject().put("role","tool")'));
    return /clampToolResult/.test(seg);
  })(),'role:"tool" 那条应调用 clampToolResult');
check('Anthropic 协议的工具结果走截断',
  (function(){
    const i=agent.indexOf('"type","tool_result"');
    const seg=agent.slice(Math.max(0,i-900),i+200);
    return /clampToolResult/.test(seg);
  })(),'tool_result 那条应调用 clampToolResult');
check('降级路径的工具结果汇总也走截断',
  /clampToolResults\(results\)/.test(agent),
  '降级路径应逐条截断，而不是把整轮拼起来再砍中间');
check('单条上限不会被一轮的总预算抬高',
  /if\(perItem>MAX_TOOL_RESULT_CHARS\)perItem=MAX_TOOL_RESULT_CHARS;/.test(agent),
  'perItem 必须再取一次小值，单条永远不超过 MAX_TOOL_RESULT_CHARS');
check('降级路径不再把整轮结果拼成一个字符串再截断',
  !/clampToolResult\(results\.toString\(\)\)/.test(agent),
  '整轮拼接后截断会让前面的工具结果整条消失');

console.log('\n── 传输量检查 ───────────────────────────────────');
check('请求前检查了 messages 体积',
  /messages\.toString\(\)\.length\(\)/.test(main)&&
  /这次对话的内容太多/.test(main),
  '应有一处针对 messages 的独立检查');
check('检查发生在没有项目上下文时也会执行（不在 projectContext 分支内）',
  (function(){
    const i=main.indexOf('全局传输量检查');
    if(i<0)return false;
    // 该检查应在 projectContext 块的闭合之后
    const seg=main.slice(i-800,i+1200);
    return /final JSONArray request=messages/.test(seg);
  })(),'检查点应在赋给 request 之前');
check('错误信息给出了可操作的下一步',
  /新开一个对话/.test(main));

console.log('\n── 协议措辞按路径分开 ─────────────────────────────');
check('instructions 带 nativeTools 参数',
  /static String instructions\s*\(boolean project\s*,\s*boolean nativeTools\)/.test(tools));
check('原生路径不再要求模型把工具请求写成 JSON',
  (function(){
    const i=tools.indexOf('private static String callProtocol');
    if(i<0)return false;
    const seg=tools.slice(i,i+900);
    const m=seg.match(/if\(nativeTools\)return\s+"([^"]*)"/);
    return m&&!/只返回 JSON|返回 JSON/.test(m[1]);
  })(),'原生分支的措辞里不该出现「只返回 JSON」');
check('降级路径明确要求 JSON 协议',
  /只返回 JSON：\{\\"tools\\"/.test(tools));
check('ProjectEdits 区分原生与降级',
  /static String instructions\s*\(boolean nativeTools\)/.test(edits)&&
  /static String sourceInstructions\s*\(boolean nativeTools\)/.test(edits));
check('原生路径的写文件说明要求用工具而不是 JSON',
  (function(){
    const i=edits.indexOf('private static String fileProtocol');
    if(i<0)return false;
    const seg=edits.slice(i,i+900);
    const m=seg.match(/if\(nativeTools\)return\s+"([^"]*)"/);
    return m&&/write_files/.test(m[1]);
  })());
check('降级时向模型补发协议更正',
  /协议更正/.test(agent)&&/本轮服务端不支持原生工具调用/.test(agent));

console.log('\n── 提示词自洽 ───────────────────────────────────');
check('有项目分支不再硬编码「结束时返回严格 JSON files 对象」',
  !/结束时返回严格 JSON files 对象。";/.test(tools),
  '应改为按 nativeTools 分支选择措辞');
check('调用点传入了 nativeTools',
  /instructions\(project!=null\s*,\s*nativeTools\)/.test(agent));
check('MainActivity 的调用点也传了 nativeTools',
  /ProjectEdits\.(sourceInstructions|instructions)\(nativeTools\)/.test(main));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail?1:0);
