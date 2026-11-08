package cn.com.scsxrkj;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;
/**
 * AI 可调用的项目工具集。
 *
 * <p>模型在改代码时能通过这些工具实际动手：读文件、改文件、新建文件等。
 *
 * <p>关键约束：<b>所有操作都在暂存快照上做</b>，最后一次性校验并提交。
 * 中途出错就整体丢弃，项目不会变成改了一半的烂摊子。
 */
final class LocalDevTools {
 final MainActivity a;final JSONObject original;JSONObject staged;final JSONArray calls=new JSONArray();int artCalls;
 LocalDevTools(MainActivity a,JSONObject project)throws Exception{this.a=a;original=project==null?null:new JSONObject(project.toString());staged=project==null?null:new JSONObject(project.toString());}
 static String instructions(boolean project){
 /*
  * 分成两段写：「不分场合都该知道的」和「有项目才用得上的」。
  *
  * 之所以要拆开，是因为记忆、技能、联网、GitHub 这几件事跟项目无关 ——
  * 用户没选项目的时候问「上次那个坑怎么修的」，助手也得答得上来。
  * 以前这段在无项目时只提了连接器两个工具，等于把这些能力藏起来了。
  */
 String common="\n\n【记忆】"
  +"\n- remember(text, scope可选global|project)：把值得长期留下的事写下来。"
  +"该记的是：用户说过的偏好、这个项目特有的约定、你踩过并修好的坑、外部服务的限制。"
  +"不该记的是临时状态（「刚改完三个文件」这种东西明天就是垃圾）。"
  +"scope 可以不填：有项目时默认记到项目，没项目时自动记到全局。"
  +"\n- read_memory(scope可选global|project|all)：看已经记住了什么。要记之前先看，别记重复的。"
  +"\n- update_memory(content, scope)：整段重写记忆。条目太乱或者快满了（每轮提示词末尾会告诉你用量）时用它整理。"
  +"\n已经记住的内容每轮开头都自动给你了，不用主动调 read_memory。"
  +"\n\n【技能】"
  +"\n技能是成套的做法，不是事实。提示词里只给了名字和一句话描述，要照做之前必须读全文，不要凭描述猜步骤。"
  +"\n- list_skills()：列出所有技能。"
  +"\n- read_skill(name)：读某个技能的完整内容。"
  +"\n- write_skill(name, description, content)：把一套做法存成技能。"
  +"该写的时候：你完成了一件多步骤、以后还会重复做的事（比如「清洗云端项目的正确顺序」），"
  +"或者用户纠正了你的做法。description 要写成「什么时候该用」，因为系统就是靠这句话决定要不要读全文。"
  +"\n- delete_skill(name)：删掉过时或写错的技能。"
  +"\n\n【联网】"
  +"\n- web_fetch(url)：抓网页正文。用在已知网址的场合：查官方文档、读报错对应的 issue。"
  +"\n- web_search(query, limit可选)：搜索。用在不知道该去哪儿找的场合。"
  +"\n遇到不熟的库、新版本 API、看不懂的报错，先查再写。查来的结论要说清是查到的，"
  +"不要把自己的猜测也说成查证过的。"
  +"\n\n【GitHub】"
  +"\n- github_status()：看当前配置、登录身份、目标仓库在不在。"
  +"\n- github_push(repo可选, message可选, private可选)：把当前项目上传或增量更新到 GitHub。"
  +"只传文本文件，二进制和超大文件会跳过并在结果里列出来。用户说「传到 GitHub」「备份到仓库」时用它。"
  +"默认建私有仓库。只有用户明确说要公开时才传 private=false，并且要在回复里提醒他项目会公开可见。"
  +"\n\n【在本机跑代码】"
  +"\n- run_tests()：跑项目里的单元测试。测试文件按 *.test.ts / *.test.js / *.spec.ts 命名，"
  +"里面直接用 describe / it / expect（已经注入全局，不用 import），也认 @jest/globals 的 import 写法。"
  +"改了逻辑就跑一下，比肉眼看靠谱。"
  +"\n- run_script(code)：在隔离沙箱里跑一段 JS。可以 await fetch('/project.json') 读项目文件、"
  +"console.log 看中间值、最后 window.__neoResult=... 交出返回值。适合验算数据、试算法、批量分析文件。"
  +"沙箱里没有 node、装不了 npm 包、也连不了网 —— 这是隔离，不是限制。";

 if(!project)return "本轮没有指定项目。这几类工具照常可用："+common
  +"\n\n另外还能用 search_connectors(query)、describe_connector(id,query可选,offset可选) 查官方连接器。"
  +"\n需要工具时只返回 JSON：{\"tools\":[{\"name\":\"工具名\",\"args\":{...}}]}。轮数不限；做完正常用文字回答。";

 return "你是一个能真正动手的编程助手，不是只会给建议的聊天机器人。"
  +"\n\n【铁律】"
  +"\n1. 不要凭记忆猜文件内容。要看就用 read_file，要定位就用 search_code。"
  +"\n2. 改代码前必须先读那个文件。没读过就改，等于闭着眼睛写。"
  +"\n3. 改完系统会自动跑一次编译，结果会返回给你。编译不过就自己修，别把坏代码交给用户。"
  +"\n4. 不要声称做过没做过的事。没验证就说没验证。"
  +"\n5. 一次只做用户要求的事，别顺手大改无关文件。"
  +"\n\n【计划】"
  +"\n- write_plan(steps)：把要做的事列成清单。数组，每项 {text, done}。"
  +"开工前先写一次，做完一项改一次 done，这样长任务不会跑偏，用户也能看到进度。"
  +"\n- read_plan()：读回当前清单。"
  +"\n\n【工作流程】"
  +"\n① list_files 看结构 → ② search_code 定位 → ③ read_file 读内容"
  +"\n④ patch_file / multi_patch / replace_text 改动 → ⑤ diff_mine 自查改了哪些行"
  +"\n⑥ 看自动编译结果 → ⑦ 改的是逻辑就跑 run_tests → ⑧ 有错继续修，直到通过才交付"
  +"\n\n【调用方式】需要工具时只返回 JSON，不要夹带其他文字："
  +"{\"tools\":[{\"name\":\"工具名\",\"args\":{...}}]}。可以一次调用多个工具。"
  +"\n\n【工具清单】"
  +"\nlist_files(prefix可选目录前缀,depth可选展开层数)：按目录分组列出文件，带行数与类型。"
  +"\nread_file(path,startLine可选,lineCount可选)：读文件；不指定范围就读整份。"
  +"\nsearch_code(query,prefix可选,glob可选,regex可选true用正则,ignoreCase可选)：搜索，返回文件+行号+该行内容。"
  +"例：找所有 tsx 里的某个词 → glob=\"*.tsx\"；只搜某目录 → prefix=\"src/app\"；写复杂条件 → regex=true。"
  +"\npatch_file(path,startLine,endLine,newContent)：按行范围替换，只动指定那几行，其余原样保留。"
  +"改代码首选这个 —— 不用把整个文件重写一遍，也不会误伤没读到的部分。行号从1开始、含首尾。"
  +"\nreplace_text(path,oldText,newText)：精确替换；oldText 必须在文件里只出现一次，适合改一两句。"
  +"\nmulti_patch(patches数组)：一次改多个文件的多个位置，每项 {path,startLine,endLine,newContent}。"
  +"要动两个以上文件就优先用它，别一个一个发。"
  +"\nwrite_files(files文件对象)：暂存并校验，最终一次写入。新增文件或大范围重写才用它。"
  +"\ninspect_project：项目概览（文件数、package.json、运行环境说明）。"
  +"\nlist_art_models、list_assets、generate_image(prompt,path可选,referenceFile可选,placeholder可选)："
  +"美术资源；generate_image 每轮最多3张（防刷屏），先 list_assets 复用已有图。"
  +"\ncheck_project：手动触发编译检查（改完系统会自动跑一次，一般不用手动调）。"
  +"\nrun_preview：打开离线预览，看实际效果。"
  +"\nget_debug_reports：取运行日志。看用户报的错之前先调这个，别只凭他一句话猜。"
  +"\ndiff_mine(withLines可选,path可选)：看你本轮改了什么 —— 新增/修改/删除的文件和具体行差异。"
  +"改完代码先调这个自查，确认没改错地方、没误伤别的文件，再交付。"
  +"\ndiff_project(snapshot可选)：看整个项目相对历史快照改了哪些文件。"
  +"\nbuild_apk：本机编译并打包暂存快照。"
  +common
  +"\n\n【约束】工具只能操作当前指定项目；没有系统 shell（只有上面的 JS 沙箱）；"
  +"不可修改凭据、签名材料或二进制资源；结束时返回严格 JSON files 对象。";
 }

/**
  * 不依赖项目的工具。
  *
  * <p>记忆、技能、联网、GitHub 状态这几类跟「当前选了哪个项目」无关。
  * 用户可能就想问一句「上次那个构建错误你是怎么解的」——
  * 那时候他未必选了什么项目，能力不该被藏起来。
  *
  * @return 处理结果；返回 null 表示这个名字不归这里管，交给后面的项目工具
  */
 JSONObject contextFree(String name,JSONObject args)throws Exception{
  String projectId=args.optString("projectId",staged==null?"":staged.optString("id",""));
  switch(name){
   case "remember":{
    /*
     * 没指定 scope 时按上下文自动选：有项目就记到项目，没项目就记到全局。
     *
     * 早先的默认值是写死的 "project"，于是在没选项目的对话里调 remember
     * 会直接报错「记到项目记忆时必须指定项目」—— 模型想记点东西反而被打断，
     * 而它本来就没法预知有没有项目。
     */
    String scope=args.optString("scope","");
    if(scope.isEmpty())scope=projectId.isEmpty()?"global":"project";
    return a.memory.remember(args.optString("text",""),scope,projectId);
   }
   case "read_memory":{
    String scope=args.optString("scope","all");
    JSONObject m=new JSONObject().put("scope",scope);
    if(!scope.equals("project"))m.put("global",a.memory.read("global",null)).put("globalUsage",
     new JSONObject().put("chars",a.memory.used("global",null)).put("cap",AiMemory.GLOBAL_CAP));
    if(!scope.equals("global")&&!projectId.isEmpty()){
     m.put("project",a.memory.read("project",projectId));
     m.put("projectUsage",new JSONObject().put("chars",a.memory.used("project",projectId)).put("cap",AiMemory.PROJECT_CAP));
    }
    return m;
   }
   case "update_memory":{
    String scope=args.optString("scope","");
    if(scope.isEmpty())scope=projectId.isEmpty()?"global":"project";
    return a.memory.replace(args.optString("content",""),scope,projectId);
   }
   case "list_skills":return new JSONObject().put("skills",a.skills.list());
   case "read_skill":return a.skills.read(args.optString("name",""));
   case "write_skill":return a.skills.write(args.optString("name",""),args.optString("description",""),args.optString("content",""));
   case "delete_skill":return a.skills.delete(args.optString("name",""));
   case "web_fetch":return a.net.fetch(args.optString("url",""));
   case "web_search":return a.net.search(args.optString("query",""),args.optInt("limit",5));
   case "github_status":return a.gh.status();
   default:return null;
  }
 }

