package cn.com.scsxrkj;
import org.json.*;
import java.util.*;
/**
 * 项目文件的编辑与回滚，是「AI 改代码」这件事的安全底座。
 *
 * <p>核心设计：<b>改动必须绑定一个确切的基线</b>。AI 看到的是某一版文件，
 * 提交改动时也要声明是基于哪一版改的。如果这期间用户手动改过，
 * 基线对不上就拒绝写入，防止把用户的改动冲掉。
 *
 * <p>整个过程是原子的：要么整批改动全部生效，要么一个都不生效。
 */
final class ProjectEdits {
 static boolean same(JSONObject a,JSONObject b)throws Exception{if(a.length()!=b.length())return false;Iterator<String> it=a.keys();while(it.hasNext()){String k=it.next();if(!b.has(k)||!Objects.equals(a.get(k),b.get(k)))return false;}return true;}
 static JSONObject parse(String text)throws Exception{
  /*
   * 原来这里只接受「整段就是一个 JSON 对象」。
   *
   * <p><b>为什么这是个坑：</b>降级路径（模型不支持 tools）的提示词是
   * 「返回 JSON，允许在前面先说一两句话」。于是模型经常回：
   * <pre>
   *   好的，我改好了。
   *   {"summary":"...","files":{...}}
   * </pre>
   * 这时候 {@code new JSONObject(text)} 直接抛 JSONException，
   * 改动被整个丢掉 —— 用户看到的是「AI 说了改好了，项目却没变」。
   *
   * <p>所以改成先剥代码块围栏、再用 DevAgent 那套「定位 JSON 边界」的办法
   * 抠出真正的 JSON 对象。模型爱说什么说什么，文件照样取得到。
   */
  String s=text==null?"":text.trim();
  if(s.isEmpty())throw new Exception("模型没有返回内容");
  if(s.startsWith("```")){
   int start=s.indexOf('\n'),end=s.lastIndexOf("```");
   if(start>=0&&end>start){s=s.substring(start+1,end).trim();}
  }
  s=s.replaceAll("(?s)<think[^>]*>.*?</think>","").trim();
  JSONObject o=null;
  try{o=new JSONObject(s);}catch(Exception ignore){}
  if(o==null){
   int from=JsonScan.indexOfJsonStart(s);
   if(from<0)throw new Exception("模型没有返回可解析的 JSON");
   int to=JsonScan.endOfJsonObject(s,from);
   if(to<0)throw new Exception("模型返回的 JSON 不完整");
   o=new JSONObject(s.substring(from,to+1));
  }
  if(!(o.opt("files") instanceof JSONObject))throw new Exception("模型没有返回 files 文件对象");
  return o.getJSONObject("files");
 }
 /**
  * 校验 AI 交回来的文件集合。
  *
  * <p><b>上限按项目实际规模算，不写死 40。</b>
  * 原来写死「40 个文件、45 万字符」，那是给「一个手写的单页应用」定的。
  * 一个 331 文件的 TSX 工程，AI 改十几个文件就撞线了 ——
  * 而报错说的是「项目上限为 40 个文件」，用户完全无法理解为什么自己的项目这么小。
  *
  * <p>现在按「原项目有多少文件」和「云端同步的硬上限 3000」取小的那个，
  * 再留出余量给新增文件。
  *
  * <p><b>允许的扩展名也要放开。</b>
  * 原来只认 {@code html|css|js|json|md|txt|svg}，
  * 却不认 {@code .ts} 和 {@code .tsx} ——
  * 而这个工作台的编译器支持 React/TSX，那些恰恰是最该被 AI 改的文件。
  *
  * @param files  文件集合
  * @param base   原项目的文件集合（用来定上限）
  */
 static void validate(JSONObject files,JSONObject base)throws Exception{
  // 上限：原项目规模 + 100 个新增余量，但不超过云端同步的 3000 硬上限
  // 上限跟着项目规模走：原项目有多少文件，就允许改到多少（外加新增余量）。
  // 上限本身是 3000 —— 那是云端同步的硬协议，不是人为设的能力天花板。
  int cap=base==null?3000:Math.min(3000,base.length()+200);
  if(files.length()>cap)throw new Exception("本次修改涉及 "+files.length()+" 个文件，超过本项目允许的 "+cap+" 个");
  if(files.toString().length()>24*1024*1024)throw new Exception("本次修改内容过大（超过 24 MB），请分批处理");
  if(!(files.opt("index.html") instanceof String))throw new Exception("必须保留 index.html 入口");
  /*
   * 只查「这次被改到」的文件，不查项目里原有的。
   *
   * <p>这里原来把整张合并后的表逐个校验，于是只要项目里<b>已经存在</b>
   * 一个扩展名不在白名单里的文件（导入的 .csv、.xml、.py、.webp，
   * 或者早期版本留下的怪路径），这个项目就<b>从此再也改不动</b> ——
   * AI 每次动手都收到「无效的文本文件路径：data.csv」，
   * 而它压根没碰过那个文件，改也改不掉，只能反复重试。
   *
   * <p>要防的是「AI 写进不该写的路径」，不是「用户项目里本来有什么」。
   * 内容没变的文件跳过：那不是我这次引入的。
   */
  Iterator<String> it=files.keys();
  while(it.hasNext()){
   String n=it.next();
   if(base!=null&&base.has(n)
    &&String.valueOf(base.opt(n)).equals(String.valueOf(files.opt(n))))continue;
   // 允许的扩展名：补上 ts/tsx/jsx/mjs，这些是本机编译器真正支持的
   if(!n.matches("[\\p{L}\\p{N}_-][\\p{L}\\p{N} ._/-]{0,199}")||n.contains("..")
    ||!n.matches("(?i).+\\.(html|css|js|jsx|mjs|ts|tsx|json|md|txt|svg)")
    ||!(files.get(n) instanceof String))
    throw new Exception("无效的文本文件路径："+n);

  }
 }

