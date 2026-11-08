package cn.com.scsxrkj;
import org.json.*;

/**
 * 工具的 JSON Schema 定义。
 *
 * <p><b>为什么要单独一个类：</b>工具的参数说明以前是塞在系统提示词里的纯文本，
 * 模型得自己照着读。现在改成原生 function calling，参数结构由 API 层保证 ——
 * 但这要求每个工具都有一份机器可读的 schema。两边必须一致，改一处就得改两处，
 * 所以集中放在这里，别散落在各处。
 *
 * <p><b>每个 schema 的三要素：</b>
 * <ul>
 *   <li><b>description</b> —— 模型据此决定「这个工具该不该用」。写「做什么」，
 *       不写「怎么做」。特别要写清楚什么时候不该用。</li>
 *   <li><b>parameters</b> —— JSON Schema。必填项放 required，可选项给 default 含义。</li>
 *   <li><b>不写模型不可能知道的东西</b> —— 比如「当前项目有 392 个文件」，
 *       模型自己会调 list_files 去看。</li>
 * </ul>
 *
 * <p><b>Anthropic 的格式不一样：</b>它要 input_schema，而且没有 system 角色。
 * 这里两套都生成，切换服务商时自动用对应的那套。
 */
final class ToolSchema {

 /** 一个工具的完整定义。 */
 static final class Tool {
  final String name,description;final JSONObject parameters;
  Tool(String name,String description,JSONObject parameters)throws Exception{
   this.name=name;this.description=description;this.parameters=parameters;
  }
 }

 /**
  * 构造一个 object 类型的参数表。
  *
  * <p>参数是一串「名字, schema」交替，数量必须是偶数。
  * 少一个会在运行期炸，很难查，所以这里直接检查并抛出。
  *
  * <p>调用时必须写在一行里：Java 的可变参数不吃换行，
  * 写成多行会在第一行就闭合，后面的参数跑到 obj 外面去。
  */
 private static JSONObject obj(Object... pairs)throws Exception{
  if(pairs.length%2!=0)throw new IllegalArgumentException("obj() 的参数必须成对：名字 + schema，实际给了 "+pairs.length+" 个");
  JSONObject schema=new JSONObject().put("type","object").put("properties",new JSONObject());
  JSONArray required=new JSONArray();
  for(int i=0;i<pairs.length;i+=2){
   String key=(String)pairs[i];
   JSONObject value=(JSONObject)pairs[i+1];
   schema.getJSONObject("properties").put(key,value);
   if(value.optBoolean("__required",false)){
    required.put(key);
    value.remove("__required");
   }
  }
  if(required.length()>0)schema.put("required",required);
  return schema;
 }

 /** 一个字符串参数。 */
 private static JSONObject str(String desc)throws Exception{return new JSONObject().put("type","string").put("description",desc);}
 /** 一个带默认值的字符串参数。 */
 private static JSONObject str(String desc,String def)throws Exception{return new JSONObject().put("type","string").put("description",desc).put("default",def);}
 /** 一个整数参数。 */
 private static JSONObject num(String desc)throws Exception{return new JSONObject().put("type","integer").put("description",desc);}
 /** 一个带默认值的整数参数。 */
 private static JSONObject num(String desc,int def)throws Exception{return new JSONObject().put("type","integer").put("description",desc).put("default",def);}
 /** 一个布尔参数。 */
 private static JSONObject bool(String desc)throws Exception{return new JSONObject().put("type","boolean").put("description",desc);}
 /** 一个带默认值的布尔参数。 */
 private static JSONObject bool(String desc,boolean def)throws Exception{return new JSONObject().put("type","boolean").put("description",desc).put("default",def);}
 /** 一个对象参数。 */
 private static JSONObject jobj(String desc)throws Exception{return new JSONObject().put("type","object").put("description",desc);}
 /** 一个数组参数。 */
 private static JSONObject jarr(String desc)throws Exception{return new JSONObject().put("type","array").put("description",desc);}
 /** 标记必填。 */
 private static JSONObject req(JSONObject schema)throws Exception{schema.put("__required",true);return schema;}

