/*
 * app.js —— 本地工作台的主界面脚本
 * ================================================================
 *
 * 这是 StepX Studio 本地界面的核心文件。页面结构在 index.html 里用内联
 * HTML 字符串拼出来，所有交互逻辑都在这个文件里。
 *
 * 与原生通信的方式：
 *   调用  window.Neo.action(type, JSON字符串)   → 交给 MainActivity.Bridge
 *   接收  window.receive(type, data)            → 原生推过来的事件
 *
 * ── 本文件里所有按钮（data-a 动作）的含义 ──────────────────────────
 *
 * 【项目】
 *   projects            打开「本地项目」列表
 *   projectList         刷新项目列表
 *   newProject          新建一个空项目
 *   renameProject       改项目名字
 *   deleteProject       把项目移到「最近删除」（可恢复）
 *   trash               打开「最近删除」页，里面能恢复或彻底删除
 *   restoreSnapshot     把项目回滚到上一版快照（只保留最近一版）
 *   exportProject       把项目全部文件打成 ZIP 导出
 *   importProject       【导入 HTML / ZIP】把外面做好的网页项目搬进本应用。
 *                       点下去会打开手机的文件选择器，两种选法：
 *                         · 选 .zip 压缩包 → 解出里面最多 40 个文本文件（html/css/js/
 *                           图片路径等），当成一个完整的多文件项目
 *                         · 选单个 .html 文件 → 只有一个页面，当成单文件项目
 *                       两种情况都要求包里必须有 index.html，否则拒绝导入
 *                       （因为生成的 App 一启动就是找 index.html 来显示的）。
 *                       总大小限制 2 MB，超了会提示。导入后出现在「本地项目」列表。
 *   reviewAiFiles       审查 AI 改过的文件，逐条决定接受还是丢弃
 *   collab              进入「项目协作」页（任务、构建、Studio 联动都在里面）
 *   builds              打开「构建与调试」页
 *   preview             在手机本地预览项目效果（断网隔离，不联网）
 *   openStudioProject   打开项目关联的官方 Studio 网页
 *
 * 【文件编辑】
 *   file                打开某个文件开始编辑
 *   addFile             新建一个文件
 *   deleteFile          删除一个文件
 *   applyHtml           把编辑器里的 HTML 内容应用回项目
 *   undo                撤销上一次编辑
 *   redo                重做被撤销的编辑
 *   indent              自动整理代码缩进
 *   findCode            在代码里查找文字
 *   copyCode            复制代码到剪贴板
 *
 * 【AI 对话】
 *   ai                  发送一条 AI 请求
 *   aiCode              让 AI 直接生成/修改代码
 *   send                发送输入框里的消息
 *   cancel              取消正在跑的 AI 请求
 *   newChat             新建一段对话
 *   chatHistory         查看历史对话列表
 *   deleteChat          删除一段对话（只删对话，项目文件保留）
 *   exportChat          把对话导出成文本文件
 *   copyMessage         复制某一条消息
 *
 * 【模型配置】
 *   settings            打开「模型与 API」设置页
 *   editProfile         编辑某个模型配置
 *   saveProfile         保存模型配置
 *   deleteProfile       删除模型配置
 *   freshProfile        新建一个模型配置
 *   testProfile         测试这个配置能不能连通
 *   detectModels        让服务商返回它支持哪些模型
 *   localModels         打开「本地模型」页（下载/导入离线模型）
 *
 * 【云端同步】
 *   cloudList           拉取官方云端上的项目列表
 *   cloudUpload         把某个项目上传到云端
 *   cloudUploadAll      把所有本地项目一次性上传
 *   cloudPull           把云端项目下载到本地
 *   cloudRelay          云端接力开发：传到云端继续做
 *   cloudCancel         取消正在进行的同步
 *
 * 【其他】
 *   studio              切换到官方 Studio 网页
 *   help                打开「关于与使用说明」
 *   license             查看第三方开源许可
 *   checkUpdates        检查 GitHub 上有没有新版本
 *   backEditor          从子页面返回编辑器
 *
 * ================================================================
 */

'use strict';
const $=s=>document.querySelector(s),app=$('#app'),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid=()=>crypto.randomUUID(),send=(a,p={})=>Neo.action(a,JSON.stringify(p)),num=n=>Number(n||0).toLocaleString('zh-CN');
let S=JSON.parse(Neo.read()),page='projects',projectId=null,file='index.html',chatId=null,profileId=null,busy=false,pendingChat=null,requestMessages=null,usageScope='all',editProfile=null;

/* 编辑中的文件内容暂存。状态快照只带文件清单不带内容，所以内容放这儿。 */
let editBuffer={};

/*
 * 取项目的文本文件内容。
 *
 * 为什么不能直接用 p.files[n]：
 * 状态快照为了不撑爆内存，只带**文件清单**（路径 → 字节数），
 * 不带内容 —— 一个用了几天的工作台有 36 MB，全塞进快照会直接 OOM。
 * 所以内容按需取：打开一个文件取一个。
 *
 * @param p    项目对象（必须有 id）
 * @param path 项目内相对路径
 * @return 文件内容；取不到返回空串
 */
function fileContent(p,path){
  if(!p||!p.id||!path)return '';
  try{return Neo.readFile(p.id,path)||''}catch(e){return ''}
}

/*
 * 取一份恢复快照里的文件内容。
 *
 * 快照列表只带「有哪些文件、什么时候」，完整内容在原生那边，
 * 用 Neo.readSnapshot(projectId, index) 按序号取。
 */
function snapshotFiles(p,index){
  if(!p||!p.id)return {};
  try{return JSON.parse(Neo.readSnapshot(p.id,index))||{}}catch(e){return {}}
}

/*
 * 取文件的当前内容。
 *
 * 编辑器里改过的内容优先 —— 它还没存进原生，但已经是用户看到的样子。
 */
function currentContent(p,path){
  if(editBuffer[path]!==undefined)return editBuffer[path];
  return fileContent(p,path);
}

/*
 * 把项目的所有文本文件内容读出来（只在确实需要全部内容时用）。
 *
 * 比如：全局替换、预览编译、审查应用时的基线。都用这个，避免到处写循环。
 *
 * <p><b>必须走 currentContent，不能用 fileContent。</b>
 * 输出这份表的两个用途都对「内容」有严格假设：
 * <ul>
 *   <li>审查应用时它是传给原生的 {@code base}，原生拿它做
 *       {@code same(项目当前文件, base)} 的冲突检测 —— 基线不对，检测就是假的；</li>
 *   <li>审查页左右对比里「当前文件」一侧用的正是 currentContent。</li>
 * </ul>
 * 一边含编辑暂存、一边不含，两边看到的内容就不一样：
 * 用户以为在改 A，原生按 B 做冲突判断，结果要么误报「文件已变化」，
 * 要么该拦的改动没拦住。口径必须只有一份。
 */
function allFileContents(p){
  const out={};
  const names=Object.keys((p&&p.files)||{});
  for(const n of names)out[n]=currentContent(p,n);
  return out;
}
/*
 * 防抖保存。
 *
 * <p><b>为什么必须防抖：</b>编辑器原来每敲一个字符就 saveProject() 一次，
 * 而原生那边保存是把整份 workspace.json 重写一遍（实测 7.5 MB）。
 * 打字时每秒好几个字符，就是每秒写好几次 7.5 MB ——
 * 表现是打字卡顿、手机发热、闪存被反复擦写。
 *
 * <p>但也不能改成「只在不敲了才保存」：用户敲完立刻切走、或者电脑端
 * 直接断电，最后那几个字符就丢了。所以做两件事：
 * <ul>
 *   <li>敲字时只更新内存里的 editBuffer，400 毫秒没有新输入才落盘；</li>
 *   <li>任何「可能离开编辑」的动作之前先 flushNow()，把待写的补上。</li>
 * </ul>
 */