 /**
  * 校验 AI 交回来的文件集合（不知道原项目时的宽松版）。
  *
  * @param files 文件集合
  */
 static void validate(JSONObject files)throws Exception{validate(files,null);}
 /**
  * 把改动合进「暂存副本」，只动文件内容，不产生任何提交副作用。
  *
  * <p><b>为什么需要它：</b>AI 走工具路径改文件时（write_files / patch_file /
  * multi_patch / replace_text），改的是本轮内存里的暂存副本。
  * 这本该是纯计算，可原来它调的是 {@link #apply} —— 那是<b>提交</b>语义：
  * 往里塞一份差量快照、写一条 history、刷新 updated 时间戳。
  *
  * <p>于是一个 40 轮的工具循环，每改一次文件就往暂存副本里堆一份快照、
  * 记一条历史。看着只是浪费内存，实际后果更直接：
  * <ul>
  *   <li>暂存副本的快照列表被工具调用刷满，真正该保留的
  *       「AI 动手之前」那份快照被挤出裁剪窗口；</li>
  *   <li>history 里全是「AI 暂存 · 1 个文件」这种中间态记录，
  *       用户翻项目历史根本找不到自己关心的事；</li>
  *   <li>体积白白翻几倍，手机上直接吃内存。</li>
  * </ul>
  *
  * <p>所以拆成两段：{@code stage} 只合并 + 校验，{@code apply} 在它之上加提交副作用。
  * 校验一步不少 —— 路径、内容类型、neo-matrix、云端协议、项目规模，
  * 与提交路径完全同一套，只是不落快照、不写历史。
  *
  * @param project 暂存副本（会被就地修改）
  * @param changes 本次改动：路径 → 新内容；值为 null 表示删除该文件
  */
 static void stage(JSONObject project,JSONObject changes)throws Exception{
  if(project==null)throw new Exception("没有可修改的项目");
  if(changes==null||changes.length()==0)return;
  JSONObject base=project.getJSONObject("files");
  JSONObject next=mergeChecked(project,base,changes);
  if(!same(next,base))project.put("files",next);
  applyBinaryChanges(project,changes);
 }

