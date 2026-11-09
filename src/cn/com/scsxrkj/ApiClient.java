package cn.com.scsxrkj;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

/**
 * 云端 AI 接口的 HTTP 客户端，负责一次完整的「提问—流式收答案」。
 *
 * <p>做的事：
 * <ul>
 *   <li>把统一格式的对话转成各服务商要的请求体（OpenAI / Anthropic / DeepSeek 等）</li>
 *   <li>用 SSE 边收边解析，让界面能实时看到文字一个个冒出来</li>
 *   <li>累计这次请求消耗了多少 Token，按服务商返回的分段记进 usageSegments</li>
 *   <li>支持随时取消：cancelled 置 true 后连接会被主动断开</li>
 * </ul>
 *
 * <p>密钥只在这个类里用一次就丢，不会存进任何状态对象，也不会写进日志。
 */
class ApiClient {
 interface Progress {void update(String text,String reasoning);}
 Progress progress;final JSONArray usageSegments=new JSONArray();
 /**
  * 本次请求是否已经把内容交给过前端。
  *
  * <p>重试的唯一安全前提是「用户什么都没看见」：请求根本没生效、
  * 或者刚开始就断了。一旦正文已经吐到屏幕上，再重发就是
  * 把同一段话再说一遍 —— 用户看到的不是恢复，是重影。
  *
  * <p>更糟的是它掩盖了真实原因：用户以为「网络重试了一下」，
  * 实际上模型已经生成了一半、服务端也计了费，
  * 而这一轮最后还可能因为重试次数用尽而报错，让人完全对不上。
  *
  * <p>所以只要 {@code delivered} 为真，任何 IOException 都直接抛出。
  */
 volatile boolean delivered;
 volatile HttpURLConnection connection;volatile boolean cancelled;
 static String endpoint(String raw,String protocol,boolean debug)throws Exception{
  URI u=new URI(raw.trim());boolean local=debug&&"http".equals(u.getScheme())&&"127.0.0.1".equals(u.getHost());
  if((!"https".equals(u.getScheme())&&!local)||u.getHost()==null||u.getRawUserInfo()!=null||u.getRawQuery()!=null||u.getRawFragment()!=null)throw new Exception("接口必须是无参数、无用户名的 HTTPS 地址");
  String s=raw.trim().replaceAll("/+$","");String suffix=protocol.equals("anthropic")?"/messages":"/chat/completions";
  return s.endsWith(suffix)?s:s+suffix;
 }
 static JSONArray models(JSONObject p,String secret,boolean debug)throws Exception{
  String protocol=p.optString("protocol","compatible");String request=endpoint(p.getString("endpoint"),protocol,debug);String suffix=protocol.equals("anthropic")?"/messages":"/chat/completions";String url=request.substring(0,request.length()-suffix.length())+"/models";
  if(secret.isEmpty())throw new Exception("请先保存 API Key");HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();try{c.setInstanceFollowRedirects(false);c.setConnectTimeout(20000);c.setReadTimeout(30000);if(protocol.equals("anthropic")){c.setRequestProperty("x-api-key",secret);c.setRequestProperty("anthropic-version","2023-06-01");}else c.setRequestProperty("Authorization","Bearer "+secret);
   int code=c.getResponseCode();if(code!=200)throw new IOException("模型检测 HTTP "+code+"。服务商可能不开放列表接口，可手动填写模型 ID。");byte[] bytes;try(InputStream in=c.getInputStream()){bytes=MainActivity.readLimited(in,2*1024*1024);}JSONArray data=new JSONObject(new String(bytes,StandardCharsets.UTF_8)).getJSONArray("data"),ids=new JSONArray();java.util.TreeSet<String> sorted=new java.util.TreeSet<>();for(int i=0;i<data.length();i++){String id=data.getJSONObject(i).optString("id");if(!id.isEmpty())sorted.add(id);}for(String id:sorted)ids.put(id);return ids;
  }finally{c.disconnect();}
 }
 /**
  * 把 OpenAI 格式的消息转成 Anthropic 能收的格式。
  *
  * <p>纯文本消息两边一样，原样传。差别只在图片：
  * <pre>
  * OpenAI     {type:"image_url", image_url:{url:"data:image/jpeg;base64,xxx"}}
  * Anthropic  {type:"image", source:{type:"base64", media_type:"image/jpeg", data:"xxx"}}
  * </pre>
  * 不转的话 Anthropic 会直接拒绝这条消息，而且报错信息不会提到图片，
  * 用户只会看到「请求无效」，根本想不到是格式问题。
  *
  * <p>只处理内联的 data URL —— 远程图片地址两家语义不同，
  * 这里不替用户做抓取，跳过并保留文字部分。
  */
 static JSONArray toAnthropicMessages(JSONArray messages)throws Exception{
  JSONArray out=new JSONArray();
  for(int i=0;i<messages.length();i++){
   JSONObject message=messages.optJSONObject(i);
   if(message==null){out.put(messages.get(i));continue;}
   Object raw=message.opt("content");
   if(!(raw instanceof JSONArray)){out.put(message);continue;}
   JSONArray parts=(JSONArray)raw;
   JSONArray converted=new JSONArray();
   for(int k=0;k<parts.length();k++){
    JSONObject part=parts.optJSONObject(k);
    if(part==null)continue;
    if(!"image_url".equals(part.optString("type"))){converted.put(part);continue;}
    JSONObject holder=part.optJSONObject("image_url");
    String url=holder==null?"":holder.optString("url","");
    int comma=url.indexOf(',');
    if(!url.startsWith("data:")||comma<0)continue;   // 远程地址不转，跳过
    String header=url.substring(5,comma);            // 形如 image/jpeg;base64
    String mediaType=header.split(";")[0];
    if(mediaType.isEmpty())mediaType="image/jpeg";
    converted.put(new JSONObject().put("type","image")
     .put("source",new JSONObject().put("type","base64")
      .put("media_type",mediaType).put("data",url.substring(comma+1))));
   }
   JSONObject copy=new JSONObject(message.toString());
   copy.put("content",converted);
   out.put(copy);
  }
  return out;
 }

/**
  * 构造请求体。
  *
  * <p><b>带 tools 时：</b>启用原生 function calling。
  * 模型不再需要输出「正文里的 JSON」，而是返回结构化的 tool_calls ——
  * 这样它就没法在 JSON 前后加解释导致解析失败。
  *
  * <p><b>不带 tools 时：</b>退回旧的纯对话模式（普通问答）。
  */
static JSONObject requestBody(JSONObject p,JSONArray messages,String system)throws Exception{
  return requestBody(p,messages,system,null);
 }

