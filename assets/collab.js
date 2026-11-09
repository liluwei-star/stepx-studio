/*
 * collab.js —— 项目协作页的脚本
 * ================================================================
 *
 * 这个文件负责「项目协作」页：把项目交给 AI 拆分任务、逐个执行，
 * 以及构建出包、和官方 Studio 双向交接。
 *
 * ── 本文件里所有按钮（data-a 动作）的含义 ──────────────────────────
 *
 * 【页面导航】
 *   backCollab          从子页面返回协作主页
 *   backEditor          返回项目编辑器
 *
 * 【任务与自动联动】
 *   addTask             给项目添加一条待办任务
 *   runProjectTask      立刻执行某一条任务（把任务内容发给 AI）
 *   startAuto           开始自动联动：AI 自动连续执行多步，不用一步步点
 *   stopAuto            停止自动联动
 *   cancel              取消当前正在跑的任务
 *
 * 【构建出包】
 *   buildOffline        在本机构建 APK。会弹出选项让你填自定义包名、
 *                       勾选是否用「最小权限」模板（只声明联网权限，适合上架）
 *   buildInstall        构建完直接装到这台手机上
 *   exportApk           把构建好的 APK 导出到手机存储，用于发给别人或上架
 *   installApk          安装某一条历史构建
 *   importDebug         导入生成的 App 回传的调试报告 JSON
 *
 * 【AI 结果审查】
 *   reviewReply         审查 AI 这次回复，看它改了什么
 *   importChanges       把 AI 建议的改动导入项目
 *   applyCandidate      应用一批候选文件（通常是导入时 AI 分拣的结果）
 *   restoreSnapshot     把项目回滚到上一版快照
 *   copyResult          复制 AI 的输出结果
 *   exportContext       把当前项目上下文导出成文件，方便交给外部 AI
 *
 * 【官方 Studio 协作】
 *   linkStudio          把本地项目关联到官方 Studio 的某个项目页面
 *   captureStudio       抓取官方 Studio 页面上可见的文字，存成项目上下文
 *   handoffStep         把本地内容填进官方 Studio 的输入框（只填不发送）
 *   openStudioProject   打开关联的官方 Studio 项目页
 *   handoffAmoo         把任务交给 Amoo（系统 AI 启动器）去执行
 *
 * 【其他】
 *   settings            打开设置
 *
 * ================================================================
 */