 /**
  * 全部工具的定义。
  *
  * <p>顺序不重要，工具数量重要 —— 太多了模型会挑花眼，
  * 而且每个 schema 都要占 token。三十个左右是比较稳的量。
  */
 static Tool[] all()throws Exception{
  return new Tool[]{
   new Tool("list_files","列出项目里的文件，按目录分组。只看有哪些文件时用这个，不要凭猜测去读文件。",obj("prefix",str("只列这个目录下的，留空表示全部",""),"depth",num("列几层目录，默认 3，最多 6",3),"entryLimit",num("最多列多少个文件条目，默认 500，最多 2000",500))),
   new Tool("inspect_project","看项目概况：文件数、package.json 内容、能跑什么环境。开始改代码前先调一次。",obj()),
   new Tool("list_assets","列出项目里已有的图片素材（路径和引用方式）。要复用素材而不是重新生成时用这个。",obj()),
   new Tool("list_art_models","列出可用的绘图模型和它们的风格、价格。生成图片前先看有哪些选择。",obj()),
   /*
    * 连接器查询工具也漏过。
    *
    * <p>和 generate_image 同一个毛病：提示词里写着「还能用 search_connectors」，
    * 但 schema 里没有，原生路径下模型调不到 —— 查官方连接器的能力静默消失。
    *
    * <p>这两个是只读查询，没有副作用，放开给模型用是安全的。
    */
   new Tool("search_connectors","搜索官方连接器目录。需求涉及设备、系统、支付、地图、网盘等官方能力时，先用它找有没有现成连接器。",
    obj("query",req(str("要搜的能力关键词，例如 支付、蓝牙、地图、网盘")))),
   new Tool("describe_connector","看某个官方连接器有哪些工具、有什么限制、适用哪些构建器。搜索到候选后用它核对细节。",
    obj("id",req(str("连接器 id，来自 search_connectors 的结果")),"query",str("想进一步问的问题，留空表示只看工具清单",""),"offset",num("分页偏移，留空从 0 开始",0))),
   /*
    * generate_image 原来只在文本协议的提示词里出现过，
    * 原生 function calling 的 schema 里**漏了**。
    *
    * <p>后果：模型在原生路径下**根本调不到绘图工具** ——
    * 提示词说「绘图工具可用」，schema 里没有这个工具，
    * 服务端只会把 schema 里有的工具给模型，于是绘图功能静默消失。
    * 这就是「原生改造引入功能回退」的典型：一边是提示词，一边是 schema，
    * 改一边忘了另一边。
    */
   new Tool("generate_image","生成一张图片并保存到项目里。要画插图、图标、背景时用这个。每轮最多 3 张，先用 list_assets 看看有没有能复用的。",
    obj("prompt",req(str("要画什么，1 到 6000 字的画面描述")),"path",str("保存路径，例如 assets/hero.png，留空自动命名",""),"referenceFile",str("参考图的路径（例如照着已有素材画），留空表示不用参考",""),"placeholder",str("占位提示文字，图片生成后由代码替换",""))),
   new Tool("read_file","读一个文件的内容。文件大时可以只读一部分（startLine/lineCount）。",obj("path",req(str("文件路径，例如 src/App.tsx")),"startLine",num("从第几行开始读，默认 1",1),"lineCount",num("读多少行，默认读到文件末尾"))),
   new Tool("search_code","在项目里搜代码。找函数在哪定义、找某个字符串被谁用了，用这个。",obj("query",req(str("要搜索的字符串或正则表达式")),"regex",bool("query 是正则表达式吗，默认 false",false),"ignoreCase",bool("忽略大小写，默认 true",true),"glob",str("只搜匹配这个模式的文件，例如 **/*.ts",""),"prefix",str("只在这个目录下搜",""),"limit",num("最多返回多少条，默认 50，最多 200",50))),
   new Tool("patch_file","改一个文件里的一段。改之前先 read_file 看清上下文，不要凭猜的行号。",obj("path",req(str("文件路径")),"newContent",req(str("替换成的新内容（只这段，不是整个文件）")),"startLine",num("从第几行开始替换（1 起）",1),"endLine",num("替换到第几行（不含），留空表示只改 startLine 那一行"))),
   new Tool("replace_text","在文件里把一段文字换成另一段。旧文字必须在文件里只出现一次，否则会失败。",obj("path",req(str("文件路径")),"oldText",req(str("要被替换的原文（必须在文件里唯一出现）")),"newText",req(str("替换成的新文字")))),
   new Tool("multi_patch","一次改多个文件的多个位置。改多处时用这个，比多次调用 patch_file 快，也不容易改漏。",obj("patches",req(jarr("补丁数组。每项 {path, startLine, endLine, newContent}，startLine 从 1 起，endLine 留空表示只改 startLine 那一行")))),
   new Tool("write_files","新建文件或整体覆盖文件。改整个文件的内容用这个；只改几行用 patch_file。",obj("files",req(jobj("路径到内容的映射，例如 {\"src/a.ts\":\"完整内容\"}")))),
   new Tool("diff_mine","看这一轮我改了哪些行。写文件之前先自查一遍，确认没有改坏别的地方。",obj("path",str("只看这一个文件的差异，留空表示全部",""),"withLines",bool("要不要带具体行差异，默认 true；只看哪些文件变了就传 false",true),"context",num("每段差异上下各留几行上下文，默认 3",3))),
   new Tool("diff_project","对比项目当前内容和某个快照。想知道某次改动前后差了什么时用。",obj("snapshot",str("快照标识，留空就是和上一轮比",""))),
   new Tool("check_project","编译检查整个项目，看有没有语法或引用错误。改完代码一定要调一次。",obj()),
   new Tool("run_tests","跑项目里的单元测试。测试文件按 *.test.ts / *.spec.js 命名，里面直接用 describe/it/expect。"
    +"结果里 ok 表示这次验证过没过；项目里没有测试文件时 ok 是 false、ran 是 false，那是没得跑而不是跑挂了。",obj()),
   new Tool("run_script","在沙箱里跑一段 JavaScript，用来算东西或者验证逻辑。不能访问网络和文件系统。",obj("code",req(str("要执行的 JavaScript 代码")))),
   new Tool("run_preview","在真机上预览当前项目。改完想看效果时用。",obj()),
   new Tool("get_debug_reports","拿最近的崩溃日志和报错信息。预览跑出问题时用这个。",obj()),
   new Tool("build_apk","打包成 APK。用户明确说要打包、要安装、要上架时才用。",obj("context",str("打包时要附带的说明",""),"depth",num("包含多深的依赖目录",2))),
   new Tool("write_plan","把要做的事列成清单。任务有三四步以上时，开工前先列一次，做完一项改一次 done。",obj("steps",req(jarr("步骤数组，每项 {\"text\":\"做什么\",\"done\":false}")))),
   new Tool("read_plan","读回当前计划清单。",obj()),
   new Tool("remember","把值得长期留下的事写进记忆。用户说过的偏好、项目特有的约定、踩过并修好的坑。",obj("text",req(str("要记住的内容")),"scope",str("global 或 project。不填就自动：有项目记项目，没项目记全局",""))),
   new Tool("read_memory","看已经记住了什么。要记之前先看，免得记重复。",obj("scope",str("global / project / all，默认 all",""))),
   new Tool("update_memory","整段重写记忆。记忆条目太乱或者快满了的时候整理用。",obj("content",req(str("完整的新记忆内容")),"scope",str("global 或 project，不填就自动",""))),
   new Tool("list_skills","列出所有技能（程序性记忆）的名字和一句话说明。",obj()),
   new Tool("read_skill","读一个技能的完整内容。要用某个做法时先读它。",obj("name",req(str("技能名字")))),
   new Tool("write_skill","新建或覆盖一个技能。记下这个项目特有的做法，下次直接用。",obj("name",req(str("技能名字，只用字母数字和连字符")),"description",req(str("一句话说明这个技能什么时候用")),"content",req(str("技能的完整正文")))),
   new Tool("delete_skill","删掉一个技能。",obj("name",req(str("技能名字")))),
   new Tool("web_fetch","抓一个网址的内容。查官方文档、看别人的实现时用。",obj("url",req(str("要抓的网址，必须是 http 或 https")))),
   new Tool("web_search","搜索网上的资料。不知道某个 API 怎么用、想找参考实现时用。",obj("query",req(str("搜索词")),"limit",num("要几条结果，默认 5",5))),
   new Tool("github_status","看 GitHub 配置、登录身份、目标仓库在不在。",obj()),
   new Tool("github_push","把项目上传到 GitHub 或增量更新。只传改动的文件，不会重传全部。默认建私有仓库。",obj("repo",str("仓库名，留空用默认的",""),"message",str("提交说明",""),"private",bool("建私有仓库吗，默认 true。只有用户明确说要公开才填 false",true))),
  };
 }

