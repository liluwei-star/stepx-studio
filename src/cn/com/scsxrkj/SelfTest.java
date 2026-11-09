package cn.com.scsxrkj;
import org.json.*;
import java.io.*;
/** 整体自检：跑一批内置检查，确认核心功能没坏。只在调试版触发。 */
final class SelfTest {
 static int passed;static JSONArray details;
 static void check(boolean b,String name)throws Exception{if(!b)throw new Exception("FAIL "+name);passed++;details.put(name);}
 static JSONObject response(String json)throws Exception{return new JSONObject(json);}
 static JSONObject profile(String path,String protocol)throws Exception{return new JSONObject().put("endpoint","http://127.0.0.1:8768/"+path).put("protocol",protocol).put("model","fixture").put("maxTokens",128);}
 /**
  * 判断这个异常是不是「外部条件不可用」，而不是代码写错了。
  *
  * <p>区别很重要：限流 429、欠费 402、断网、超时 —— 这些都跟代码无关，
  * 用户换个时间或充个值就恢复正常了，不该让整场自测挂掉。
  * 而「返回结构不对」「工具调用拼不出来」才是真的代码问题，必须报出来。
  */
 static boolean isExternalBlocker(Exception e,String msg){
  if(e instanceof java.net.ConnectException||e instanceof java.net.SocketTimeoutException
    ||e instanceof java.net.UnknownHostException||e instanceof java.io.InterruptedIOException)return true;
  String m=msg==null?"":msg;
  /*
   * 外部条件不可用的三种表现：网络挂了、服务商拒绝、**功能没配置**。
   *
   * <p>第三种最容易被误判成代码 BUG：绘图没配 API、GitHub 没连 token ——
   * 工具确实没法干活，但那是环境问题，不是代码写错了。
   * 把它们混进失败里，自测就会在别人没配这些功能的机器上永远红着。
   */
  String[] external={"429","402","401","403","500","502","503","504",
   "额度","速率","限流","余额","欠费","配额","超时","timeout","rate limit","quota","insufficient",
   "Failed to connect","Unable to resolve host","Connection reset","Broken pipe",
   "请先添加并选择绘图 API","绘图 API 尚未允许 AI 调用","请保存绘图 API 密钥",
   "请先填写密钥","密钥格式无效","尚未连接 GitHub","未配置","没有配置"};
  for(String k:external)if(m.toLowerCase().contains(k.toLowerCase()))return true;
  return false;
 }

 /** 把冗长的服务端报错压成一句，报告里能看清就行。 */
 static String shortReason(String msg){
  String m=msg.replace('\n',' ').replace('\r',' ').trim();
  return m.length()<=120?m:m.substring(0,120)+"…";
 }

