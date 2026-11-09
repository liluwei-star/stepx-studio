package cn.com.scsxrkj;
import android.content.Context;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

/**
 * AI 助手的跨会话记忆。
 *
 * <p>为什么需要它：每次开新对话，模型都是从零开始。它不知道
 * 「这个项目用的是哪套组件库」「上次那个构建错误是怎么解的」
 * 「用户偏好哪种文件结构」。这些信息如果不落盘，
 * 用户就得每一轮重新解释一遍，而模型还会重复犯同样的错。
 *
 * <p>分两层：
 * <ul>
 *   <li><b>全局记忆</b> {@code files/ai-memory.md} —— 跨所有项目共用的经验，
 *       比如用户偏好、这台设备的能力边界</li>
 *   <li><b>项目记忆</b> {@code files/project-notes/<项目ID>.md} —— 这个项目特有的约定和坑</li>
 * </ul>
 *
 * <p>为什么用纯文本文件而不是 SharedPreferences：记忆需要人肉可读、可编辑、可导出。
 * 用户应该能直接打开看 AI 到底记住了什么，也能自己改掉记错的部分。
 * 塞进 JSON 的一个长字符串里就做不到这一点。
 *
 * <p><b>容量是有上限的，而且故意不设成无限。</b>记忆会整个进 system prompt，
 * 无限增长等于每轮都往上下文里灌垃圾，最后真正重要的事反而被淹没。
 * 超限时保留<b>最近</b>的条目 —— 旧的经验往往已经内化到技能里了。
 */
final class AiMemory {
 /** 全局记忆的字符上限。约 8000 字符 ≈ 中文 8000 字，进上下文约 6K token。 */
 static final int GLOBAL_CAP=8000;
 /** 单个项目记忆的字符上限。项目级信息更具体，但量也更小。 */
 static final int PROJECT_CAP=6000;
 /** 单条记忆的长度上限。超过说明该拆成几条，否则一条就占满预算。 */
 static final int ENTRY_CAP=2000;
 /** 裁剪标记。读写两侧共用，避免改了一边忘了另一边。 */
 static final String CUT_MARK="（更早的记忆已自动裁剪）";

 private final MainActivity a;
 AiMemory(MainActivity a){this.a=a;}

 File memoryDir(){File d=new File(a.getFilesDir(),"project-notes");if(!d.exists()&&!d.mkdirs())return d;return d;}

 /** 全局记忆文件。所有项目共用。 */
 File globalFile(){return new File(a.getFilesDir(),"ai-memory.md");}

 /**
  * 某个项目的记忆文件。
  *
  * <p>项目 ID 可能含任意字符（云端同步下来的 ID 是十六进制串，用户也可能手改），
  * 直接拿来做文件名不安全，所以统一过滤成字母数字下划线。
  */
 File projectFile(String projectId){
  /* 用同一个方法算文件名 —— MainActivity 删项目时也要按同样的规则找到它 */
  return new File(memoryDir(),MainActivity.safeNoteName(projectId)+".md");
 }

