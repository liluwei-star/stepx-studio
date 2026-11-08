/*
 * 工具交互历史的裁剪。
 *
 * <p>长任务里 messages 单调增长，几十轮就能到几 MB，任何模型的窗口都装不下。
 * 所以要丢历史。但**不能丢坏**：
 *
 * <ul>
 *   <li>原生协议里 tool_calls 消息必须配对它后面的 tool 结果，拆散会被服务端拒</li>
 *   <li>最初的用户提问不能丢 —— 丢了模型就不知道自己在干什么</li>
 *   <li>要告诉模型丢了东西，否则它会以为那段过程从来没发生过</li>
 * </ul>
 *
 * <p>这个测试用一份和 Java 实现同构的 JS 版本来验证行为。
 * 两边逻辑必须一致，所以改动时要一起改。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const agent=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/DevAgent.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

/* ── 与 Java 实现同构的参考实现 ───────────────────────── */
const MAX_CONTEXT=200*1024;

function isToolResultMsg(k){
 if(!k)return false;
 const role=k.role||'';
 if(role==='tool')return true;
 if(role==='user'&&Array.isArray(k.content)&&k.content.length>0){
  for(const b of k.content){
   if(!b||b.type!=='tool_result')return false;
  }
  return true;
 }
 return false;
}

function groupMessages(messages){
 const groups=[];let i=0;const n=messages.length;
 while(i<n){
  const m=messages[i];let start=i,end=i+1;
  let isToolCall=false;
  if(m){
   if(Array.isArray(m.tool_calls)&&m.tool_calls.length>0)isToolCall=true;
   else if(Array.isArray(m.content)&&m.content.length>0){
    isToolCall=true;
    for(const b of m.content){if(!b||b.type!=='tool_use'){isToolCall=false;break;}}
   }
  }
  if(isToolCall){
   while(end<n){
    const k=messages[end];
    if(!k)break;
    if(isToolResultMsg(k)){end++;continue;}
    break;
   }
  }
  let len=0;
  for(let j=start;j<end;j++)len+=JSON.stringify(messages[j]).length;
  groups.push({start,end,len,tool:isToolCall});
  i=end;
 }
 return groups;
}

function trimToolHistory(messages,budgetChars){
 if(!messages||messages.length===0)return [];
 if(JSON.stringify(messages).length<=budgetChars)return messages;
 const groups=groupMessages(messages);
 let budget=budgetChars,keepFrom=groups.length;
 const firstLen=groups.length>0?groups[0].len:0;
 budget-=firstLen;
 for(let g=groups.length-1;g>=1;g--){
  if(groups[g].len>budget)break;
  budget-=groups[g].len;keepFrom=g;
 }
 const out=[];
 if(groups.length>0){
  for(let j=groups[0].start;j<groups[0].end;j++)out.push(messages[j]);
 }
 const inserted=out.length;
 for(let g=keepFrom;g<groups.length;g++){
  for(let j=groups[g].start;j<groups[g].end;j++)out.push(messages[j]);
 }
 let dropped=keepFrom-1;if(dropped<0)dropped=0;
 let droppedChars=0;
 for(let g=1;g<keepFrom;g++)droppedChars+=groups[g].len;
 if(dropped>0){
  out.splice(Math.min(inserted,out.length),0,{
   role:'user',
   content:'【较早的 '+dropped+' 段工具交互已从上下文中移除（约 '+droppedChars+' 字符）】'
    +'这些是很早以前的工具调用与返回。如果现在还需要当时的信息，'
    +'请重新调用对应工具获取，不要凭记忆假设。'
  });
 }
 return out;
}

/* ── 造场景 ─────────────────────────────────────────── */
function makeRound(i){
 const id='call_'+i;
 return [
  {role:'user',content:'第 '+i+' 轮的问题'},
  {role:'assistant',content:'我来查一下',tool_calls:[{id,type:'function',function:{name:'read_file',arguments:'{}'}}]},
  {role:'tool',tool_call_id:id,content:'文件内容 '.repeat(2000)+'第'+i+'轮'}
 ];
}

