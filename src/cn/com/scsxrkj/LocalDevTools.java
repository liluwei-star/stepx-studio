package cn.com.scsxrkj;
import org.json.*;
import java.util.Map;
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
 /**
  * 造一份「够工具用」的项目副本。
  *
  * <p><b>为什么不是整份拷贝：</b>项目对象里最占地方的是 {@code files}（所有文本内容），
  * 其次是 {@code snapshots} 和 {@code history} —— 而工具循环<b>从来不读</b>后两者。
  * 原来这里对传入项目做了两次 {@code new JSONObject(project.toString())}，
  * 把快照、历史、调试报告、美术资源全部又抄了一遍。几十 MB 的工程，
  * 一个请求里同时存在三份全文，手机堆顶掉就是「点发送之后应用直接退出」，
  * 而这条路径跟 AI 逻辑毫无关系，极难联想到是拷贝。
  *
  * <p>所以只搬工具真正会读的字段。<b>不能改成直接接管传入对象</b> ——
  * 「所有操作都在暂存副本上做，调用方的项目对象一个字不动」是这个类的核心契约，
  * 自测里有一条专门守它（{@code tool stages new files without overwriting original}）。
  */
 static JSONObject leanCopy(JSONObject project)throws Exception{
  JSONObject out=new JSONObject();
  if(project==null)return out;
  JSONObject files=project.optJSONObject("files");
  out.put("files",new JSONObject(files==null?"{}":files.toString()));
  /* 工具会读的其余字段：标识、名字、云端标记、二进制索引、美术资源 */
  for(String k:new String[]{"id","name","cloudSource","binaryFiles","artAssets"}){
   if(!project.has(k))continue;
   Object v=project.opt(k);
   out.put(k,v instanceof JSONObject?new JSONObject(v.toString())
    :v instanceof JSONArray?new JSONArray(v.toString()):v);
  }
  return out;
 }

 LocalDevTools(MainActivity a,JSONObject project)throws Exception{
  this.a=a;
  /*
   * 对比基准只装 files —— 它唯一被读的地方（diffMine、finalChanges）
   * 都只取 original.optJSONObject("files")。
   */
  JSONObject files=project==null?null:project.optJSONObject("files");
  original=project==null?null:new JSONObject().put("files",
   new JSONObject(files==null?"{}":files.toString()));
  /* 工作副本是精简副本：与调用方隔离，但不把快照和历史也抄一遍 */
  staged=project==null?null:leanCopy(project);
 }
 /**
 * 拼工具说明与行为准则。
 *
 * @param project  本轮有没有目标项目
 * @param nativeTools 服务端支持原生 function calling 吗
 *
 * <p><b>为什么要分原生/降级两种措辞：</b>提示词里原本写死了
 * 「需要工具时返回 JSON 对象」「结束时返回严格 JSON files 对象」。
 * 那是<b>降级路径</b>的协议 —— 服务端不支持 tools 时，
 * 模型只能把工具请求写进正文。
 *
 * <p>但在原生路径下模型是<b>看不到</b>这个 JSON 协议的：
 * 它直接调用 tools 参数。这两套说法同时出现在提示词里，
 * 模型会犯迷糊：既然要用 JSON 写在正文里，那我干脆不调工具了 ——
 * 于是原生 function calling 明明挂着，却一次都不被触发。
 * 这就是「明明是原生路径，行为却像降级路径」的由来。
 *
 * <p>所以措辞必须跟着实际路径走：原生路径只讲「直接调工具」，
 * 降级路径才讲「把工具请求写成 JSON」。
 */
  /**
  * 说明「怎么调工具」—— 这句话必须跟着实际协议走。
  *
  * <p>原生 function calling：模型直接调 tools 参数，不该看到任何 JSON 协议的说法。
  * <p>降级：服务端不支持 tools，只能把工具请求写进正文，格式必须是 JSON。
  */
 private static String callProtocol(boolean nativeTools){
  if(nativeTools)return "需要工具就直接调用对应的工具（一次可以调多个）。"
   +"不要把工具请求写成 JSON 放进正文 —— 系统认的是你直接发起的工具调用。";
  return "需要工具时只返回 JSON：{\"tools\":[{\"name\":\"工具名\",\"args\":{...}}]}。"
   +"允许在 JSON 前面先用一两句话说明你要做什么，但不要夹带大段解释。";
 }

 /**
  * 当前项目的概览，直接拼进系统提示词。
  *
  * <p><b>为什么必须在提示词里：</b>提示词教模型「用户问『你能看到这个项目吗』，
  * 第一句就该是『能，有 318 个文件，是 Vite + React』」——
  * 可模型<b>根本不知道</b>项目有 318 个文件。
  *
  * <p>于是只剩两条路：先调 list_files（违背「先回答问题」的要求，
  * 用户等一轮才看到第一句话），或者<b>编一个数字出来</b>。
  * 后者更糟 —— 那是在骗用户。
  *
  * <p>所以项目概览要像记忆、技能清单一样，<b>每轮自动带上</b>。
  * 代价是几十个字，换来的是模型第一句就能如实回答。
  *
  * @param project 当前项目；null 表示这轮没选项目
  * @return 概览文本；没有项目时返回空串
  */
 static String overview(JSONObject project){
  if(project==null)return "";
  JSONObject files=project.optJSONObject("files");
  if(files==null)return "";
  int count=files.length();
  if(count==0)return "\n\n【当前项目】项目是空的，还没有文件。";
  /*
   * 顶层目录分布：模型要知道「这是个单页应用」还是「这是个多模块工程」，
   * 得先看出文件的形状。这里只统计顶层，不递归 —— 递归太占地方。
   */
  java.util.TreeMap<String,Integer> top=new java.util.TreeMap<>();
  for(Iterator<String> it=files.keys();it.hasNext();){
   String n=it.next();
   int slash=n.indexOf('/');
   String k=slash<0?"（根目录）":n.substring(0,slash);
   Integer c=top.get(k);
   top.put(k,c==null?1:c+1);
  }
  StringBuilder dirs=new StringBuilder();
  int shown=0;
  for(java.util.Map.Entry<String,Integer> e:top.entrySet()){
   if(shown++>=8)break;
   if(dirs.length()>0)dirs.append("、");
   dirs.append(e.getKey()).append(' ').append(e.getValue()).append(" 个");
  }
  if(top.size()>8)dirs.append(" 等 ").append(top.size()).append(" 个顶层目录");
  StringBuilder sb=new StringBuilder();
  sb.append("\n\n【当前项目】").append(project.optString("name","未命名")).append("，共 ").append(count).append(" 个文件。");
  sb.append("\n顶层分布：").append(dirs).append("。");
  if(files.has("index.html"))sb.append("\n入口：index.html");
  else if(files.has("src/main.tsx")||files.has("src/App.tsx"))sb.append("\n入口：src 下的 React 应用");
  else if(files.has("src/main.ts")||files.has("src/main.js"))sb.append("\n入口：src 下的模块入口");
  String pkg=files.optString("package.json","");
  if(!pkg.isEmpty()){
   // 只挑依赖名 —— 完整 package.json 可能几百行，塞进提示词太占地方
   java.util.ArrayList<String> deps=new java.util.ArrayList<>();
   try{
    org.json.JSONObject pj=new JSONObject(pkg);
    for(String key:new String[]{"dependencies","devDependencies"}){
     JSONObject d=pj.optJSONObject(key);
     if(d==null)continue;
     for(Iterator<String> it=d.keys();it.hasNext();){
      String dep=it.next();
      if(!deps.contains(dep))deps.add(dep);
     }
    }
   }catch(Exception ignored){}
   if(!deps.isEmpty()){
    int n=Math.min(deps.size(),20);
    sb.append("\n依赖：");
    for(int i=0;i<n;i++){if(i>0)sb.append("、");sb.append(deps.get(i));}
    if(deps.size()>n)sb.append(" 等 ").append(deps.size()).append(" 个");
   }
  }
  sb.append("\n要看具体文件用 list_files，要读内容用 read_file。");
  return sb.toString();
 }