 /**
 * 计划存在哪：项目快照的顶层字段，不进 files。
 *
 * <p>为什么不塞成一个项目文件（比如 .studio-plan.json）：
 * 那样它会出现在 list_files 的结果里，会被 build_apk 打进 APK，
 * 也会被 diff_mine 报成「用户文件被改了」—— 用户根本没写过这个文件。
 * 计划是助手的内部状态，跟用户的内容就该分开。
 */
 static final String PLAN_KEY="aiPlan";

 /**
  * 写计划。
  *
  * <p>存两处：
  * <ul>
  *   <li>staged 顶层 —— 本轮工具循环里马上能读到</li>
  *   <li>项目状态 —— 跨轮次还在，下次发消息时提示词会自动带上</li>
  * </ul>
  * 只存 staged 的话，这一轮结束就丢了 —— 计划工具的全部意义就是跨轮接着做。
  */
 void setPlan(JSONObject staged,JSONArray steps)throws Exception{
  if(staged==null)throw new Exception("没有项目，写不了计划");
  // 空计划没有意义 —— 写进去会让提示词多一段空内容，模型还以为有活要干
  if(steps==null||steps.length()==0)throw new Exception("计划是空的，没有要写的步骤");
  staged.put(PLAN_KEY,steps);
  if(staged.optString("id","")!=null&&!staged.optString("id","").isEmpty())a.savePlan(staged.optString("id"),steps);
 }

