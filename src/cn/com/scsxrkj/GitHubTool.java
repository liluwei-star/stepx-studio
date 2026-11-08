package cn.com.scsxrkj;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/**
 * 把项目上传到 GitHub，并支持增量更新。
 *
 * <p>用 Git Data API 而不是 Contents API，原因是量级：
 * Contents API 每个文件一次 PUT 请求，一次改三个文件就要三次 commit；
 * Git Data API 可以一次建 tree、一次 commit，几百个文件的更新只产生一条历史记录。
 *
 * <p>增量靠 <b>git blob 的 SHA-1</b> 判断：先在远端拉一遍 tree，
 * 算出每个文件在 git 里的对象哈希，跟本地现算的比。相同的跳过，
 * 只上传真正变了的。首次上传 392 个文件就是 392 次请求，
 * 之后改十个文件就只有十来次。
 *
 * <p>只传文本文件。二进制（图片、模型权重）跳过并在结果里列出来 ——
 * 那些文件动辄几十 MB，手机上通过 API 传既慢又容易断，
 * 而且 GitHub 对单文件有 100 MB 硬限制。
 */
final class GitHubTool {
 static final String API="https://api.github.com";
 static final String BRANCH="main";
 /** 单个文件的大小上限。GitHub 自己的硬限制是 100 MB，这里压到 1 MB —— 再大手机网络扛不住。 */
 static final int FILE_CAP=1024*1024;
 /** 单次上传的文件数上限，防止误点一个巨型项目把配额耗光。 */
 static final int PUSH_FILE_CAP=3000;

 private final MainActivity a;
 GitHubTool(MainActivity a){this.a=a;}

 String token(){return a.prefs.getString("ghToken","").trim();}
 String owner(){return a.prefs.getString("ghOwner","").trim();}
 String repo(){return a.prefs.getString("ghRepo","").trim();}

 boolean ready(){return !token().isEmpty();}

 static String requireToken(MainActivity a)throws Exception{
  String t=a.prefs.getString("ghToken","").trim();
  if(t.isEmpty())throw new Exception("还没有配置 GitHub Token。请在「AI 设置」里填一个带 repo 权限的 Personal Access Token");
  return t;
 }

 /** 发一个 GitHub API 请求。统一处理认证、超时、错误信息。 */
 static JSONObject request(MainActivity a,String method,String path,JSONObject body)throws Exception{
  return request(a,method,path,body,false);
 }

 /**
  * @param raw true 时返回 {@code {__raw:字符串}}，用于不需要解析的响应
  */
 static JSONObject request(MainActivity a,String method,String path,JSONObject body,boolean raw)throws Exception{
  String token=requireToken(a);
  HttpURLConnection c;
  try{c=(HttpURLConnection)new URL(path.startsWith("http")?path:API+path).openConnection();}
  catch(Exception e){throw new Exception("GitHub 地址无法解析："+e.getMessage());}
  try{
   c.setRequestMethod(method);
   c.setConnectTimeout(20000);
   c.setReadTimeout(45000);
   c.setRequestProperty("Authorization","Bearer "+token);
   c.setRequestProperty("Accept","application/vnd.github+json");
   c.setRequestProperty("X-GitHub-Api-Version","2022-11-28");
   c.setRequestProperty("User-Agent","StepXStudio/1.0");
   if(body!=null){
    c.setDoOutput(true);
    c.setRequestProperty("Content-Type","application/json; charset=utf-8");
    byte[] payload=body.toString().getBytes(StandardCharsets.UTF_8);
    c.setFixedLengthStreamingMode(payload.length);
    try(OutputStream out=c.getOutputStream()){out.write(payload);}
   }
   int code=c.getResponseCode();
   InputStream in=code>=400?c.getErrorStream():c.getInputStream();
   String text="";
   if(in!=null){
    ByteArrayOutputStream out=new ByteArrayOutputStream();
    byte[] buf=new byte[8192];int n;
    while((n=in.read(buf))>0)out.write(buf,0,n);
    text=new String(out.toByteArray(),StandardCharsets.UTF_8);
   }
   if(code>=400){
    String message=text;
    try{message=new JSONObject(text).optString("message",text);}catch(Exception ignored){}
    if(code==401)throw new Exception("GitHub Token 无效或已过期（401）");
    if(code==403)throw new Exception("GitHub 拒绝访问（403），可能是权限不足或触发限流："+trim(message,200));
    if(code==404)throw new Exception("GitHub 找不到资源（404）："+trim(message,200));
    throw new Exception("GitHub 返回 HTTP "+code+"："+trim(message,300));
   }
   if(raw)return new JSONObject().put("__raw",text);
   return text.trim().isEmpty()?new JSONObject():new JSONObject(text);
  }catch(SocketTimeoutException e){
   throw new Exception("连不上 GitHub（超时）。手机网络访问 github.com 经常不通，换个网络或开代理再试");
  }catch(UnknownHostException e){
   throw new Exception("解析不了 api.github.com，当前网络可能访问不了 GitHub");
  }finally{c.disconnect();}
 }

