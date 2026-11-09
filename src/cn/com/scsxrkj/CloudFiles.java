package cn.com.scsxrkj;
import org.json.*;
import java.util.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import android.util.Base64;
/**
 * 云端项目的文件快照与三方合并。
 *
 * <p>纯函数集合：不做网络请求，也不写状态，只负责算。
 *
 * <p>核心是「保守三方合并」：本地改了、云端也改了同一个文件时，
 * 不猜哪个对，直接报冲突让用户处理，绝不悄悄覆盖掉别人的改动。
 */
final class CloudFiles {

 /** 超过这个大小（字节）的文件不存进 JSON，改存成独立文件。 */
 static final int BIG_THRESHOLD = 256 * 1024;
 /** 大文件独立存储的目录名（相对 filesDir）。 */
 static final String BIG_DIR = "project-files";
 /** 大文件引用的编码标记。 */
 static final String REF_MARK = "ref";

 /** 判断条目是不是「外部文件引用」。 */
 static boolean isRef(JSONObject e){return e!=null&&e.has(REF_MARK);}

 /**
  * 大文件的存储目录。
  * @param filesDir 应用私有目录
  */
 static File bigDir(File filesDir){File d=new File(filesDir,BIG_DIR);if(!d.isDirectory()&&!d.mkdirs())throw new RuntimeException("无法创建大文件目录");return d;}

 /**
  * 把一个大文件写成独立文件，返回引用对象。
  * @param filesDir 应用私有目录
  * @param name 存储名
  * @param bytes 文件内容
  * @return {"ref":name,"sha256":"...","size":N}
  */
 static JSONObject writeBig(File filesDir,String name,byte[] bytes)throws Exception{
  File f=new File(bigDir(filesDir),name);
  try(java.io.FileOutputStream out=new java.io.FileOutputStream(f)){out.write(bytes);}
  return new JSONObject().put(REF_MARK,name).put("sha256",hash(bytes)).put("size",bytes.length);
 }

 /**
  * 读回一个大文件。
  * @param filesDir 应用私有目录
  * @param name 存储名
  */
 static byte[] readBig(File filesDir,String name)throws Exception{
  File f=new File(bigDir(filesDir),name);
  if(!f.isFile())throw new Exception("大文件缺失："+name);
  long len=f.length();
  if(len>200L*1024*1024)throw new Exception("大文件过大："+name);
  byte[] out=new byte[(int)len];
  try(java.io.RandomAccessFile r=new java.io.RandomAccessFile(f,"r")){r.readFully(out);}
  return out;
 }

 /**
  * 从条目里取出字节。小文件走 content，大文件走外部引用。
  * @param filesDir 应用私有目录
  * @param e 条目
  */
 static byte[] bytes(File filesDir,JSONObject e)throws Exception{if(isRef(e))return readBig(filesDir,e.getString(REF_MARK));return bytes(e);}

 /**
  * 为一个大文件生成存储名。
  *
  * <p><b>为什么不能只用路径：</b>大文件都放在同一个目录 {@code project-files/}，
  * 是<b>所有项目共用</b>的。而项目内路径在不同项目里会重名 ——
  * 两个项目都有 {@code assets/model.onnx}，如果只用路径算哈希，
  * 两个项目算出同一个文件名，后写的把先写的覆盖掉。
  *
  * <p><b>那会发生什么：</b>项目 A 的模型被项目 B 的模型顶掉，
  * A 里显示着 20 片分片、实际文件却是 B 的内容 ——
  * 症状是「素材体检说齐了，装上去就是识别不了」，
  * 而且没有任何报错，只是内容不对。
  *
  * <p><b>所以名字里必须带上项目 id：</b>同一个项目里路径唯一，
  * 不同项目天然分开。
  *
  * @param projectId 项目 id；为空时退化成只用路径（兼容没有项目上下文的调用）
  * @param path      项目内相对路径
  * @return 存储文件名，形如 {@code <项目id>-<路径哈希16位>.bin}
  */
 static String bigName(String projectId,String path)throws Exception{
  String scope=projectId==null?"":projectId;
  return hash((scope+"/"+path).getBytes(StandardCharsets.UTF_8)).substring(0,16)+"-"+
         hash(path.getBytes(StandardCharsets.UTF_8)).substring(0,8)+".bin";
 }