'use strict';
let buildBusy=false;
let candidateBase=null,candidateProjectId=null;
let selectedTaskId=null,candidateFiles=null,candidateSource='',collabIncludeCode=true,collabRole='implement';
function initProject(p){if(!p.tasks)p.tasks=[];if(!p.history)p.history=[];if(!p.brief)p.brief='';if(!p.stepNotes)p.stepNotes='';if(!p.amooNotes)p.amooNotes='';return p}
function currentTask(){return project()?.tasks?.find(x=>x.id===selectedTaskId)}
function projectContext(task,includeFiles=collabIncludeCode){const p=initProject(project());let t='# 共享项目：'+p.name+'\n\n## 项目说明\n'+(p.brief||'未填写')+'\n\n## 当前任务\n'+(task||currentTask()?.text||'请继续完善此项目')+'\n\n## 任务列表\n'+p.tasks.map(x=>'- ['+x.status+'] '+x.text).join('\n');if(p.stepNotes.trim())t+='\n\n## 从 Studio 导入的上下文（人工核对）\n'+p.stepNotes.slice(0,30000);if(p.debugReports?.length)t+='\n\n## 最近调试报告（实际回传，仍需核对）\n'+JSON.stringify(p.debugReports.slice(-3));if(p.amooNotes.trim())t+='\n\n## Amoo 执行结果（人工核对）\n'+p.amooNotes.slice(0,15000);const h=p.history.filter(x=>x.type==='api').slice(-3);if(h.length)t+='\n\n## 其他 AI 的最近工作\n'+h.map(x=>'### '+x.provider+'\n'+x.text.slice(0,12000)).join('\n');if(includeFiles)t+='\n\n## 本地当前文件（作为本轮修改基线）\n'+Object.keys(p.files).map(n=>'### '+n+'\n```\n'+currentContent(p,n)+'\n```').join('\n');return t;}
function collaboration(){const p=project();if(!p){page='projects';render();return}initProject(p);if(!p.tasks.some(x=>x.id===selectedTaskId))selectedTaskId=p.tasks[0]?.id||null;const task=currentTask(),profile=selectedProfile();app.innerHTML=`<div class="page"><div class="row"><button data-a="backEditor">‹ 编辑</button><strong class="grow">${esc(p.name)}</strong></div>${autoCard(p)}<details class="card"><summary>共享上下文与交接记录</summary><label for="brief">项目目标与约定</label><textarea id="brief" rows="2" placeholder="用途、目标用户、界面偏好、验收条件…">${esc(p.brief)}</textarea><label for="stepNotes">Step 项目上下文 / 交接结果</label><textarea id="stepNotes" rows="3" placeholder="导入或粘贴 Step 的方案、进度和反馈，再核对内容。">${esc(p.stepNotes)}</textarea><small>修改自动保存。每次发给 AI 的内容可在下方预览。</small></details><div class="card"><div class="row spread"><h2>Studio 项目</h2><span class="tag">${p.studioUrl?'已关联':'尚未关联'}</span></div><p class="muted mono">${p.studioUrl?esc(p.studioUrl):'先在 Studio 打开具体项目，再关联链接。'}</p><div class="row"><button data-a="linkStudio">关联项目</button><button data-a="openStudioProject">打开 Studio</button><button data-a="captureStudio">导入页面文字</button><button data-a="importChanges">导入代码 ZIP</button></div><small>网页与本地文件通过交接更新，不会自动覆盖彼此。</small></div><div class="card"><div class="row spread"><h2>共同任务</h2><button data-a="addTask">＋ 任务</button></div>${p.tasks.length?`<select id="taskSelect" aria-label="协作任务">${p.tasks.map(t=>`<option value="${esc(t.id)}" ${t.id===selectedTaskId?'selected':''}>${esc(t.text.slice(0,55))}</option>`).join('')}</select><p>${esc(task?.text)}</p><label for="taskStatus">项目中的任务状态（人工确认）</label><select id="taskStatus"><option value="todo">待处理</option><option value="doing">处理中</option><option value="review">待审查</option><option value="done">已验收</option></select>`:'<p class="muted">把大目标拆成任务，在 StepX Studio 中协同规划、实现与检查，接着上一次结果继续。</p>'}<label><input id="collabCode" type="checkbox" ${collabIncludeCode?'checked':''}>交接时附上当前项目全部文本文件</label><details><summary>预览将共享的上下文</summary><pre class="contextPreview">${esc(projectContext(task?.text))}</pre></details><div class="row"><button class="primary" data-a="handoffStep" ${!task?'disabled':''}>交给 Step · 填入草稿</button><button data-a="exportContext">导出交接文档</button></div></div><details class="card"><summary>Amoo · 手机执行</summary><p>把当前任务交给手机 Amoo。先核对范围，再在 Amoo 会话中发送；手机能力和授权由 Amoo 提供。</p><button class="primary" data-a="handoffAmoo" ${!task?'disabled':''}>交给 Amoo 执行</button><label for="amooNotes">Amoo 结果 · 粘贴后核对</label><textarea id="amooNotes" rows="3" placeholder="将 Amoo 的回执粘贴到这里，供 Step 和其他 AI 继续处理。">${esc(p.amooNotes)}</textarea><small>不自动获取聊天记录，不统计 Amoo 内部 Token。</small></details><div class="card"><h2>交给外部 AI</h2><label for="collabProfile">执行模型</label><select id="collabProfile">${S.profiles.map(x=>`<option value="${esc(x.id)}" ${profile?.id===x.id?'selected':''}>${esc(x.name)} · ${esc(x.model)}</option>`).join('')||'<option>请先添加 API</option>'}</select><label for="collabRole">本轮职责</label><select id="collabRole"><option value="implement">实现任务 · 直接修改本地项目</option><option value="plan">规划 · 拆分方案和验收条件</option><option value="review">审查 · 检查代码和风险</option></select><p class="muted">会发送共享说明、所选任务、Step 上下文和最近三轮 AI 结果。不会发送密钥或其他项目。</p><div class="row"><button class="primary" data-a="runProjectTask" ${busy||!task||!profile?'disabled':''}>${busy?'正在处理…':'开始本轮协作'}</button><button data-a="settings">模型设置</button>${busy?'<button data-a="cancel">取消</button>':''}</div></div><h2>协作记录</h2>${p.history.slice(-12).reverse().map((h,i)=>`<div class="card"><div class="row spread"><strong>${h.type==='api'?esc(h.provider):h.type==='apply'?'已应用文件修改':h.type==='restore'?'已恢复快照':h.type==='amoo-handoff'?'Amoo 任务交接':'Step 交接'}</strong><small>${new Date(h.time).toLocaleString()}</small></div><pre class="contextPreview">${esc(h.text)}</pre>${h.type==='api'&&!['applied','unchanged'].includes(h.editStatus)?`<div class="row"><button data-a="reviewReply" data-id="${p.history.length-1-i}">审查文件建议</button><button data-a="copyResult" data-id="${p.history.length-1-i}">复制结果</button></div>`:''}</div>`).join('')||'<p class="muted">每轮 API 结果、Step 交接草稿和文件应用都会记录在这里。</p>'}${p.snapshots?.length?'<button data-a="restoreSnapshot">恢复上次应用前的文件</button>':''}<div class="noticebar">填入 Studio 草稿不代表已发送、构建或同步成功。实现任务自动写入指定本地项目并保存快照，冲突时保留原文件；任务“已验收”由你确认。</div></div>`;if($('#autoTask'))$('#autoTask').oninput=e=>{p.autoDraft=e.target.value;saveProject()};if($('#autoRounds'))$('#autoRounds').onchange=e=>{p.autoRounds=+e.target.value;saveProject()};if($('#autoProfile'))$('#autoProfile').onchange=e=>{p.autoProfile=e.target.value;saveProject()};$('#amooNotes').oninput=e=>{p.amooNotes=e.target.value;saveProject()};$('#brief').oninput=e=>{p.brief=e.target.value;saveProject()};$('#stepNotes').oninput=e=>{p.stepNotes=e.target.value;saveProject()};if($('#taskSelect'))$('#taskSelect').onchange=e=>{selectedTaskId=e.target.value;collaboration()};if($('#taskStatus')){$('#taskStatus').value=task.status;$('#taskStatus').onchange=e=>{task.status=e.target.value;saveProject()}}$('#collabCode').onchange=e=>{collabIncludeCode=e.target.checked;collaboration()};$('#collabProfile').onchange=e=>profileId=e.target.value;$('#collabRole').value=collabRole;$('#collabRole').onchange=e=>collabRole=e.target.value;}
function runProjectTask(){if(busy)return;const p=initProject(project()),t=currentTask(),m=selectedProfile();if(!t||!m?.hasKey){notice('先建立任务并配置带密钥的模型');return}let context=projectContext(t.text,collabRole==='implement'?false:collabIncludeCode);if(context.length>modelLimits(m).chars){notice('共享内容过长，请精简 Step 上下文或取消附加全部代码');return}let instruction=collabRole==='implement'?'你正在与 Step Studio 及其他 AI 共同开发项目。根据当前文件完成所选任务。只返回一个 JSON 对象，格式为 {"summary":"修改说明","files":{"文件名":"完整文件内容"}}。只列出需要新增或修改的根目录文本文件。不要删除文件，不要输出占位代码，不要执行命令。':collabRole==='review'?'你负责审查这个共享项目。结合任务、Step 方案和代码，指出具体问题、优先级及验收步骤。不要声称测试已通过。':'你负责这个共享项目的技术规划。结合现有文件和其他 AI 的结果，给出最小实现方案、任务顺序和可检查的验收条件。';const c={id:uuid(),name:'项目协作 · '+t.text.slice(0,20),projectId:p.id,taskId:t.id,messages:[{role:'user',content:context}],created:Date.now()};S.chats.push(c);saveChat(c);t.status='doing';saveProject();busy=true;send('send',{profileId:m.id,chatId:c.id,projectId:p.id,taskId:t.id,projectContext:collabRole==='implement',editMode:collabRole==='implement'?'auto':'',system:instruction,messages:c.messages});collaboration();}
function parseCandidate(text){let raw=text.trim();const block=raw.match(/```(?:json)?\s*\n([\s\S]*?)```/i);if(block)raw=block[1].trim();try{const x=JSON.parse(raw);if(x.files&&typeof x.files==='object'&&!Array.isArray(x.files))return x.files;}catch{}const html=text.match(/```html\s*\n([\s\S]*?)```/i);if(html)return {'index.html':html[1]};return null;}
function reviewChanges(){const p=project();if(!p||p.id!==candidateProjectId||!candidateFiles){page='collab';render();return}const entries=Object.entries(candidateFiles);/*
 * 哪些文件可以进审查列表。
 *
 * <p><b>这条规则必须和原生 ProjectEdits.validate 一致。</b>
 * 原来这里只认根目录、扩展名只有 html|css|js|json|md|txt|svg ——
 * 一个 React + TSX 工程里 AI 改的恰恰是 {@code src/App.tsx}：
 * 路径含 / 被过滤、扩展名 tsx 不在白名单，
 * 于是<b>所有改动都被筛掉</b>，页面只说一句「没有可应用的根目录文本文件」。
 * 用户看到的现象是「AI 说改好了、审查页是空的」，而后端其实完全接受这些文件。
 *
 * <p>所以放宽到后端同一套：允许子目录，扩展名补 ts/tsx/jsx/mjs，
 * 仍然拒绝 .. 、绝对路径和二进制后缀。
 */
const REVIEW_EXT=/\.(html|css|js|jsx|mjs|ts|tsx|json|md|txt|svg)$/i;
function reviewablePath(n){
  if(typeof n!=='string'||!n||n.length>240)return false;
  if(n.startsWith('/')||n.includes('..')||n.includes('\\'))return false;
  /* 每段都要有内容，不能有空段（和 CloudFiles.path 一致） */
  for(const seg of n.split('/'))if(!seg||seg==='.'||seg==='..')return false;
  return REVIEW_EXT.test(n);
}
const valid=entries.filter(([n,c])=>(typeof c==='string'||c===null)&&reviewablePath(n));if(!valid.length){notice('没有可应用的根目录文本文件');page='collab';render();return}app.innerHTML=`<div class="page"><button data-a="backCollab">‹ 协作项目</button><p class="muted">来源：${esc(candidateSource)}。只更新勾选的文件，未列出的文件保留。</p>${valid.map(([n,c],i)=>`<div class="card"><label><input type="checkbox" class="candidateCheck" data-name="${esc(n)}" checked>${esc(n)} · ${c===null?'删除':!(n in p.files)?'新增':currentContent(p,n)===c?'没有变化':'修改'}</label><div class="split"><div><small>当前文件</small><pre class="diffText">${esc(currentContent(p,n))}</pre></div><div><small>修改建议</small><pre class="diffText">${esc(c)}</pre></div></div></div>`).join('')}<div class="row"><button class="primary" data-a="applyCandidate">应用勾选的文件</button><button data-a="backCollab">保留现状</button></div><div class="noticebar">应用前保留文件快照，可在协作页面恢复。应用后请运行预览或完成实际构建验收。</div></div>`;}
function applyCandidate(){const p=project(),names=[...document.querySelectorAll('.candidateCheck:checked')].map(x=>x.dataset.name);if(!p||p.id!==candidateProjectId||!candidateBase){notice('没有绑定修改基线，请重新生成建议');return}if(!names.length)return;if(!confirm('应用到“'+p.name+'”的 '+names.length+' 个文件？将保留快照。'))return;
  /*
   * 先把编辑暂存落盘，再提交改动。
   *
   * <p>原生的冲突检测是 {@code same(项目当前文件, base)}。candidateBase 走的是
   * currentContent（含编辑暂存），而项目当前文件只反映**已落盘**内容。
   * 用户刚在编辑器里敲过字、还没触发保存时，两者会差一个暂存区 ——
   * 检测于是报「文件已变化」，可用户明明没改过别的，只能一脸困惑地重新生成建议。
   *
   * <p>先落盘，让「项目当前文件」追上「用户看到的内容」，
   * 冲突检测才是在比真正该比的两样东西。
   */
  try{saveProject();}catch(e){notice('保存编辑内容失败，未应用改动：'+(e&&e.message||e));return}
  send('applyProjectFiles',{id:candidateProjectId,base:candidateBase,files:Object.fromEntries(names.map(n=>[n,candidateFiles[n]])),source:candidateSource});}

