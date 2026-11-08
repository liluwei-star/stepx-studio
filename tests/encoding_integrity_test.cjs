/*
 * 源码完整性检查：不允许出现编码损坏。
 *
 * <p>U+FFFD（三个字节 EF BF BD 拼起来）出现的唯一原因是：某个 UTF-8 字符在写入时被
 * 从中间截断，三字节序列没写全。读回来就成了「□」。
 *
 * <p>这不是排版瑕疵 —— 出现损坏的地方可能正好是关键字面量，
 * 模型读到的提示词就缺了一截，或者 JSON 解析直接失败。
 * 本项目里真实发生过一次：
 *   「改之前的□□□容」 —— 应该是「改之前的内容」。
 * 一个字坏了，一整句说明就废了。
 *
 * <p>所以每次跑测试都扫一遍源码，发现损坏直接失败。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

/* 会被检查的文件类型 —— 都是文本，损坏就是 bug */
const EXTS=new Set(['.java','.js','.cjs','.mjs','.json','.md','.sh','.html','.css','.txt','.py','.yml','.yaml','.xml']);
/* 这些目录是构建产物或第三方代码，不归我们管 */
const SKIP=new Set(['.git','node_modules','dist','build','.gradle','temp','tmp']);

function walk(dir,out){
 for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(SKIP.has(e.name))continue;
  const full=path.join(dir,e.name);
  if(e.isDirectory())walk(full,out);
  else if(EXTS.has(path.extname(e.name).toLowerCase()))out.push(full);
 }
}

console.log('\n── 源码不能有编码损坏 ─────────────────────────────');
const files=[];
walk(root,files);
const BAD=Buffer.from([0xef,0xbf,0xbd])  // 运行时拼，不写进源码;
const damaged=[];
for(const f of files){
 try{
  const raw=fs.readFileSync(f);
  const n=raw.length - Buffer.compare(raw,BAD)===0?0:0; // 占位，下面直接数
  let count=0;
  for(let i=0;i+2<raw.length;i++)if(raw[i]===0xef&&raw[i+1]===0xbf&&raw[i+2]===0xbd){count++;i+=2;}
  if(count>0)damaged.push({file:path.relative(root,f),count});
 }catch(e){}
}
check(damaged.length===0,
 'no source file contains a broken UTF-8 sequence [damaged='+JSON.stringify(damaged)+']');
check(files.length>20,'the scan actually covered the project ('+files.length+' files)');

console.log('\n── 损坏检测本身要有效 ───────────────────────────');
/* 拿一个故意损坏的临时文件试试扫描逻辑，确认它能报出来 —— */
/* 不然这个测试可能因为「什么都没扫到」而永远绿。 */
const probe=path.join(root,'.encoding-probe.tmp');
fs.writeFileSync(probe,Buffer.concat([Buffer.from('正常文本'),BAD,Buffer.from('尾巴')]));
let probeCount=0;
try{
 const raw=fs.readFileSync(probe);
 for(let i=0;i+2<raw.length;i++)if(raw[i]===0xef&&raw[i+1]===0xbf&&raw[i+2]===0xbd){probeCount++;i+=2;}
}finally{fs.unlinkSync(probe);}
check(probeCount===1,'the detector really finds a broken sequence (found '+probeCount+')');

console.log('\n── 已修的地方要保持原样 ─────────────────────────');
const edits=root+'\\src\\cn\\com\\scsxrkj\\ProjectEdits.java';
if(fs.existsSync(edits)){
 const t=fs.readFileSync(edits,'utf8');
 check(t.includes('改之前的内容'),'the ProjectEdits comment reads correctly');
}
const md=root+'\\调试接口.md';
if(fs.existsSync(md)){
 const t=fs.readFileSync(md,'utf8');
 check(t.includes('StepX Studio 本体）'),'the debugging doc reads correctly');
}
const conn=root+'\\assets\\official-connectors.json';
if(fs.existsSync(conn)){
 const t=fs.readFileSync(conn,'utf8');
 check(t.includes('才补坐车后接'),'the connector description reads correctly');
}

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (encoding_integrity_test) '+pass+' 项');
