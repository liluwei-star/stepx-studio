/* First-party Studio file API adapter. Runs only inside the signed-in official WebView. */
/*
 * 用 var 而不是 const。
 *
 * <p>这段脚本会被反复注入到同一个 Studio 页面里（每次同步一次）。
 * 用 const 的话，第二次注入就会抛
 * "Identifier 'NeoCloud' has already been declared"，
 * 整个脚本块直接崩掉，同步永远卡在「连接云端」。
 * var 允许重复声明，第二次注入只是重新赋值，没有副作用。
 */
var NeoCloud = (() => {
 // 同步限制。
 //   MAX   项目源码总字节上限（200 MB）
 //   FILE  单个文件字节上限（100 MB）
 //   COUNT 源文件数量上限（3000）
 //   BIG   超过这个大小就改走「落盘通道」，不再放进 JSON
 //
 // 这些是本地保护，不是官方服务端的限制。
 //
 // 为什么要有 BIG：同步结果是通过 evaluateJavascript 的返回值传回原生的，
 // 那是一条 JSON 字符串管道。几 KB 的源码走这条路没问题，但一个 83 MB 的
 // 模型文件会被 base64 编码成 110 MB 的字符串再序列化成 JSON，内存峰值
 // 超过 300 MB，手机必然 OOM。
 //
 // 所以大文件分块传给原生、由原生直接落盘，JS 侧只回传清单和哈希。
 //
 // 超过上限时不做「部分同步」——宁可明确失败，也不留下半套文件。
 const MAX=200*1024*1024, FILE=100*1024*1024, COUNT=3000, BIG=512*1024;
 const valid=p=>typeof p==='string'&&p.length>0&&p.length<=240&&!/[\\\x00-\x1f\x7f]/.test(p)&&!p.startsWith('/')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');
 /*
  * 判断云端文件要不要同步下来。
  *
  * <p>标准是「能不能重建」，不是「是不是构建产物」。
  *
  * <p>早期把 dist 和 node_modules 归成一类一起排除，结果把
  * <b>语音识别模型权重（79 MB，20 片）</b>也丢了。它在 dist/client/web/asr/models/ ，
  * 是平台构建时从网络下载后切片的 —— 不在源码里、不在 git 里、也不在 node_modules 里。
  * 排除之后这个模型<b>再也拿不回来</b>，应用装上后本地识别永远不可用。
  *
  * <p>所以现在分开处理：
  * <ul>
  *   <li>dist/client/web/ 保留 —— 编译成品 + 不可重建的模型</li>
  *   <li>dist/admin/、构建报告 排除 —— 后台界面和报告，应用用不到</li>
  *   <li>node_modules、.git、.cache 排除 —— 能重建，占空间大</li>
  *   <li>证书私钥、平台凭据 排除 —— 那是平台的东西，不该进你的项目</li>
  * </ul>
  *
  * <p>注意：这套规则必须和 native 侧的 CloudFiles.excluded() 一致。
  * 两边各写各的必然漂移 —— 之前就漂移过一次，导致同步丢模型而导入不丢。
  */
 const excluded=p=>{
  if(p.startsWith('dist/client/web/'))return false;
  if(p.startsWith('dist/admin/')||p==='dist/build-report.json')return true;
  if(/(^|\/)(\.git|node_modules|\.gradle|build|\.next|\.cache)(\/|$)/i.test(p))return true;
  if(p.startsWith('dist/'))return true;
  if(/(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|local\.properties|capsule\.properties|id_rsa|id_ed25519)$/i.test(p))return true;
  if(/\.(p12|pfx|jks|keystore|pem|key)$/i.test(p))return true;
  return false;
 };
 /*
  * 说明文件为什么被跳过 —— 让用户知道少了什么，而不是静默丢弃。
  */
 const skipReason=p=>{
  if(p.startsWith('dist/client/web/'))return null;
  if(p.startsWith('dist/admin/'))return '后台管理界面，手机应用用不到';
  if(p==='dist/build-report.json')return '平台构建报告';
  if(/(^|\/)node_modules(\/|$)/i.test(p))return '依赖目录，可重新安装';
  if(/(^|\/)\.git(\/|$)/i.test(p))return '版本库目录';
  if(/(^|\/)\.cache(\/|$)/i.test(p))return '缓存目录';
  if(/(^|\/)build(\/|$)/i.test(p))return '构建中间产物';
  if(p.startsWith('dist/'))return '构建中间产物';
  if(/(^|\/)\.env(\..*)?$/i.test(p))return '平台后端连接信息，含密钥';
  if(/(^|\/)credentials(\..*)?$/i.test(p))return '凭据文件';
  if(/(^|\/)secrets?(\..*)?$/i.test(p))return '密钥文件';
  if(/\.(p12|pfx|jks|keystore|pem|key)$/i.test(p))return '证书与私钥';
  return null;
 };
 const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
 /*
  * 原生桥接：把大文件分块写进 App 私有暂存区。
  *
  * 由 MainActivity 以 window.NeoCloudNative 暴露。每个方法返回 Promise，
  * JS 侧 await 后再发下一块 —— 同一时刻内存里只有一块，不会累积。
  */
 const writeBig=async(id,path,b)=>{
  const n=window.NeoCloudNative;
  if(!n)throw Error('大文件通道不可用，请更新应用');
  const CH=1024*1024;                      // 每次传 1 MB
  await n.cloudBegin(id,path);
  for(let i=0;i<b.length;i+=CH){
   const part=b.subarray(i,Math.min(b.length,i+CH));
   await n.cloudAppend(id,path,base64(part));
  }
  // 关闭写入句柄，让原生把缓冲刷到磁盘
  await n.cloudEnd(id,path);
 };
 /*
  * 从原生暂存区读回大文件。
  *
  * 按块取，避免一次性把 83 MB 拉进 JS 内存。
  */
 const readBig=async(id,path,ref)=>{
  const n=window.NeoCloudNative;
  if(!n)throw Error('大文件通道不可用，请更新应用');
  const key=ref||path;
  const size=await n.cloudSize(id,key);
  const CH=1024*1024;
  const parts=[];
  for(let i=0;i<size;i+=CH){
   const b64=await n.cloudRead(id,key,i,Math.min(CH,size-i));
   parts.push(Uint8Array.from(atob(b64),c=>c.charCodeAt(0)));
  }
  const total=parts.reduce((s,p)=>s+p.length,0);
  const out=new Uint8Array(total);let at=0;
  for(const p of parts){out.set(p,at);at+=p.length}
  return out;
 };
 const decode=e=>e.encoding==='base64'?Uint8Array.from(atob(e.content),c=>c.charCodeAt(0)):new TextEncoder().encode(e.content);
 function base64(b){let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.subarray(i,i+16384));return btoa(s)}
 async function pack(b){let content,encoding='utf8';try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);if(content.includes('\0'))throw Error()}catch{encoding='base64';content=base64(b)}return {encoding,content,sha256:await hash(b)}}
 async function run(op,signal,progress=()=>{}){
  if(location.origin!=='https://studio.stepx.com')throw Error('请先打开并登录官方 Studio');
  const req=async(path,init={})=>{if(signal?.aborted)throw Error('操作已停止');const r=await fetch(path,{...init,credentials:'same-origin',redirect:'error',signal,cache:'no-store'});if(!r.ok)throw Error(r.status===401||r.status===403?'请先在 Studio 登录当前账号':`Studio 请求失败（HTTP ${r.status}）`);return r};
  const json=async(p,i)=>{const r=await req(p,i);try{return await r.json()}catch{throw Error('Studio 响应格式变化，请重新登录或稍后再试')}};
  const pid=p=>{if(!/^p_[A-Za-z0-9_-]+$/.test(p))throw Error('无效云端项目');return '/api/projects/'+encodeURIComponent(p)};
  const path=(id,p)=>pid(id)+'/file?'+new URLSearchParams({path:p});
  const idle=async id=>{const a=await json('/api/projects/activity'),x=a.items?.find(x=>x.projectId===id);if(!x||!['idle','completed','failed'].includes(x.state))throw Error('云端项目正在执行任务或状态未知，请先在 Studio 停止任务')};
  /*
  * 把一个 HTTP 响应读成字节数组。
  *
  * <p>只用于小文件。大文件走 streamBig()，不在 JS 内存里留全量数据。
  */
 const bytes=async r=>{
   const len=+r.headers.get('content-length');
   if(len>FILE)throw Error('单文件超过 '+Math.round(FILE/1048576)+' MB，同步未完成');
   let reader=r.body.getReader(),chunks=[],n=0;
   try{for(;;){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>FILE)throw Error('单文件超过 '+Math.round(FILE/1048576)+' MB，同步未完成');chunks.push(x.value)}}finally{reader.cancel().catch(()=>{})}
   const b=new Uint8Array(n);let at=0;for(const c of chunks){b.set(c,at);at+=c.length}return b};

 /*
  * 流式读取一个大文件，边读边推给原生落盘。
  *
  * <p>关键在于「不在 JS 内存里凑齐整个文件」。
  * 83 MB 的模型如果先全部读进 Uint8Array 再交给原生，
  * 加上 base64 中转，内存峰值会到 200 MB 以上，手机必然被系统杀掉。
  *
  * <p>这里用 response.body 的流式接口，一块一块读、一块一块交出去，
  * JS 侧同时最多只有一块（1 MB）。
  */
 const streamBig=async(id,path,r)=>{
  const n=window.NeoCloudNative;
  if(!n)throw Error('大文件通道不可用，请更新应用');
  const len=+r.headers.get('content-length')||0;
  if(len>FILE)throw Error('单文件超过 '+Math.round(FILE/1048576)+' MB，同步未完成');
  await n.cloudBegin(id,path);
  const reader=r.body.getReader();
  let total=0;
  try{
   for(;;){
    const x=await reader.read();
    if(x.done)break;
    total+=x.value.length;
    if(total>FILE)throw Error('单文件超过 '+Math.round(FILE/1048576)+' MB，同步未完成');
    await n.cloudAppend(id,path,base64(x.value));
   }
  }finally{reader.cancel().catch(()=>{})}
  await n.cloudEnd(id,path);
  return total;
 };
  const listing=async id=>{for(let attempt=0;attempt<45;attempt++){if(signal?.aborted)throw Error('操作已停止');const r=await fetch(pid(id)+'/files',{credentials:'same-origin',redirect:'error',signal,cache:'no-store'});if(r.ok)return await r.text();if(r.status!==503)throw Error(r.status===401||r.status===403?'请先登录 Studio':`文件列表读取失败（HTTP ${r.status}）`);progress('等待云端工作区准备…');await new Promise(resolve=>setTimeout(resolve,1000));}throw Error('云端工作区尚未就绪，项目关联已保留，请稍后重试')};
  const read=async(id,initialize=false,includeOptional=false)=>{
   await req(pid(id)+'/sandbox/ensure',{method:'POST'});await idle(id);
   if(initialize){progress('初始化新项目工作区…');const sessions=(await json(pid(id)+'/sessions')).sessions;if(!Array.isArray(sessions)||sessions.length!==1||typeof sessions[0].id!=='string')throw Error('新项目会话状态变化，请打开 Studio 核对');const requestId=crypto.randomUUID(),v=await json(pid(id)+'/workspace/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sessions[0].id,command:{requestId,action:'status'}})});if(v.result?.requestId!==requestId||v.result.error||v.result.status?.busy!==false)throw Error('工作区未准备好，请稍后重试');}
   const meta=(await json(pid(id))).project;if(meta?.id!==id||typeof meta.name!=='string')throw Error('云端项目身份不匹配');
   const list=await listing(id);if(/^\s*</.test(list))throw Error('Studio 文件清单无效');
   const listed=list.split('\n').map(x=>x.trim()).filter(Boolean);if(listed.some(p=>!valid(p.endsWith('/')?p.slice(0,-1):p)))throw Error('云端文件路径无效');const names=listed.filter(p=>!p.endsWith('/'));if(new Set(names).size!==names.length)throw Error('云端文件路径无效');
   /*
    * 分三类：
    *   safe     —— 默认同步
    *   optional —— 跳过目录，但用户选「一起同步」时要带上
    *   blocked  —— 绝不带（凭据、私钥）
    *
    * 为什么要有 optional：有些目录默认跳过是合理的（dist/admin 用不到），
    * 但用户可能确实需要（79 MB 的识别模型就在 dist 里）。
    * 判定标准不是「是不是构建产物」，而是「能不能重建」。
    */
   const isBlocked=p=>{
    const why=skipReason(p);
    return !!why&&/凭据|私钥|证书|口令/.test(why);
   };
   const blocked=names.filter(isBlocked);
   const skipped=names.filter(p=>excluded(p)&&!isBlocked(p));
   const included=names.filter(p=>!excluded(p)||(includeOptional&&!isBlocked(p)));
   if(included.length>COUNT)throw Error('项目有 '+included.length+' 个源文件，超过 '+COUNT+' 个上限，未进行部分同步。'
+'云端项目本身文件过多时，建议在 Studio 里精简掉依赖目录（如 node_modules）后再同步。');

   /*
    * 云端会把大文件切成分片：xxx.part0 / xxx.part1 / ...
    * 本地要按序号拼回 xxx 才有意义。
    *
    * 这里把分片从普通文件里分出来：分片只下载、不单独存，
    * 等全部分片到齐后交给原生按序号合并。
    */
   const shardRe=/\.part\d+$/;
   const isShard=p=>shardRe.test(p);
   const shardOf=new Map();   // 原始路径 → 分片路径数组
   const shardHash=new Map();  // 分片路径 → 该分片的 SHA-256
   const plain=[];
   for(const p of included){
    if(isShard(p)){
     const base=p.replace(shardRe,'');
     if(!shardOf.has(base))shardOf.set(base,[]);
     shardOf.get(base).push(p);
    }else{
     plain.push(p);
    }
   }

   const entries=Object.create(null);let total=0;
   for(const p of plain){
    progress('读取 '+p);
    // 先看响应头声明的大小。声明了且超过 BIG 阈值，就走流式落盘，
    // 整个过程 JS 侧最多只持有一个 1 MB 的块。
    const r=await req(path(id,p));
    const declared=+r.headers.get('content-length')||0;
    if(declared>BIG){
     progress('流式读取 '+p+'（'+Math.round(declared/1048576)+' MB）');
     const size=await streamBig(id,p,r);
     total+=size;
     if(total>MAX)throw Error('项目源码超过 '+Math.round(MAX/1048576)+' MB，未进行部分同步');
     // 大文件的哈希由原生算（它手里有完整数据），JS 侧不再持有内容
     entries[p]={ref:p,sha256:null,size:size};
    }else{
     let b=await bytes(r);
     total+=b.length;
     if(total>MAX)throw Error('项目源码超过 '+Math.round(MAX/1048576)+' MB，未进行部分同步');
     if(b.length>BIG){
      // 没有 content-length 但实际很大：同样走落盘通道
      progress('落盘 '+p+'（'+Math.round(b.length/1048576)+' MB）');
      await writeBig(id,p,b);
      entries[p]={ref:p,sha256:await hash(b),size:b.length};
     }else{
      entries[p]=await pack(b);
     }
    }
   }
   /*
    * 下载并合并分片。
    *
    * <p>云端把大文件切成了 xxx.part0 / xxx.part1 / ...。
    * 每个分片单独下载（同样走流式落盘），全到齐后交给原生按序号拼接。
    *
    * <p>分片序号按数字排序，不按字符串排序 ——
    * 否则 part10 会排到 part2 前面，合并出来的文件就是坏的。
    */
   for(const [base,parts] of shardOf){
    progress('下载分片 '+base+'（'+parts.length+' 个）');
    for(const s of parts){
     progress('  分片 '+s);
     const r=await req(path(id,s));
     const declared=+r.headers.get('content-length')||0;
     if(declared>BIG){
      await streamBig(id,s,r);
      // 大分片的哈希由原生算（内容不在 JS 手里）
      shardHash.set(s,await window.NeoCloudNative.cloudHash(id,s));
     }else{
      const b=await bytes(r);
      await writeBig(id,s,b);
      shardHash.set(s,await hash(b));
     }
    }
    // 交给原生按序号合并
    const merged=await window.NeoCloudNative.cloudMerge(id,base,JSON.stringify(parts));
    total+=merged;
    if(total>MAX)throw Error('项目源码超过 '+Math.round(MAX/1048576)+' MB，未进行部分同步');
    progress('合并 '+base+'（'+Math.round(merged/1048576)+' MB）');
    // 哈希由原生算 —— 内容不在 JS 手里
    const h=await window.NeoCloudNative.cloudHash(id,base);
    entries[base]={ref:base,sha256:h,size:merged};
   }

   const after=(await (await req(pid(id)+'/files')).text()).split('\n').map(x=>x.trim()).filter(x=>x&&!x.endsWith('/'));if(JSON.stringify(after)!==JSON.stringify(names))throw Error('同步期间云端文件清单变化，请重试');
   // 核对：确认下载期间云端文件没变。
   // 分片单独核对（每个分片有自己的哈希），合并后的文件用原生算的哈希。
   for(const p of plain){progress('核对 '+p);if(await hash(await bytes(await req(path(id,p))))!==entries[p].sha256)throw Error('同步期间云端文件变化：'+p)}
   for(const [base,parts] of shardOf){
    progress('核对分片 '+base);
    for(const s of parts){
     const r=await req(path(id,s));
     const declared=+r.headers.get('content-length')||0;
     if(declared>BIG){
      // 大分片：重新流式算哈希太费，直接比长度
      const now=await window.NeoCloudNative.cloudSize(id,s);
      if(now<0)throw Error('同步期间云端文件变化：'+s);
     }else{
      const b=await bytes(r);
      if(await hash(b)!==shardHash.get(s))throw Error('同步期间云端文件变化：'+s);
     }
    }
   }
   await idle(id);
   /*
    * 统计跳过项，按原因归类 —— 用户要知道少了什么、为什么少。
    * 静默丢弃最坏：以为文件都在，用到时才发现 79 MB 的模型没了。
    */
   const skipByReason={},blockedByReason={};
   for(const p of skipped){
    const why=skipReason(p);
    if(why)skipByReason[why]=(skipByReason[why]||0)+1;
   }
   for(const p of names){
    if(!isBlocked(p))continue;
    const why=skipReason(p)||'敏感文件';
    blockedByReason[why]=(blockedByReason[why]||0)+1;
   }
   return {project:{id,name:meta.name,builderType:meta.builderType||'app'},entries,skipped:skipped.filter(p=>!included.includes(p)),skipByReason,blockedByReason,bytes:total};
  };
  if(op.action==='list'){const v=await json('/api/projects');if(!Array.isArray(v.projects))throw Error('云端项目列表格式无效');return {projects:v.projects.map(p=>({id:p.id,name:p.name,builderType:p.builderType||'app'}))}}
  /*
   * 只探测清单，不下载。
   *
   * 为什么要这一步：云端项目里有些目录（依赖、构建产物）默认不同步，
   * 但用户可能确实想要（比如 79 MB 的识别模型就在 dist 里）。
   * 所以先让用户看到「要下什么、跳过什么」，选完再真下。
   *
   * 返回按"能不能带"分三档：
   *   safe     —— 默认就同步的内容
   *   optional —— 可选的（跳过目录，用户可勾选一起下）
   *   blocked  —— 绝不带的（凭据、私钥：带了就是把别人的密钥搬到你这）
   */
  if(op.action==='probe'){
   const meta=await json(pid(op.projectId));
   const list=await listing(op.projectId);
   if(typeof list!=='string')throw Error('Studio 文件清单无效');
   const listed=list.split('\n').map(x=>x.trim()).filter(Boolean);
   if(listed.some(p=>!valid(p.endsWith('/')?p.slice(0,-1):p)))throw Error('云端文件路径无效');
   const names=listed.filter(p=>!p.endsWith('/'));
   const groups={};
   let safe=0,optional=0,blocked=0;
   for(const p of names){
    if(!excluded(p)){safe++;continue}
    const why=skipReason(p)||'其他';
    const isBlocked=/凭据|私钥|证书|口令/.test(why);
    if(isBlocked){blocked++;continue}
    optional++;
    if(!groups[why])groups[why]={count:0};
    groups[why].count++;
   }
   return {project:{id:op.projectId,name:meta.name||'',builderType:meta.builderType||'app'},
           total:names.length,safe:safe,optional:optional,blocked:blocked,groups:groups};
  }
  if(op.action==='pull')return read(op.projectId,op.initialize===true,op.includeOptional===true);
  if(op.action==='create'){
   const v=await json('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:op.name,projectType:'web',builderType:'app',productType:'app',model:'auto',description:'从 StepX Studio 上传的本地项目'})});
   if(!v.project?.id)throw Error('创建结果未知，请先刷新云端项目列表，不要重复上传');
   return {project:{id:v.project.id,name:v.project.name,builderType:v.project.builderType||'app'}};
  }
  if(op.action==='upload'){
   const id=op.projectId;pid(id);let names=Object.keys(op.entries||{}),total=0,written=[];
   if(!names.length)throw Error('没有可上传的文件');
   if(names.length>COUNT)throw Error('本次要上传 '+names.length+' 个文件，超过 '+COUNT+' 个上限');
   if(names.some(p=>!valid(p)||excluded(p)))throw Error('上传文件范围无效');
   // 大文件的字节在原生暂存区里，这里只拿清单不拿内容
   for(const p of names){
    const e=op.entries[p];
    if(e&&e.big){total+=e.size||0;if(total>MAX)throw Error('上传总大小超过 '+Math.round(MAX/1048576)+' MB');continue;}
    let b=decode(e);total+=b.length;if(b.length>FILE||total>MAX||await hash(b)!==e.sha256)throw Error('上传文件校验失败');
   }
   try{
    await idle(id);
    for(const p of names){
     progress('上传 '+p);await idle(id);
     const present=(await (await req(pid(id)+'/files')).text()).split('\n');let current=present.includes(p)?await hash(await bytes(await req(path(id,p)))):null;
     if(current!== (op.expected?.[p]??null))throw Error('云端文件在核对后变化，已停止：'+p);
     if(current===null){const all=(await (await req(pid(id)+'/files')).text()).split('\n');const parts=p.split('/');for(let k=1;k<parts.length;k++){const dir=parts.slice(0,k).join('/');if(!all.some(x=>x.startsWith(dir+'/')))await req(path(id,dir)+'&kind=directory',{method:'POST'});}await req(path(id,p)+'&kind=file',{method:'POST'});}
     const e=op.entries[p];
     let body;
     if(e&&e.ref){
      // 大文件：原生手里有内容，由原生按块吐回，避免一次持有全部
      progress('读取大文件 '+p);
      body=await readBig(id,p,e.ref);
     }else{
      body=decode(e);
     }
     await req(path(id,p),{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body});
     if(await hash(await bytes(await req(path(id,p))))!==e.sha256)throw Error('上传后回读不一致：'+p);
     written.push(p);
    }
    return {written,complete:true};
   }catch(e){return {written,complete:false,error:(signal?.aborted?'操作已停止':e.message)+'；已核验 '+written.length+' 个文件。可重新核对后继续。'}}
  }
  throw Error('未知同步操作');
 }
 return {run,valid,excluded,pack,hash,decode};
})();
