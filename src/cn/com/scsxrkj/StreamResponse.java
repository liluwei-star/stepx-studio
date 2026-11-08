package cn.com.scsxrkj;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
/**
 * 流式响应的解码器（SSE 格式）。
 *
 * <p>云端 AI 是一段段往回吐数据的，这个类负责把那些碎片拼成完整文字和思考过程，
 * 顺便累计 Token 用量。
 *
 * <p>一条铁律：<b>流没完整结束就不许写文件</b>。
 * 网络中途断了、被用户取消、输出被截断，都算不完整，一律不落地。
 */
final class StreamResponse {
 final StringBuilder text=new StringBuilder(),reason=new StringBuilder();JSONObject usage;String model="",finish="";boolean ended;
 /*
  * 工具调用的累积。
  *
  * <p>流式下工具调用是<b>分片</b>到的：先是 id 和 name，然后 arguments 的字符串
  * 一截一截来。比如 {"path":"src/A.ts"} 会先来 {"path":"src/ ，再来 A.ts"}。
  *
  * <p>所以必须按 index 把 id / name / arguments 分别攒起来，
  * 收到 finish_reason 时才拼成完整的调用。
  * 直接每次覆盖会丢掉前面的分片 —— 模型传个路径就断在半个字符串上。
  */
 private final java.util.LinkedHashMap<String,String[]> calls=new java.util.LinkedHashMap<>();

 /** 记一条工具调用的分片。 */
 private void addToolCallFragment(String id,String name,String argsFragment,Integer index)throws Exception{
  String key=index!=null?("idx:"+index):("id:"+id);
  String[] slot=calls.get(key);
  if(slot==null){slot=new String[3];calls.put(key,slot);}
  if(name!=null&&!name.isEmpty())slot[0]=name;
  if(id!=null&&!id.isEmpty())slot[1]=id;
  if(argsFragment!=null&&!argsFragment.isEmpty()){
   /*
    * 这里曾经写成「slot[2]==null 就置空串，否则才拼接」——
    * 结果是<b>第一片 arguments 被整段丢掉</b>，第二片从中间接上，
    * 拼出来的 JSON 必然残缺，工具参数全空。
    *
    * <p>正确做法：第一片直接作为起点，之后每片往后追加。
    */
   if(slot[2]==null)slot[2]=argsFragment;else slot[2]=slot[2]+argsFragment;
  }
 }