 /** 带工具定义的请求体。tools 为 null 表示这次不挂工具。 */
static JSONObject requestBody(JSONObject p,JSONArray messages,String system,JSONArray tools)throws Exception{
  String protocol=p.optString("protocol","compatible");
  JSONObject body=new JSONObject().put("model",p.getString("model")).put("stream",false);
  int max=Math.max(64,Math.min(ModelLimits.output(p.optString("endpoint"),p.optString("model")),p.optInt("maxTokens",4096)));
  if(protocol.equals("anthropic")){
   body.put("system",system).put("messages",toAnthropicMessages(messages)).put("max_tokens",max);
   if(tools!=null&&tools.length()>0)body.put("tools",tools);
  }else{
   JSONArray all=new JSONArray().put(new JSONObject().put("role","system").put("content",system));
   for(int i=0;i<messages.length();i++)all.put(messages.get(i));
   body.put("messages",all).put("max_tokens",max);
   String thinking=p.optString("thinking","");
   if(thinking.equals("enabled")||thinking.equals("disabled"))body.put("thinking",new JSONObject().put("type",thinking));
   if(tools!=null&&tools.length()>0)body.put("tools",tools).put("tool_choice","auto");
  }
  return body;
 }

  void cancel(){cancelled=true;HttpURLConnection c=connection;if(c!=null)c.disconnect();}
 /**
  * 发一次请求。
  *
  * @param tools 工具定义；null 表示这次是纯对话，不挂工具
  */
 JSONObject request(JSONObject p,String secret,JSONArray messages,String system,boolean debug)throws Exception{
  return request(p,secret,messages,system,debug,null);
 }

