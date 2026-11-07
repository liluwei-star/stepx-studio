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
let detectedModels=[],draft=S.draft||'',includeCode=false,undo=[],redo=[],noticeTimer;aiLive=S.activeAi||{};
const defaults=()=>{for(const k of ['projects','profiles','chats','usage','projectTrash'])if(!Array.isArray(S[k]))S[k]=[]};defaults();
const project=()=>S.projects.find(x=>x.id===projectId),chat=()=>S.chats.find(x=>x.id===chatId),selectedProfile=()=>S.profiles.find(x=>x.id===profileId)||S.profiles[0];
function notice(s){$('#notice').textContent=s;$('#notice').style.display='block';clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').style.display='none',5000)}
function saveProject(){const p=project();if(!p)return;p.updated=Date.now();send('project',p);if($('#saveStatus'))$('#saveStatus').textContent='草稿已保存到本机';}
function saveChat(c=chat()){if(c){c.updated=Date.now();send('chat',c)}}
window.receive=(type,data)=>{if(type==='cloudRelay'){window.cloudRelayState=data;notice(data.message);if(page==='projects')projects();else if(page==='editor')editor();return;}if(type==='aiProjectCreated'){S=JSON.parse(Neo.read());if(chatId===data.chatId){projectId=data.projectId;aiEditMode='auto';renderIfAi();}return;}if(type==='cloudBatch'){S.cloudBatch=data;if(page==='projects')projects();return;}if(type==='connectorStatus'){connectorStatus=data;if($('#connectorStatus'))$('#connectorStatus').textContent=data;return;}if(type==='connectorsChanged'){S.connectors=data;if(page==='connectors')render();return;}if(type==='aiTool'){notice((data.ok?'已完成：':'工具未完成：')+data.name);return;}if(type==='aiLive'){aiLive=data;refreshLiveEdit();return;}if(type==='localModelProgress'){localModelStatus=data;refreshLocalModelProgress();return;}if(type==='localModelCatalog'){localModelCatalog=data;page='localModels';render();return;}if(type==='localModelsChanged'){S.localModels=data;if(page==='localModels')render();return;}if(type==='chatsDeleted'){S=JSON.parse(Neo.read());defaults();if(data.includes(chatId))chatId=null;historySelected.clear();historyEditing=false;if(page==='ai')render();refreshChatHistory();notice('已删除 '+data.length+' 段对话，Token 账本保留');return;}if(type==='cloudError'){notice(data);return;}if(type==='aiSetting'){S=JSON.parse(Neo.read());if(!S.aiAssistantEnabled&&page==='ai')page='projects';render();return;}if(type==='cloudUpdated'){S=JSON.parse(Neo.read());render();return;}if(type==='filesApplied'){S=JSON.parse(Neo.read());projectId=data;candidateFiles=null;candidateBase=null;file='index.html';undo=[];redo=[];render();notice('文件已保存，已保留恢复快照');return;}if(type==='studioUsage'){S=JSON.parse(Neo.read());if(data.status==='runtime')studioReportId=data.report.projectId;if(page==='usage')usage();return;}if(type==='projectOpen'){S=JSON.parse(Neo.read());defaults();projectId=data;file='index.html';undo=[];redo=[];page='editor';render();return;}if(type==='projectChanged'){S=JSON.parse(Neo.read());defaults();if(data.id===projectId&&data.action!=='restore'){projectId=null;includeCode=false;undo=[];redo=[];}page=data.action==='trash'?'projects':page==='trash'?'trash':'projects';render();notice(data.action==='trash'?'已移到最近删除，可恢复':data.action==='restore'?'已恢复到本地项目':'项目已彻底删除');return;}if(type==='autoOpen'){S=JSON.parse(Neo.read());projectId=data;page='collab';render();return;}if(type==='autoUpdate'){S=JSON.parse(Neo.read());if((page==='collab'&&projectId===data)||page==='usage')render();return;}if(type==='buildReady'){S=JSON.parse(Neo.read());projectId=data;page='builds';render();notice('APK 已在 Neo 本机完成签名构建');}else if(type==='building'){buildBusy=data===true||data==='true';if(page==='builds')render();}else if(type==='state'){S=data;defaults();if(!['editor','settings','ai','collab','review','builds'].includes(page))render();}else if(type==='projectRefresh'){S=JSON.parse(Neo.read());if(page==='collab')render();}else if(type==='importCandidate'){S=JSON.parse(Neo.read());projectId=data.id;candidateFiles=data.files;candidateProjectId=data.id;candidateBase=JSON.parse(JSON.stringify(project().files));candidateSource='Studio / ZIP 导入';page='review';render();}else if(type==='saved'){if($('#saveStatus'))$('#saveStatus').textContent='草稿已保存到本机';}else if(type==='profileSaved'){S=JSON.parse(Neo.read());defaults();editProfile=data.id;profileId=data.id;if(data.next==='local'){page='ai';render();notice('已切换到本地模型');}else if(data.next==='test'){page='ai';newChat();draft='请只回复：连接成功';sendMessage()}else if(page==='settings')settings();}else if(type==='models'){if(editProfile===data.id){detectedModels=data.models;settings();notice('检测到 '+data.models.length+' 个模型；列表可能由服务商分页返回，可继续手动填 ID')}}else if(type==='modelLoading'){if($('#detectButton'))$('#detectButton').textContent=(data===true||data==='true')?'检测中…':'保存并检测模型';}else if(type==='error'){notice(data);if($('#aiToggle'))$('#aiToggle').checked=S.aiAssistantEnabled!==false;busy=false;renderIfAi();}else if(type==='busy'){busy=data===true||data==='true';renderIfAi();refreshChatHistory();}else if(type==='reply'){S=JSON.parse(Neo.read());defaults();if(data.edit?.status==='applied'&&data.edit.projectId===projectId&&page==='editor'){undo=[];redo=[];if(!project()?.files[file])file='index.html';render();notice('AI 已更新当前项目文件');}else renderIfAi();}};
function renderIfAi(){if(page==='ai'||page==='collab'||page==='usage')render()}
window.backLocal=()=>{if(closeChatHistory())return true;if(page==='collab'||page==='review'||page==='builds'){page='editor';render();return true}if(page==='editor'){page='projects';render();return true}if(page==='trash'){page='projects';render();return true}if(page==='settings'||page==='help'||page==='localModels'||page==='connectors'){page=page==='settings'&&S.aiAssistantEnabled!==false?'ai':'projects';render();return true}return false};
window.navigate=p=>{closeChatHistory();if(p==='projects'&&page==='editor')return;page=p;render()};
function header(tag,title,sub){send('pageTitle',{page});return ''}
function render(){document.documentElement.dataset.ai=S.aiAssistantEnabled===false?'off':'on';if(page==='ai'&&S.aiAssistantEnabled===false)page='projects';send('pageTitle',{page});if(page==='art')return artPage();if(page==='artSettings')return artSettingsPage();if(page==='connectors')return connectorsPage();if(page==='localModels')return localModelsPage();if(page==='builds')return buildPage();if(page==='collab')return collaboration();if(page==='review')return reviewChanges();if(page==='editor')return editor();if(page==='projects')return projects();if(page==='trash')return trashPage();if(page==='settings')return settings();if(page==='ai')return ai();if(page==='usage')return usage();help()}
function projects(){app.innerHTML=`<div class="page">${header('CREATE ON NEO','把想法，写在手机里。','本机编辑与预览，随时接着做。')}<div class="row"><button class="primary" data-a="newProject">＋ 新建项目</button><button data-a="importProject">导入 HTML / ZIP</button><button data-a="cloudList">同步云端项目 ↓</button><button data-a="cloudUploadAll" ${!S.projects.length||S.cloudBatch?.running?'disabled':''}>全部上传同步 ↑</button></div>${cloudBatchCard()}<div class="card"><div class="row spread"><strong>Step Studio</strong><span class="tag">官方云端构建</span></div><p class="muted">用自然语言构建应用、智能体和技能。</p><button data-a="studio">打开官方 Studio ↗</button></div><div class="row spread"><h2>本地项目</h2><small>${S.projects.length} 个</small></div><p class="project-hint">长按菜单 · 左滑删除 · ↑ 上传到已登录的 Studio</p>${S.projects.length?S.projects.map(projectRow).join(''):`<div class="empty">从一个能运行的小页面开始。<br>支持 HTML、CSS、JavaScript，离线可用。</div>`}<div class="noticebar">本地 Web 项目可在编辑器“构建与调试”中离线生成 APK，也可交给 Step 云端构建。</div><details class="appearance"><summary>功能与显示设置</summary><label class="setting-switch"><input id="aiToggle" type="checkbox" ${S.aiAssistantEnabled!==false?'checked':''}>开启 AI 助手</label><small>关闭后隐藏底部入口；保留模型配置、对话和用量。</small><label for="appearanceSelect">界面材质</label><select id="appearanceSelect"><option value="glass">标准玻璃</option><option value="solid">降低透明度</option><option value="contrast">增强对比度</option></select></details><div class="row"><button data-a="trash">最近删除${S.projectTrash.length?` · ${S.projectTrash.length}`:''}</button><button data-a="help">使用说明</button></div></div>`;if($('#aiToggle'))$('#aiToggle').onchange=e=>send('aiEnabled',{value:e.target.checked});if($('#appearanceSelect'))$('#appearanceSelect').value=document.documentElement.dataset.appearance||'glass';}
function newProject(html){const name=prompt('项目名称','我的 Neo 应用');if(!name)return;const p={id:uuid(),name:name.slice(0,60),updated:Date.now(),files:{'index.html':html||'<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>我的 Neo 应用</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main>\n    <h1>你好，Neo</h1>\n    <p>第一个在手机上编辑的小应用。</p>\n    <button id="count">点按计数 · 0</button>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>','style.css':'body { margin: 0; padding: 32px 20px; font-family: system-ui; background: #eef7f4; color: #173d35; }\nmain { max-width: 560px; margin: auto; }\nbutton { background: #087f75; color: white; border: 0; border-radius: 14px; padding: 16px 24px; font-size: 18px; }','app.js':'let count = 0;\nconst button = document.querySelector("#count");\nif (button) button.onclick = () => {\n  button.textContent = `点按计数 · ${++count}`;\n};'}};S.projects.push(p);projectId=p.id;file='index.html';undo=[];redo=[];saveProject();page='editor';render()}
function editor(){const p=project();if(!p){page='projects';render();return}if(!(file in p.files))file=Object.keys(p.files)[0];app.innerHTML=`<div class="editor"><div class="row"><button data-a="projectList">‹ 项目</button><h2 class="grow">${esc(p.name)}</h2><button class="primary" data-a="preview">本地运行 ▷</button>${p.cloudSource?'<button data-a="openStudioProject">云端 ↗</button>':''}</div>${cloudControls(p)}<div class="row"><button data-art="open">美术资源</button></div>${liveEditCard()}<div class="files">${Object.keys(p.files).map(f=>`<button class="${file===f?'chosen':''}" data-a="file" data-id="${esc(f)}">${esc(f)}</button>`).join('')}<button data-a="addFile">＋ 文件</button></div><textarea id="code" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="代码编辑器" wrap="off"></textarea><div class="tools"><button data-a="indent">Tab</button><button data-a="undo">撤销</button><button data-a="redo">重做</button><button data-a="findCode">查找</button><button data-a="copyCode">复制</button><button data-a="collab">项目协作</button><button data-a="builds">构建 APK</button><button data-a="aiCode">问 AI</button><button data-a="exportProject">导出 ZIP</button><button data-a="renameProject">重命名</button><button class="danger" data-a="deleteFile">删文件</button><button class="danger" data-a="deleteProject">删项目</button></div><div class="status" id="saveStatus">本机自动保存 · ${(p.files[file]||'').length} 字符</div></div>`;document.querySelector('.files .chosen')?.scrollIntoView({block:'nearest',inline:'center'});$('#code').value=p.files[file]||'';$('#code').disabled=!file;$('#code').addEventListener('input',()=>{undo.push(p.files[file]);if(undo.length>80)undo.shift();redo=[];p.files[file]=$('#code').value;saveProject()});$('#code').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();insert('  ')}if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveProject()}})}
function insert(t){const e=$('#code');if(!e)return;const pos=e.selectionStart;e.setRangeText(t,pos,e.selectionEnd,'end');e.dispatchEvent(new Event('input'));e.focus()}
function compiled(p){let html=p.files['index.html']||'';const doc=new DOMParser().parseFromString(html,'text/html');for(const el of [...doc.querySelectorAll('link[rel="stylesheet"][href]')]){let n=el.getAttribute('href').replace(/^\.\//,'');if(p.files[n]!=null){let s=doc.createElement('style');s.textContent=p.files[n];el.replaceWith(s)}}for(const el of [...doc.querySelectorAll('script[src]')]){let n=el.getAttribute('src').replace(/^\.\//,'');if(p.files[n]!=null){let s=doc.createElement('script');s.textContent=p.files[n].replace(/<\/script/gi,'<\\/script');el.replaceWith(s)}}return '<!doctype html>\n'+doc.documentElement.outerHTML}
let aiEditMode='auto',githubResearch=true;
function aiProjectCard(){return `<div class="card ai-target"><div class="ai-target-fields"><div><label for="aiProject">目标项目</label><select id="aiProject" ${busy?'disabled':''}><option value="">仅对话 · 不写入</option>${S.projects.map(x=>`<option value="${esc(x.id)}" ${x.id===projectId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>${project()?`<div><label for="aiEditMode">工作方式</label><select id="aiEditMode" ${busy?'disabled':''}><option value="auto">直接修改 · 留快照</option><option value="review">先审查修改</option><option value="discuss">只讨论项目</option></select></div>`:''}</div>${project()?`<label class="setting-switch"><input id="githubResearch" type="checkbox" ${githubResearch?'checked':''}>开发前检索 GitHub 参考</label><small>先查可复用实现、核对许可证，再编写代码；关闭后可完全离线开发。</small>${artControls()}<details><summary>开发工具与写入说明</summary><small>AI 可列出/读取文件、搜索代码、暂存修改、本机编译检查、预览、离线构建 APK、读取调试日志。每轮最多6次工具循环，过程和结果可查看。</small><small>每轮读取全部最新文件和调试报告。仅写入选定项目；冲突或截断不会覆盖，保留最近 5 次快照。</small><div class="row"><button data-a="backEditor">文件</button><button data-a="preview">预览</button><button data-a="builds">构建 APK</button>${project().snapshots?.length?'<button data-a="restoreSnapshot">恢复文件</button>':''}</div></details>`:'<small>直接说“新建一个待办项目”，助手会创建本地项目并写入代码。也可以选择已有项目继续开发。</small>'}</div>`;}

function ai(){if(!chatId&&S.chats.length)chatId=S.chats.filter(x=>(x.projectId||null)===projectId).slice(-1)[0]?.id||null;const c=chat(),p=selectedProfile();if(p)profileId=p.id;const messages=c?c.messages:[];let usageRows=S.usage.filter(r=>r.chatId===chatId),known=usageRows.filter(r=>r.usage.known),sum=usageTotals(usageRows.filter(r=>usageSource(r)==='external_api')).total,stepSum=usageTotals(usageRows.filter(r=>usageSource(r)==='step_api')).total;app.innerHTML=`<div class="page">${header('YOUR MODELS','AI 编程助手','使用自己的 API，在本机保存对话。')}<div class="row"><select id="profileSelect" class="grow" aria-label="模型配置">${S.profiles.map(x=>`<option value="${esc(x.id)}" ${x.id===profileId?'selected':''}>${esc(x.name)} · ${esc(x.model)}</option>`).join('')||'<option value="">尚未配置模型</option>'}<option value="__new__">＋ 新建模型配置…</option></select><button data-a="settings">API</button><button data-a="localModels">本地模型</button><button data-connect="catalog">连接器</button></div><div class="row" style="margin-top:10px"><button class="grow history-trigger" data-a="chatHistory" aria-haspopup="dialog" aria-controls="chatHistoryDrawer"><span>☰ 对话历史</span><span class="history-current">${esc(c?.name||'新对话')}</span></button><button data-a="newChat">＋</button><button data-a="exportChat">导出</button>${c?'<button class="danger" data-a="deleteChat">删除</button>':''}</div><small>当前对话：第三方 ${num(sum)} / 阶跃 API ${num(stepSum)} / 本地 ${num(usageTotals(usageRows.filter(r=>usageSource(r)==='local_model')).total)} token${usageRows.some(r=>!r.usage.known)?' ＋ 未知用量':''} · 仅统计本工作台</small>${p?`<div class="status">${p.protocol==='local'?'端侧离线 · '+esc(p.name):'发送至 '+esc(p.endpoint)+(p.hasKey?'':' · 尚未保存密钥')}</div>`:'<div class="noticebar">先添加模型配置。支持 Chat Completions 兼容接口和 Anthropic Messages。</div>'}${aiProjectCard()}${liveEditCard()}<div id="messages">${messages.map((m,i)=>`<div class="message ${m.role}"><small>${m.role==='user'?'你':'AI'}</small><div>${m.edit?`<details><summary>查看 AI 返回的代码与说明</summary><pre>${esc(m.content)}</pre></details>`:`<pre>${esc(m.content)}</pre>`}</div>${m.edit?`<div class="noticebar">${esc(m.edit.message)}${m.edit.status==='review'?`<button data-a="reviewAiFiles" data-id="${i}">审查并应用</button>`:''}</div>`:''}${m.research?`<details><summary>GitHub 参考 · ${m.research.status==='failed'?'检索未成功':m.research.references.length+' 个候选'}</summary><pre>${esc(JSON.stringify(m.research,null,2))}</pre></details>`:''}${m.benchmark?.decodeTokensPerSecond?`<small>本机生成 ${Number(m.benchmark.decodeTokensPerSecond).toFixed(1)} Token/s · 首字 ${Number(m.benchmark.firstTokenSeconds).toFixed(1)} 秒</small>`:''}${m.toolCalls?.length?`<details><summary>开发工具记录（${m.toolCalls.length}）</summary><pre>${esc(JSON.stringify(m.toolCalls,null,2))}</pre></details>`:''}${m.reasoning?`<details><summary>推理内容</summary><pre>${esc(m.reasoning)}</pre></details>`:''}${m.usage?`<small>${m.usage.known?`输入 ${num(m.usage.input)} · 输出 ${num(m.usage.output)} · 合计 ${num(m.usage.total)}`:'接口未返回用量'}</small>`:''}<div class="row"><button data-a="copyMessage" data-id="${i}">复制</button>${m.role==='assistant'&&/```(?:html)?\s*\n([\s\S]*?)```/i.test(m.content)?`<button data-a="applyHtml" data-id="${i}">HTML 新建项目</button>`:''}</div></div>`).join('')||'<div class="empty">描述你想做的应用，或在编辑器里<br>点“问 AI”，附上当前文件。</div>'}</div>${busy?'<div class="noticebar">模型正在处理，请保持应用打开。<br>取消后服务端仍可能计费。<button data-a="cancel">取消请求</button></div>':''}<div class="composer"><textarea id="prompt" aria-label="发送给 AI 的内容" placeholder="例如：做一个适合手机使用的录音任务清单"></textarea>${false?`<label><input type="checkbox" id="includeCode" ${includeCode?'checked':''}>附加当前文件：${esc(file)}（${num(project().files[file]?.length)} 字符）</label>`:''}<div class="row spread"><small>多轮上下文随请求发送</small><button class="primary" data-a="send" ${busy||!p?'disabled':''}>${project()&&aiEditMode==='auto'?'修改此项目 ↑':'发送 ↑'}</button></div></div></div>`;$('#aiProject').onchange=e=>{projectId=e.target.value||null;chatId=null;render()};if($('#aiEditMode')){$('#aiEditMode').value=aiEditMode;$('#aiEditMode').onchange=e=>{aiEditMode=e.target.value;render()}};if($('#githubResearch'))$('#githubResearch').onchange=e=>githubResearch=e.target.checked;$('#prompt').value=draft;$('#prompt').oninput=e=>{draft=e.target.value;send('draft',{text:draft})};$('#profileSelect').onchange=e=>{if(e.target.value==='__new__'){editProfile=null;detectedModels=[];page='settings';render();return;}profileId=e.target.value;render()};if($('#includeCode'))$('#includeCode').onchange=e=>includeCode=e.target.checked;}
function newChat(){if(busy){notice('请等待当前请求结束');return}const c={id:uuid(),name:'新对话',projectId:projectId||'',messages:[],created:Date.now()};S.chats.push(c);chatId=c.id;saveChat();render()}
function sendMessage(){if(busy)return;const p=selectedProfile();if(!p||(!p.hasKey&&p.protocol!=='local')){notice('请先保存模型配置和 API Key');return}if(!draft.trim())return;const text=draft.trim();if(text.length>(modelLimits(p).official?modelLimits(p).chars:80000)){notice('消息超过本机传输限制，请分段发送');return}const createProject=Neo.wantsNewProject(text);if(createProject){projectId=null;chatId=null;newChat();}else if(!chat()||(chat().projectId||null)!==projectId)newChat();const c=chat(),target=project();if(!c.messages.length)c.name=text.slice(0,24);c.messages.push({role:'user',content:text});saveChat(c);draft='';send('draft',{text:''});busy=true;send('send',{createProject,profileId:p.id,chatId:c.id,projectId:target?.id||'',projectContext:!!target,githubResearch,editMode:target&&aiEditMode!=='discuss'?aiEditMode:'',messages:c.messages.map(m=>({role:m.role,content:m.content})),system:p.system||'你是一位中文编程助手。不要假装已经运行程序。'});render()}

const presets=[['自定义兼容接口','https://','compatible',''],['DeepSeek','https://api.deepseek.com','compatible','deepseek-flash'],['阶跃星辰','https://api.stepfun.com/v1','compatible',''],['通义千问（兼容模式）','https://dashscope.aliyuncs.com/compatible-mode/v1','compatible','qwen-plus'],['Anthropic','https://api.anthropic.com/v1','anthropic','']];
function settings(){app.innerHTML=`<div class="page"><button data-art="settings">绘图 API 与美术资源</button>${header('CONNECT','模型与 API','密钥加密保存在手机，不提供给 Studio 网页或项目导出。')}<div class="row">${S.profiles.filter(p=>p.protocol!=='local').map(p=>`<button data-a="editProfile" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}<button data-a="freshProfile">＋ 新配置</button></div><div class="card"><label for="preset">快速填写服务商</label><select id="preset">${presets.map((x,i)=>`<option value="${i}">${x[0]}</option>`).join('')}</select><label for="pname">配置名称</label><input id="pname" maxlength="60" placeholder="我的模型"><label for="endpoint">Base URL 或完整请求地址</label><input id="endpoint" type="url" placeholder="https://api.example.com/v1" autocapitalize="off"><label for="protocol">接口协议</label><select id="protocol"><option value="compatible">Chat Completions 兼容协议</option><option value="anthropic">Anthropic Messages</option></select><button id="detectButton" data-a="detectModels" style="margin-top:12px">保存并检测模型</button><div id="modelPicker">${detectedModels.length?`<label for="modelSearch">搜索检出的模型（${detectedModels.length}）</label><input id="modelSearch" placeholder="输入关键词"><select id="detectedModel" aria-label="检测到的模型"><option value="">选择模型…</option>${detectedModels.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('')}</select>`:''}</div><label for="model">模型 ID（以服务商账户为准）</label><input id="model" autocapitalize="off" placeholder="填写模型标识"><label for="key">API Key</label><input id="key" type="password" autocomplete="off" placeholder="新密钥；编辑时留空保留"><p id="keyhint" class="keyhint"></p><p id="contextLimit" class="muted"></p><label for="maxTokens">单次最大输出 token</label><input id="maxTokens" type="number" value="4096" min="64" max="32768"><label class="setting-switch"><input id="streaming" type="checkbox" checked>实时显示生成内容（接口需支持流式响应）</label><label for="thinking">推理模式（DeepSeek 等支持该参数的兼容接口）</label><select id="thinking"><option value="">服务商默认</option><option value="disabled">关闭推理，直接输出</option><option value="enabled">开启推理</option></select><label for="system">系统提示词</label><textarea id="system" rows="3" placeholder="你是一位中文编程助手…"></textarea><div class="row" style="margin-top:16px"><button class="primary" data-a="saveProfile">保存配置</button><button data-a="testProfile">保存并测试</button>${editProfile?'<button class="danger" data-a="deleteProfile">删除配置</button>':''}</div></div><div class="noticebar">使用 API 会按服务商规则计费。“测试”也会发起一次短请求。这里配置的模型只用于本地 AI 助手，不会替换官方 Studio 的后端模型。支持项目开发工具与官方连接器说明查询；暂不支持 Responses 协议。生成图片请在独立的“绘图 API”中配置。</div><button data-a="ai">返回 AI 助手</button></div>`;const p=S.profiles.find(x=>x.id===editProfile);if(p){for(const k of ['name','endpoint','protocol','model','maxTokens','thinking','system'])$(k==='name'?'#pname':'#'+k).value=p[k]??'';$('#keyhint').textContent=p.hasKey?'已保存密钥，留空即可保留':'尚未保存密钥'}$('#streaming').checked=p?.streaming!==false;$('#endpoint').addEventListener('input',refreshModelLimits);$('#model').addEventListener('input',refreshModelLimits);refreshModelLimits();if($('#detectedModel'))$('#detectedModel').onchange=e=>{if(e.target.value){$('#model').value=e.target.value;refreshModelLimits()}};if($('#modelSearch'))$('#modelSearch').oninput=e=>{const q=e.target.value.toLowerCase();$('#detectedModel').innerHTML='<option value="">选择模型…</option>'+detectedModels.filter(m=>m.toLowerCase().includes(q)).map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('')};$('#preset').onchange=e=>{const x=presets[e.target.value];$('#pname').value=x[0];$('#endpoint').value=x[1];$('#protocol').value=x[2];$('#model').value=x[3];refreshModelLimits();$('#key').value='';if(editProfile){editProfile=null;$('#keyhint').textContent='将保存为新配置，不沿用原服务商密钥'}};}
function saveProfile(next=''){const p={id:editProfile||uuid(),name:$('#pname').value.trim(),endpoint:$('#endpoint').value.trim(),protocol:$('#protocol').value,model:$('#model').value.trim(),key:$('#key').value.trim(),maxTokens:Number($('#maxTokens').value),system:$('#system').value,streaming:$('#streaming').checked,thinking:$('#thinking').value,next};if(!p.name||!p.endpoint||(!p.model&&next!=='detect')){notice('请填写名称、接口地址和模型 ID；也可先检测模型');return false}if(!Number.isInteger(p.maxTokens)||p.maxTokens<64||p.maxTokens>modelLimits(p).output){notice('最大输出应在 64–'+modelLimits(p).output+' 之间');return false}send('profile',p);return true;}

function help(){app.innerHTML=`<div class="page"><p class="muted">StepX Studio · scsxrkj.com.cn</p><div class="card"><h2>版本更新</h2><p>可选功能：自动检查 GitHub 上的新版本并下载安装。更新仓库是公开的，无需令牌。不联网时可以直接安装新版 APK 覆盖升级。</p><button data-a="checkUpdates">检查更新</button></div><div class="card"><h2>AI 开关与云端项目</h2><p>在本地项目页“功能与显示设置”或右上角更多菜单开关 AI 助手，关闭后底部入口隐藏，配置和对话保留。</p><p>“同步云端项目”选择 Studio 项目下载源码；编辑器“同步到本地”更新已关联项目，“上传项目”将本地文件写回云端。首次上传新建云端项目，之后继续同一项目。两边同时修改同一文件时停止覆盖。</p><p>保留子目录和二进制资源，排除依赖、构建产物、凭据和签名材料；上限 300 个文件、单文件 1 MB、合计 4 MB。上传不删除云端其他文件；中断显示部分完成。支持内置依赖范围内的前端源码本机编译与运行；其他依赖及任意 npm 脚本需外部环境。</p></div><div class="card"><h2>官方 Studio</h2><p>底部 Studio 打开官方网页，登录后使用应用、智能体和技能构建。右上角菜单提供刷新、前进、桌面模式、缩放、查找、下载列表和专注模式。</p><p>网站功能、模型和云端构建由官方提供。本客户端无法替换其服务端模型。Token 页可检查当前项目的官方历史返回字段；字段缺失时会显示原因，不用 0 冒充用量。</p></div><div class="card"><h2>本地项目</h2><p>新建后直接编辑 HTML / CSS / JS。草稿保存在应用私有目录；运行可检查界面和 JavaScript 错误；导出 ZIP 后可继续在 Mac 上开发。</p><p>预览会编译支持的前端源码，默认断网；可手动开启 HTTPS 网络，文件与设备权限不开放。导入支持最多 40 个根目录文本文件、总大小 2 MB，须含 index.html；支持通过预编译运行壳离线封装 APK，不包含 npm 或任意 Kotlin/Gradle 工程编译器。</p><p>应用卸载会删除本地资料，请定期导出项目和对话。项目支持长按菜单、左滑删除；确认后移到最近删除，可恢复或另行彻底删除。云端项目、已导出文件、已安装App及Token账本保留。</p></div><div class="card"><h2>构建与调试</h2><p>编辑器中选择本机离线或 Step 云端路径。生成 APK 后须按系统提示安装；运行 App 的菜单可开启调试、查看和回传报告。每次调用已有 AI 配置都会原生确认。卸载 StepX Studio 会丢失本机签名密钥，无法直接更新此前生成的 App。</p></div><div class="card"><h2>官方构建 vs 本地构建</h2><p><b>官方 Studio 打的包是预览版</b>：运行时从 studio-api.stepx.com 拉内容。手机断网会显示「AI App 加载失败 / ERR_CONNECTION_ABORTED」，官方服务器故障会显示「503 Service Temporarily Unavailable」。包名以 <code>com.stepx.aiapp.</code> 开头。</p><p><b>本工作台打的包把页面全部装进 APK</b>：通过虚拟域名 app.neo.local 直接从安装包读文件，全程不联网。断网照常运行。包名以 <code>com.scsxrkj.app.</code> 开头，或构建时你填的自定义包名。</p><p>同样断网实测：官方包 4.9~5.8 MB，只剩错误页和「重试」按钮；本地包 73 KB，页面和按钮全部正常。</p><p>要做出能离线用的 App：在官方 Studio 把项目做出来，用「同步云端项目 ↓」拉到本地，再用本机离线构建出包。<b>不要用官方那边的「导出 APK / 安装到手机」</b>，那是预览版。</p></div><div class="card"><h2>项目协作</h2><p>编辑器的“项目协作”可管理共享目标、任务、Step 上下文和外部 AI 结果。先关联具体 Studio 项目，再交接草稿或导入页面文字。代码 ZIP 与 AI 文件建议都需逐文件审查；应用前保存快照。</p><p>共享上下文可预览和导出。切换不同 API 模型可按规划、实现、审查顺序接力；自动联动可在前台完成模型规划 → Studio 开发 → 模型审查，最多 1–3 轮；已有草稿、切换项目、离开应用或异常会停止。云端与本地通过明确交接同步，没有自动双向文件锁或后台合并。</p></div><div class="card"><h2>Amoo 与显示</h2><p>项目协作中的“交给 Amoo”会先预览任务，再打开 Amoo 分享入口；请在 Amoo 核对并发送。执行结果经人工核对后填回项目，尚无后台自动执行或自动回调。</p><p>本地项目页底部可选择标准玻璃、降低透明度或增强对比度。本地界面采用阶跃 AI 的炭黑、灰色与橙色方向，并参考 Apple Liquid Glass 的层级与材质原则，未使用 Apple UI 框架或图形资源。</p></div><div class="card"><h2>AI 与 Token</h2><p>设置 HTTPS 接口、模型 ID 和密钥，可保存多个配置。在 AI 助手选择本地项目，可直接修改、先审查或只讨论。每轮从本机读取全部最新文件；自动保存前验证目标和修改基线，只保留上一版快照（可回退一步）。失败、截断和文件冲突不会写入。</p><p>发送过程中保持应用打开。输出上限默认 4096。官方 DeepSeek 支持 1,048,576 Token 上下文、最高 393,216 Token 输出；其他接口最高可设 32768，以对应模型能力为准。上下文包括输入与输出预留。API 错误会显示 HTTP 状态，不自动重试或转发密钥。</p><p>用量来自服务商返回字段：兼容接口输入与输出相加；Anthropic 输入包含缓存读取与缓存写入。账本自动汇总已记录的全部项目；Step API、Studio 和第三方 API 分开计算。Studio 取各项目最新已读取报告，没有报告或 usage 时标为未知。</p></div><button data-a="projects">返回项目</button><div class="card"><h2>来源与许可</h2><p>本工具基于公开的 STEPX Neo 社区实践整理改进。设备端签名使用 apksig-android 4.4.0（Apache 2.0），端侧模型运行时使用 Google LiteRT-LM 0.18.0（Apache 2.0），内置前端依赖各自遵循其原许可。完整许可全文随安装包分发。</p><button data-a="license">查看第三方许可</button></div><div class="card"><h2>按钮说明提示</h2><p>第一次点某个功能按钮时，会先弹一段说明讲清楚它做什么。如果之前勾了「不再提示」，可以在这里恢复。</p><button data-a="resetExplains">重置所有按钮说明</button><p id="explainResetResult" class="muted"></p></div></div>`}

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
  importProject:['导入 HTML / ZIP',
    '把外面做好的网页项目搬进本应用。\n\n'+
    '· 选 .zip 压缩包\n  解出里面的多个文件（html / css / js），当成一个完整的多文件项目\n\n'+
    '· 选单个 .html 文件\n  只有一个页面，当成单页项目\n\n'+
    '两种情况都必须含 index.html，否则拒绝导入，因为生成的 App 一启动就是找它来显示的。\n'+
    '总大小上限 2 MB。导入成功后出现在「本地项目」列表里。'],
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
    '把云端上的项目下载到本地，变成一个可以编辑的本地项目。'],
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
  card.style.cssText='background:#2b2b2e;border:1px solid rgba(255,255,255,.10);border-radius:18px;'+
    'padding:22px 20px;max-width:460px;width:100%;color:#ededf0;box-shadow:0 18px 60px rgba(0,0,0,.55);'+
    'max-height:84vh;overflow:auto';
  const btnStyle='flex:1;height:44px;border-radius:11px;font-size:15px;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:transparent;color:#b8b8c0';
  const okStyle='flex:1;height:44px;border-radius:11px;font-size:15px;font-weight:700;cursor:pointer;border:0;background:#ff8a5b;color:#231a16';
  card.innerHTML=
    '<div style="font-size:17px;font-weight:700;color:#ff8a5b;margin-bottom:12px">'+esc(title)+'</div>'+
    '<div style="font-size:14px;line-height:1.75;white-space:pre-wrap;color:#d8d8de">'+esc(body)+'</div>'+
    '<label style="display:flex;align-items:center;gap:9px;margin-top:18px;font-size:13px;color:#9a9aa4;cursor:pointer">'+
      '<input type="checkbox" id="expSkip" style="width:17px;height:17px;accent-color:#ff8a5b">这个按钮的说明不再提示</label>'+
    '<div style="display:flex;gap:10px;margin-top:18px">'+
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
    btn.click();
  };
}

app.addEventListener('click',e=>{const b=e.target.closest('[data-a]');if(!b)return;const a=b.dataset.a,id=b.dataset.id;if(explainGuard(a,b))return;const p=project(),c=chat();if(['projects','trash','settings','ai','usage','help','localModels'].includes(a)){page=a;render();return}switch(a){case 'cloudRelay':if(!id)saveProject();send('cloudRelay',{id:id||p.id});break;case 'cloudUploadAll':send('cloudUploadAll');break;case 'cloudCancel':send('cloudCancel');break;case 'resetExplains':{let n=0;try{const keys=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.indexOf('explainSeen:')===0)keys.push(k)}keys.forEach(k=>localStorage.removeItem(k));n=keys.length;}catch(e){}const r=document.querySelector('#explainResetResult');if(r)r.textContent=n?('已重置 '+n+' 个按钮，下次点击会重新显示说明'):'当前没有勾过「不再提示」的按钮';break}case 'cloudList':send('cloudList');break;case 'cloudPull':send('cloudPull',{id:p.id});break;case 'cloudUpload':if(!id)saveProject();send('cloudUpload',{id:id||p.id});break;case 'checkUpdates':send('checkUpdates');break;case 'newProject':newProject();break;case 'importProject':send('importProject');break;case 'studio':send('studio');break;case 'openProject':projectId=id;file='index.html';undo=[];redo=[];page='editor';render();break;case 'projectList':page='projects';render();break;case 'file':file=id;undo=[];redo=[];render();break;case 'preview':saveProject();send('localRun',{id:p.id});break;case 'exportProject':saveProject();send('exportProject',p);break;case 'renameProject':{let n=prompt('项目名称',p.name);if(n){p.name=n.slice(0,60);saveProject();render()}break}case 'projectMenu':send('projectMenu',{id});break;case 'deleteProject':send('projectTrash',{id:id||p?.id});break;case 'restoreProject':send('projectRestore',{id});break;case 'purgeProject':send('projectPurge',{id});break;case 'addFile':{let n=prompt('根目录文本文件名，例如 utils.js');if(!n)return;if(!(p.cloudSource?validSourcePath(n):/^[\p{L}\p{N}_-][\p{L}\p{N} ._-]{0,99}$/u.test(n)&&!n.includes('..'))||p.files[n]!=null||p.binaryFiles?.[n]!=null){notice('文件名无效或已存在');return}p.files[n]='';file=n;saveProject();render();break}case 'deleteFile':if(file==='index.html'&&!p.cloudSource){notice('请保留项目入口 index.html');break}if(confirm('删除 '+file+'？')){delete p.files[file];file='index.html';saveProject();render()}break;case 'indent':insert('  ');break;case 'undo':if(undo.length){redo.push(p.files[file]);p.files[file]=undo.pop();saveProject();$('#code').value=p.files[file]}break;case 'redo':if(redo.length){undo.push(p.files[file]);p.files[file]=redo.pop();saveProject();$('#code').value=p.files[file]}break;case 'findCode':{let q=prompt('查找文字');if(q){const t=$('#code'),pos=t.value.indexOf(q,t.selectionEnd);let at=pos>=0?pos:t.value.indexOf(q);if(at>=0){t.focus();t.setSelectionRange(at,at+q.length)}else notice('未找到')}break}case 'copyCode':send('copy',{text:p.files[file]});break;case 'aiCode':page='ai';includeCode=true;render();break;case 'chatHistory':openChatHistory();break;case 'newChat':newChat();break;case 'send':sendMessage();break;case 'cancel':send('cancel');break;case 'exportChat':if(c)send('exportText',{name:'neo-conversation.md',text:'# '+c.name+'\n\n'+c.messages.map(m=>'## '+(m.role==='user'?'我':'AI')+'\n\n'+m.content).join('\n\n')});break;case 'deleteChat':requestChatDeletion(c?[c.id]:[]);break;case 'copyMessage':send('copy',{text:c.messages[+id].content});break;case 'reviewAiFiles':{const edit=c.messages[+id].edit;if(!S.projects.some(x=>x.id===edit.projectId)){notice('原目标项目不存在');break}projectId=edit.projectId;candidateProjectId=edit.projectId;candidateBase=edit.base;candidateFiles=edit.files;candidateSource='AI 助手';page='review';render();break}case 'applyHtml':{const m=c.messages[+id].content.match(/```(?:html)?\s*\n([\s\S]*?)```/i);if(m&&confirm('把此代码另存为新项目？原项目保留。'))newProject(m[1]);break}case 'freshProfile':editProfile=null;detectedModels=[];settings();break;case 'editProfile':editProfile=id;detectedModels=[];settings();break;case 'saveProfile':saveProfile('');break;case 'testProfile':if(confirm('保存配置并发送一次简短测试请求？服务商可能计费。'))saveProfile('test');break;case 'detectModels':saveProfile('detect');break;case 'deleteProfile':if(confirm('删除此配置及加密密钥？')){send('delete',{list:'profiles',id:editProfile});S.profiles=S.profiles.filter(x=>x.id!==editProfile);editProfile=null;settings()}break;case 'today':usageScope='today';usage();break;case 'allUsage':usageScope='all';usage();break;case 'usageExport':send('usageExport');break;}});
render();

app.addEventListener("click",async e=>{if(e.target.closest("[data-a=license]")){const text=await (await fetch("licenses-apksig.txt")).text();app.innerHTML=`<div class="page"><button data-a="help">‹ 使用说明</button><h1>apksig-android 4.4.0</h1><pre class="contextPreview">${esc(text)}</pre></div>`}});

try{document.documentElement.dataset.appearance=Neo.appearance()||'glass'}catch{}
send('appearance',{value:document.documentElement.dataset.appearance||'glass'});
app.addEventListener('change',e=>{if(e.target.id==='appearanceSelect'){document.documentElement.dataset.appearance=e.target.value;send('appearance',{value:e.target.value});try{localStorage.setItem('neo-appearance',e.target.value)}catch{}}});

function validSourcePath(p){return p.length>0&&p.length<=240&&!/[\\\x00-\x1f\x7f]/.test(p)&&!p.startsWith('/')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');}
function cloudControls(p){const c=p.cloud,bin=Object.keys(p.binaryFiles||{});return `<div class="cloud-controls"><div class="row"><button class="primary" data-a="cloudRelay" ${window.cloudRelayState?.status==='syncing'?'disabled':''}>云端接力开发 ↗</button><button data-a="cloudUpload">上传项目 ↑</button>${c?'<button data-a="cloudPull">同步到本地 ↓</button>':''}<details class="cloud-status"><summary>同步详情</summary><div class="cloud-info">${c?`<small>云端：${esc(c.name)}<br>${esc(c.message||'已关联')}</small>`:'<small>接力会同步源码与资源、打开同一 Studio 项目并准备草稿。首次接力自动创建并关联项目。</small>'}${p.cloudSource?'<small>云端源码 · 可在本机编译运行前端，也可交给 Studio。</small>':''}${c?.skipped?.length?`<small>已排除 ${c.skipped.length} 项</small><pre>${esc(c.skipped.join('\n'))}</pre>`:''}${bin.length?`<small>${bin.length} 个二进制资源（同步和 ZIP 导出保留）</small><pre>${esc(bin.join('\n'))}</pre>`:''}</div></details></div></div>`;}

function cloudBatchCard(){const b=S.cloudBatch;if(!b?.items?.length)return '';const labels={waiting:'等待',running:'上传中',done:'完成',failed:'失败',stopped:'已停止',interrupted:'已中断'};return `<details class="card cloud-batch" ${b.running?'open':''}><summary>上传同步 · ${b.items.filter(x=>x.status==='done').length}/${b.items.length} 完成${b.running?' · 进行中':''}</summary>${b.items.map(x=>`<div class="sync-result"><strong>${esc(x.name)}</strong><span>${labels[x.status]||esc(x.status)}</span><small>${esc(x.message||'')}</small></div>`).join('')}${b.running?'<button data-a="cloudCancel">停止后续上传</button>':'<small>可单独重试失败项目；再次同步只上传变化，不删除云端文件。</small>'}</details>`;}