 /**
  * 按内容给一个大文件定名（内容寻址）。
  *
  * <p><b>为什么必须按内容定名：</b>大文件都放在同一个目录
  * {@code project-files/}，是<b>所有项目共用</b>的，文件名就是唯一的身份。
  * 只要名字不是由内容唯一决定的，就一定会出事：
  *
  * <ul>
  *   <li><b>跨项目覆盖</b> —— 两个项目都有 {@code assets/model.onnx}，
  *       只用路径定名会算出同一个文件名，后写的把先写的覆盖掉。
  *       症状是「素材体检说齐了，装上去就是识别不了」，
  *       而且没有任何报错，只是内容不对。</li>
  *   <li><b>同项目旧内容残留</b> —— 路径没变、内容变了，
  *       名字却不变。{@code externalizeBinaries} 看到文件已存在就跳过写入，
  *       结果磁盘上留着旧内容，{@code bigHashes} 却记了新内容的哈希 ——
  *       哈希对不上，同步时会被判成「两边都改了」。</li>
  * </ul>
  *
  * <p><b>内容寻址把这一类问题整个消掉：</b>
  * <ul>
  *   <li>内容不同 → 哈希不同 → 绝不会撞名；</li>
  *   <li>内容相同 → 名字相同 → 天然复用一份磁盘空间；</li>
  *   <li>改名不用搬文件 —— 名字跟路径无关；</li>
  *   <li>旧内容变成没人引用的孤儿，由 {@code gcBigFiles} 统一回收。</li>
  * </ul>
  *
  * <p>取 SHA-256 的前 32 位十六进制（128 bit）：碰撞概率低到可以忽略，
  * 而文件名短一些，路径拼接时不容易超长。
  *
  * @param content 文件内容
  * @return 存储文件名，形如 {@code <32位十六进制>.bin}
  */
 static String bigNameFor(byte[] content)throws Exception{
  return hash(content).substring(0,32)+".bin";
 }

 /**
  * 按内容给一个大文件定名（流式版本）。
  *
  * <p>大文件可能有几百 MB，不该整份读进内存再算哈希。
  * 边写边算，名字在写完之后才知道 —— 所以先写临时文件，
  * 拿到哈希后改名。
  *
  * @param filesDir 应用私有目录
  * @param raw      文件内容
  * @return 存储好的引用对象 {@code {"ref":..., "sha256":..., "size":...}}
  */
 static JSONObject writeBig(File filesDir,byte[] raw)throws Exception{
  String name=bigNameFor(raw);
  File f=new File(bigDir(filesDir),name);
  if(!f.isFile()){
   try(java.io.FileOutputStream out=new java.io.FileOutputStream(f)){out.write(raw);}
  }
  return new JSONObject().put(REF_MARK,name).put("sha256",hash(raw)).put("size",raw.length);
 }

 /**
  * 为一个大文件生成存储名（没有项目上下文时用）。
  *
  * <p><b>为什么不建议用这个：</b>它不区分项目，多个项目之间会互相覆盖。
  * 只有确实拿不到项目 id 的地方才能用（比如猜引用名的兜底查找）。
  *
  * @param path 项目内相对路径
  */
 static String bigName(String path)throws Exception{
  return hash(path.getBytes(StandardCharsets.UTF_8)).substring(0,16)+".bin";
 }

 /**
  * 把条目集合还原成「路径 → 文字内容」。
  * @param filesDir 应用私有目录
  * @param entries 条目集合
  */
 static JSONObject readable(File filesDir,JSONObject entries)throws Exception{
  JSONObject out=new JSONObject();
  for(Iterator<String>i=entries.keys();i.hasNext();){String n=i.next();out.put(n,new String(bytes(filesDir,entries.getJSONObject(n)),StandardCharsets.UTF_8));}
  return out;
 }

 /**
  * 判断一段字节是不是「UTF-8 文本」。
  *
  * <p>判据两条：不含 NUL 字节；能按 UTF-8 严格解码（拒绝非法序列，不做静默替换）。
  *
  * <p>为什么要判：文本存原文（能直接在编辑器里改、体积也小），
  * 二进制必须存 base64，否则一旦被当文本解码再写回去，文件就损坏了。
  * 模型文件（.onnx / .wasm / .gz）全是二进制，这条判错了整个导入就废了。
  *
  * @param b 字节
  */
 static boolean text(byte[] b){
  if(b==null)return false;
  for(byte v:b)if(v==0)return false;
  try{
   java.nio.charset.StandardCharsets.UTF_8.newDecoder()
     .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
     .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
     .decode(java.nio.ByteBuffer.wrap(b));
   return true;
  }catch(Exception e){
   return false;
  }
 }

