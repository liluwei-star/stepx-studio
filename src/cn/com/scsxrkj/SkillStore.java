package cn.com.scsxrkj;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * AI 的技能库 —— 程序性记忆。
 *
 * <p>和 {@link AiMemory} 的区别很重要：
 * <ul>
 *   <li>记忆记的是<b>事实</b>：「这个项目用的是 esbuild 0.18」</li>
 *   <li>技能记的是<b>做法</b>：「清洗一个云端项目的正确顺序是 ① 扫引用 ② 补 manifest ③ 再删」</li>
 * </ul>
 * 事实每轮都该知道，所以整个塞进提示词。做法只在做那件事时才需要，
 * 全塞进去会撑爆上下文 —— 所以这里只把<b>名字和一句话描述</b>放进提示词，
 * 模型判断需要时才用 {@code read_skill} 读全文。
 *
 * <p>这就是「按需加载」的全部秘密：不是省略，是延迟。
 *
 * <p>文件放在 {@code files/skills/<名字>.md}，格式是 frontmatter + 正文：
 * <pre>
 * ---
 * name: 清洗云端项目
 * description: 当项目来自 studio.stepx.com 且需要上架其他市场时使用
 * ---
 * 正文……
 * </pre>
 */
final class SkillStore {
 /** 技能名上限。够长能说清是什么，又够短不会撑爆文件系统。 */
 static final int NAME_CAP=64;
 /** 描述上限。这句会进提示词，每条都算成本，所以压得很紧。 */
 static final int DESC_CAP=120;
 /** 单个技能正文上限。 */
 static final int BODY_CAP=20000;
 /** 技能总数字上限。再多就该合并了，否则清单本身就能塞满上下文。 */
 static final int COUNT_CAP=40;

 private final MainActivity a;
 SkillStore(MainActivity a){this.a=a;}

 File dir(){
  File d=new File(a.getFilesDir(),"skills");
  if(!d.exists())d.mkdirs();
  return d;
 }

 /**
  * 校验技能名。
  *
  * <p>允许中文（用户和模型都会用中文起名，强制英文反而别扭），
  * 但禁止路径分隔符和点 —— 名字要直接当文件名用，
  * 一个 {@code ../} 就能写到 App 私有目录外面去。
  */
 static String checkName(String raw)throws Exception{
  String name=raw==null?"":raw.trim();
  if(name.isEmpty())throw new Exception("技能名不能为空");
  if(name.length()>NAME_CAP)throw new Exception("技能名超过 "+NAME_CAP+" 字符");
  if(!name.matches("[\\p{L}\\p{N}_-][\\p{L}\\p{N} _-]*"))throw new Exception("技能名只能用中英文、数字、空格、下划线、短横线，且不能以符号开头："+name);
  return name;
 }

 File fileOf(String name)throws Exception{return new File(dir(),checkName(name)+".md");}

 /**
  * 解析一个技能文件。
  *
  * <p>手写 frontmatter 解析，不引 YAML 库 —— 只需要取两个字段，
  * 引一个库进来会让 APK 变大、还可能出兼容问题。
  * 解析失败的字段用文件名兜底，宁可显示得糙一点也不要整个列表读不出来。
  */
 static JSONObject parse(File f){
  JSONObject o=new JSONObject();
  String base=f.getName();
  String fallback=base.endsWith(".md")?base.substring(0,base.length()-3):base;
  try{
   o.put("name",fallback).put("description","");
   String text=AiMemory.readText(f);
   String body=text;
   if(text.startsWith("---")){
    int end=text.indexOf("\n---",3);
    if(end>0){
     String head=text.substring(3,end);
     body=text.substring(text.indexOf('\n',end+1)+1);
     for(String line:head.split("\n")){
      int colon=line.indexOf(':');
      if(colon<=0)continue;
      String key=line.substring(0,colon).trim().toLowerCase(Locale.ROOT);
      String val=line.substring(colon+1).trim();
      if(val.startsWith("\"")&&val.endsWith("\"")&&val.length()>1)val=val.substring(1,val.length()-1);
      if(key.equals("name")&&!val.isEmpty())o.put("name",val);
      else if(key.equals("description")&&!val.isEmpty())o.put("description",val);
     }
    }
   }
   o.put("chars",text.length()).put("bodyChars",body.length());
  }catch(Exception e){
   try{o.put("error",String.valueOf(e.getMessage()));}catch(Exception ignored){}
  }
  return o;
 }