 static String trim(String s,int cap){
  String t=s==null?"":s.trim();
  return t.length()>cap?t.substring(0,cap)+"…":t;
 }

 /**
  * 算一个文件在 git 里的 blob 哈希。
  *
  * <p>公式是死的：{@code sha1("blob " + 字节数 + "\0" + 内容)}。
  * 必须先有字节数再有内容，中间那个 NUL 不能少 —— 少了算出来就永远对不上，
  * 结果每次上传都当"全变了"，一个文件不落全传一遍。
  */
 static String blobSha(byte[] content)throws Exception{
  MessageDigest md=MessageDigest.getInstance("SHA-1");
  md.update(("blob "+content.length+"\0").getBytes(StandardCharsets.UTF_8));
  md.update(content);
  byte[] digest=md.digest();
  StringBuilder sb=new StringBuilder(digest.length*2);
  for(byte b:digest)sb.append(String.format("%02x",b));
  return sb.toString();
 }

 /**
  * 判断一份内容能不能当文本传。
  *
  * <p>含 NUL 字节就当二进制。这个判据比看扩展名可靠 ——
  * 有些 .json 其实是坏文件，有些没扩展名的确实是纯文本。
  */
 static boolean isText(byte[] data){
  if(data.length==0)return true;
  int check=Math.min(data.length,4096);
  for(int i=0;i<check;i++)if(data[i]==0)return false;
  return true;
 }

 /** GitHub 上的当前状态：登录身份、目标仓库是否存在、有多少文件。 */
 JSONObject status()throws Exception{
  JSONObject user=request(a,"GET","/user",null);
  String login=user.optString("login","");
  JSONObject out=new JSONObject().put("ok",true).put("login",login)
   .put("configured",ready()).put("ownerHint",owner().isEmpty()?login:owner());
  String r=repo();
  if(!r.isEmpty()){
   String o=owner().isEmpty()?login:owner();
   try{
    JSONObject repoInfo=request(a,"GET","/repos/"+o+"/"+r,null);
    out.put("repo",r).put("repoExists",true)
     .put("defaultBranch",repoInfo.optString("default_branch","main"))
     .put("private",repoInfo.optBoolean("private"))
     .put("htmlUrl",repoInfo.optString("html_url"))
     .put("pushedAt",repoInfo.optString("pushed_at"));
   }catch(Exception e){
    out.put("repo",r).put("repoExists",false).put("repoNote",e.getMessage());
   }
  }
  return out;
 }