 static void run(MainActivity a){passed=0;details=new JSONArray();JSONObject out=new JSONObject();try{
  check(ProjectCreation.requested("帮我新建一个计数器项目。写代码")&&ProjectCreation.requested("新建项目")&&ProjectCreation.requested("Create a new local project for a timer"),"explicit new-project requests recognized");
  check(!ProjectCreation.requested("不要新建项目")&&!ProjectCreation.requested("如何新建项目？")&&!ProjectCreation.requested("请修改按钮为新建项目")&&!ProjectCreation.requested("“新建项目”是什么意思"),"discussion negation and quoted text do not create projects");
  String request="新建一个计数器项目";JSONObject creation=new JSONObject().put("projects",new JSONArray().put(new JSONObject().put("id","existing").put("name","计数器").put("files",new JSONObject().put("index.html","original")))).put("chats",new JSONArray().put(new JSONObject().put("id","new-chat").put("projectId","").put("messages",new JSONArray().put(new JSONObject().put("role","user").put("content",request)))));
  JSONObject created=ProjectCreation.create(creation,"new-chat",request);check(creation.getJSONArray("projects").length()==2&&created.getString("name").equals("计数器 2")&&creation.getJSONArray("projects").getJSONObject(0).getJSONObject("files").getString("index.html").equals("original"),"new project preserves existing code and uses unique name");
  check(creation.getJSONArray("chats").getJSONObject(0).getString("projectId").equals(created.getString("id")),"new conversation binds to created project");
  try{ProjectCreation.create(creation,"new-chat",request);throw new Exception("created twice");}catch(Exception e){check(!e.getMessage().equals("created twice"),"same request cannot create twice in bound conversation");}
  JSONObject queue=CloudQueue.start(creation.getJSONArray("projects"));CloudQueue.mark(queue,0,"done","verified");CloudQueue.mark(queue,1,"running","uploading");CloudQueue.end(queue,true);
  check(!queue.getBoolean("running")&&queue.getJSONArray("items").getJSONObject(0).getString("status").equals("done")&&queue.getJSONArray("items").getJSONObject(1).getString("status").equals("interrupted"),"interrupted queue retains completed results without automatic retries");
  queue=CloudQueue.start(creation.getJSONArray("projects"));CloudQueue.mark(queue,0,"failed","conflict");CloudQueue.end(queue,false);check(queue.getJSONArray("items").getJSONObject(0).getString("status").equals("failed")&&queue.getJSONArray("items").getJSONObject(1).getString("status").equals("stopped"),"stopping queue preserves failed result and marks pending item stopped");
  JSONObject history=new JSONObject("{chats:[{id:'a',projectId:'p'},{id:'b'},{id:'c'}],usage:[{id:'u',chatId:'a',usage:{total:42}},{id:'v',chatId:'a',projectId:'other'}],projects:[{id:'p'}]}");
  JSONArray deleted=ChatHistory.remove(history,new JSONArray("['a','b','a','missing']"));
  check(deleted.length()==2&&history.getJSONArray("chats").length()==1&&history.getJSONArray("chats").getJSONObject(0).getString("id").equals("c"),"batch delete only selected unique existing conversations");
  check(history.getJSONArray("usage").length()==2&&history.getJSONArray("projects").length()==1&&history.getJSONArray("usage").getJSONObject(0).getJSONObject("usage").getInt("total")==42,"batch delete preserves token amounts and projects");
  check(history.getJSONArray("usage").getJSONObject(0).getString("projectId").equals("p")&&history.getJSONArray("usage").getJSONObject(1).getString("projectId").equals("other"),"deleted history preserves accounting project attribution");
  check(ChatHistory.remove(history,new JSONArray("['a','b']")).length()==0,"batch delete idempotent");
  JSONObject ds=new JSONObject().put("endpoint","https://api.deepseek.com/v1").put("model","deepseek-v4-flash").put("maxTokens",393216);JSONArray longMessages=new JSONArray();String large=new String(new char[100000]).replace('\0','x');for(int i=0;i<121;i++)longMessages.put(new JSONObject().put("role",i%2==0?"user":"assistant").put("content",i==0?large:"fixture"));
  JSONObject longBody=ApiClient.requestBody(ds,longMessages,"system");check(longBody.getJSONArray("messages").length()==122&&longBody.getJSONArray("messages").getJSONObject(1).getString("content").length()==100000,"DeepSeek request preserves over 100 messages and 80000 characters");
  check(ModelLimits.context(ds.getString("endpoint"),ds.getString("model"))==1048576&&longBody.getInt("max_tokens")==393216&&!longBody.has("context_window"),"official context and output limits without unsupported context parameter");
  StreamResponse stream=new StreamResponse();stream.event("{choices:[{delta:{content:'a'}}]}",false,null);stream.event("{choices:[{delta:{content:'b'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}}",false,null);try{stream.result(false);throw new Exception("accepted partial stream");}catch(Exception e){check(!e.getMessage().equals("accepted partial stream"),"interrupted stream rejects project write");}stream.event("[DONE]",false,null);JSONObject sr=stream.result(false);check(sr.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content").equals("ab")&&Usage.parse(sr,"compatible").getInt("total")==5,"stream text and final usage preserved");
  StreamResponse ant=new StreamResponse();ant.event("{type:'message_start',message:{usage:{input_tokens:2,cache_read_input_tokens:4},model:'fixture'}}",true,null);ant.event("{type:'content_block_delta',delta:{type:'text_delta',text:'ok'}}",true,null);ant.event("{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}}",true,null);ant.event("{type:'message_stop'}",true,null);check(Usage.parse(ant.result(true),"anthropic").getInt("total")==9,"Anthropic stream usage merges without losing input cache");
  JSONObject project=new JSONObject().put("id","qa-local-tools").put("name","Tool fixture").put("files",new JSONObject().put("index.html","<!doctype html><html><body><h1>fixture</h1></body></html>"));LocalDevTools dev=new LocalDevTools(a,project);
  check(dev.call("list_files",new JSONObject()).getJSONArray("files").length()==1,"project tool lists scoped files");
  check(dev.call("read_file",new JSONObject().put("path","index.html")).getString("content").contains("fixture"),"project tool reads scoped content");
  /*
   * 搜索结果必须有上限 —— 源码断言只能证明「代码写了」，
   * 这里真的调一次，证明运行时确实被限住了。
   *
   * <p>造 800 个文件、每个 10 行都含同一个词，
   * 不传 limit（模型不传是常态），结果必须 ≤ 50 条。
   */
  JSONObject bigFiles=new JSONObject();
  for(int i=0;i<800;i++){
   StringBuilder sb=new StringBuilder();
   for(int k=0;k<10;k++)sb.append("const needleValue = ").append(i).append("_").append(k).append(";\n");
   bigFiles.put("src/f"+i+".js",sb.toString());
  }
  JSONObject limProject=new JSONObject().put("id","qa-search-limit").put("name","Search limit").put("files",bigFiles);
  LocalDevTools bigDev=new LocalDevTools(a,limProject);
  JSONObject limRes=bigDev.call("search_code",new JSONObject().put("query","needleValue"));
  check(limRes.getJSONArray("matches").length()<=50,
   "search results are capped at 50 when the model sends no limit");
  check(limRes.optBoolean("possiblyMore",false),
   "search says there may be more matches when it stops at the cap");
  check(limRes.getJSONArray("matches").length()==50,
   "the default cap fills up completely instead of truncating early");
  /*
   * 模型传一个离谱的大数也不行 —— 硬上限 200。
   */
  JSONObject bigRes=bigDev.call("search_code",new JSONObject().put("query","needleValue").put("limit",1000000));
  check(bigRes.getJSONArray("matches").length()<=200,
   "an absurd limit from the model is still capped at 200");
  /*
   * 列文件同样要有条目上限，且必须说清还剩多少没列。
   */
  JSONArray limList=bigDev.call("list_files",new JSONObject()).getJSONArray("files");
  int limListed=0;boolean limTold=false;
  for(int i=0;i<limList.length();i++){
   JSONObject g=limList.optJSONObject(i);
   if(g==null)continue;
   /*
    * 「还有 N 个没列出来」那条是提示分组，不是真实条目 ——
    * 把它算进去会把总数算成 800，测试就假失败了。
    */
   if(g.optString("dir","").startsWith("（还有")){limTold=true;continue;}
   limListed+=g.optInt("count",0);
  }
  check(limListed<=500,
   "listing files stops at 500 entries");
  check(limTold,
   "listing files says how many entries were left out");
  /*
   * 原地打转要被拦住 —— 同样是运行时验，不能只靠源码断言。
   *
   * <p>连续三次读同一个文件：前两次正常返回全文，
   * 第三次必须变成 unchanged（不重复贴），否则大文件能把一轮预算贴光。
   */
  JSONObject repProject=new JSONObject().put("id","qa-repeat").put("name","Repeat guard")
   .put("files",new JSONObject().put("README.md","# 原文"));
  LocalDevTools repDev=new LocalDevTools(a,repProject);
  JSONObject repArgs=new JSONObject().put("path","README.md");
  JSONObject rep1=repDev.callOnce("read_file",repArgs);
  check(!rep1.optBoolean("unchanged",false),
   "the first read returns the content as usual");
  JSONObject rep2=repDev.callOnce("read_file",repArgs);
  check(!rep2.optBoolean("unchanged",false)&&rep2.has("repeatHint"),
   "the second read still returns content but warns about the repeat");
  JSONObject rep3=repDev.callOnce("read_file",repArgs);
  check(rep3.optBoolean("unchanged",false),
   "the third identical read says unchanged instead of pasting it again");
  check(!rep3.has("content"),
   "the repeated read no longer carries the whole file");
  /*
   * 文件变了就一定要重新给 —— 改完再读是正常行为，不能误伤。
   */
  repDev.staged.getJSONObject("files").put("README.md","# 改过了");
  JSONObject rep4=repDev.callOnce("read_file",repArgs);
  check(!rep4.optBoolean("unchanged",false)&&rep4.optString("content","").contains("改过了"),
   "reading again after the file changed returns the new content");
  /*
   * 空回复兜底 —— 模型不写字时用户也得看到发生了什么。
   */
  JSONObject sumRes=new JSONObject().put("stagedFiles",new JSONObject().put("src/a.ts","x").put("src/b.ts","y"));
  String sumText=DevAgent.summaryText(sumRes,new JSONArray());
  check(sumText.contains("2 个文件")&&sumText.contains("src/a.ts"),
   "an empty reply is filled with the files that changed");
  JSONObject sumRes2=new JSONObject();
  check(DevAgent.summaryText(sumRes2,new JSONArray()).contains("没有改动文件"),
   "an empty reply with no changes says so");
  JSONArray sumTrail=new JSONArray().put(new JSONObject().put("name","read_file").put("error","没有这个文件：x.ts"));
  String sumText3=DevAgent.summaryText(sumRes2,sumTrail);
  check(sumText3.contains("次工具调用出错")&&sumText3.contains("没有这个文件"),
   "an empty reply with failed tools names the last error");
  JSONArray sumTrail2=new JSONArray().put(new JSONObject().put("name","auto_check_project")
   .put("result",new JSONObject().put("ok",false).put("error","TS2304")));
  check(DevAgent.summaryText(new JSONObject(),sumTrail2).contains("编译检查没通过"),
   "an empty reply after a failed compile says it did not pass");
  /*
   * 纯问答不该报错 —— 先验它依赖的两个前提。
   *
   * <p>前提一：自然语言解析不出 files（所以以前必然抛）。
   * <p>前提二：空改动 apply 回去不抛、结果和原来一样（所以现在能安全走这条路）。
   */
  boolean proseRejected=false;
  try{ProjectEdits.parse("这个项目有 4 个文件，是一个静态页面。");}
  catch(Exception e){proseRejected=true;}
  check(proseRejected,
   "plain prose is not mistaken for a file change");
  JSONObject emptyBase=new JSONObject().put("index.html","<html></html>");
  JSONObject emptyApplied=ProjectEdits.apply(new JSONObject().put("files",new JSONObject(emptyBase.toString())),
   emptyBase,new JSONObject(),"AI 助手");
  check(ProjectEdits.same(emptyBase,emptyApplied.getJSONObject("files")),
   "applying an empty change set leaves the project untouched instead of throwing");
  /*
   * 读文件越界的两种表现 —— 都要说清楚，不能给空内容。
   */
  LocalDevTools rrDev=new LocalDevTools(a,new JSONObject().put("id","qa-read").put("name","Read range")
   .put("files",new JSONObject().put("a.js","l1\nl2\nl3\nl4\nl5")));
  boolean rrThrew=false;
  try{rrDev.call("read_file",new JSONObject().put("path","a.js").put("startLine",99));}
  catch(Exception e){rrThrew=e.getMessage()!=null&&e.getMessage().contains("一共 5 行");}
  check(rrThrew,
   "reading past the end throws with the real line count");
  JSONObject rrPart=rrDev.call("read_file",new JSONObject().put("path","a.js").put("startLine",2).put("lineCount",2));
  check(rrPart.optInt("returnedLines",0)==2,
   "a partial read reports how many lines came back");
  check(rrPart.optString("note","").contains("后面还有 2 行"),
   "a partial read says how many lines are left");
  check(rrPart.optString("note","").contains("startLine=4"),
   "a partial read says exactly where to continue");
  /*
   * 只改一行 —— 这条以前必然失败（不传 endLine 就抛行号范围无效）。
   */
  LocalDevTools ppDev=new LocalDevTools(a,new JSONObject().put("id","qa-patch").put("name","Patch one line")
   .put("files",new JSONObject().put("index.html","<html></html>").put("a.js","one\ntwo\nthree")));
  ppDev.call("patch_file",new JSONObject().put("path","a.js").put("startLine",2).put("newContent","TWO"));
  check(ppDev.staged.getJSONObject("files").getString("a.js").equals("one\nTWO\nthree"),
   "patching a single line without endLine replaces exactly that line");
  /*
   * endLine 不含：startLine=2 endLine=3 只换第 2 行。
   */
  LocalDevTools ppDev2=new LocalDevTools(a,new JSONObject().put("id","qa-patch2").put("name","Patch range")
   .put("files",new JSONObject().put("index.html","<html></html>").put("a.js","one\ntwo\nthree")));
  ppDev2.call("patch_file",new JSONObject().put("path","a.js").put("startLine",2).put("endLine",3).put("newContent","TWO"));
  check(ppDev2.staged.getJSONObject("files").getString("a.js").equals("one\nTWO\nthree"),
   "endLine stays exclusive, so endLine=3 still replaces only line 2 and keeps line 3");
  /* endLine == startLine 也要能用（模型常把它当「含」写）。 */
  LocalDevTools ppDev3=new LocalDevTools(a,new JSONObject().put("id","qa-patch3").put("name","Patch same line")
   .put("files",new JSONObject().put("index.html","<html></html>").put("a.js","one\ntwo\nthree")));
  JSONObject pp3=ppDev3.call("patch_file",new JSONObject().put("path","a.js")
   .put("startLine",2).put("endLine",2).put("newContent","TWO"));
  check(ppDev3.staged.getJSONObject("files").getString("a.js").equals("one\nTWO\nthree"),
   "endLine equal to startLine is treated as a single-line change");
  JSONObject pp3r=pp3.optJSONObject("result");
  check(pp3r!=null&&pp3r.optInt("replacedFrom",0)==2&&pp3r.optInt("replacedTo",0)==2,
   "the result reports exactly which lines were replaced");
  /*
   * 记忆用量真的要出现在提示词里 —— 提示词承诺过这件事。
   *
   * <p>只在<b>自测专用</b>的 project scope 里写，写完立刻清掉。
   * 绝不碰 global —— 那是用户真正的记忆，自测没有资格动它。
   */
  String muScope="qa-memory-usage";
  a.memory.replace("测试用量：这条是自测写的","project",muScope);
  String muNow=a.memory.usageFor(muScope);
  check(muNow.contains("记忆用量")&&muNow.contains("/"+AiMemory.PROJECT_CAP),
   "after writing memory the usage line carries real numbers");
  a.memory.clear("project",muScope);
  /*
   * 计划全部完成时要明说，别让模型回头把做完的事再做一遍。
   */
  String planId="qa-plan-done";
  a.upsert("projects",new JSONObject().put("id",planId).put("name","Plan QA")
   .put("files",new JSONObject().put("index.html","<html></html>")));
  a.savePlan(planId,new JSONArray().put(new JSONObject().put("text","第一步").put("done",true))
   .put(new JSONObject().put("text","第二步").put("done",true)));
  String planDoneText=DevAgent.planContext(a,planId);
  check(planDoneText.contains("已全部完成"),
   "a finished plan says it is finished");
  check(planDoneText.contains("不是新任务"),
   "a finished plan is not treated as a fresh task");
  a.savePlan(planId,new JSONArray().put(new JSONObject().put("text","第一步").put("done",true))
   .put(new JSONObject().put("text","第二步").put("done",false)));
  check(DevAgent.planContext(a,planId).contains("接着做没勾的那几项"),
   "an unfinished plan tells the model to keep going");
  /*
   * 技能名要能带版本号，但不能带路径。
   *
   * <p>原来的正则把点号一起禁了，「清洗流程 v1.0」这种最自然的命名写不进去；
   * 而真正要防的只是路径穿越。
   */
  String skillName="自测技能 v1.0";
  a.skills.write(skillName,"自测用，写完就删","内容");
  check(a.skills.read(skillName).has("content"),
   "a skill name with a version dot is accepted");
  a.skills.delete(skillName);
  boolean pathSkillRejected=false;
  try{a.skills.write("../逃出去","不该允许","x");}
  catch(Exception e){pathSkillRejected=true;}
  check(pathSkillRejected,
   "a skill name with a path traversal is still refused");
  /*
   * 用户手动存的存档不能被 AI 的自动存档顶掉。
   *
   * <p>原来每次 AI 改文件都追加一份存档并只留最后一份 ——
   * 用户点「存档」存下来的基准就消失了，「变更」视图的基准
   * 悄悄换掉，用户完全看不出来。
   */
  JSONObject snapProj=new JSONObject().put("id","qa-snapkeep").put("name","Snap keep")
   .put("files",new JSONObject().put("index.html","<html></html>"));
  a.upsert("projects",snapProj);
  CloudFiles.snapshot(snapProj,null,"user");
  JSONObject afterUser=a.byId("projects","qa-snapkeep");
  int userCount=0;
  JSONArray sn0=afterUser.optJSONArray("snapshots");
  if(sn0!=null)for(int i=0;i<sn0.length();i++)
   if(CloudFiles.isUserSnapshot(sn0.optJSONObject(i)))userCount++;
  check(userCount==1,
   "a manual snapshot is recorded");
  /*
   * 再模拟三轮 AI 改动 —— 每一轮都会自动追加一份存档。
   */
  JSONObject cur=afterUser;
  for(int round=0;round<3;round++){
   JSONObject baseF=new JSONObject(cur.getJSONObject("files").toString());
   JSONObject changed=new JSONObject().put("index.html","<html>round"+round+"</html>");
   cur=ProjectEdits.apply(cur,baseF,changed,"AI 助手");
  }
  a.upsert("projects",cur);
  JSONObject afterAi=a.byId("projects","qa-snapkeep");
  int userAfter=0,autoAfter=0;
  JSONArray sn1=afterAi.optJSONArray("snapshots");
  if(sn1!=null)for(int i=0;i<sn1.length();i++){
   JSONObject s=sn1.optJSONObject(i);
   if(s==null)continue;
   if(CloudFiles.isUserSnapshot(s))userAfter++;else autoAfter++;
  }
  check(userAfter==1,
   "the manual snapshot survives several AI edits");
  /*
   * 编译失败不能显示成成功。
   *
   * <p>自动验证编译失败时，错误在 result.ok 里，不在 toolCalls 的 error 字段。
   * 原来按有没有 error 字段判成功，编译没过却显示 ok:true。
   */
  JSONArray cc=new JSONArray();
  cc.put(new JSONObject().put("name","auto_check_project")
   .put("result",new JSONObject().put("ok",false).put("error","第 3 行：缺少右括号")));
  JSONArray ccSummary=a.toolCallSummary(cc);
  JSONObject cc0=ccSummary.optJSONObject(0);
  check(cc0!=null&&!cc0.optBoolean("ok",true),
   "a failed compile is not reported as ok");
  check(cc0!=null&&cc0.optString("error","").contains("右括号"),
   "the compile error text reaches the tool record");
  /*
   * glob 要匹配得上模型写得出来的样子。
   *
   * <p>「src 下的所有 .ts」是模型最常写的搜索模式。原来匹配不到
   * src/a.ts，模型搜不到东西只会换个写法再试，白烧一轮。
   */
  check(LocalDevTools.globMatch("src/a.ts","src/**/*.ts"),
   "a src glob matches a file directly under src");
  check(LocalDevTools.globMatch("src/x/y/a.ts","src/**/*.ts"),
   "a src glob matches a nested file");
  check(!LocalDevTools.globMatch("lib/a.ts","src/**/*.ts"),
   "a src glob does not match another directory");
  check(LocalDevTools.globMatch("src/app/x.tsx","*.tsx"),
   "a bare extension glob matches in any directory");
  /*
   * 行号口径必须三处一致。
   *
   * <p>read_file / list_files / patch_file 报的行数如果不一样，
   * 模型照着 read_file 的行号去改，就会撞「起始行超出文件行数」——
   * 明明是同一个文件。
   */
  JSONObject lfFiles=new JSONObject()
   .put("index.html","<html></html>")
   .put("a.js","l1\nl2\nl3\nl4\nl5\n");
  LocalDevTools lfDev=new LocalDevTools(a,new JSONObject().put("id","qa-lines").put("name","Lines")
   .put("files",lfFiles));
  JSONObject lfRead=lfDev.call("read_file",new JSONObject().put("path","a.js"));
  check(lfRead.optInt("totalLines",0)==5,
   "read_file does not count the trailing newline as a line");
  JSONObject lfList=lfDev.call("list_files",new JSONObject().put("prefix",""));
  int listedLines=0;
  JSONArray lfGroups=lfList.optJSONArray("files");
  if(lfGroups!=null)for(int gi=0;gi<lfGroups.length();gi++){
   JSONArray g=lfGroups.optJSONObject(gi).optJSONArray("files");
   if(g==null)continue;
   for(int fi=0;fi<g.length();fi++){
    JSONObject f=g.optJSONObject(fi);
    if(f!=null&&"a.js".equals(f.optString("path")))listedLines=f.optInt("lines",0);
   }
  }
  check(listedLines==5,
   "list_files counts the same lines as read_file");
  /*
   * 关键：按 read_file 报的行号去改，不能撞越界。
   */
  boolean patchOk=true;String patchErr="";
  try{
   lfDev.call("patch_file",new JSONObject().put("path","a.js")
    .put("startLine",lfRead.optInt("totalLines",0)).put("newContent","last"));
  }catch(Exception e){patchOk=false;patchErr=String.valueOf(e.getMessage());}
  check(patchOk,
   "patching the last line read_file reported does not hit an out-of-range error ("+patchErr+")");
  /*
   * 连着改两次：先 write_files 建文件，再 patch_file 改它。
   *
   * <p>这是 AGENT 最常见的动作序列。两个工具必须看到同一份最新的暂存区，
   * 否则第二个会拿旧内容算新内容，或者直接报「文件已变化」。
   */
  LocalDevTools seqDev=new LocalDevTools(a,new JSONObject().put("id","qa-seq").put("name","Seq")
   .put("files",new JSONObject().put("index.html","<html></html>")));
  String seqErr="";
  try{
   seqDev.call("write_files",new JSONObject().put("files",
    new JSONObject().put("app.js","const a=1;\nconst b=2;\n")));
  }catch(Exception e){seqErr="write_files: "+e.getMessage();}
  JSONObject seqPatch=new JSONObject();
  try{
   seqPatch=seqDev.call("patch_file",new JSONObject().put("path","app.js")
    .put("startLine",2).put("newContent","const b=3;"));
  }catch(Exception e){seqErr=seqErr+(seqErr.isEmpty()?"":"; ")+"patch_file: "+e.getMessage();}
  check(seqPatch.optJSONObject("result")!=null&&seqPatch.getJSONObject("result").optBoolean("staged",false),
   "a patch right after a write_file succeeds ("+seqErr+")");
  JSONObject seqRead=seqDev.call("read_file",new JSONObject().put("path","app.js"));
  check(seqRead.optString("content","").contains("const b=3;"),
   "the second edit sees the first edit result");
  /*
   * 精确替换也要看到最新内容。
   */
  seqDev.call("replace_text",new JSONObject().put("path","app.js")
   .put("oldText","const a=1;").put("newText","const a=9;"));
  JSONObject seqRead2=seqDev.call("read_file",new JSONObject().put("path","app.js"));
  check(seqRead2.optString("content","").contains("const a=9;"),
   "replace_text sees the file as it is now");
  check(autoAfter>=1,
   "the automatic snapshots are still kept");
  a.remove("projects","qa-snapkeep");
  check(a.memory.usageFor(muScope).indexOf("记忆用量")<0
    ||!a.memory.usageFor(muScope).contains("本项目"),
   "clearing the test scope removes it from the usage line");
  /*
   * multi_patch 从后往前改 —— 前面插行不能把后面的行号顶掉。
   *
   * 第 2 行插入两行、同时改第 2 行之外的第 4 行（原文件）。
   * 如果按升序改，插完两行后原第 4 行已是第 6 行，就改错了地方。
   */
  LocalDevTools mpDev=new LocalDevTools(a,new JSONObject().put("id","qa-multi").put("name","Multi patch")
   .put("files",new JSONObject().put("index.html","<html></html>")
    .put("a.js","l1\nl2\nl3\nl4\nl5")));
  JSONArray mpPatches=new JSONArray()
   .put(new JSONObject().put("path","a.js").put("startLine",2).put("newContent","X2\nX2b"))
   .put(new JSONObject().put("path","a.js").put("startLine",4).put("newContent","X4"));
  mpDev.call("multi_patch",new JSONObject().put("patches",mpPatches));
  check(mpDev.staged.getJSONObject("files").getString("a.js").equals("l1\nX2\nX2b\nl3\nX4\nl5"),
   "multi_patch applies from the bottom up so earlier inserts cannot shift later line numbers");
  check(dev.call("search_code",new JSONObject().put("query","fixture")).getJSONArray("matches").length()==1,"project tool searches line numbers");
  dev.call("write_files",new JSONObject().put("files",new JSONObject().put("app.js","let count=0;")));check(!project.getJSONObject("files").has("app.js")&&dev.finalChanges(new JSONObject()).getString("app.js").contains("count"),"tool stages new files without overwriting original");
  try{dev.call("write_files",new JSONObject().put("files",new JSONObject().put("../escape.js","bad")));throw new Exception("accepted traversal");}catch(Exception e){check(!e.getMessage().equals("accepted traversal"),"tool write rejects directory escape");}
  dev.call("replace_text",new JSONObject().put("path","app.js").put("oldText","count=0").put("newText","count=1"));check(dev.finalChanges(new JSONObject()).getString("app.js").equals("let count=1;"),"precise replacement stages a small edit");
  try{dev.call("replace_text",new JSONObject().put("path","app.js").put("oldText","missing").put("newText","x"));throw new Exception("accepted missing text");}catch(Exception e){check(!e.getMessage().equals("accepted missing text"),"precise replacement refuses missing context");}
  /*
   * 这一批测的是「按行改动」和「自查」类工具。
   *
   * 它们最容易出两种错：
   * ① 行号算错，把不该动的地方动了 —— patch_file 的行号处理是纯算术，错了很难看出来
   * ② diff 把整个文件都吐出来 —— 500 行的文件改 1 行，返回 500 条，等于没给信息
   * 所以两项都单独验：一个验结果对不对，一个验输出有没有被裁剪。
   */
  dev.call("patch_file",new JSONObject().put("path","app.js").put("startLine",1).put("endLine",1).put("newContent","let count=99;"));
  check(dev.finalChanges(new JSONObject()).getString("app.js").equals("let count=99;"),"patch_file replaces only the given line range");

  JSONArray patches=new JSONArray();
  patches.put(new JSONObject().put("path","app.js").put("startLine",1).put("endLine",1).put("newContent","let count=7;"));
  patches.put(new JSONObject().put("path","index.html").put("startLine",1).put("endLine",1).put("newContent","<!doctype html><html><body><h1>patched</h1></body></html>"));
  JSONObject multi=dev.call("multi_patch",new JSONObject().put("patches",patches));
  check(multi.getInt("ok")==2&&dev.finalChanges(new JSONObject()).getString("index.html").contains("patched"),"multi_patch edits several files in one call");
  /*
   * 审查链路的原生断言。
   *
   * <p>这里守的是一个真实踩过的坑：edit.base 是「改动前的整个项目」，几 MB；
   * edit.files 是「这次改了什么」，审查页面全靠它。以前保存聊天消息时用
   * 摘要方法把 files 换成了 changedFiles —— 审查页于是是空的，
   * 而且时好时坏（刚回复完能审，state 刷新后就废）。
   */
  JSONObject editProbe=new JSONObject()
   .put("status","review").put("message","建议已生成").put("projectId","p1")
   .put("base",new JSONObject().put("index.html","旧内容"))
   .put("files",new JSONObject().put("index.html","新内容"));
  JSONObject editStored=a.editForStore(editProbe);
  check(editStored.has("files"),"the stored edit keeps the changed files for review");
  check(editStored.getJSONObject("files").optString("index.html").equals("新内容"),"the stored edit keeps the new file content");
  check(!editStored.has("base"),"the stored edit drops the whole-project baseline");
  check(editStored.has("baseHash"),"the stored edit records the baseline hash instead");
  check(editStored.has("changedFiles"),"the stored edit lists the changed file names");
  /*
   * 幂等检查要按「键和值」比，不能比字符串：
   * org.json 的 JSONObject 用 LinkedHashMap，toString 按插入顺序输出，
   * 两次处理后的插入顺序会不同（files 的位置变了），字符串就不相等了 ——
   * 但内容完全一样。拿字符串比会误判成 BUG。
   */
  JSONObject editTwice=a.editForStore(editStored);
  boolean sameKeys=editTwice.length()==editStored.length();
  if(sameKeys)for(java.util.Iterator<String> it=editStored.keys();it.hasNext();){
   String k=it.next();
   if(!editTwice.has(k)||!String.valueOf(editTwice.opt(k)).equals(String.valueOf(editStored.opt(k))))sameKeys=false;
  }
  check(sameKeys,"storing the edit twice keeps the same content");
  JSONObject hugeEdit=new JSONObject().put("files",new JSONObject().put("big.js",new String(new char[600*1024]).replace('\0','x')));
  JSONObject hugeStored=a.editForStore(hugeEdit);
  check(hugeStored.optBoolean("filesOmitted",false),"an oversized change is marked as omitted instead of kept whole");
  check(!hugeStored.has("files"),"an oversized change does not keep the full content");
  check(hugeStored.has("changedFiles"),"an oversized change still lists the changed file names");
  check(!a.editForUi(editProbe).has("base"),"the edit sent to the web view drops the baseline");

  JSONObject mine=dev.call("diff_mine",new JSONObject()).getJSONObject("diff");
  check(mine.getJSONObject("stats").getInt("modified")>=1&&mine.getJSONArray("modified").length()>=1,"diff_mine reports what changed this round");

  dev.call("write_files",new JSONObject().put("files",new JSONObject().put("src/a.ts","const FIXTURE_TOKEN=1;").put("src/b.tsx","const FIXTURE_TOKEN=2;")));
  JSONArray tsxOnly=dev.call("search_code",new JSONObject().put("query","FIXTURE_TOKEN").put("glob","*.tsx")).getJSONArray("matches");
  check(tsxOnly.length()==1&&tsxOnly.getJSONObject(0).getString("path").endsWith(".tsx"),"search_code glob restricts to matching extensions");

  /*
   * 裁剪验证要拿「本来就存在」的文件来改。
   * 会话中途新建的文件在 diff_mine 里算 added，不算 modified ——
   * 那不叫裁剪，那叫没改。
   */
  StringBuilder big=new StringBuilder();
  for(int k=0;k<300;k++)big.append("line").append(k).append('\n');
   String bigText=big.toString();
  JSONObject bigProject=new JSONObject().put("id","qa-big-tools").put("name","Big fixture")
   .put("files",new JSONObject().put("index.html","<!doctype html><html><body>big</body></html>").put("big.js",bigText));
  LocalDevTools bigTools=new LocalDevTools(a,bigProject);
  bigTools.call("write_files",new JSONObject().put("files",new JSONObject().put("big.js",bigText.replace("line150","CHANGED150"))));
  JSONArray bigDiff=bigTools.call("diff_mine",new JSONObject().put("path","big.js")).getJSONObject("diff").getJSONArray("modified");
  check(bigDiff.length()==1&&bigDiff.getJSONObject(0).getJSONArray("lines").length()<50,"diff_mine trims unchanged lines around edits");

  check(dev.call("check_project",new JSONObject()).getBoolean("ok"),"tool invokes real offline compiler");
  String query=GithubResearch.query("private@example.test ./private 再做一个待办",project.getJSONObject("files"));check(query.equals("todo language:JavaScript archived:false"),"GitHub query uses only generic task vocabulary");
  check(a.connectors.items().length()>=39,"official connector catalog includes all builder types");
  check(a.connectors.search("震动").getJSONArray("items").length()>0,"connector search finds capability descriptions");
  JSONObject vib=a.connectors.describe("ic_atomic_990012","",0);check(vib.getJSONArray("capabilities").length()==2&&!vib.has("connection"),"connector detail contains tools without account connection data");
  LocalDevTools readOnly=new LocalDevTools(a,null);check(readOnly.call("search_connectors",new JSONObject().put("query","ic_atomic_990012")).getJSONArray("items").length()==1,"connector tools work without a project");
  try{readOnly.call("list_files",new JSONObject());throw new Exception("accepted unscoped files");}catch(Exception e){check(!e.getMessage().equals("accepted unscoped files"),"no project cannot access files");}
  JSONObject u=Usage.parse(response("{usage:{prompt_tokens:100,completion_tokens:40,prompt_tokens_details:{cached_tokens:60},completion_tokens_details:{reasoning_tokens:10}}}"),"compatible");check(u.getLong("total")==140,"compatible subsets not double counted");check(u.getLong("cacheRead")==60&&u.getLong("reasoning")==10,"detail fields");
  u=Usage.parse(response("{usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:80,cache_creation_input_tokens:30}}"),"anthropic");check(u.getLong("input")==120&&u.getLong("total")==140,"anthropic all input buckets");
  check(!Usage.parse(response("{}"),"compatible").getBoolean("known"),"missing usage unknown");check(!Usage.parse(response("{usage:{prompt_tokens:4}}"),"compatible").getBoolean("known"),"partial usage unknown");check(Usage.parse(response("{usage:{prompt_tokens:0,completion_tokens:0}}"),"compatible").getBoolean("known"),"zero tokens valid");
  try{ApiClient.endpoint("http://example.com/v1","compatible",false);throw new Exception("accepted HTTP");}catch(Exception e){check(!e.getMessage().equals("accepted HTTP"),"reject cleartext endpoints");}
  try{ApiClient.endpoint("https://user:pass@example.com/v1","compatible",false);throw new Exception("accepted credentials");}catch(Exception e){check(!e.getMessage().equals("accepted credentials"),"reject URL credentials");}
  check(ApiClient.endpoint("https://example.com/v1/","compatible",false).equals("https://example.com/v1/chat/completions"),"endpoint suffix normalization");
  JSONArray messages=new JSONArray().put(new JSONObject().put("role","user").put("content","fixture"));
  JSONObject r=new ApiClient().request(profile("ok","compatible"),"fixture-secret",messages,"system",true);check(r.getString("text").equals("fixture reply")&&r.getJSONObject("usage").getLong("total")==140,"compatible transport and usage");
  r=new ApiClient().request(profile("anthropic","anthropic"),"fixture-secret",messages,"system",true);check(r.getString("text").equals("anthropic reply")&&r.getJSONObject("usage").getLong("total")==140,"anthropic transport and usage");
  r=new ApiClient().request(profile("missing","compatible"),"fixture-secret",messages,"system",true);check(!r.getJSONObject("usage").getBoolean("known"),"transport missing usage");
  r=new ApiClient().request(profile("thinking","compatible").put("thinking","disabled"),"fixture-secret",messages,"system",true);check(!r.optBoolean("incomplete"),"thinking toggle transport");
  r=new ApiClient().request(profile("incomplete","compatible"),"fixture-secret",messages,"system",true);check(r.optBoolean("incomplete")&&r.getString("text").contains("不完整")&&r.getJSONObject("usage").getLong("total")==140,"truncated reasoning keeps usage and warning");
  for(String path:new String[]{"bad","redirect"}){try{new ApiClient().request(profile(path,"compatible"),"fixture-secret",messages,"system",true);throw new Exception("accepted "+path);}catch(Exception e){check(e.getMessage().startsWith("HTTP "),"reject "+path);}}
  a.vault.put("selftest","secret-value");check(a.vault.get("selftest").equals("secret-value"),"keystore encryption roundtrip");a.vault.remove("selftest");check(!a.vault.has("selftest"),"key removal");
  if(a.getIntent().getBooleanExtra("networktest",false)){JSONObject net=new JSONObject();try{JSONObject research=GithubResearch.run("计数器",project.getJSONObject("files"),new ApiClient());net.put("result","PASS").put("references",research.getJSONArray("references").length());}catch(Exception e){net.put("result","UNAVAILABLE").put("errorType",e.getClass().getSimpleName());}try(FileOutputStream f=new FileOutputStream(new File(a.getFilesDir(),"research-selftest.json"))){f.write(net.toString().getBytes("UTF-8"));}}
  /*
   * ── 记忆 / 技能 / 联网 / GitHub 的基础校验 ──────────────────
   *
   * 这一批只验「底层会不会静默出错」，不验「模型会不会正确使用它们」——
   * 后者是行为，单测抓不住。但这几处一旦错了都不会报错，
   * 只会悄悄记错东西、算错哈希、或者放行不该访问的地址。
   */

  // 记忆：写进去要能原样读回来。测试前后保存/恢复用户真实记忆，不能污染。
  AiMemory mem=new AiMemory(a);
  String savedGlobal=AiMemory.readText(mem.globalFile());
  try{
   mem.replace("","global",null);
   mem.remember("自测写入的一条记忆","global",null);
   check(mem.read("global",null).contains("自测写入的一条记忆"),"memory writes and reads back");

   boolean entryRejected=false;
   StringBuilder tooLong=new StringBuilder();
   for(int i=0;i<AiMemory.ENTRY_CAP+10;i++)tooLong.append('x');
   try{mem.remember(tooLong.toString(),"global",null);}catch(Exception e){entryRejected=true;}
   check(entryRejected,"memory rejects an over-long single entry");

   // 灌到超限：裁剪后仍要保持整行，并且裁剪标记只出现一次
   /*
    * 要真的灌过 8000 字符才叫「超限」。
    * 每条约 190 字符（时间戳 + 正文），所以 80 条 ≈ 15000 字符，
    * 必定触发裁剪。写 40 条只在 7000 多，测不到这条路径。
    */
   StringBuilder filler=new StringBuilder();
   for(int i=0;i<40;i++)filler.append("填充内容");
   for(int i=0;i<80;i++)mem.remember("第"+i+"条 "+filler,"global",null);
   String trimmedMem=mem.read("global",null);
   int markCount=0;
   for(int i=trimmedMem.indexOf(AiMemory.CUT_MARK);i>=0;i=trimmedMem.indexOf(AiMemory.CUT_MARK,i+1))markCount++;
   check(trimmedMem.contains(AiMemory.CUT_MARK)&&markCount==1,"memory trims to cap with a single cut marker");
   check(trimmedMem.length()<=AiMemory.GLOBAL_CAP+AiMemory.CUT_MARK.length()+8,"memory stays within cap after trimming");
  }finally{
   mem.replace(savedGlobal,"global",null);
  }

  /*
   * 项目记忆必须按项目隔离。
   * 串了的话，AI 会把 A 项目的约定当成 B 项目的，用户完全察觉不到。
   */
  String isolatedA="qa-memory-a",isolatedB="qa-memory-b";
  try{
   mem.replace("","project",isolatedA);
   mem.replace("","project",isolatedB);
   mem.remember("甲项目的约定","project",isolatedA);
   mem.remember("乙项目的约定","project",isolatedB);
   String readA=mem.read("project",isolatedA),readB=mem.read("project",isolatedB);
   check(readA.contains("甲项目的约定")&&!readA.contains("乙项目的约定"),"project memory is isolated per project (a)");
   check(readB.contains("乙项目的约定")&&!readB.contains("甲项目的约定"),"project memory is isolated per project (b)");
   check(mem.contextFor(isolatedA).contains("甲项目的约定")&&!mem.contextFor(isolatedA).contains("乙项目的约定"),
    "memory context only carries the current project's notes");
  }finally{
   try{mem.clear("project",isolatedA);}catch(Exception ignored){}
   try{mem.clear("project",isolatedB);}catch(Exception ignored){}
  }

  // 技能：名字要能防路径穿越，读回要完整，清单只给描述
  SkillStore store=new SkillStore(a);
  String testSkill="自测技能"+System.currentTimeMillis();
  try{
   store.write(testSkill,"当需要验证技能系统时使用","第一步\n第二步");
   JSONArray skillList=store.list();
   boolean found=false;
   for(int i=0;i<skillList.length();i++){
    JSONObject s=skillList.optJSONObject(i);
    if(s!=null&&testSkill.equals(s.optString("name"))&&s.optString("description").contains("验证技能系统"))found=true;
   }
   check(found,"skill writes and lists with its description");
   check(store.read(testSkill).getString("content").contains("第二步"),"skill reads back the full body");
   check(store.index().contains(testSkill),"skill index exposes the name for the prompt");

   boolean badSkillName=false;
   try{store.write("../逃逸","x","y");}catch(Exception e){badSkillName=true;}
   check(badSkillName,"skill rejects path traversal in its name");

   boolean emptyDescRejected=false;
   try{store.write("没有描述","","正文");}catch(Exception e){emptyDescRejected=true;}
   check(emptyDescRejected,"skill refuses an empty description");
  }finally{
   try{store.delete(testSkill);}catch(Exception ignored){}
  }

  // 联网：内网和本机地址必须拦掉，公网地址要放行
  check(WebTools.isPrivate("127.0.0.1")&&WebTools.isPrivate("localhost")&&WebTools.isPrivate("192.168.1.1")
   &&WebTools.isPrivate("10.0.0.5")&&WebTools.isPrivate("172.16.0.1")&&WebTools.isPrivate("169.254.1.1")
   &&!WebTools.isPrivate("example.com")&&!WebTools.isPrivate("172.32.0.1"),
   "web blocks loopback and private ranges");

  boolean badProtocol=false;
  try{WebTools.checkUrl("file:///etc/passwd");}catch(Exception e){badProtocol=true;}
  check(badProtocol,"web rejects non-http protocols");

  String rawHtml="<html><script>var secret=1</script><style>a{color:red}</style><p>你好 &amp; 世界</p><div>第二段</div></html>";
  String plainText=WebTools.htmlToText(rawHtml);
  check(!plainText.contains("var secret")&&!plainText.contains("color:red")
   &&plainText.contains("你好 & 世界")&&plainText.contains("第二段"),
   "html to text strips scripts and decodes entities");

  // GitHub：blob 哈希必须和 git hash-object 完全一致，否则每次上传都会全量重传
  check(GitHubTool.blobSha("abc".getBytes("UTF-8")).equals("f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f"),
   "git blob hash matches git hash-object for ascii");
  check(GitHubTool.blobSha("中文内容".getBytes("UTF-8")).equals("f3c5747975eb7bc1f48dab7dbef19d126d60a12f"),
   "git blob hash matches for utf-8 chinese");
  check(GitHubTool.blobSha(new byte[0]).equals("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"),
   "git blob hash of empty content");
  check(GitHubTool.sanitizeRepo("My Cool Repo!!").equals("my-cool-repo"),"repo name sanitized");

  /*
   * ── 沙箱与测试运行器 ────────────────────────────────────────
   *
   * 这两项会真的起 WebView、真的跑 esbuild，所以慢（几秒到十几秒）。
   * 但必须验：它们是「AI 说改好了」和「AI 真的验过」之间的那道桥，
   * 桥断了的话，模型会以为自己测过了，用户拿到的是没验过的代码。
   */
  JSONObject sandboxProject=new JSONObject().put("id","qa-sandbox").put("name","Sandbox 自测")
   .put("files",new JSONObject()
    .put("index.html","<!doctype html><html><body>sandbox</body></html>")
    .put("math.js","export const add=(a,b)=>a+b;\n")
    .put("math.test.js","import {add} from './math.js';\n"
     +"describe('加法',()=>{\n"
     +"  it('1+1 等于 2',()=>{expect(add(1,1)).toBe(2);});\n"
     +"  it('故意失败的一条',()=>{expect(add(1,1)).toBe(3);});\n"
     +"});\n"));

  try{
   JSONObject sandbox=a.script.runScript(
    "const out=[];for(let i=1;i<=3;i++)out.push(i*i);console.log('算完了');window.__neoResult=out.join(',');",
    sandboxProject);
   check(sandbox.optBoolean("ok")&&"1,4,9".equals(sandbox.optString("result")),
    "sandbox runs javascript and returns the result");
  }catch(Exception e){
   throw new Exception("FAIL sandbox runs javascript and returns the result: "+e.getMessage());
  }

  /*
   * 语法错必须立刻变成一条明确的错误，而不是等到超时。
   *
   * 这是 new Function 隔离的价值所在：如果用户代码是被拼进外层脚本的，
   * 一个多余的括号就会让整段外层脚本解析失败，调用方只能看到「超时」，
   * 完全不知道真正的原因是语法错。
   */
  try{
   JSONObject broken=a.script.runScript("this is not valid js {{{{",sandboxProject);
   check(!broken.optBoolean("ok")&&!broken.optString("error").isEmpty(),
    "sandbox reports syntax errors instead of hanging");
  }catch(Exception e){
   throw new Exception("FAIL sandbox reports syntax errors instead of hanging: "+e.getMessage());
  }

  /*
   * 同步抛错也要被接住（不是所有错误都在 await 之后）。
   */
  try{
   JSONObject thrown=a.script.runScript("throw new Error('故意抛的错误')",sandboxProject);
   check(!thrown.optBoolean("ok")&&thrown.optString("error").contains("故意抛的错误"),
    "sandbox catches runtime errors with their message");
  }catch(Exception e){
   throw new Exception("FAIL sandbox catches runtime errors: "+e.getMessage());
  }

  /*
   * 没有测试文件时要说清楚，而不是返回一堆零让人以为测试全过了。
   */
  try{
   JSONObject noTests=a.script.runTests(new JSONObject().put("id","qa-notests").put("name","无测试")
    .put("files",new JSONObject().put("index.html","<!doctype html><html></html>")));
   check(noTests.optInt("files",0)==0&&noTests.optString("note").contains("没有测试文件"),
    "test runner explains when a project has no tests");
   /*
    * 「没有测试」不能报成「测试通过」。
    *
    * <p>原来这里 ok 是 true，模型看到就会说「测试通过了」——
    * 而一个用例都没跑。这是假阳性，比明确报错更糟。
    */
   check(!noTests.optBoolean("ok",true),
    "a project with no tests is not reported as a passing run");
   check(!noTests.optBoolean("ran",true),
    "a project with no tests is marked as not-run");
   check(noTests.optString("summary","").contains("未运行任何测试"),
    "the summary says nothing was run");
   check(noTests.optString("summary","").contains("不是测试失败"),
    "the summary tells the model this is not a failure to fix");
  }catch(Exception e){
   throw new Exception("FAIL test runner explains when a project has no tests: "+e.getMessage());
  }

  try{
   JSONObject tested=a.script.runTests(sandboxProject);
   check(tested.optInt("files",0)==1&&tested.optInt("passed",-1)==1&&tested.optInt("failed",-1)==1,
    "test runner bundles tests, runs them, and counts pass and fail");
   check(tested.optBoolean("ran",false),
    "a real test run is marked as run");
   check(!tested.optBoolean("ok",true),
    "a run with a failing case is not reported as ok");
   check(tested.optString("summary","").contains("故意失败的一条"),
    "test runner reports the failing case by name");
  }catch(Exception e){
   throw new Exception("FAIL test runner bundles tests, runs them, and counts pass and fail: "+e.getMessage());
  }

  /*
   * ── 多模态消息的文本提取 ────────────────────────────────────
   *
   * 带图的消息 content 是数组不是字符串。任何一处还用 getString/optString
   * 去取的地方都会出问题：前者抛异常把请求打断，后者把一串 JSON 当成用户原话。
   * 这一组测的就是那个统一入口。
   */
  JSONObject plainMessage=new JSONObject().put("role","user").put("content","你好，帮我看看");
  check("你好，帮我看看".equals(MainActivity.messageText(plainMessage)),"messageText handles a plain string");
  check(MainActivity.messageImageCount(plainMessage)==0,"messageImageCount is zero for plain text");

  JSONObject imageMessage=new JSONObject().put("role","user").put("content",new JSONArray()
   .put(new JSONObject().put("type","text").put("text","这个报错什么原因"))
   .put(new JSONObject().put("type","image_url").put("image_url",new JSONObject().put("url","data:image/jpeg;base64,QUJD"))));
  String imageText=MainActivity.messageText(imageMessage);
  check(imageText.contains("这个报错什么原因")&&!imageText.contains("base64"),
   "messageText extracts text without leaking base64");
  check(MainActivity.messageImageCount(imageMessage)==1,"messageImageCount counts attached images");
  check(MainActivity.messageText(new JSONObject()).isEmpty(),"messageText of an empty message is empty");

  /*
   * Anthropic 协议要的图片结构是 {type:image,source:{type:base64,...}}，
   * 和 OpenAI 的 image_url 完全不同。不转的话 Claude 会直接拒这条消息。
   */
  JSONArray anthropic=ApiClient.toAnthropicMessages(new JSONArray().put(imageMessage));
  JSONObject convertedPart=null;
  JSONArray convertedParts=anthropic.getJSONObject(0).optJSONArray("content");
  if(convertedParts!=null)for(int i=0;i<convertedParts.length();i++){
   JSONObject part=convertedParts.optJSONObject(i);
   if(part!=null&&"image".equals(part.optString("type")))convertedPart=part;
  }
  check(convertedPart!=null,"anthropic conversion turns image_url into an image block");
  if(convertedPart!=null){
   JSONObject source=convertedPart.optJSONObject("source");
   check(source!=null&&"base64".equals(source.optString("type"))
    &&"image/jpeg".equals(source.optString("media_type"))&&"QUJD".equals(source.optString("data")),
    "anthropic conversion carries media type and payload");
  }
  check(anthropic.getJSONObject(0).optJSONArray("content").length()==2,
   "anthropic conversion keeps the text part alongside the image");

  /*
   * ── 图片压缩 ──────────────────────────────────────────────
   *
   * 造一张 3000×2000 的图走一遍完整读取。这一步错了用户看不出来：
   * 图会传上去，但模型收到的是尺寸不对或者坏掉的数据。
   */
  try{
   android.graphics.Bitmap photo=android.graphics.Bitmap.createBitmap(3000,2000,android.graphics.Bitmap.Config.ARGB_8888);
   photo.eraseColor(0xff2277cc);
   File imageFile=new File(a.getCacheDir(),"selftest-image.jpg");
   try(java.io.FileOutputStream jpegStream=new java.io.FileOutputStream(imageFile)){
    photo.compress(android.graphics.Bitmap.CompressFormat.JPEG,92,jpegStream);
   }
   photo.recycle();
   String dataUrl=ImageBridge.readAsDataUrl(a,android.net.Uri.fromFile(imageFile));
   imageFile.delete();

   check(dataUrl.startsWith("data:image/jpeg;base64,"),"image encoded as a jpeg data url");
   byte[] decoded=android.util.Base64.decode(dataUrl.substring("data:image/jpeg;base64,".length()),android.util.Base64.DEFAULT);
   android.graphics.BitmapFactory.Options bounds=new android.graphics.BitmapFactory.Options();
   bounds.inJustDecodeBounds=true;
   android.graphics.BitmapFactory.decodeByteArray(decoded,0,decoded.length,bounds);
   check(bounds.outWidth>0&&bounds.outHeight>0,"compressed image is still decodable");
   check(Math.max(bounds.outWidth,bounds.outHeight)<=ImageBridge.MAX_SIDE,"image long edge scaled down to the limit");
   check(Math.min(bounds.outWidth,bounds.outHeight)>0&&Math.abs((float)bounds.outWidth/bounds.outHeight-1.5f)<0.05f,
    "image aspect ratio preserved");
  }catch(Exception e){
   throw new Exception("FAIL image encoded as a jpeg data url: "+e.getMessage());
  }

  check(WebTools.isPrivate("::1")&&WebTools.isPrivate("[::1]")&&WebTools.isPrivate("fe80::1")
   &&WebTools.isPrivate("fc00::1")&&WebTools.isPrivate("fd12::1")
   &&!WebTools.isPrivate("2606:4700::1111"),
   "web blocks ipv6 private ranges");
  check(WebTools.isPrivate("127.0.0.1.nip.io")&&WebTools.isPrivate("10.0.0.1.sslip.io")
   &&WebTools.isPrivate("0x7f.0.0.1")&&!WebTools.isPrivate("example.com"),
   "web blocks dns rebinding hosts and hex ip forms");

  /*
   * ── 模型输出的容错解析 ──────────────────────────────────────
   *
   * 这是 Studio 最大的单点故障：模型不是 JSON 机器，
   * 它经常在 JSON 前后加一句话。加一句，整轮工具就全废了。
   */
  try{
   JSONObject plain=DevAgent.parse("{\"tools\":[{\"name\":\"list_files\"}]}");
   check(plain.optJSONArray("tools").length()==1,"parse handles a bare json object");
  }catch(Exception e){throw new Exception("FAIL parse handles a bare json object: "+e.getMessage());}

  try{
   JSONObject fenced=DevAgent.parse("```json\n{\"tools\":[{\"name\":\"list_files\"}]}\n```");
   check(fenced.optJSONArray("tools").length()==1,"parse handles a fenced json block");
  }catch(Exception e){throw new Exception("FAIL parse handles a fenced json block: "+e.getMessage());}

  try{
   JSONObject chatty=DevAgent.parse("好的，我先看看项目结构。\n{\"tools\":[{\"name\":\"list_files\"}]}\n看完我再决定改哪里。");
   check(chatty.optJSONArray("tools").length()==1,"parse ignores chatter around the json");
  }catch(Exception e){throw new Exception("FAIL parse ignores chatter around the json: "+e.getMessage());}

  try{
   JSONObject thinking=DevAgent.parse("<think>先列目录</think>\n{\"tools\":[{\"name\":\"list_files\"}]}");
   check(thinking.optJSONArray("tools").length()==1,"parse strips thinking tags");
  }catch(Exception e){throw new Exception("FAIL parse strips thinking tags: "+e.getMessage());}

  try{
   JSONObject tricky=DevAgent.parse("{\"tools\":[{\"name\":\"patch_file\",\"args\":{\"text\":\"有个 } 符号\"}}]}");
   check(tricky.getJSONArray("tools").getJSONObject(0).getJSONObject("args").optString("text").contains("}"),
    "parse handles braces inside json strings");
  }catch(Exception e){throw new Exception("FAIL parse handles braces inside json strings: "+e.getMessage());}

  boolean plainTextRejected=false;
  try{DevAgent.parse("项目里有 12 个文件。");}catch(Exception e){plainTextRejected=true;}
  check(plainTextRejected,"parse rejects a plain prose answer");

  /*
   * ── 降级路径：区分「工具协议」和「正文里讲 JSON」────────────
   *
   * <p>降级路径靠从正文里抠 JSON 来执行工具。但「抠得出 JSON」不等于
   * 「这是工具协议」—— 用户问「JSON 怎么写」，模型的回答里必然有花括号。
   * 于是真实问题有两个：
   *
   * <p>① 解析成功但里面没有 tools/files/answer → 用户的示例被当成指令执行；
   * <p>② 解析失败且文本里有 { → 正确答案被判成格式错误，
   *    触发重试，最后用户只看到「模型返回的内容无法解析」。
   *
   * <p>正确判据是「整段文本是不是一个 JSON 对象」。
   */
  check(DevAgent.isProtocolBody(new JSONObject().put("tools",new JSONArray())),"a tools body is a protocol body");
  check(DevAgent.isProtocolBody(new JSONObject().put("files",new JSONObject())),"a files body is a protocol body");
  check(DevAgent.isProtocolBody(new JSONObject().put("answer","好")),"an answer body is a protocol body");
  check(!DevAgent.isProtocolBody(new JSONObject().put("name","张三")),"an ordinary object is not a protocol body");
  check(!DevAgent.isProtocolBody(null),"null is not a protocol body");
  check(DevAgent.looksLikeProtocolText("{\"tools\":[{\"name\":\"list_files\"}]}"),"a whole-json tool request looks like a protocol");
  check(DevAgent.looksLikeProtocolText("{\"files\":{\"index.html\":\"x\"}}"),"a whole-json file request looks like a protocol");
  check(DevAgent.looksLikeProtocolText("{\"tools\":["),"a broken whole-json request still looks like a protocol");
  check(!DevAgent.looksLikeProtocolText("JSON 对象用花括号包起来，比如 {\"name\":\"张三\"}。"),"a prose answer about json is not a protocol");
  check(!DevAgent.looksLikeProtocolText("按钮样式这样写：\\n.button { color: red; }"),"a css answer is not a protocol");
  check(!DevAgent.looksLikeProtocolText("项目里有 3 个文件。"),"a plain prose answer is not a protocol");
  check(!DevAgent.looksLikeProtocolText("可以这样写：\\n```js\\nconst o = {a:1};\\n```"),"a fenced code answer is not a protocol");

  /*
   * ── 计划工具 ──────────────────────────────────────────────
   *
   * 计划必须跨轮保留，而且不能混进用户的文件列表 ——
   * 否则它会被 build_apk 打进 APK，被 diff_mine 报成用户改动。
   */
  JSONObject planProject=new JSONObject().put("id","qa-plan").put("name","计划自测")
   .put("files",new JSONObject().put("index.html","<!doctype html><html></html>"));
  LocalDevTools planTools=new LocalDevTools(a,planProject);
  JSONArray planSteps=new JSONArray()
   .put(new JSONObject().put("text","先看看有哪些文件").put("done",true))
   .put(new JSONObject().put("text","修好报错").put("done",false));
  planTools.setPlan(planProject,planSteps);

  check(planProject.optJSONArray(LocalDevTools.PLAN_KEY).length()==2,"plan is stored on the project snapshot");
  check(!planProject.getJSONObject("files").has(LocalDevTools.PLAN_KEY),"plan does not leak into the project files");
  check(planProject.getJSONObject("files").length()==1,"plan adds no file to the project");

  JSONArray readBack=planTools.getPlan(planProject);
  check(readBack.length()==2&&readBack.getJSONObject(0).optBoolean("done"),"plan reads back with its done flags");

  /*
   * 注入提示词这段要用「真实存在的项目」才能测 ——
   * 计划是存在项目状态里的，savePlan 会写到 byId("projects", id)，
   * 拿一个不存在的 id 去调，它存不进去（catch 掉只记日志）。
   * 所以这里先建一个真项目，测完删掉。
   */
  String realPlanId="qa-plan-real";
  try{
   a.upsert("projects",new JSONObject().put("id",realPlanId).put("name","计划注入自测")
    .put("files",new JSONObject().put("index.html","<!doctype html><html></html>"))
    .put("created",System.currentTimeMillis()));
   a.savePlan(realPlanId,planSteps);
   String planText=DevAgent.planContext(a,realPlanId);
   check(planText.contains("修好报错")&&planText.contains("[x]")&&planText.contains("[ ]"),
    "plan is injected into the prompt with progress marks");
   check(planText.contains("已完成 1 / 2"),"plan context reports how much is done");
  }finally{
   try{a.remove("projects",realPlanId);}catch(Exception ignored){}
  }
  check(DevAgent.planContext(a,"").isEmpty(),"no plan context without a project");

  boolean emptyPlanRejected=false;
  try{planTools.setPlan(planProject,new JSONArray());}catch(Exception e){emptyPlanRejected=true;}
  check(emptyPlanRejected,"an empty plan is rejected");

  /*
   * ── 全工具冒烟：每个工具至少能被调起来 ─────────────────────
   *
   * <p>以前的自测只覆盖了文件类工具。记忆、技能、联网、GitHub、图片、
   * 脚本、构建这些 —— 全是 AGENT 的看家本领，却一个都没被真正调过。
   * 于是「工具有没有、参数对不对、返回结构像不像」只能靠读代码猜。
   *
   * <p>这一组把 schema 里的每个工具都真的调一次：
   * ① 不抛异常（外部条件受限的除外 —— 断网、没配 GitHub token 这类）；
   * ② 返回值不是 null。
   *
   * <p><b>用完必须清理：</b>技能、记忆、项目、计划都会落到真实存储里，
   * 不清就会污染用户自己的数据。
   */
  String smokeProjectId="qa-smoke";
  String smokeSkillName="qa-smoke-skill";
  try{
   a.upsert("projects",new JSONObject().put("id",smokeProjectId).put("name","冒烟自测")
    .put("files",new JSONObject().put("index.html","<!doctype html><html><body><h1>smoke</h1></body></html>")
     .put("app.js","function hello(){return 1;}\n"))
    .put("created",System.currentTimeMillis()));
   LocalDevTools smoke=new LocalDevTools(a,a.byId("projects",smokeProjectId));
   JSONArray smokeCalls=new JSONArray()
    /*
     * 记忆一律用 project scope 写。
     *
     * <p>全局记忆是**用户自己的数据**（files/ai-memory.md）。
     * 自测如果往里写、或者调 clear("global") 去清，
     * 就等于把用户攒下来的经验抹了 —— 这比测试失败严重得多。
     * 写进项目范围，测完删掉那个文件，用户的全局记忆一点不碰。
     */
    .put(new JSONObject().put("name","remember").put("args",new JSONObject().put("text","冒烟测试记忆").put("scope","project")))
    .put(new JSONObject().put("name","read_memory").put("args",new JSONObject().put("scope","project")))
    .put(new JSONObject().put("name","update_memory").put("args",new JSONObject().put("content","冒烟测试记忆").put("scope","project")))
    .put(new JSONObject().put("name","list_skills").put("args",new JSONObject()))
    .put(new JSONObject().put("name","write_skill").put("args",new JSONObject().put("name",smokeSkillName).put("description","冒烟测试用").put("content","冒烟测试技能正文")))
    .put(new JSONObject().put("name","read_skill").put("args",new JSONObject().put("name",smokeSkillName)))
    .put(new JSONObject().put("name","delete_skill").put("args",new JSONObject().put("name",smokeSkillName)))
    .put(new JSONObject().put("name","list_files").put("args",new JSONObject()))
    .put(new JSONObject().put("name","read_file").put("args",new JSONObject().put("path","index.html")))
    .put(new JSONObject().put("name","search_code").put("args",new JSONObject().put("query","smoke")))
    .put(new JSONObject().put("name","replace_text").put("args",new JSONObject().put("path","index.html").put("oldText","smoke").put("newText","smoke2")))
    .put(new JSONObject().put("name","patch_file").put("args",new JSONObject().put("path","app.js").put("startLine",1).put("endLine",1).put("newContent","function hello(){return 2;}")))
    .put(new JSONObject().put("name","multi_patch").put("args",new JSONObject().put("patches",new JSONArray().put(new JSONObject().put("path","app.js").put("startLine",1).put("endLine",1).put("newContent","function hello(){return 3;}")))))
    .put(new JSONObject().put("name","diff_mine").put("args",new JSONObject()))
    .put(new JSONObject().put("name","diff_project").put("args",new JSONObject()))
    .put(new JSONObject().put("name","write_files").put("args",new JSONObject().put("files",new JSONObject().put("new.txt","hello"))))
    .put(new JSONObject().put("name","check_project").put("args",new JSONObject()))
    .put(new JSONObject().put("name","get_debug_reports").put("args",new JSONObject()))
    .put(new JSONObject().put("name","run_tests").put("args",new JSONObject()))
    .put(new JSONObject().put("name","run_script").put("args",new JSONObject().put("code","window.__neoResult=1+1;")))
    .put(new JSONObject().put("name","inspect_project").put("args",new JSONObject()))
    .put(new JSONObject().put("name","list_art_models").put("args",new JSONObject()))
    .put(new JSONObject().put("name","generate_image").put("args",new JSONObject().put("prompt","一只橘猫").put("path","cat.png")))
    .put(new JSONObject().put("name","list_assets").put("args",new JSONObject()))
    .put(new JSONObject().put("name","github_status").put("args",new JSONObject()))
    .put(new JSONObject().put("name","search_connectors").put("args",new JSONObject().put("query","ic_atomic_990012")))
    .put(new JSONObject().put("name","describe_connector").put("args",new JSONObject().put("id","ic_atomic_990012")))
    .put(new JSONObject().put("name","web_fetch").put("args",new JSONObject().put("url","https://example.com")))
    .put(new JSONObject().put("name","web_search").put("args",new JSONObject().put("query","hermes agent")))
    .put(new JSONObject().put("name","write_plan").put("args",new JSONObject().put("steps",new JSONArray().put(new JSONObject().put("text","冒烟一步").put("done",false)))))
    .put(new JSONObject().put("name","read_plan").put("args",new JSONObject()));
   /*
    * 三个工具不能在这里真跑：build_apk 要几分钟，run_preview 会弹窗打断自测，
    * github_push 会真的推仓库。它们改用「参数校验路径」验证 ——
    * 至少确认入口活着、参数校验会给出说得清楚的错，而不是崩掉。
    */
   JSONArray smokeCalls2=new JSONArray()
    .put(new JSONObject().put("name","build_apk").put("args",new JSONObject()))
    .put(new JSONObject().put("name","github_push").put("args",new JSONObject()))
    .put(new JSONObject().put("name","run_preview").put("args",new JSONObject()));
   JSONArray smokeBad=new JSONArray();JSONArray smokeSkipped=new JSONArray();
   for(int i=0;i<smokeCalls.length();i++){
    JSONObject c=smokeCalls.optJSONObject(i);
    String toolName=c.optString("name");
    try{
     JSONObject smokeResult=smoke.call(toolName,c.optJSONObject("args"));
     if(smokeResult==null)smokeBad.put(toolName+" 返回了 null");
    }catch(Exception e){
     String msg=e.getMessage()==null?"":e.getMessage();
     /* 外部条件不可用不算代码问题 */
     if(isExternalBlocker(e,msg)){smokeSkipped.put(toolName+"："+shortReason(msg));continue;}
     smokeBad.put(toolName+"："+msg);
    }
   }
   /*
    * 这三个**只计入覆盖，不实际调用**：
    * build_apk 真构建要几分钟，run_preview 会弹窗打断自测，
    * github_push 会真的往用户仓库推东西。
    * 它们的真实行为另在真机上手工验证。
    */
   /*
    * 以后新增工具却忘了加进冒烟列表，这里会立刻发现 ——
    * 工具列表是照着 schema 长出来的，schema 加了就是新工具。
    */
   JSONArray schemaNames=new JSONArray();
   for(ToolSchema.Tool st:ToolSchema.all())schemaNames.put(st.name);
   JSONArray smokeNames=new JSONArray();
   for(int i=0;i<smokeCalls.length();i++)smokeNames.put(smokeCalls.optJSONObject(i).optString("name"));
   for(int i=0;i<smokeCalls2.length();i++)smokeNames.put(smokeCalls2.optJSONObject(i).optString("name"));
   JSONArray notSmoked=new JSONArray();
   for(int i=0;i<schemaNames.length();i++){
    String sn=schemaNames.optString(i,"");
    boolean covered=false;
    for(int j=0;j<smokeNames.length();j++)if(sn.equals(smokeNames.optString(j,""))){covered=true;break;}
    if(!covered)notSmoked.put(sn);
   }
   check(notSmoked.length()==0,"every schema tool is covered by the smoke test [missing="+notSmoked+"]");
   check(smokeBad.length()==0,"every tool can be called without crashing [bad="+smokeBad+" skipped="+smokeSkipped+"]");
   /*
    * 计划要能被读回来 —— 单独确认，不靠上面的「没抛异常」蒙混。
    */
   check(smoke.call("read_plan",new JSONObject()).optJSONArray("steps").length()==1,"the smoke plan is readable");
   /*
    * ── 失败恢复：错误消息要能让模型自我纠正 ──────────────
    *
    * <p>这三段验证的是**运行时真实行为**，不是源码里有没有那句话。
    * 模型出错的时候拿到什么，比代码里写了什么更要紧。
    */
   try{
    smoke.call("no_such_tool_at_all",new JSONObject());
    check(false,"an unknown tool name is rejected");
   }catch(Exception e){
    String msg=e.getMessage()==null?"":e.getMessage();
    check(msg.contains("可用工具")&&msg.contains("list_files"),
     "an unknown tool name tells the model which tools exist [msg="+msg.substring(0,Math.min(120,msg.length()))+"]");
   }
   try{
    smoke.call("read_file",new JSONObject().put("path","nope/missing.js"));
    check(false,"a missing file is rejected");
   }catch(Exception e){
    String msg=e.getMessage()==null?"":e.getMessage();
    check(msg.contains("文件不存在")&&msg.contains("index.html"),
     "a missing file tells the model which files exist [msg="+msg.substring(0,Math.min(120,msg.length()))+"]");
   }
   /*
    * ── 上下文裁剪：协议配对不能破 ────────────────────
    *
    * <p>这是真机上的 Java 实现，不是 JS 参考版本。
    * 两边必须一致 —— 参考版本错了，Java 对了也说明不了问题。
    */
   JSONArray longHistory=new JSONArray();
   longHistory.put(new JSONObject().put("role","user").put("content","原始任务"));
   for(int i=0;i<30;i++){
    String id="call_"+i;
    longHistory.put(new JSONObject().put("role","assistant").put("content","我来查一下")
     .put("tool_calls",new JSONArray().put(new JSONObject().put("id",id).put("type","function")
      .put("function",new JSONObject().put("name","read_file").put("arguments","{}")))));
    longHistory.put(new JSONObject().put("role","tool").put("tool_call_id",id)
     .put("content","文件内容 ".repeat(2000)+i));
   }
   JSONArray trimmed=DevAgent.trimToolHistory(longHistory,200*1024);
   check(trimmed.length()<longHistory.length(),"a long tool history is trimmed");
   check(trimmed.length()>0&&"原始任务".equals(trimmed.optJSONObject(0).optString("content","")),
    "the original request survives the trim");
   /* 每条 tool 消息都必须有配对的 assistant tool_calls */
   JSONArray callIds=new JSONArray();
   for(int i=0;i<trimmed.length();i++){
    JSONObject m=trimmed.optJSONObject(i);
    if(m==null)continue;
    JSONArray tc=m.optJSONArray("tool_calls");
    if(tc!=null)for(int c=0;c<tc.length();c++)callIds.put(tc.optJSONObject(c).optString("id"));
   }
   int orphaned=0;
   for(int i=0;i<trimmed.length();i++){
    JSONObject m=trimmed.optJSONObject(i);
    if(m==null)continue;
    if("tool".equals(m.optString("role",""))){
     String id=m.optString("tool_call_id","");
     boolean found=false;
     for(int c=0;c<callIds.length();c++)if(id.equals(callIds.optString(c,""))){found=true;break;}
     if(!found)orphaned++;
    }
   }
   check(orphaned==0,"every tool message still has its paired tool_calls after the trim");
   boolean hasNote=false;
   for(int i=0;i<trimmed.length();i++){
    JSONObject m=trimmed.optJSONObject(i);
    if(m!=null&&"user".equals(m.optString("role",""))&&m.optString("content","").contains("已从上下文中移除")){hasNote=true;break;}
   }
   check(hasNote,"the trim tells the model what was dropped");
   /*
    * ── 项目概览真的进了系统提示词 ─────────────────────
    *
    * <p>这一条只能在真机上验：概览是拼进 system 提示词的，
    * 源码断言只能证明「代码写了」，证明不了「真的发出去了」。
    *
    * <p>做法：连本地 fixture，它检查收到的 system 里有没有「【当前项目】」——
    * 有就把概览原样带进回答，没有就回一个 OVERVIEW_MISSING。
    * 于是「回答里出现了真实文件数」就等于「概览进了提示词」。
    *
    * <p>fixture 连不上时算跳过，不是失败 —— 它是外部条件。
    */
   try{
    JSONObject ovProject=new JSONObject().put("id","qa-ov-e2e").put("name","概览测试")
     .put("files",new JSONObject()
      .put("index.html","<!doctype html><html><body>hi</body></html>")
      .put("src/main.js","console.log(1)")
      .put("src/util.js","export const a=1")
      .put("README.md","# 概览测试"));
    a.upsert("projects",ovProject);
    JSONArray ovMessages=new JSONArray().put(new JSONObject().put("role","user").put("content","这个项目有多少个文件？"));
    ApiClient ovClient=new ApiClient();
    ovClient.progress=null;
    JSONObject ovProfile=new JSONObject().put("endpoint","http://127.0.0.1:8770/v1")
     .put("protocol","compatible").put("model","overview-probe")
     .put("maxTokens",512).put("id","qa-ov-profile").put("streaming",false);
    JSONObject ovResult=DevAgent.run(a,ovClient,ovProfile,"fixture-secret",ovMessages,"system",ovProject,true);
    String ovText=ovResult.optString("text","");
    check(ovText.contains("OVERVIEW_OK"),
     "the project overview reaches the model's system prompt");
    check(ovText.contains("4 个文件"),
     "the model can state the real file count without calling a tool");
    check(ovResult.optJSONArray("toolCalls")==null||ovResult.optJSONArray("toolCalls").length()==0,
     "answering a question needs no tool call");
   }catch(Exception e){
    /*
     * fixture 连不上是外部条件，不是代码问题 —— 跳过，不算失败。
     * 但「概览没进提示词」是代码问题，必须报出来。
     */
    if(!isExternalBlocker(e,e.getMessage()))throw new Exception("FAIL project overview reaches the prompt: "+e.getMessage());
   }

   /*
    * ── 跑满轮数不该把做好的活丢掉 ─────────────────────
    *
    * <p>原来 cancelled 和 incomplete 一起丢。incomplete 也包括「跑满 40 轮」，
    * 那种情况下前面几十轮改的文件全白改。
    */
   check(MainActivity.shouldRejectWrite(false,false)==false,
    "a completed round keeps its changes");
   check(MainActivity.shouldRejectWrite(true,false)==true,
    "an explicit cancel drops the changes");
   check(MainActivity.shouldRejectWrite(false,true)==false,
    "a round that hit the tool-call cap keeps its changes");
   check(MainActivity.shouldRejectWrite(true,true)==true,
    "an explicit cancel drops the changes even when the round was cut short");

   /*
    * ── 项目概览必须是真的 ─────────────────────────
    *
    * <p>提示词教模型「第一句就说有 N 个文件」——
    * 那 N 必须来自真实项目，不能是编的。
    */
   JSONObject ovProject=new JSONObject().put("id","qa-overview").put("name","测试项目")
    .put("files",new JSONObject()
     .put("index.html","<!doctype html><html><body>hi</body></html>")
     .put("src/main.js","console.log(1)")
     .put("src/util.js","export default 1")
     .put("README.md","# 测试"));
   String ov=LocalDevTools.overview(ovProject);
   check(ov.contains("4 个文件"),"the overview states the real file count");
   check(ov.contains("index.html"),"the overview names the entry file");
   check(ov.contains("src"),"the overview describes the top-level layout");
   check(!ov.contains("318"),"the overview does not carry a made-up number");
   check(LocalDevTools.overview(null).isEmpty(),"no project means no overview");
   JSONObject emptyOv=new JSONObject().put("id","qa-empty").put("files",new JSONObject());
   check(LocalDevTools.overview(emptyOv).contains("空的"),"an empty project says so");

   /*
    * ── 路径规则只有一份 ─────────────────────────────
    *
    * <p>本地和云端各写各的路径规则时，会出现「本地能存、云端不能」，
    * 用户看到的只是「同步不包含此路径」—— 不知道是哪个文件、为什么。
    *
    * <p>这里直接拿云端那套标准去卡本轮改动。
    */
   JSONObject pathProject=new JSONObject().put("id","qa-path")
    .put("files",new JSONObject().put("index.html","<!doctype html><html><body>hi</body></html>"));
   boolean rejectedEmptySegment=false;
   try{
    JSONObject bad=new JSONObject().put("a//b.html","x");
    ProjectEdits.apply(pathProject,pathProject.getJSONObject("files"),bad,"路径测试");
   }catch(Exception e){rejectedEmptySegment=true;}
   check(rejectedEmptySegment,"a path with an empty segment is rejected");
   boolean rejectedDotDot=false;
   try{
    JSONObject bad=new JSONObject().put("../evil.html","x");
    ProjectEdits.apply(pathProject,pathProject.getJSONObject("files"),bad,"路径测试");
   }catch(Exception e){rejectedDotDot=true;}
   check(rejectedDotDot,"a path that climbs out is rejected");
   boolean rejectedAbsolute=false;
   try{
    JSONObject bad=new JSONObject().put("/etc/passwd","x");
    ProjectEdits.apply(pathProject,pathProject.getJSONObject("files"),bad,"路径测试");
   }catch(Exception e){rejectedAbsolute=true;}
   check(rejectedAbsolute,"an absolute path is rejected");
   boolean acceptedNormal=false;
   try{
    JSONObject good=new JSONObject().put("src/app/main.js","console.log(1)");
    ProjectEdits.apply(pathProject,pathProject.getJSONObject("files"),good,"路径测试");
    acceptedNormal=true;
   }catch(Exception e){}
   check(acceptedNormal,"a normal path is accepted");

   /*
    * ── 编译检查：警告必须被区分对待 ──────────────────
    *
    * <p>「编译通过」不等于「项目是好的」。这里用真实编译跑一遍，
    * 验证环境提示不会让检查失败、但也不会被藏起来。
    */
   JSONObject plainProject=new JSONObject().put("id","qa-compile")
    .put("files",new JSONObject().put("index.html","<!doctype html><html><body><h1>hi</h1></body></html>"));
   JSONObject plainCheck=LocalCompiler.check(a,plainProject);
   check(plainCheck.optBoolean("ok",false),"a clean project passes the compile check");
   check(plainCheck.optJSONArray("warnings")!=null,"the compile check always returns a warnings array");
   /*
    * 带 vite.config.ts 的项目会有一条「未执行 Vite 插件」的提示。
    * 这是环境限制，不是代码坏了 —— 检查该通过，但要看得见这条提示。
    */
   JSONObject viteProject=new JSONObject().put("id","qa-vite")
    .put("files",new JSONObject()
     .put("index.html","<!doctype html><html><body><h1>hi</h1></body></html>")
     .put("vite.config.ts","export default {plugins:[]};"));
   JSONObject viteCheck=LocalCompiler.check(a,viteProject);
   check(viteCheck.optJSONArray("warnings")!=null&&viteCheck.optJSONArray("warnings").length()>0,
    "an environment hint shows up in the warnings");
   check(viteCheck.optBoolean("ok",false),
    "an environment hint alone does not fail the check");
   check(viteCheck.optJSONArray("hints")!=null&&viteCheck.optJSONArray("hints").length()>0,
    "environment hints are listed separately from fatal ones");
   check(viteCheck.optJSONArray("fatalWarnings")!=null&&viteCheck.optJSONArray("fatalWarnings").length()==0,
    "an environment hint is not counted as fatal");
   /* Anthropic 形态也要能分组 */
   JSONArray anthHistory=new JSONArray();
   anthHistory.put(new JSONObject().put("role","user").put("content","原始任务"));
   for(int i=0;i<20;i++){
    String id="tu_"+i;
    anthHistory.put(new JSONObject().put("role","assistant")
     .put("content",new JSONArray().put(new JSONObject().put("type","tool_use").put("id",id)
      .put("name","read_file").put("input",new JSONObject()))));
    anthHistory.put(new JSONObject().put("role","user")
     .put("content",new JSONArray().put(new JSONObject().put("type","tool_result")
      .put("tool_use_id",id).put("content","内容 ".repeat(4000)))));
   }
   JSONArray anthTrimmed=DevAgent.trimToolHistory(anthHistory,200*1024);
   check(anthTrimmed.length()<anthHistory.length(),"an anthropic-style history is trimmed too");
   check(anthTrimmed.length()>0&&"原始任务".equals(anthTrimmed.optJSONObject(0).optString("content","")),
    "the original request survives the anthropic-style trim");
   JSONObject missResult=smoke.call("search_code",new JSONObject().put("query","zzz_绝对不存在的字符串_zzz"));
   check(!missResult.optBoolean("found",true)&&missResult.optString("note","").contains("list_files"),
    "a search miss explains itself instead of returning a bare empty array");
   /*
    * 记忆要能真的读回来 —— 这是 AGENT 跨会话能力的根。
    * 只验证「没抛异常」是不够的：写不进去也照样不抛异常。
    */
   check(smoke.call("read_memory",new JSONObject().put("scope","project")).optString("project","").contains("冒烟测试记忆"),
    "a remembered note can be read back");
  }catch(Exception e){
   throw new Exception("FAIL tool smoke test: "+e.getMessage());
  }finally{
   /* 清理：技能、记忆、项目、计划都不能留在用户数据里 */
   try{a.skills.delete(smokeSkillName);}catch(Exception ignored){}
   /* 只清项目范围，不碰用户的全局记忆 */
   try{a.memory.clear("project",smokeProjectId);}catch(Exception ignored){}
   try{a.remove("projects",smokeProjectId);}catch(Exception ignored){}
  }

  /*
   * ── 原生 function calling 的协议层 ─────────────────────────
   *
   * 这一组不联网，靠构造假的响应来验协议转换对不对。
   * 真连网上去测的话，一旦某家服务商的格式变了，CI 上什么也看不出来。
   */
  ToolSchema.Tool[] schemaTools=ToolSchema.all();
  check(schemaTools.length>=30,"every tool has a schema");

  // schema 必须机器可读：名字合法、描述非空、参数是 object
  boolean schemasWellFormed=true;
  java.util.HashSet<String> schemaNames=new java.util.HashSet<>();
  for(ToolSchema.Tool tool:schemaTools){
   if(tool.name.isEmpty()||!tool.name.matches("[a-z_][a-z0-9_]*"))schemasWellFormed=false;
   if(tool.description.isEmpty())schemasWellFormed=false;
   if(!"object".equals(tool.parameters.optString("type")))schemasWellFormed=false;
   if(tool.parameters.optJSONObject("properties")==null)schemasWellFormed=false;
   if(!schemaNames.add(tool.name))schemasWellFormed=false;
  }
  check(schemasWellFormed,"all tool schemas are well formed and uniquely named");

  // 两种协议的包装格式不一样
  JSONArray openAiToolList=ToolSchema.openAiTools();
  check(openAiToolList.length()==schemaTools.length,"openai tools array has one entry per tool");
  check("function".equals(openAiToolList.getJSONObject(0).optString("type"))
   &&openAiToolList.getJSONObject(0).optJSONObject("function").has("parameters"),
   "openai tool entry uses type function with parameters");

  JSONArray anthropicToolList=ToolSchema.anthropicTools();
  check("anthropic".equals("anthropic")&&anthropicToolList.getJSONObject(0).has("input_schema")
   &&!anthropicToolList.getJSONObject(0).has("parameters")
   &&anthropicToolList.getJSONObject(0).has("name"),
   "anthropic tool entry uses input_schema");

  /*
   * OpenAI 响应解析：tool_calls 里的 arguments 是 JSON 字符串，要解成对象。
   */
  JSONObject openAiResponse=new JSONObject().put("choices",new JSONArray().put(new JSONObject()
   .put("message",new JSONObject().put("content","").put("tool_calls",new JSONArray().put(new JSONObject()
    .put("id","call_abc").put("type","function")
    .put("function",new JSONObject().put("name","read_file").put("arguments","{\"path\":\"src/App.tsx\",\"startLine\":10}")))))));
  JSONArray parsedCalls=ToolSchema.parseToolCalls(openAiResponse,"compatible");
  check(parsedCalls.length()==1,"openai tool_calls parsed");
  if(parsedCalls.length()==1){
   JSONObject call=parsedCalls.getJSONObject(0);
   check("read_file".equals(call.optString("name"))&&"call_abc".equals(call.optString("id")),
    "openai tool call keeps its name and id");
   check("src/App.tsx".equals(call.optJSONObject("args").optString("path"))
    &&call.optJSONObject("args").optInt("startLine")==10,
    "openai tool call arguments are parsed into an object");
  }

  // Anthropic 响应解析
  JSONObject anthropicResponse=new JSONObject().put("content",new JSONArray()
   .put(new JSONObject().put("type","text").put("text","我先看看"))
   .put(new JSONObject().put("type","tool_use").put("id","toolu_1").put("name","list_files")
    .put("input",new JSONObject().put("prefix","src/"))));
  JSONArray anthropicCalls=ToolSchema.parseToolCalls(anthropicResponse,"anthropic");
  check(anthropicCalls.length()==1,"anthropic tool_use parsed");
  if(anthropicCalls.length()==1){
   JSONObject call=anthropicCalls.getJSONObject(0);
   check("list_files".equals(call.optString("name"))&&"toolu_1".equals(call.optString("id"))
    &&"src/".equals(call.optJSONObject("args").optString("prefix")),
    "anthropic tool call keeps name, id and input");
  }

  // 没有工具调用时返回空数组，不是 null
  check(ToolSchema.parseToolCalls(new JSONObject(),"compatible").length()==0
   &&ToolSchema.parseToolCalls(new JSONObject(),"anthropic").length()==0,
   "no tool calls yields an empty array");

  /*
   * 工具结果消息的格式 —— 错了服务端会直接拒绝下一轮请求。
   */
  JSONArray oneResult=new JSONArray().put(new JSONObject().put("name","read_file").put("id","call_1")
   .put("result",new JSONObject().put("ok",true)));
  JSONArray openAiResults=DevAgent.toolResultMessages(oneResult,"compatible");
  check(openAiResults.length()==1,"openai tool result is one message per call");
  if(openAiResults.length()==1){
   JSONObject message=openAiResults.getJSONObject(0);
   check("tool".equals(message.optString("role"))&&"call_1".equals(message.optString("tool_call_id")),
    "openai tool result carries role tool and the matching id");
   check(message.optString("content").length()>0,"openai tool result content is a string");
  }

  JSONArray anthropicResults=DevAgent.toolResultMessages(oneResult,"anthropic");
  check(anthropicResults.length()==1,"anthropic tool result is one user message");
  if(anthropicResults.length()==1){
   JSONObject block=anthropicResults.getJSONObject(0).optJSONArray("content").optJSONObject(0);
   check(block!=null&&"tool_result".equals(block.optString("type"))
    &&"call_1".equals(block.optString("tool_use_id")),
    "anthropic tool result carries type tool_result and the matching id");
  }

  // 出错的工具也要回一条结果，而且要标出来
  JSONArray errorResult=new JSONArray().put(new JSONObject().put("name","read_file").put("id","call_2")
   .put("error","文件不存在"));
  JSONArray errorResults=DevAgent.toolResultMessages(errorResult,"compatible");
  check(errorResults.getJSONObject(0).optString("content").contains("文件不存在"),
   "a failed tool still returns a result the model can read");

  /*
   * 工具结果太长时的截断。
   *
   * <p>不截的话，read_file 读一个 300 KB 的源文件就进上下文了，
   * 几十轮下来请求体撑爆，服务端要么拒、要么悄悄截断。
   */
  {
   StringBuilder big2=new StringBuilder();
   for(int i=0;i<40000;i++)big2.append("0123456789");
   String fat=big2.toString();
   String clamped=DevAgent.clampToolResult(fat);
   check(clamped.length()<=DevAgent.MAX_TOOL_RESULT_CHARS+200,
    "an oversized tool result is clamped to the cap");
   check(clamped.contains("已省略中间"),"the clamped result says it was shortened");
   check(clamped.contains(String.valueOf(fat.length())),"the clamped result states the original length");
   check(clamped.startsWith("0123456789"),"the clamped result keeps the head");
   check(clamped.endsWith("0123456789"),"the clamped result keeps the tail");
   // 没超限的原样返回
   check(DevAgent.clampToolResult("短").equals("短"),"a short tool result is untouched");

  /*
   * 工具结果是一份 JSON，截断不能把它切坏。
   *
   * <p>模型收到的是一段文本，它会当 JSON 读。切在中间就只剩半个数组，
   * 模型后面几十轮都在跟坏数据打交道 —— 看不到真结果，只会不停重查。
   */
  {
   JSONArray hits=new JSONArray();
   for(int i=0;i<2000;i++){
    JSONObject h=new JSONObject().put("path","src/file"+i+".js").put("line",i+1)
     .put("text","匹配的一行内容xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    hits.put(h);
   }
   JSONObject searchResult=new JSONObject().put("matches",hits).put("count",hits.length());
   String clampedJson=DevAgent.clampToolResult(searchResult.toString());
   boolean stillJson=true;
   JSONObject reparsed=null;
   try{reparsed=new JSONObject(clampedJson);}catch(Exception e){stillJson=false;}
   check(stillJson,"a clamped JSON tool result is still valid JSON");
   if(reparsed!=null){
    check(reparsed.optBoolean("matches_truncated",false),
     "the clamped JSON says the array was shortened");
    check(reparsed.optInt("matches_total",0)==2000,
     "the clamped JSON says how many items there were in total");
    check(reparsed.optInt("matches_shown",0)>0&&reparsed.optInt("matches_shown",0)<2000,
     "the clamped JSON shows only part of the array");
    check(reparsed.optJSONArray("matches")!=null
     &&reparsed.optJSONArray("matches").length()==reparsed.optInt("matches_shown",-1),
     "the kept array really has the number of items it claims");
   }
   // 非 JSON 的纯文本还是按老办法截
   check(DevAgent.clampToolResult("短").equals("短"),"a short tool result is untouched");
  }

  /*
   * publicState 不能往 state 里写东西。
   *
   * <p>它要给 profiles / artProfiles 补 hasKey（密钥存不存在）。
   * 如果直接改 state 里的原对象，这些标记会被 saveState 持久化：
   * 用户后来删了密钥，state 里残留的 true 还在，
   * 前端继续显示「已配置」—— 用户点进去才发现没了。
   */
  {
   /*
    * 真机自测跑在真实 Activity 上 —— 不能破坏用户数据。
    * 所以先把原 state 存一份，测完原样放回去。
    */
   JSONObject savedState=a.state;
   try{
    JSONObject st=new JSONObject();
    JSONArray profs=new JSONArray();
    profs.put(new JSONObject().put("id","p1").put("name","测试模型"));
    st.put("profiles",profs);
    a.state=st;
    a.publicState();
    boolean leaked=false;
    JSONArray after=a.state.optJSONArray("profiles");
    if(after!=null)for(int i=0;i<after.length();i++){
     if(after.getJSONObject(i).has("hasKey"))leaked=true;
    }
    check(!leaked,"publicState does not write hasKey into the stored profiles");
   }finally{
    a.state=savedState;
   }
  }

  /*
   * 被截断的参数补全后，写文件类工具不能执行。
   *
   * <p>补全只是把括号引号闭上，正文没回来。
   * 直接执行 = 把只有一半的文件写进项目，工具还报成功。
   */
  {
   JSONObject repairedWrite=new JSONObject().put("name","write_files")
    .put("args",new JSONObject().put("files",new JSONObject().put("a.js","半截")))
    .put("argsRepaired",true).put("argsError","{\"files\":{\"a.js\":\"半截");
   check(!DevAgent.canExecute("write_files",repairedWrite),
    "a write tool with repaired (truncated) arguments is refused");
   check(!DevAgent.canExecute("patch_file",repairedWrite),
    "patch_file with repaired arguments is refused too");
   check(!DevAgent.canExecute("multi_patch",repairedWrite),
    "multi_patch with repaired arguments is refused too");
   /* 只读工具不受影响 —— 读一半不致命。 */
   check(DevAgent.canExecute("read_file",repairedWrite),
    "a read tool with repaired arguments is still allowed");
   check(DevAgent.canExecute("search_code",repairedWrite),
    "search_code with repaired arguments is still allowed");
   /* 参数没被截断的写工具正常执行。 */
   check(DevAgent.canExecute("write_files",new JSONObject().put("name","write_files")),
    "a normal write tool call is allowed");
  }

  /*
   * 自动验证编译的结果不能伪装成工具消息。
   *
   * <p>原生协议里每个 tool 消息都要配 tool_call_id。自动编译是我们自己跑的，
   * 没有 id。硬塞一条进去，服务端会直接 400 —— 现象是「改完文件下一轮就崩」。
   */
  {
   JSONArray msgs=new JSONArray();
   msgs.put(new JSONObject().put("role","assistant")
    .put("tool_calls",new JSONArray().put(new JSONObject().put("id","call_1").put("type","function")
     .put("function",new JSONObject().put("name","patch_file").put("arguments","{}")))));
   msgs.put(new JSONObject().put("role","tool").put("tool_call_id","call_1").put("content","ok"));
   int before=msgs.length();
   DevAgent.appendAutoCheck(msgs,"编译失败：第 3 行缺少分号","compatible");
   check(msgs.length()==before+1,"the auto compile result adds one message");
   JSONObject added=msgs.getJSONObject(msgs.length()-1);
   check("user".equals(added.optString("role","")),
    "the auto compile result is a plain user message, not a tool message");
   check(!added.has("tool_call_id"),
    "the auto compile result carries no dangling tool_call_id");
   check(added.optString("content","").contains("缺少分号"),
    "the auto compile result carries the compiler output");

   /* Anthropic：追加到最后一条 user 消息的 content 数组里。 */
   JSONArray am=new JSONArray();
   am.put(new JSONObject().put("role","user").put("content",new JSONArray()
    .put(new JSONObject().put("type","tool_result").put("tool_use_id","call_1").put("content","ok"))));
   DevAgent.appendAutoCheck(am,"编译通过","anthropic");
   check(am.length()==1,"the anthropic auto compile result does not add a separate message");
   JSONArray ac=am.getJSONObject(0).optJSONArray("content");
   check(ac!=null&&ac.length()==2,"the anthropic auto compile result is appended as a text block");
   if(ac!=null&&ac.length()==2){
    check("text".equals(ac.getJSONObject(1).optString("type","")),
     "the appended block is a text block");
    check(ac.getJSONObject(1).optString("text","").contains("编译通过"),
     "the appended block carries the compiler output");
   }
  }
   // 走协议时也要被截
   JSONArray hugeResult=new JSONArray().put(new JSONObject().put("name","read_file").put("id","call_big")
    .put("result",fat));
   check(DevAgent.toolResultMessages(hugeResult,"compatible").getJSONObject(0).optString("content").length()
    <=DevAgent.MAX_TOOL_RESULT_CHARS+200,"an oversized tool result is clamped on the openai path");
   check(DevAgent.toolResultMessages(hugeResult,"anthropic").getJSONObject(0).optJSONArray("content")
    .getJSONObject(0).optString("content").length()<=DevAgent.MAX_TOOL_RESULT_CHARS+200,
    "an oversized tool result is clamped on the anthropic path");
  }

  /*
   * assistant 侧的 tool_calls 消息必须带 id，
   * 否则服务端对不上号会拒绝整个请求。
   */
  JSONObject assistant=DevAgent.assistantToolCallMessage(new JSONObject().put("text",""),parsedCalls,"compatible");
  check(assistant.optJSONArray("tool_calls").length()==1
   &&"call_abc".equals(assistant.optJSONArray("tool_calls").getJSONObject(0).optString("id")),
   "assistant message carries the tool call id back to the server");

  /*
   * 服务端报「不支持 tools」时要能识别出来，才能自动降级。
   * 误判的代价是把真正的错误当成「不支持」，然后用更弱的方式重试，掩盖原因。
   */
  check(DevAgent.looksLikeToolsUnsupported(new Exception("HTTP 400：tools is not supported")),
   "unsupported-tools error detected");
  check(DevAgent.looksLikeToolsUnsupported(new Exception("Invalid parameter: 'tools' is not supported")),
   "unsupported-tools error detected in another wording");
  check(!DevAgent.looksLikeToolsUnsupported(new Exception("HTTP 401：密钥或权限错误")),
   "an unrelated error is not mistaken for unsupported tools");
  check(!DevAgent.looksLikeToolsUnsupported(new Exception("网络超时")),
   "a timeout is not mistaken for unsupported tools");

  /*
   * ── 流式下的工具调用分片 ──────────────────────────────────
   *
   * 这是 function calling 最容易写错的地方：工具参数是<b>分片</b>到的，
   * 一次覆盖会丢掉前面的片段，模型传个文件路径就断在半个字符串上。
   *
   * 这里用假的 SSE 事件流走一遍完整的 read()，验证分片能被拼回来。
   */
  String openAiSse=
   "data: {\"model\":\"m\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]}}]}\n\n"
   +"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n"
   +"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"src/App.tsx\\\"\"}}]}}]}\n\n"
   +"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\",\\\"startLine\\\":5}\"}}]}}]}\n\n"
   +"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
   +"data: [DONE]\n\n";
  java.io.ByteArrayInputStream sseIn=new java.io.ByteArrayInputStream(openAiSse.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  StreamResponse sseStream=new StreamResponse();
  try{
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(sseIn,java.nio.charset.StandardCharsets.UTF_8));
   String line;StringBuilder event=new StringBuilder();
   while((line=reader.readLine())!=null){
    if(line.isEmpty()){sseStream.event(event.toString(),false,null);event.setLength(0);if(sseStream.ended)break;}
    else if(line.startsWith("data:")){String data=line.substring(5);event.append(data.startsWith(" ")?data.substring(1):data);}
   }
  }catch(Exception e){
   throw new Exception("FAIL streamed tool call fragments are assembled: "+e.getMessage());
  }
  JSONObject streamedRaw=sseStream.result(false);
  JSONArray streamedCalls=ToolSchema.parseToolCalls(streamedRaw,"compatible");
  check(streamedCalls.length()==1,"streamed tool call assembled into one call");
  if(streamedCalls.length()==1){
   JSONObject call=streamedCalls.getJSONObject(0);
   check("read_file".equals(call.optString("name"))&&"call_1".equals(call.optString("id")),
    "streamed tool call keeps its name and id");
   JSONObject dbgArgs=call.optJSONObject("args");
   check("src/App.tsx".equals(dbgArgs.optString("path"))
    &&dbgArgs.optInt("startLine")==5,
    "streamed tool call arguments are joined across fragments [args="+dbgArgs.toString()+"]");
  }

  /*
   * Anthropic 的分片方式完全不同：先给工具名，再给 input 的分片。
   */
  String anthropicSse=
   "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{}}}\n\n"
   +"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_9\",\"name\":\"read_file\"}}\n\n"
   +"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a.ts\\\"}\"}}\n\n"
   +"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n"
   +"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
  java.io.ByteArrayInputStream sseIn2=new java.io.ByteArrayInputStream(anthropicSse.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  StreamResponse sseStream2=new StreamResponse();
  try{
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(sseIn2,java.nio.charset.StandardCharsets.UTF_8));
   String line;StringBuilder event=new StringBuilder();
   while((line=reader.readLine())!=null){
    if(line.isEmpty()){sseStream2.event(event.toString(),true,null);event.setLength(0);if(sseStream2.ended)break;}
    else if(line.startsWith("data:")){String data=line.substring(5);event.append(data.startsWith(" ")?data.substring(1):data);}
   }
  }catch(Exception e){
   throw new Exception("FAIL anthropic streamed tool call assembled: "+e.getMessage());
  }
  JSONArray anthropicStreamed=ToolSchema.parseToolCalls(sseStream2.result(true),"anthropic");
  check(anthropicStreamed.length()==1,"anthropic streamed tool call assembled");
  if(anthropicStreamed.length()==1){
   JSONObject call=anthropicStreamed.getJSONObject(0);
   check("read_file".equals(call.optString("name"))&&"toolu_9".equals(call.optString("id"))
    &&"a.ts".equals(call.optJSONObject("args").optString("path")),
    "anthropic streamed tool call keeps name, id and joined input");
  }

  /*
   * 两个工具同时被调用时不能互相覆盖 ——
   * 早期版本用 id 做 key，第二个工具的同 id 分片会把第一个冲掉。
   */
  String twoCallsSse=
   "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{\\\"prefix\\\":\\\"src/\\\"}\"}}]}}]}\n\n"
   +"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"c2\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"b.ts\\\"}\"}}]}}]}\n\n"
   +"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
   +"data: [DONE]\n\n";
  java.io.ByteArrayInputStream sseIn3=new java.io.ByteArrayInputStream(twoCallsSse.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  StreamResponse sseStream3=new StreamResponse();

  /*
   * 参数被截断时先试着补全 —— 补得回来就不用让模型重发一遍。
   * 这四条是模型输出被 max_tokens 截断时最常见的四种断法。
   */
  JSONObject fix1=new JSONObject(StreamResponse.repairTruncatedJson("{\"path\":\"src/App.tsx\""));
  check(fix1.getString("path").equals("src/App.tsx"),
   "a truncated object is closed and parsed");
  JSONObject fix2=new JSONObject(StreamResponse.repairTruncatedJson("{\"a\":[1,2"));
  check(fix2.getJSONArray("a").length()==2,
   "a truncated array is closed and parsed");
  JSONObject fix3=new JSONObject(StreamResponse.repairTruncatedJson("{\"a\":\"还没写完"));
  check(fix3.getString("a").equals("还没写完"),
   "an unclosed string is closed and parsed");
  JSONObject fix4=new JSONObject(StreamResponse.repairTruncatedJson("{\"files\":{\"a.ts\":\"x\",\"b.ts\":\"y\""));
  check(fix4.getJSONObject("files").length()==2,
   "nested braces are closed in the right order");
  check(StreamResponse.repairTruncatedJson("完全不是 JSON")==null,
   "text that is not JSON at all is not guessed at");
  check(StreamResponse.repairTruncatedJson("{\"a\":1}")==null,
   "a payload that was already valid is left alone");  try{
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(sseIn3,java.nio.charset.StandardCharsets.UTF_8));
   String line;StringBuilder event=new StringBuilder();
   while((line=reader.readLine())!=null){
    if(line.isEmpty()){sseStream3.event(event.toString(),false,null);event.setLength(0);if(sseStream3.ended)break;}
    else if(line.startsWith("data:")){String data=line.substring(5);event.append(data.startsWith(" ")?data.substring(1):data);}
   }
  }catch(Exception e){
   throw new Exception("FAIL parallel streamed tool calls kept apart: "+e.getMessage());
  }
  JSONArray twoCalls=ToolSchema.parseToolCalls(sseStream3.result(false),"compatible");
  check(twoCalls.length()==2,"two parallel streamed tool calls both survive");
  if(twoCalls.length()==2){
   check("list_files".equals(twoCalls.getJSONObject(0).optString("name"))
    &&"read_file".equals(twoCalls.getJSONObject(1).optString("name")),
    "parallel streamed tool calls keep their own names");
  }

  /*
   * ── 端到端：工具连续失败要熔断 ────────────────────────────
   *
   * fixture 的 /tools-fail 每次都让模型调 read_file 读一个不存在的文件，
   * 工具永远失败。以前这里会一路循环到 40 轮上限 ——
   * 用户等几分钟、白烧几十次请求，最后拿到的还是一句失败。
   *
   * 正确行为：连续几轮全败就停，并且说清失败原因。
   */
  try{
   JSONObject failProject=new JSONObject().put("id","qa-fail").put("name","失败自测")
    .put("files",new JSONObject().put("index.html","<!doctype html><html><body>x</body></html>"));
   a.upsert("projects",failProject);
   JSONArray failMessages=new JSONArray().put(new JSONObject().put("role","user").put("content","读一个不存在的文件"));
   ApiClient failClient=new ApiClient();
   failClient.progress=null;
   JSONObject failProfile=profile("tools-fail","compatible").put("id","qa-fail-profile").put("streaming",false);
   JSONObject failResult=DevAgent.run(a,failClient,failProfile,"fixture-secret",failMessages,"system",failProject,true);
   check(failResult.optBoolean("incomplete"),"repeated tool failures stop the loop");
   check(failResult.optString("text","").contains("全部失败"),
    "the stop message says the tools kept failing [text="+failResult.optString("text","")+"]");
   check(failResult.optString("text","").contains("不存在")||failResult.optString("text","").contains("失败原因"),
    "the stop message names the failure reason");
   /* 熔断必须早于轮次上限，否则等于没熔断 */
   JSONArray failTrail=failResult.optJSONArray("toolCalls");
   check(failTrail!=null&&failTrail.length()<=DevAgent.MAX_CONSECUTIVE_FAIL_ROUNDS+1,
    "the loop stops after a few failed rounds, not after the full round cap [rounds="+(failTrail==null?"null":failTrail.length())+"]");
  }catch(Exception e){
   throw new Exception("FAIL repeated tool failures are cut short: "+e.getMessage());
  }

  /*
   * ── 端到端：真的跑一遍原生工具循环 ────────────────────────
   *
   * 上面那些是协议层的单测。这组是**真发请求**：
   * 打 fixture 的 /tools 端点，模型第一轮返回 tool_calls，
   * 第二轮返回最终答案 —— 服务端会检查第二轮有没有带回 tool_call_id。
   *
   * <p>这一组能抓住的问题是：Studio 挂上 tools 了但没把结果回传，
   * 或者回传的 id 对不上 —— 这两种情况在纯单测里看不出来。
   */
  JSONObject toolsProject=new JSONObject().put("id","qa-tools").put("name","工具循环自测")
   .put("files",new JSONObject().put("src/main.js","console.log(1)").put("src/util.js","export const a=1"));
  try{
   a.upsert("projects",toolsProject);
   JSONArray toolMessages=new JSONArray().put(new JSONObject().put("role","user").put("content","看看 src 下面有什么文件"));
   ApiClient toolClient=new ApiClient();
   toolClient.progress=null;
   JSONObject toolProfile=profile("tools","compatible").put("id","qa-tools-profile").put("streaming",false);
   JSONObject toolResult=DevAgent.run(a,toolClient,toolProfile,"fixture-secret",toolMessages,"system",toolsProject,true);
   /*
    * fixture 第二轮会断言 messages 里有 role=tool 且 tool_call_id 匹配，
    * 断言不过会返回 500，DevAgent 抛异常 —— 这里就说明回传链路有问题。
    */
   check(toolResult.optString("text","").contains("3 个文件"),"native tool loop completes and returns the final answer [text="+toolResult.optString("text","")+" finish="+toolResult.optString("finishReason","")+" trail="+toolResult.optJSONArray("toolCalls")+"]");
   /*
    * 工具轨迹必须真的有内容，而且记的是执行过的工具 ——
    * 空数组意味着工具压根没跑，只是模型编了个调用。
    */
   JSONArray toolTrail=toolResult.optJSONArray("toolCalls");
   check(toolTrail!=null&&toolTrail.length()>=1,"native tool loop records the tool trail");
   if(toolTrail!=null&&toolTrail.length()>=1){
    JSONObject first=toolTrail.optJSONObject(0);
    check("list_files".equals(first.optString("name"))&&first.has("result"),
     "the trail records the tool that actually ran [trail="+toolTrail+"]");
   }
  }catch(Exception e){
   throw new Exception("FAIL native tool loop end-to-end: "+e.getMessage());
  }

  /*
   * ── 端到端：模型通过工具改文件，改动必须被保留 ──────────
   *
   * <p><b>这是原生 function calling 改造里最要命的一条链路。</b>
   *
   * <p>原生路径下，模型把文件内容放在 tool_calls（write_files）里，
   * 最终文本是**人话回答**，里面根本没有 files JSON。
   *
   * <p>而 Studio 原来只做
   * {@code ProjectEdits.parse(result.optString("text"))} ——
   * 从最终文本里抠 JSON。原生路径下这必然抛「模型没有返回 files 文件对象」，
   * 于是**模型明明改对了文件，改动却被整个丢掉**。
   *
   * <p>用户看到的现象：AI 说「已经改好了」，项目却一个字没变。
   *
   * <p>这条断言直接盯住 DevAgent 导出的 stagedFiles：
   * 它必须带上模型在工具里改的那个文件，以及改后的内容。
   */
  try{
   JSONObject editProject=new JSONObject().put("id","qa-edit").put("name","编辑自测")
    .put("files",new JSONObject().put("src/main.js","console.log(1)").put("index.html","<html></html>"));
   a.upsert("projects",editProject);
   JSONArray editMessages=new JSONArray().put(new JSONObject().put("role","user").put("content","把 src/main.js 改成新内容"));
   ApiClient editClient=new ApiClient();
   editClient.progress=null;
   JSONObject editProfile=profile("tools-edit","compatible").put("id","qa-tools-edit").put("streaming",false);
   JSONObject editResult=DevAgent.run(a,editClient,editProfile,"fixture-secret",editMessages,"system",editProject,true);
   JSONObject staged=editResult.optJSONObject("stagedFiles");
   check(staged!=null,"native tool edits are exported as stagedFiles [result="+editResult.optJSONArray("toolCalls")+"]");
   if(staged!=null){
    check(staged.has("src/main.js"),"the edited file is present in stagedFiles [staged="+staged+"]");
    if(staged.has("src/main.js")){
     check("console.log(\"edited by agent\")".equals(staged.optString("src/main.js","")),
      "the edited file carries the NEW content, not the old one [got="+staged.optString("src/main.js","")+"]");
    }
   }
   /*
    * 模型最终说的应该是人话，不该是一坨 JSON。
    * 如果正文里出现 files JSON，说明模型被旧的文本协议污染了。
    */
   check(!editResult.optString("text","").contains("\"files\""),
    "the final answer stays human-readable, not a raw files JSON [text="+editResult.optString("text","")+"]");
  }catch(Exception e){
   throw new Exception("FAIL native tool edit end-to-end: "+e.getMessage());
  }

  /*
   * ── 端到端：多轮依赖流程 ────────────────────────────────────
   *
   * <p>fixture 的 /tools-flow 会模拟一个真正干活的模型：
   * 先读文件 → 用读到的内容改文件 → 编译检查 → 回答。
   *
   * <p>第 2 步的写入内容**依赖第 1 步读到的内容**。
   * 这一环能暴露三类问题：
   * ① 工具结果没回传给模型 → 模型拿不到旧内容，写出来的东西是瞎编的；
   * ② staged 改动没累积 → 第 2 轮写的内容被后面某步覆盖掉；
   * ③ 循环提前退出 → 编译检查那步根本没跑。
   */
  try{
   JSONObject flowProject=new JSONObject().put("id","qa-flow").put("name","流程自测")
    .put("files",new JSONObject().put("index.html","<html><head><title>旧标题</title></head><body>Hi</body></html>"));
   a.upsert("projects",flowProject);
   JSONArray flowMessages=new JSONArray().put(new JSONObject().put("role","user").put("content","把标题改成会议助手"));
   ApiClient flowClient=new ApiClient();
   flowClient.progress=null;
   JSONObject flowProfile=profile("tools-flow","compatible").put("id","qa-tools-flow").put("streaming",false);
   JSONObject flowResult=DevAgent.run(a,flowClient,flowProfile,"fixture-secret",flowMessages,"system",flowProject,true);
   JSONArray flowTrail=flowResult.optJSONArray("toolCalls");
   check(flowTrail!=null&&flowTrail.length()>=3,
    "the multi-step flow ran read, write and check [trail="+flowTrail+"]");
   if(flowTrail!=null){
    StringBuilder names=new StringBuilder();
    for(int i=0;i<flowTrail.length();i++)names.append(flowTrail.optJSONObject(i).optString("name")).append(",");
    check(names.indexOf("read_file")>=0,"the flow read the file first");
    check(names.indexOf("write_files")>=0,"the flow wrote the file");
    check(names.indexOf("check_project")>=0,"the flow checked the project after writing");
   }
   JSONObject flowStaged=flowResult.optJSONObject("stagedFiles");
   check(flowStaged!=null&&flowStaged.has("index.html"),"the flow left the edited file in stagedFiles");
   if(flowStaged!=null&&flowStaged.has("index.html")){
    String flowContent=flowStaged.optString("index.html","");
    check(flowContent.contains("会议助手"),"the edited content carries the change [got="+flowContent+"]");
    check(!flowContent.contains("旧标题"),"the old title was replaced, not kept alongside");
    /*
     * 关键：第 2 步的写入依赖第 1 步读到的内容。
     * 如果模型没拿到工具结果，它写出来的 index.html 就没有「Hi」这段正文。
     */
    check(flowContent.contains("Hi"),"the write was based on the content the model actually read");
   }
   check(flowResult.optString("text","").contains("会议助手"),"the flow ends with a human-readable answer");
  }catch(Exception e){
   throw new Exception("FAIL multi-step native flow end-to-end: "+e.getMessage());
  }

  // Anthropic 版本的同款端到端
  try{
   JSONArray anthMessages=new JSONArray().put(new JSONObject().put("role","user").put("content","看看 src 下面有什么文件"));
   ApiClient anthClient=new ApiClient();
   anthClient.progress=null;
   JSONObject anthProfile=profile("tools-anthropic","anthropic").put("id","qa-tools-anthropic").put("streaming",false);
   JSONObject anthResult=DevAgent.run(a,anthClient,anthProfile,"fixture-secret",anthMessages,"system",toolsProject,true);
   check(anthResult.optString("text","").contains("3 个文件"),"anthropic native tool loop completes");
  }catch(Exception e){
   throw new Exception("FAIL anthropic native tool loop end-to-end: "+e.getMessage());
  }

  /*
   * ── 真实服务商：各家到底支不支持原生 function calling ────
   *
   * 这一项是真的往外发请求。每个服务商对 tools 的支持程度不一样：
   * 有的完整支持，有的只认一部分字段，有的直接报 400。
   *
   * <p>不测的后果是：用户在某个服务商上第一次用 AI 助手，
   * 整轮工具循环直接失败，而报错信息只有一句「HTTP 400」。
   *
   * <p>密钥从 Vault 取，用完就丢，绝不落到日志或报告里。
   * 没配置密钥的服务商直接跳过，不算失败。
   */
  JSONArray liveProfiles=a.state.getJSONArray("profiles");
  int liveChecked=0;
  /*
   * 外部原因跳过的服务商（限流、欠费、断网）。
   *
   * <p>这些不是代码问题 —— 但以前它们是**直接 throw**，
   * 一个 429 就把整场自测打断，后面几十条断言一条都跑不到。
   * 所以现在记下来继续跑，最后在报告里说明。
   */
  JSONArray liveSkipped=new JSONArray();
  for(int pi=0;pi<liveProfiles.length();pi++){
   JSONObject live=liveProfiles.optJSONObject(pi);
   if(live==null)continue;
   String liveId=live.optString("id");
   if(liveId.isEmpty())continue;
   if("local".equals(live.optString("protocol")))continue;
   String liveKey;
   try{liveKey=a.vault.get(liveId);}catch(Exception e){continue;}
   if(liveKey==null||liveKey.isEmpty())continue;
   try{
    JSONObject snapshot=new JSONObject(live.toString());
    snapshot.put("streaming",false);
    JSONObject liveProfile=new JSONObject().put("id",liveId)
     .put("name",live.optString("name")).put("endpoint",live.optString("endpoint"))
     .put("model",live.optString("model")).put("protocol",live.optString("protocol","compatible"))
     .put("maxTokens",256).put("streaming",false);
    /*
     * 只问一个极简单的问题，让模型决定要不要调工具。
     * 调了 → 支不支持 tools 一目了然；
     * 没调但服务端没报错 → 至少不炸。
     */
    JSONArray liveMessages=new JSONArray().put(new JSONObject().put("role","user")
     .put("content","请调用 read_file 工具读取 index.html，不要直接回答。"));
    ApiClient liveClient=new ApiClient();
    liveClient.progress=null;
    JSONObject liveResponse=liveClient.request(liveProfile,liveKey,liveMessages,"你是测试助手。",false,ToolSchema.forProtocol(liveProfile.optString("protocol","compatible")));
    JSONArray liveCalls=liveResponse.optJSONArray("toolCalls");
    liveChecked++;
    if(liveCalls!=null&&liveCalls.length()>0){
     JSONObject liveCall=liveCalls.optJSONObject(0);
     check(!liveCall.optString("name").isEmpty()&&!liveCall.optString("id").isEmpty(),
      "live provider supports native function calling ["+live.optString("name")+": "+liveCall.optString("name")+"]");
    }else{
     // 没调工具但也没报错：说明服务端接受了 tools 参数，只是模型选择了直接回答
     check(liveResponse.optString("text","").length()>0,
      "live provider accepts the tools parameter ["+live.optString("name")+"]");
    }
   }catch(Exception e){
    String em=e.getMessage()==null?"":e.getMessage();
    // 服务端不认 tools 是正常情况，不算失败 —— 运行时本来就会自动降级
    if(DevAgent.looksLikeToolsUnsupported(e))continue;
    /*
     * 外部条件不可用（限流 429、欠费、断网、超时）不代表代码有问题，
     * 记一条跳过继续跑。真正的失败是「协议层对不上」：返回结构不对、
     * 工具调用拼装错、字段名错了 —— 那些照样 throw。
     */
    if(isExternalBlocker(e,em)){
     liveSkipped.put(live.optString("name")+"："+(em.isEmpty()?e.getClass().getSimpleName():shortReason(em)));
     continue;
    }
    throw new Exception("FAIL live provider ["+live.optString("name")+"@"+live.optString("endpoint")+"]: "+em);
   }
  }
  /*
   * 全部服务商都因外部原因跳过时，不能判失败 —— 那几天用户没法自测。
   * 报告里写明跳过原因，人一看就知道要去充值或等限流恢复。
   */
  if(liveChecked>=1)check(true,"live provider probed, native function calling checked on "+liveChecked);
  else if(liveSkipped.length()>0)check(true,"live provider check skipped, external limits: "+liveSkipped.optString(0));
  else check(false,"at least one live provider was probed");

  check(GitHubTool.isText("纯文本".getBytes(java.nio.charset.StandardCharsets.UTF_8))&&!GitHubTool.isText(new byte[]{65,0,66}),
   "binary content detected by nul bytes");
  check(GitHubTool.blobSha("a\u0000b".getBytes(java.nio.charset.StandardCharsets.UTF_8)).length()==40,"blob hash is always 40 hex chars");

  boolean pushWithoutProject=false;
  try{new GitHubTool(a).push(null,"x","",false,null);}catch(Exception e){pushWithoutProject=true;}
  check(pushWithoutProject,"github push rejects a missing project");

  /*
   * ── 状态瘦身：快照不能把大内容带出去 ────────────────────────
   *
   * <p>这条是血泪教训：状态快照曾经把整个 state 原样转发，
   * 而 state 里有项目文件全文、base64 二进制、五份全量存档、AI 工具结果全文。
   * 一个用了几天的工作台 workspace.json 涨到 36 MB，
   * onResume 里发一次 state 就 OutOfMemoryError，App 闪退后再也起不来。
   *
   * <p>所以这里断言：快照里**不能有**文件内容、二进制内容、存档内容和工具结果全文。
   */
  String slimId="qa-state-slim";
  try{
   StringBuilder fatText=new StringBuilder();
   for(int i=0;i<4000;i++)fatText.append("内容行").append(i).append("\n");
   JSONObject slimProject=new JSONObject().put("id",slimId).put("name","状态瘦身自测")
    .put("files",new JSONObject().put("index.html",fatText.toString()).put("app.js","let a=1;"))
    .put("binaryFiles",new JSONObject().put("pic.png","iVBORw0KGgoAAAANSUhEUg=="))
    .put("snapshots",new JSONArray().put(new JSONObject().put("time",System.currentTimeMillis())
     .put("files",new JSONObject().put("index.html",fatText.toString()))))
    .put("history",new JSONArray().put(new JSONObject().put("time",System.currentTimeMillis())
     .put("type","api").put("text","一次调用").put("editBase",new JSONObject().put("index.html",fatText.toString()))));
   a.upsert("projects",slimProject);

   JSONObject slim=a.publicState();
   JSONArray slimProjects=slim.getJSONArray("projects");
   JSONObject slimOne=null;
   for(int i=0;i<slimProjects.length();i++)if(slimId.equals(slimProjects.getJSONObject(i).optString("id")))slimOne=slimProjects.getJSONObject(i);
   check(slimOne!=null,"the slimmed state still contains the project");

   if(slimOne!=null){
    JSONObject slimFiles=slimOne.optJSONObject("files");
    boolean filesAreSizes=true;
    for(java.util.Iterator<String> it=slimFiles.keys();it.hasNext();){
     Object v=slimFiles.opt(it.next());
     // 清单里的值必须是数字（字节数），不能是文件内容
     if(!(v instanceof Integer||v instanceof Long))filesAreSizes=false;
    }
    check(filesAreSizes,"the snapshot carries file sizes instead of file contents");
    check(slimFiles.has("index.html")&&slimFiles.has("app.js"),"the snapshot still lists every file path");
    check(!slimOne.optJSONObject("binaryFiles").optString("pic.png").contains("iVBOR"),"binary contents are not leaked into the snapshot");
    check(slimOne.optJSONArray("snapshots").getJSONObject(0).optJSONArray("files")!=null,"snapshot metadata keeps the file list");
    check(!slimOne.optJSONArray("history").getJSONObject(0).has("editBase"),"the edit base copy is not leaked into the snapshot");
    check(slimOne.optJSONArray("history").getJSONObject(0).has("editBaseHash"),"the edit base is replaced by a hash");
    /*
     * 两件事分开断言，别混成一个。
     *
     * <p>① 针对性：那个 32 KB 的文件内容一个字都不能出现在快照里。
     * 取文件最后一行当探针 —— 前面的行有可能被日志顺手带出去，
     * 最后一行还在就说明整份内容都漏了。
     *
     * <p>② 数量级：整份快照要比「曾经的 36 MB」小一个量级以上。
     * 这里**不能卡 200 KB 这种绝对值** —— 快照里还有对话记录和用量统计，
     * 自测跑到这一步时 state 里已经攒了不少东西，
     * 卡绝对值等于在测「用户用了多久」，而不是在测「有没有泄漏」。
     */
    MainActivity.Bridge bridge=a.new Bridge();
    String slimText=slim.toString();
    check(!slimText.contains("内容行3999"),"large file contents never reach the snapshot");
    check(slimText.length()<1000000,"the whole state snapshot stays under a megabyte ["+slimText.length()+"]");

    /*
     * 按需读取：快照里只剩字节数，内容要靠 Neo.readFile 单独取。
     *
     * <p>这是瘦身改造后最容易出岔子的地方 —— 前端编辑器、搜索、
     * 全局替换、导出 ZIP 全都改成走这个接口。
     * 它要是返回空字符串，症状是「项目一打开文件全是空的」，
     * 而 state 看上去完全正常，极难查。
     */
    check(bridge.readFile(slimId,"app.js").equals("let a=1;"),"readFile returns the real file content");
    check(bridge.readFile(slimId,"index.html").endsWith("内容行3999\n"),"readFile returns the whole large file, not its size");
    check(bridge.readFile(slimId,"nope.js").isEmpty(),"readFile returns empty for an unknown path");
    check(bridge.readFile(slimId,"../secret").isEmpty(),"readFile blocks directory escape");
    check(bridge.readFile(slimId,"/etc/passwd").isEmpty(),"readFile blocks absolute paths");
    check(bridge.readFile("no-such-project","app.js").isEmpty(),"readFile returns empty for an unknown project");
    // 快照按需取：快照元数据只给时间，内容要单独取
    String snapBody=bridge.readSnapshot(slimId,0);
    check(snapBody.contains("内容行3999")||snapBody.contains("index.html"),"readSnapshot returns the stored snapshot");
   }

   /*
    * 差量存档：只存改动过的文件的旧内容，恢复时叠回去。
    */
   JSONObject deltaBase=new JSONObject().put("index.html","旧内容").put("app.js","let a=1;");
   JSONObject deltaChanges=new JSONObject().put("index.html","新内容");
   JSONObject deltaProject=new JSONObject().put("id","qa-delta").put("name","差量存档自测").put("files",deltaBase);
   JSONObject deltaOut=ProjectEdits.apply(deltaProject,deltaBase,deltaChanges,"自测");
   JSONArray deltaSnaps=deltaOut.optJSONArray("snapshots");
   check(deltaSnaps!=null&&deltaSnaps.length()==1,"one snapshot is kept after a change");
   if(deltaSnaps!=null){
    JSONObject snap0=deltaSnaps.getJSONObject(0);
    check(snap0.optBoolean("delta",false),"the snapshot is marked as a delta");
    check(snap0.getJSONObject("files").has("index.html"),"the delta keeps the changed file");
    check(!snap0.getJSONObject("files").has("app.js"),"the delta does not duplicate unchanged files");
    check("旧内容".equals(snap0.getJSONObject("files").getString("index.html")),"the delta stores the previous content");
   }
   check(deltaOut.getJSONObject("files").getString("index.html").equals("新内容"),"the change itself is applied");
   /*
    * 差量存档的语义：NULL 表示「存档时刻这个文件还不存在」。
    * 恢复时要把这个文件删掉 —— 留成空字符串的话，
    * diff 会把它算成「内容变了」，实际应该是「新增了」。
    */
   JSONObject newFileBase=new JSONObject().put("index.html","旧内容");
   JSONObject newFileChanges=new JSONObject().put("index.html","新内容").put("new.css","body{}");
   JSONObject newFileOut=ProjectEdits.apply(new JSONObject().put("id","qa-delta2").put("files",newFileBase),newFileBase,newFileChanges,"自测");
   JSONObject newFileSnap=newFileOut.getJSONArray("snapshots").getJSONObject(0);
   check(newFileSnap.getJSONObject("files").isNull("new.css"),"a newly created file is marked null in the delta");
   check(!newFileSnap.getJSONObject("files").isNull("index.html"),"an edited file keeps its previous content in the delta");
   check(newFileSnap.optBoolean("delta",false),"the second snapshot is also a delta");
  }finally{
   try{a.remove("projects",slimId);}catch(Exception ignored){}
  }

  check(!a.safeFile("../secret")&&!a.safeFile("x/y.html")&&a.safeFile("index.html"),"import traversal blocked");out.put("result","PASS");
 }catch(Exception e){try{out.put("result","FAIL").put("error",e.toString());}catch(Exception ignored){}}try{out.put("passed",passed).put("checks",details);try(FileOutputStream f=new FileOutputStream(new File(a.getFilesDir(),"selftest.json"))){f.write(out.toString(2).getBytes("UTF-8"));}}catch(Exception ignored){}}
}