 /** 列出全部技能的元信息（不含正文）。按名字排序，方便用户和模型找到。 */
 JSONArray list(){
  JSONArray out=new JSONArray();
  File[] files=dir().listFiles((d,n)->n.endsWith(".md"));
  if(files==null)return out;
  Arrays.sort(files,Comparator.comparing(File::getName));
  for(File f:files){
   if(out.length()>=COUNT_CAP)break;
   out.put(parse(f));
  }
  return out;
 }

 /** 读某个技能的全文。 */
 JSONObject read(String name)throws Exception{
  File f=fileOf(name);
  if(!f.exists())throw new Exception("没有这个技能："+name+"。用 list_skills 看有哪些");
  String text=AiMemory.readText(f);
  return new JSONObject().put("name",name).put("content",text).put("chars",text.length());
 }

 /**
  * 新建或覆盖一个技能。
  *
  * <p>覆盖是允许的（模型需要能修正自己写的技能），但会在返回值里
  * 标明 {@code replaced:true}，让它知道自己动了一个已有的技能而不是新建的。
  */
 synchronized JSONObject write(String name,String description,String bodyText)throws Exception{
  String n=checkName(name);
  String desc=description==null?"":description.trim();
  String body=bodyText==null?"":bodyText;
  if(desc.isEmpty())throw new Exception("description 不能为空 —— 它是模型判断「什么时候该用这个技能」的唯一依据");
  if(desc.length()>DESC_CAP)throw new Exception("description 超过 "+DESC_CAP+" 字符，请压缩成一句话");
  if(body.trim().isEmpty())throw new Exception("技能正文不能为空");
  if(body.length()>BODY_CAP)throw new Exception("技能正文 "+body.length()+" 字符，超过上限 "+BODY_CAP+"，请精简");

  File f=fileOf(n);
  boolean replaced=f.exists();
  if(!replaced&&list().length()>=COUNT_CAP)throw new Exception("技能已达 "+COUNT_CAP+" 个上限，请合并或删除一些");

  // frontmatter 里的值如果含冒号或引号，包一层引号，避免下次解析串行
  String safeDesc=desc.indexOf(':')>=0||desc.startsWith("\"")?"\""+desc.replace("\"","'")+"\"":desc;
  StringBuilder sb=new StringBuilder();
  sb.append("---\n");
  sb.append("name: ").append(n).append('\n');
  sb.append("description: ").append(safeDesc).append('\n');
  sb.append("---\n\n");
  sb.append(body.trim()).append('\n');
  AiMemory.writeText(f,sb.toString());
  return new JSONObject().put("ok",true).put("name",n).put("replaced",replaced).put("chars",sb.length());
 }

 synchronized JSONObject delete(String name)throws Exception{
  File f=fileOf(name);
  if(!f.exists())throw new Exception("没有这个技能："+name);
  if(!f.delete())throw new Exception("删除失败："+f.getName());
  return new JSONObject().put("ok",true).put("name",name);
 }

 /**
  * 拼出给 system prompt 用的技能清单。
  *
  * <p>只给名字和描述，不给正文。模型看到「清洗云端项目 —— 当项目来自
  * studio.stepx.com 且需要上架其他市场时使用」就知道该不该读全文了。
  * 一个技能都没有时返回空串，理由同 {@link AiMemory#contextFor}。
  */
 String index(){
  JSONArray all=list();
  if(all.length()==0)return "";
  StringBuilder sb=new StringBuilder();
  sb.append("\n\n【可用技能】下面是你会做的成套做法。需要哪项的细节时，用 read_skill 读它的全文，不要凭印象猜：\n");
  for(int i=0;i<all.length();i++){
   JSONObject o=all.optJSONObject(i);
   if(o==null)continue;
   String desc=o.optString("description","");
   sb.append("- ").append(o.optString("name","?"));
   if(!desc.isEmpty())sb.append("：").append(desc);
   sb.append('\n');
  }
  return sb.toString();
 }
}