 /**
  * 上传或更新一个项目。
  *
  * @param project  项目对象（含 files）
  * @param repoName 仓库名，空则用配置里的
  * @param message  commit 说明
  * @param isPrivate 私有仓库
  * @param progress 进度回调，可为 null
  */
 JSONObject push(JSONObject project,String repoName,String message,boolean isPrivate,Progress progress)throws Exception{
  if(project==null)throw new Exception("没有要上传的项目");
  String token=requireToken(a);
  JSONObject files=project.optJSONObject("files");
  if(files==null||files.length()==0)throw new Exception("项目里没有文本文件可上传");

  // ① 拿登录名
  JSONObject user=request(a,"GET","/user",null);
  String login=user.optString("login","");
  if(login.isEmpty())throw new Exception("取不到 GitHub 账号信息，Token 可能没有 user 权限");
  String o=owner().isEmpty()?login:owner();
  String name=(repoName==null?repo():repoName).trim();
  if(name.isEmpty())name=sanitizeRepo(project.optString("name","stepx-project"));
  if(progress!=null)progress.step("登录为 "+login);

  // ② 确保仓库存在
  String full=o+"/"+name;
  boolean created=false;
  try{
   request(a,"GET","/repos/"+full,null);
  }catch(Exception e){
   String msg=String.valueOf(e.getMessage());
   if(msg.contains("404")){
    if(progress!=null)progress.step("仓库不存在，创建 "+full);
    request(a,"POST","/user/repos",new JSONObject()
     .put("name",name).put("private",isPrivate).put("auto_init",true)
     .put("description","由 StepX Studio 上传的移动端项目"));
    created=true;
    // auto_init 会异步建初始 commit，刚建完可能还没落地，重试几次
    for(int i=0;i<6;i++){
     try{Thread.sleep(1200);request(a,"GET","/repos/"+full,null);break;}
     catch(Exception retry){if(i==5)throw new Exception("仓库已创建，但暂时读不到（GitHub 侧延迟）。稍后重试即可");}
    }
   }else throw e;
  }

  // ③ 取远端 HEAD
  String parentSha=null,treeSha=null;
  Map<String,String> remote=new HashMap<>();
  try{
   JSONObject ref=request(a,"GET","/repos/"+full+"/git/ref/heads/"+BRANCH,null);
   parentSha=ref.getJSONObject("object").getString("sha");
   JSONObject commit=request(a,"GET","/repos/"+full+"/git/commits/"+parentSha,null);
   treeSha=commit.getJSONObject("tree").getString("sha");
   JSONObject tree=request(a,"GET","/repos/"+full+"/git/trees/"+treeSha+"?recursive=1",null);
   JSONArray arr=tree.optJSONArray("tree");
   if(arr!=null)for(int i=0;i<arr.length();i++){
    JSONObject e=arr.optJSONObject(i);
    if(e==null||!"blob".equals(e.optString("type")))continue;
    remote.put(e.optString("path"),e.optString("sha"));
   }
   if(progress!=null)progress.step("远端已有 "+remote.size()+" 个文件");
  }catch(Exception e){
   // 空仓库或还没初始 commit：parent 留空，走全新建树
   if(progress!=null)progress.step("远端仓库还是空的，走首次上传");
   parentSha=null;treeSha=null;
  }

  // ④ 算本地文件，只留真正变了的
  List<String> paths=new ArrayList<>();
  for(Iterator<String> it=files.keys();it.hasNext();)paths.add(it.next());
  Collections.sort(paths);
  if(paths.size()>PUSH_FILE_CAP)throw new Exception("项目有 "+paths.size()+" 个文件，超过单次上传上限 "+PUSH_FILE_CAP);

  JSONArray treeEntries=new JSONArray();
  JSONArray skipped=new JSONArray();
  int uploaded=0,unchanged=0,total=paths.size();
  for(int i=0;i<paths.size();i++){
   String path=paths.get(i);
   String content=files.optString(path,"");
   byte[] bytes=content.getBytes(StandardCharsets.UTF_8);
   if(bytes.length>FILE_CAP){
    skipped.put(new JSONObject().put("path",path).put("reason","超过 "+(FILE_CAP/1024)+" KB").put("bytes",bytes.length));
    continue;
   }
   if(!isText(bytes)){
    skipped.put(new JSONObject().put("path",path).put("reason","二进制文件"));
    continue;
   }
   String sha=blobSha(bytes);
   if(sha.equals(remote.get(path))){unchanged++;continue;}
   /*
    * 进度提示要节流。392 个文件逐个弹 toast 会把屏幕刷满，
    * 而且每一次都要跨线程投递到主线程 —— 只为显示一行马上就消失的字。
    * 只报开头几个和每 50 个一次就够了，用户要的是「它在动」，不是逐条流水账。
    */
   if(progress!=null&&(i<2||i%50==0))progress.step("上传 "+(i+1)+"/"+total);
   JSONObject blob=request(a,"POST","/repos/"+full+"/git/blobs",new JSONObject()
    .put("content",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP))
    .put("encoding","base64"));
   treeEntries.put(new JSONObject().put("path",path).put("mode","100644")
    .put("type","blob").put("sha",blob.getString("sha")));
   uploaded++;
  }