 /**
  * 合并 + 全套校验，返回合并后的文件表（不改入参）。
  *
  * @param project 项目对象，用于读取 cloudSource 等属性，可为 null
  * @param base    改动前的文件表
  * @param changes 改动集合
  */
 static JSONObject mergeChecked(JSONObject project,JSONObject base,JSONObject changes)throws Exception{
  JSONObject next=new JSONObject(base.toString());
  Iterator<String> it=changes.keys();
  while(it.hasNext()){
   String n=it.next();
   if(changes.isNull(n)){
    /*
     * 图片、字体、模型权重这些在 binaryFiles 里，不在 files 里。
     *
     * <p>原来这里只看 files，于是模型想删一张图，得到的回复是
     * 「不能删除不存在的文件：assets/photo.png」——
     * 文件明明在，只是存在另一张表。模型会反复重试同一句话，
     * 或者干脆放弃改成别的方式，最后图还在磁盘上。
     */
    boolean inText=next.has(n);
    boolean inBin=project!=null&&project.optJSONObject("binaryFiles")!=null
      &&project.getJSONObject("binaryFiles").has(n);
    if(!inText&&!inBin)throw new Exception("不能删除不存在的文件："+n);
    if(inText)next.remove(n);
   }else{
    if(!(changes.get(n) instanceof String))throw new Exception("文件内容必须是文本");
    next.put(n,changes.getString(n));
   }
  }
  if(next.has("neo-matrix.json"))cn.com.scsxrkj.matrix.MatrixSpec.parse(next.getString("neo-matrix.json"));
  /*
   * 本轮改动的路径要按云端那套标准再过一遍。
   *
   * <p>之前这两套标准各写各的，结果是同一个路径本地能存、云端不能 —
   * 比如 {@code a//b}（中间空段）本地正则放行，同步时被 CloudFiles.path 拒掉，
   * 用户看到的却是「同步不包含此路径」，完全不知道是哪个文件、为什么。
   *
   * <p>路径规则只该有一份。统一成 CloudFiles.path 之后，
   * 本地存进去的东西一定能同步出去。
   *
   * <p>只查<b>本轮改动的文件</b>，不查项目里原有的 —
   * 老项目要是本来就有几个怪路径，不该让 AI 从此再也改不动它。
   */
  for(Iterator<String> ci=changes.keys();ci.hasNext();){
   String cn=ci.next();
   if(!CloudFiles.path(cn))throw new Exception("路径不合法（不能以 / 开头，不能含 .. 或空段，每段要有内容）："+cn);
  }
  if(project!=null&&project.optBoolean("cloudSource")){
   /*
    * 只装 CloudFiles.entries 真正会读的两个字段。
    *
    * <p>原来这里是把整个项目复制一份再换掉 files —— 而 entries 只看
    * {@code files} 和 {@code binaryFiles}。一个几十 MB 的项目，
    * 每调用一次改文件的工具就白复制一遍全量数据，
    * 四十轮工具循环下来是几十次无谓的全量拷贝，手机上直接吃内存。
    */
   JSONObject temp=new JSONObject().put("files",next);
   Object binaries=project.opt("binaryFiles");
   if(binaries!=null)temp.put("binaryFiles",binaries);
   CloudFiles.entries(temp);
  }else validate(next,base);
  return next;
 }

 /**
  * 把本轮改动同步到二进制表。
  *
  * <p>两条规则，缺一条都会留下「幽灵引用」：
  *
  * <ul>
  *   <li><b>值为 null</b> —— 用户/模型要删这个路径。
  *       文本表删了还不够，binaryFiles 里那条也得删，
  *       否则文件树里没了、同步上云时还在，磁盘上的 .bin 也永远不回收。</li>
  *   <li><b>值是文本</b> —— 这个路径现在变成文本文件了。
  *       binaryFiles 里同名的旧引用必须去掉，不然同一路径会同时
  *       出现在两张表里，导出、同步、构建各按各的理解走一遍。</li>
  * </ul>
  *
  * @param project 项目对象（会被就地修改）
  * @param changes 本轮改动
  */
 static void applyBinaryChanges(JSONObject project,JSONObject changes)throws Exception{
  applyBinaryChangesTouched(project,changes);
 }