 static String readText(File f){try{if(!f.exists())return "";try(InputStream in=new FileInputStream(f)){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];int n;while((n=in.read(buf))>0)out.write(buf,0,n);return new String(out.toByteArray(),StandardCharsets.UTF_8);}}catch(Exception e){return "";}}

 /**
  * 原子写：先写临时文件再 rename。
  *
  * <p>直接覆盖写的话，写到一半被杀进程（手机很常见：切后台被回收）
  * 会留下一个截断的文件，下次读出来是半截记忆 —— 比没有记忆更糟，
  * 因为模型会当真。
  */
 static void writeText(File f, String text) throws IOException {
  File dir=f.getParentFile();
  if(dir!=null&&!dir.exists())dir.mkdirs();
  File tmp=new File(f.getPath()+".tmp");
  try(FileOutputStream out=new FileOutputStream(tmp)){
   out.write(text.getBytes(StandardCharsets.UTF_8));
   out.flush();
   out.getFD().sync();
  }
  if(f.exists()&&!f.delete())throw new IOException("无法替换旧文件："+f.getName());
  if(!tmp.renameTo(f))throw new IOException("无法写入："+f.getName());
 }

 /** 目标文件对应的容量上限。 */
 int capOf(String scope,String projectId){return "project".equals(scope)?PROJECT_CAP:GLOBAL_CAP;}

 File fileOf(String scope,String projectId){return "project".equals(scope)?projectFile(projectId):globalFile();}

 /**
  * 读取记忆。
  *
  * <p>超限时从<b>头部</b>裁掉整行，保留最近的。
  * 不从中间硬切 —— 硬切会留下半句话，模型读起来会误解。
  */
 String read(String scope,String projectId){
  String text=readText(fileOf(scope,projectId));
  int cap=capOf(scope,projectId);
  if(text.length()<=cap)return text;
  return CUT_MARK+"\n"+trimToLines(text,cap);
 }

 /**
  * 按整行裁剪，保留末尾的内容。
  *
  * <p><b>为什么必须按行裁，不能硬切：</b>硬切会在开头留下半句话 ——
  * 模型读到的是「……因为编译期检查不通过」，它会以为这件事本来就是这样，
  * 从而按一个残缺的因果关系去做判断。
  *
  * <p>所以从末尾往回找完整的行边界，凑够预算就停。
  *
  * @param text 原文
  * @param cap  最多保留多少字符
  * @return 裁剪后的内容（一定以完整行结尾）
  */
 static String trimToLines(String text,int cap){
  if(cap<=0)return "";
  if(text.length()<=cap)return text;
  /*
   * 拆成整行，再从末尾往前一行行地收，直到收满预算。
   *
   * <p>拆行而不是找换行符的位置：找位置很容易写出死循环
   * （位置没退回去就永远转），拆行没有这个坑。
   */
  String[] lines=text.split("\n",-1);
  // 用列表收集，最后一次性拼 —— 逐次 insert(0,...) 是 O(n²)，条目多了会卡
  java.util.ArrayList<String> kept=new java.util.ArrayList<>();
  int usedChars=0;
  for(int i=lines.length-1;i>=0;i--){
   String line=lines[i];
   if(line.isEmpty())continue;
   int cost=line.length()+(kept.isEmpty()?0:1);
   if(usedChars+cost>cap)break;
   kept.add(line);
   usedChars+=cost;
  }
  java.util.Collections.reverse(kept);
  // 不用 String.join —— 它要 API 26，而本应用最低支持 API 24
  StringBuilder sb=new StringBuilder();
  for(int i=0;i<kept.size();i++){
   if(i>0)sb.append('\n');
   sb.append(kept.get(i));
  }
  String out=sb.toString().trim();
  /*
   * 一行都收不下（单行就超预算）时，至少保住最后一行 ——
   * 宁可超一点，也不能留半句话。
   */
  if(out.isEmpty()){
   for(int i=lines.length-1;i>=0;i--){
    if(!lines[i].isEmpty())return lines[i].trim();
   }
  }
  return out;
 }

 /** 记忆当前占用的字符数，用于给前端显示进度。 */
 int used(String scope,String projectId){return readText(fileOf(scope,projectId)).length();}

 /**
  * 追加一条记忆。
  *
  * @param text      要记的内容，一行一件事
  * @param scope     {@code global} 或 {@code project}
  * @param projectId 项目范围时必需
  */
 synchronized JSONObject remember(String text,String scope,String projectId)throws Exception{
  String body=(text==null?"":text).trim();
  if(body.isEmpty())throw new Exception("要记的内容不能为空");
  if(body.length()>ENTRY_CAP)throw new Exception("单条记忆 "+body.length()+" 字符，超过上限 "+ENTRY_CAP+"。请拆成几条更具体的记忆");
  if(!"project".equals(scope))scope="global";
  if("project".equals(scope)&&(projectId==null||projectId.trim().isEmpty()))throw new Exception("记到项目记忆时必须指定项目");

  File f=fileOf(scope,projectId);
  String capText=readText(f);
  // 每条前面带时间，问题在于「什么时候知道的」有时比内容本身更重要
  String stamp=new java.text.SimpleDateFormat("MM-dd HH:mm",java.util.Locale.CHINA).format(new java.util.Date());
  StringBuilder sb=new StringBuilder(capText);
  if(sb.length()>0&&sb.charAt(sb.length()-1)!='\n')sb.append('\n');
  sb.append("- [").append(stamp).append("] ").append(body.replace("\r","")).append('\n');

  String next=sb.toString();
  int cap=capOf(scope,projectId);
  boolean trimmed=false;
  if(next.length()>cap){
   /*
    * 裁剪前先把上一次留下的标记去掉。
    * 不去的话每 remember 一次就加一层「已自动裁剪」，
    * 记忆满了之后这个前缀会越堆越高，把真正的预算吃掉。
    */
   String keep=next;
   while(keep.startsWith(CUT_MARK)){
    keep=keep.substring(CUT_MARK.length()).trim();
   }
   next=CUT_MARK+"\n"+trimToLines(keep,cap-CUT_MARK.length()-1);
   trimmed=true;
  }
  writeText(f,next);
  return new JSONObject().put("ok",true).put("scope",scope)
   .put("chars",next.length()).put("cap",cap).put("trimmed",trimmed)
   .put("hint",trimmed?"记忆已满，旧的条目被裁掉了。用 read_memory 看一眼，把还有用的重写一遍":null);
 }

 /**
  * 整段改写记忆（整理时用：把散条目合并成有结构的笔记）。
  *
  * <p>和 {@link #remember} 并存是为了让模型能「整理」而不只是「追加」。
  * 只会追加的话，记忆满了就没法收拾，只能眼看着有用的信息被裁掉。
  */
 synchronized JSONObject replace(String text,String scope,String projectId)throws Exception{
  if(!"project".equals(scope))scope="global";
  String body=text==null?"":text;
  int cap=capOf(scope,projectId);
  if(body.length()>cap)throw new Exception("整理后的内容 "+body.length()+" 字符，仍超过上限 "+cap+"，请再精简");
  writeText(fileOf(scope,projectId),body);
  return new JSONObject().put("ok",true).put("scope",scope).put("chars",body.length()).put("cap",cap);
 }

 /** 清空某个范围的记忆。 */
 synchronized JSONObject clear(String scope,String projectId)throws Exception{
  if(!"project".equals(scope))scope="global";
  File f=fileOf(scope,projectId);
  if(f.exists()&&!f.delete())throw new Exception("删除失败："+f.getName());
  return new JSONObject().put("ok",true).put("scope",scope);
 }

 /**
  * 拼出要被塞进 system prompt 的记忆段落。
  *
  * <p>没有记忆时返回空串 —— 不要在提示词里留一个空的「记忆：无」标题，
   * 那会让模型以为这里本来就该有内容，从而倾向于凭空编点东西填上。
  */
 /**
  * 记忆用量的一行说明，拼进系统提示词。
  *
  * <p><b>为什么必须有：</b>提示词里写着「每轮提示词末尾会告诉你用量」，
  * 可实际上从来没注入过 —— 模型根本不知道还剩多少空间。
  * 于是它只能照常 remember，撞到上限拿到「超过上限，请再精简」，
  * 再猜着删一点、再试一次，来回好几轮才存进去。
  *
  * <p>给出具体数字之后，模型能在快满的时候主动用 update_memory 整理，
  * 而不是被动挨报错。
  *
  * @param projectId 当前项目；没选项目时传 null 或空串
  * @return 一行用量说明；两个范围都为空时返回空串
  */
 String usageFor(String projectId){
  int g=used("global",null);
  int p=projectId==null||projectId.trim().isEmpty()?-1:used("project",projectId);
  if(g==0&&(p<=0))return "";
  StringBuilder sb=new StringBuilder();
  sb.append("\n\n【记忆用量】");
  sb.append("全局 ").append(g).append("/").append(GLOBAL_CAP);
  if(g*10>=GLOBAL_CAP*7)sb.append("（快满了，用 update_memory 整理压缩一轮）");
  if(p>0){
   sb.append("；本项目 ").append(p).append("/").append(PROJECT_CAP);
   if(p*10>=PROJECT_CAP*7)sb.append("（快满了，用 update_memory 整理压缩一轮）");
  }
  sb.append("。写之前先看这个数，别撞上限才发现放不下。");
  return sb.toString();
 }

 String contextFor(String projectId){
  StringBuilder sb=new StringBuilder();
  String global=read("global",null).trim();
  if(!global.isEmpty())sb.append("\n\n【全局记忆】跨会话保存的经验，视为已知事实：\n").append(global);
  if(projectId!=null&&!projectId.trim().isEmpty()){
   String proj=read("project",projectId).trim();
   if(!proj.isEmpty())sb.append("\n\n【本项目记忆】这个项目特有的约定和踩过的坑：\n").append(proj);
  }
  return sb.toString();
 }
}