 /** 读回计划。没有就返回空数组 —— 这不是错误，是还没规划过。 */
 JSONArray getPlan(JSONObject staged){
  JSONArray empty=new JSONArray();
  if(staged==null)return empty;
  JSONArray steps=staged.optJSONArray(PLAN_KEY);
  if(steps!=null&&steps.length()>0)return steps;
  // staged 里没有就找项目状态 —— 上一轮写的那份
  String id=staged.optString("id","");
  if(id.isEmpty())return empty;
  JSONArray saved=a.loadPlan(id);
  return saved==null?empty:saved;
 }

JSONObject call(String name,JSONObject args)throws Exception{
  if(name.equals("search_connectors"))return a.connectors.search(args.optString("query"));if(name.equals("describe_connector"))return a.connectors.describe(args.getString("id"),args.optString("query"),args.optInt("offset"));
  // 不依赖项目的工具先处理掉：记忆、技能、联网、GitHub 状态
  JSONObject free=contextFree(name,args);
  if(free!=null)return free;
  /*
   * 计划工具在项目检查之前处理。
   *
   * 计划本身要写进项目，所以确实需要项目 ——
   * 但它属于「流程控制」而不是「操作文件」，
   * 放在后面会让「还没选项目」这个状态卡住整个循环。
   */
  if(name.equals("write_plan")||name.equals("read_plan")){
   if(staged==null)throw new Exception("请先选择目标项目才能使用计划工具");
   if(name.equals("read_plan"))return new JSONObject().put("steps",getPlan(staged));
   JSONArray plan=args.optJSONArray("steps");
   if(plan==null)throw new Exception("write_plan 需要 steps（数组），每项是 {\"text\":\"...\",\"done\":true/false}");
   JSONArray items=new JSONArray();
   for(int i=0;i<plan.length();i++){
    JSONObject step=plan.optJSONObject(i);
    if(step==null)continue;
    items.put(new JSONObject().put("text",step.optString("text","")).put("done",step.optBoolean("done",false)));
   }
   if(items.length()==0)throw new Exception("write_plan 的 steps 是空的");
   setPlan(staged,items);
   return new JSONObject().put("steps",items).put("count",items.length());
  }
  if(staged==null)throw new Exception("请先选择目标项目才能使用开发工具");
  JSONObject files=staged.getJSONObject("files"),out=new JSONObject();
  switch(name){
   case "list_art_models":return a.art.catalog();
   case "list_assets":return new JSONObject().put("assets",staged.optJSONArray("artAssets")).put("binaryPaths",staged.optJSONObject("binaryFiles")==null?new JSONArray():staged.getJSONObject("binaryFiles").names());
   case "generate_image":if(artCalls>=3)throw new Exception("本轮已达到3次绘图调用限制，请先使用已有资源");artCalls++;return a.art.tool(staged,args);
   case "inspect_project":out.put("name",staged.optString("name")).put("fileCount",files.length()).put("cloudSource",staged.optBoolean("cloudSource")).put("packageJson",files.optString("package.json","")).put("environment","离线 HTML/CSS/JS、TS/TSX/JSX 编译、React 与预装依赖、Tailwind 3；WebView隔离运行。原生Android/Node服务端/npm安装需外部环境。工具可以读写、搜索、检查、预览、离线打包和取回日志。");break;
   case "list_files":out.put("files",listFiles(files,staged,args));break;
   case "read_file":String path=args.getString("path");if(!files.has(path))throw new Exception("文件不存在");String[] lines=files.getString(path).split("\\n",-1);int start=Math.max(1,args.optInt("startLine",1)),count=Math.max(1,args.optInt("lineCount",lines.length));StringBuilder text=new StringBuilder();for(int i=start-1;i<Math.min(lines.length,start-1+count);i++){text.append(i+1).append(": ").append(lines[i]).append('\n');}out.put("path",path).put("totalLines",lines.length).put("content",text.toString());break;
   case "search_code":out.put("matches",searchCode(files,args));break;
   case "replace_text":String editPath=args.getString("path"),oldText=args.getString("oldText"),newText=args.getString("newText");if(!files.has(editPath)||oldText.isEmpty())throw new Exception("无效的精确替换参数");String current=files.getString(editPath);int at=current.indexOf(oldText);if(at<0||current.indexOf(oldText,at+1)>=0)throw new Exception("替换片段必须在当前文件中精确匹配一次，请先读取并扩大上下文");String replaced=current.substring(0,at)+newText+current.substring(at+oldText.length());staged=ProjectEdits.apply(staged,files,new JSONObject().put(editPath,replaced),"AI 暂存");out.put("staged",true).put("path",editPath).put("replacements",1);break;
   case "patch_file":out.put("result",patchFile(files,args));break;
   /*
    * 批量局部改：一次调用改多个文件的多个位置。
    *
    * 原来改 5 个文件各 3 行，要发 5 次 patch_file。
    * 每次都是一来一回，既慢又容易在中途失去上下文。
    * 这里直接把一批 patch 按顺序执行，返回每处的回显。
    */
   case "multi_patch":{
    JSONArray patches=args.optJSONArray("patches");
    if(patches==null||patches.length()==0)throw new Exception("patches 不能为空，格式：[{path,startLine,endLine,newContent}]");
    JSONArray done=new JSONArray();JSONArray failed=new JSONArray();
    for(int pi=0;pi<patches.length();pi++){
     JSONObject pc=patches.getJSONObject(pi);
     try{done.put(patchFile(staged.getJSONObject("files"),pc));}
     catch(Exception e){failed.put(new JSONObject().put("path",pc.optString("path","")).put("error",e.getMessage()==null?"失败":e.getMessage()));}
    }
    out.put("ok",done.length()).put("results",done).put("failed",failed);
    break;
   }
   /*
    * 我这次改了什么。
    *
    * 这就是 Studio 里的 git diff —— 项目不是 git 仓库，
    * 但「本轮起点」和「现在暂存的东西」之间一定有差异，
    * 模型需要能看见自己动了哪些行，才谈得上自查。
    */
   case "diff_mine":out.put("diff",diffMine(args));break;
   /*
    * 项目相对历史快照改了什么。
    *
    * 快照在同步、导入、AI 写回时自动建立，
    * 所以这能回答「这个项目从上次同步到现在，被动了哪些文件」。
    */
   case "diff_project":{
    synchronized(a){
     JSONObject live=a.byId("projects",staged.getString("id"));
     out.put("diff",ProjectDiff.against(live,args.optInt("snapshot",-1)));
    }
    break;
   }
   case "write_files":staged=ProjectEdits.apply(staged,files,args.getJSONObject("files"),"AI 暂存");out.put("staged",true).put("message","暂存文件已校验，最终成功后写回项目");break;
   case "check_project":return LocalCompiler.check(a,staged);
   case "run_preview":CountDownLatch opened=new CountDownLatch(1);String[] failure={null};a.runOnUiThread(()->{try{if(a.localRunner!=null&&a.localRunner.dialog!=null)a.localRunner.dialog.dismiss();a.localRunner=new LocalRunner(a,staged);a.localRunner.start();}catch(Exception e){failure[0]=e.getMessage();}finally{opened.countDown();}});if(!opened.await(10,TimeUnit.SECONDS))throw new Exception("预览打开超时");if(failure[0]!=null)throw new Exception(failure[0]);out.put("opened",true).put("message","已打开离线预览，编译/运行日志可用get_debug_reports读取；打开不代表交互验收通过");break;
   case "get_debug_reports":synchronized(a){out.put("reports",a.byId("projects",staged.getString("id")).optJSONArray("debugReports"));}if(a.localRunner!=null&&a.localRunner.projectId.equals(staged.getString("id")))out.put("preview",a.localRunner.report());break;
   /*
    * 跑测试：改完逻辑让系统自己验一遍。
    *
    * 编译只能证明「语法没错」，证明不了「算得对」。这两件事完全可能一起出错 ——
    * 一段把加法写成减法的代码，编译得干干净净。
    */
   case "run_tests":return a.script.runTests(staged);
   /*
    * 跑一段任意 JS。沙箱里能读项目文件、能 console.log、能算东西，
    * 但没有系统命令、没有 npm、没有网络。
    */
   case "run_script":return a.script.runScript(args.optString("code",""),staged);
   /*
    * 推到 GitHub。同步请求，几百个文件时会跑一阵 ——
    * 进度通过 toast 报给用户，免得他以为卡死了。
    */
   /*
    * 默认建私有仓库。
    *
    * 用户说「传到 GitHub」时想的是备份，不是发布 —— 默认公开会把他的项目
    * 连同里面可能的密钥、内部地址一起挂到互联网上，而且搜索引擎会收录。
    * 要公开必须显式说 private=false。
    */
   case "github_push":return a.gh.push(staged,args.optString("repo",""),args.optString("message",""),
    args.optBoolean("private",true),msg->a.runOnUiThread(()->a.toast(msg)));
   case "build_apk":CloudFiles.entries(staged);int number;synchronized(a){number=a.byId("projects",staged.getString("id")).optInt("buildNumber",0)+1;}JSONObject build=OfflineBuilder.build(a,staged,number);build.put("stagedSnapshot",true);synchronized(a){JSONObject p=a.byId("projects",staged.getString("id"));JSONArray builds=p.optJSONArray("builds");if(builds==null){builds=new JSONArray();p.put("builds",builds);}builds.put(build);p.put("buildNumber",number);a.saveState();}return new JSONObject().put("build",build).put("message","暂存快照APK已构建；未自动安装，未代表实际运行通过");
   default:throw new Exception("不支持的工具："+name);
  }return out;
 }
 /**
  * 列出项目文件。
  *
  * <p>比平铺全量强在三点：
  * <ul>
  *   <li><b>按目录分组</b> —— 模型能看出「这是一个 Vite 工程，源码在 src/ 下」，
  *       平铺 300 个文件名等于没给结构</li>
  *   <li><b>带行数和类型</b> —— 知道哪个是入口、哪个是配置、哪个是样式</li>
  *   <li><b>可按前缀过滤</b> —— 大项目里只列某个目录，不必每次看全量</li>
  * </ul>
  *
  * @param files   项目的文本文件表
  * @param project 项目对象（取二进制清单）
  * @param args    参数：{@code prefix} 目录前缀，{@code depth} 展开几层
  * @return 文件条目数组
  */
 private JSONArray listFiles(JSONObject files,JSONObject project,JSONObject args)throws Exception{
  String prefix=args.optString("prefix","").trim();
  int depth=Math.max(1,Math.min(6,args.optInt("depth",3)));
  JSONObject bins=project.optJSONObject("binaryFiles");
  JSONArray out=new JSONArray();
  // 先按目录分组，模型才看得出结构
  java.util.TreeMap<String,java.util.ArrayList<String>> byDir=new java.util.TreeMap<>();
  for(Iterator<String> it=files.keys();it.hasNext();){
   String n=it.next();
   if(!prefix.isEmpty()&&!n.startsWith(prefix))continue;
   String dir=n.contains("/")?n.substring(0,n.lastIndexOf('/')):".";
   int levels=dir.equals(".")?0:dir.split("/").length;
   if(levels>depth)dir=dir.substring(0,dir.lastIndexOf('/',dir.length()-1)+1)+"…";
   byDir.computeIfAbsent(dir,k->new java.util.ArrayList<>()).add(n);
  }
  for(java.util.Map.Entry<String,java.util.ArrayList<String>> e:byDir.entrySet()){
   JSONArray group=new JSONArray();
   java.util.Collections.sort(e.getValue());
   for(String n:e.getValue()){
    String content=files.optString(n,"");
    int lines=1;
    for(int i=0;i<content.length();i++)if(content.charAt(i)=='\n')lines++;
    group.put(new JSONObject().put("path",n).put("lines",lines).put("characters",content.length())
     .put("kind",kindOf(n)));
   }
   out.put(new JSONObject().put("dir",e.getKey()).put("count",group.length()).put("files",group));
  }
  // 二进制与大文件单列 —— 模型需要知道它们存在但读不了
  if(bins!=null){
   JSONArray bin=new JSONArray();
   java.util.ArrayList<String> names=new java.util.ArrayList<>();
   for(Iterator<String> it=bins.keys();it.hasNext();){String n=it.next();if(prefix.isEmpty()||n.startsWith(prefix))names.add(n);}
   java.util.Collections.sort(names);
   for(String n:names)bin.put(new JSONObject().put("path",n).put("kind","binary"));
   if(bin.length()>0)out.put(new JSONObject().put("dir","（二进制与大文件，不能按文本读）").put("count",bin.length()).put("files",bin));
  }
  return out;
 }

