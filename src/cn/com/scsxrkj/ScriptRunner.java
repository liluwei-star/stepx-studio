package cn.com.scsxrkj;
import android.os.Handler;
import android.webkit.*;
import org.json.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

/**
 * 在设备上跑代码：单元测试、以及任意 JS 脚本。
 *
 * <p>为什么是 JS 沙箱而不是系统 shell：
 * 手机上一条 {@code rm -rf} 就能把用户的东西全删掉，而 AI 是会写错的 ——
 * 它可能自信地把 {@code rm -rf ./dist} 写成 {@code rm -rf ./dist /}。
 * 真正需要的「跑代码验证逻辑」用不着系统权限，
 * 一个没挂任何原生桥的 WebView 就够了：它能读写项目文件、能编译 TS，
 * 碰不到通讯录、相册、其他应用的数据。
 *
 * <p>这也是为什么沙箱里<b>没有</b> {@code addJavascriptInterface} ——
 * 测试代码和项目源码是同源的，给沙箱挂桥就等于给项目里的任何一行代码挂桥。
 *
 * <p>两个入口：
 * <ul>
 *   <li>{@link #runTests} —— 找 {@code *.test.ts} 之类的文件，打包后跑，收断言结果</li>
 *   <li>{@link #runScript} —— 跑一段任意 JS，收集 console 输出和返回值</li>
 * </ul>
 */
final class ScriptRunner {
 /** 测试的总时限。一个测试跑满 90 秒基本可以判定是死循环了。 */
 static final int TEST_TIMEOUT=90;
 /** 单段脚本的时限。 */
 static final int SCRIPT_TIMEOUT=45;
 /** 收集的 console 输出上限，防止一个 while 循环把内存打满。 */
 static final int OUTPUT_CAP=40000;

 private final MainActivity a;
 ScriptRunner(MainActivity a){this.a=a;}

 /**
  * 跑项目里的单元测试。
  *
  * @param project 项目快照
  * @return 结果：通过数、失败数、每个用例的详情、错误
  */
 JSONObject runTests(JSONObject project)throws Exception{
  if(project==null)throw new Exception("没有指定项目");
  JSONObject snapshot=new JSONObject(project.toString());
  CloudFiles.entries(snapshot);
  return withWebView("neo-test.invalid","/test-runner.html",snapshot,output->{
   try{
    /*
     * 这里的 output 已经是页面变量的内容本身（外层轮询已经解过一次 JSON 编码），
     * 所以直接构造，不能再 JSONTokener 一遍 ——
     * 再解一次拿到的是 JSONObject 而不是 String，会让人误以为"还没好"，
     * 然后一直轮询到超时。
     */
    JSONObject r=new JSONObject(output);
    // 把每个用例的详情整理成人能读的一段话，模型看文字比看嵌套 JSON 更省 token
    StringBuilder summary=new StringBuilder();
    int pass=0,fail=0;
    JSONArray suites=r.optJSONArray("suites");
    if(suites!=null)for(int i=0;i<suites.length();i++){
     JSONObject s=suites.optJSONObject(i);
     if(s==null)continue;
     JSONArray cases=s.optJSONArray("cases");
     if(cases==null)continue;
     for(int k=0;k<cases.length();k++){
      JSONObject c=cases.optJSONObject(k);
      if(c==null)continue;
      if(c.optBoolean("ok")){pass++;summary.append("✓ ").append(s.optString("name")).append(" › ").append(c.optString("name")).append('\n');}
      else{fail++;summary.append("✗ ").append(s.optString("name")).append(" › ").append(c.optString("name")).append("：").append(c.optString("error")).append('\n');}
     }
    }
    JSONArray errs=r.optJSONArray("errors");
    if(errs!=null)for(int i=0;i<errs.length();i++){
     JSONObject e=errs.optJSONObject(i);
     if(e==null)continue;
     summary.append("! ").append(e.optString("file","")).append('：').append(e.optString("error")).append('\n');
    }
    if(r.optInt("files",0)==0)summary.append(r.optString("note","项目里没有测试文件"));
    r.put("summary",summary.toString().trim());
    return r;
   }catch(Exception e){
    return new JSONObject().put("ok",false).put("error","测试结果解析失败："+e.getMessage()).put("raw",output);
   }
  },TEST_TIMEOUT,"window.__neoTest");
 }

