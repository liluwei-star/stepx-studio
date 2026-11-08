package cn.com.scsxrkj;
import android.webkit.*;
import android.os.Handler;
import org.json.*;
import java.util.concurrent.*;
import java.nio.charset.StandardCharsets;
/**
 * 项目编译：把 TSX / React / TypeScript 源码转成浏览器能跑的 JS。
 *
 * <p>用的是打包在 APK 里的 esbuild（WebAssembly 版），所以不需要联网也不需要装 Node。
 * 编译失败会把具体错误行报给用户，不会静默生成一个坏包。
 */
final class LocalCompiler {
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
   return out;
  }catch(Exception e){return new JSONObject().put("ok",false).put("error",e.getMessage());}
 }
}