 /** 从文件名猜类型，模型据此判断该看哪个文件。 */
 private static String kindOf(String n){
  String l=n.toLowerCase(Locale.ROOT);
  if(l.equals("index.html")||l.endsWith("/index.html"))return "入口页面";
  if(l.endsWith(".tsx"))return "React 组件";
  if(l.endsWith(".ts"))return "TypeScript 源码";
  if(l.endsWith(".jsx"))return "React 组件";
  if(l.endsWith(".js")||l.endsWith(".mjs"))return "脚本";
  if(l.endsWith(".css"))return "样式";
  if(l.endsWith(".json"))return "配置";
  if(l.endsWith(".md"))return "文档";
  if(l.endsWith(".wasm"))return "WebAssembly";
  return "文本";
 }

 /**
  * 在项目里搜索代码。
  *
  * <p>比纯文本匹配强在：
  * <ul>
  *   <li><b>支持正则</b> —— 「找出所有 import 了 xxx 的地方」用纯文本匹配做不到</li>
  *   <li><b>可限定目录</b> —— 大项目里只搜 src/</li>
  *   <li><b>大小写可选</b> —— 找组件名时通常不区分大小写</li>
  * </ul>
  *
  * @param files 项目文本文件表
  * @param args  参数：{@code query}，{@code prefix}，{@code regex}，{@code ignoreCase}
  * @return 命中列表
  */
 private JSONArray searchCode(JSONObject files,JSONObject args)throws Exception{
  String q=args.optString("query","").trim();
  if(q.isEmpty()||q.length()>300)throw new Exception("搜索词需为1到300字符");
  String prefix=args.optString("prefix","").trim();
  String glob=args.optString("glob","").trim();
  boolean regex=args.optBoolean("regex",false);
  boolean ignoreCase=!args.has("ignoreCase")||args.optBoolean("ignoreCase",true);
  int limit=Math.max(1,args.optInt("limit",Integer.MAX_VALUE));
  java.util.regex.Pattern pattern;
  if(regex){
   try{
    pattern=java.util.regex.Pattern.compile(q,ignoreCase?java.util.regex.Pattern.CASE_INSENSITIVE:0);
   }catch(Exception e){throw new Exception("正则表达式无效："+e.getMessage());}
  }else{
   pattern=java.util.regex.Pattern.compile(java.util.regex.Pattern.quote(q),ignoreCase?java.util.regex.Pattern.CASE_INSENSITIVE:0);
  }
  JSONArray matches=new JSONArray();
  for(Iterator<String> it=files.keys();it.hasNext()&&matches.length()<limit;){
   String n=it.next();
   if(!prefix.isEmpty()&&!n.startsWith(prefix))continue;
   if(!glob.isEmpty()&&!globMatch(n,glob))continue;
   String[] code=files.getString(n).split("\\n");
   for(int i=0;i<code.length&&matches.length()<limit;i++){
    if(pattern.matcher(code[i]).find())
     matches.put(new JSONObject().put("path",n).put("line",i+1).put("text",code[i].trim().substring(0,Math.min(400,code[i].trim().length()))));
   }
  }
  return matches;
 }