static String instructions(boolean project,boolean nativeTools){
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
  +"结果里 ok 是「这次验证通过了没有」。项目里没有测试文件时 ok 会是 false、ran 是 false —— "
  +"那表示没得跑，不是跑挂了，别当成代码有问题去反复改。"
  +"\n- run_script(code)：在隔离沙箱里跑一段 JS。可以 await fetch('/project.json') 读项目文件、"
  +"console.log 看中间值。适合验算数据、试算法、批量分析文件。"
  +"交出结果有两种写法，随便用一种：直接 return 值（最自然），或者赋值给 window.__neoResult。"
  +"结果会在返回的 result 字段里；只有 console.log 的话结果在 log 里，模型拿不到。"
  +"沙箱是只读的：你在里面改项目文件不会写回，要改得用 write_files / patch_file。"
  +"沙箱里没有 node、装不了 npm 包、也连不了网 —— 这是隔离，不是限制。";

 if(!project)return "本轮没有指定项目。用户问的是问题就先直接回答，别急着调工具；"
  +"需要动手时先用一句话说明你要做什么，干完用自然语言说结果。"
  +"这几类工具照常可用："+common
  +"\n\n另外还能用 search_connectors(query)、describe_connector(id,query可选,offset可选) 查官方连接器。"
  +"\n"+callProtocol(nativeTools)+"。工具调用最多 40 轮；做完正常用文字回答。";

 return "你是一个能真正动手的编程助手，不是只会给建议的聊天机器人。"
  /*
   * 【怎么跟用户说话】—— 这段是加的。
   *
   * <p><b>不加会怎样：</b>用户问「你能看到打开的项目吗？」，
   * 模型直接甩一串 JSON 或一句「已保存到指定项目」，
   * 用户问的「能不能看到」根本没有被回答。
   *
   * <p>根因是提示词只教了「怎么调工具」，没教「先答问题」。
   * 模型把「完成一次工具调用」当成了「回答用户」。
   */
  +"\n\n【怎么跟用户说话】"
  +"\n1. 用户问的是问题，就先回答问题。项目概览在本提示词里，"
  +"照实说就行（「能，这个项目有 42 个文件，是 Vite + React」），"
  +"不要凭印象报数字。"
  +"\n   这句话要和工具调用放在<同一条回复>里：先给结论，再发工具调用。"
  +"只发文字不发工具调用，等于这一轮就结束了，活根本没干 ——"
  +"要动手就必须真的把工具调用发出去。"
  +"\n2. 动手之前先用一句话说明你要做什么（「我先看下项目结构」），"
  +"让人知道没卡住。别让工具调用凭空出现。"
  +"\n3. 干完用人话说结果：改了哪几个文件、验证过没有、哪些没做、有什么风险。"
  +"别用「已保存到指定项目」这种系统通知代替回答。"
  +"\n4. 不要把 JSON、文件清单、工具参数原样甩给用户 —— 那是给你自己看的。"
  +"\n5. 说错了就承认，别绕。用户问「你刚才真的改了吗」，"
  +"就说清改了哪些文件、验证过没有。"
  +"\n\n【铁律】"
  +"\n1. 不要凭记忆猜文件内容。要看就用 read_file，要定位就用 search_code。"
  +"\n2. 改代码前必须先读那个文件。没读过就改，等于闭着眼睛写。"
  +"\n3. 改完系统会自动跑一次编译，结果会返回给你。编译不过就自己修，别把坏代码交给用户。"
  +"\n4. 不要声称做过没做过的事。没验证就说没验证。"
  +"\n5. 回答问题要直接回答。用户问「你能看到这个项目吗」，"
  +"第一句就该照实说「能，有 N 个文件，是……」，而不是先去调工具，"
  +"更不要凭空编一个数字 —— 概览里没有的事就说不确定。"
  +"\n6. 一次只做用户要求的事，别顺手大改无关文件。"
  +"\n\n【计划】"
  +"\n- write_plan(steps)：把要做的事列成清单。数组，每项 {text, done}。"
  +"开工前先写一次，做完一项改一次 done，这样长任务不会跑偏，用户也能看到进度。"
  +"\n- read_plan()：读回当前清单。"
  +"\n\n【工作流程】"
  +"\n用户说「这个」「这里」时，先看上下文里「用户当前正在看的文件」那一条 —— "
  +"那才是他指的东西，别反问是哪个文件。要看内容就用 read_file 读那个文件。"
  +"\n① list_files 看结构 → ② search_code 定位 → ③ read_file 读内容"
  +"\n④ patch_file / multi_patch / replace_text 改动 → ⑤ diff_mine 自查改了哪些行"
  +"\n⑥ 看自动编译结果 → ⑦ 改的是逻辑就跑 run_tests → ⑧ 有错继续修，直到通过才交付"
  +"\n\n【调用方式】"+callProtocol(nativeTools)+"。"
  +"一轮之内最多可以连续调用工具 40 次 —— 复杂任务要分步做，别指望一次跑完。"
  +"动手前先用一两句话说明你要做什么 —— 用户要看到你的动作；"
  +"但不要夹带大段解释、也不要重复解释代码。"
  +"\n\n【工具清单】"
  +"\nlist_files(prefix可选目录前缀,depth可选展开层数,entryLimit可选默认500最多2000)：按目录分组列出文件，带行数与类型。"
  +"没列全时会明说还剩多少，那时用 prefix 缩到某个目录再看。"
  +"\nread_file(path,startLine可选,lineCount可选)：读文件；不指定范围就读整份。"
  +"只读到一部分时结果里会告诉你还剩多少行、从哪行接着读。"
  +"注意返回内容每行开头的「行号: 」只是定位标记，不是文件内容，写回时不要带上。"
  +"\nsearch_code(query,prefix可选,glob可选,regex可选true用正则,ignoreCase可选,limit可选默认50最多200)：搜索，返回文件+行号+该行内容。"
  +"命中到上限时结果里会给 possiblyMore=true，那说明还有更多 —— 缩小 prefix/glob 或换更具体的词再搜。"
  +"例：找所有 tsx 里的某个词 → glob=\"*.tsx\"；只搜某目录 → prefix=\"src/app\"；写复杂条件 → regex=true。"
  +"\npatch_file(path,startLine,endLine,newContent)：按行范围替换，只动指定那几行，其余原样保留。"
  +"改代码首选这个 —— 不用把整个文件重写一遍，也不会误伤没读到的部分。"
  +"行号从 1 开始；endLine 不含在替换范围内（写 10 表示到第 9 行结束），"
  +"只改一行时不用传 endLine。"
  +"\nreplace_text(path,oldText,newText)：精确替换；oldText 必须在文件里只出现一次，适合改一两句。"
  +"\nmulti_patch(patches数组)：一次改多个文件的多个位置，每项 {path,startLine,endLine,newContent}。"
  +"endLine 规则和 patch_file 一样。行号一律按「改之前」的文件算，"
  +"不用操心前面一处改动会不会把后面的行号顶掉 —— 系统会从后往前应用。"
  +"要动两个以上文件就优先用它，别一个一个发。"
  +"\nwrite_files(files文件对象)：暂存并校验，最终一次写入。新增文件或大范围重写才用它。"
  +"\ninspect_project：项目概览（文件数、package.json、运行环境说明）。"
  +"\nlist_art_models、list_assets、generate_image(prompt,path可选,referenceFile可选,placeholder可选)："
  +"美术资源；generate_image 每轮最多3张（防刷屏），先 list_assets 复用已有图。"
  +"\ncheck_project：手动触发编译检查（改完系统会自动跑一次，一般不用手动调）。"
  +"\nrun_tests：跑项目里的单元测试（*.test.ts / *.spec.js）。结果里 ok 是这次验证过没过，"
  +"ran 是有没有真的跑起来 —— 项目里没有测试文件时 ok=false、ran=false，"
  +"那表示没得跑，不是跑挂了，别当成通过。"
  +"\nrun_script(code)：在沙箱里跑一段 JS，用来算东西、验证逻辑。"
  +"沙箱里能读到项目文件，但改不到 —— 在沙箱里改的文件不会写回项目，"
  +"要真的改文件必须用 write_file / patch_file / multi_patch。"
  +"想让结果出现在结果里，就把值 return 出去；只 console.log 的话只有日志能看到。"
  +"\nrun_preview：打开离线预览，看实际效果。"
  +"\nget_debug_reports：取运行日志。看用户报的错之前先调这个，别只凭他一句话猜。"
  +"\ndiff_mine(withLines可选,path可选)：看你本轮改了什么 —— 新增/修改/删除的文件和具体行差异。"
  +"改完代码先调这个自查，确认没改错地方、没误伤别的文件，再交付。"
  +"\ndiff_project(snapshot可选)：看整个项目相对历史快照改了哪些文件。"
  +"\nbuild_apk：本机编译并打包暂存快照。"
  +common
  +"\n\n【约束】工具只能操作当前指定项目；没有系统 shell（只有上面的 JS 沙箱）；"
  +"不可修改凭据、签名材料或二进制资源；"
  +(nativeTools?"文件改动直接通过工具写入，结束时用自然语言说明改了什么。"
                :"结束时返回严格 JSON files 对象。");
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

 /*
  * ── 防原地打转 ──────────────────────────────
  *
  * <p>模型有时会陷进一个圈：读同一个文件、搜同一个词，一遍又一遍，
  * 每一轮都「成功」，所以熔断（只统计整轮全败）根本不会触发。
  * 40 轮就这么耗完，用户等几分钟，最后什么也没改。
  *
  * <p>所以这里按「工具名 + 参数」记住上一次的结果。
  * 连续两次拿到完全一样的结果，说明这一轮调用没有带来任何新信息。
  *
  * <p>第三次起不再重复贴全文，只回一句「结果和上次一样」——
  * 既省 token（大文件全文贴三遍能吃掉一整轮预算），
  * 又明确告诉模型该换做法了。
  *
  * <p>为什么不靠参数判断「重复」：改完文件之后再读同一个文件，
  * 参数一样但结果变了，那是正常行为。按结果判断才不会误伤。
  */
 /*
  * 记住上一次只读工具的调用参数和结果，用来识别「一模一样的空转调用」。
  *
  * <p><b>这两个表必须有上限。</b>参数里可能带着整份文件列表、很长的搜索词，
  * 每一次不同的调用都会往表里塞一条，几千轮之后能撑到几十兆 ——
  * 手机上直接 OOM，而这正是当初要治的毛病。
  *
  * <p>超出上限就丢掉最老的一条（{@link java.util.LinkedHashMap} 的插入序正好当队列用）。
  *
  * <p><b>而且表里只放指纹，不放全文。</b>之前这里存的是工具结果的完整 JSON：
  * {@code read_file} 一个结果就能几百 KB，200 条就是几十 MB ——
  * 上限管住了条数，管不住每条多大，等于白设上限。
  * 现在存「长度 + 哈希」两个数，判重语义完全一样（同样的内容哈希必然相同），
  * 内存从几十 MB 降到几十 KB。
  */
 private final java.util.LinkedHashMap<String,String> lastResult=new java.util.LinkedHashMap<String,String>(64,0.75f,true){
  protected boolean removeEldestEntry(Map.Entry<String,String> eldest){return size()>REPEAT_CACHE_CAP;}
 };
 private final java.util.LinkedHashMap<String,Integer> sameCount=new java.util.LinkedHashMap<String,Integer>(64,0.75f,true){
  protected boolean removeEldestEntry(Map.Entry<String,Integer> eldest){return size()>REPEAT_CACHE_CAP;}
 };
 /** 重复调用识别表最多留多少条。够用就行 —— 真正会被反复调用的工具本来就那么几个。 */
 static final int REPEAT_CACHE_CAP=200;

 /**
  * 给一段文本算一个固定长度的指纹。
  *
  * <p>用途是「判断两次内容是否一样」，不需要内容本身。
  * 长度 + 哈希就够：内容一样则长度和哈希必然一样；
  * 反过来哈希撞了的概率极低，撞了也只是把一次重复识别当成重复，
  * 顶多让模型少看一遍结果，不会出错。
  *
  * @param s 待算指纹的文本
  * @return 形如 {@code 12345-ab12cd34} 的短字符串
  */
 static String fingerprint(String s){
  if(s==null)s="";
  return s.length()+"-"+Integer.toHexString(s.hashCode());
 }

 /**
  * 重复调用识别表当前占用的字符数（只算指纹字符串）。
  *
  * <p>给自测用：这张表要是又开始存全文，这个数会蹭蹭往上涨。
  *
  * @return 表内所有键值对的字符总数
  */
 int repeatCacheChars(){
  int n=0;
  for(java.util.Map.Entry<String,String> e:lastResult.entrySet())n+=e.getKey().length()+e.getValue().length();
  for(java.util.Map.Entry<String,Integer> e:sameCount.entrySet())n+=e.getKey().length()+String.valueOf(e.getValue()).length();
  return n;
 }

 /** 只读工具才做这个判断：写工具的重复调用可能有真实意图。 */
 static boolean isReadOnly(String n){
  return n.equals("read_file")||n.equals("list_files")||n.equals("search_code")
   ||n.equals("inspect_project")||n.equals("list_assets")||n.equals("list_art_models")
   ||n.equals("diff_mine")||n.equals("diff_project")||n.equals("check_project")
   ||n.equals("read_plan");
 }

 /**
  * 调工具，并顺手挡掉「同参数、同结果」的空转。
  *
  * @param name 工具名
  * @param args 参数
  * @return 工具结果；重复空转时返回一条说明而不是全文
  */
 JSONObject callOnce(String name,JSONObject args)throws Exception{
  JSONObject r=call(name,args);
  if(!isReadOnly(name))return r;
  /* 签名和指纹都只留固定长度，参数里可能带着整份文件清单 */
  String sig=name+"|"+fingerprint(args==null?"{}":args.toString());
  String now=fingerprint(r==null?"":r.toString());
  String prev=lastResult.get(sig);
  if(now.equals(prev)){
   int n=sameCount.containsKey(sig)?sameCount.get(sig)+1:2;
   sameCount.put(sig,n);
   if(n>=3){
    JSONObject same=new JSONObject().put("unchanged",true).put("times",n)
     .put("note","「"+name+"」用完全相同的参数已经连续拿到 "+n+" 次一模一样的结果，"
      +"这次没有再重复贴一遍全文。这说明这条路查不出新东西了 —— "
      +"请换个做法：换参数、换工具、换搜索词，或者把已经拿到的结论直接告诉用户。"
      +"如果你确实需要再完整看一次内容，请用 startLine/lineCount 分段读，"
      +"并说明为什么之前那份不够用。");
    sameCount.put(sig,n);
    return same;
   }
   r.put("repeatHint","注意：这是你和上一轮完全一样的调用，结果也一样。不必重复调用。");
   return r;
  }
  lastResult.put(sig,now);
  sameCount.put(sig,1);
  return r;
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
  /*
   * 文件表从当前暂存区现取。
   *
   * <p>每次工具调用都会重新进这里，所以这份引用反映的是此刻暂存区的内容 ——
   * 前面 write_files / patch_file 改过的东西，这里读到的是改后的。
   */
  JSONObject files=staged.getJSONObject("files"),out=new JSONObject();
  switch(name){
   case "list_art_models":return a.art.catalog();
   case "list_assets":return new JSONObject().put("assets",staged.optJSONArray("artAssets")).put("binaryPaths",staged.optJSONObject("binaryFiles")==null?new JSONArray():staged.getJSONObject("binaryFiles").names());
   case "generate_image":if(artCalls>=3)throw new Exception("本轮已达到3次绘图调用限制，请先使用已有资源");artCalls++;return a.art.tool(staged,args);
   case "inspect_project":out.put("name",staged.optString("name")).put("fileCount",files.length()).put("cloudSource",staged.optBoolean("cloudSource")).put("packageJson",files.optString("package.json","")).put("environment","离线 HTML/CSS/JS、TS/TSX/JSX 编译、React 与预装依赖、Tailwind 3；WebView隔离运行。原生Android/Node服务端/npm安装需外部环境。工具可以读写、搜索、检查、预览、离线打包和取回日志。");break;
   case "list_files":out.put("files",listFiles(files,staged,args));break;
   case "read_file":{
    /*
     * 读文件。越界要明说，不能返回空内容。
     *
     * <p>原来 startLine 超出文件行数时，循环一次都不执行，
     * 返回的 content 是空串。模型拿到的结果是
     * {@code {path, totalLines:100, content:""}} ——
     * 它会以为这 100 行全是空行，或者以为文件读不出来，
     * 于是换个行号再试，白烧几轮。
     *
     * <p>所以越界直接报错，并把真实行数说出来：
     * 模型立刻知道该从哪读，不用猜。
     */
    String path=args.getString("path");
    if(!files.has(path))throw new Exception(fileMissingMessage(path,files));
    /*
     * 拆行时要分清「内容有几行」和「末尾有没有换行」。
     *
     * <p>split(-1) 在文件以换行结尾时会多出一个空元素 ——
     * 「a\nb\nc\n」拆成 4 段而不是 3 段。于是 read_file 报 totalLines=4，
     * 而 patch_file 报 3：模型照 read_file 给的行号去改，会撞上
     * 「起始行 4 超出文件行数 3」，明明是同一个文件，两边说法不一致。
     *
     * <p>所以这里跟 patch_file 用同一套算法：末尾那个换行不算一行。
     */
    String rawText=files.getString(path);
    String[] raw=rawText.split("\\n",-1);
    int lineCount=raw.length;
    if(lineCount>0&&raw[raw.length-1].isEmpty()&&rawText.endsWith("\n"))lineCount--;
    String[] lines=new String[lineCount];
    System.arraycopy(raw,0,lines,0,lineCount);
    int start=Math.max(1,args.optInt("startLine",1));
    int count=Math.max(1,args.optInt("lineCount",lines.length));
    if(start>lines.length)throw new Exception("起始行 "+start+" 超出文件总行数："+path+" 一共 "
     +lines.length+" 行。请把 startLine 取在 1 到 "+lines.length+" 之间，或者不传 startLine 读整份。");
    int end=Math.min(lines.length,start-1+count);
    StringBuilder text=new StringBuilder();
    for(int i=start-1;i<end;i++){text.append(i+1).append(": ").append(lines[i]).append('\n');}
    out.put("path",path).put("totalLines",lines.length).put("content",text.toString())
     .put("startLine",start).put("endLine",end).put("returnedLines",end-start+1)
     /*
      * 必须明说行号不是内容。
      *
      * <p>read_file 的内容每行前面加了「12: 」方便定位，模型最容易犯的错
      * 就是把它当成文件内容原样写回去 —— 于是项目里每一行多一个行号，
      * 而这种损坏经常还能编译通过，用户只看到页面多了堆数字。
      * 写入路径上虽然会自动剥掉，但让模型一开始就别带才是最省事的。
      */
     .put("note","每行开头的「行号: 」是定位标记，不是文件内容；写回时不要带上。");
    /* 只读到一部分时说明还有多少 —— 模型才知道要不要接着读。 */
    if(end<lines.length)
     out.put("note","这次只读到第 "+end+" 行，后面还有 "+(lines.length-end)
      +" 行。要接着读就传 startLine="+(end+1)+"。");
    break;
   }
   case "search_code":{
    JSONObject sr=searchCode(files,args);
    JSONArray found=sr.optJSONArray("matches");
    if(found==null)found=new JSONArray();
    out.put("matches",found);
    /*
     * 命中数撞到上限时，要明说「还有更多」。
     * 不说的话，模型会以为这 50 条就是全部，
     * 于是得出「项目里只有这些地方用到它」这种错误结论。
     */
    if(sr.optBoolean("possiblyMore",false)){
     out.put("possiblyMore",true).put("limit",sr.optInt("limit",50))
      .put("note","结果已达上限 "+sr.optInt("limit",50)+" 条，可能还有更多命中。"
       +"要看得更全，请缩小 prefix/glob 范围，或换个更具体的搜索词。");
    }
    /*
     * 搜不到的时候，要说清楚「搜过了、没找到」，
     * 别让模型对着一个空数组自己猜 —— 它可能以为项目里根本没这段代码，
     * 于是得出错误结论；也可能以为是搜索词拼错了。
     *
     * 顺便把搜索范围报出来：搜了几个文件、命中几个。
     */
    if(found.length()==0){
     out.put("found",false).put("searchedFiles",files.length())
      .put("note","搜索词「"+args.optString("query","")+"」在本项目 "+files.length()+" 个文件里没有命中。"
       +"可能是代码确实不存在，也可能是用词不同（试试更短的关键字、或换个同义词），"
       +"也可能文件在二进制目录里没被索引。可先用 list_files 看有哪些文件，再 read_file 直接读。");
    }else{
     out.put("found",true);
    }
    break;
   }
   case "replace_text":{
    String editPath=args.optString("path","");
    /*
     * 先判「有没有给路径」，再判「文件在不在」。
     *
     * <p>顺序反了会给出误导性的报错：模型忘传 path 时会看到
     * 「文件不存在：」，于是它以为路径格式写错了，换个写法再试，
     * 而真正的问题是它压根没传这个参数。
     */
    if(editPath.isEmpty())throw new Exception("缺少 path —— 要改哪个文件");
    /*
     * 用当前暂存区的文件。
     *
     * <p>明确写出来而不是依赖外面那个变量：编辑类工具改完会换掉 staged，
     * 这里必须以「此刻暂存区」为准，才能保证基线对得上、
     * 不至于报「文件已变化，本轮建议未写入」。
     */
    JSONObject curFiles=staged.getJSONObject("files");
    if(!curFiles.has(editPath)){
     String hint=nearestFiles(curFiles,editPath);
     throw new Exception("文件不存在："+editPath
      +(hint.isEmpty()?"":"。项目里相近的文件有："+hint));
    }
    String oldText=args.optString("oldText","");
    if(oldText.isEmpty())throw new Exception("oldText 不能为空 —— 要替换的原文片段");
    String newText=args.optString("newText",null);
    if(newText==null)throw new Exception("缺少 newText —— 要替换成的新内容");
    String current=curFiles.getString(editPath);
    int at=current.indexOf(oldText);
    /*
     * oldText 对不上时，先试试「是不是带着 read_file 的行号」。
     *
     * <p>模型从 read_file 复制片段时，每行前面都有「12: 」。
     * 那种片段在文件里当然找不到 —— 直接报「精确匹配一次」，
     * 模型只会以为是自己上下文取窄了，于是重新读、重新扩大，
     * 再贴一次还是带行号，白烧几轮而且最后失败。
     *
     * <p>所以先剥一次再匹配。能匹配上就用剥过的继续走，
     * 并在结果里说明「你的 oldText 带了行号，已自动剥掉」——
     * 让模型知道下次别带。
     */
    boolean strippedOld=false;
    if(at<0||current.indexOf(oldText,at+1)>=0){
     String maybe=stripSnippetLineNumbers(oldText);
     if(!maybe.equals(oldText)){
      int at2=current.indexOf(maybe);
      if(at2>=0&&current.indexOf(maybe,at2+1)<0){at=at2;oldText=maybe;strippedOld=true;}
     }
    }
    if(at<0||current.indexOf(oldText,at+1)>=0)
     throw new Exception("替换片段必须在当前文件中精确匹配一次，请先读取并扩大上下文");
    /*
     * newText 里的行号同样要剥，否则替换进去的就是带行号的代码。
     *
     * <p>这里能给出精确到行的判据：newText 从 oldText 的位置开始，
     * 所以数一下 at 之前有几个换行，就知道这段在文件里是第几行。
     * 单行替换时「这一行的行号正好等于起始行」就足以认定是行号副本 ——
     * 光看一行内容本来判不出来，有了位置这个外部线索就能判。
     */
    int editLine=1;
    for(int k=0;k<at;k++)if(current.charAt(k)=='\n')editLine++;
    String cleanedNew=stripSnippetLineNumbers(newText,editLine);
    String replaced=current.substring(0,at)+cleanedNew+current.substring(at+oldText.length());
    ProjectEdits.stage(staged,new JSONObject().put(editPath,replaced));
    out.put("staged",true).put("path",editPath).put("replacements",1);
    if(strippedOld||!cleanedNew.equals(newText))
     out.put("strippedLineNumbers",true)
      .put("notice","oldText/newText 里带着 read_file 的行号前缀（例如「12: 」），已自动剥掉；以后直接给原文即可。");
    break;
   }
   case "patch_file":out.put("result",patchFile(staged.getJSONObject("files"),args));break;
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
    /*
     * 从行号大的往小的改。
     *
     * <p><b>为什么必须这样：</b>模型给的行号都是按<b>原文件</b>算的。
     * 如果先改第 2 行（插入三行），原第 10 行就变成第 13 行，
     * 接着按「第 10 行」去改就改错了地方 —— 而且不会报错，
     * 只是悄悄改坏了不相干的内容。
     *
     * <p>从后往前改，前面还没动，行号就一直有效。
     */
    java.util.ArrayList<JSONObject> ordered=new java.util.ArrayList<>();
    for(int pi=0;pi<patches.length();pi++)ordered.add(patches.getJSONObject(pi));
    ordered.sort((x,y)->Integer.compare(y.optInt("startLine",0),x.optInt("startLine",0)));
    for(int pi=0;pi<ordered.size();pi++){
     JSONObject pc=ordered.get(pi);
     try{done.put(patchFile(staged.getJSONObject("files"),pc));}
     catch(Exception e){failed.put(new JSONObject().put("path",pc.optString("path","")).put("error",e.getMessage()==null?"失败":e.getMessage()));}
    }
    /*
     * ok 是「成功了几处」，不是「全成功」——
     * 原来的写法只有 ok=成功数，模型很容易读成「都成功了」。
     * 现在补一个 allOk 布尔，并且有失败时把失败清单摆在最前面。
     */
    boolean allOk=failed.length()==0;
    out.put("ok",done.length()).put("allOk",allOk).put("results",done).put("failed",failed);
    if(!allOk)out.put("note","共 "+done.length()+" 处成功、"+failed.length()+" 处失败。"
     +"失败的那几处没有改动，请看 failed 数组里的原因；成功的那些已经生效。");
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
   case "write_files":{
    /*
     * files 有时会被模型写成字符串（把整个对象序列化进了字符串里）。
     *
     * <p>直接 getJSONObject 会抛 org.json 的原始异常，
     * 模型看到的是「JSONObject["files"] not a string」这种底层报错 ——
     * 它不知道该改什么，往往就把同样的东西再发一遍。
     *
     * <p>所以这里先把字符串解出来，解不出才报错，并且说清楚两种正确写法。
     */
    JSONObject wfFiles=args.optJSONObject("files");
    if(wfFiles==null){
     String rawFiles=args.optString("files","");
     if(rawFiles.trim().isEmpty())throw new Exception("write_files 需要 files 对象，形如 {\"文件路径\":\"完整内容\"}");
     try{wfFiles=new JSONObject(rawFiles);}
     catch(Exception e){throw new Exception("files 不是对象。请写成 {路径:内容} 这样的对象，"
      +"不要把整个对象再包成字符串。你发来的原文开头是："+rawFiles.substring(0,Math.min(120,rawFiles.length())));}
    }
    /*
     * 剥掉模型从 read_file 结果里带回来的行号前缀。
     *
     * <p>模型最常见的动作是「读出来 → 改两行 → 整份写回」，
     * 而 read_file 的内容每行都带 {@code 12: } 这样的定位信息。
     * 不剥的话，文件每一行前面会多一个 {@code N: }，
     * 而且这种损坏经常能编译通过，用户只会看到页面多出一堆数字。
     *
     * <p>剥的时候要在结果里说一声，模型才知道自己带回了行号 ——
     * 不说的话它会以为文件本来就这样，下次继续照原样写。
     */
    JSONArray stripped=new JSONArray();
    for(Iterator<String> it=wfFiles.keys();it.hasNext();){
     String n=it.next();
     Object v=wfFiles.opt(n);
     if(!(v instanceof String))continue;
     String raw=(String)v;
     String clean=stripLineNumbers(raw);
     if(!clean.equals(raw)){wfFiles.put(n,clean);stripped.put(n);}
    }
    ProjectEdits.stage(staged,wfFiles);
    out.put("staged",true).put("message","暂存文件已校验，最终成功后写回项目");
    if(stripped.length()>0)
     out.put("strippedLineNumbers",stripped)
      .put("notice","我检查到这些文件的内容里每一行都带「行号: 」前缀，那是 read_file 返回的定位信息、不是文件内容，已经去掉后再写入。"
       +"下次读文件后改完，直接把行号前缀去掉，或者改用 patch_file 只改指定几行。");
    break;}
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
   default:
    /*
     * 工具名写错时，要告诉模型**正确的名字有哪些**。
     *
     * <p>只说「不支持的工具：xxx」是不够的：模型不知道自己该写什么，
     * 下一轮大概率再猜一个错的名字，然后又是同样的错 ——
     * 三轮下来触发熔断，用户只看到一句「工具调用全部失败」。
     *
     * <p>把可用工具名列出来，模型下一轮就能自己对上。
     * 另外做一次「最接近的名字」提示，省得它靠猜。
     */
    throw new Exception("不支持的工具："+name+"。可用工具："+availableToolNames()
     +"。请从上面这些名字里选一个，参数名要照工具说明里的写。");
  }return out;
 }
 /**
  * 找出项目里和给定路径最接近的几个文件名。
  *
  * <p>模型写路径时经常差一个目录、少一个后缀、把斜杠写成反斜杠。
  * 只说「文件不存在」它只能瞎猜；把相近的几个列出来，它一眼就能对上。
  *
  * @param files 项目的文件表
  * @param want  模型给的路径
  * @return 逗号分隔的候选路径（最多 5 个，没有则空串）
  */
 private static String nearestFiles(JSONObject files,String want){
  if(files==null||want==null)return "";
  String w=want.toLowerCase(java.util.Locale.ROOT);
  // 打分：完全相同的文件名算最高，其次是包含关系，再次是共用后缀
  java.util.List<String> names=new java.util.ArrayList<>();
  java.util.Iterator<String> it=files.keys();
  while(it.hasNext())names.add(it.next());
  // 用「分数 + 路径」一起存，排序时按分数从高到低
  java.util.List<String> hits=new java.util.ArrayList<>();
  java.util.Map<String,Integer> scores=new java.util.LinkedHashMap<>();
  for(String n:names){
   String ln=n.toLowerCase(java.util.Locale.ROOT);
   String base=ln.substring(ln.lastIndexOf('/')+1);
   String wbase=w.substring(w.lastIndexOf('/')+1);
   int score=-1;
   if(ln.equals(w))score=100;
   else if(base.equals(wbase))score=80;
   else if(ln.endsWith(w)||w.endsWith(ln))score=60;
   else if(base.contains(wbase)||wbase.contains(base))score=40;
   else if(ln.contains(w)||w.contains(ln))score=20;
   if(score>=0){hits.add(n);scores.put(n,score);}
  }
  if(hits.isEmpty())return "";
  // 分数高的排前面；同分保持文件表里的原顺序
  // 用 Collections.sort 而不是 List.sort —— 后者要 API 24 以上才稳
  java.util.Collections.sort(hits,new java.util.Comparator<String>(){
   public int compare(String a,String b){return scores.get(b)-scores.get(a);}
  });
  StringBuilder sb=new StringBuilder();
  for(int i=0;i<hits.size()&&i<5;i++){
   if(i>0)sb.append("、");
   sb.append(hits.get(i));
  }
  return sb.toString();
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
  /*
   * 文件条目总数上限。
   *
   * <p>大项目（几千个文件）全列出来，光这个 JSON 就几百 KB —— 一轮工具
   * 预算 48 KB 会被它一个工具吃光，同轮的其他工具结果全被挤掉。
   *
   * <p>而且模型真要挨个看几千个文件也没意义 —— 它需要的是结构，
   * 剩下的用 prefix 缩小范围再看。所以这里限 500 条，
   * 超了就明说「还有多少没列出来」。
   */
  int entryLimit=Math.max(1,Math.min(2000,args.optInt("entryLimit",500)));
  int listed=0;
  int totalEntries=0;
  for(java.util.ArrayList<String> v:byDir.values())totalEntries+=v.size();
  for(java.util.Map.Entry<String,java.util.ArrayList<String>> e:byDir.entrySet()){
   JSONArray group=new JSONArray();
   java.util.Collections.sort(e.getValue());
   for(String n:e.getValue()){
    if(listed>=entryLimit)break;
    String content=files.optString(n,"");
    /*
     * 算行数用 indexOf 循环，不逐字符扫。
     * 逐字符 charAt 在大文件上是 O(n) 的解释执行，比 indexOf 慢一个量级；
     * 82 MB 的项目里这一项能差出好几秒。
     */
    /*
     * 行数跟 read_file、patch_file 用同一个口径：
     * 末尾的换行不算一行。
     *
     * <p>原来数的是「换行符个数 + 1」，文件以换行结尾时会多算一行。
     * 于是 list_files 说 101 行、patch_file 说 100 行 ——
     * 模型照着列表里的行号去改，会撞「起始行超出文件行数」。
     *
     * <p>仍然用 indexOf 循环，不逐字符扫：逐字符 charAt 在大文件上
     * 是 O(n) 的解释执行，比 indexOf 慢一个量级。
     */
    int lines=0;
    if(!content.isEmpty()){
     int nl=content.indexOf('\n');
     while(nl>=0){lines++;nl=content.indexOf('\n',nl+1);}
     // 末尾没有换行时，最后一段内容也占一行
     if(!content.endsWith("\n"))lines++;
    }
    group.put(new JSONObject().put("path",n).put("lines",lines).put("characters",content.length())
     .put("kind",kindOf(n)));
    listed++;
   }
   out.put(new JSONObject().put("dir",e.getKey()).put("count",group.length()).put("files",group));
   if(listed>=entryLimit)break;
  }
  /*
   * 文件没列全时必须说明 —— 不说的话，模型会以为项目就这么点文件，
   * 于是得出「这个项目只有这几个模块」这种错误结论。
   */
  if(listed<totalEntries){
   out.put(new JSONObject().put("dir","（还有 "+(totalEntries-listed)+" 个文件没列出来）")
    .put("count",totalEntries-listed).put("files",new JSONArray())
    .put("note","文件条目已达上限 "+entryLimit+" 条，还有 "+(totalEntries-listed)
     +" 个文件没列出来。请用 prefix 指定目录，或用 depth 调小展开层数再列一次。"));
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
  * @param args  参数：{@code query}，{@code prefix}，{@code glob}，{@code regex}，{@code ignoreCase}，{@code limit}
  * @return 含 {@code matches}（命中列表）、{@code possiblyMore}（是否可能还有更多）、{@code limit} 的对象
  */
 private JSONObject searchCode(JSONObject files,JSONObject args)throws Exception{
  String q=args.optString("query","").trim();
  if(q.isEmpty()||q.length()>300)throw new Exception("搜索词需为1到300字符");
  String prefix=args.optString("prefix","").trim();
  String glob=args.optString("glob","").trim();
  boolean regex=args.optBoolean("regex",false);
  boolean ignoreCase=!args.has("ignoreCase")||args.optBoolean("ignoreCase",true);
  /*
   * 结果条数上限。
   *
   * <p><b>为什么不能没有上限：</b>模型搜个常见词（"import"、"e"、"const"）
   * 就能在几千个文件里命中几万行。每行最多 400 字符，几万行就是几 MB 的
   * JSON —— 先把内存吃光（和之前的 OOM 一回事），再被外层整体截断成
   * <b>非法 JSON</b>，模型看到半个数组，更糟。
   *
   * <p>所以默认 50 条、硬上限 200 条。schema 里本来就写着「默认 50」，
   * 但实现里是 Integer.MAX_VALUE —— 服务端一般不会替模型填默认值，
   * 模型不传 limit 就是真的无上限。这是个实打实的坑。
   */
  int limit=Math.min(200,Math.max(1,args.optInt("limit",50)));
  java.util.regex.Pattern pattern;
  if(regex){
   try{
    pattern=java.util.regex.Pattern.compile(q,ignoreCase?java.util.regex.Pattern.CASE_INSENSITIVE:0);
   }catch(Exception e){throw new Exception("正则表达式无效："+e.getMessage());}
  }else{
   pattern=java.util.regex.Pattern.compile(java.util.regex.Pattern.quote(q),ignoreCase?java.util.regex.Pattern.CASE_INSENSITIVE:0);
  }
  JSONArray matches=new JSONArray();
  boolean more=false;
  for(Iterator<String> it=files.keys();it.hasNext();){
   if(matches.length()>=limit){more=true;break;}
   String n=it.next();
   if(!prefix.isEmpty()&&!n.startsWith(prefix))continue;
   if(!glob.isEmpty()&&!globMatch(n,glob))continue;
   String[] code=files.getString(n).split("\\n");
   for(int i=0;i<code.length;i++){
    if(matches.length()>=limit){more=true;break;}
    if(pattern.matcher(code[i]).find())
     matches.put(new JSONObject().put("path",n).put("line",i+1).put("text",code[i].trim().substring(0,Math.min(400,code[i].trim().length()))));
   }
  }
  return new JSONObject().put("matches",matches).put("possiblyMore",more).put("limit",limit);
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
  /*
   * 转成正则。
   *
   * <p><b>关键在两个星号后面跟着的斜杠：</b>
   * 「src 目录下的所有 .ts」这种模式，由 src 前缀 + 任意层目录 + 斜杠 + *.ts 组成。
   * 如果只是把两个星号换成点星，中间那个斜杠就变成了硬性的 ——
   * 于是 {@code src/a.ts} 匹配不上（要 {@code src/} 后面还得多一层目录）。
   *
   * <p>而这恰恰是模型最常写的模式：它想搜 src 下面所有 .ts，
   * 结果一条都没搜到，只能换个写法再试一轮。
   *
   * <p>所以「双星加斜杠」要整体变成「可选的任意层目录」，零层也能匹配。
   */
  StringBuilder re=new StringBuilder("^");
  for(int i=0;i<g.length();i++){
   char c=g.charAt(i);
   if(c=='*'&&i+1<g.length()&&g.charAt(i+1)=='*'){
    i++;
    // **/ → 任意层目录（可以零层）
    if(i+1<g.length()&&g.charAt(i+1)=='/'){re.append("(?:.*/)?");i++;}
    // 结尾的 ** → 任意内容（可以跨目录）
    else re.append(".*");
   }else if(c=='*')re.append("[^/]*");
   else if(c=='?')re.append("[^/]");
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
  * <p>行号从 1 开始，endLine 是「不含」的上界（不传就只改 startLine 那一行）。
  * 替换前会校验行号范围，
  * 并回显替换前后的片段，让模型能确认改对了地方。
  *
  * @param files 当前暂存的文件表
  * @param args  参数
  * @return 结果描述
  */
 private JSONObject patchFile(JSONObject files,JSONObject args)throws Exception{
  String path=args.optString("path","");
  if(path.isEmpty())throw new Exception("缺少 path —— 要改哪个文件");
  if(!files.has(path)){
   String hint=nearestFiles(files,path);
   throw new Exception("文件不存在："+path+(hint.isEmpty()?"":"。项目里相近的文件有："+hint));
  }
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
  /*
   * 这里踩过两个坑，都跟 endLine 的默认值和下标含义有关。
   *
   * <p><b>坑一：不传 endLine 必然报错。</b>
   * 原作 {@code Math.min(lineCount,args.optInt("endLine",0))}，
   * 不传得到 0，接着 end<start 抛「行号范围无效」。
   * 而「只改一行」是最常见的改法 —— 最普通的调用反而一定失败。
   * 模型会以为行号算错，重新读文件、重新数行、再试还是错，耗到轮数上限。
   *
   * <p><b>坑二：把 endLine 当数组索引，吃掉一行。</b>
   * {@code list.subList(end,lineCount)} 里 end 是 0-based，
   * endLine 是 1-based。startLine=2、endLine=3 本意「只改第 2 行」，
   * 却因为 subList(3,3) 为空而把第 3 行整行删掉。
   * 这种错模型自己发现不了 —— diff_mine 只说「第 2 行变了」，
   * 少掉的那行要等用户跑起来才知道。
   *
   * <p>现在统一成 1-based 半开区间：替换 [startLine, endExclusive)，
   * 尾部从索引 endExclusive-1 开始保留。不传 endLine 时只改一行。
   */
  int endLineArg=args.optInt("endLine",0);
  /*
   * endLine 是「1 起、不含」的行号，不是数组索引。
   *
   * <p><b>差一个索引会吃掉一行。</b>原来先把 endLine 直接当索引传进
   * {@code list.subList(end, lineCount)}，于是：
   * startLine=2、endLine=3（本意「只改第 2 行」）→ subList(3,3) 是空的
   * → 第 3 行被整行删掉。
   *
   * <p>模型改完自己也不会发现 —— diff_mine 显示的是「第 2 行变了」，
   * 少掉的那一行要到用户跑起来才发现。这类 bug 比报错可怕得多。
   *
   * <p>所以这里统一成 1-based 的半开区间：替换 [startLine, endExclusive)，
   * 尾部从索引 endExclusive-1 开始保留。不传 endLine 时只改一行。
   */
  int endExclusive=endLineArg>0?Math.min(lineCount+1,Math.max(start+1,endLineArg)):start+1;
  /*
   * endLine <= startLine 不报错，当作「只改这一行」。
   *
   * <p>模型有两种直觉：有人把 endLine 当「含」，于是写
   * startLine=3、endLine=3 想改第 3 行；也有人按「不含」写 startLine=3、endLine=4。
   * 两种都得能用 —— 对着一个行号范围报错，模型只会以为行号算错了，
   * 重新读文件、重新数行，再试一次还是同样的写法，白烧几轮。
   *
   * <p>所以这里一律往上兜到「至少改一行」，并在结果里说明它实际改的是哪几行。
   */
  boolean endLineClamped=endLineArg>0&&endLineArg<=start;
  if(start>lineCount)throw new Exception("起始行 "+start+" 超出文件行数 "+lineCount);

  /*
   * newContent 也可能带着 read_file 的行号前缀。
   *
   * <p>模型经常是「照着读到的第 12 行改」，于是把「12: xxx」整段贴进 newContent。
   * 这里剥掉 —— 判据同样严格：整段都符合「数字: 」且连续递增才动。
   * 一段真实的代码不可能长成这样。
   *
   * <p><b>但有一类文件本来就长这样。</b>数据文件、清单、导出的编号列表，
   * 每一行就是「行号: 内容」。对它们剥号等于把内容改坏。
   * 判据很简单：要改的这一行现在自己就写成「这一行的行号: …」，
   * 那说明文件本身带行号，一个字符都别动。
   */
  boolean numberedFile=false;
  if(start<=list.size()){
   String currentLine=list.get(start-1);
   numberedFile=currentLine.startsWith(start+": ");
  }
  if(!numberedFile)newContent=stripSnippetLineNumbers(newContent,start);
  // newContent 末尾的换行是格式噪音，去掉，否则会多出空行
  String nc=newContent;
  while(nc.endsWith("\n"))nc=nc.substring(0,nc.length()-1);
  /*
   * 文件是 CRLF 的话，新内容的换行也换成 CRLF。
   *
   * <p>拼接时行与行之间只补 \n；文件原有的行自己带着 \r，所以整体仍是 CRLF。
   * 但新写进去的那几行是模型给的，只有 \n —— 不换的话，
   * 一个文件里就同时存在 CRLF 和 LF 两种行尾。
   * 这在编辑器里看不出来，等到提交到 git、或者被别的工具解析时才开始闹。
   */
  int crLines=0;
  for(String line:list)if(line.endsWith("\r"))crLines++;
  if(crLines*2>list.size())nc=nc.replace("\n","\r\n");

  java.util.ArrayList<String> result=new java.util.ArrayList<>(list.subList(0,start-1));
  if(!nc.isEmpty())for(String s:nc.split("\\n",-1))result.add(s);
  result.addAll(list.subList(endExclusive-1,lineCount));

  StringBuilder sb=new StringBuilder();
  for(int i=0;i<result.size();i++){
   sb.append(result.get(i));
   if(i<result.size()-1)sb.append('\n');
  }
  if(trailingNewline&&!result.isEmpty())sb.append('\n');
  String replaced=sb.toString();

  ProjectEdits.stage(staged,new JSONObject().put(path,replaced));
  // 回显改动前的原文，模型能自己确认改对了地方
  StringBuilder before=new StringBuilder();
  for(int i=start-1;i<Math.min(endExclusive-1,start-1+8)&&i<list.size();i++)before.append(list.get(i)).append('\n');
  JSONObject result2=new JSONObject();
  result2.put("staged",true).put("path",path)
   .put("replacedLines",endExclusive-start).put("newLines",nc.isEmpty()?0:nc.split("\\n",-1).length)
   .put("totalLinesAfter",trailingNewline&&result.isEmpty()?0
     :replaced.split("\\n",-1).length-(replaced.endsWith("\n")?1:0))
   .put("before",before.toString());
  /*
   * 告诉模型实际改的是哪几行。endLine 两种直觉都能用，
   * 但结果里要如实回报，模型才能核对。
   */
  result2.put("replacedFrom",start).put("replacedTo",endExclusive-1);
  if(endLineClamped)
   result2.put("note","endLine="+endLineArg+" 不大于 startLine="+start+"，按「只改这一行」处理，"
    +"实际替换的是第 "+start+" 行。");
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

 /**
  * 文件找不到时，把「你要的路径」和「实际有哪些」一起给出去。
  *
  * <p>只说一句「文件不存在」，模型只知道失败，不知道该换成什么路径 ——
  * 下一轮它多半再猜一个，还是错。三轮下来就触发熔断，
  * 明明只是路径写错了一个字母。
  *
  * <p>所以这里附上现有文件清单。清单可能很长，只给前 40 个，
  * 但足够模型对上名字了。
  */
 static String fileMissingMessage(String path,JSONObject files){
  StringBuilder sb=new StringBuilder();
  sb.append("文件不存在：").append(path).append("。本项目现有文件：");
  Iterator<String> it=files.keys();int n=0;StringBuilder names=new StringBuilder();
  while(it.hasNext()){
   String k=it.next();
   if(n++>0)names.append("、");
   names.append(k);
   if(n>=40){names.append(" 等").append(files.length()).append("个");break;}
  }
  sb.append(names.length()==0?"（没有文件）":names.toString());
  sb.append("。请照上面的路径重试，路径要完全一致。");
  return sb.toString();
 }

 /**
  * 列出所有可用工具名，给模型对照用。
  *
  * <p>工具名拼错是最常见的模型失误（少个下划线、把 list_files 写成 listFile）。
  * 光说「不支持」模型改不了；把清单给它，它一眼就能看出该用哪个。
  */
 static String availableToolNames()throws Exception{
  StringBuilder sb=new StringBuilder();
  for(ToolSchema.Tool st:ToolSchema.all()){
   if(sb.length()>0)sb.append("、");
   sb.append(st.name);
  }
  return sb.toString();
 }

 /** 行号前缀的正则。整份和片段共用一份，免得两处走偏。 */
 static final java.util.regex.Pattern STRIP_LINE=java.util.regex.Pattern.compile("^(\\d+): (.*)$");

 /**
  * 按 {@code \n} 拆行，行尾的 {@code \r} 留在行里。
  *
  * <p><b>为什么不能直接 split 之后就用：</b>Windows 上导入的项目、
  * 云端同步下来或 ZIP 解出来的文件常常是 CRLF。{@code (.*)$} 里的 {@code .}
  * 不匹配 {@code \r}，而 {@code matches()} 要求整串吃完 ——
  * 于是「12: code\r」永远匹配不上，行号剥离对 CRLF 文件<b>整个失效</b>，
  * 号照样被写进文件，而且这类文件大多在 Windows 上编辑，看着还特别正常。
  *
  * <p>所以匹配前把行尾 {@code \r} 摘掉，写回时再补上，换行风格原样保留。
  */
 static String[] splitKeepCr(String content){
  return content.split("\n",-1);
 }

 /** 摘掉行尾的 {@code \r}，用来做匹配。 */
 static String withoutCr(String line){
  return line.endsWith("\r")?line.substring(0,line.length()-1):line;
 }

 /**
  * 去掉模型从 read_file 结果里带回来的行号前缀。
  *
  * <p><b>为什么需要：</b>read_file 返回的内容每行都带 {@code "12: "} 这样的行号，
  * 那是给人读的定位信息，不是文件内容。而模型最常见的动作就是
  * 「读出来 → 改两行 → 整份写回去」—— 它往往不会自己删掉那些前缀。
  *
  * <p>结果就是把行号写进项目文件：每一行前面多一个 {@code N: }。
  * 更糟的是这东西往往还能编译通过（在 JS 里就是一句标签 + 表达式），
  * 用户看到的现象是「页面多了一堆乱七八糟的数字」，查半天查不出原因。
  *
  * <p><b>判据要严，宁可漏剥也不能错剥：</b>只有当
  * <ol>
  *   <li>所有非空行都以 {@code 数字: } 开头，</li>
  *   <li>而且这些数字恰好是从 1 开始连续递增的</li>
  * </ol>
  * 才认定这是带行号的副本。真实代码里不会出现这种严格递增的行号前缀，
  * 所以不会误伤正常内容。
  *
  * @param content 模型交回来的内容
  * @return 剥离后的内容；不像行号副本时原样返回
  */
 static String stripLineNumbers(String content){
  if(content==null||content.isEmpty())return content;
  String[] lines=splitKeepCr(content);
  java.util.regex.Pattern p=STRIP_LINE;
  int expect=1,checked=0;
  for(String raw:lines){
   String line=withoutCr(raw);
   if(line.isEmpty())continue;
   java.util.regex.Matcher m=p.matcher(line);
   if(!m.matches())return content;
   if(Integer.parseInt(m.group(1))!=expect)return content;
   expect++;checked++;
  }
  /* 少于两行不值得判断，也可能只是内容里恰好有个「1: 」开头 */
  if(checked<2)return content;
  /*
   * 重建：只在行与行之间补 \n，不补在每行后面。
   *
   * <p>split(-1) 在「内容以换行结尾」时会多出一个空元素代表那个换行；
   * 如果每行后面都补一个 \n，这个空元素就被补成了额外的空行 ——
   * 一份 CRLF 文件剥完号会平白多出一行。
   */
  StringBuilder sb=new StringBuilder();
  for(int i=0;i<lines.length;i++){
   String raw=lines[i],line=withoutCr(raw);
   if(i>0)sb.append('\n');
   if(!line.isEmpty()){
    java.util.regex.Matcher m=p.matcher(line);
    if(m.matches())sb.append(m.group(2));
   }
   if(raw.length()>line.length())sb.append('\r');
  }
  return sb.toString();
 }

 /**
  * 片段版的行号剥离，给 {@code patch_file} 的 newContent 用。
  *
  * <p>整份剥离要求行号从 1 开始，因为整份文件的第 1 行就是第 1 行。
  * 但模型改文件时改的往往是中间几行 —— 它读到的片段是
  * {@code 12: xxx / 13: yyy}，起始值不是 1。用整份的判据去判，
  * 这批行号<b>一个都剥不掉</b>，直接写进项目。
  *
  * <p>所以这里只要求「数字连续严格递增」，起始值任意。
  * 代价是一段恰好每行都长成 {@code 5: …/6: …/7: …} 的真实内容会被误剥，
  * 但那本身就是行号副本的样子 —— 误剥一次用户看得见，
  * 写进行号却常常编译通过、极难发现，两害相权取轻。
  *
  * @param content 片段内容
  * @return 剥离后的内容；不像行号副本时原样返回
  */
 static String stripSnippetLineNumbers(String content){
  return stripSnippetLineNumbers(content,0);
 }

 /**
  * 带位置提示的片段剥离。
  *
  * <p>单行内容光看格式判不出来（{@code "5: 说明"} 可能是正常的 YAML 键），
  * 但 {@code patch_file} 知道自己要改的是第几行 —— 如果模型交给我们的
  * 那一行开头恰好是这个行号，那就不是巧合了，剥。
  *
  * @param hintStart 这一段在文件中的起始行号；0 表示不知道
  */
 static String stripSnippetLineNumbers(String content,int hintStart){
  if(content==null||content.isEmpty())return content;
  String[] lines=splitKeepCr(content);
  java.util.regex.Pattern p=STRIP_LINE;
  int expect=-1,checked=0,firstNo=-1;
  for(String raw:lines){
   String line=withoutCr(raw);
   if(line.isEmpty())continue;
   java.util.regex.Matcher m=p.matcher(line);
   if(!m.matches())return content;
   int n=Integer.parseInt(m.group(1));
   if(firstNo<0)firstNo=n;
   if(expect>=0&&n!=expect)return content;
   expect=n+1;checked++;
  }
  /* 只有一行时，只能靠「行号正好等于这段的起始行」这个外部线索来判断 */
  if(checked<2&&!(checked==1&&hintStart>0&&firstNo==hintStart))return content;
  StringBuilder sb=new StringBuilder();
  for(int i=0;i<lines.length;i++){
   String raw=lines[i],line=withoutCr(raw);
   if(i>0)sb.append('\n');
   if(!line.isEmpty()){
    java.util.regex.Matcher m=p.matcher(line);
    if(m.matches())sb.append(m.group(2));
   }
   if(raw.length()>line.length())sb.append('\r');
  }
  return sb.toString();
 }

 /** 记录一次「行号前缀被剥掉」的事，好在工具结果里告诉模型。 */
 static boolean looksNumbered(String content){
  if(content==null)return false;
  return !content.equals(stripLineNumbers(content));
 }

/**
  * 算出「本轮暂存区相对项目起点改了哪些文件」。
  *
  * <p>返回的表直接交给 MainActivity 当改动集合用：值是新内容，
  * 文件被删掉的值是 {@link JSONObject#NULL}。
  *
  * <p><b>这里绝不能绕道 {@code ProjectEdits.apply()}。</b>
  * apply() 是<b>提交</b>路径：它要跑路径校验、按项目规模校验、
  * 按云端协议校验，还要往 history 里写一条、往 snapshots 里塞一份存档。
  * 只是「算个差异」而已，用不着这一整套，而且副作用很明显：
  * <ul>
  *   <li>它会把一份空改动当成一次提交记进历史；</li>
  *   <li>更糟的是校验会<b>抛异常</b> —— 老项目里只要有一个不合规的
  *       历史路径（比如早期版本留下的 {@code a//b}），
  *       差分这一步就整段失败，而调用方外面套着
  *       {@code catch(Exception ignore){}}，异常被静默吞掉，
  *       stagedFiles 于是<b>根本不会挂到结果上</b>。</li>
  * </ul>
  * 用户看到的正是最莫名其妙的那种现象：AI 说「改好了」，
  * 项目却一个字都没变，日志里也没有任何错误。
  *
  * <p>所以差异就老老实实比两张文件表，纯读、无副作用、不会失败。
  *
  * @param changes 保留参数以兼容调用方（此实现不再需要它）
  */
 JSONObject finalChanges(JSONObject changes)throws Exception{
  /*
   * 有 changes 就先合进暂存副本，再算差异。
   *
   * <p><b>这一步不能省。</b>降级路径（服务端不支持原生 function calling）下，
   * 模型是把整个 files 对象写进正文的 —— 那些内容不在暂存区里，
   * 只有靠这里合进去，后面的差异才看得见它们。
   *
   * <p>合并走 ProjectEdits.stage：路径校验、内容校验、cloudSource 规则
   * 一个不少，只是不产生快照和历史（那是提交阶段的事）。
   */
  if(changes!=null&&changes.length()>0){
   /*
    * 降级路径同样要剥行号前缀。
    *
    * <p>这条路是模型把整个 files 写进正文 —— 它刚 read_file 过，
    * 手上那份内容就是带行号的。不剥就把行号一起写进项目。
    */
   for(Iterator<String> it=changes.keys();it.hasNext();){
    String n=it.next();
    Object v=changes.opt(n);
    if(v instanceof String)changes.put(n,stripLineNumbers((String)v));
   }
   ProjectEdits.stage(staged,changes);
  }
  JSONObject next=staged.getJSONObject("files");
  JSONObject old=original==null?null:original.optJSONObject("files");
  JSONObject out=new JSONObject();
  if(old==null){for(Iterator<String> it=next.keys();it.hasNext();){String n=it.next();out.put(n,next.optString(n,""));}return out;}
  for(Iterator<String> it=next.keys();it.hasNext();){
   String n=it.next();
   String now=next.optString(n,"");
   /* 起点没有这个文件，或者内容变了 —— 都算本轮改动 */
   if(!old.has(n)||!now.equals(old.optString(n,"")))out.put(n,now);
  }
  /* 起点有、现在没有 —— 本轮删掉了，用 NULL 表示删除 */
  for(Iterator<String> it=old.keys();it.hasNext();){
   String n=it.next();
   if(!next.has(n))out.put(n,JSONObject.NULL);
  }
  return out;
 }
}
