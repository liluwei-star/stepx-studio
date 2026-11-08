package cn.com.scsxrkj;

import android.app.Dialog;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Handler;
import android.view.WindowInsets;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * 在手机本地运行项目，实时看效果。
 *
 * <p>先编译，再把编译产物塞进一个隔离的 WebView 里渲染。
 * <b>这个 WebView 没有挂任何 JS 桥</b>，所以页面拿不到任何原生能力，
 * 跑别人的代码也不会出事。控制台报错会显示在界面上，方便调试。
 */
final class LocalRunner {
 final MainActivity a; final JSONObject project; final Handler handler=new Handler();
 final Map<String,byte[]> files=new java.util.concurrent.ConcurrentHashMap<>();
 Dialog dialog; WebView compiler,view; LinearLayout box; TextView status; boolean closed,online,ready; String detail="";
 String host,projectId; long deadline;final JSONArray events=new JSONArray();
 synchronized JSONObject report()throws Exception{return new JSONObject().put("ready",ready).put("closed",closed).put("events",new JSONArray(events.toString()));}
 synchronized void record(String kind,String message){try{if(events.length()>=100)events.remove(0);events.put(new JSONObject().put("kind",kind).put("message",message).put("time",System.currentTimeMillis()));}catch(Exception ignored){}}
 LocalRunner(MainActivity activity,JSONObject source)throws Exception{
  a=activity;projectId=source.getString("id");project=new JSONObject().put("files",new JSONObject(source.getJSONObject("files").toString())).put("binaryFiles",source.optJSONObject("binaryFiles")==null?new JSONObject():new JSONObject(source.getJSONObject("binaryFiles").toString()));
  // 大文件的哈希索引必须一起带过来。
  // 不带的话 CloudFiles.entries() 校验 .bin 引用时找不到 sha256，
  // 直接抛「大文件缺少哈希」，整个构造失败 ——
  // 表现是点「本地运行」毫无反应，连报错都看不到。
  if(source.optJSONObject("bigHashes")!=null)project.put("bigHashes",new JSONObject(source.getJSONObject("bigHashes").toString()));
  CloudFiles.entries(project);
  host="p"+CloudFiles.hash(source.getString("id").getBytes(StandardCharsets.UTF_8)).substring(0,24)+".neo-preview.invalid";
 }
 /**
  * 判断这个项目是不是「已经编译好的静态产物」。
  *
  * <p>为什么要分：本机编译器（local-runner.html）是给源码工程用的 ——
  * 它要把 TSX/模块打包成一个 HTML。但对于已经在 PC 上跑过 npm run build
  * 的项目，产物本身就是 .js，再编译一遍不但没必要，还会撞上
  * 「编译结果超过 16MB」的上限（这个大项目的产物有 88MB）。
  *
  * <p>判据很简单：入口 HTML 里有没有引用 src/ 下的 .ts/.tsx/.jsx。
  * 有就是源码工程，得编译；没有就是产物，直接跑。
  */
 boolean isStaticBuild(){
  try{
   JSONObject f=project.optJSONObject("files");
   if(f==null)return false;
   String html=f.optString("index.html","");
   if(html.isEmpty())return false;
   return !java.util.regex.Pattern.compile("(?is)[\"'](?:\\./|/)?src/[^\"']*\\.(?:tsx?|jsx?)['\"]").matcher(html).find();
  }catch(Exception e){return false;}
 }