 /**
  * 跑一段任意 JS。
  *
  * <p>约定：脚本可以直接写表达式，也可以写语句；最后如果设置了
  * {@code window.__neoResult}，那个值会被返回。
  * console.log/warn/error 的输出全部收集。
  *
  * @param code    要执行的 JS
  * @param project 项目快照（脚本里可用 {@code await fetch('/project.json')} 读到）
  */
 JSONObject runScript(String code,JSONObject project)throws Exception{
  String src=code==null?"":code;
  if(src.trim().isEmpty())throw new Exception("脚本内容不能为空");
  if(src.length()>400000)throw new Exception("脚本太长（"+src.length()+" 字符），上限 400000");

  JSONObject snapshot=project==null?null:new JSONObject(project.toString());
  if(snapshot!=null)CloudFiles.entries(snapshot);

  /*
   * 包一层：把结果和错误都写进 window.__neoRun，顺便接住 console 输出。
   * 用 async IIFE 是为了支持 top-level await —— 脚本里等一个 Promise 很常见。
   */
  /*
   * 关键设计：用 new Function 执行用户代码，而不是把它拼进外层脚本。
   *
   * 拼进去的话，用户代码里任何一处语法错误都会让整个外层脚本解析失败 ——
   * evaluateJavascript 静默失败，window.__neoRun 永远不会被设置，
   * 调用方只能看到「超时」，完全不知道真正的原因是第 3 行少了个括号。
   *
   * 换成 new Function 之后，语法错误在调用时才抛出，能被 catch 住，
   * 而且错误信息里带着行号。
   */
  String quoted=JSONObject.quote(src);
  String wrapper=
   "(function(){\n"
   +"window.__neoRun={ok:false,error:'脚本没有跑完（可能是卡住了）',log:[]};\n"
   +"var logs=[];\n"
   +"var original={};\n"
   +"['log','info','warn','error'].forEach(function(k){\n"
   +"  original[k]=console[k];\n"
   +"  console[k]=function(){\n"
   +"    try{\n"
   +"      var parts=[];for(var i=0;i<arguments.length;i++){var x=arguments[i];try{parts.push(typeof x==='string'?x:JSON.stringify(x));}catch(e){parts.push(String(x));}}\n"
   +"      logs.push(k+': '+parts.join(' '));\n"
   +"      if(logs.length>2000){logs.length=0;logs.push('（输出过多，已清空）');}\n"
   +"    }catch(e){}\n"
   +"    try{original[k].apply(console,arguments);}catch(e){}\n"
   +"  };\n"
   +"});\n"
   +"function finish(ok,value,error){\n"
   +"  window.__neoRun={ok:ok,result:value,error:error,log:logs};\n"
   +"}\n"
   +"try{\n"
   +"  var fn=new Function("+quoted+");\n"
   +"  var value=fn();\n"
   +"  if(value&&typeof value.then==='function'){\n"
   +"    value.then(function(v){finish(true,window.__neoResult!==undefined?window.__neoResult:(v===undefined?null:v),null);},\n"
   +"               function(e){finish(false,null,String((e&&e.stack)||(e&&e.message)||e));});\n"
   +"  }else{\n"
   +"    finish(true,window.__neoResult!==undefined?window.__neoResult:(value===undefined?null:value),null);\n"
   +"  }\n"
   +"}catch(e){\n"
   +"  finish(false,null,String((e&&e.stack)||(e&&e.message)||e));\n"
   +"}\n"
   +"})();\n";

  JSONObject result=withWebView("neo-sandbox.invalid","/sandbox.html",snapshot,output->{
   try{
    // 同上：output 已经是 __neoRun 的内容，不要再解析一层
    JSONObject r=new JSONObject(output);
    // console 输出太多时截断，别把模型灌死
    JSONArray log=r.optJSONArray("log");
    if(log!=null&&log.length()>200){
     JSONArray cut=new JSONArray();
     for(int i=0;i<100;i++)cut.put(log.get(i));
     cut.put("…（共 "+log.length()+" 条，中间省略）…");
     for(int i=log.length()-50;i<log.length();i++)cut.put(log.get(i));
     r.put("log",cut);
    }
    return r;
   }catch(Exception e){
    return new JSONObject().put("ok",false).put("error","输出解析失败："+e.getMessage()).put("raw",output);
   }
  },SCRIPT_TIMEOUT,null,wrapper);

  return result;
 }

