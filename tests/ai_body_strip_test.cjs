/*
 * AI 回复正文的清洗：把模型交回的协议 JSON 剥掉，只留给人看的部分。
 *
 * <p>这个文件盯三件事：
 *
 * <p>① JSON 后面还有一句人话时，也要能剥干净（不能整段解析失败就把 JSON 裸露出去）。
 *
 * <p>② JSON 前面那句人话（模型先回答问题再给 JSON）必须留下。
 *
 * <p>③ 纯问答时模型只给 {"summary":"..."}，没有 files —— 也要剥，
 *     用户看到的是那句话，不是一坨 JSON。
 *
 * <p>这里直接从 assets/app.js 里抠出真实函数来测，不另抄一份，
 * 免得源码改了测试还在测旧逻辑。
 */
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');
const app=fs.readFileSync(path.join(root,'assets/app.js'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── AI 回复正文的 JSON 剥离 ───────────────────────');

// 从 app.js 里抠出真实实现（连同它内部的辅助函数）
const start=app.indexOf('function aiMessageBody(m)');
if(start<0){
 console.log('  ✗ 找不到 app.js 里的 aiMessageBody');
 process.exit(1);
}
let src=app.slice(start);
const nextFn=src.indexOf('\nfunction ');
if(nextFn>0)src=src.slice(0,nextFn);

// esc 是 app.js 顶部的转义函数，这里补一份同义的
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
let body;
try{
 body=new Function('esc',src+'; return aiMessageBody;')(esc);
}catch(e){
 console.log('  ✗ 抠出来的代码无法加载：'+e.message);
 process.exit(1);
}

// ① JSON 后面跟人话
let raw='改好了标题。\n{"summary":"改了标题","files":{"index.html":"x"}}\n还需要我做别的吗？';
let out=body({content:raw});
check(out.indexOf('"summary"')<0&&out.indexOf('{')<0,
 'a JSON object followed by more prose is stripped clean');
check(out.indexOf('改好了标题')>=0,'the prose before the JSON is kept');
check(out.indexOf('还需要我做别的吗')>=0,'the prose after the JSON is kept');

// ② JSON 前面有人话（先回答再给 JSON）
raw='看到了，是个 Vite 项目。我把标题改成了「会议助手」。\n{"summary":"改了标题","files":{"index.html":"x"}}';
out=body({content:raw});
check(out.indexOf('我把标题改成了')>=0,'the direct answer before the JSON survives');
check(out.indexOf('"files"')<0,'the files JSON is removed');

// ③ 纯问答：只有 summary，没有 files
raw='{"summary":"这个函数的作用是解析配置"}';
out=body({content:raw});
check(out.indexOf('这个函数的作用是解析配置')>=0,'a summary-only answer is shown as text');
check(out.indexOf('{')<0,'a summary-only answer is not shown as raw JSON');

// ④ 回答里先出现代码里的左花括号
raw='先看下这段：function f(){ return 1; }\n然后 {"summary":"好了","files":{}}';
out=body({content:raw});
check(out.indexOf('"files"')<0,'a stray brace before the JSON does not break stripping');

// ⑤ 纯自然语言不受影响
raw='好的，项目是 Vite + React，入口在 src/main.tsx。';
out=body({content:raw});
check(out.indexOf('Vite + React')>=0&&out.indexOf('{')<0,'plain prose is left alone');

// ⑥ HTML 被转义
raw='<img src=x onerror=alert(1)>';
out=body({content:raw});
check(out.indexOf('<img')<0&&out.indexOf('&lt;img')>=0,'HTML in a reply is escaped');

// ⑦ 字符串里的花括号不算 JSON 结束
raw='{"summary":"值是 }","files":{"a":"b"}}';
out=body({content:raw});
check(out.indexOf('"files"')<0&&out.indexOf('值是 }')>=0,
 'a brace inside a JSON string does not end the object');

// ⑧ 代码围栏
raw='说明\n```json\n{"summary":"做了","files":{"a":"b"}}\n```\n完毕';
out=body({content:raw});
check(out.indexOf('"files"')<0,'a fenced JSON block is stripped');
check(out.indexOf('做了')>=0,'the fenced summary is kept');
check(out.indexOf('```')<0,'the code fence itself is not shown');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