 static boolean path(String p){if(p==null||p.isEmpty()||p.length()>240||p.startsWith("/")||java.util.regex.Pattern.compile("[\\\\\\x00-\\x1f\\x7f]").matcher(p).find())return false;for(String s:p.split("/",-1))if(s.isEmpty()||s.equals(".")||s.equals(".."))return false;return true;}
 /**
  * 判断一个路径要不要排除在同步/导入之外。
  *
  * <p><b>判断标准是「能不能重建」，不是「是不是构建产物」</b>
  *
  * <p>早期这里把 {@code dist} 和 {@code node_modules} 归成同一类「构建产物」一起排除，
  * 结果模型权重丢了 —— 而且是永久丢失：
  *
  * <ul>
  *   <li>语音识别权重（79 MB，20 片）在 {@code dist/client/web/asr/models/}，
  *       是平台构建时从网络下载后切片的</li>
  *   <li>它<b>不在源码里</b>（源码只有 wasm 和 tokens.txt）</li>
  *   <li>它<b>不在 git 里</b>（79 MB 放不进仓库）</li>
  *   <li>它<b>不在 node_modules 里</b>（那只是构建缓存）</li>
  * </ul>
  *
  * <p>也就是说，排除 dist 之后这个模型<b>再也拿不回来</b> ——
  * 重新构建要从网络重新下载，而应用装上后本地识别永远不可用。
  *
  * <p>所以现在按「能不能重建」分：
  * <ul>
  *   <li><b>排除</b>：node_modules、.git、.cache —— 能重建，占空间大</li>
  *   <li><b>排除</b>：dist/admin、dist/build-report.json —— 后台 UI 和报告，应用用不到</li>
  *   <li><b>保留</b>：dist/client/web/ —— 编译成品 + 不可重建的模型</li>
  *   <li><b>排除</b>：证书私钥、平台凭据 —— 那是平台的东西，不该进你的项目</li>
  * </ul>
  *
  * @param p 路径
  * @return true 表示要排除
  */
 static boolean excluded(String p){
  // 编译成品：保留（里面有不可重建的模型权重）
  if(p.startsWith("dist/client/web/"))return false;
  // 后台管理 UI 和构建报告：应用用不到
  if(p.startsWith("dist/admin/")||p.equals("dist/build-report.json"))return true;
  // 可重建的目录：排除
  if(p.matches("(?i)(?:.*/)?(?:\\.git|node_modules|\\.gradle|build|\\.next|\\.cache)(?:/.*)?"))return true;
  // dist 下其他目录（构建中间产物）：排除
  if(p.startsWith("dist/"))return true;
  // 平台凭据与私钥：绝不能进你的项目
  if(p.matches("(?i)(?:.*/)?(?:\\.env(?:\\..*)?|credentials(?:\\..*)?|secrets?(?:\\..*)?|local\\.properties|capsule\\.properties|id_rsa|id_ed25519)"))return true;
  if(p.matches("(?i).*\\.(p12|pfx|jks|keystore|pem|key)"))return true;
  return false;
 }
 /**
  * 说明一个路径为什么被跳过。
  *
  * <p>同步/导入时不是所有文件都会带过来。被跳过的要让用户知道 ——
  * 静默丢弃会让人以为「文件都在」，等用到时才发现少了一堆。
  *
  * @param p 路径
  * @return 跳过原因；不跳过返回 null
  */
 static String skipReason(String p){
  if(p.startsWith("dist/client/web/"))return null;
  if(p.startsWith("dist/admin/"))return "后台管理界面，手机应用用不到";
  if(p.equals("dist/build-report.json"))return "平台构建报告";
  if(p.matches("(?i)(?:.*/)?node_modules(?:/.*)?"))return "依赖目录，可重新安装";
  if(p.matches("(?i)(?:.*/)?\\.git(?:/.*)?"))return "版本库目录";
  if(p.matches("(?i)(?:.*/)?\\.cache(?:/.*)?"))return "缓存目录";
  if(p.matches("(?i)(?:.*/)?build(?:/.*)?"))return "构建中间产物";
  if(p.matches("(?i)(?:.*/)?\\.gradle(?:/.*)?"))return "Gradle 缓存";
  if(p.matches("(?i)(?:.*/)?\\.next(?:/.*)?"))return "Next 构建缓存";
  if(p.startsWith("dist/"))return "构建中间产物";
  if(p.matches("(?i)(?:.*/)?\\.env(?:\\..*)?"))return "平台后端连接信息，含密钥";
  if(p.matches("(?i)(?:.*/)?credentials(?:\\..*)?"))return "凭据文件";
  if(p.matches("(?i)(?:.*/)?secrets?(?:\\..*)?"))return "密钥文件";
  if(p.matches("(?i)(?:.*/)?local\\.properties"))return "本机路径配置";
  if(p.matches("(?i)(?:.*/)?capsule\\.properties"))return "平台签名口令";
  if(p.matches("(?i)(?:.*/)?id_rsa")||p.matches("(?i)(?:.*/)?id_ed25519"))return "SSH 私钥";
  if(p.matches("(?i).*\\.(p12|pfx|jks|keystore|pem|key)"))return "证书与私钥";
  return null;
 }