app.addEventListener('click',e=>{const b=e.target.closest('[data-a]');if(!b)return;const a=b.dataset.a,p=project();switch(a){case 'startAuto':send('autoStart',{id:p.id,profileId:$('#autoProfile').value,task:$('#autoTask').value,rounds:+$('#autoRounds').value});break;case 'stopAuto':send('autoStop');break;case 'builds':page='builds';render();break;case 'cleanProject':{const p2=project();if(p2){send('cleanProject',{projectId:p2.id});}break;}
   case 'buildOffline':case 'buildInstall':{const pi=document.getElementById('pkgInput');const mp=document.getElementById('minPerm');const pkgVal=pi?pi.value.trim():'';const minVal=mp?!!mp.checked:false;p.pkg=pkgVal;p.minPermissions=minVal;
   // 先让原生拿到最新的包名/权限设置；万一保存失败也不能拦住构建 ——
   // 构建读的是原生侧已有的 state，保存失败最多是这次的设置没生效。
   try{saveProject();}catch(e){notice('包名设置没保存上，仍按已保存的设置构建');}
   send('buildApk',{id:p.id,install:a==='buildInstall',pkg:pkgVal,minPermissions:minVal});break;}case 'installApk':send('installApk',{id:p.id,number:+b.dataset.number});break;case 'exportApk':send('exportApk',{id:p.id,number:+b.dataset.number});break;case 'importDebug':send('importDebug');break;case 'collab':page='collab';render();break;case 'backEditor':page='editor';render();break;case 'backCollab':page='collab';render();break;case 'addTask':{const t=prompt('共同任务：这轮希望 Step 或其他 AI 做什么？');if(t){initProject(p);const task={id:uuid(),text:t,status:'todo'};p.tasks.push(task);selectedTaskId=task.id;saveProject();collaboration()}break}case 'linkStudio':send('studioLink',{id:p.id});break;case 'openStudioProject':send('studioOpen',{id:p.id});break;case 'captureStudio':send('studioCapture',{id:p.id});break;case 'importChanges':send('importProject',{target:p.id});break;case 'handoffAmoo':{let text='# StepX Studio 项目：'+p.name+'\n项目ID：'+p.id+'\n\n任务：'+(currentTask()?.text||'请协助检查项目')+'\n\n项目约定：'+p.brief+'\n\n请仅执行任务范围内的动作；缺少权限或能力时如实报告。完成后返回执行步骤、实际结果和未完成项。';if(p.debugReports?.length)text+='\n\n最近调试摘要：'+JSON.stringify(p.debugReports.slice(-1)).slice(0,12000);send('amooHandoff',{id:p.id,text});break;}case 'handoffStep':{const text=projectContext(currentTask()?.text);if(text.length>95000){notice('共享内容过长，请先精简');break}send('studioHandoff',{id:p.id,text:text+'\n\n请基于以上共享上下文继续处理当前任务，先说明计划，避免覆盖其他 AI 已完成的修改。'});break}case 'exportContext':send('exportText',{name:'neo-project-handoff.md',text:projectContext(currentTask()?.text)});break;case 'runProjectTask':runProjectTask();break;case 'reviewReply':{const h=p.history[+b.dataset.id];candidateFiles=parseCandidate(h.text);candidateProjectId=p.id;candidateBase=h.editBase||null;candidateSource=h.provider;if(!candidateBase){notice('旧记录没有文件基线，请基于当前文件重新请求 AI');return}if(!candidateFiles){notice('这轮结果是方案或审查意见，没有结构化文件建议，可复制或交给下一模型');return}page='review';render();break}case 'copyResult':send('copy',{text:p.history[+b.dataset.id].text});break;case 'applyCandidate':applyCandidate();break;case 'restoreSnapshot':{
    if(!p.snapshots?.length)break;
    if(!confirm('恢复“'+p.name+'”上次修改前的文件？当前文件也会保留为快照。'))break;
    /*
     * 先把编辑暂存落盘，再提交恢复。
     *
     * <p>原生那边的冲突检测是 {@code same(项目当前文件, base)}。
     * 这里传的 base 走 allFileContents —— 用的是 currentContent，
     * <b>包含编辑暂存</b>；而项目当前文件只反映<b>已落盘</b>的内容。
     *
     * <p>用户刚在编辑器里敲过字、还没触发那 400 毫秒的防抖保存时，
     * 两者会差一个暂存区 —— 检测于是报「文件已变化」，
     * 走抢救路径只恢复一部分文件，用户看到的是「恢复了一半」，
     * 而且完全不知道是哪一半。
     *
     * <p>applyCandidate 早就修过同一个问题，这里漏了。
     * 先落盘，让「项目当前文件」追上「用户看到的内容」，
     * 冲突检测才是在比真正该比的两样东西。
     */
    try{saveProject();}catch(e){notice('保存编辑内容失败，未恢复：'+(e&&e.message||e));break}
    send('restoreProjectFiles',{id:p.id,base:allFileContents(p)});
    break;}}});