 /**
  * 把 glob 模式匹配到文件路径上。
  *
  * <p>支持三种写法：
  * <ul>
  *   <li>{@code *.tsx} —— 不含斜杠时只比文件名，所以能命中任意目录下的 .tsx</li>
  *   <li>{@code src/**\/*.ts} —— 含斜杠时比完整路径，{@code **} 跨目录</li>
  *   <li>{@code ?} 匹配单个字符</li>
  * </ul>
  *
  * <p>写成正则来匹配，是因为 Java 没现成的 glob 方法，
  * 而引 JDK 的 PathMatcher 要额外构造 FileSystem，路径还得真实存在 ——
  * 这里的路径只是项目里的字符串，不一定在磁盘上。
  *
  * @param path 文件路径
  * @param glob 模式
  * @return 是否匹配
  */
 static boolean globMatch(String path,String glob){
  String g=glob.trim();
  if(g.isEmpty())return true;
  String target=path;
  // 不含斜杠的模式只比文件名：「*.tsx」应该命中 src/app/x.tsx
  if(g.indexOf('/')<0){
   int s=path.lastIndexOf('/');
   target=s<0?path:path.substring(s+1);
  }
  StringBuilder re=new StringBuilder("^");
  for(int i=0;i<g.length();i++){
   char c=g.charAt(i);
   if(c=='*'){
    if(i+1<g.length()&&g.charAt(i+1)=='*'){re.append(".*");i++;}
    else re.append("[^/]*");
   }else if(c=='?')re.append("[^/]");
   else if("\\.[]{}()+-^$|".indexOf(c)>=0)re.append('\\').append(c);
   else re.append(c);
  }
  re.append('$');
  try{return target.matches(re.toString());}catch(Exception e){return false;}
 }