 /**
  * 建一个隔离 WebView，加载指定页面，交出页面上的一个变量。
  *
  * <p>和 {@link LocalCompiler} 用的是同一套模式：拦截请求、从 assets 喂文件、
  * 轮询结果。区别是这里可以带一段预注入的脚本（{@code preInject}），
  * 在页面脚本跑起来之前或之后执行。
  *
  * @param host      虚拟域名，请求只认这个 host，其余一律拒绝
  * @param path      页面路径
  * @param snapshot  项目快照，页面里 {@code fetch('/project.json')} 能拿到
  * @param extractor 把轮询到的原始 JSON 字符串转换成结果；返回 null 表示"还没好"
  * @param timeoutS  时限（秒）
  * @param prop      轮询哪个变量；传 {@code null} 表示直接把 preInject 当表达式求值
  */
 JSONObject withWebView(String host,String path,JSONObject snapshot,
                        Extract extractor,int timeoutS,String prop)throws Exception{
  return withWebView(host,path,snapshot,extractor,timeoutS,prop,null);
 }

 JSONObject withWebView(String host,String path,JSONObject snapshot,
                        Extract extractor,int timeoutS,String prop,String preInject)throws Exception{
  CountDownLatch done=new CountDownLatch(1);
  JSONObject[] result={null};
  String[] failure={null};
  WebView[] view={null};
  Handler handler=new Handler(a.getMainLooper());
  String projectJson=snapshot==null?"{}":snapshot.toString();

  a.runOnUiThread(()->{
   try{
    WebView w=new WebView(a);
    view[0]=w;
    WebSettings s=w.getSettings();
    s.setJavaScriptEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setBlockNetworkLoads(true);      // 沙箱不许联网，所有请求都被拦截
    s.setDomStorageEnabled(false);
    final boolean[] pageReady={false};
    w.setWebViewClient(new WebViewClient(){
     @Override public void onPageFinished(WebView v,String url){pageReady[0]=true;if(a.debug)android.util.Log.i("NeoSandbox","page finished "+url);}
     @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){
      if(a.debug)android.util.Log.i("NeoSandbox","load error "+r.getUrl()+" code="+e.getErrorCode());
     }
     @Override public void onPageStarted(WebView v,String url,android.graphics.Bitmap icon){
      if(a.debug)android.util.Log.i("NeoSandbox","page started "+url);
     }
     @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){
      try{
       if(!host.equals(r.getUrl().getHost()))return LocalRunner.blocked();
       String p=r.getUrl().getPath();
       if(p==null)p="/";
       if(p.startsWith("/"))p=p.substring(1);
       if(p.equals("project.json"))return LocalRunner.response("application/json",projectJson.getBytes(StandardCharsets.UTF_8));
       if(p.startsWith("local-vendor/")){
        String inner=p.substring("local-vendor/".length());
        if(inner.contains(".."))return LocalRunner.blocked();
        return new WebResourceResponse(LocalRunner.mime(inner),"UTF-8",a.getAssets().open("local-vendor/"+inner));
       }
       if(!p.isEmpty()&&!p.contains("..")&&(p.endsWith(".js")||p.endsWith(".html"))){
        try{return new WebResourceResponse(LocalRunner.mime(p),"UTF-8",a.getAssets().open(p));}
        catch(Exception openFailed){return LocalRunner.blocked();}
       }
       return LocalRunner.blocked();
      }catch(Exception e){return LocalRunner.blocked();}
     }
    });
    w.loadUrl("https://"+host+path);
    long deadline=System.currentTimeMillis()+(long)timeoutS*1000;
    final String pollExpr;
    if(preInject!=null){
     // 预注入模式：页面加载后先把脚本塞进去
     pollExpr="JSON.stringify(window.__neoRun||null)";
    }else{
     pollExpr="JSON.stringify("+prop+"||null)";
    }
    final boolean[] injected={false};final int[] polls={0};
    Runnable poll=new Runnable(){
     public void run(){
      if(done.getCount()==0)return;
      if(System.currentTimeMillis()>deadline){
       failure[0]="超时（"+timeoutS+" 秒）：代码可能陷入了死循环";
       done.countDown();
       return;
      }
      final Runnable self=this;
      if(preInject!=null&&!injected[0]){
       /*
        * 必须等 onPageFinished 才注入。
        * 之前是在第一次轮询（300ms）时就塞脚本，那时页面可能还没加载完，
        * 注入的脚本会被随后的导航清掉 —— 表现是「一直超时，什么也没跑」。
        */
       if(!pageReady[0]){handler.postDelayed(self,200);return;}
       injected[0]=true;
       if(a.debug)android.util.Log.i("NeoSandbox","injecting script, len="+preInject.length());
       w.evaluateJavascript(preInject,v->{if(a.debug)android.util.Log.i("NeoSandbox","inject callback="+v);});
      }
      w.evaluateJavascript(pollExpr,raw->{
       polls[0]++;
       if(a.debug&&(polls[0]<4||polls[0]%20==0))android.util.Log.i("NeoSandbox","poll#"+polls[0]+" raw="+(raw==null?"null":(raw.length()>160?raw.substring(0,160):raw)));
       try{
        Object decoded=new JSONTokener(raw).nextValue();
        if(a.debug&&polls[0]<=2)android.util.Log.i("NeoSandbox","decoded type="+(decoded==null?"null":decoded.getClass().getName())
         +" isString="+(decoded instanceof String)+(decoded instanceof String?(" len="+((String)decoded).length()):""));
        if(decoded instanceof String&&!decoded.equals("null")){
         JSONObject got=extractor.convert((String)decoded);
         if(got!=null){result[0]=got;done.countDown();return;}
        }
       }catch(Exception e){
        // 这里吞异常会让「结果解析失败」表现成「超时」，必须留下痕迹
        if(a.debug)android.util.Log.i("NeoSandbox","poll parse failed: "+e+" raw="+(raw==null?"null":raw));
       }
       handler.postDelayed(self,300);
      });
     }
    };
    handler.postDelayed(poll,preInject!=null?900:300);
   }catch(Exception e){
    failure[0]=String.valueOf(e.getMessage());
    done.countDown();
   }
  });

  try{
   if(!done.await(timeoutS+8,TimeUnit.SECONDS)||result[0]==null){
    throw new Exception(failure[0]!=null?failure[0]:"执行超时，没有拿到结果");
   }
   return result[0];
  }finally{
   done.countDown();
   a.runOnUiThread(()->{if(view[0]!=null){view[0].stopLoading();view[0].destroy();}});
  }
 }

 /** 把轮询到的原始 JSON 字符串转成结果对象；返回 null 表示"还没好，继续等"。 */
 interface Extract{JSONObject convert(String raw)throws Exception;}
}