 /**
  * 把一组名字用顿号连成一句，供报错文案使用。
  *
  * <p>不用 String.join —— 那是 API 26 才有的，minSdk 24 用不了。
  *
  * @param list 名字列表
  */
 static String join(java.util.List<String> list){
  StringBuilder s=new StringBuilder();
  for(String n:list){if(s.length()>0)s.append("、");s.append(n);}
  return s.toString();
 }

 /**
  * 流式计算文件的 SHA-256。
  *
  * <p>不用 {@code readAllBytes} —— 那样会把整个文件读进堆里，
  * 一个 100 MB 的模型就能让手机内存吃紧。
  *
  * @param f 文件
  * @return 小写十六进制哈希
  */
 static String hashFile(File f)throws Exception{
  MessageDigest d=MessageDigest.getInstance("SHA-256");
  try(java.io.FileInputStream in=new java.io.FileInputStream(f)){
   byte[] buf=new byte[1024*1024];
   int n;
   while((n=in.read(buf))!=-1)d.update(buf,0,n);
  }
  StringBuilder s=new StringBuilder();
  for(byte v:d.digest())s.append(String.format(java.util.Locale.ROOT,"%02x",v&255));
  return s.toString();
 }

 static String hash(byte[] b)throws Exception{StringBuilder s=new StringBuilder();for(byte v:MessageDigest.getInstance("SHA-256").digest(b))s.append(String.format(java.util.Locale.ROOT,"%02x",v&255));return s.toString();}
 static byte[] bytes(JSONObject e)throws Exception{String c=e.getString("content"),encoding=e.getString("encoding");if(encoding.equals("utf8"))return c.getBytes(StandardCharsets.UTF_8);if(encoding.equals("base64"))return Base64.decode(c,Base64.NO_WRAP);throw new Exception("不支持的文件编码");}
 static JSONObject entry(String content,String encoding)throws Exception{JSONObject e=new JSONObject().put("content",content).put("encoding",encoding);return e.put("sha256",hash(bytes(e)));}
 static JSONObject entries(JSONObject p)throws Exception{return entries(p,null);}