 /**
  * 按行范围替换文件的一部分。
  *
  * <p>解决的问题：{@code write_files} 和 {@code replace_text} 都要求给出完整的新内容，
  * 改一个函数要连带把整个文件重写一遍 —— 既费 token，又容易把没读到的部分改坏。
  *
  * <p>这个工具只要求给出「要替换的那几行」，其余原样保留：
  * <pre>
  *   patch_file(path="src/a.ts", startLine=42, endLine=58, newContent="新的代码")
  * </pre>
  *
  * <p>行号从 1 开始，含首尾。替换前会校验行号范围，
  * 并回显替换前后的片段，让模型能确认改对了地方。
  *
  * @param files 当前暂存的文件表
  * @param args  参数
  * @return 结果描述
  */
 private JSONObject patchFile(JSONObject files,JSONObject args)throws Exception{
  String path=args.getString("path");
  if(!files.has(path))throw new Exception("文件不存在："+path);
  String newContent=args.optString("newContent","");
  String original2=files.getString(path);

  /*
   * 把文件拆成「行列表 + 有没有尾换行」两件事，而不是直接按 \n 切完就拼。
   *
   * 原来那版只想着「替换完补个换行」，结果两头都不对：
   *   ① 原文件末尾没有换行时，每改一次末尾就多一个空行，改五次多五个
   *   ② 删掉最后一行时，前面保留的行还带着换行，文件末尾凭空多一行空行
   * 分清楚再拼，两种情况都不会出现。
   */
  String[] raw=original2.split("\\n",-1);
  boolean trailingNewline=original2.endsWith("\\n")&&raw.length>0;
  int lineCount=trailingNewline?raw.length-1:raw.length;
  java.util.ArrayList<String> list=new java.util.ArrayList<>();
  for(int i=0;i<lineCount;i++)list.add(raw[i]);
  if(lineCount==0)throw new Exception("文件是空的，没有可替换的行");

  int start=Math.max(1,args.optInt("startLine",0));
  int end=Math.min(lineCount,args.optInt("endLine",0));
  if(end<start)throw new Exception("行号范围无效：startLine="+start+" endLine="+end+"（文件共 "+lineCount+" 行）");
  if(start>lineCount)throw new Exception("起始行 "+start+" 超出文件行数 "+lineCount);

  // newContent 末尾的换行是格式噪音，去掉，否则会多出空行
  String nc=newContent;
  while(nc.endsWith("\n"))nc=nc.substring(0,nc.length()-1);

  java.util.ArrayList<String> result=new java.util.ArrayList<>(list.subList(0,start-1));
  if(!nc.isEmpty())for(String s:nc.split("\\n",-1))result.add(s);
  result.addAll(list.subList(end,lineCount));

  StringBuilder sb=new StringBuilder();
  for(int i=0;i<result.size();i++){
   sb.append(result.get(i));
   if(i<result.size()-1)sb.append('\n');
  }
  if(trailingNewline&&!result.isEmpty())sb.append('\n');
  String replaced=sb.toString();

  staged=ProjectEdits.apply(staged,files,new JSONObject().put(path,replaced),"AI 暂存");
  // 回显改动前的原文，模型能自己确认改对了地方
  StringBuilder before=new StringBuilder();
  for(int i=start-1;i<Math.min(end,start-1+8)&&i<list.size();i++)before.append(list.get(i)).append('\n');
  JSONObject result2=new JSONObject();
  result2.put("staged",true).put("path",path)
   .put("replacedLines",end-start+1).put("newLines",nc.isEmpty()?0:nc.split("\\n",-1).length)
   .put("totalLinesAfter",trailingNewline&&result.isEmpty()?0
     :replaced.split("\\n",-1).length-(replaced.endsWith("\n")?1:0))
   .put("before",before.toString());
  return result2;
 }