 /** 带工具的请求。 */
 JSONObject request(JSONObject p,String secret,JSONArray messages,String system,boolean debug,JSONArray tools)throws Exception{
  /*
   * 网络抖动重试。
   *
   * <p>为什么必须有：一次工具循环要连着发几十次请求，
   * 每次都重新建 TCP 连接、重新握手。中途任何一次连接被服务商回收、
   * 或者手机网络切了一下，整轮几十次工具调用全部作废 ——
   * 模型已经改好的文件、已经读到的内容，全都白费。
   *
   * <p>用户看到的现象是「AI 干了一半突然报网络错误」，
   * 而已改的文件因为暂存区没提交，全丢了。
   *
   * <p><b>只重试「还没吐出内容」的失败：</b>连接超时、连接被重置、
   * 首字节读超时。这类失败说明请求根本没开始生效，重发是安全的。
   * 一旦已经开始往回吐字就不重试 —— 重发会把同样的内容再吐一遍，
   * 用户看到的是重复文本，比直接报错更糟。
   */
  IOException last=null;
  for(int attempt=1;attempt<=NET_RETRY_ATTEMPTS+1;attempt++){
   if(cancelled)throw new InterruptedIOException("已取消");
   try{
    return requestOnce(p,secret,messages,system,debug,tools,attempt>1);
   }catch(IOException e){
    /* 用户主动取消不算失败，也不重试 */
    if(cancelled||e instanceof InterruptedIOException)throw e;
    /*
     * 已经往界面吐过内容了，不许重放。
     *
     * <p>见字段 delivered 的说明：重发会把同样的正文再说一遍，
     * 用户看到的是重复文本，而不是「恢复正常了」。
     * 这种时候正确的做法是如实报告中断，让用户自己决定是否继续。
     */
    if(delivered)throw e;
    /* 服务端明确拒绝的，重试没有意义 */
    String m=e.getMessage()==null?"":e.getMessage();
    if(m.startsWith("HTTP "))throw e;
    last=e;
    if(attempt>NET_RETRY_ATTEMPTS)break;
    /* 退避一下再试，别在网络不通的时候连着撞墙 */
    try{Thread.sleep(800L*attempt);}catch(InterruptedException ie){throw new InterruptedIOException("已取消");}
    if(cancelled)throw new InterruptedIOException("已取消");
   }
  }
  throw last==null?new IOException("请求失败"):last;
 }

 /** 网络失败最多重试几次（不含第一次）。 */
 static final int NET_RETRY_ATTEMPTS=2;