 void start(){
  dialog=new Dialog(a,android.R.style.Theme_Material_Light_NoActionBar);box=new LinearLayout(a);box.setOrientation(1);box.setBackgroundColor(a.BG);
  LinearLayout bar=new LinearLayout(a);bar.addView(a.button("关闭","关闭本地运行",()->dialog.dismiss()));
  bar.addView(a.button("重载","重新运行当前快照",()->{if(view!=null)view.reload();}));
  Switch network=new Switch(a);network.setText("联网");network.setTextColor(a.INK);network.setOnCheckedChangeListener((b,on)->{online=on;if(ready)status.setText("本地运行 · "+(on?"联网":"离线")+" · 点此查看说明");if(view!=null){view.getSettings().setBlockNetworkLoads(!on);view.reload();} });bar.addView(network);
  box.addView(bar);status=new TextView(a);status.setTextColor(a.INK);status.setTextSize(12);status.setPadding(12,4,12,4);status.setText("正在 Neo 本机编译… 首次运行可能需要数秒");status.setOnClickListener(v->{if(ready)new android.app.AlertDialog.Builder(a).setTitle("本地运行").setMessage(detail+"\n\n项目在 Neo 本机编译和执行。联网开关只开放 HTTPS 请求；系统权限、Step 原生桥接和服务端功能不在此预览中提供。").setPositiveButton("知道了",null).show();});box.addView(status);
  compiler=new WebView(a);compiler.getSettings().setJavaScriptEnabled(true);compiler.getSettings().setAllowFileAccess(false);compiler.getSettings().setAllowContentAccess(false);compiler.getSettings().setBlockNetworkLoads(true);
  compiler.setWebViewClient(new WebViewClient(){@Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){String path=r.getUrl().getPath();if(!r.getUrl().getHost().equals("neo-compiler.invalid"))return blocked();try{if(path.equals("/project.json"))return response("application/json",project.toString().getBytes(StandardCharsets.UTF_8));return asset(path.substring(1));}catch(Exception e){return blocked();}}@Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return true;}});
  box.addView(compiler,new LinearLayout.LayoutParams(1,1));dialog.setContentView(box);dialog.setOnDismissListener(d->{closed=true;handler.removeCallbacksAndMessages(null);if(compiler!=null){compiler.stopLoading();compiler.destroy();compiler=null;}if(view!=null){view.stopLoading();view.destroy();view=null;}files.clear();});
  dialog.show();
  // 对话框也铺满全屏。API 30 起才有 setDecorFitsSystemWindows，
  // 低版本用旧的 systemUiVisibility 标志达到同样效果。
  dialog.getWindow().setLayout(-1,-1);
  if(android.os.Build.VERSION.SDK_INT>=30){
   dialog.getWindow().setDecorFitsSystemWindows(false);
   android.view.WindowInsetsController c=dialog.getWindow().getInsetsController();
   if(c!=null)c.setSystemBarsAppearance(0,24);
  }else{
   dialog.getWindow().getDecorView().setSystemUiVisibility(
     android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
     |android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
     |android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
  }dialog.getWindow().setLayout(-1,-1);dialog.getWindow().setDecorFitsSystemWindows(false);dialog.getWindow().getInsetsController().setSystemBarsAppearance(0,android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);box.setOnApplyWindowInsetsListener((v,in)->{Insets i=in.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());box.setPadding(i.left,i.top,i.right,i.bottom);return in;});box.requestApplyInsets();
  // 静态产物直接跑，不用过本机编译器。
  // 编译器那条路会把结果内联成一个 HTML，上限 16MB；
  // 这个项目的产物是 88MB 的独立文件，硬塞进去必然失败。
  if(isStaticBuild()){
   status.setText("正在加载产物…");
   show("这是已经构建好的产物，直接加载，不再走本机编译。");
   return;
  }
  deadline=System.currentTimeMillis()+90000;compiler.loadUrl("https://neo-compiler.invalid/local-runner.html");handler.postDelayed(this::poll,250);
 }
 void poll(){if(closed||compiler==null)return;if(System.currentTimeMillis()>deadline){status.setText("本机编译超时，请关闭后重试或缩小工程。");compiler.stopLoading();return;}compiler.evaluateJavascript("JSON.stringify(window.__neoBuild||null)",raw->{if(closed)return;try{Object parsed=new JSONTokener(raw).nextValue();if(parsed instanceof String&&!parsed.equals("null")){JSONObject result=new JSONObject((String)parsed);if(result.has("error")){record("compile_error",result.getString("error"));status.setText("本机编译失败："+result.getString("error"));return;}if(result.has("files")){JSONObject out=result.getJSONObject("files");long size=0;for(Iterator<String>i=out.keys();i.hasNext();){String n=i.next();if(!CloudFiles.path(n))throw new Exception("非法输出路径");byte[]b=CloudFiles.bytes(out.getJSONObject(n));size+=b.length;if(size>16777216)throw new Exception("编译结果超过16MB");files.put(n,b);}show(result.optString("note"));return;}}handler.postDelayed(this::poll,250);}catch(Exception e){status.setText("本机编译失败："+e.getMessage());}});}
 void show(String note){
  // 静态产物模式没有编译器视图，这里要判空
  if(compiler!=null){box.removeView(compiler);compiler.destroy();compiler=null;}
  ready=true;detail=note;record("compiled",note);status.setText("本地运行 · "+(online?"联网":"离线")+" · 点此查看说明");view=new WebView(a);WebSettings s=view.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setBlockNetworkLoads(!online);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setMediaPlaybackRequiresUserGesture(true);
  CookieManager.getInstance().setAcceptThirdPartyCookies(view,false);
  view.setWebViewClient(new WebViewClient(){@Override public WebResourceResponse shouldInterceptRequest(WebView w,WebResourceRequest r){Uri u=r.getUrl();if(host.equals(u.getHost())){String path=u.getPath();try{if(path.startsWith("/__vendor/"))return asset("local-vendor/"+path.substring(10));String n=path.substring(1);if(n.isEmpty())n="index.html";byte[]b=files.get(n);if(b==null)b=files.get("public/"+n);if(b!=null)return response(mime(n),b);
      // 编译结果里没有，就从项目文件本身取。
      // 静态产物模式下 files 是空的（没过编译器），所有资源都得走这里 ——
      // 包括 88MB 的模型分片，所以必须流式返回，不能整块读进内存。
      WebResourceResponse direct=projectFile(n);if(direct!=null)return direct;
      return blocked();}catch(Exception e){return blocked();}}return online&&"https".equals(u.getScheme())?null:blocked();}@Override public boolean shouldOverrideUrlLoading(WebView w,WebResourceRequest r){return !host.equals(r.getUrl().getHost());}});
  view.setWebChromeClient(new WebChromeClient(){@Override public boolean onConsoleMessage(ConsoleMessage m){record(m.messageLevel().toString(),m.message()+" ("+m.lineNumber()+")");if(m.messageLevel()==ConsoleMessage.MessageLevel.ERROR)status.setText("运行错误："+m.message()+"（"+m.lineNumber()+"）");return true;}@Override public void onPermissionRequest(PermissionRequest r){
   // 录音类应用要麦克风。只放行音频采集，摄像头、地理等其他能力一律拒绝 ——
   // 预览页跑的是项目代码，不该随便拿到设备能力。
   for(String res:r.getResources()){
    if(PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)){r.grant(new String[]{res});return;}
   }
   r.deny();
  }});
  box.addView(view,new LinearLayout.LayoutParams(-1,0,1));view.loadUrl("https://"+host+"/index.html");
 }
 /**
  * 直接从项目文件里取一个资源给 WebView。
  *
  * <p>三种存法分别处理：
  * <ul>
  *   <li>文本文件 —— 在 {@code files} 里，转成字节返回</li>
  *   <li>小二进制 —— 在 {@code binaryFiles} 里存 base64，解码后返回</li>
  *   <li>大文件 —— 存的是 {@code .bin} 引用，内容在 project-files 目录，
  *       用文件流直接递给 WebView，不读进内存</li>
  * </ul>
  *
  * <p>为什么大文件必须流式：语音识别模型 19 个分片加起来 80MB，
  * 一次性读进 byte[] 会让应用直接被系统杀掉。
  *
  * @param n 请求路径（不含开头的斜杠）
  * @return 能用的响应；找不到返回 null
  */
 WebResourceResponse projectFile(String n){
  try{
   JSONObject f=project.optJSONObject("files");
   JSONObject bins=project.optJSONObject("binaryFiles");
   /*
    * 请求路径 → 项目路径。候选不止一个，因为项目里的目录结构和运行时不一样：
    *
    *   运行时按 {页面根}/models/... 找识别模型，项目里却在
    *   dist/client/web/asr/models/...（平台的部署结构，多一层 asr/）。
    *
    * 平台原站点跑在 /aiapp/web/ 下，所以它把 asr/ 作为一层目录；
    * 我们的 App 直接跑在根上，这一层就得让开。
    */
   String[] cands={
     n,
     "public/"+n,
     "public/asr/"+n,
     "dist/client/web/asr/"+n,
     "dist/client/web/"+n
   };
   String key=null;
   for(String c:cands){
    if((f!=null&&f.has(c))||(bins!=null&&bins.has(c))){key=c;break;}
   }
   if(key==null)return null;
   if(f!=null&&f.has(key)){
    return response(mime(key),f.getString(key).getBytes(StandardCharsets.UTF_8));
   }
   if(bins==null)return null;
   String bkey=key;
   String ref=bins.getString(bkey);
   if(ref.endsWith(".bin")){
    File file=new File(new File(a.getFilesDir(),"project-files"),ref);
    if(!file.isFile())return null;
    java.io.FileInputStream in=new java.io.FileInputStream(file);
    return new WebResourceResponse(mime(bkey),"UTF-8",200,"OK",
      Collections.singletonMap("Cache-Control","no-store"),in);
   }
   byte[] raw=android.util.Base64.decode(ref,android.util.Base64.DEFAULT);
   return response(mime(bkey),raw);
  }catch(Exception e){return null;}
 }

 WebResourceResponse asset(String path)throws Exception{if(!CloudFiles.path(path))return blocked();return new WebResourceResponse(mime(path),"UTF-8",a.getAssets().open(path));}
 static WebResourceResponse response(String type,byte[]b){return new WebResourceResponse(type,"UTF-8",200,"OK",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(b));}
 static WebResourceResponse blocked(){return new WebResourceResponse("text/plain","UTF-8",404,"Unavailable",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
 static String mime(String n){n=n.toLowerCase(Locale.ROOT);if(n.endsWith("html"))return "text/html";if(n.endsWith("js")||n.endsWith("mjs"))return "text/javascript";if(n.endsWith("css"))return "text/css";if(n.endsWith("wasm"))return "application/wasm";if(n.endsWith("json"))return "application/json";if(n.endsWith("svg"))return "image/svg+xml";if(n.endsWith("png"))return "image/png";if(n.endsWith("jpg")||n.endsWith("jpeg"))return "image/jpeg";if(n.endsWith("webp"))return "image/webp";if(n.endsWith("woff2"))return "font/woff2";if(n.endsWith("mp3"))return "audio/mpeg";if(n.endsWith("mp4"))return "video/mp4";return "application/octet-stream";}
}