 /** 转成 OpenAI 格式的 tools 数组。 */
 static JSONArray openAiTools()throws Exception{
  Tool[] tools=all();
  JSONArray out=new JSONArray();
  for(Tool t:tools){
   JSONObject function=new JSONObject().put("name",t.name).put("description",t.description).put("parameters",t.parameters);
   out.put(new JSONObject().put("type","function").put("function",function));
  }
  return out;
 }

 /** 转成 Anthropic 格式的 tools 数组。 */
 static JSONArray anthropicTools()throws Exception{
  Tool[] tools=all();
  JSONArray out=new JSONArray();
  for(Tool t:tools){
   out.put(new JSONObject().put("name",t.name).put("description",t.description).put("input_schema",t.parameters));
  }
  return out;
 }

 /** 按协议取对应格式。 */
 static JSONArray forProtocol(String protocol)throws Exception{
  return "anthropic".equals(protocol)?anthropicTools():openAiTools();
 }

 /** 从模型回复里取出工具调用（OpenAI 格式）。 */
 static JSONArray parseOpenAiToolCalls(JSONObject raw)throws Exception{
  JSONArray out=new JSONArray();
  JSONObject choice=raw.optJSONArray("choices")==null?null:raw.getJSONArray("choices").optJSONObject(0);
  if(choice==null)return out;
  JSONObject message=choice.optJSONObject("message");
  if(message==null)return out;
  JSONArray calls=message.optJSONArray("tool_calls");
  if(calls==null)return out;
  for(int i=0;i<calls.length();i++){
   JSONObject call=calls.optJSONObject(i);
   if(call==null)continue;
   JSONObject function=call.optJSONObject("function");
   if(function==null)continue;
   String name=function.optString("name","");
   if(name.isEmpty())continue;
   JSONObject args=new JSONObject();
   String rawArgs=function.optString("arguments","");
   if(!rawArgs.isEmpty()){
    try{args=new JSONObject(rawArgs);}catch(Exception e){args=new JSONObject();}
   }
   out.put(new JSONObject().put("id",call.optString("id","call_"+i))
    .put("name",name).put("args",args));
  }
  return out;
 }

 /** 从模型回复里取出工具调用（Anthropic 格式）。 */
 static JSONArray parseAnthropicToolCalls(JSONObject raw)throws Exception{
  JSONArray out=new JSONArray();
  JSONArray content=raw.optJSONArray("content");
  if(content==null)return out;
  for(int i=0;i<content.length();i++){
   JSONObject block=content.optJSONObject(i);
   if(block==null||!"tool_use".equals(block.optString("type")))continue;
   String name=block.optString("name","");
   if(name.isEmpty())continue;
   JSONObject args=block.optJSONObject("input");
   out.put(new JSONObject().put("id",block.optString("id","call_"+i))
    .put("name",name).put("args",args==null?new JSONObject():args));
  }
  return out;
 }

 /** 按协议取对应格式的工具调用。 */
 static JSONArray parseToolCalls(JSONObject raw,String protocol)throws Exception{
  return "anthropic".equals(protocol)?parseAnthropicToolCalls(raw):parseOpenAiToolCalls(raw);
 }
}
