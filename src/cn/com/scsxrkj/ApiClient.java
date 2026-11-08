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
  String protocol=p.optString("protocol","compatible");String url=endpoint(p.getString("endpoint"),protocol,debug);
  if(secret.isEmpty())throw new Exception("请先在模型设置中保存 API Key");
  JSONObject body=requestBody(p,messages,system,tools);
  boolean streaming=progress!=null&&p.optBoolean("streaming",true);if(streaming){body.put("stream",true);String host=new URI(url).getHost();if(!protocol.equals("anthropic")&&java.util.Arrays.asList("api.deepseek.com","api.stepfun.com","api.openai.com").contains(host))body.put("stream_options",new JSONObject().put("include_usage",true));}
  if(cancelled)throw new InterruptedIOException("已取消");
  HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();connection=c;
  try{
   c.setInstanceFollowRedirects(false);c.setRequestMethod("POST");c.setConnectTimeout(20000);c.setReadTimeout(ModelLimits.deepSeek(p.optString("endpoint"),p.optString("model"))?0:120000);c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
   if(protocol.equals("anthropic")){c.setRequestProperty("x-api-key",secret);c.setRequestProperty("anthropic-version","2023-06-01");}else c.setRequestProperty("Authorization","Bearer "+secret);
   byte[]data=body.toString().getBytes(StandardCharsets.UTF_8);if(data.length>32*1024*1024)throw new IOException("请求超过32 MB传输限制；请分批处理");c.setFixedLengthStreamingMode(data.length);
   try(OutputStream o=c.getOutputStream()){o.write(data);}
   int code=c.getResponseCode();if(code!=200)throw new IOException("HTTP "+code+(code==400?"：模型参数或上下文超限；上下文总量包含输入和输出预留，请减少输入或输出上限":code==401?"：密钥或权限错误":code==429?"：额度或速率限制":code>=300&&code<400?"：已阻止重定向，请核对接口地址":"：请求失败，请检查模型、参数和服务状态"));
   JSONObject raw;
   if(c.getContentType()!=null&&c.getContentType().toLowerCase().contains("text/event-stream")){try(InputStream in=c.getInputStream()){raw=StreamResponse.read(in,protocol.equals("anthropic"),this);}}
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