let saveTimer=null;
function saveSoon(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;try{saveProject();}catch(e){}},400);
}
function flushNow(){
  if(saveTimer===null)return;
  clearTimeout(saveTimer);saveTimer=null;
  try{saveProject();}catch(e){}
}
let pendingImages=[],detectedModels=[],draft=S.draft||'',includeCode=false,undo=[],redo=[],noticeTimer;aiLive=S.activeAi||{};
const defaults=()=>{for(const k of ['projects','profiles','chats','usage','projectTrash'])if(!Array.isArray(S[k]))S[k]=[]};defaults();
const project=()=>S.projects.find(x=>x.id===projectId),chat=()=>S.chats.find(x=>x.id===chatId),selectedProfile=()=>S.profiles.find(x=>x.id===profileId)||S.profiles[0];
function notice(s){$('#notice').textContent=s;$('#notice').style.display='block';clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').style.display='none',5000)}
function saveProject(){
  const p=project();
  if(!p)return;
  p.updated=Date.now();
  /*
   * 把暂存区的编辑内容合并进要发出去的文件表。
   *
   * 状态快照里 p.files 是「路径 → 字节数」的清单（不带内容），
   * 所以编辑中的内容放在 editBuffer，这里统一合并后再发给原生。
   * 原生那边有完整文件表，会用收到的新内容覆盖对应文件。
   */
  const payload=Object.assign({},p);
  payload.files=Object.assign({},p.files);
  for(const n in editBuffer){
    if(editBuffer[n]!==undefined)payload.files[n]=editBuffer[n];
  }
  // 保存失败不能静默，也不能拦住后面的动作 ——
  // 之前构建按钮点了没反应，就是这里抛异常把 send('buildApk') 掐断了。
  try{
    send('project',payload);
    if($('#saveStatus'))$('#saveStatus').textContent='草稿已保存到本机';
  }catch(e){
    notice('保存失败：'+(e&&e.message||e));
    throw e;
  }
}
function saveChat(c=chat()){
 if(!c)return;
 c.updated=Date.now();
 /*
  * 存盘时把图片的 base64 摘掉，只留张数。
  *
  * 一张压缩后的截图还有几百 KB，base64 之后更大。
  * 工作区状态是整份读写的（每次改动都写一遍磁盘），
  * 几 MB 的图片塞进去会让每一次操作都变慢，而且很快就会撑破传输上限。
  *
  * 注意是新建对象再摘 —— 直接改 c 会把内存里那份也改掉，
  * 当前这轮对话就看不到自己刚发的图了。
  */
 const slim={...c,messages:(c.messages||[]).map(m=>{
  if(!m.images||!m.images.length)return m;
  return {...m,images:undefined,imageCount:m.images.length};
 })};
 send('chat',slim);
}
/*
 * 原生把选中的图片压缩好之后回调这里。
 *
 * 为什么走回调而不是让前端自己读文件：WebView 拿不到相册的原生权限，
 * 只有原生侧能解码、压缩、转 base64。前端只负责接收一个 data URL。
 */
window.NeoImage=url=>{
  const s=String(url||'');
  if(!s.startsWith('data:image/')){notice('这张图没有读出来');return;}
  pendingImages=pendingImages.concat([s]);
  // 最多同时带 4 张：再多请求体会过大，而且模型也看不过来
  if(pendingImages.length>4){pendingImages=pendingImages.slice(-4);notice('最多同时带 4 张图，先移除了最早的一张');}
  render();
};
/* 用户取消选图：什么都不做，不要弹提示打扰他 */
window.NeoImageCancel=()=>{};
window.receive=(type,data)=>{
   /* 原生把联网/GitHub 配置和记忆内容异步送回来，存下来再重绘对应页面 */
   if(type==='integrationConfig'){try{window.integrationState=JSON.parse(data);}catch(e){window.integrationState={};}if(page==='integrations')render();return;}
   if(type==='memorySkills'){try{window.memoryState=JSON.parse(data);}catch(e){window.memoryState={};}if(page==='memory')render();return;}
  // 原生让前端打开某个文件（文件浏览器的「打开编辑」走这条路）
  if(type==='assetAudit'){window.auditReport=data;page='audit';render();return;}if(type==='openFile'){flushNow();file=String(data);undo=[];redo=[];page='editor';render();return;}
  if(type==='cloudRelay'){window.cloudRelayState=data;notice(data.message);if(page==='projects')projects();else if(page==='editor')editor();return;}if(type==='aiProjectCreated'){S=JSON.parse(Neo.read());if(chatId===data.chatId){projectId=data.projectId;aiEditMode='auto';renderIfAi();}return;}if(type==='cloudBatch'){S.cloudBatch=data;if(page==='projects')projects();return;}if(type==='connectorStatus'){connectorStatus=data;if($('#connectorStatus'))$('#connectorStatus').textContent=data;return;}if(type==='connectorsChanged'){S.connectors=data;if(page==='connectors')render();return;}if(type==='aiTool'){notice((data.ok?'已完成：':'工具未完成：')+data.name);return;}if(type==='aiLive'){aiLive=data;refreshLiveEdit();return;}if(type==='localModelProgress'){localModelStatus=data;refreshLocalModelProgress();return;}if(type==='localModelCatalog'){localModelCatalog=data;page='localModels';render();return;}if(type==='localModelsChanged'){S.localModels=data;if(page==='localModels')render();return;}if(type==='chatsDeleted'){S=JSON.parse(Neo.read());defaults();if(data.includes(chatId))chatId=null;historySelected.clear();historyEditing=false;if(page==='ai')render();refreshChatHistory();notice('已删除 '+data.length+' 段对话，Token 账本保留');return;}if(type==='cloudError'){notice(data);return;}if(type==='aiSetting'){S=JSON.parse(Neo.read());if(!S.aiAssistantEnabled&&page==='ai')page='projects';render();return;}if(type==='cloudUpdated'){S=JSON.parse(Neo.read());render();return;}if(type==='filesApplied'){
  /* 待写的内容先落盘，再让 AI 的改动覆盖 —— 否则这一笔会在之后某个时刻把 AI 的改动写回去 */
  flushNow();
  S=JSON.parse(Neo.read());projectId=data;candidateFiles=null;candidateBase=null;
  /*
   * 别把用户拽回 index.html。
   *
   * <p>AI 改完文件，用户往往正盯着刚才讨论的那个文件看改动。
   * 原来这里无条件 file='index.html' —— 视图直接跳走，
   * 用户得自己再点回去找到刚才那处改动。
   *
   * <p>而且这会让下一轮 AI 拿到的「当前正在看的文件」变成 index.html：
   * 用户接着说「这里还有问题」，模型却不知道「这里」是哪。
   *
   * <p>所以：当前文件还在项目里就留着，被删了才回退到 index.html。
   */
  const _ap=project();
  if(!_ap||!(_ap.files&&Object.prototype.hasOwnProperty.call(_ap.files,file)))file='index.html';
  /*
   * 清掉编辑暂存区。
   *
   * <p><b>这里不清就是个数据事故：</b>editBuffer 是「编辑器里看到的内容」的
   * 权威来源，currentContent() 优先读它。文件刚被 AI 改过，原生里已是新内容，
   * 但 editBuffer 里还留着改之前的旧字符串。
   *
   * <p>于是：编辑器继续显示旧代码 → 用户随手敲一个字或点一下保存 →
   * saveProject() 把 editBuffer 里的旧内容整体发给原生 →
   * <b>AI 刚写进去的改动被原样覆盖回去</b>，而且没有任何提示。
   *
   * <p>清空是安全的：editBuffer 的每次写入都紧跟一次 saveProject()，
   * 里面的内容早已落盘；清掉之后编辑器会重新从原生读最新内容。
   */
  editBuffer={};
  undo=[];redo=[];render();notice('文件已保存，已保留恢复快照');return;}if(type==='studioUsage'){S=JSON.parse(Neo.read());if(data.status==='runtime')studioReportId=data.report.projectId;if(page==='usage')usage();return;}if(type==='projectOpen'){
  flushNow();
  S=JSON.parse(Neo.read());defaults();projectId=data;file='index.html';undo=[];redo=[];
  /*
   * 换项目必须清编辑暂存。
   *
   * <p>editBuffer 是按「文件路径」存的，不带项目 id。
   * 而几乎所有项目都有 index.html —— 清空的话，打开 B 项目的 index.html
   * 会看到 A 项目里编辑过的内容，一敲键盘还会把它存进 B 项目。
   */
  editBuffer={};
  page='editor';render();return;}if(type==='projectChanged'){S=JSON.parse(Neo.read());defaults();if(data.id===projectId&&data.action!=='restore'){projectId=null;includeCode=false;undo=[];redo=[];}page=data.action==='trash'?'projects':page==='trash'?'trash':'projects';render();notice(data.action==='trash'?'已移到最近删除，可恢复':data.action==='restore'?'已恢复到本地项目':'项目已彻底删除');return;}if(type==='autoOpen'){S=JSON.parse(Neo.read());projectId=data;page='collab';render();return;}if(type==='autoUpdate'){S=JSON.parse(Neo.read());if((page==='collab'&&projectId===data)||page==='usage')render();return;}if(type==='buildReady'){S=JSON.parse(Neo.read());projectId=data;page='builds';render();notice('APK 已在 Neo 本机完成签名构建');}else if(type==='building'){buildBusy=data===true||data==='true';if(page==='builds')render();}else if(type==='state'){S=data;defaults();if(!['editor','settings','ai','collab','review','builds'].includes(page))render();}else if(type==='projectRefresh'){S=JSON.parse(Neo.read());if(page==='collab')render();}else if(type==='importCandidate'){S=JSON.parse(Neo.read());projectId=data.id;candidateFiles=data.files;candidateProjectId=data.id;candidateBase=allFileContents(project());candidateSource='Studio / ZIP 导入';page='review';render();}else if(type==='saved'){if($('#saveStatus'))$('#saveStatus').textContent='草稿已保存到本机';}else if(type==='profileSaved'){S=JSON.parse(Neo.read());defaults();editProfile=data.id;profileId=data.id;if(data.next==='local'){page='ai';render();notice('已切换到本地模型');}else if(data.next==='test'){page='ai';newChat();draft='请只回复：连接成功';sendMessage()}else if(page==='settings')settings();}else if(type==='models'){if(editProfile===data.id){detectedModels=data.models;settings();notice('检测到 '+data.models.length+' 个模型；列表可能由服务商分页返回，可继续手动填 ID')}}else if(type==='modelLoading'){if($('#detectButton'))$('#detectButton').textContent=(data===true||data==='true')?'检测中…':'保存并检测模型';}else if(type==='error'){notice(data);if($('#aiToggle'))$('#aiToggle').checked=S.aiAssistantEnabled!==false;busy=false;renderIfAi();}else if(type==='busy'){busy=data===true||data==='true';renderIfAi();refreshChatHistory();}else if(type==='reply'){S=JSON.parse(Neo.read());defaults();if(data.edit?.status==='applied'&&data.edit.projectId===projectId){
  /*
   * 自动应用后清掉编辑暂存 —— 不管用户当前在哪个页面。
   *
   * <p>原来这段只在 page==='editor' 时执行。可 AI 助手最常用的姿势就是
   * 待在 AI 页跟它聊、让它改代码，根本没进编辑器。
   * 这时候暂存区没被清：等用户切回编辑器，看到的是<b>改之前</b>的内容
   * （currentContent 优先读 editBuffer），一保存就把 AI 的改动覆盖回去。
   *
   * <p>「在哪个页面」和「暂存该不该失效」是两件不相干的事。
   */
  editBuffer={};undo=[];redo=[];
  if(!project()||!(file in project().files))file='index.html';
  if(page==='editor')render();else renderIfAi();
  notice('AI 已更新当前项目文件');
}else renderIfAi();}};
function renderIfAi(){if(page==='ai'||page==='collab'||page==='usage')render()}
window.backLocal=()=>{if(closeChatHistory())return true;if(page==='collab'||page==='review'||page==='builds'){page='editor';render();return true}if(page==='editor'){page='projects';render();return true}if(page==='trash'){page='projects';render();return true}if(page==='settings'||page==='help'||page==='localModels'||page==='connectors'){page=page==='settings'&&S.aiAssistantEnabled!==false?'ai':'projects';render();return true}return false};
window.navigate=p=>{closeChatHistory();if(p==='projects'&&page==='editor')return;page=p;render()};
function header(tag,title,sub){send('pageTitle',{page});return ''}
function render(){document.documentElement.dataset.ai=S.aiAssistantEnabled===false?'off':'on';if(page==='ai'&&S.aiAssistantEnabled===false)page='projects';send('pageTitle',{page});if(page==='art')return artPage();if(page==='artSettings')return artSettingsPage();if(page==='connectors')return connectorsPage();if(page==='localModels')return localModelsPage();if(page==='builds')return buildPage();if(page==='collab')return collaboration();if(page==='review')return reviewChanges();if(page==='files')return filesPage();
  if(page==='integrations')return integrationsPage();
  if(page==='memory')return memoryPage();
  if(page==='audit')return auditPage();
  if(page==='changes')return changesPage();
  if(page==='compare')return comparePage();
  if(page==='bigfiles')return bigFilesPage();
  if(page==='overview')return overviewPage();
  if(page==='replace')return replacePage();
  if(page==='editor')return editor();if(page==='projects')return projects();if(page==='trash')return trashPage();if(page==='settings')return settings();if(page==='ai')return ai();if(page==='usage')return usage();help()}
function projects(){app.innerHTML=`<div class="page">${header('CREATE ON NEO','把想法，写在手机里。','本机编辑与预览，随时接着做。')}<div class="row"><button class="primary" data-a="newProject">＋ 新建项目</button><button data-a="importProject">导入 HTML / ZIP</button><button data-a="cloudList">同步云端项目 ↓</button><button data-a="cloudUploadAll" ${!S.projects.length||S.cloudBatch?.running?'disabled':''}>全部上传同步 ↑</button></div>${cloudBatchCard()}<div class="card"><div class="row spread"><strong>Step Studio</strong><span class="tag">官方云端构建</span></div><p class="muted">用自然语言构建应用、智能体和技能。</p><button data-a="studio">打开官方 Studio ↗</button></div><div class="row spread"><h2>本地项目</h2><small>${S.projects.length} 个</small></div><p class="project-hint">长按菜单 · 左滑删除 · ↑ 上传到已登录的 Studio</p>${S.projects.length?S.projects.map(projectRow).join(''):`<div class="empty">从一个能运行的小页面开始。<br>支持 HTML、CSS、JavaScript，离线可用。</div>`}<div class="noticebar">本地 Web 项目可在编辑器“构建与调试”中离线生成 APK，也可交给 Step 云端构建。</div><details class="appearance"><summary>功能与显示设置</summary><label class="setting-switch"><input id="aiToggle" type="checkbox" ${S.aiAssistantEnabled!==false?'checked':''}>开启 AI 助手</label><small>关闭后隐藏底部入口；保留模型配置、对话和用量。</small><label for="appearanceSelect">界面材质</label><select id="appearanceSelect"><option value="glass">标准玻璃</option><option value="solid">降低透明度</option><option value="contrast">增强对比度</option></select></details><div class="row"><button data-a="trash">最近删除${S.projectTrash.length?` · ${S.projectTrash.length}`:''}</button><button data-a="help">使用说明</button></div></div>`;if($('#aiToggle'))$('#aiToggle').onchange=e=>send('aiEnabled',{value:e.target.checked});if($('#appearanceSelect'))$('#appearanceSelect').value=document.documentElement.dataset.appearance||'glass';}
function newProject(html){const name=prompt('项目名称','我的 Neo 应用');if(!name)return;const p={id:uuid(),name:name.slice(0,60),updated:Date.now(),files:{'index.html':html||'<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>我的 Neo 应用</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main>\n    <h1>你好，Neo</h1>\n    <p>第一个在手机上编辑的小应用。</p>\n    <button id="count">点按计数 · 0</button>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>','style.css':'body { margin: 0; padding: 32px 20px; font-family: system-ui; background: #eef7f4; color: #173d35; }\nmain { max-width: 560px; margin: auto; }\nbutton { background: #087f75; color: white; border: 0; border-radius: 14px; padding: 16px 24px; font-size: 18px; }','app.js':'let count = 0;\nconst button = document.querySelector("#count");\nif (button) button.onclick = () => {\n  button.textContent = `点按计数 · ${++count}`;\n};'}};S.projects.push(p);projectId=p.id;file='index.html';undo=[];redo=[];saveProject();page='editor';render()}
/* ============================================================
 * 变更视图与文件对比
 * ============================================================
 *
 * 要解决的问题：项目从云端同步下来、或者 AI 改完之后，
 * 根本不知道这次到底动了哪些文件。只能一个个点开看。
 *
 * 数据来源是项目里的 snapshots —— 每做一次同步或 AI 改代码，
 * 系统会把改之前的那份内容存成一个快照。所以「变更」
 * 就是当前文件跟最近一个快照比出来的差集。
 *
 * 这两件事全在前端算：state 里已经带着 files 和 snapshots，
 * 不用来回问原生，翻页立刻就有结果。
 */

/* 变更视图的筛选：all / added / changed / removed / binary */
let diffFilter = 'all';
/* 正在对比的文件路径 */
let diffPath = null;
/* 对比结果缓存 */
let diffResult = null;
/* 对比时铺开显示全部行，还是只显示有改动的行 */
let diffFull = false;

/**
 * 算出当前项目相对某个快照的差异。
 *
 * @param p         项目对象
 * @param snapIndex 用第几个快照；-1 或省略表示最近一个
 * @return {has, time, index, count, added, changed, removed, addedBinary, same}
 */
function computeDiff(p, snapIndex){
  const snaps=p.snapshots||[];
  if(!snaps.length)return {has:false,added:[],changed:[],removed:[],addedBinary:[],same:0,count:0};

  const idx=(snapIndex==null||snapIndex<0)?snaps.length-1:Math.min(snapIndex,snaps.length-1);
  const snap=snaps[idx]||{};
  /*
   * 快照的完整内容要从原生按需取（快照列表里只留了文件名）。
   * 当前文件内容也从原生取（状态快照是清单，不带内容）。
   */
  /*
   * 存档有两种形态：全量（当时的全部文件）和差量（只记改动过的文件的旧内容）。
   * 差量要先叠回当前文件表，才得到改动前的完整样子。
   */
  const snapFiles=snapshotFiles(p,idx);
  const nowFiles=p.files||{};
  const isDelta=!!(p.snapshots||[])[idx]&&!!(p.snapshots||[])[idx].delta;
  /*
   * 差量存档只记了「改动过的文件的旧内容」，
   * 所以只有这些文件需要读内容比较；其余文件必然没变。
   * 全量存档则每个文件都要比。
   */
  const added=[],changed=[],removed=[],addedBinary=[];
  let same=0;

  if(isDelta){
    /*
     * 差量：值是 null 的表示「存档时刻这个文件还不存在」→ 现在有就是新增。
     * added 名单里的同理（存档时刻之后新建的）。
     */
    const addedLater=(p.snapshots||[])[idx].added||[];
    for(const n of Object.keys(nowFiles)){
      if(!(n in snapFiles)){added.push(n);continue}
      if(snapFiles[n]===null||addedLater.includes(n)){added.push(n);continue}
      if(snapFiles[n]===currentContent(p,n))same++;
      else changed.push(n);
    }
    for(const n of Object.keys(snapFiles)){
      if(!(n in nowFiles)&&snapFiles[n]!==null)removed.push(n);
    }
  }else{
    for(const n of Object.keys(nowFiles)){
      if(!(n in snapFiles)){added.push(n);continue}
      if(snapFiles[n]===currentContent(p,n))same++;
      else changed.push(n);
    }
    for(const n of Object.keys(snapFiles)){
      if(!(n in nowFiles))removed.push(n);
    }
  }
  // 二进制文件不在 files 里，单独提一下 —— 同步/导入进来的图片、模型
  // 也算「这次变了什么」的一部分
  const oldBins=snap.binaryFiles||{};
  for(const n of Object.keys(p.binaryFiles||{})){
    if(!(n in oldBins))addedBinary.push(n);
  }

  added.sort();changed.sort();removed.sort();addedBinary.sort();
  return {has:true,time:snap.time||0,index:idx,count:snaps.length,
          added,changed,removed,addedBinary,same};
}

/**
 * 对两段文本做逐行比较。
 *
 * 算法是最长公共子序列：先找出相同的行当锚点，
 * 两个锚点之间夹着的就是删掉的行和新增的行。
 *
 * 规模保护：行数乘积超过 150 万就退化成「剥掉首尾相同的行，
 * 中间整段当重写」。结果仍然正确（该标的都标了），
 * 只是不会把相邻改动拆得那么细。手机内存经不起 3000×3000 的表。
 *
 * @param a 旧内容
 * @param b 新内容
 * @return [{t,n,text}]，t 是 '+' / '-' / ' '
 */
function diffLines(a,b){
  const A=splitLines(a),B=splitLines(b);
  const n=A.length,m=B.length;

  if(n*m>1500000)return roughDiff(A,B);

  // 用一维数组压成滚动的两行太绕，这里直接开表 —— 150 万以内 int 表约 6MB，可行
  const w=m+1;
  const lcs=new Int32Array((n+1)*w);
  for(let i=n-1;i>=0;i--){
    for(let j=m-1;j>=0;j--){
      lcs[i*w+j]=A[i]===B[j]?lcs[(i+1)*w+j+1]+1:Math.max(lcs[(i+1)*w+j],lcs[i*w+j+1]);
    }
  }

  const out=[];
  let i=0,j=0;
  while(i<n&&j<m){
    if(A[i]===B[j]){out.push({t:' ',n:j+1,text:B[j]});i++;j++}
    else if(lcs[(i+1)*w+j]>=lcs[i*w+j+1]){out.push({t:'-',n:i+1,text:A[i]});i++}
    else {out.push({t:'+',n:j+1,text:B[j]});j++}
  }
  while(i<n){out.push({t:'-',n:i+1,text:A[i]});i++}
  while(j<m){out.push({t:'+',n:j+1,text:B[j]});j++}
  return out;
}

/** 按换行切分，保留空行。 */
function splitLines(s){
  if(!s)return [];
  return String(s).replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
}

/** 超大文件的降级对比：剥掉首尾相同的行，中间整段当重写。 */
function roughDiff(A,B){
  const out=[];
  let head=0;
  while(head<A.length&&head<B.length&&A[head]===B[head]){
    out.push({t:' ',n:head+1,text:B[head]});head++;
  }
  let tail=0;
  while(tail<A.length-head&&tail<B.length-head&&
        A[A.length-1-tail]===B[B.length-1-tail])tail++;
  for(let i=head;i<A.length-tail;i++)out.push({t:'-',n:i+1,text:A[i]});
  for(let j=head;j<B.length-tail;j++)out.push({t:'+',n:j+1,text:B[j]});
  for(let i=A.length-tail;i<A.length;i++)out.push({t:' ',n:i+1,text:A[i]});
  return out;
}

/** 把一个时间戳变成「11月7日 22:15」这种看得懂的写法。 */
function fmtTime(ts){
  if(!ts)return '未知时间';
  const d=new Date(ts);
  const p=n=>String(n).padStart(2,'0');
  return (d.getMonth()+1)+'月'+d.getDate()+'日 '+p(d.getHours())+':'+p(d.getMinutes());
}

/**
 * 变更视图：列出当前项目相对最近快照的新增 / 修改 / 删除。
 */
/**
 * 素材体检结果页。
 *
 * 为什么单独做一页而不是弹个提示：缺片这件事要说清三件，
 * 缺哪个目录、缺几片、一共缺多少字节。挤在一条 5 秒消失的提示里等于没说。
 *
 * 判据来自项目自带的 chunks.json —— 它记录每片应有的字节数，
 * 逐片对照实际文件。少一片运行时就拼不出完整模型，
 * 而文件浏览器里 20 个分片摆着，看不出哪个是空的。
 */
/*
 * 联网与 GitHub 的设置页。
 *
 * 密钥不回显：页面上只标「已保存」，输入框留空表示不改动。
 * 这不是多此一举 —— 把 Token 明文写进 DOM，等于任何能读页面的人都拿到了密钥
 * （包括不小心截图发出去的那一刻）。
 */
function integrationsPage(){
 /*
  * 配置还没读回来时只显示「读取中」，不渲染表单。
  *
  * 不能拿 {} 兜底去渲染 —— 那样下拉框会显示「不使用」，
  * 用户以为没配过，随手点一下「保存」就把已有的服务商覆盖成空了。
  * 数据回来之前不给操作机会，比事后补救简单得多。
  */
 if(!window.integrationState){
  return `<div class="page">${header('EXTERNAL SERVICES','联网与 GitHub','两项都需要你自己提供服务商的密钥，密钥只存在这台手机上。')}<div class="card"><p class="muted">正在读取配置…</p></div></div>`;
 }
 const cfg=window.integrationState;
 return `<div class="page">${header('EXTERNAL SERVICES','联网与 GitHub','两项都需要你自己提供服务商的密钥，密钥只存在这台手机上。')}
 <div class="card"><h2>联网搜索</h2>
  <p class="muted">不配置也能用 web_fetch 抓已知网址，但 AI 无法主动搜索。</p>
  <label>服务商</label>
  <select id="searchProvider">
   <option value="" ${!cfg.searchProvider?'selected':''}>不使用</option>
   <option value="tavily" ${cfg.searchProvider==='tavily'?'selected':''}>Tavily（有免费额度）</option>
   <option value="serper" ${cfg.searchProvider==='serper'?'selected':''}>Serper（Google 结果）</option>
  </select>
  <label>API Key${cfg.hasSearchKey?' · 已保存':''}</label>
  <input id="searchKey" type="password" autocomplete="off" placeholder="${cfg.hasSearchKey?'已保存，留空表示不修改':'粘贴密钥'}">
  <div class="row" style="margin-top:12px"><button class="primary" data-a="saveNet">保存</button>${cfg.hasSearchKey?'<button class="danger" data-a="clearSearchKey">清除密钥</button>':''}</div>
 </div>
 <div class="card"><h2>GitHub</h2>
  <p class="muted">配置后可以让 AI 把项目传上 GitHub；之后只传改动的文件，不重传全部。</p>
  <label>Personal Access Token${cfg.hasToken?' · 已保存':''}</label>
  <input id="ghToken" type="password" autocomplete="off" placeholder="${cfg.hasToken?'已保存，留空表示不修改':'需要 repo 权限'}">
  <label>默认仓库</label>
  <div class="row"><input id="ghOwner" class="grow" placeholder="用户名（留空用 Token 对应账号）" value="${esc(cfg.ghOwner||'')}"><input id="ghRepo" class="grow" placeholder="仓库名" value="${esc(cfg.ghRepo||'')}"></div>
  <div class="row" style="margin-top:12px"><button class="primary" data-a="saveGithub">保存</button>${cfg.hasToken?'<button data-a="testGithub">测试连接</button><button class="danger" data-a="clearToken">断开</button>':''}</div>
 </div>
 <p class="muted">上传只处理文本文件；图片和模型权重会被跳过并列出来。</p></div>`;
}

/*
 * 记忆与技能页。
 *
 * 用户有权看见 AI 到底记住了什么 —— 如果记忆里有一句错的，
 * 而用户看不见，那个错误会跟着每一次对话重复下去。
 */
function memoryPage(){
 if(!window.memoryState){
  return `<div class="page">${header('MEMORY','记忆与技能','AI 跨对话保存下来的事实和做法。你能看，也能清掉。')}<div class="card"><p class="muted">正在读取…</p></div></div>`;
 }
 const s=window.memoryState;
 const skills=s.skills||[];
 const gLen=(s.global||'').length,pLen=(s.project||'').length;
 return `<div class="page">${header('MEMORY','记忆与技能','AI 跨对话保存下来的事实和做法。你能看，也能清掉。')}
 <div class="card"><h2>全局记忆</h2>
  <small>${num(gLen)} / ${num(s.globalCap||8000)} 字符</small>
  <pre class="contextPreview">${esc(s.global||'（还没有内容）')}</pre>
  ${gLen?'<button class="danger" data-a="clearMemory" data-scope="global">清空全局记忆</button>':''}
 </div>
 <div class="card"><h2>项目记忆${project()?' · '+esc(project().name):''}</h2>
  <small>${num(pLen)} / ${num(s.projectCap||6000)} 字符</small>
  <pre class="contextPreview">${esc(s.project||'（还没有内容）')}</pre>
  ${project()&&pLen?'<button class="danger" data-a="clearMemory" data-scope="project">清空项目记忆</button>':(project()?'':'<p class="muted">先在 AI 页选一个项目，才有项目记忆。</p>')}
 </div>
 <div class="card"><h2>技能 · ${skills.length} 个</h2>
  ${skills.length?skills.map(k=>`<div class="statrow"><b>${esc(k.name)}</b><br><small>${esc(k.description||'（没有描述）')}${k.bodyChars?' · '+num(k.bodyChars)+' 字符':''}</small></div>`).join(''):'<p class="muted">还没有技能。AI 做完一个多步骤任务后会把做法存下来，下次直接用。</p>'}
 </div></div>`;
}

function auditPage(){
  const r=window.auditReport||{};
  const back='<div class="row"><button data-a="backEditor">‹ 返回编辑</button></div>';
  let body;
  if(r.error){
    body=`<div class="card"><h2>体检没跑完</h2><p>${esc(r.error)}</p>
      <p class="muted">这是读取项目时出的问题，不是素材缺失。可以再点一次试试。</p></div>`;
  }else if(r.manifestCount===0&&!r.missingParts){
    body=`<div class="card"><h2>无需体检</h2>
      <p>${esc(r.note||'项目里没有分片清单。')}</p>
      <p class="muted">只有带 chunks.json 的资源才能核对，其他文件无从判断，不做猜测。</p></div>`;
  }else if(r.ok){
    body=`<div class="card"><h2>素材完整</h2>
      <p>${r.manifestCount||0} 组资源全部对得上，一片不缺。</p>
      <p class="muted">这表示模型和运行时的分片都能在项目里找到，并且字节数正确。</p></div>`;
  }else{
    const rows=(r.groups||[]).map(g=>{
      if(g.broken)return `<li>${esc(g.manifest)}：清单损坏，读不出该有哪些片</li>`;
      const items=(g.items||[]).map(it=>
        `<li>${esc(it.file)}：${it.parts} 片里缺 ${it.missing} 片（${fmtSize(it.missingBytes||0)}）</li>`).join('');
      return `<li>${esc(g.dir||g.manifest)}<ul>${items}</ul></li>`;
    }).join('');
    body=`<div class="card"><h2>缺 ${r.missingParts} 片</h2>
      <p>一共缺 ${fmtSize(r.missingBytes||0)}。少一片，运行时拼出来的文件就是坏的。</p>
      <ul>${rows}</ul>
      <p class="muted">用「补全素材」选一份完整安装包（带模型的 ZIP），只补缺的那些，已有的不会动。</p></div>`;
  }
  app.innerHTML=`<div class="page">${back}${body}</div>`;
}

function changesPage(){
  const p=project();
  if(!p){page='projects';render();return}
  const d=computeDiff(p);

  if(!d.has){
    app.innerHTML=`<div class="page">`+
      `<div class="row"><button data-a="backEditor">‹ 返回</button><h2 class="grow">变更</h2></div>`+
      `<div class="empty-note">`+
        `<div style="font-size:15px;font-weight:700;margin-bottom:10px">还没有对比基准</div>`+
        `要看出「改了什么」，得先有一个改之前的存档。`+
        `云端同步和 AI 改代码会自动存档，手动改文件不会。`+
        `<div style="margin-top:14px"><button data-a="makeSnapshot" style="width:100%">📷 现在就存一份存档</button></div>`+
        `<div style="margin-top:10px;font-size:12px;color:#8b8b95">存一份存档会把当前所有文本文件复制进项目数据。`+
        `文件很多的项目（几百个）会让应用变慢，建议只在需要对比时存。</div>`+
      `</div>`+
    `</div>`;
    return;
  }

  const total=d.added.length+d.changed.length+d.removed.length+d.addedBinary.length;
  const items=[];
  const push=(kind,list)=>{
    for(const n of list)items.push({kind,path:n});
  };
  if(diffFilter==='all'||diffFilter==='added')push('added',d.added);
  if(diffFilter==='all'||diffFilter==='changed')push('changed',d.changed);
  if(diffFilter==='all'||diffFilter==='removed')push('removed',d.removed);
  if(diffFilter==='all'||diffFilter==='binary')push('binary',d.addedBinary);

  const chip=(key,label,n)=>`<button class="fchip${diffFilter===key?' on':''}" data-a="diffFilter" data-id="${key}">${label} ${n}</button>`;

  app.innerHTML=`<div class="page">`+
    `<div class="row"><button data-a="backEditor">‹ 返回</button><h2 class="grow">变更</h2>`+
      `<button data-a="makeSnapshot">📷 存档</button></div>`+
    `<div class="diff-head">`+
      `<div class="diff-base">对比基准：${esc(fmtTime(d.time))} 的存档（第 ${d.index+1}/${d.count} 份）</div>`+
      `<div class="diff-sum">`+
        (d.added.length?`<span class="c-add">新增 ${d.added.length}</span>`:'')+
        (d.changed.length?`<span class="c-mod">修改 ${d.changed.length}</span>`:'')+
        (d.removed.length?`<span class="c-del">删除 ${d.removed.length}</span>`:'')+
        (d.addedBinary.length?`<span class="c-bin">新二进制 ${d.addedBinary.length}</span>`:'')+
        (!total?`<span class="c-same">跟存档完全一样</span>`:'')+
      `</div>`+
    `</div>`+
    `<div class="chips">${chip('all','全部',total)}${chip('added','新增',d.added.length)}`+
      `${chip('changed','修改',d.changed.length)}${chip('removed','删除',d.removed.length)}`+
      `${chip('binary','二进制',d.addedBinary.length)}</div>`+
    `<div class="fileTree">`+
      (items.length?items.map(it=>{
        const sign=it.kind==='added'?'+':it.kind==='removed'?'−':it.kind==='changed'?'~':'◈';
        const cls=it.kind==='added'?'c-add':it.kind==='removed'?'c-del':it.kind==='changed'?'c-mod':'c-bin';
        const act=it.kind==='binary'||it.kind==='added'?'openPath':'compare';
        return `<button class="drow" data-a="${act}" data-id="${esc(it.path)}">`+
          `<span class="dsign ${cls}">${sign}</span>`+
          `<span class="fpath">${esc(it.path)}</span>`+
          (it.kind==='changed'?`<span class="dhint">看改动 ›</span>`:'')+
        `</button>`;
      }).join(''):'<div class="muted" style="padding:16px">这一栏是空的</div>')+
    `</div>`+
  `</div>`;
}

/**
 * 文件对比页：把一个文件跟它在存档里的旧版本逐行比。
 */
function comparePage(){
  const p=project();
  if(!p){page='projects';render();return}
  const snaps=p.snapshots||[];
  const idx=snaps.length?snaps.length-1:0;
  const oldText=(snapshotFiles(p,idx)||{})[diffPath];
  const newText=currentContent(p,diffPath);

  // 缓存一下，切换「只看改动」时不用重算
  if(!diffResult||diffResult.path!==diffPath||diffResult.version!==(p.updated||0)){
    diffResult={path:diffPath,version:p.updated||0,rows:diffLines(oldText||'',newText||'')};
  }
  const rows=diffResult.rows;

  let add=0,del=0;
  for(const r of rows){if(r.t==='+')add++;else if(r.t==='-')del++}

  // 只看改动模式：把连续的未变行折叠成「… 跳过 N 行」
  let view=rows;
  if(!diffFull){
    view=[];
    let skip=0;
    for(const r of rows){
      if(r.t===' '){skip++;continue}
      if(skip){view.push({t:'gap',n:0,text:skip+' 行未变'});skip=0}
      view.push(r);
    }
    if(skip)view.push({t:'gap',n:0,text:skip+' 行未变'});
  }

  const body=view.map(r=>{
    if(r.t==='gap')return `<div class="dl gap">⋯ ${esc(r.text)}</div>`;
    const cls=r.t==='+'?'add':r.t==='-'?'del':'same';
    const mark=r.t==='+'?'+':r.t==='-'?'-':' ';
    return `<div class="dl ${cls}"><span class="dlno">${r.n||''}</span>`+
      `<span class="dlmk">${mark}</span>`+
      `<span class="dltx">${esc(r.text)}</span></div>`;
  }).join('');

  app.innerHTML=`<div class="page">`+
    `<div class="row"><button data-a="backChanges">‹ 变更</button>`+
      `<h2 class="grow difftitle">${esc(diffPath)}</h2></div>`+
    `<div class="diff-head"><div class="diff-sum">`+
      `<span class="c-add">+${add}</span> <span class="c-del">−${del}</span>`+
      `<span class="c-same">· 共 ${rows.length} 行</span>`+
    `</div><div class="chips">`+
      `<button class="fchip${diffFull?'':' on'}" data-a="diffFull" data-id="0">只看改动</button>`+
      `<button class="fchip${diffFull?' on':''}" data-a="diffFull" data-id="1">全部行</button>`+
      `<button class="fchip" data-a="openPath" data-id="${esc(diffPath)}">打开文件</button>`+
    `</div></div>`+
    `<div class="diffbody">${body||'<div class="muted" style="padding:16px">两边内容一样</div>'}</div>`+
  `</div>`;
}

/* ============================================================
 * 大文件管理
 * ============================================================
 *
 * 同步进来的语音识别模型一个就 4 MB，二十张图又是几 MB。
 * 这些文件在编辑器里看不见（编辑器只列文本），
 * 想清理的时候无从下手。这一页把它们全列出来，按体积排序。
 */

/** 大文件管理页。 */
function bigFilesPage(){
  const p=project();
  if(!p){page='projects';render();return}
  const bins=p.binaryFiles||{},sizes=p.binarySizes||{};

  const list=[];
  for(const n of Object.keys(bins)){
    const ref=bins[n]||'';
    const big=ref.endsWith('.bin');
    const size=sizes[n];
    list.push({path:n,big,size:(size==null?-1:size)});
  }
  // 大的排前面 —— 要清空间时先看最大的
  list.sort((a,b)=>b.size-a.size);

  const total=list.reduce((s,x)=>s+Math.max(0,x.size),0);
  const nBig=list.filter(x=>x.big).length;

  app.innerHTML=`<div class="page">`+
    `<div class="row"><button data-a="backEditor">‹ 返回</button><h2 class="grow">大文件</h2></div>`+
    `<div class="diff-base">共 ${list.length} 个二进制文件 · 合计 ${fmtSize(total)}`+
      (nBig?` · 其中 ${nBig} 个存在项目目录里`:'')+`</div>`+
    `<div class="fmeta">大文件的内容存在手机里，删掉能真正腾出空间。`+
      `小的二进制直接内嵌在项目数据里，删掉只是从项目移除。</div>`+
    `<div class="fileTree">`+
      (list.length?list.map(f=>`<div class="frow">`+
        `<button class="fname" data-a="bigInfo" data-id="${esc(f.path)}">`+
          `<span class="ficon">${f.big?'🗃':'🧩'}</span>`+
          `<span class="fpath">${esc(f.path)}</span>`+
          `<span class="fsize">${fmtSize(f.size)}</span>`+
          (f.big?`<span class="fbadge">占用存储</span>`:'')+
        `</button>`+
        `<button class="fdel" data-a="bigDelete" data-id="${esc(f.path)}">删</button>`+
      `</div>`).join(''):'<div class="muted" style="padding:16px">这个项目没有二进制文件</div>')+
    `</div>`+
  `</div>`;
}

/* ============================================================
 * 项目总览
 * ============================================================
 *
 * 一个地方看清：多少文件、多大、什么时候动过、有几个存档。
 */

/** 项目总览页。 */
function overviewPage(){
  const p=project();
  if(!p){page='projects';render();return}

  const files=p.files||{},bins=p.binaryFiles||{},sizes=p.binarySizes||{};
  const nText=Object.keys(files).length;
  const nBin=Object.keys(bins).length;
  let textBytes=0;
  // files 里的值是字节数（快照是瘦身后的清单，不带内容）
  for(const n of Object.keys(files))textBytes+=(Number(files[n])||0);
  let binBytes=0,nBig=0;
  for(const n of Object.keys(bins)){
    binBytes+=Math.max(0,sizes[n]==null?0:sizes[n]);
    if(String(bins[n]||'').endsWith('.bin'))nBig++;
  }
  const snaps=(p.snapshots||[]).length;
  const d=computeDiff(p);

  const line=(k,v,extra)=>`<div class="ovrow"><span class="ovk">${k}</span>`+
    `<span class="ovv">${v}</span>${extra?`<span class="ovx">${extra}</span>`:''}</div>`;

  app.innerHTML=`<div class="page">`+
    `<div class="row"><button data-a="backEditor">‹ 返回</button><h2 class="grow">项目总览</h2></div>`+
    `<div class="ovcard">`+
      `<div class="ovname">${esc(p.name||'未命名项目')}</div>`+
      `<div class="ovsub">最后修改 ${esc(fmtTime(p.updated))}</div>`+
    `</div>`+
    `<div class="ovcard">`+
      line('文本文件',nText+' 个',fmtSize(textBytes))+
      line('二进制文件',nBin+' 个',fmtSize(binBytes))+
      (nBig?line('其中占存储',nBig+' 个','内容在手机里'):'')+
      line('文件合计',(nText+nBin)+' 个',fmtSize(textBytes+binBytes))+
      line('存档',snaps+' 份',snaps?'可做变更对比':'还没有，变更视图用不了')+
    `</div>`+
    `<div class="ovcard">`+
      `<div class="ovtitle">这次改了什么</div>`+
      (d.has?`<div class="diff-sum">`+
        (d.added.length?`<span class="c-add">新增 ${d.added.length}</span>`:'')+
        (d.changed.length?`<span class="c-mod">修改 ${d.changed.length}</span>`:'')+
        (d.removed.length?`<span class="c-del">删除 ${d.removed.length}</span>`:'')+
        (!d.added.length&&!d.changed.length&&!d.removed.length?`<span class="c-same">跟存档一致</span>`:'')+
        `</div><div class="ovsub" style="margin-top:6px">基准：${esc(fmtTime(d.time))}</div>`
       :`<div class="ovsub">还没有对比基准，点下面的「拍一份存档」，之后再改东西就能看出差别。</div>`)+
    `</div>`+
    `<div class="ovbtns">`+
      `<button data-a="changesPage">变更视图</button>`+
      `<button data-a="filesPage">全部文件</button>`+
      `<button data-a="bigfilesPage">大文件</button>`+
      `<button data-a="replacePage">全局替换</button>`+
      `<button data-a="snapshotNow">📷 拍一份存档</button>`+
      `<button data-a="builds">构建 APK</button>`+
    `</div>`+
  `</div>`;
}

/* ============================================================
 * 全局替换
 * ============================================================
 *
 * 搜索能一次找到几十个文件里的同一个词，但改起来还得一个个进去改。
 * 这一页做的是：所有文本文件里一次替换，先给预览再动手。
 */

/* 替换页的输入状态。存在变量里，因为每次重绘会重建 DOM。 */
let rpFind='';
let rpWith='';
let rpCase=false;

/** 数一段文字里出现多少次关键词。 */
function countOcc(src,find,caseSensitive){
  if(!find)return 0;
  const s=caseSensitive?src:src.toLowerCase();
  const f=caseSensitive?find:find.toLowerCase();
  let n=0,i=0;
  while((i=s.indexOf(f,i))>=0){n++;i+=f.length||1}
  return n;
}

/** 把 src 里所有 find 换成 with。 */
function replaceIn(src,find,withText,caseSensitive){
  if(!find)return src;
  if(caseSensitive)return src.split(find).join(withText);
  // 不区分大小写：用正则，先把特殊字符转义掉
  const escRe=find.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return src.replace(new RegExp(escRe,'gi'),()=>withText);
}

/** 全局替换页。 */
function replacePage(){
  const p=project();
  if(!p){page='projects';render();return}
  const files=p.files||{};

  // 预览：哪些文件命中、各多少处
  const hits=[];
  let totalHits=0;
  if(rpFind){
    for(const n of Object.keys(files).sort()){
      const c=countOcc(fileContent(p,n),rpFind,rpCase);
      if(c>0){hits.push({path:n,n:c});totalHits+=c}
    }
  }

  app.innerHTML=`<div class="page">`+
    `<div class="row"><button data-a="backEditor">‹ 返回</button><h2 class="grow">全局替换</h2></div>`+
    `<div class="rpform">`+
      `<input id="rpFind" type="search" placeholder="要查找的内容" value="${esc(rpFind)}" autocomplete="off">`+
      `<input id="rpWith" type="search" placeholder="替换成（留空表示删除）" value="${esc(rpWith)}" autocomplete="off">`+
      `<label class="rpcb"><input type="checkbox" id="rpCase"${rpCase?' checked':''}>区分大小写</label>`+
    `</div>`+
    (rpFind?`<div class="diff-base">`+
      (totalHits?`${hits.length} 个文件里共 ${totalHits} 处`:'没有找到要替换的内容')+
      `</div>`:'')+
    `<div class="fileTree">`+
      (hits.length?hits.map(h=>`<button class="drow" data-a="compare" data-id="${esc(h.path)}">`+
        `<span class="dsign c-mod">${h.n}</span>`+
        `<span class="fpath">${esc(h.path)}</span>`+
        `<span class="dhint">${h.n} 处</span></button>`).join(''):'')+
    `</div>`+
    (totalHits?`<button class="rpgo" data-a="replaceDo">全部替换（${totalHits} 处）</button>`:'')+
  `</div>`;

  const bind=(sel,fn)=>{const el=$(sel);if(el)el.addEventListener('input',fn)};
  bind('#rpFind',e=>{rpFind=e.target.value;replacePage()});
  bind('#rpWith',e=>{rpWith=e.target.value});
  const cb=$('#rpCase');
  if(cb)cb.addEventListener('change',e=>{rpCase=e.target.checked;replacePage()});
}

/* ============================================================
 * 文件浏览器
 * ============================================================
 *
 * 为什么要有这个页面：
 * 编辑器里的文件栏是一排横向按钮。项目只有三五个文件时够用，
 * 但从云端同步或导入 ZIP 进来的真实项目动辄两三百个文件，
 * 排成一行根本没法找 —— 想改某个文件只能一直往右滑。
 *
 * 这个页面把文件按目录分组列出，支持：
 *   · 按文件名或文件内容搜索（内容是跨所有文本文件搜）
 *   · 显示每个文件的大小和类型（文本 / 二进制 / 大文件）
 *   · 重命名、复制、删除、复制内容到剪贴板
 *
 * 二进制文件不显示在编辑器的文件栏里（那里只列文本文件），
 * 但在这里能看到全 —— 模型、图片这些也在。
 */

/* 文件浏览器里的搜索关键词，空串表示不搜索 */
let fileQuery = '';
/* 目录折叠状态：目录名 → 是否收起 */
let fileCollapsed = {};
/* 代码全屏模式：隐藏其他区块，代码框占满整屏 */
let codeFocus = false;
/* 代码字号，存本地，下次打开还是这个大小 */
let codeFont = parseInt(localStorage.getItem('codeFont')||'13', 10) || 13;

/** 把当前字号应用到代码框。 */
function applyCodeFont(){
  const c=$('#code');
  if(c)c.style.fontSize=codeFont+'px';
}

/**
 * 列出项目里的全部文件，文本和二进制都算。
 *
 * @param p 项目对象
 * @return [{path, kind, size}]，按路径排序
 *   kind: 'text' 文本 / 'bin' 普通二进制 / 'big' 大文件（内容在磁盘上）
 */
function allFiles(p){
  const out=[];
  for(const n of Object.keys(p.files||{}))out.push({path:n,kind:'text',size:Number(p.files[n])||0});
  const bins=p.binaryFiles||{},sizes=p.binarySizes||{};
  for(const n of Object.keys(bins)){
    const ref=bins[n]||'';
    out.push({path:n,kind:ref.endsWith('.bin')?'big':'bin',size:sizes[n]??-1});
  }
  out.sort((a,b)=>a.path.localeCompare(b.path));
  return out;
}

/** 把字节数变成人看的大小。 */
function fmtSize(n){
  if(n<0)return '大小未知';
  if(n<1024)return n+' B';
  if(n<1048576)return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}

/**
 * 按名字或内容搜索文件。
 *
 * @param p 项目对象
 * @param q 关键词（已转小写）
 * @return Map，路径 → 命中行号数组（按名字命中的是空数组）
 */
function searchFiles(p,q){
  const hits=new Map();
  if(!q)return hits;
  for(const n of Object.keys(p.files||{})){
    if(n.toLowerCase().includes(q)){hits.set(n,[]);continue}
    const v=fileContent(p,n);
    const idx=v.toLowerCase().indexOf(q);
    if(idx>=0)hits.set(n,[v.slice(0,idx).split('\n').length]);
  }
  for(const n of Object.keys(p.binaryFiles||{})){
    if(n.toLowerCase().includes(q)&&!hits.has(n))hits.set(n,[]);
  }
  return hits;
}

/**
 * 打开某个文件的操作菜单。
 *
 * 具体操作交给原生做 —— 项目的权威数据在原生那边（state），
 * 前端只是一份快照。前端改完再 send 回去，容易出现两边不一致；
 * 让原生改完 sendState() 推回来，只有一条路径。
 *
 * @param path 文件路径
 */
function fileMenu(path){
  const p=project();
  if(!p)return;
  send('fileOps',{projectId:p.id,path});
}

/**
 * 求一组路径的公共目录前缀，带结尾斜杠。
 *
 * 移动多个文件时用它当「源目录」：把前缀换成新目录，
 * 文件在各自原有位置不变。比如选中 src/a.js 和 src/b.js，
 * 公共前缀是 src/，移到 lib 就变成 lib/a.js、lib/b.js。
 *
 * @param paths 路径数组
 * @return 公共前缀，如 'src/'；没有公共目录时返回空串
 */
function commonDir(paths){
  if(!paths.length)return '';
  const dirs=paths.map(p=>{
    const i=p.lastIndexOf('/');
    return i<0?'':p.slice(0,i+1);
  });
  let c=dirs[0];
  for(const d of dirs){
    while(c&&!d.startsWith(c))c=c.slice(0,Math.max(0,c.lastIndexOf('/',c.length-2)+1));
    if(!c)return '';
  }
  return c;
}

/**
 * 原生问完目标目录后回调这里，执行批量移动。
 * @param dir 目标目录，不带首尾斜杠；空串表示移到根目录
 */
function doBulkMove(dir){
  const p=project();
  if(!p||!selected.size)return;
  const paths=[...selected];
  const from=commonDir(paths);
  send('bulkFiles',{projectId:p.id,action:'move',paths:paths,from:from,to:dir});
  // 立刻退出选择模式，等原生推回新状态
  selected.clear();selectMode=false;
  notice('正在移动 '+paths.length+' 个文件到 '+(dir||'根目录'));
}

/* 多选模式：底部出现批量操作栏 */
let selectMode = false;
/* 选中的文件路径集合 */
let selected = new Set();

/**
 * 文件浏览器页面。
 *
 * 两件事共用一套渲染：浏览和批量管理。
 * 打开选择模式后，每行前面出现勾选圈，底部出现操作栏。
 */
function filesPage(){
  const p=project();
  if(!p){page='projects';render();return}
  const all=allFiles(p),q=fileQuery.trim().toLowerCase();
  const hits=searchFiles(p,q);
  const shown=q?all.filter(f=>hits.has(f.path)):all;

  app.innerHTML=`<div class="page files-page">`+
    `<div class="row">`+
      `<button data-a="backEditor">‹ 返回编辑</button>`+
      `<h2 class="grow">文件</h2>`+
      (selectMode
        ? `<button data-a="fmSelectOff">完成</button>`
        : `<button data-a="replacePage">替换</button><button data-a="fmSelectOn">选择</button>`)+
    `</div>`+
    `<input id="fileSearch" type="search" placeholder="搜索文件名，或输入一段文字在全部文件里找…" value="${esc(fileQuery)}" autocomplete="off">`+
    `<div class="fmeta">${buildFileMeta(p,q,hits)}</div>`+
    `<div class="fileTree" id="fileTree">${renderFileRows(shown,hits)}</div>`+
    (selectMode?fileSelectBar(shown):'')+
  `</div>`;

  const box=$('#fileSearch');
  if(box){
    box.addEventListener('input',()=>{
      fileQuery=box.value;
      // 只重绘文件树 —— 整页重绘会把输入框重建，焦点和光标位置就丢了
      const pp=project();
      const qq=fileQuery.trim().toLowerCase();
      const hh=searchFiles(pp,qq);
      const list=(qq?allFiles(pp).filter(f=>hh.has(f.path)):allFiles(pp));
      const tree=$('#fileTree');
      if(tree)tree.innerHTML=renderFileRows(list,hh);
      const mx=document.querySelector('.files-page .fmeta');
      if(mx)mx.textContent=buildFileMeta(pp,qq,hh);
      // 选择模式下搜索框变了，底部「已选 N 个」的计数也要跟着走
      const bar=document.querySelector('.fbar-count');
      if(bar)bar.textContent='已选 '+selected.size+' 个';
    });
  }
}

/** 选择模式下的底部操作栏。 */
function fileSelectBar(shown){
  // 当前列表是不是已经全选上了（搜索过滤后只算看得见的）
  const allOn=shown.length>0&&shown.every(f=>selected.has(f.path));
  return `<div class="fbar">`+
    `<button data-a="fmAll" data-id="${allOn?'0':'1'}">${allOn?'取消全选':'全选'}</button>`+
    `<span class="grow fbar-count">已选 ${selected.size} 个</span>`+
    `<button data-a="fmMove"${selected.size?'':' disabled'}>移动</button>`+
    `<button class="danger" data-a="fmDelete"${selected.size?'':' disabled'}>删除</button>`+
  `</div>`;
}

/**
 * 把文件列表渲染成一行行 HTML。
 *
 * @param list  文件数组（来自 allFiles）
 * @param hits  搜索结果，路径 → 命中行号数组
 */
function renderFileRows(list,hits){
  const groups=new Map();
  for(const f of list){
    const i=f.path.lastIndexOf('/');
    const dir=i<0?'':f.path.slice(0,i);
    if(!groups.has(dir))groups.set(dir,[]);
    groups.get(dir).push(f);
  }
  const rows=[];
  for(const [dir,arr] of groups){
    const key=dir||'\u0000root';
    const collapsed=fileCollapsed[key]===true;
    rows.push(`<button class="fdir" data-a="fmToggle" data-id="${esc(key)}">`+
      `<span class="fcaret">${collapsed?'▸':'▾'}</span>`+
      `<span class="fdirname">${esc(dir||'（根目录）')}</span>`+
      `<span class="fcount">${arr.length}</span></button>`);
    if(collapsed)continue;
    for(const f of arr){
      const base=dir?f.path.slice(dir.length+1):f.path;
      const icon=f.kind==='text'?'📄':f.kind==='big'?'🗃':'🧩';
      const lineHit=(hits.get(f.path)||[])[0];
      const badge=f.kind==='text'?'':(f.kind==='big'?'大文件':'二进制');
      const on=selected.has(f.path);
      rows.push(`<div class="frow${selectMode?' sel-mode':''}">`+
        (selectMode?`<button class="fcheck${on?' on':''}" data-a="fmSelect" data-id="${esc(f.path)}">${on?'✓':''}</button>`:'')+
        `<button class="fname${on?' picked':''}" data-a="${selectMode?'fmSelect':'file'}" data-id="${esc(f.path)}">`+
          `<span class="ficon">${icon}</span>`+
          `<span class="fpath">${esc(base)}</span>`+
          `<span class="fsize">${fmtSize(f.size)}</span>`+
          (badge?`<span class="fbadge">${badge}</span>`:'')+
          (lineHit?`<span class="fhit">第 ${lineHit} 行</span>`:'')+
        `</button>`+
        (selectMode?'':`<button class="fmore" data-a="fileMenu" data-id="${esc(f.path)}">⋯</button>`)+
      `</div>`);
    }
  }
  return rows.join('')||'<div class="muted" style="padding:16px">没有匹配的文件</div>';
}

/** 顶部那行统计文字。 */
function buildFileMeta(p,q,hits){
  const all=allFiles(p);
  const nText=all.filter(f=>f.kind==='text').length;
  const nBin=all.length-nText;
  const nBig=all.filter(f=>f.kind==='big').length;
  return `共 ${all.length} 个 · 文本 ${nText}`+
    (nBin?` · 二进制 ${nBin}`:'')+
    (nBig?`（其中大文件 ${nBig}）`:'')+
    (q?` · 匹配 ${hits.size} 个`:'');
}

function editor(){const p=project();if(!p){page='projects';render();return}if(!(file in p.files))file=Object.keys(p.files)[0];app.innerHTML=`<div class="editor${codeFocus?' code-focus':''}" id="editorRoot"><div class="row"><button data-a="projectList">‹ 项目</button><h2 class="grow">${esc(p.name)}</h2><button class="primary" data-a="preview">本地运行 ▷</button>${p.cloudSource?'<button data-a="openStudioProject">云端 ↗</button>':''}</div>${cloudControls(p)}<div class="row"><button data-art="open">美术资源</button></div>${liveEditCard()}<div class="files"><button class="chosen" data-a="file" data-id="${esc(file)}">${esc(file)}</button><button data-a="filesPage">📁 全部 ${allFiles(p).length} 个</button><button data-a="changesPage">变更</button><button data-a="overviewPage">总览</button><button data-a="addFile">＋ 文件</button></div><textarea id="code" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="代码编辑器" wrap="off"></textarea><div class="tools"><button data-a="codeFocus">${codeFocus?'⛶ 退出全屏':'⛶ 全屏'}</button><button data-a="fontMinus">A−</button><button data-a="fontPlus">A+</button><button data-a="indent">Tab</button><button data-a="undo">撤销</button><button data-a="redo">重做</button><button data-a="findCode">查找</button><button data-a="gotoLine">跳行</button><button data-a="copyCode">复制</button><button data-a="collab">项目协作</button><button data-a="builds">构建 APK</button><button data-a="aiCode">问 AI</button><button data-a="exportProject">导出 ZIP</button><button data-a="renameProject">重命名</button><button class="danger" data-a="deleteFile">删文件</button><button class="danger" data-a="deleteProject">删项目</button></div><div class="status" id="saveStatus">本机自动保存 · ${(p.files[file]||0)} 字符</div></div>`;document.querySelector('.files .chosen')?.scrollIntoView({block:'nearest',inline:'center'});
  /*
   * 渲染编辑器一律用 currentContent，不能用 fileContent。
   *
   * <p>fileContent 只读<b>已存盘</b>的内容；用户正在敲的东西在 editBuffer 里。
   * 保存是异步发出去的，所以两者之间永远有一段窗口不一致。
   *
   * <p>只要这期间发生一次重新渲染（state 事件回来、切页面再切回来、
   * 改个字体、AI 那边推了条状态），输入框就会被塞回磁盘上的旧内容 ——
   * 用户看着自己刚敲的几行字凭空消失，然后再敲一遍。
   *
   * <p>currentContent 的定义就是「编辑器里应该显示什么」：暂存优先、落盘兜底。
   * 渲染走它，这条路径才是自洽的。
   */
  $('#code').value=currentContent(p,file);
  applyCodeFont();$('#code').disabled=!file;$('#code').addEventListener('input',()=>{undo.push(editBuffer[file]!==undefined?editBuffer[file]:fileContent(p,file));if(undo.length>80)undo.shift();redo=[];editBuffer[file]=$('#code').value;saveSoon()});
  /* 离开输入框（切走、点了别处）立刻落盘，不留未保存的内容 */
  $('#code').addEventListener('blur',()=>flushNow());$('#code').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();insert('  ')}if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveProject()}})}