 JSONObject requestOnce(JSONObject p,String secret,JSONArray messages,String system,boolean debug,JSONArray tools,boolean retrying)throws Exception{
  /*
   * 每次真正发一次 HTTP 请求前复位。
   *
   * <p>delivered 判的是「这一次请求有没有把内容交给用户」，
   * 不是「这个客户端有没有交过」。同一个 ApiClient 会在一次工具循环里
   * 连发几十次请求：上一轮早就把正文吐完了，如果不清零，
   * 这一轮连接刚建好就断也会被判定成「已经输出过」而不重试。
   */
  delivered=false;
  String protocol=p.optString("protocol","compatible");String url=endpoint(p.getString("endpoint"),protocol,debug);
  if(secret.isEmpty())throw new Exception("请先在模型设置中保存 API Key");
  JSONObject body=requestBody(p,messages,system,tools);
  boolean streaming=progress!=null&&p.optBoolean("streaming",true);if(streaming){body.put("stream",true);String host=new URI(url).getHost();if(!protocol.equals("anthropic")&&java.util.Arrays.asList("api.deepseek.com","api.stepfun.com","api.openai.com").contains(host))body.put("stream_options",new JSONObject().put("include_usage",true));}
  if(cancelled)throw new InterruptedIOException("已取消");
  HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();connection=c;
  try{
   c.setInstanceFollowRedirects(false);c.setRequestMethod("POST");c.setConnectTimeout(20000);
   /*
    * 读超时。
    *
    * <p>原来非 DeepSeek 一律 120 秒。问题是：模型「思考」期间服务端可能
    * 十几秒不吐任何字节，一个复杂问题想两分钟很常见 —— 一超就
    * SocketTimeoutException，而这一轮几十次工具调用全部作废。
    *
    * <p>放宽到 300 秒。DeepSeek 保持 0（不限），它本来就慢。
    *
    * <p>流式下这个超时是「两个数据块之间的间隔」，不是总时长，
    * 所以放宽不会让正常请求变慢，只是不再误杀慢思考。
    */
   c.setReadTimeout(ModelLimits.deepSeek(p.optString("endpoint"),p.optString("model"))?0:300000);
   c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
   if(protocol.equals("anthropic")){c.setRequestProperty("x-api-key",secret);c.setRequestProperty("anthropic-version","2023-06-01");}else c.setRequestProperty("Authorization","Bearer "+secret);
   byte[]data=body.toString().getBytes(StandardCharsets.UTF_8);if(data.length>32*1024*1024)throw new IOException("请求超过32 MB传输限制；请分批处理");c.setFixedLengthStreamingMode(data.length);
   try(OutputStream o=c.getOutputStream()){o.write(data);}
   int code=c.getResponseCode();if(code!=200)throw new IOException("HTTP "+code+(code==400?"：模型参数或上下文超限；上下文总量包含输入和输出预留，请减少输入或输出上限":code==401?"：密钥或权限错误":code==429?"：额度或速率限制":code>=300&&code<400?"：已阻止重定向，请核对接口地址":"：请求失败，请检查模型、参数和服务状态"));
   JSONObject raw;
   if(c.getContentType()!=null&&c.getContentType().toLowerCase().contains("text/event-stream")){
    /*
     * 重试时把上一轮吐到前端的字清掉。
     *
     * <p>有了 delivered 门槛，走到这里时一定是「一个字节都没吐过」，
     * 所以这条清理其实已经不会触发内容差异；保留它是为了防御
     * 未来某条路径在吐完之后仍然回到重试分支。
     */
    if(retrying&&progress!=null)progress.update("","");
    /*
     * 包一层进度回调，用来记录「这次到底有没有把内容交给用户」。
     *
     * <p>必须包在 progress 上而不是自己另记一份：正文和思维链
     * 都是通过这个回调流到界面的，只有在这里才能准确知道
     * 用户已经看见了什么。读完恢复原来的回调，不影响调用方。
     */
    Progress realProgress=progress;
    if(realProgress!=null)progress=new Progress(){
     public void update(String text,String reasoning){
      if((text!=null&&!text.isEmpty())||(reasoning!=null&&!reasoning.isEmpty()))delivered=true;
      realProgress.update(text,reasoning);
     }};
    try(InputStream in=c.getInputStream()){raw=StreamResponse.read(in,protocol.equals("anthropic"),this);}
    finally{progress=realProgress;}}
   else{byte[] bytes;try(InputStream in=c.getInputStream()){bytes=MainActivity.readLimited(in,16*1024*1024);}raw=new JSONObject(new String(bytes,StandardCharsets.UTF_8));}
   String content="",reason="",finish="";
   if(protocol.equals("anthropic")){finish=raw.optString("stop_reason");JSONArray a=raw.optJSONArray("content");if(a!=null)for(int i=0;i<a.length();i++){JSONObject x=a.getJSONObject(i);if(x.optString("type").equals("text"))content+=x.optString("text");}}
   else{JSONObject choice=raw.optJSONArray("choices")==null?null:raw.getJSONArray("choices").optJSONObject(0);if(choice!=null){finish=choice.optString("finish_reason");JSONObject m=choice.optJSONObject("message");if(m!=null){content=m.isNull("content")?"":m.optString("content");reason=m.optString("reasoning_content","");}}}

   /*
    * 工具调用。
    *
    * <p>这里是最容易出错的地方：模型决定调工具时，正文是空的 ——
    * 内容全在 tool_calls 里。如果还按老规矩「没有文本就报错」，
    * 每一轮工具调用都会失败一次。
    *
    * <p>而且顺序很重要：先取工具调用，再判断「是不是什么都没有」。
    */
   JSONArray toolCalls=ToolSchema.parseToolCalls(raw,protocol);

   if(content.isEmpty()&&reason.isEmpty()&&toolCalls.length()==0)throw new IOException("接口没有返回文本内容");
   boolean incomplete=(content.isEmpty()&&toolCalls.length()==0)||finish.equals("length")||finish.equals("max_tokens");
   if(incomplete)content="[工作台提示：本次输出不完整。"+(content.isEmpty()?"接口只返回推理，没有最终答案。":"已达到输出上限，代码可能被截断。")+"请调整推理模式或输出上限后重试；已记录真实用量。]\n\n"+content;
   return new JSONObject().put("incomplete",incomplete).put("finishReason",finish)
    .put("text",content).put("reasoning",reason)
    .put("toolCalls",toolCalls)
    .put("usage",Usage.parse(raw,protocol)).put("model",raw.optString("model",p.getString("model")));
  }finally{c.disconnect();connection=null;}
 }
}
