package cn.com.scsxrkj;
import android.webkit.*;
import android.os.Handler;
import org.json.*;
import java.util.Map;
import java.util.concurrent.*;
import java.nio.charset.StandardCharsets;
/**
 * 项目编译：把 TSX / React / TypeScript 源码转成浏览器能跑的 JS。
 *
 * <p>用的是打包在 APK 里的 esbuild（WebAssembly 版），所以不需要联网也不需要装 Node。
 * 编译失败会把具体错误行报给用户，不会静默生成一个坏包。
 */
final class LocalCompiler {
 /*
  * 编译结果缓存。
  *
  * <p><b>为什么需要：</b>编译要起一个 WebView 跑 esbuild 的 WASM，
  * 一个项目几秒到几十秒。模型在工具循环里很容易连着调好几次
  * check_project —— 有时是改了文件想确认，有时只是没想好下一步。
  * 文件一个字没改还去重编一遍，纯属浪费；用户那边表现为「AI 卡住不动」。
  *
  * <p>键是文件表的内容指纹，所以只要改了任何一个字节（哪怕只改了一个空格）
  * 缓存就失效，重新编译 —— 绝不会拿旧结果糊弄。
  *
  * <p>只留最近几份，且每份只存结论（错误和警告），不存编译产物：
  * 产物是整套 JS，留着占内存。
  */
 private static final int CACHE_CAP=8;
 private static final java.util.LinkedHashMap<String,JSONObject> CACHE=new java.util.LinkedHashMap<String,JSONObject>(16,0.75f,true){
  protected boolean removeEldestEntry(Map.Entry<String,JSONObject> eldest){return size()>CACHE_CAP;}
 };
 /** 缓存命中次数，用来在结果里告诉模型「这次没重新编译」。 */
 private static int cacheHits=0;