console.log('\n── 短对话不该被裁 ───────────────────────────────');
{
 const msgs=[{role:'user',content:'你好'}];
 const out=trimToolHistory(msgs,MAX_CONTEXT);
 check(out.length===msgs.length,'a short conversation is left alone');
 check(out[0].content==='你好','the original message survives');
}

console.log('\n── 长对话要裁，但协议配对不能破 ───────────────');
{
 let msgs=[{role:'user',content:'原始任务：把登录页改好'}];
 for(let i=0;i<30;i++)msgs=msgs.concat(makeRound(i));
 const before=JSON.stringify(msgs).length;
 const out=trimToolHistory(msgs,MAX_CONTEXT);
 const after=JSON.stringify(out).length;
 check(after<before,'the history actually shrank ('+before+' → '+after+')');
 check(out.length<msgs.length,'some messages were dropped');
 // 关键：每条 tool 消息都必须能找到配对的 assistant tool_calls
 const ids=new Set();
 let broken=0;
 for(const m of out){
  if(m.role==='assistant'&&Array.isArray(m.tool_calls))for(const c of m.tool_calls)ids.add(c.id);
 }
 for(const m of out){
  if(m.role==='tool'&&!ids.has(m.tool_call_id))broken++;
 }
 check(broken===0,'every tool message still has its paired assistant tool_calls ('+broken+' orphaned)');
 // 最初的提问必须在
 check(out.some(m=>m.role==='user'&&m.content==='原始任务：把登录页改好'),
  'the original user request is kept');
}

console.log('\n── 裁剪要如实告知模型 ─────────────────────────');
{
 let msgs=[{role:'user',content:'原始任务'}];
 for(let i=0;i<30;i++)msgs=msgs.concat(makeRound(i));
 const out=trimToolHistory(msgs,MAX_CONTEXT);
 const notes=out.filter(m=>m.role==='user'&&String(m.content).includes('已从上下文中移除'));
 check(notes.length===1,'exactly one note tells the model what was dropped');
 check(String(notes[0].content).includes('请重新调用对应工具获取'),
  'the note tells the model to re-fetch instead of guessing');
 // 说明要排在用户提问之后，不能跑到最前面
 check(out[0].content==='原始任务','the note does not come before the original request');
 check(out.length>0&&out[0].role==='user'&&out[0].content==='原始任务',
  'the original request is the very first message after trimming');
}

console.log('\n── Anthropic 形态（工具结果在 user 的 content 里）──');
{
 let msgs=[{role:'user',content:'原始任务'}];
 for(let i=0;i<20;i++){
  const id='tu_'+i;
  msgs.push({role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name:'read_file',arguments:'{}'}}]});
  msgs.push({role:'user',content:[{type:'tool_result',tool_use_id:id,content:'内容 '.repeat(4000)}]});
 }
 const out=trimToolHistory(msgs,MAX_CONTEXT);
 check(out.length<msgs.length,'the anthropic-style history shrank');
 const ids=new Set();
 for(const m of out)if(m.role==='assistant'&&Array.isArray(m.tool_calls))for(const c of m.tool_calls)ids.add(c.id);
 let broken=0;
 for(const m of out){
  if(m.role==='user'&&Array.isArray(m.content)){
   for(const b of m.content)if(b.type==='tool_result'&&!ids.has(b.tool_use_id))broken++;
  }
 }
 check(broken===0,'anthropic tool_use blocks stay paired ('+broken+' orphaned)');
}

console.log('\n── Java 侧必须真的接上了 ───────────────────────');
check(agent.includes('trimToolHistory(messages,MAX_CONTEXT_CHARS)'),
 'the trim is actually called in the main loop');
check(agent.includes('static final int MAX_CONTEXT_CHARS'),
 'the context budget is declared as a constant');
check(/static JSONArray trimToolHistory\(JSONArray messages,int budgetChars\)/.test(agent),
 'the Java implementation has the same shape as the reference');
check(agent.includes('MAX_ROUND_TOOL_CHARS'),
 'a per-round tool result budget exists');

console.log('\n'+'-'.repeat(52));
if(fail>0){console.log('FAIL: '+fail+' 项未通过');process.exit(1);}
console.log('ALL PASS (context_trim_test) '+pass+' 项');