 /**
  * 把完整行级差异裁成「只留改动附近几行」。
  *
  * <p>不裁会出大问题：{@link ProjectDiff#lines} 返回的是<b>全部行</b>
  * （未改的行也要有，否则前端画不出上下文）。
  * 一个 500 行的文件只改了 3 行，它照样返回 500 条 ——
  * 模型调一次 diff_mine 就被灌满，真正该看的那 3 行反而淹没了。
  *
  * <p>这里保留每处改动前后 {@code context} 行，中间的未改区段
  * 折叠成一条 {@code {"skipped":N}} 记录。模型看得懂这个标记。
  *
  * @param all     完整差异
  * @param context 每处改动前后保留几行
  * @return 裁剪后的差异
  */
 static JSONArray trimDiff(JSONArray all,int context)throws Exception{
  int n=all.length();
  if(n==0)return new JSONArray();
  int pad=Math.max(0,Math.min(20,context));
  boolean[] keep=new boolean[n];
  boolean anyChange=false;
  for(int i=0;i<n;i++){
   String tk=all.getJSONObject(i).optString("t"," ");
   if(!tk.equals(" ")){
    anyChange=true;
    int lo=Math.max(0,i-pad),hi=Math.min(n-1,i+pad);
    for(int k=lo;k<=hi;k++)keep[k]=true;
   }
  }
  // 一行都没改：不必把整个文件贴回去
  if(!anyChange)return new JSONArray().put(new JSONObject().put("note","该文件没有行级改动"));

  JSONArray out=new JSONArray();
  int skipped=0;
  for(int i=0;i<n;i++){
   if(keep[i]){
    if(skipped>0){out.put(new JSONObject().put("skipped",skipped));skipped=0;}
    out.put(all.getJSONObject(i));
   }else skipped++;
  }
  if(skipped>0)out.put(new JSONObject().put("skipped",skipped));
  return out;
 }