 /**
  * 同上，但返回这一轮有没有真的动到二进制表。
  *
  * <p>调用方要据此判断「这轮是否完全没变化」——
  * 只删一张图时文本表是没变的，不能因此当成没改动。
  */
 static boolean applyBinaryChangesTouched(JSONObject project,JSONObject changes)throws Exception{
  if(project==null||changes==null)return false;
  JSONObject bins=project.optJSONObject("binaryFiles");
  if(bins==null)return false;
  boolean touched=false;
  for(Iterator<String> it=changes.keys();it.hasNext();){
   String n=it.next();
   if(bins.has(n)){bins.remove(n);touched=true;}
  }
  if(touched&&bins.length()==0)project.remove("binaryFiles");
  return touched;
 }

 static JSONObject apply(JSONObject p,JSONObject base,JSONObject changes,String source)throws Exception{
  if(!same(p.getJSONObject("files"),base))throw new Exception("文件已变化，本轮建议未写入；请基于最新文件重新发送");
  /* 合并与校验统一走 mergeChecked，和暂存路径同一套规则，不会各写一份。 */
  JSONObject next=mergeChecked(p,base,changes);
  JSONObject out=new JSONObject(p.toString());
  /*
   * 先把二进制表的改动做在副本上，再看这一轮到底有没有变化。
   *
   * <p>顺序不能反：只删一张图时 files 那份表一个字都没变，
   * 先判 {@code same(next,base)} 就会直接返回，
   * 二进制表那条删除悄悄没做 —— 用户以为删了，图还在磁盘上。
   */
  boolean binsTouched=applyBinaryChangesTouched(out,changes);
  if(same(next,base)&&!binsTouched)return out;
  /*
    * 存档只存**这次改动的文件的旧内容**，不存整个项目。
    *
    * <p>原来存的是整个 base（项目全部文件）。一个 300 个文件的项目，
    * 改 5 次就是 5 份全量 —— workspace.json 直接涨到几 MB，
    * 而内存里再拷几遍就 OOM。
    *
    * <p>改成差量：每份快照只记「哪些文件被改了 + 改之前的内容」。
    * 恢复时把差量叠回去就行，体积从 O(项目大小 × 次数) 降到 O(改动量 × 次数)。
    *
    * <p>同时只留 2 份 —— 再多用户也用不上，而每份都是内存负担。
    */
   /*
   * 存档。
   *
   * <p>这里原来只留最后一份 —— AI 每改一轮代码，
   * 用户之前手动存的那份基准就被顶掉了。用户回头想看
   * 「我改之前是什么样」，发现「变更」视图的基准已经变了，
   * 而且没有任何提示。
   *
   * <p>现在跟 CloudFiles 用同一套裁剪：自动存档留最近几份，
   * <b>用户手动存的一份都不丢</b>。
   */
   JSONArray snaps=out.optJSONArray("snapshots");if(snaps==null)snaps=new JSONArray();
   JSONObject delta=new JSONObject();
   JSONArray added=new JSONArray();
   for(Iterator<String> dit=changes.keys();dit.hasNext();){
    String n=dit.next();
    if(base.has(n))delta.put(n,base.optString(n,""));
    // 当时没有这个文件（这次是新建的）→ 用 NULL 标记，恢复时要删掉
    else{
     delta.put(n,JSONObject.NULL);
     /*
      * 同时记进「新增名单」。
      *
      * <p>NULL 标记已经能让恢复时删掉这个文件，
      * 但新增名单是差量存档里另一条独立的语义通道 ——
      * 前端算变更、ProjectDiff 算差异时都读它。
      * 两条通道都写，恢复路径才不会因为某一条漏读而留下新建的文件。
      */
     added.put(n);
    }
   }
   /* 改动前的二进制引用也存一份，恢复时才能连图一起回来 */
   JSONObject oldBins=p.optJSONObject("binaryFiles");
   JSONObject snapBins=oldBins==null?null:new JSONObject(oldBins.toString());
   JSONArray mine=new JSONArray();
   JSONObject one=new JSONObject().put("time",System.currentTimeMillis())
     .put("files",delta).put("added",added).put("delta",true).put("source","auto");
   if(snapBins!=null)one.put("bins",snapBins);
   mine.put(one);
   out.put("snapshots",CloudFiles.trimSnapshots(snaps,mine)).put("files",next).put("updated",System.currentTimeMillis());
  JSONArray h=out.optJSONArray("history");if(h==null)h=new JSONArray();h.put(new JSONObject().put("time",System.currentTimeMillis()).put("type","apply").put("text",source+" · "+changes.length()+" 个文件；运行验收待完成。"));out.put("history",h);return out;
 }
 /**
  * 写文件协议的那一段措辞。
  *
  * @param nativeTools 服务端支持原生 function calling 吗
  *
  * <p><b>为什么必须分两种：</b>原生路径下模型是用 write_files / patch_file
  * 这类工具改文件的，改动进暂存区，走校验后原子提交；
  * 降级路径下模型没有工具可用，只能把整个文件内容塞进正文里的 files 对象。
  *
  * <p>把两套说法混在一起，模型会在原生路径下也去返回 files JSON ——
  * 那条路没有暂存区、没有校验、没有原子提交，
  * 而且最终自然语言里往往不含 JSON，调用方抠不出来，改动就丢了。
  */
 private static String fileProtocol(boolean nativeTools){
  if(nativeTools)return "文件改动请直接用 write_files / patch_file / multi_patch / replace_text 工具完成，"
   +"不要把文件内容拼成 JSON 写进正文。工具调用会进暂存区，校验通过后才会真正落盘。"
   +"删除文件：write_files 里把该路径的值写成 null。";
  return "只返回一个严格 JSON 对象：{\"summary\":\"说明\",\"files\":{\"文件路径\":\"完整内容\"}}。";
 }
 /**
  * 云端项目的改写说明。
  *
  * @param nativeTools 服务端支持原生 function calling 吗
  */
 static String sourceInstructions(boolean nativeTools){return "你正在修改云端项目的本地源码副本。"
  +fileProtocol(nativeTools)
  +"只列需要修改的文本文件；删除用null。保留其他文件。允许子目录和TSX等源码，不可直接修改凭据、签名材料或二进制资源；新图片使用generate_image工具保存后引用。不执行shell、不假装完成构建；可在工作台本地运行支持的前端工程；发布构建仍可上传Studio。保持用户项目品牌，不擅自添加模型厂商联名或接入成功宣传。需要看具体文件内容时用 read_file，需要定位时用 search_code，改动前先读。";}
 /**
  * 本地项目的改写说明。
  *
  * @param nativeTools 服务端支持原生 function calling 吗
  */
 static String instructions(boolean nativeTools){return "你正在直接修改用户选定的本地项目。"
  +fileProtocol(nativeTools)
  +"只列出需要新增或修改的文本文件；删除文件用 null，但必须保留 index.html。支持 html/css/js/mjs/ts/tsx/json/md/txt/svg，允许子目录。文件数上限按项目规模计算，不要超过项目现有文件数。不支持 npm、shell或Kotlin/Gradle。不得省略代码或在最终交付中留下占位符；绘图工具可使用随后替换的临时图片路径占位符。下方文件概览是唯一修改基线（要改哪个文件先用 read_file 读它），保持未要求修改的功能。游戏要保留可操作的玩法、结束与重试；不要声称已经运行或验收。";}
}