  /*
   * 远端有、本地已经没有的文件。
   *
   * 不自动删 —— 用户可能只是本地同步不全，自动删会丢东西。
   * 但必须报出来：否则他看到「上传成功 0 个、跳过 0 个」会以为两边一致了，
   * 实际远端还留着一堆早就删掉的文件。
   */
  JSONArray staleFiles=new JSONArray();
  if(!remote.isEmpty()){
   Set<String> localSet=new HashSet<>(paths);
   List<String> remoteKeys=new ArrayList<>(remote.keySet());
   Collections.sort(remoteKeys);
   for(String remotePath:remoteKeys)if(!localSet.contains(remotePath))staleFiles.put(remotePath);
  }

  if(treeEntries.length()==0&&created){
   // 新仓库 auto_init 已经有内容，本地又全都一样 —— 没什么可提交的
   return new JSONObject().put("ok",true).put("repo",full).put("htmlUrl","https://github.com/"+full)
    .put("created",true).put("uploaded",0).put("unchanged",unchanged).put("stale",staleFiles)
    .put("note","仓库已创建，本地文件与远端一致，没有需要提交的改动");
  }
  if(treeEntries.length()==0){
   return new JSONObject().put("ok",true).put("repo",full).put("htmlUrl","https://github.com/"+full)
    .put("uploaded",0).put("unchanged",unchanged).put("skipped",skipped).put("stale",staleFiles)
    .put("note","远端已经是最新的，没有需要提交的改动");
  }

  // ⑤ 建 tree（带 base_tree 才能只改变化的，其余保留）
  if(progress!=null)progress.step("建立目录树");
  JSONObject treeBody=new JSONObject().put("tree",treeEntries);
  if(treeSha!=null)treeBody.put("base_tree",treeSha);
  JSONObject newTree=request(a,"POST","/repos/"+full+"/git/trees",treeBody);

  // ⑥ 建 commit
  String msg=(message==null||message.trim().isEmpty())?"由 StepX Studio 更新":message.trim();
  JSONObject commitBody=new JSONObject().put("message",msg).put("tree",newTree.getString("sha"));
  if(parentSha!=null)commitBody.put("parents",new JSONArray().put(parentSha));
  JSONObject commit=request(a,"POST","/repos/"+full+"/git/commits",commitBody);

  // ⑦ 移动分支指针
  if(progress!=null)progress.step("更新分支 "+BRANCH);
  if(parentSha!=null){
   request(a,"PATCH","/repos/"+full+"/git/refs/heads/"+BRANCH,
    new JSONObject().put("sha",commit.getString("sha")).put("force",false));
  }else{
   request(a,"POST","/repos/"+full+"/git/refs",new JSONObject()
    .put("ref","refs/heads/"+BRANCH).put("sha",commit.getString("sha")));
  }

  return new JSONObject().put("ok",true).put("repo",full)
   .put("htmlUrl","https://github.com/"+full)
   .put("commit",commit.optString("sha")).put("commitUrl","https://github.com/"+full+"/commit/"+commit.optString("sha"))
   .put("created",created).put("uploaded",uploaded).put("unchanged",unchanged)
   .put("skipped",skipped).put("stale",staleFiles).put("totalFiles",total)
   .put("note",(skipped.length()>0?"已跳过 "+skipped.length()+" 个二进制或超大文件，它们没有进仓库；":"全部文本文件已同步；")
    +(staleFiles.length()>0?"远端另有 "+staleFiles.length()+" 个文件本地已不存在（未删除，需要的话手动清理）":"远端没有多余文件"));
 }

 /** 仓库名只允许字母数字点横线，空格换成短横线。GitHub 的规则比这严，这里做基本清洗。 */
 static String sanitizeRepo(String raw){
  String s=(raw==null?"":raw).trim().toLowerCase(java.util.Locale.ROOT);
  s=s.replaceAll("[^a-z0-9._-]+","-").replaceAll("-+","-").replaceAll("^[-.]+|[-.]+$","");
  if(s.isEmpty())s="stepx-project";
  return s.length()>90?s.substring(0,90):s;
 }

 /** 进度回调。在后台线程里被调用，实现方自己负责切主线程。 */
 interface Progress{void step(String message);}
}