 /** 把累积好的分片拼成完整的工具调用列表。 */
 JSONArray collectToolCalls()throws Exception{
  JSONArray out=new JSONArray();
  int i=0;
  for(String[] slot:calls.values()){
   String name=slot[0]==null?"":slot[0];
   if(name.isEmpty())continue;
   JSONObject args=new JSONObject();
   String rawArgs=slot[2]==null?"":slot[2];
   if(!rawArgs.isEmpty()){
    try{args=new JSONObject(rawArgs);}catch(Exception e){args=new JSONObject();}
   }
   out.put(new JSONObject().put("id",slot[1]==null||slot[1].isEmpty()?("call_"+i):slot[1])
    .put("name",name).put("args",args));
   i++;
  }
  return out;
 }
 void event(String data,boolean anthropic,ApiClient.Progress progress)throws Exception{
  if(data.equals("[DONE]")){ended=true;return;}if(data.isEmpty())return;JSONObject o=new JSONObject(data);if(o.has("error")||o.optString("type").equals("error"))throw new IOException("流式接口返回错误");
  if(anthropic){String type=o.optString("type");if(type.equals("message_start")){JSONObject m=o.getJSONObject("message");usage=m.optJSONObject("usage");model=m.optString("model");}else if(type.equals("content_block_start")){
    /*
     * Anthropic 的工具调用是分两步来的：
     *   content_block_start 里给 tool_use 的 name 和 id
     *   content_block_delta 里给 input_json_delta，也就是 arguments 的一截
     * 两边要按 index 对上。
     */
    JSONObject block=o.optJSONObject("content_block");
    if(block!=null&&"tool_use".equals(block.optString("type"))){
     addToolCallFragment(block.optString("id",""),block.optString("name",""),null,o.optInt("index",-1)<0?null:o.optInt("index"));
    }
   }else if(type.equals("content_block_delta")){JSONObject d=o.getJSONObject("delta");if(d.optString("type").equals("text_delta"))text.append(d.optString("text"));else if(d.optString("type").equals("thinking_delta"))reason.append(d.optString("thinking"));else if(d.optString("type").equals("input_json_delta")){
    /*
     * arguments 的分片。partial_json 是一小段 JSON 文本，要按顺序拼起来。
     * 少了这一段，流式下工具参数会是空的或者半截。
     */
    addToolCallFragment(null,null,d.optString("partial_json",""),o.optInt("index",-1)<0?null:o.optInt("index"));
   }}else if(type.equals("message_delta")){finish=o.getJSONObject("delta").optString("stop_reason");JSONObject u=o.optJSONObject("usage");if(u!=null){if(usage==null)usage=new JSONObject();java.util.Iterator<String> it=u.keys();while(it.hasNext()){String k=it.next();usage.put(k,u.get(k));}}}else if(type.equals("message_stop"))ended=true;
  }else{if(o.has("model"))model=o.optString("model");JSONObject u=o.optJSONObject("usage");if(u!=null)usage=u;JSONArray choices=o.optJSONArray("choices");if(choices!=null&&choices.length()>0){JSONObject c=choices.getJSONObject(0),d=c.optJSONObject("delta");if(d!=null){if(!d.isNull("content"))text.append(d.optString("content",""));if(!d.isNull("reasoning_content"))reason.append(d.optString("reasoning_content",""));JSONArray tc=d.optJSONArray("tool_calls");if(tc!=null)for(int i=0;i<tc.length();i++){JSONObject one=tc.optJSONObject(i);if(one==null)continue;JSONObject fn=one.optJSONObject("function");addToolCallFragment(one.optString("id",""),fn==null?"":fn.optString("name",""),fn==null?null:fn.optString("arguments",""),one.has("index")?one.optInt("index"):null);}}if(!c.isNull("finish_reason"))finish=c.optString("finish_reason","");}}
  if(text.length()+reason.length()>8*1024*1024)throw new IOException("流式响应过大");if(progress!=null)progress.update(text.toString(),reason.toString());
 }
 /**
  * 拼出最终响应。
  *
  * <p>流式下工具调用是拼回来的，这里要把拼好的 {@code tool_calls} 塞进
  * 对应协议的响应结构里 —— 这样上层不管走流式还是非流式，
  * 都能用同一套 {@code ToolSchema.parseToolCalls} 解析。
  */
 JSONObject result(boolean anthropic)throws Exception{
  if(!ended)throw new IOException("流式响应中断，未保存项目修改");
  JSONObject r=new JSONObject().put("model",model);
  if(usage!=null)r.put("usage",usage);
  JSONArray toolCalls=collectToolCalls();
  if(anthropic){
   r.put("stop_reason",finish);
   JSONArray content=new JSONArray().put(new JSONObject().put("type","text").put("text",text.toString()));
   for(int i=0;i<toolCalls.length();i++){
    JSONObject call=toolCalls.optJSONObject(i);
    if(call==null)continue;
    content.put(new JSONObject().put("type","tool_use").put("id",call.optString("id"))
     .put("name",call.optString("name")).put("input",call.optJSONObject("args")));
   }
   r.put("content",content);
  }else{
   JSONObject message=new JSONObject().put("content",text.toString()).put("reasoning_content",reason.toString());
   if(toolCalls.length()>0){
    JSONArray tcs=new JSONArray();
    for(int i=0;i<toolCalls.length();i++){
     JSONObject call=toolCalls.optJSONObject(i);
     if(call==null)continue;
     tcs.put(new JSONObject().put("id",call.optString("id")).put("type","function")
      .put("function",new JSONObject().put("name",call.optString("name"))
       .put("arguments",call.optJSONObject("args").toString())));
    }
    message.put("tool_calls",tcs);
   }
   r.put("choices",new JSONArray().put(new JSONObject().put("finish_reason",finish).put("message",message)));
  }
  return r;
 }
 static JSONObject read(InputStream input,boolean anthropic,ApiClient client)throws Exception{
  StreamResponse stream=new StreamResponse();BufferedReader r=new BufferedReader(new InputStreamReader(input,StandardCharsets.UTF_8));String line;StringBuilder event=new StringBuilder();long chars=0;
  while((line=r.readLine())!=null){if(client.cancelled)throw new InterruptedIOException("已取消");chars+=line.length();if(chars>32*1024*1024)throw new IOException("流式响应超出限制");if(line.isEmpty()){stream.event(event.toString(),anthropic,client.progress);event.setLength(0);if(stream.ended)break;}else if(line.startsWith("data:")){if(event.length()>0)event.append('\n');String data=line.substring(5);event.append(data.startsWith(" ")?data.substring(1):data);}}
  if(event.length()>0)stream.event(event.toString(),anthropic,client.progress);return stream.result(anthropic);
 }
}