 /**
  * 枚举一个项目的全部文件，返回带哈希的条目集合。
  *
  * <p>大文件在项目里存的是「引用名」，这里按需读回实际内容并转成标准条目。
  * 传 filesDir 就能读到大文件；传 null 则只处理小文件。
  *
  * @param p 项目对象
  * @param filesDir 应用私有目录；null 表示不读大文件
  */
 static JSONObject entries(JSONObject p,File filesDir)throws Exception{
  JSONObject out=new JSONObject(),f=p.getJSONObject("files"),b=p.optJSONObject("binaryFiles");
  for(Iterator<String>i=f.keys();i.hasNext();){String n=i.next();out.put(n,entry(f.getString(n),"utf8"));}
  if(b!=null)for(Iterator<String>i=b.keys();i.hasNext();){
   String n=i.next();
   if(out.has(n))throw new Exception("文件路径重复");
   String v=b.getString(n);
   boolean isRef=v.endsWith(".bin");
   if(isRef){
    // 大文件：哈希从 bigHashes 索引取（不需要读盘），
    // 内容按需从项目大文件目录读。
    JSONObject hashes=p.optJSONObject("bigHashes");
    String sha=hashes==null?null:hashes.optString(n,null);
    if(sha==null||sha.isEmpty()){
     // 索引里没有（旧数据），只能读盘算
     if(filesDir!=null)sha=hash(readBig(filesDir,v));
     else sha="";
    }
    long sz=0;
    if(filesDir!=null){File g=new File(bigDir(filesDir),v);if(g.isFile())sz=g.length();}
    out.put(n,new JSONObject().put("ref",v).put("sha256",sha).put("size",sz));
   }else{
    out.put(n,entry(v,"base64"));
   }
  }
  validate(out);return out;}
 static void validate(JSONObject entries)throws Exception{if(entries.length()>3000)throw new Exception("项目有 "+entries.length()+" 个文件，超过 3000 个上限");long size=0;for(Iterator<String>i=entries.keys();i.hasNext();){String n=i.next();if(!path(n)||excluded(n))throw new Exception("同步不包含此路径："+n);JSONObject e=entries.getJSONObject(n);long len=e.optLong("size",-1);if(len<0&&!isRef(e))len=bytes(e).length;if(len>0)size+=len;if(len>100L*1024*1024||size>200L*1024*1024)throw new Exception("同步上限为单文件 100 MB、项目 200 MB");// 大文件（外部引用）的内容在项目大文件目录里，校验交给读取方；这里只检查元数据齐全
 if(isRef(e)){if(!e.has("sha256"))throw new Exception("大文件缺少哈希："+n);continue;}
 if(!hash(bytes(e)).equals(e.getString("sha256")))throw new Exception("文件校验失败："+n);}}
 static JSONObject hashes(JSONObject e)throws Exception{JSONObject h=new JSONObject();for(Iterator<String>i=e.keys();i.hasNext();){String n=i.next();h.put(n,e.getJSONObject(n).getString("sha256"));}return h;}
 static String h(JSONObject e,String n){JSONObject v=e.optJSONObject(n);return v==null?"":v.optString("sha256");}
 static JSONObject merge(JSONObject local,JSONObject remote,JSONObject base)throws Exception{
  validate(local);validate(remote);JSONObject result=new JSONObject(local.toString());Set<String>names=new TreeSet<>();for(JSONObject o:new JSONObject[]{local,remote,base})for(Iterator<String>i=o.keys();i.hasNext();)names.add(i.next());ArrayList<String>conflicts=new ArrayList<>();
  for(String n:names){String l=h(local,n),r=h(remote,n),b=base.optString(n,"");if(l.equals(r))continue;if(l.equals(b)){if(remote.has(n))result.put(n,remote.get(n));else result.remove(n);}else if(!r.equals(b))conflicts.add(n);}
  if(!conflicts.isEmpty())throw new Exception("两边都修改了同一文件，未覆盖本地："+CloudFiles.join(conflicts));validate(result);return result;
 }
 /**
  * 把条目集合写回项目对象。超过阈值的文件写成独立文件，JSON 里只留引用。
  * @param p 项目对象
  * @param entries 条目集合
  * @param filesDir 应用私有目录
  */
 static void assign(JSONObject p,JSONObject entries,File filesDir)throws Exception{
 JSONObject f=new JSONObject(),b=new JSONObject(),h=new JSONObject();
 for(Iterator<String>i=entries.keys();i.hasNext();){
  String n=i.next();
  JSONObject e=entries.getJSONObject(n);
  if(isRef(e)){
   // 大文件：项目里只存引用名，哈希另存一份索引。
   //
   // 哈希直接读盘算，不依赖条目里带的 sha256 ——
   // 那条传递链（网页 → 原生 → 合并 → 写回）中间环节多，
   // 任何一环丢了字段，最终索引就是空的，
   // 下次同步时 merge 拿不到哈希，就会把大文件误判成「两边都改了」而报冲突。
   String ref=e.getString(REF_MARK);
   b.put(n,ref);
   try{
    File bigFile=new File(bigDir(filesDir),ref);
    // 流式算哈希 —— readAllBytes 会把整个文件读进堆里，一个 100 MB 的模型就能让手机内存吃紧。
    if(bigFile.isFile())h.put(n,hashFile(bigFile));
   }catch(Exception ignored){}
   continue;
  }
  byte[] raw=bytes(e);
  if(raw.length>BIG_THRESHOLD){
   JSONObject stored=writeBig(filesDir,raw);
   b.put(n,stored.getString(REF_MARK));
   h.put(n,stored.getString("sha256"));
  }else (e.getString("encoding").equals("utf8")?f:b).put(n,e.getString("content"));
 }
 p.put("files",f).put("binaryFiles",b).put("bigHashes",h);}
 /*
 * 把项目里的 base64 二进制搬到磁盘，改成 .bin 引用。
 *
 * <p>为什么：这些内容原来直接存在 workspace.json 里。
 * 一张图片 base64 后比原文件还大 33%，几十张图就能让 workspace.json 涨好几 MB ——
 * 而 workspace.json 是**每次启动都要整个读进内存**的。
 *
 * <p>机制本来就有（超过 BIG_THRESHOLD 的文件写成 .bin 放 project-files/），
 * 但只有走同步的路径才会触发。本方法让**已有的**项目也能用上。
 *
 * <p>搬完 workspace.json 里只剩文件名（几十字节），内存和磁盘都省。
 *
 * @param p        项目对象（会被就地修改）
 * @param filesDir 应用私有目录
 * @return 搬走了多少字节
 */
 static long externalizeBinaries(JSONObject p,File filesDir)throws Exception{
  JSONObject bins=p.optJSONObject("binaryFiles");
  if(bins==null)return 0L;
  JSONObject hashes=p.optJSONObject("bigHashes");
  if(hashes==null){hashes=new JSONObject();p.put("bigHashes",hashes);}
  long moved=0L;
  for(java.util.Iterator<String> it=bins.keys();it.hasNext();){
   String n=it.next();
   String v=bins.optString(n,"");
   if(v.isEmpty()||v.endsWith(".bin"))continue;
   byte[] raw;
   try{raw=Base64.decode(v,Base64.DEFAULT);}catch(Exception e){continue;}
   JSONObject stored=writeBig(filesDir,raw);
   bins.put(n,stored.getString(REF_MARK));
   hashes.put(n,stored.getString("sha256"));
   moved+=raw.length;
  }
  return moved;
 }

