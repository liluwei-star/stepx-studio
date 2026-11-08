package cn.com.scsxrkj;
import org.json.*;
import java.io.*;
/** 整体自检：跑一批内置检查，确认核心功能没坏。只在调试版触发。 */
final class SelfTest {
 static int passed;static JSONArray details;
 static void check(boolean b,String name)throws Exception{if(!b)throw new Exception("FAIL "+name);passed++;details.put(name);}
 static JSONObject response(String json)throws Exception{return new JSONObject(json);}
 static JSONObject profile(String path,String protocol)throws Exception{return new JSONObject().put("endpoint","http://127.0.0.1:8768/"+path).put("protocol",protocol).put("model","fixture").put("maxTokens",128);}
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
  }catch(Exception e){
   throw new Exception("FAIL test runner explains when a project has no tests: "+e.getMessage());
  }

  try{
   JSONObject tested=a.script.runTests(sandboxProject);
   check(tested.optInt("files",0)==1&&tested.optInt("passed",-1)==1&&tested.optInt("failed",-1)==1,
    "test runner bundles tests, runs them, and counts pass and fail");
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
  try{
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
    throw new Exception("FAIL live provider ["+live.optString("name")+"@"+live.optString("endpoint")+"]: "+em);
   }
  }
  check(liveChecked>=1,"at least one live provider was probed");

  check(GitHubTool.isText("纯文本".getBytes(java.nio.charset.StandardCharsets.UTF_8))&&!GitHubTool.isText(new byte[]{65,0,66}),
   "binary content detected by nul bytes");
  check(GitHubTool.blobSha("a\u0000b".getBytes(java.nio.charset.StandardCharsets.UTF_8)).length()==40,"blob hash is always 40 hex chars");

  boolean pushWithoutProject=false;
  try{new GitHubTool(a).push(null,"x","",false,null);}catch(Exception e){pushWithoutProject=true;}
  check(pushWithoutProject,"github push rejects a missing project");

  check(!a.safeFile("../secret")&&!a.safeFile("x/y.html")&&a.safeFile("index.html"),"import traversal blocked");out.put("result","PASS");
 }catch(Exception e){try{out.put("result","FAIL").put("error",e.toString());}catch(Exception ignored){}}try{out.put("passed",passed).put("checks",details);try(FileOutputStream f=new FileOutputStream(new File(a.getFilesDir(),"selftest.json"))){f.write(out.toString(2).getBytes("UTF-8"));}}catch(Exception ignored){}}
}