function buildPage(){const p=project();if(!p){page='projects';render();return}app.innerHTML=`<div class="page"><button data-a="backEditor">‹ 编辑器</button><p class="muted">${esc(p.name)} · 选择构建路径</p><div class="card"><h2>Neo 本机离线构建</h2><p>在 Neo 本机编译当前前端项目，打包页面、图片和内置依赖并签名。可导出 APK，也可直接安装到 Neo。</p><label class="field">自定义包名（留空自动生成）<input id="pkgInput" placeholder="cn.example.myapp" value="${esc(p.pkg||'')}" ${buildBusy?'disabled':''}></label><label class="field"><input type="checkbox" id="minPerm" ${p.minPermissions?'checked':''} ${buildBusy?'disabled':''}> 最小权限（仅保留联网，适合提交应用市场）</label><button class="primary" data-a="buildOffline" ${buildBusy?'disabled':''}>${buildBusy?'正在本机编译与签名…':'构建 APK'}</button><button data-a="cleanProject" ${buildBusy?'disabled':''}>🧹 先清洗再出包</button><button data-a="buildInstall" ${buildBusy?'disabled':''}>构建并安装到 Neo</button><small class="build-note">支持 HTML / React / TSX 和内置依赖；缺失依赖会显示具体错误。不是 Kotlin/Gradle 编译器。卸载 StepX Studio 会丢失本机签名密钥，届时无法直接更新此前生成的 App。</small></div><div class="card"><h2>Step 云端构建</h2><p>将共享任务和代码交给官方 Studio，使用其构建与真机测试功能。需要网络和官方账号。</p><button data-a="backCollab">进入项目协作</button><button data-a="openStudioProject">打开 Studio 项目</button></div><h2>本机 APK</h2>${(p.builds||[]).slice().reverse().map(b=>`<div class="card"><strong>${esc(b.version)} · ${Math.round(b.bytes/1024)} KB</strong><p class="mono">${esc(b.package)}</p><small>${new Date(b.time).toLocaleString()} · 本机签名<br>SHA-256 ${esc(b.sha256)}</small><div class="row"><button class="primary" data-a="installApk" data-number="${b.number}">安装到 Neo</button><button data-a="exportApk" data-number="${b.number}">导出 APK</button></div></div>`).join('')||'<p class="muted">还没有构建记录。</p>'}<div class="card"><h2>App 调试回传</h2><p>生成的 App → 右上角菜单 → 开启调试模式 → 回传调试报告。每次导入先核对内容。报告会进入共享项目上下文，供 AI 继续修复。</p><button data-a="importDebug">导入调试 JSON</button><p>已收到 ${(p.debugReports||[]).length} 份报告</p>${(p.debugReports||[]).slice(-3).reverse().map(r=>`<details><summary>${esc(r.appId)} · ${esc(r.version)}</summary><pre class="contextPreview">${esc(JSON.stringify(r,null,2))}</pre></details>`).join('')}</div><div class="noticebar">安装包生成、安装成功、功能验收是三个独立步骤。正式分发前请在独立 App 中实际测试权限和数据行为。</div></div>`;}