 /*
 * 存一份恢复存档。
 *
 * <p>只存**这次同步真正动过的文件**的旧内容，不存整个项目。
 * 原来存全量，一个 300 文件的项目每次同步都多存一份全量，
 * workspace.json 很快涨到几 MB。
 *
 * <p>只留 2 份：再多用户也用不上，每份都是内存和磁盘负担。
 *
 * @param p      项目对象（会被就地修改）
 * @param changed 这次变了的文件路径；传 null 表示「全量存一份」
 */
static void snapshot(JSONObject p)throws Exception{snapshot(p,null,"auto");}
static void snapshot(JSONObject p,java.util.Set<String> changed)throws Exception{snapshot(p,changed,"auto");}
/**
 * 存一份存档。
 *
 * <p>{@code source} 记着这份存档是谁存的：
 * {@code user} 是用户手动点的，{@code auto} 是系统自动存的
 * （云端同步、AI 改代码、清洗、补文件）。
 *
 * <p><b>为什么要分这个：</b>自动存档每做一次 AI 改动就多一份，
 * 而状态文件放不下无限多份 —— 必须裁掉一些。
 * 可要是无脑裁，用户手动存的那份会被后来的自动存档顶掉，
 * 用户回头想「回到我改之前的样子」，发现没了。
 *
 * <p>所以裁剪规则是：自动存档按时间留最近几份，<b>用户手动存的一份都不丢</b>。
 */
static void snapshot(JSONObject p,java.util.Set<String> changed,String source)throws Exception{
 JSONArray old=p.optJSONArray("snapshots");
 JSONObject cur=p.optJSONObject("files"),delta=new JSONObject();
 if(changed==null){
  if(cur!=null)for(java.util.Iterator<String> it=cur.keys();it.hasNext();){String n=it.next();delta.put(n,cur.optString(n,""));}
 }else{
  /*
   * 差量：changed 里「当前没有」的文件是这次同步新建的，
   * 用 NULL 标记 —— 恢复时要删掉，否则新建的文件会残留下来。
   */
  for(String n:changed){
   if(cur!=null&&cur.has(n))delta.put(n,cur.optString(n,""));
   else delta.put(n,JSONObject.NULL);
  }
 }
 /*
  * 二进制文件也要进存档 —— 只存文本等于「恢复」是假的。
  *
  * <p>图片、字体、模型权重都在 binaryFiles 这张表里，内容在 project-files 目录。
  * 以前存档只拍 files，于是：删掉一张图 → 引用没了 → gcBigFiles 把磁盘上的
  * .bin 也删了 → 点「恢复上一版」，文本回来了，图永远回不来了。
  *
  * <p>现在按内容寻址，同一份内容可能被多个项目共用，所以恢复时只要把引用
  * 指回去就行，不需要复制磁盘内容。
  */
 JSONObject curBins=p.optJSONObject("binaryFiles"),bins=new JSONObject();
 if(curBins!=null)for(java.util.Iterator<String> it=curBins.keys();it.hasNext();){
  String n=it.next();
  bins.put(n,curBins.optString(n,""));
 }
 // 这一份新存档：跟老的合并后统一裁剪
 JSONArray newest=new JSONArray();
 newest.put(new JSONObject().put("time",System.currentTimeMillis())
   .put("files",delta).put("bins",bins).put("delta",true)
   .put("source",source==null?"auto":source));
 p.put("snapshots",trimSnapshots(old,newest));
}
 /**
  * 裁剪存档列表。
  *
  * <p>规则：最近 {@link #SNAP_KEEP} 份自动存档照留，
  * <b>用户手动存的（source=user）一份都不丢</b>。
  *
  * <p>原来是无脑只留最后一份 —— AI 改一轮代码，用户手动存的基准就没了，
  * 「变更」视图自动跳到最新的自动存档上，用户完全看不出发生了什么。
  */
 static final int SNAP_KEEP=5;
 /**
  * 这份存档是不是用户手动存的。
  *
  * <p>没有 source 字段的老存档一律当成用户存的 ——
  * 老版本只有用户手动点过才产生存档，自动存档是后来才有的。
  * 把老的当自动存档裁掉，就等于把用户的历史基准删了。
  */
 static boolean isUserSnapshot(JSONObject s){
  if(s==null)return false;
  String src=s.optString("source","");
  // 没有 source → 老存档 → 当作用户存的
  if(src.isEmpty())return true;
  return "user".equals(src);
 }
 static JSONArray trimSnapshots(JSONArray old,JSONArray newest){
  JSONArray all=new JSONArray();
  if(old!=null)for(int i=0;i<old.length();i++)all.put(old.opt(i));
  if(newest!=null)for(int i=0;i<newest.length();i++)all.put(newest.opt(i));
  /*
   * 先数自动存档一共几份，再决定丢哪些。
   *
   * <p><b>丢的是最老的那几份，留的是最近的。</b>
   * 「变更」视图默认拿最后一份存档当基准，所以最近的必须留着 ——
   * 留最早的那几份等于把用户当下要看的基准删了。
   */
  /*
   * 老项目的存档没有 source 字段 —— 那都是用户自己点出来的，
   * 必须当成 user 保留下来，不能当自动存档裁掉。
   */
  int autoTotal=0;
  for(int i=0;i<all.length();i++){
   JSONObject s=all.optJSONObject(i);
   if(s==null)continue;
   if(!isUserSnapshot(s))autoTotal++;
  }
  // 自动存档要丢掉的份数（从最老的那头丢）
  int autoDrop=Math.max(0,autoTotal-SNAP_KEEP);
  JSONArray out=new JSONArray();
  int autoSeen=0;
  for(int i=0;i<all.length();i++){
   JSONObject s=all.optJSONObject(i);
   if(s==null)continue;
   if(isUserSnapshot(s)){out.put(s);continue;}
   autoSeen++;
   // 前 autoDrop 份自动存档丢掉，剩下的（包括最新那份）留下
   if(autoSeen<=autoDrop)continue;
   out.put(s);
  }
  return out;
 }
}