/**
 * 跳到代码的第 n 行。
 *
 * textarea 没有「滚到某一行」的 API，所以分两步：
 * 先把光标选中放在那一行的字符位置上（浏览器会保证光标可见），
 * 再按行高估算一个 scrollTop 把它摆到屏幕中间 ——
 * 光靠选中会让那一行贴着顶部，看不出上下文。
 *
 * @param n 行号，从 1 开始
 */
function gotoLine(n){
  const ta=$('#code');
  if(!ta)return;
  const arr=ta.value.split('\n');
  const line=Math.max(1,Math.min(Math.floor(n)||1,arr.length));
  let pos=0;
  for(let i=0;i<line-1;i++)pos+=arr[i].length+1;
  ta.focus();
  try{ta.setSelectionRange(pos,pos+arr[line-1].length)}catch(e){}
  const cs=getComputedStyle(ta);
  const lh=parseFloat(cs.lineHeight)||(codeFont*1.6);
  ta.scrollTop=Math.max(0,(line-1)*lh-ta.clientHeight/2+lh);
  notice('已跳到第 '+line+' 行，全文共 '+arr.length+' 行');
}

function insert(t){const e=$('#code');if(!e)return;const pos=e.selectionStart;e.setRangeText(t,pos,e.selectionEnd,'end');e.dispatchEvent(new Event('input'));e.focus()}
function compiled(p){let html=fileContent(p,'index.html');const doc=new DOMParser().parseFromString(html,'text/html');for(const el of [...doc.querySelectorAll('link[rel="stylesheet"][href]')]){let n=el.getAttribute('href').replace(/^\.\//,'');if(p.files[n]!=null){let s=doc.createElement('style');s.textContent=fileContent(p,n);el.replaceWith(s)}}for(const el of [...doc.querySelectorAll('script[src]')]){let n=el.getAttribute('src').replace(/^\.\//,'');if(p.files[n]!=null){let s=doc.createElement('script');s.textContent=fileContent(p,n).replace(/<\/script/gi,'<\\/script');el.replaceWith(s)}}return '<!doctype html>\n'+doc.documentElement.outerHTML}
let aiEditMode='auto',githubResearch=true,aiSetupOpen=false;
function aiProjectCard(){return `<div class="card ai-target"><div class="ai-target-fields"><div><label for="aiProject">目标项目</label><select id="aiProject" ${busy?'disabled':''}><option value="">仅对话 · 不写入</option>${S.projects.map(x=>`<option value="${esc(x.id)}" ${x.id===projectId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>${project()?`<div><label for="aiEditMode">工作方式</label><select id="aiEditMode" ${busy?'disabled':''}><option value="auto">直接修改 · 留快照</option><option value="review">先审查修改</option><option value="discuss">只讨论项目</option></select></div>`:''}</div>${project()?`<label class="setting-switch"><input id="githubResearch" type="checkbox" ${githubResearch?'checked':''}>开发前检索 GitHub 参考</label><small>先查可复用实现、核对许可证，再编写代码；关闭后可完全离线开发。</small>${artControls()}<details><summary>开发工具与写入说明</summary><small>AI 可列出/读取文件、搜索代码、暂存修改、本机编译检查、预览、离线构建 APK、读取调试日志。每轮最多40次工具循环，过程和结果可查看。</small><small>每轮读取全部最新文件和调试报告。仅写入选定项目；冲突或截断不会覆盖。你手动存的存档一直保留，自动存档留最近 5 份。</small><div class="row"><button data-a="backEditor">文件</button><button data-a="preview">预览</button><button data-a="builds">构建 APK</button>${project().snapshots?.length?'<button data-a="restoreSnapshot">恢复文件</button>':''}</div></details>`:'<small>直接说“新建一个待办项目”，助手会创建本地项目并写入代码。也可以选择已有项目继续开发。</small>'}</div>`;}

/*
 * 渲染一条 AI 消息的正文。
 *
 * <p><b>为什么正文不能折叠：</b>早先只要这条消息带编辑结果（m.edit），
 * 就把正文包进 <details>「查看 AI 返回的代码与说明」里，默认收起。
 * 于是用户看到的是一排折叠条 —— 「已保存到指定项目」「GitHub 参考」
 * 「开发工具记录」「推理内容」—— 唯独看不到 AI 到底说了什么。
 *
 * <p>问「你能看到打开的项目吗」，屏幕上找不到任何答案，
 * 只有一个封起来的 JSON 块。这就是「不人性化」的根源：
 * <b>答案被当成过程记录藏起来了</b>。
 *
 * <p>现在：正文永远直接显示（Markdown 风格的换行保留）；
 * 代码块、工具记录、推理、GitHub 参考这些「过程」才折叠。
 * 用户想看细节可以点开，但第一眼就能读到结论。
 */
/**
 * 找出一个 JSON 对象真正的结束位置。
 *
 * <p>用括号配对数，字符串里的括号和转义引号不算。
 * 找不到配对就返回 -1。
 */

function aiMessageBody(m){
  function jsonObjectEnd(s,start){
  if(s[start]!=='{')return -1;
  let depth=0,inStr=false,esc=false;
  for(let i=start;i<s.length;i++){
    const ch=s[i];
    if(inStr){
      if(esc){esc=false;continue;}
      if(ch==='\\'){esc=true;continue;}
      if(ch==='"')inStr=false;
      continue;
    }
    if(ch==='"'){inStr=true;continue;}
    if(ch==='{')depth++;
    else if(ch==='}'){depth--;if(depth===0)return i+1;}
  }
  return -1;
  }
  const raw=typeof m.content==='string'?m.content:JSON.stringify(m.content);
  /*
   * 正文里如果混着模型交回的 files JSON，把它剥掉。
   *
   * <p>降级路径（模型不支持 tools）下，模型被要求返回一个
   * {"summary":"...","files":{...}} 对象，整个对象塞进 content。
   * 用户看到的就是一坨 JSON，而不是那句「summary」里的说明。
   * 真正要写进项目的文件已经在别处处理了，正文只该留给人看的部分。
   *
   * <p><b>但不能只取 summary。</b>模型很常见地先答问题再给 JSON：
   * <pre>
   *   看到了，是个 Vite 项目。我把标题改成了「会议助手」。
   *   {"summary":"改了标题","files":{...}}
   * </pre>
   * 早先的实现只认 summary，把上面那句回答整段丢了 ——
   * 用户看到的是「改了标题」，完全不知道助手先说了什么。
   *
   * <p>所以：<b>JSON 前的人话 + summary 一起保留</b>，JSON 本体丢掉。
   */
  let body=raw;
  let parsed=null;
  let jsonStart=-1;
  /* JSON 在正文里的起点和终点。终点用来保留 JSON 之后的那句人话。 */
  let jsonEnd=-1;
  const fence=body.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if(fence){
    try{parsed=JSON.parse(fence[1]);}catch(e){parsed=null;}
    if(parsed){jsonStart=body.indexOf(fence[1]);jsonEnd=jsonStart+fence[1].length;}
  }else{
    /*
     * 裸 JSON 的情况：靠括号配对找出它真正的结尾。
     *
     * <p>不能直接 JSON.parse(body.slice(from)) —— 那是「从第一个 { 一直到末尾」。
     * 两个后果：
     * <ol>
     *   <li>JSON 后面还有一句人话（「还需要我做别的吗？」）→ 整段解析失败，
     *       JSON 就这么裸露给用户看；</li>
     *   <li>回答里先出现一个左花括号（比如贴了段代码 function f(){）→ from 指错了地方，
     *       同样解析失败。</li>
     * </ol>
     * 所以先按括号配对（字符串里的括号不算）截出完整的那一段，再解析。
     */
    const from=body.indexOf('{');
    if(from>=0){
      const to=jsonObjectEnd(body,from);
      if(to>from){
        try{parsed=JSON.parse(body.slice(from,to));}catch(e){parsed=null;}
        if(parsed){jsonStart=from;jsonEnd=to;}
      }
    }
  }
  /*
   * 只要模型给了一个协议对象（带 files 或带 summary），就把 JSON 剥掉。
   *
   * <p>原来只认 files。可纯问答时模型返回的是 {"summary":"..."}，
   * 没有 files —— 于是 JSON 整段裸露给用户，看到的是
   * {"summary":"这个函数的作用是..."}，而不是那句答案。
   */
  if(parsed&&(parsed.files||typeof parsed.summary==='string')){
    const summary=typeof parsed.summary==='string'?parsed.summary:'';
    /*
     * JSON 前后的人话都要留下。
     *
     * <p>模型经常是「先说答案 → 给 JSON → 再补一句」，
     * 后半句同样是给用户看的，不能跟着 JSON 一起被丢掉。
     */
    let prose=jsonStart>0?body.slice(0,jsonStart).trim():'';
    /*
     * 开头的代码围栏也在 prose 里（jsonStart 指的是 JSON 本身的位置，
     * 围栏的 ```json 在它前面）—— 同样要剥掉，
     * 否则用户看到正文第一行是孤零零的三个反引号。
     */
    prose=prose.replace(/```[A-Za-z0-9]*\s*$/,'').trim();
    let after=jsonEnd>0?body.slice(jsonEnd).trim():'';
    /*
     * 代码围栏的收尾 ``` 也在 after 里，得去掉 ——
     * 否则用户会看到一行孤零零的三个反引号。
     */
    after=after.replace(/^```[A-Za-z0-9]*\s*/,'').replace(/```\s*$/,'').trim();
    if(prose&&summary&&prose.indexOf(summary)<0)prose=prose+'\n';
    const parts=[];
    if(prose)parts.push(prose);
    if(summary)parts.push(summary);
    if(after)parts.push(after);
    if(!parts.length)parts.push(parsed.files?'（本轮已按要求修改项目文件，模型没有给出文字说明）':'（模型没有给出文字说明）');
    body=parts.join('\n');
  }
  return `<div class="ai-text">${esc(body).replace(/\n/g,'<br>')}</div>`;
}
function ai(){if(!chatId&&S.chats.length)chatId=S.chats.filter(x=>(x.projectId||null)===projectId).slice(-1)[0]?.id||null;const c=chat(),p=selectedProfile();if(p)profileId=p.id;const messages=c?c.messages:[];let usageRows=S.usage.filter(r=>r.chatId===chatId),known=usageRows.filter(r=>r.usage.known),sum=usageTotals(usageRows.filter(r=>usageSource(r)==='external_api')).total,stepSum=usageTotals(usageRows.filter(r=>usageSource(r)==='step_api')).total;app.innerHTML=`<div class="page ai-page">${header('YOUR MODELS','AI 编程助手','使用自己的 API，在本机保存对话。')}<details class="ai-setup"${aiSetupOpen?' open':''}><summary>模型与项目设置</summary><div class="row"><select id="profileSelect" class="grow" aria-label="模型配置">${S.profiles.map(x=>`<option value="${esc(x.id)}" ${x.id===profileId?'selected':''}>${esc(x.name)} · ${esc(x.model)}</option>`).join('')||'<option value="">尚未配置模型</option>'}<option value="__new__">＋ 新建模型配置…</option></select><button data-a="settings">API</button><button data-a="localModels">本地模型</button><button data-connect="catalog">连接器</button><button data-a="integrations">联网/GitHub</button><button data-a="memoryPage">记忆</button></div><div class="row" style="margin-top:10px"><button class="grow history-trigger" data-a="chatHistory" aria-haspopup="dialog" aria-controls="chatHistoryDrawer"><span>☰ 对话历史</span><span class="history-current">${esc(c?.name||'新对话')}</span></button><button data-a="newChat">＋</button><button data-a="exportChat">导出</button>${c?'<button class="danger" data-a="deleteChat">删除</button>':''}</div><small>当前对话：第三方 ${num(sum)} / 阶跃 API ${num(stepSum)} / 本地 ${num(usageTotals(usageRows.filter(r=>usageSource(r)==='local_model')).total)} token${usageRows.some(r=>!r.usage.known)?' ＋ 未知用量':''} · 仅统计本工作台</small>${p?`<div class="status">${p.protocol==='local'?'端侧离线 · '+esc(p.name):'发送至 '+esc(p.endpoint)+(p.hasKey?'':' · 尚未保存密钥')}</div>`:'<div class="noticebar">先添加模型配置。支持 Chat Completions 兼容接口和 Anthropic Messages。</div>'}${aiProjectCard()}${liveEditCard()}</details><div id="messages">${messages.map((m,i)=>`<div class="message ${m.role}"><small>${m.role==='user'?'你':'AI'}</small><div>${(m.images||[]).map(u=>`<img class="msg-img" src="${u}" alt="用户附上的图片" loading="lazy">`).join('')}${!m.images&&m.imageCount?`<small class="muted">（这条消息原本附了 ${m.imageCount} 张图，图片不会存进对话记录，重开对话后不再显示）</small>`:''}${aiMessageBody(m)}</div>${m.edit?`<div class="noticebar">${esc(m.edit.message)}${m.edit.partialNote?`<span class="muted">${esc(m.edit.partialNote)}</span>`:''}${m.edit.status==='review'?`<button data-a="reviewAiFiles" data-id="${i}">审查并应用</button>`:''}</div>`:''}${m.research?`<details><summary>GitHub 参考 · ${m.research.status==='failed'?'检索未成功':m.research.references.length+' 个候选'}</summary><pre>${esc(JSON.stringify(m.research,null,2))}</pre></details>`:''}${m.benchmark?.decodeTokensPerSecond?`<small>本机生成 ${Number(m.benchmark.decodeTokensPerSecond).toFixed(1)} Token/s · 首字 ${Number(m.benchmark.firstTokenSeconds).toFixed(1)} 秒</small>`:''}${m.toolCalls?.length?`<details><summary>开发工具记录（${m.toolCalls.length}）</summary><pre>${esc(JSON.stringify(m.toolCalls,null,2))}</pre></details>`:''}${m.reasoning?`<details><summary>推理内容</summary><pre>${esc(m.reasoning)}</pre></details>`:''}${m.usage?`<small>${m.usage.known?`输入 ${num(m.usage.input)} · 输出 ${num(m.usage.output)} · 合计 ${num(m.usage.total)}`:'接口未返回用量'}</small>`:''}<div class="row"><button data-a="copyMessage" data-id="${i}">复制</button>${m.role==='assistant'&&/```(?:html)?\s*\n([\s\S]*?)```/i.test(m.content)?`<button data-a="applyHtml" data-id="${i}">HTML 新建项目</button>`:''}</div></div>`).join('')||'<div class="empty">描述你想做的应用，或在编辑器里<br>点“问 AI”，附上当前文件。</div>'}</div>${busy?'<div class="noticebar">模型正在处理，请保持应用打开。<br>取消后服务端仍可能计费。<button data-a="cancel">取消请求</button></div>':''}<div class="composer">${pendingImages.length?`<div class="attachments">${pendingImages.map((u,i)=>`<span class="attachment"><img src="${u}" alt="待发送的第 ${i+1} 张图片"><button data-a="dropImage" data-i="${i}" aria-label="移除这张图片">×</button></span>`).join('')}</div>`:''}<textarea id="prompt" aria-label="发送给 AI 的内容" placeholder="例如：做一个适合手机使用的录音任务清单"></textarea>${false?`<label><input type="checkbox" id="includeCode" ${includeCode?'checked':''}>附加当前文件：${esc(file)}（${num(currentContent(project(),file).length)} 字符）</label>`:''}<div class="row spread"><small>多轮上下文随请求发送</small><button data-a="pickImage" aria-label="添加图片" title="从相册选一张图，让 AI 看">📷</button><button class="primary" data-a="send" ${busy||!p?'disabled':''}>${project()&&aiEditMode==='auto'?'修改此项目 ↑':'发送 ↑'}</button></div></div></div>`;$('#aiProject').onchange=e=>{projectId=e.target.value||null;chatId=null;render()};if($('#aiEditMode')){$('#aiEditMode').value=aiEditMode;$('#aiEditMode').onchange=e=>{aiEditMode=e.target.value;render()}};if($('#githubResearch'))$('#githubResearch').onchange=e=>githubResearch=e.target.checked;$('#prompt').value=draft;$('#prompt').oninput=e=>{draft=e.target.value;send('draft',{text:draft})};$('#profileSelect').onchange=e=>{if(e.target.value==='__new__'){editProfile=null;detectedModels=[];page='settings';render();return;}profileId=e.target.value;render()};if($('#includeCode'))$('#includeCode').onchange=e=>includeCode=e.target.checked;
  // 折叠区状态：展开时记住，下次渲染还开着
  const setup=document.querySelector('.ai-setup');
  if(setup)setup.addEventListener('toggle',()=>{aiSetupOpen=setup.open;});}
function newChat(){if(busy){notice('请等待当前请求结束');return}const c={id:uuid(),name:'新对话',projectId:projectId||'',messages:[],created:Date.now()};S.chats.push(c);chatId=c.id;saveChat();render()}
function sendMessage(){
  if(busy)return;
  /*
   * 先把待写的编辑落盘。
   *
   * <p>保存现在是防抖的（见 saveSoon）：用户敲完最后一句、立刻点发送，
   * 那一刻磁盘上可能还是几秒前的内容。不 flush 的话模型读到的是旧代码，
   * 用户却以为它看的是屏幕上这一版 —— 改出来的东西自然对不上。
   */
  flushNow();
  const p=selectedProfile();if(!p||(!p.hasKey&&p.protocol!=='local')){notice('请先保存模型配置和 API Key');return}/*
 * 只发一张图、不打字，是合理用法 —— 用户就是想问「这截图里的报错怎么回事」。
 * 所以「没有文字」不能直接拦掉，得看有没有待发的图片。
 */
if(!draft.trim()&&!pendingImages.length)return;
const text=draft.trim();
/*
 * 有图片时不能只发纯文本了：把这条消息组装成
 *   [{type:'text',text}, {type:'image_url',image_url:{url}}, ...]
 * 这是 OpenAI 兼容接口的多模态格式，MiniMax / 通义 / GLM 的视觉模型都认。
 * 没有图片就还是纯字符串 —— 老模型不认识数组格式，别给它添麻烦。
 */
/* 不再按字符数拦：真正的限制是模型上下文窗口，由服务端判断。
   在本地猜一个数，只会让用户莫名其妙被拦。 */
/*
 * 用户当前正在看的文件和光标位置。
 *
 * <p>为什么必须带上：用户会说「这个按钮怎么改」「这里为什么报错」，
 * 但「这个」「这里」指的是屏幕上的哪一个文件，光看对话历史是猜不出来的。
 * 少了这条，模型只能反问「你说的是哪个文件」，来回两轮才问得清。
 *
 * <p>AI 页面和编辑器页面是同一个页面里的两个视图，用户随时能切。
 * 所以发消息的那一刻现场取一次：编辑器的 textarea 还在 DOM 里就取光标，
 * 取不到就只报文件名、不报行号 —— 半个信息也比没有强。
 */
let activeFile='',activeLine=0;
try{
  /*
   * 「当前文件」和「光标行」要分开判断。
   *
   * <p><b>原来的写法把两件事绑在一起：</b>只在 page==='editor' 时
   * 才把 file 报上去。可 AI 助手的主战场恰恰是<b>AI 页面</b> ——
   * 用户从编辑器点进 AI 页问「这个按钮怎么改」，page 已经是 'ai'，
   * 文件名当场就丢了，模型又只能反问「你说的是哪个文件」。
   *
   * <p>所以：文件跟着 file 走（它记住的是用户最后打开的那个文件，
   * 切页面不影响），只有光标行要求编辑器真在屏幕上 ——
   * textarea 不在 DOM 里的时候，光标位置没有意义。
   */
  const p0=project();
  if(typeof file==='string'&&file&&p0&&p0.files&&Object.prototype.hasOwnProperty.call(p0.files,file)){
    activeFile=file;
    if(page==='editor'){
      const ta=document.getElementById('code');
      if(ta&&typeof ta.selectionStart==='number'){
        /* selectionStart 是字符偏移，换成行号：从开头数到光标位置有几个换行 +1 */
        activeLine=ta.value.slice(0,ta.selectionStart).split('\n').length;
      }
    }
  }
}catch(e){}
const createProject=Neo.wantsNewProject(text);if(createProject){projectId=null;chatId=null;newChat();}else if(!chat()||(chat().projectId||null)!==projectId)newChat();const c=chat(),target=project();if(!c.messages.length)c.name=(text||'图片对话').slice(0,24);c.messages.push(pendingImages.length?{role:'user',content:text,images:pendingImages.slice()}:{role:'user',content:text});pendingImages=[];saveChat(c);draft='';send('draft',{text:''});busy=true;send('send',{createProject,profileId:p.id,chatId:c.id,projectId:target?.id||'',projectContext:!!target,githubResearch,editMode:target&&aiEditMode!=='discuss'?aiEditMode:'',activeFile,activeLine,messages:c.messages.map(m=>{
  if(!m.images||!m.images.length)return {role:m.role,content:m.content};
  const parts=[];
  if(m.content)parts.push({type:'text',text:m.content});
  for(const u of m.images)parts.push({type:'image_url',image_url:{url:u}});
  return {role:m.role,content:parts};
}),system:p.system||'你是一位中文编程助手。不要假装已经运行程序。'});render()}

/*
 * 从剪贴板批量导入模型配置。
 *
 * 用途：手工在四个输入框里填地址、模型名、密钥很慢，尤其是密钥很长。
 *      复制一段 JSON 过来，一次导入多套配置。
 *
 * 接受的格式（每项一个对象）：
 *   {
 *     "name": "MiniMax",                          ← 配置名称
 *     "endpoint": "https://api.minimax.cn/v1",     ← 接口地址
 *     "model": "MiniMax-M3.1-Flash",              ← 模型 ID
 *     "key": "sk-xxx",                            ← API Key
 *     "protocol": "compatible"                    ← 可选，默认 compatible
 *   }
 *
 * 安全性：只接受 https 开头的地址；协议只允许 compatible / anthropic 两种。
 *          密钥走原生加密存储，和手工填写一样，不会留在页面里。
 */
async function importProfilesFromClipboard(){
  let text='';
  try{text=await navigator.clipboard.readText();}catch(e){}
  // 剪贴板里如果是 base64（以 eyJ 开头），先解码
  if(text&&text.trim().startsWith('eyJ')){
   try{text=decodeURIComponent(escape(atob(text.trim())));}catch(e){}
  }
  if(!text){
    // WebView 里剪贴板权限可能被拒，退回到让用户粘贴到输入框
    const t=prompt('把配置 JSON 粘贴到这里（每项含 name / endpoint / model / key）');
    if(!t)return; text=t;
  }
  let list;
  try{
    list=JSON.parse(text);
    if(!Array.isArray(list))list=[list];
  }catch(e){notice('JSON 格式不对：'+e.message);return;}
  if(!list.length){notice('没有可导入的配置');return;}

  const ok=[],bad=[];
  for(const p of list){
    const name=String(p.name||'').trim();
    const endpoint=String(p.endpoint||'').trim();
    const model=String(p.model||'').trim();
    const key=String(p.key||'').trim();
    const protocol=(p.protocol||'compatible')==='anthropic'?'anthropic':'compatible';
    if(!name||!endpoint||!model||!key){bad.push(name||'(未命名)'+'：缺字段');continue;}
    if(!/^https:\/\//i.test(endpoint)){bad.push(name+'：地址必须 https 开头');continue;}
    const id='imp-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    send('profile',{id,name,endpoint,model,key,protocol,maxTokens:4096,streaming:true,system:'',thinking:'default',next:''});
    ok.push(name);
  }
  notice('已导入 '+ok.length+' 套配置'+(bad.length?'，'+bad.length+' 套失败：'+bad.join('、'):''));
}

const presets=[['自定义兼容接口','https://','compatible',''],['DeepSeek','https://api.deepseek.com','compatible','deepseek-flash'],['阶跃星辰','https://api.stepfun.com/v1','compatible',''],['通义千问（兼容模式）','https://dashscope.aliyuncs.com/compatible-mode/v1','compatible','qwen-plus'],['Anthropic','https://api.anthropic.com/v1','anthropic','']];
function settings(){app.innerHTML=`<div class="page"><button data-art="settings">绘图 API 与美术资源</button>${header('CONNECT','模型与 API','密钥加密保存在手机，不提供给 Studio 网页或项目导出。')}<div class="row">${S.profiles.filter(p=>p.protocol!=='local').map(p=>`<button data-a="editProfile" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}<button data-a="freshProfile">＋ 新配置</button><button data-a="importProfiles">粘贴导入配置</button></div><div class="card"><label for="preset">快速填写服务商</label><select id="preset">${presets.map((x,i)=>`<option value="${i}">${x[0]}</option>`).join('')}</select><label for="pname">配置名称</label><input id="pname" maxlength="60" placeholder="我的模型"><label for="endpoint">Base URL 或完整请求地址</label><input id="endpoint" type="url" placeholder="https://api.example.com/v1" autocapitalize="off"><label for="protocol">接口协议</label><select id="protocol"><option value="compatible">Chat Completions 兼容协议</option><option value="anthropic">Anthropic Messages</option></select><button id="detectButton" data-a="detectModels" style="margin-top:12px">保存并检测模型</button><div id="modelPicker">${detectedModels.length?`<label for="modelSearch">搜索检出的模型（${detectedModels.length}）</label><input id="modelSearch" placeholder="输入关键词"><select id="detectedModel" aria-label="检测到的模型"><option value="">选择模型…</option>${detectedModels.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('')}</select>`:''}</div><label for="model">模型 ID（以服务商账户为准）</label><input id="model" autocapitalize="off" placeholder="填写模型标识"><label for="key">API Key</label><input id="key" type="password" autocomplete="off" placeholder="新密钥；编辑时留空保留"><p id="keyhint" class="keyhint"></p><p id="contextLimit" class="muted"></p><label for="maxTokens">单次最大输出 token</label><input id="maxTokens" type="number" value="4096" min="64" max="32768"><label class="setting-switch"><input id="streaming" type="checkbox" checked>实时显示生成内容（接口需支持流式响应）</label><label for="thinking">推理模式（DeepSeek 等支持该参数的兼容接口）</label><select id="thinking"><option value="">服务商默认</option><option value="disabled">关闭推理，直接输出</option><option value="enabled">开启推理</option></select><label for="system">系统提示词</label><textarea id="system" rows="3" placeholder="你是一位中文编程助手…"></textarea><div class="row" style="margin-top:16px"><button class="primary" data-a="saveProfile">保存配置</button><button data-a="testProfile">保存并测试</button>${editProfile?'<button class="danger" data-a="deleteProfile">删除配置</button>':''}</div></div><div class="noticebar">使用 API 会按服务商规则计费。“测试”也会发起一次短请求。这里配置的模型只用于本地 AI 助手，不会替换官方 Studio 的后端模型。支持项目开发工具与官方连接器说明查询；暂不支持 Responses 协议。生成图片请在独立的“绘图 API”中配置。</div><button data-a="ai">返回 AI 助手</button></div>`;const p=S.profiles.find(x=>x.id===editProfile);if(p){for(const k of ['name','endpoint','protocol','model','maxTokens','thinking','system'])$(k==='name'?'#pname':'#'+k).value=p[k]??'';$('#keyhint').textContent=p.hasKey?'已保存密钥，留空即可保留':'尚未保存密钥'}$('#streaming').checked=p?.streaming!==false;$('#endpoint').addEventListener('input',refreshModelLimits);$('#model').addEventListener('input',refreshModelLimits);refreshModelLimits();if($('#detectedModel'))$('#detectedModel').onchange=e=>{if(e.target.value){$('#model').value=e.target.value;refreshModelLimits()}};if($('#modelSearch'))$('#modelSearch').oninput=e=>{const q=e.target.value.toLowerCase();$('#detectedModel').innerHTML='<option value="">选择模型…</option>'+detectedModels.filter(m=>m.toLowerCase().includes(q)).map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('')};$('#preset').onchange=e=>{const x=presets[e.target.value];$('#pname').value=x[0];$('#endpoint').value=x[1];$('#protocol').value=x[2];$('#model').value=x[3];refreshModelLimits();$('#key').value='';if(editProfile){editProfile=null;$('#keyhint').textContent='将保存为新配置，不沿用原服务商密钥'}};}
function saveProfile(next=''){const p={id:editProfile||uuid(),name:$('#pname').value.trim(),endpoint:$('#endpoint').value.trim(),protocol:$('#protocol').value,model:$('#model').value.trim(),key:$('#key').value.trim(),maxTokens:Number($('#maxTokens').value),system:$('#system').value,streaming:$('#streaming').checked,thinking:$('#thinking').value,next};if(!p.name||!p.endpoint||(!p.model&&next!=='detect')){notice('请填写名称、接口地址和模型 ID；也可先检测模型');return false}if(!Number.isInteger(p.maxTokens)||p.maxTokens<64||p.maxTokens>modelLimits(p).output){notice('最大输出应在 64–'+modelLimits(p).output+' 之间');return false}send('profile',p);return true;}

function help(){app.innerHTML=`<div class="page"><p class="muted">StepX Studio · scsxrkj.com.cn</p><div class="card"><h2>版本更新</h2><p>可选功能：自动检查 GitHub 上的新版本并下载安装。更新仓库是公开的，无需令牌。不联网时可以直接安装新版 APK 覆盖升级。</p><button data-a="checkUpdates">检查更新</button></div><div class="card"><h2>AI 开关与云端项目</h2><p>在本地项目页“功能与显示设置”或右上角更多菜单开关 AI 助手，关闭后底部入口隐藏，配置和对话保留。</p><p>“同步云端项目”选择 Studio 项目下载源码；编辑器“同步到本地”更新已关联项目，“上传项目”将本地文件写回云端。首次上传新建云端项目，之后继续同一项目。两边同时修改同一文件时停止覆盖。</p><p>保留子目录和二进制资源，排除依赖、构建产物、凭据和签名材料；上限 3000 个文件、单文件 100 MB、合计 200 MB。大文件（语音识别模型之类）走独立的落盘通道，网页里分块读取、一块一块交给手机写盘，不经过 JSON 文本管道，所以不会把内存撑爆；云端若把大文件切成 .part0/.part1 分片，本地会按序号数字顺序拼回原文件。上传不删除云端其他文件；中断显示部分完成。支持内置依赖范围内的前端源码本机编译与运行；其他依赖及任意 npm 脚本需外部环境。</p></div><div class="card"><h2>大文件怎么传</h2><p>语音识别模型这类文件动辄 80 MB 以上。常规做法是把文件内容编码进 JSON 再传回手机，手机内存会被瞬间撑爆，App 直接闪退。</p><p>所以大文件走另一条路：网页用流式接口一块一块读，读到一块就交给手机写盘，网页里同时最多只有 1 MB。手机这边直接写到应用私有目录，不经过 Java 堆。项目清单里对大文件只记一个引用名，实际内容单独存放，项目清单因此始终很小。</p><p>云端如果把大文件切成了 .part0 / .part1 分片，本地会按序号数字顺序拼回原文件（不是字符串字典序，否则 part10 会排到 part2 前面）。</p><p>想自己验证：右上角菜单「云端大文件通道自检」，可选 20 / 50 / 83 / 100 MB，在设备上造一个假文件走完整流程并校验哈希，不上传任何数据到云端。</p></div><div class="card"><h2>官方 Studio</h2><p>底部 Studio 打开官方网页，登录后使用应用、智能体和技能构建。右上角菜单提供刷新、前进、桌面模式、缩放、查找、下载列表和专注模式。</p><p>网站功能、模型和云端构建由官方提供。本客户端无法替换其服务端模型。Token 页可检查当前项目的官方历史返回字段；字段缺失时会显示原因，不用 0 冒充用量。</p></div><div class="card"><h2>本地项目</h2><p>新建后直接编辑 HTML / CSS / JS。草稿保存在应用私有目录；运行可检查界面和 JavaScript 错误；导出 ZIP 后可继续在 Mac 上开发。</p><p>预览会编译支持的前端源码，默认断网；可手动开启 HTTPS 网络，文件与设备权限不开放。导入支持最多 40 个根目录文本文件、总大小 2 MB，须含 index.html；支持通过预编译运行壳离线封装 APK，不包含 npm 或任意 Kotlin/Gradle 工程编译器。</p><p>应用卸载会删除本地资料，请定期导出项目和对话。项目支持长按菜单、左滑删除；确认后移到最近删除，可恢复或另行彻底删除。云端项目、已导出文件、已安装App及Token账本保留。</p></div><div class="card"><h2>构建与调试</h2><p>编辑器中选择本机离线或 Step 云端路径。生成 APK 后须按系统提示安装；运行 App 的菜单可开启调试、查看和回传报告。每次调用已有 AI 配置都会原生确认。卸载 StepX Studio 会丢失本机签名密钥，无法直接更新此前生成的 App。</p></div><div class="card"><h2>官方构建 vs 本地构建</h2><p><b>官方 Studio 打的包是预览版</b>：运行时从 studio-api.stepx.com 拉内容。手机断网会显示「AI App 加载失败 / ERR_CONNECTION_ABORTED」，官方服务器故障会显示「503 Service Temporarily Unavailable」。包名以 <code>com.stepx.aiapp.</code> 开头。</p><p><b>本工作台打的包把页面全部装进 APK</b>：通过虚拟域名 app.neo.local 直接从安装包读文件，全程不联网。断网照常运行。包名以 <code>com.scsxrkj.app.</code> 开头，或构建时你填的自定义包名。</p><p>同样断网实测：官方包 4.9~5.8 MB，只剩错误页和「重试」按钮；本地包 73 KB，页面和按钮全部正常。</p><p>要做出能离线用的 App：在官方 Studio 把项目做出来，用「同步云端项目 ↓」拉到本地，再用本机离线构建出包。<b>不要用官方那边的「导出 APK / 安装到手机」</b>，那是预览版。</p></div><div class="card"><h2>项目协作</h2><p>编辑器的“项目协作”可管理共享目标、任务、Step 上下文和外部 AI 结果。先关联具体 Studio 项目，再交接草稿或导入页面文字。代码 ZIP 与 AI 文件建议都需逐文件审查；应用前保存快照。</p><p>共享上下文可预览和导出。切换不同 API 模型可按规划、实现、审查顺序接力；自动联动可在前台完成模型规划 → Studio 开发 → 模型审查，最多 1–3 轮；已有草稿、切换项目、离开应用或异常会停止。云端与本地通过明确交接同步，没有自动双向文件锁或后台合并。</p></div><div class="card"><h2>Amoo 与显示</h2><p>项目协作中的“交给 Amoo”会先预览任务，再打开 Amoo 分享入口；请在 Amoo 核对并发送。执行结果经人工核对后填回项目，尚无后台自动执行或自动回调。</p><p>本地项目页底部可选择标准玻璃、降低透明度或增强对比度。本地界面采用阶跃 AI 的炭黑、灰色与橙色方向，并参考 Apple Liquid Glass 的层级与材质原则，未使用 Apple UI 框架或图形资源。</p></div><div class="card"><h2>AI 与 Token</h2><p>设置 HTTPS 接口、模型 ID 和密钥，可保存多个配置。在 AI 助手选择本地项目，可直接修改、先审查或只讨论。每轮从本机读取全部最新文件；自动保存前验证目标和修改基线，只保留上一版快照（可回退一步）。失败、截断和文件冲突不会写入。</p><p>发送过程中保持应用打开。输出上限默认 4096。官方 DeepSeek 支持 1,048,576 Token 上下文、最高 393,216 Token 输出；其他接口最高可设 32768，以对应模型能力为准。上下文包括输入与输出预留。API 错误会显示 HTTP 状态，不自动重试或转发密钥。</p><p>用量来自服务商返回字段：兼容接口输入与输出相加；Anthropic 输入包含缓存读取与缓存写入。账本自动汇总已记录的全部项目；Step API、Studio 和第三方 API 分开计算。Studio 取各项目最新已读取报告，没有报告或 usage 时标为未知。</p></div><button data-a="projects">返回项目</button><div class="card"><h2>来源与许可</h2><p>本工具基于公开的 STEPX Neo 社区实践整理改进。设备端签名使用 apksig-android 4.4.0（Apache 2.0），端侧模型运行时使用 Google LiteRT-LM 0.18.0（Apache 2.0），内置前端依赖各自遵循其原许可。完整许可全文随安装包分发。</p><button data-a="license">查看第三方许可</button></div><div class="card"><h2>按钮说明提示</h2><p>第一次点某个功能按钮时，会先弹一段说明讲清楚它做什么。如果之前勾了「不再提示」，可以在这里恢复。</p><button data-a="resetExplains">重置所有按钮说明</button><p id="explainResetResult" class="muted"></p></div></div>`}

/* ============================================================
 * 按钮首次点击说明
 * ============================================================
 *
 * 目的：第一次点某个功能按钮时，先弹一段大白话说明「这个按钮到底做什么」，
 *       看完点「继续」才真的执行。勾「不再提示」后永久跳过。
 *
 * 工作方式：
 *   1. EXPLAIN 里存每个动作的标题和说明文字
 *   2. explainGuard() 在动作执行前检查三件事：
 *        · 这个动作有说明吗？        没有 → 直接放行
 *        · 用户勾过「不再提示」吗？   勾过 → 直接放行
 *        · 是不是刚点过「继续」重来的？ 是   → 直接放行
 *      三条都不满足才弹框
 *   3. 用户点「继续」时，先给按钮打个标记，再重新 click() 一次
 *
 * 为什么用「重新 click」而不是直接执行动作：
 *   原来的点击分发是个同步函数，硬改成 async 牵一发动全身。
 *   打标记再触发一次点击，等于让它原路重走一遍，行为完全一致，零副作用。
 *
 * 哪些按钮会弹：涉及数据操作、外部交互、不可逆操作、功能不直观的。
 * 哪些不弹：切页面、返回、撤销重做、复制这种一看就懂的，弹了只会烦人。
 * ============================================================ */
/*
 * 说明系统的版本号。
 *
 * 改动这个数字，会让所有「不再提示」的记录失效，下次点击重新弹说明。
 * 用途：说明内容大改、或者用户要求「全部恢复提示」时，改这里即可。
 *
 * 工作方式：进页面时先比对 localStorage 里存的版本，
 * 不一致就把所有 explainSeen:* 清掉，然后写入新版本号。
 */
const EXPLAIN_VERSION='2';
try{
  if(localStorage.getItem('explainVer')!==EXPLAIN_VERSION){
    const stale=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.indexOf('explainSeen:')===0)stale.push(k);
    }
    stale.forEach(k=>localStorage.removeItem(k));
    localStorage.setItem('explainVer',EXPLAIN_VERSION);
  }
}catch(e){}

const EXPLAIN={
  changesPage:['变更视图',
    '看这一次到底改了哪些文件。\n\n'+
    '数据来自项目里的「存档」：云端同步、AI 改代码、你点「📷 存档」的时候，'+
    '系统会把当时全部文本文件复制一份存起来。变更视图就是拿当前文件跟最近一份存档比。\n\n'+
    '四种标记：\n'+
    '· + 绿  这次新增的文件\n'+
    '· ~ 橙  内容改过的文件，点进去能看具体哪几行变了\n'+
    '· − 红  这次被删掉的文件\n'+
    '· ◈ 蓝  新加的二进制文件（图片、模型这些）\n\n'+
    '注意：存档会把文件内容复制进项目数据，文件多的项目存次数多了应用会变慢。'+
    '所以只在需要对比的时候点「📷 存档」，不做自动定时存档。'],
  overviewPage:['项目总览',
    '一个地方看清这个项目的全貌：\n\n'+
    '· 有多少文本文件、多少二进制文件、各占多少体积\n'+
    '· 有几个存档，最近一次改了什么\n'+
    '· 一键跳到变更视图、文件浏览器、大文件管理、全局替换\n\n'+
    '文件突然变多、应用变慢的时候，先来这里看看体积花在哪儿了。'],
  bigfilesPage:['大文件管理',
    '列出项目里所有二进制文件，按体积从大到小排。\n\n'+
    '为什么单独做一页：编辑器只列文本文件，图片和模型在那边根本看不见。'+
    '同步进来的语音识别模型一个就 4 MB，二十张图又是几 MB，'+
    '想清理的时候没人知道空间花在哪儿。\n\n'+
    '标了「占用存储」的是真正存在手机里的文件，删掉能腾出空间；'+
    '没标的直接内嵌在项目数据里，删掉只是从项目移除。'],
  replacePage:['全局替换',
    '在所有文本文件里一次替换同一个词。\n\n'+
    '用法：填「要查找的内容」和「替换成」，下面会先列出哪些文件命中、各多少处。'+
    '确认没问题再点「全部替换」。\n\n'+
    '· 换行时自动存一份存档 —— 批量改容易改错，改完能在变更视图里看改了什么\n'+
    '· 「替换成」留空表示把这些内容删掉\n'+
    '· 不勾「区分大小写」时，Payment 和 payment 都会被换掉\n\n'+
    '只作用于文本文件，二进制文件不会被碰。'],
  gotoLine:['跳到指定行',
    '输入行号，直接跳到代码的那一行。\n\n'+
    '手机上长文件翻起来很费劲，知道「大概在八百多行」的时候，'+
    '不用一直往上滑 —— 填行号就过去了。\n\n'+
    '跳过去之后那一行会被选中，方便直接改。'],
  fmSelectOn:['多选文件',
    '进入多选模式，一次处理多个文件。\n\n'+
    '点每一行前面的圈勾选（也可以点整行），底部会出现操作栏：\n'+
    '· 全选 —— 把当前列表里看得见的都勾上（搜索过滤后就只勾搜到的）\n'+
    '· 移动 —— 把这些文件挪到另一个目录，目录会自动建\n'+
    '· 删除 —— 一次删掉，删之前会确认\n\n'+
    '移动时文件保持原来的相对位置：选中 src/a.js 和 src/b.js 移到 lib，'+
    '结果是 lib/a.js 和 lib/b.js。'],
  makeSnapshot:['存一份存档',
    '把当前所有文本文件复制一份存进项目，作为以后对比的基准。\n\n'+
    '什么时候用：你打算动手改一批文件，改之前点一下。'+
    '改完再进变更视图，就能清楚看到自己动了哪些文件、哪些行。\n\n'+
    '云端同步和 AI 改代码会自动存档，手动改文件不会 —— 所以需要自己点。\n\n'+
    '代价：存档是把内容真的复制一份。258 个文件的项目存一次就是 2.9 MB，'+
    '存太多会让应用变慢。系统最多保留最近 5 份，旧的会自动丢。'],
  snapshotNow:['存一份存档',
    '把当前文件复制一份存起来，作为变更对比的基准。最多保留最近 5 份。'],
  compare:['看这个文件改了什么',
    '把这个文件和它在存档里的旧版本逐行比。\n\n'+
    '绿色是新增的行，红色是删掉的行，左边数字是行号。\n'+
    '默认只看有改动的部分，中间没变的会折叠成「⋯ N 行未变」；'+
    '点「全部行」可以铺开看完整的。'],
  bigDelete:['删除这个大文件',
    '把这个二进制文件从项目里删掉，内容同时从手机存储里清掉。\n\n'+
    '删之前会确认。删了之后如果还想用，得重新从云端同步或导入。'],
  fmDelete:['批量删除',
    '把选中的文件一次删掉。删之前会弹确认，告诉你一共删几个。\n\n'+
    '大文件会同时从手机存储里清掉，真正腾出空间。'],
  fmMove:['批量移动',
    '把选中的文件挪到另一个目录。\n\n'+
    '填目标目录名，比如 lib 或 src/utils。目录不存在会自动创建，'+
    '不用先手动建。\n\n'+
    '文件保持原来的相对位置，多个文件挪过去不会乱。'],
  filesPage:['浏览全部文件',
    '打开文件浏览器，把项目里所有文件列出来。\n\n'+
    '为什么需要它：项目从云端同步或从 ZIP 导入进来常有几百个文件，编辑器里那排横向按钮要一直往右滑才能翻完。\n\n'+
    '文件浏览器里：\n'+
    '· 按目录分组，点目录名可以收起/展开\n'+
    '· 顶部搜索框能搜文件名，也能输入一段文字在全部文件内容里找\n'+
    '· 每行显示文件大小；大文件、二进制文件会单独标出来\n'+
    '· 右边的「⋯」可以重命名、复制一份、删除、复制内容到剪贴板\n\n'+
    '注意：编辑器里只能改文本文件；二进制和大文件（图片、模型）在浏览器里能看到，但点开会提示不能编辑。'],
  fileMenu:['文件操作',
    '对这一个文件做管理操作：\n\n'+
    '· 打开编辑 —— 回到编辑器改内容（只有文本文件有这个）\n'+
    '· 重命名 —— 可以连目录一起改，比如把 utils.js 改成 lib/utils.js，目录会自动建\n'+
    '· 复制一份 —— 内容复制成另一个文件，改坏了好回退\n'+
    '· 复制内容到剪贴板 —— 把整个文件内容拷走，粘到别处\n'+
    '· 用剪贴板内容覆盖 —— 拿剪贴板里的文字替换掉这个文件\n'+
    '· 删除 —— 删掉这个文件，大文件会连手机里的那份一起清掉'],
  codeFocus:['全屏代码',
    '把代码框铺满整屏，暂时藏起上下的按钮和文件栏。\n\n'+
    '手机上改代码时上面挤了太多东西，实际能看到的代码只有几行。全屏后能一次看几十行。\n\n'+
    '全屏时工具栏只留几个真正常用的：退出全屏、撤销、重做、查找、复制。\n'+
    '再点一次就退出全屏，所有按钮回来。'],
  fontPlus:['放大代码字号',
    '把代码里的字调大一档，最大 24 号。\n\n'+
    '字号记在本机，下次打开还是这个大小。\n'+
    '旁边的 A− 是缩小。'],
  fontMinus:['缩小代码字号',
    '把代码里的字调小一档，最小 9 号。\n\n'+
    '字号记在本机，下次打开还是这个大小。\n'+
    '旁边的 A+ 是放大。'],
  backEditor:['返回编辑器',
    '从文件浏览器回到代码编辑界面。\n\n'+
    '刚才在浏览器里点开过的那个文件会保持选中。'],
  importProject:['导入 HTML / ZIP',
    '把外面做好的网页项目搬进本应用。\n\n'+
    '· 选 .zip 压缩包\n  解出完整的项目结构，可以含子目录、图片、模型文件，当成一个多文件项目\n\n'+
    '· 选单个 .html 文件\n  只有一个页面，当成单页项目\n\n'+
    '两种情况都必须含 index.html，否则拒绝导入，因为生成的 App 一启动就是找它来显示的。\n\n'+
    '上限：3000 个文件、单个文件 100 MB、解压后合计 200 MB。\n'+
    '大文件（语音识别模型之类）边读边写盘，不占内存；文本存原文可以直接编辑，二进制单独存不会损坏。\n'+
    'node_modules、dist、build 这些依赖和构建产物会自动跳过。\n'+
    '导入成功后出现在「本地项目」列表里。'],
  exportProject:['导出项目',
    '把当前项目的全部文件打成一个 ZIP 压缩包，保存到手机里。\n\n'+
    '用途：备份、换手机迁移、或者拿到电脑上继续改。\n'+
    '导出的是纯源码，不含构建出来的 APK。'],
  preview:['预览',
    '在手机上直接跑一遍当前项目，看实际效果。\n\n'+
    '预览环境是隔离的：不联网、读不到手机文件、也拿不到本应用的任何权限。\n'+
    '页面的 JS 报错会显示在屏幕下方，方便排查为什么白屏。'],
  localRun:['本地运行',
    '先编译再运行，和「预览」的区别是这里会走完整的编译流程（支持 React / TSX）。\n\n'+
    '编译失败会报出具体错误行，不会静默生成一个坏页面。'],
  buildOffline:['本机离线构建',
    '把这台手机当成打包机，直接把项目编译成能安装的 APK。\n\n'+
    '点下去会弹选项让你填：\n'+
    '· 自定义包名（留空自动生成）\n'+
    '· 是否用最小权限模板（只声明联网权限，适合提交应用市场）\n\n'+
    '整个过程不需要电脑、不需要联网，用内置密钥签名。'],
  buildInstall:['构建并安装到 Neo',
    '先构建 APK，成功后立刻拉起系统安装器装到这台手机上。\n\n'+
    '一步到位，适合边改边看效果。构建记录会留在项目里。'],
  exportApk:['导出 APK',
    '把已经构建好的 APK 文件保存到手机存储。\n\n'+
    '用于：发给别人安装、上传到应用市场、留档。\n'+
    '导出的是正式签名的包，可以直接安装。'],
  installApk:['安装',
    '安装某一条历史构建产物。\n\n'+
    '会先核对 APK 里的包名和构建记录是否一致，防止装错文件。\n'+
    '同一个包名 + 同一份签名才能覆盖升级，否则系统会拒绝。'],
  importDebug:['导入调试报告',
    '把生成的 App 回传回来的调试报告（JSON 文件）导进项目。\n\n'+
    '报告里有版本、自检结果和错误日志，导入后可以交给 AI 分析为什么出错。\n'+
    '导入前会自动清掉敏感字段。'],
  ai:['发送 AI 请求',
    '把对话发给你配置的模型服务，让 AI 回答或改代码。\n\n'+
    '会产生 Token 费用（本地模型除外），每次用量都记进「Token 账本」。\n'+
    '可以在发送后随时点取消。'],
  aiCode:['AI 生成代码',
    '让 AI 直接给出可用的代码，并尝试写进项目文件。\n\n'+
    '写入分两种模式：\n'+
    '· 直接写入 —— AI 给的改动立刻生效\n'+
    '· 先审查 —— 只生成建议，等你在「文件修改审查」里确认后才写'],
  startAuto:['开始自动联动',
    '让 AI 自动连续执行多步任务，不用你一步步点。\n\n'+
    '原理是在官方 Studio 网页的输入框里反复填写、发送、等待、读取结果。\n'+
    '有总时长上限，跑到时间会自动停；应用退到后台也会停。随时可以手动停止。'],
  reviewAiFiles:['审查 AI 改动的文件',
    'AI 改了哪些文件、每个文件改了什么，在这里逐条看，决定接受还是丢弃。\n\n'+
    '接受之后才真正写进项目。不放心 AI 乱改的话，用这个模式最安全。'],
  reviewReply:['审查这次回复',
    '看 AI 这一次回复都动了什么，再决定要不要应用。'],
  applyCandidate:['应用候选文件',
    '把一批候选文件正式写进项目。\n\n'+
    '通常是导入项目时 AI 帮你分拣出来的结果，确认没问题才应用。'],
  importChanges:['导入改动',
    '把 AI 建议的改动批量导入项目。\n\n'+
    '导入前会和当前文件做比对，如果这期间你自己也改过同一个文件，会提示冲突，不会强行覆盖。'],
  restoreSnapshot:['恢复上一版',
    '把项目回滚到上一次修改之前的状态。\n\n'+
    '注意：只保留最近一版快照，再往前就回不去了。\n'+
    '恢复前建议先导出一次项目做备份。'],
  cloudList:['同步云端项目',
    '从官方 Studio 云端拉取项目列表，看看云端上有哪些项目。\n\n'+
    '用你已经在网页版登录的账号身份去读，不需要另外填 token。'],
  cloudUpload:['上传到云端',
    '把这个项目的源码上传到官方 Studio 云端。\n\n'+
    '上传后可以在电脑上打开继续做，也会出现在云端的项目列表里。'],
  cloudUploadAll:['全部上传同步',
    '把所有本地项目一次性传到云端。\n\n'+
    '记录每个项目的进度，传到一半中断了也不会重复创建云端项目。'],
  cloudPull:['下载云端项目',
    '把云端上的项目下载到本地，变成一个可以编辑的本地项目。\\n\\n'+
    '云端只存源码。语音识别模型那 78 MB 权重是平台构建时临时下载的，不在项目快照里，'+
    '所以同步回来也没有模型，本地识别用不了。需要模型就用「补全素材」补进去。'],
  auditAssets:['素材体检',
    '核对项目里的分片资源齐不齐。\\n\\n'+
    '语音识别模型被切成 20 片存着，旁边有份清单记录每片该多大。这个检查就照着清单逐片对，'+
    '缺一片或者大小不对都算不完整。\\n\\n'+
    '为什么要单独查：文件浏览器里 20 个分片摆在那里，看着都在，看不出哪个是空的。'+
    '而运行时的表现只是识别一直用不了，不告诉你是缺文件。'],
  fillFiles:['补全素材',
    '从一份完整的安装包（ZIP）里，把当前项目缺的文件补进来。\\n\\n'+
    '典型用法：云端同步来的项目缺语音识别模型，这时候选一份带模型的安装包，'+
    '只补缺的那些，项目里已有的文件一个都不会被改动。\\n\\n'+
    '依赖目录和构建缓存不会补，那些能重新装。'],
  cloudRelay:['云端接力开发',
    '把项目推到云端，接着在电脑或网页上继续开发。\n\n'+
    '只有上传快照完整校验通过之后，才会打开对应的云端项目，避免传一半就以为传完了。'],
  linkStudio:['关联 Studio 项目',
    '把这个本地项目关联到官方 Studio 里的某个具体项目页面。\n\n'+
    '关联只是记住链接，方便一键跳过去，不会同步源码。\n'+
    '要先在网页上打开具体项目，首页不能作为关联对象。'],
  captureStudio:['导入 Studio 页面文字',
    '把官方 Studio 当前页面上能看到的文字抓下来，存进项目当上下文。\n\n'+
    '只读可见文字，不碰登录凭据和隐藏数据。\n'+
    '抓完会先给你核对，再决定要不要交给 AI。'],
  handoffStep:['填入 Studio 输入框',
    '把本地整理好的内容，自动填进官方 Studio 的对话框里。\n\n'+
    '只填不发送，你还需要自己在网页上点发送并核对内容。\n'+
    '如果网页里已经有没发出去的草稿，会问你要不要替换。'],
  handoffAmoo:['交给 Amoo 执行',
    '把这段任务文字发给系统的 Amoo（AI 启动器）去执行。\n\n'+
    'Amoo 可能调用手机的摄像头、定位等能力，请先明确任务范围。\n'+
    '执行结果不会自动回到项目里，需要你自己核对。'],
  openStudioProject:['打开 Studio 项目',
    '跳到这个项目关联的官方 Studio 网页。\n'+
    '没关联过的话会先提示你去关联。'],
  deleteProject:['删除项目',
    '把项目移到「最近删除」，不是真的删掉。\n\n'+
    '源码、协作记录、快照都还在，随时能恢复。\n'+
    '不会影响云端项目、已导出的文件和已安装的 App。'],
  purgeProject:['彻底删除',
    '真的删掉，无法恢复。\n\n'+
    '会连工作台里缓存的构建 APK 一起清掉。\n'+
    '云端项目、已导出的文件、已安装的 App、AI 对话和 Token 账本不受影响。'],
  restoreProject:['恢复项目',
    '把项目从「最近删除」里搬回来，原来的代码、协作记录、构建记录都保留。'],
  renameProject:['重命名项目',
    '给项目换个名字。只改显示名称，项目 id、文件内容、构建记录都不变。'],
  settings:['模型与 API 设置',
    '配置 AI 用哪个服务：接口地址、密钥、模型 ID。\n\n'+
    '支持云端 API 和本地模型两种。密钥存在手机的安全区里，加密后无法导出。\n'+
    '网页界面永远拿不到密钥原文。'],
  detectModels:['检测可用模型',
    '连一下你配置的服务，问它支持哪些模型，然后把列表显示出来供你选。\n'+
    '不用自己手打模型名字。'],
  testProfile:['测试连接',
    '发一个小请求试试这个配置能不能通。\n'+
    '能通说明地址、密钥、模型名都对；不通会告诉你卡在哪一步。'],
  freshProfile:['新建模型配置',
    '加一套新的模型配置。可以同时存好几套，随时切换。'],
  deleteProfile:['删除模型配置',
    '删掉这套配置，连同里面存的密钥一起删。已有对话和账本记录保留。'],
  exportChat:['导出对话',
    '把这段 AI 对话导出成文本文件，方便存档或贴到别处。'],
  exportContext:['导出上下文',
    '把当前项目的全部文件内容导出成一个文件。\n\n'+
    '用途：本地模型接不上时，拿去外部 AI 网页版手动对话。'],
  usageExport:['导出 Token 明细',
    '把 Token 账本导出成 CSV 表格，可以用 Excel 打开。\n\n'+
    '每行是一次调用：时间、来源、项目、服务商、模型、状态、各类 Token 数、耗时。'],
  checkUpdates:['检查更新',
    '查一下 GitHub 上有没有 StepX Studio 的新版本。\n\n'+
    '有新版会显示版本号和更新说明，可以下载安装。\n'+
    '只认正式发布版，且下载后要核对文件指纹，对不上不会装。'],
  trash:['最近删除',
    '看被删掉的项目。在这里可以恢复，也可以彻底删除。'],
  newProject:['新建项目',
    '从零开始建一个空项目，写好名字就能进编辑器写代码。\n\n'+
    '建好后项目里有一个最简的 index.html，可以直接改。\n'+
    '也可以在 AI 助手里直接说「做一个 xxx」，它会自动建项目。'],
  addFile:['新建文件',
    '在项目里加一个新文件。\n\n'+
    '文件名要带后缀，比如 style.css、app.js、data.json。\n'+
    '不支持子目录（所有文件都在项目根目录下）。'],
  deleteFile:['删除文件',
    '把当前这个文件从项目里删掉，删了不能恢复。\n\n'+
    'index.html 删掉后项目就跑不起来了，删之前想清楚。'],
  applyHtml:['应用改动',
    '把编辑器里改好的内容保存回项目。\n\n'+
    '改完不点这个，改动只在编辑器里，打包出去还是旧的。'],
  addTask:['添加任务',
    '给项目加一条待办任务。写清楚要做什么，\n'+
    '之后可以让 AI 一条条去执行，或者自己动手做。\n\n'+
    '任务只是备忘清单，不会自动执行。'],
  runProjectTask:['执行这个任务',
    '把这条任务的内容发给 AI，让它现在就动手做。\n\n'+
    '会消耗 Token。做完的改动按你选的模式处理：\n'+
    '直接写入 或 先给你审查。'],
  saveProfile:['保存配置',
    '把接口地址、密钥、模型名存下来。\n\n'+
    '密钥存在手机加密区，不会写进项目文件，导出 ZIP 也带不走。'],
  editProfile:['编辑配置',
    '修改这套模型的参数：地址、密钥、模型名。\n\n'+
    '如果只换地址不换密钥，出于安全会要求你重新填一次密钥，\n'+
    '防止把密钥误发到别的服务器。'],
  send:['发送',
    '把输入框里的内容发给 AI。\n\n'+
    '会消耗 Token，用量记进「Token 账本」。\n'+
    '发送后可以随时点「取消」中断。'],
  chatHistory:['对话历史',
    '看以前的所有对话，可以搜索、批量删除、导出。\n\n'+
    '删对话只删对话记录，项目文件和 Token 账本都保留。'],
  newChat:['新对话',
    '开一段全新的对话，不带之前的上下文。\n\n'+
    '聊久了上下文变长会变慢变贵，换新对话能省不少。'],
  deleteChat:['删除对话',
    '把这段对话删掉，删了不能恢复。\n'+
    '项目文件和 Token 账本不受影响。'],
  indent:['整理缩进',
    '自动把代码的缩进排整齐，让嵌套结构看得清。\n'+
    '只改空格和换行，不改代码逻辑。'],
  findCode:['查找',
    '在当前文件里搜索文字，可以跳到上一处 / 下一处。'],
  copyCode:['复制代码',
    '把编辑器里的代码复制到剪贴板，可以贴到别处。'],
  copyMessage:['复制这条消息',
    '把这条 AI 回复的文字复制到剪贴板。'],
  copyResult:['复制结果',
    '把这次 AI 输出的内容复制到剪贴板。'],
  file:['打开文件',
    '点开这个文件开始编辑。'],
  localModels:['本地模型',
    '管理离线模型：下载、导入、删除，以及调推理参数。\n\n'+
    '本地模型不联网、不用密钥、不花钱，但速度取决于手机算力。'],
  cancel:['取消',
    '中断正在跑的 AI 请求或绘图任务。\n\n'+
    '云端接口取消后服务端可能仍会计费，这次用量会标为「未知」。'],
  stopAuto:['停止联动',
    '停下自动联动。已经发给 Studio 的任务不会撤回，\n'+
    '需要你自己去 Studio 页面核对现在做到哪一步了。'],
  importProfiles:['粘贴导入配置',
    '一次导入多套模型配置，省得一个一个填。\n\n'+
    '先复制一段 JSON，再点这个按钮，会从剪贴板读取并导入。\n\n'+
    '格式（可以一次放好几套）：\n'+
    '[{"name":"MiniMax","endpoint":"https://api.minimax.cn/v1",\n'+
    '  "model":"MiniMax-M3.1-Flash","key":"sk-xxx"}]\n\n'+
    '· name 配置名称\n'+
    '· endpoint 接口地址，必须 https 开头\n'+
    '· model 模型 ID\n'+
    '· key API Key\n'+
    '· protocol 可选，compatible（默认）或 anthropic\n\n'+
    '密钥会加密存进手机的安全区，不会留在页面上。'],
  localInspect:['读取文件列表',
    '在一行里填 Hugging Face 的「组织名/仓库名」，然后点这个按钮，\n'+
    '去那个仓库里看看有哪些可以下载的 .litertlm 模型文件。\n\n'+
    '只是列个清单，不下载。列表会显示每个文件的名字和大小（一般 3~5 GB）。\n\n'+
    '如果提示读取失败，多半是网络或仓库名填错了。受限模型（要同意许可的）\n'+
    '需要先在 Hugging Face 网页上点同意，再把只读令牌填进下面那栏。'],
  localDownload:['下载并校验',
    '把选中的模型文件下载到手机里。\n\n'+
    '· 支持断点续传：中断了再点一次，会从断的地方接着下，不用重来\n'+
    '· 下完自动校验 SHA-256，对不上会删掉重下，防止用到损坏的文件\n'+
    '· 下载期间可以点「暂停」，已下载的部分保留\n\n'+
    '文件通常 3~5 GB，建议连 WiFi。手机至少要留出文件大小 + 512MB 的空间。'],
  localImport:['导入本地模型',
    '从手机存储里选一个已经下载好的 .litertlm 文件导入。\n\n'+
    '适合：用电脑下好了再传到手机、或者从别处拿到的模型文件。\n'+
    '文件必须是 LiteRT-LM 格式，其他格式（.gguf / .safetensors 等）不能用。'],
  localSelect:['保存并用于 AI 助手',
    '把下面这些参数保存下来，并把当前选中的模型设为 AI 助手的默认模型。\n\n'+
    '可调参数：\n'+
    '· 执行后端 —— GPU 快但吃电，CPU 稳但慢\n'+
    '· 上下文 Token —— 能记住多长的对话，越大越吃内存\n'+
    '· 最大输出 —— 一次最多生成多少字\n'+
    '· 温度 / Top-K / Top-P —— 影响回答的随机性\n\n'+
    '拿不准就点「官方参数」按钮，它会填入推荐值。'],
  localDelete:['删除模型',
    '把这个模型文件从手机上删掉，腾出空间。\n'+
    '删了以后要重新下载才能用。'],
  localDefaults:['官方参数',
    '把参数填成官方推荐的默认值（温度 1 / Top-K 64 / Top-P 0.95 / 32K 上下文）。\n'+
    '不知道该怎么调的时候用这个就行。'],
  cloudCancel:['取消同步',
    '中止正在进行的云端上传或下载。已经传完的部分保留。']
};

/*
 * 返回键处理。
 *
 * 原生侧点返回时会先调 window.backLocal()，返回 true 表示「我自己处理了」，
 * 返回 false 才继续走原生的返回逻辑（回上一页 / 询问退出）。
 *
 * 这里只做一件事：如果说明框还开着，关掉它并吃掉这次返回。
 * 不加这段的话，说明框开着时按返回键会直接触到「是否退出应用」，体验很糟。
 */
window.backLocal=function(){
  const masks=document.querySelectorAll('.explain-mask');
  if(masks.length){
    masks[masks.length-1].remove();
    return true;
  }
  return false;
};

/* 拦截器：返回 true 表示已弹框拦截，动作先不执行 */
function explainGuard(a,b){
  const item=EXPLAIN[a];
  if(!item)return false;                          // 没写说明，不拦
  if(b.dataset.explainOk==='1'){delete b.dataset.explainOk;return false;}  // 刚点过「继续」
  let seen=null;
  try{seen=localStorage.getItem('explainSeen:'+a);}catch(e){}
  if(seen==='1')return false;                     // 勾过不再提示
  showExplain(a,item[0],item[1],b);
  return true;
}

/* 弹说明框 */
function showExplain(key,title,body,btn){
  const mask=document.createElement('div');
  mask.className='explain-mask';   // 统一 class，方便返回键处理时找到它
  mask.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:99999;'+
    'display:flex;align-items:center;justify-content:center;padding:22px;overflow:auto';
  const card=document.createElement('div');
  // 卡片用 flex 列布局：正文可滚，按钮固定在底部。
  // 为什么重要：说明文字一长（比如七八行），按钮会被挤出可视区，
  // 用户点「继续」实际点在遮罩上 —— 遮罩的点击是「关闭」，
  // 所以表现成「弹框关了但什么都没执行」。
  card.style.cssText='background:#2b2b2e;border:1px solid rgba(255,255,255,.10);border-radius:18px;'+
    'padding:22px 20px;max-width:460px;width:100%;color:#ededf0;box-shadow:0 18px 60px rgba(0,0,0,.55);'+
    'max-height:84vh;display:flex;flex-direction:column';
  const btnStyle='flex:1;height:44px;border-radius:11px;font-size:15px;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:transparent;color:#b8b8c0';
  const okStyle='flex:1;height:44px;border-radius:11px;font-size:15px;font-weight:700;cursor:pointer;border:0;background:#ff8a5b;color:#231a16';
  card.innerHTML=
    // 可滚动的正文区
    '<div style="overflow-y:auto;flex:1;min-height:0;-webkit-overflow-scrolling:touch">'+
      '<div style="font-size:17px;font-weight:700;color:#ff8a5b;margin-bottom:12px">'+esc(title)+'</div>'+
      '<div style="font-size:14px;line-height:1.75;white-space:pre-wrap;color:#d8d8de">'+esc(body)+'</div>'+
      '<label style="display:flex;align-items:center;gap:9px;margin-top:18px;font-size:13px;color:#9a9aa4;cursor:pointer">'+
        '<input type="checkbox" id="expSkip" style="width:17px;height:17px;accent-color:#ff8a5b">这个按钮的说明不再提示</label>'+
    '</div>'+
    // 按钮区：不参与滚动，永远贴在卡片底部
    '<div style="display:flex;gap:10px;margin-top:18px;flex-shrink:0">'+
      '<button id="expNo" style="'+btnStyle+'">取消</button>'+
      '<button id="expYes" style="'+okStyle+'">继续</button>'+
    '</div>';
  mask.appendChild(card);
  document.body.appendChild(mask);

  const close=()=>{if(mask.parentNode)mask.remove();};
  card.querySelector('#expNo').onclick=close;
  mask.onclick=e=>{if(e.target===mask)close();};
  card.querySelector('#expYes').onclick=()=>{
    if(card.querySelector('#expSkip').checked){
      try{localStorage.setItem('explainSeen:'+key,'1');}catch(e){}
    }
    close();
    btn.dataset.explainOk='1';
    // 直接调分发函数，不再模拟点击。
    // btn.click() 会在同一帧里刚移除遮罩就派发事件，偶尔被吞掉，
    // 表现为「按了继续但什么都没发生」。
    handleAction(btn);
  };
}

/* 动作分发：所有 data-a 按钮点下去最终都走到这里。
 * 拆成独立函数（而不是写在事件监听器里）是为了让「说明框」的「继续」
 * 可以直接调用它 —— 之前是靠 btn.click() 重新派发一次点击事件，
 * 但那样在同一帧里刚移除遮罩就派发，事件偶尔会被吞掉，
 * 表现是按了「继续」什么都没发生（比如导入 ZIP 不弹文件选择器）。 */
function handleAction(b){
  const a=b.dataset.a,id=b.dataset.id;
  if(explainGuard(a,b))return;const p=project(),c=chat();if(['projects','trash','settings','ai','usage','help','localModels'].includes(a)){page=a;render();return}switch(a){case 'cloudRelay':if(!id)saveProject();send('cloudRelay',{id:id||p.id});break;case 'cloudUploadAll':send('cloudUploadAll');break;case 'cloudCancel':send('cloudCancel');break;case 'resetExplains':{let n=0;try{const keys=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.indexOf('explainSeen:')===0)keys.push(k)}keys.forEach(k=>localStorage.removeItem(k));n=keys.length;}catch(e){}const r=document.querySelector('#explainResetResult');if(r)r.textContent=n?('已重置 '+n+' 个按钮，下次点击会重新显示说明'):'当前没有勾过「不再提示」的按钮';break}case 'cloudList':send('cloudList');break;case 'cloudPull':send('cloudPull',{id:p.id});break;case 'fillFiles':send('fillFiles',{projectId:p.id});break;case 'auditAssets':send('auditAssets',{projectId:p.id});break;case 'cloudUpload':if(!id)saveProject();send('cloudUpload',{id:id||p.id});break;case 'checkUpdates':send('checkUpdates');break;case 'newProject':newProject();break;case 'importProject':send('importProject');break;case 'studio':send('studio');break;case 'openProject':projectId=id;file='index.html';undo=[];redo=[];page='editor';render();break;
case 'backEditor':page='editor';render();break;
case 'filesPage':page='files';render();break;
case 'changesPage':diffFilter='all';page='changes';render();break;
case 'backChanges':page='changes';render();break;
case 'diffFilter':diffFilter=id;render();break;
case 'diffFull':diffFull=(id==='1');render();break;
case 'compare':diffPath=id;diffResult=null;diffFull=false;page='compare';render();break;
case 'bigfilesPage':page='bigfiles';render();break;
case 'overviewPage':page='overview';render();break;
case 'replacePage':page='replace';render();break;
case 'openPath':{
  const p=project();
  if(p&&(p.files||{})[id]!==undefined){file=id;undo=[];redo=[];page='editor';render();}
  else notice('这是二进制文件，不能当文本编辑。可以在文件浏览器里重命名或删除它。');
  break;
}
case 'makeSnapshot':{const p=project();if(p)send('makeSnapshot',{projectId:p.id});break;}
case 'snapshotNow':{const p=project();if(p)send('makeSnapshot',{projectId:p.id});break;}
case 'bigInfo':{
  const p=project(),sizes=p&&p.binarySizes?p.binarySizes:{};
  notice(id+' · '+(sizes[id]==null?'大小未知':fmtSize(sizes[id]))+'。二进制文件不能当文本编辑，可以删除腾出空间。');
  break;
}
case 'bigDelete':{const p=project();if(p)send('deleteBig',{projectId:p.id,path:id});break;}
case 'fmSelectOn':selectMode=true;selected.clear();render();break;
case 'fmSelectOff':selectMode=false;selected.clear();render();break;
case 'fmSelect':{
  if(selected.has(id))selected.delete(id);else selected.add(id);
  render();
  break;
}
case 'fmAll':{
  const p=project();
  const all=allFiles(p);
  const q=fileQuery.trim().toLowerCase();
  const hits=searchFiles(p,q);
  const shown=q?all.filter(f=>hits.has(f.path)):all;
  if(id==='1'){for(const f of shown)selected.add(f.path);}
  else{for(const f of shown)selected.delete(f.path);}
  render();
  break;
}
case 'fmDelete':{
  const p=project();
  if(!p||!selected.size)break;
  send('confirmBulk',{projectId:p.id,paths:[...selected]});
  break;
}
case 'fmMove':{
  const p=project();
  if(!p||!selected.size)break;
  send('askMoveDir',{projectId:p.id,paths:[...selected]});
  break;
}
case 'doBulkMove':{
  const p=project();
  if(!p||!selected.size)break;
  const paths=[...selected];
  const dir=String(data&&data.dir||'');
  const from=commonDir(paths);
  send('bulkFiles',{projectId:p.id,action:'move',paths:paths,from:from,to:dir});
  selected.clear();selectMode=false;
  notice('正在移动 '+paths.length+' 个文件到 '+(dir||'根目录'));
  break;
}
case 'replaceDo':{
  const p=project();
  if(!p||!rpFind)break;
  // 替换前先存一份存档 —— 替换是批量改，改错了得有办法看回原来什么样
  send('makeSnapshot',{projectId:p.id});
  let filesHit=0,total=0;
  const files=p.files||{};
  /*
   * 逐个文件读真实内容、替换、写进暂存区。
   *
   * 快照里的 files 是清单（路径 → 字节数），内容要按需取；
   * 改完的结果放回 editBuffer，由 saveProject 统一发给原生。
   */
  for(const n of Object.keys(files)){
    const src=fileContent(p,n);
    const c=countOcc(src,rpFind,rpCase);
    if(c>0){editBuffer[n]=replaceIn(src,rpFind,rpWith,rpCase);filesHit++;total+=c}
  }
  if(total===0){notice('没有命中任何内容');break}
  p.updated=Date.now();
  saveProject();
  notice('已替换 '+total+' 处，涉及 '+filesHit+' 个文件。替换前自动存了存档，可在变更视图对比。');
  rpFind='';rpWith='';diffFilter='all';page='changes';render();
  break;
}
case 'codeFocus':codeFocus=!codeFocus;editor();break;
case 'fontPlus':codeFont=Math.min(24,codeFont+1);localStorage.setItem('codeFont',codeFont);applyCodeFont();break;
case 'fontMinus':codeFont=Math.max(9,codeFont-1);localStorage.setItem('codeFont',codeFont);applyCodeFont();break;
case 'gotoLine':send('askLine');break;
case 'doGotoLine':gotoLine(data&&data.line||1);break;
case 'fmToggle':fileCollapsed[id]=!fileCollapsed[id];filesPage();break;
case 'fileMenu':fileMenu(id);break;case 'projectList':page='projects';render();break;case 'file':flushNow();file=id;undo=[];redo=[];page='editor';render();break;case 'preview':saveProject();send('localRun',{id:p.id});break;case 'exportProject':saveProject();send('exportProject',{id:p.id});break;case 'renameProject':{let n=prompt('项目名称',p.name);if(n){p.name=n.slice(0,60);saveProject();render()}break}case 'projectMenu':send('projectMenu',{id});break;case 'deleteProject':send('projectTrash',{id:id||p?.id});break;case 'restoreProject':send('projectRestore',{id});break;case 'purgeProject':send('projectPurge',{id});break;case 'addFile':{let n=prompt('根目录文本文件名，例如 utils.js');if(!n)return;if(!(p.cloudSource?validSourcePath(n):/^[\p{L}\p{N}_-][\p{L}\p{N} ._-]{0,99}$/u.test(n)&&!n.includes('..'))||p.files[n]!=null||p.binaryFiles?.[n]!=null){notice('文件名无效或已存在');return}p.files[n]=0;editBuffer[n]='';file=n;saveProject();render();break}case 'deleteFile':if(file==='index.html'&&!p.cloudSource){notice('请保留项目入口 index.html');break}if(confirm('删除 '+file+'？')){delete p.files[file];delete editBuffer[file];file='index.html';saveProject();render()}break;case 'indent':insert('  ');break;case 'undo':if(undo.length){redo.push(currentContent(p,file));editBuffer[file]=undo.pop();saveProject();$('#code').value=editBuffer[file]}break;case 'redo':if(redo.length){undo.push(currentContent(p,file));editBuffer[file]=redo.pop();saveProject();$('#code').value=editBuffer[file]}break;case 'findCode':{
  let q=prompt('查找文字');if(!q)break;
  const t=$('#code'),src=t.value;
  /*
   * 从当前光标往后找，到末尾还没找到就从头再找一遍 —— 这样连点「查找」
   * 能一圈一圈往下跳。只 setSelectionRange 是不够的：匹配在视野外时
   * 编辑器不会自动滚过去，用户会觉得「点了没反应」。
   */
  let at=src.indexOf(q,t.selectionEnd);
  if(at<0)at=src.indexOf(q);
  if(at<0){notice('未找到：'+q);break}
  t.focus();
  t.setSelectionRange(at,at+q.length);
  // 按行号换算出纵向位置，把匹配行滚到编辑区中间
  const lineOf=src.slice(0,at).split('\n').length;
  const lineH=parseFloat(getComputedStyle(t).lineHeight)||20;
  t.scrollTop=Math.max(0,(lineOf-1)*lineH-t.clientHeight/2);
  notice('已定位到第 '+lineOf+' 行');
  break}case 'copyCode':send('copy',{text:currentContent(p,file)});break;case 'aiCode':page='ai';includeCode=true;render();break;case 'chatHistory':openChatHistory();break;case 'newChat':newChat();break;case 'send':sendMessage();break;case 'pickImage':Neo.pickImage('{}');break;
 case 'integrations':page='integrations';window.integrationState=null;send('integrationConfig');render();break;
 case 'memoryPage':page='memory';window.memoryState=null;send('memorySkills',{projectId:projectId||''});render();break;
 case 'saveNet':send('netSettings',{searchProvider:$('#searchProvider')?$('#searchProvider').value:'',searchKey:$('#searchKey')?$('#searchKey').value:''});notice('已保存');send('integrationConfig');break;
 case 'clearSearchKey':send('netSettings',{clearKey:true});notice('已清除搜索密钥');send('integrationConfig');break;
 case 'saveGithub':send('githubSettings',{ghToken:$('#ghToken')?$('#ghToken').value:'',ghOwner:$('#ghOwner')?$('#ghOwner').value:'',ghRepo:$('#ghRepo')?$('#ghRepo').value:''});notice('已保存');send('integrationConfig');break;
 case 'clearToken':send('githubSettings',{clearToken:true});notice('已断开 GitHub');send('integrationConfig');break;
 case 'testGithub':send('githubTest');break;
 case 'clearMemory':send('memoryClear',{scope:b&&b.dataset?b.dataset.scope||'global':'global',projectId:projectId||''});send('memorySkills',{projectId:projectId||''});break;case 'dropImage':pendingImages.splice(Number(b&&b.dataset.i)||0,1);render();break;case 'cancel':send('cancel');break;case 'exportChat':if(c)send('exportText',{name:'neo-conversation.md',text:'# '+c.name+'\n\n'+c.messages.map(m=>'## '+(m.role==='user'?'我':'AI')+'\n\n'+m.content).join('\n\n')});break;case 'deleteChat':requestChatDeletion(c?[c.id]:[]);break;case 'copyMessage':send('copy',{text:c.messages[+id].content});break;case 'reviewAiFiles':{const edit=c.messages[+id].edit;if(!edit){notice('这条消息没有可审查的改动');break}if(!S.projects.some(x=>x.id===edit.projectId)){notice('原目标项目不存在');break}if(edit.filesOmitted){notice('这次改动太大（'+(edit.filesSize||0)+' 字符），已不保存完整内容。请让 AI 分批修改后再审查');break}projectId=edit.projectId;candidateProjectId=edit.projectId;candidateBase=allFileContents(project());candidateFiles=edit.files;candidateSource='AI 助手';page='review';render();break}case 'applyHtml':{const m=c.messages[+id].content.match(/```(?:html)?\s*\n([\s\S]*?)```/i);if(m&&confirm('把此代码另存为新项目？原项目保留。'))newProject(m[1]);break}case 'freshProfile':editProfile=null;detectedModels=[];settings();break;case 'importProfiles':importProfilesFromClipboard();break;case 'editProfile':editProfile=id;detectedModels=[];settings();break;case 'saveProfile':saveProfile('');break;case 'testProfile':if(confirm('保存配置并发送一次简短测试请求？服务商可能计费。'))saveProfile('test');break;case 'detectModels':saveProfile('detect');break;case 'deleteProfile':if(confirm('删除此配置及加密密钥？')){send('delete',{list:'profiles',id:editProfile});S.profiles=S.profiles.filter(x=>x.id!==editProfile);editProfile=null;settings()}break;case 'today':usageScope='today';usage();break;case 'allUsage':usageScope='all';usage();break;case 'usageExport':send('usageExport');break;}
}
app.addEventListener('click',e=>{const b=e.target.closest('[data-a]');if(b)handleAction(b);});
render();

app.addEventListener("click",async e=>{if(e.target.closest("[data-a=license]")){const text=await (await fetch("licenses-apksig.txt")).text();app.innerHTML=`<div class="page"><button data-a="help">‹ 使用说明</button><h1>apksig-android 4.4.0</h1><pre class="contextPreview">${esc(text)}</pre></div>`}});

try{document.documentElement.dataset.appearance=Neo.appearance()||'glass'}catch{}
send('appearance',{value:document.documentElement.dataset.appearance||'glass'});
app.addEventListener('change',e=>{if(e.target.id==='appearanceSelect'){document.documentElement.dataset.appearance=e.target.value;send('appearance',{value:e.target.value});try{localStorage.setItem('neo-appearance',e.target.value)}catch{}}});

function validSourcePath(p){return p.length>0&&p.length<=240&&!/[\\\x00-\x1f\x7f]/.test(p)&&!p.startsWith('/')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');}
function cloudControls(p){const c=p.cloud,bin=Object.keys(p.binaryFiles||{});return `<div class="cloud-controls"><div class="row"><button class="primary" data-a="cloudRelay" ${window.cloudRelayState?.status==='syncing'?'disabled':''}>云端接力开发 ↗</button><button data-a="cloudUpload">上传项目 ↑</button>${c?'<button data-a="cloudPull">同步到本地 ↓</button>':''}<button data-a="fillFiles" title="云端项目只存源码，语音模型这类大文件不在里面。用这个从完整安装包补进来。">补全素材 ⊞</button><button data-a="auditAssets" title="核对分片资源齐不齐。模型缺片时界面上看不出来，但识别就是用不了。">素材体检 ⊙</button><details class="cloud-status"><summary>同步详情</summary><div class="cloud-info">${c?`<small>云端：${esc(c.name)}<br>${esc(c.message||'已关联')}</small>`:'<small>接力会同步源码与资源、打开同一 Studio 项目并准备草稿。首次接力自动创建并关联项目。</small>'}${p.cloudSource?'<small>云端源码 · 可在本机编译运行前端，也可交给 Studio。</small>':''}${c?.skipped?.length?`<small>已排除 ${c.skipped.length} 项</small><pre>${esc(c.skipped.join('\n'))}</pre>`:''}${bin.length?`<small>${bin.length} 个二进制资源（同步和 ZIP 导出保留）</small><pre>${esc(bin.join('\n'))}</pre>`:''}</div></details></div></div>`;}

function cloudBatchCard(){const b=S.cloudBatch;if(!b?.items?.length)return '';const labels={waiting:'等待',running:'上传中',done:'完成',failed:'失败',stopped:'已停止',interrupted:'已中断'};return `<details class="card cloud-batch" ${b.running?'open':''}><summary>上传同步 · ${b.items.filter(x=>x.status==='done').length}/${b.items.length} 完成${b.running?' · 进行中':''}</summary>${b.items.map(x=>`<div class="sync-result"><strong>${esc(x.name)}</strong><span>${labels[x.status]||esc(x.status)}</span><small>${esc(x.message||'')}</small></div>`).join('')}${b.running?'<button data-a="cloudCancel">停止后续上传</button>':'<small>可单独重试失败项目；再次同步只上传变化，不删除云端文件。</small>'}</details>`;}