function autoCard(p){const r=p.autoRun||{},running=r.phase&&!['done','stopped'].includes(r.phase),m=selectedProfile();return `<div class="card autoCard"><div class="row spread"><h2>自动联动</h2><span class="tag">StepX Neo</span></div><p class="muted">规划 → Studio 执行 → 取回结果 → 审查／修正</p><label for="autoTask">本次任务</label><textarea id="autoTask" rows="3" maxlength="4000" ${running?'disabled':''} placeholder="描述要完成的修改和验收条件">${esc(running?r.task:p.autoDraft??r.task??currentTask()?.text??'')}</textarea><div class="split autoOptions"><div><label for="autoProfile">协作模型</label><select id="autoProfile" ${running?'disabled':''}>${S.profiles.map(x=>`<option value="${esc(x.id)}" ${x.id===(running?r.profileId:p.autoProfile||m?.id)?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div><div><label for="autoRounds">最多往返</label><select id="autoRounds" ${running?'disabled':''}>${[1,2,3].map(n=>`<option value="${n}" ${n===(running?r.maxRounds:p.autoRounds||r.maxRounds||2)?'selected':''}>${n} 轮</option>`).join('')}</select></div></div><div class="row" style="margin-top:10px">${running?'<button class="danger" data-a="stopAuto">停止联动</button>':`<button class="primary" data-a="startAuto" ${!p.studioUrl||!m?'disabled':''}>开始自动联动</button>`}<button data-a="openStudioProject">查看 Studio</button></div>${r.message?`<p class="status">${esc(r.message)} · 第 ${r.round||0}/${r.maxRounds||2} 轮</p>`:''}${r.review?`<details><summary>模型审查意见</summary><p>${esc(r.review.summary)}</p></details>`:''}${r.events?.length?`<details><summary>运行记录 · ${r.events.length} 步</summary>${r.events.map(e=>`<div class="statrow">${new Date(e.time).toLocaleTimeString()} · ${esc(e.text)}</div>`).join('')}</details>`:''}${p.autoRuns?.length?`<details><summary>此前运行 · ${p.autoRuns.length} 次</summary>${p.autoRuns.slice().reverse().map(x=>`<div class="statrow">${new Date(x.started).toLocaleString()}<br>${esc(x.message)}${x.review?`<p>${esc(x.review.summary)}</p>`:''}</div>`).join('')}</details>`:''}<small>自动发送到关联项目，最多 3 轮；离开应用停止后续步骤。模型审查不替代实机验收。</small></div>`;}
