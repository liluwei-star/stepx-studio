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
  String s=text.trim();if(s.startsWith("```")){int start=s.indexOf('\n'),end=s.lastIndexOf("```");if(start<0||end<=start||!s.substring(end+3).trim().isEmpty())throw new Exception("文件回复格式不完整");s=s.substring(start+1,end).trim();}
  JSONObject o=new JSONObject(s);if(!(o.opt("files") instanceof JSONObject))throw new Exception("模型没有返回 files 文件对象");return o.getJSONObject("files");
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
  Iterator<String> it=files.keys();
  while(it.hasNext()){
   String n=it.next();
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
 static JSONObject apply(JSONObject p,JSONObject base,JSONObject changes,String source)throws Exception{
  if(!same(p.getJSONObject("files"),base))throw new Exception("文件已变化，本轮建议未写入；请基于最新文件重新发送");
  JSONObject next=new JSONObject(base.toString());Iterator<String> it=changes.keys();while(it.hasNext()){String n=it.next();if(changes.isNull(n)){if(!next.has(n))throw new Exception("不能删除不存在的文件："+n);next.remove(n);}else{if(!(changes.get(n) instanceof String))throw new Exception("文件内容必须是文本");next.put(n,changes.getString(n));}}if(next.has("neo-matrix.json"))cn.com.scsxrkj.matrix.MatrixSpec.parse(next.getString("neo-matrix.json"));if(p.optBoolean("cloudSource")){JSONObject temp=new JSONObject(p.toString()).put("files",next);CloudFiles.entries(temp);}else validate(next,base);
  JSONObject out=new JSONObject(p.toString());if(same(next,base))return out;
  JSONArray snaps=out.optJSONArray("snapshots");if(snaps==null)snaps=new JSONArray();JSONArray kept=new JSONArray();for(int i=Math.max(0,snaps.length()-4);i<snaps.length();i++)kept.put(snaps.get(i));kept.put(new JSONObject().put("time",System.currentTimeMillis()).put("files",new JSONObject(base.toString())));out.put("snapshots",kept).put("files",next).put("updated",System.currentTimeMillis());
  JSONArray h=out.optJSONArray("history");if(h==null)h=new JSONArray();h.put(new JSONObject().put("time",System.currentTimeMillis()).put("type","apply").put("text",source+" · "+changes.length()+" 个文件；运行验收待完成。"));out.put("history",h);return out;
 }
 static String sourceInstructions(){return "你正在修改云端项目的本地源码副本。返回严格 JSON：{\"summary\":\"说明\",\"files\":{\"相对路径\":\"完整内容\"}}。只列需要修改的文本文件；删除用null。保留其他文件。允许子目录和TSX等源码，不可直接修改凭据、签名材料或二进制资源；新图片使用generate_image工具保存后引用。不执行shell、不假装完成构建；可在工作台本地运行支持的前端工程；发布构建仍可上传Studio。保持用户项目品牌，不擅自添加模型厂商联名或接入成功宣传。需要看具体文件内容时用 read_file，需要定位时用 search_code，改动前先读。";}
 static String instructions(){return "你正在直接修改用户选定的本地项目。只返回一个严格 JSON 对象：{\"summary\":\"说明\",\"files\":{\"文件路径\":\"完整内容\"}}。只列出需要新增或修改的文本文件；删除文件用 null，但必须保留 index.html。支持 html/css/js/jsx/mjs/ts/tsx/json/md/txt/svg，允许子目录。文件数上限按项目规模计算，不要超过项目现有文件数。不支持 npm、shell或Kotlin/Gradle。不得省略代码或在最终交付中留下占位符；绘图工具可使用随后替换的临时图片路径占位符。下方文件概览是唯一修改基线（要改哪个文件先用 read_file 读它），保持未要求修改的功能。游戏要保留可操作的玩法、结束与重试；不要声称已经运行或验收。";}
}
