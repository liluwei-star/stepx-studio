/*
 * 原生 function calling 的历史消息必须符合协议，否则下一轮请求会被服务端拒。
 *
 * <p>这个文件盯三件事：
 *
 * <p>① OpenAI：带 tool_calls 的那条消息，content 要么有内容要么是 null，
 * 不能是空字符串；arguments 必须是能解析的 JSON 字符串。
 *
 * <p>② Anthropic：模型这一轮说过的正文必须带回去（否则它以为自己没说过），
 * tool_use 的 input 必须是对象（null 会被拒）。
 *
 * <p>③ 工具结果消息必须每个 tool_call 都有配对 —— 少一条下一轮就 400。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const src=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/DevAgent.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 原生工具协议的历史消息 ───────────────────────');

const fnAt=src.indexOf('static JSONObject assistantToolCallMessage(');
check(fnAt>0,'the assistant tool-call message builder exists');
const fn=src.slice(fnAt,fnAt+4000);

// ① OpenAI 分支：content 用 NULL 而不是空串
check(/else msg\.put\("content",JSONObject\.NULL\)/.test(fn),
 'an OpenAI tool-call message with no text uses null content, not an empty string');

// ① OpenAI 分支：坏参数不能原样回传（会 400）
check(/if\(!argsText\.isEmpty\(\)\)argsText="\{\}"/.test(fn),
 'broken arguments are sent as {} so the server can still parse the request');

// ② Anthropic 分支：正文要带回去
check(/put\("type","text"\)\.put\("text",said\)/.test(fn),
 'the Anthropic assistant message keeps the text the model said');

// ② Anthropic 分支：input 必须是对象
check(/JSONObject input=call\.optJSONObject\("args"\)/.test(fn),
 'the Anthropic tool_use input is read as an object');
check(/if\(input==null\)\{/.test(fn),
 'a null input is replaced with an object instead of being sent as null');

// ③ 工具结果必须逐个配对
const trAt=src.indexOf('static JSONArray toolResultMessages(');
check(trAt>0,'the tool result message builder exists');
const tr=src.slice(trAt,trAt+3000);
check(/put\("role","tool"\)\.put\("tool_call_id",result\.optString\("id"\)\)/.test(tr),
 'each OpenAI tool result carries its tool_call_id');
check(/put\("type","tool_result"\)\s*\n?\s*\.put\("tool_use_id",result\.optString\("id"\)\)/.test(tr)
  ||/put\("tool_use_id",result\.optString\("id"\)\)/.test(tr),
 'each Anthropic tool_result carries its tool_use_id');

// 单条与一轮的上限：单条永远不能超过单条上限
check(/if\(perItem>MAX_TOOL_RESULT_CHARS\)perItem=MAX_TOOL_RESULT_CHARS;/.test(tr),
 'the per-item cap can never exceed the single-item limit');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