 /**
  * 算出文件表的内容指纹。
  *
  * <p>用每个文件的路径 + 长度 + 内容一起算。路径和长度先筛掉绝大多数不相关文件，
  * 真正比对的还是内容，所以不会出现「只改了内容但长度没变就命中旧缓存」。
  */
 static String fingerprint(JSONObject files){
  if(files==null)return "";
  StringBuilder sb=new StringBuilder();
  java.util.List<String> names=new java.util.ArrayList<>();
  java.util.Iterator<String> it=files.keys();
  while(it.hasNext())names.add(it.next());
  java.util.Collections.sort(names);
  for(String n:names){
   Object v=files.opt(n);
   sb.append(n).append('\u0001');
   if(v instanceof String){
    String s=(String)v;
    sb.append(s.length()).append('\u0001').append(s).append('\u0002');
   }else{
    sb.append("null").append('\u0002');
   }
  }
  return Integer.toHexString(sb.toString().hashCode())+"-"+sb.length();
 }
 static JSONObject compile(MainActivity a,JSONObject project)throws Exception{
  JSONObject snapshot=new JSONObject(project.toString());CloudFiles.entries(snapshot);CountDownLatch done=new CountDownLatch(1);JSONObject[] result={null};WebView[] view={null};Handler handler=new Handler(a.getMainLooper());
  a.runOnUiThread(()->{try{WebView w=new WebView(a);view[0]=w;w.getSettings().setJavaScriptEnabled(true);w.getSettings().setAllowFileAccess(false);w.getSettings().setAllowContentAccess(false);w.getSettings().setBlockNetworkLoads(true);w.setWebViewClient(new WebViewClient(){@Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){try{if(!"neo-compiler.invalid".equals(r.getUrl().getHost()))return LocalRunner.blocked();String path=r.getUrl().getPath().substring(1);if(path.equals("project.json"))return LocalRunner.response("application/json",snapshot.toString().getBytes(StandardCharsets.UTF_8));if(!CloudFiles.path(path))return LocalRunner.blocked();return new WebResourceResponse(LocalRunner.mime(path),"UTF-8",a.getAssets().open(path));}catch(Exception e){return LocalRunner.blocked();}}});w.loadUrl("https://neo-compiler.invalid/local-runner.html");long deadline=System.currentTimeMillis()+60000;Runnable poll=new Runnable(){public void run(){if(done.getCount()==0)return;if(System.currentTimeMillis()>deadline){done.countDown();return;}w.evaluateJavascript("JSON.stringify(window.__neoBuild||null)",raw->{try{Object decoded=new JSONTokener(raw).nextValue();if(decoded instanceof String&&!decoded.equals("null")){result[0]=new JSONObject((String)decoded);done.countDown();return;}}catch(Exception ignored){}handler.postDelayed(this,200);});}};handler.postDelayed(poll,200);}catch(Exception e){done.countDown();}});
  try{if(!done.await(65,TimeUnit.SECONDS)||result[0]==null)throw new Exception("本地编译超时");JSONObject r=result[0];if(r.has("error"))throw new Exception(r.getString("error"));return r;}finally{done.countDown();a.runOnUiThread(()->{if(view[0]!=null){view[0].stopLoading();view[0].destroy();}});}
 }
 /**
  * 判断一条编译警告是不是「真的坏了」。
  *
  * <p><b>为什么要分类：</b>编译能过，不代表项目是好的。
  * 有几类警告意味着功能是残的 —— 比如「源码适配失败」，
  * 那个文件里的录音/选文件调用会直接报错；
  * 「tsconfig 使用默认 @/ → src/」意味着 import 指向了错的文件。
  *
  * <p>但也有几类只是环境限制 —— 「外部资源需手动开启联网」、
  * 「未执行 Vite 插件」，本机编译环境本来就跑不了这些，
  * 不该说成失败，否则模型会为一个改不了的问题反复重试。
  *
  * <p>所以分开：致命的那几类让 ok=false，环境限制只当提示。
  * 混在一起全当失败，等于让 AGENT 陷进死循环；
  * 全当成功，等于把坏掉的代码当成好的交给用户。
  */
 static boolean isFatalWarning(String w){
  if(w==null)return false;
  return w.startsWith("源码适配失败")
   ||w.startsWith("tsconfig")
   ||w.startsWith("路径别名")
   ||w.startsWith("编译失败")
   ||w.startsWith("样式处理失败");
 }

 static JSONObject check(MainActivity a,JSONObject project)throws Exception{
  try{
   /*
    * 先看缓存。
    *
    * <p>文件内容一个字没改，就直接复用上次的结论 ——
    * 省掉一次 WebView + esbuild（几秒到几十秒）。
    */
   String key=fingerprint(project==null?null:project.optJSONObject("files"));
   JSONObject cached;
   synchronized(CACHE){
    cached=CACHE.get(key);
   }
   if(cached!=null){
    cacheHits++;
    JSONObject out=new JSONObject(cached.toString());
    out.put("cached",true).put("cacheHits",cacheHits)
     .put("note",out.optString("note","")+"（本次沿用上次的编译结果：文件内容自上次编译以来没有变化）");
    return out;
   }
   JSONObject r=compile(a,project);
   JSONArray all=r.optJSONArray("warnings");
   JSONArray fatal=new JSONArray(),hints=new JSONArray();
   if(all!=null)for(int i=0;i<all.length();i++){
    String w=all.optString(i,"");
    if(w.isEmpty())continue;
    if(isFatalWarning(w))fatal.put(w);else hints.put(w);
   }
   JSONObject out=new JSONObject()
    .put("ok",fatal.length()==0)
    .put("outputFiles",r.getJSONObject("files").length())
    .put("note",r.optString("note"))
    .put("warnings",all==null?new JSONArray():all)
    .put("fatalWarnings",fatal)
    .put("hints",hints)
    .put("scope","本机源码编译检查；实际交互仍需运行验证");
   /*
    * 有致命警告时，error 字段要说清「哪里坏了」，模型才知道要改什么。
    * 只说「编译失败」它无从下手。
    */
   if(fatal.length()>0){
    StringBuilder sb=new StringBuilder();
    for(int i=0;i<fatal.length();i++){
     if(i>0)sb.append("；");
     sb.append(fatal.optString(i,""));
    }
    out.put("error","编译完成但有必须修的问题："+sb);
   }
   /*
    * 存缓存：只留结论，不留编译产物。
    *
    * <p>编译产物是整套转译后的 JS，可能几百 KB；
    * 留 8 份就是几 MB —— 而这个 App 之前就是被内存吃撑过。
    */
   synchronized(CACHE){
    CACHE.put(key,new JSONObject().put("ok",out.optBoolean("ok",false))
     .put("outputFiles",out.optInt("outputFiles",0))
     .put("note",out.optString("note",""))
     .put("warnings",out.optJSONArray("warnings")==null?new JSONArray():out.optJSONArray("warnings"))
     .put("fatalWarnings",out.optJSONArray("fatalWarnings")==null?new JSONArray():out.optJSONArray("fatalWarnings"))
     .put("hints",out.optJSONArray("hints")==null?new JSONArray():out.optJSONArray("hints"))
     .put("scope",out.optString("scope","")));
   }
   out.put("cached",false);
   return out;
  }catch(Exception e){return new JSONObject().put("ok",false).put("error",e.getMessage());}
 }
}