 /**
  * 算出「本轮开始到现在」改了哪些文件、哪些行。
  *
  * <p>这是给模型自查用的。它改完代码，最该问的一句话是
  * 「我到底动了什么」，而不是直接交出去。
  *
  * <p>对比基准是本轮开始时的项目快照（{@code original}），
  * 对比对象是当前暂存内容（{@code staged}）。两者都在内存里，不碰磁盘。
  *
  * @param args 参数：{@code withLines} 是否输出行级差异（默认 true），
  *             {@code context} 每处改动保留几行上下文，
  *             {@code path} 只看某一个文件
  * @return 新增、修改、删除三组，外加行级差异
  */
 JSONObject diffMine(JSONObject args)throws Exception{
  JSONObject before=original==null?null:original.optJSONObject("files");
  JSONObject after=staged==null?null:staged.optJSONObject("files");
  if(before==null)before=new JSONObject();
  if(after==null)after=new JSONObject();
  String only=args.optString("path","").trim();
  boolean withLines=!args.has("withLines")||args.optBoolean("withLines",true);
  int pad=args.optInt("context",3);

  JSONArray added=new JSONArray(),modified=new JSONArray(),removed=new JSONArray();
  int same=0;

  for(Iterator<String> it=after.keys();it.hasNext();){
   String n=it.next();
   if(!only.isEmpty()&&!n.equals(only))continue;
   String now=after.optString(n,"");
   if(!before.has(n)){
    added.put(new JSONObject().put("path",n).put("lines",now.split("\\n",-1).length));
    continue;
   }
   String was=before.optString(n,"");
   if(was.equals(now)){same++;continue;}
   JSONObject entry=new JSONObject().put("path",n)
    .put("linesBefore",was.split("\\n",-1).length)
    .put("linesAfter",now.split("\\n",-1).length);
   if(withLines){
    try{entry.put("lines",trimDiff(ProjectDiff.lines(was,now),pad));}
    catch(Exception e){entry.put("linesNote","行级对比失败："+e.getMessage());}
   }
   modified.put(entry);
  }
  for(Iterator<String> it=before.keys();it.hasNext();){
   String n=it.next();
   if(!only.isEmpty()&&!n.equals(only))continue;
   if(!after.has(n))removed.put(new JSONObject().put("path",n));
  }

  return new JSONObject()
   .put("added",added).put("modified",modified).put("removed",removed)
   .put("stats",new JSONObject().put("added",added.length())
    .put("modified",modified.length()).put("removed",removed.length()).put("unchanged",same))
   .put("note",added.length()+modified.length()+removed.length()==0
    ?"本轮还没有改动任何文件":"以上是本轮相对起点的全部改动");
 }

 JSONObject finalChanges(JSONObject changes)throws Exception{JSONObject next=ProjectEdits.apply(staged,staged.getJSONObject("files"),changes,"AI 暂存").getJSONObject("files"),old=original.getJSONObject("files"),out=new JSONObject();for(Iterator<String> it=next.keys();it.hasNext();){String n=it.next();if(!next.getString(n).equals(old.optString(n,null)))out.put(n,next.getString(n));}for(Iterator<String>it=old.keys();it.hasNext();){String n=it.next();if(!next.has(n))out.put(n,JSONObject.NULL);}return out;}
}
