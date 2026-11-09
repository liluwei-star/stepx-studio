package cn.com.scsxrkj;
import android.content.Context;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import com.google.ai.edge.litertlm.*;
/**
 * 本地离线模型客户端，继承 {@link ApiClient} 的接口但完全跑在手机里。
 *
 * <p>好处：不需要密钥，不产生 API 费用，断网也能用。
 * 代价：速度取决于手机算力，长上下文会比较吃力。
 */
final class LocalAiClient extends ApiClient {
 final Context context;volatile Conversation conversation;
 LocalAiClient(Context c){context=c.getApplicationContext();}
 @Override void cancel(){cancelled=true;Conversation c=conversation;if(c!=null)try{c.cancelProcess();}catch(Exception ignored){}}
 /**
  * 带工具定义的请求 —— 本地模型直接忽略工具，退回普通生成。
  *
  * <p><b>这里漏覆写是一个会让本地模型彻底跑不起来的 BUG。</b>
  * DevAgent 在「服务端支持原生 function calling」时会走 6 参数版本：
  * {@code request(p, key, messages, system, debug, toolDefs)}。
  * 而 LocalAiClient 只覆写了 5 参数那个。
  *
  * <p>于是带工具的这次请求顺着继承落到父类 {@link ApiClient} ——
  * 父类是真的去发 HTTP 的：用本地模型那条配置里的 endpoint、配一把
  * 本来就为空的密钥，开口就是「请先在模型设置中保存 API Key」。
  *
  * <p>用户看到的现象是：远端模型一切正常，一切到本地模型，
  * 第一句话就报要填密钥 —— 而本地模型根本不需要密钥。
  *
  * <p>本地引擎（LiteRT-LM）没有 function calling，所以这里的做法是
  * 忽略 tools 直接本地生成；配套地，DevAgent 那边对 local 协议
  * 也不该挂 tools，让提示词走文本 JSON 协议。
  */
 @Override JSONObject request(JSONObject p,String ignored,JSONArray messages,String system,boolean debug,JSONArray tools)throws Exception{
  /* 本地没有 function calling：工具定义忽略，按普通对话生成 */
  return request(p,ignored,messages,system,debug);
 }

 @Override JSONObject request(JSONObject p,String ignored,JSONArray messages,String system,boolean debug)throws Exception{
  File file=LocalModels.modelFile(context,p.optString("model"));if(!file.isFile())throw new Exception("本地模型尚未下载，请进入本地模型管理");
  int tokens=Math.max(1024,Math.min(32768,p.optInt("contextTokens",8192))),output=Math.max(64,Math.min(tokens-512,p.optInt("maxTokens",2048)));
  Engine.Companion.setNativeMinLogSeverity(LogSeverity.ERROR);ExperimentalFlags.INSTANCE.setEnableBenchmark(true);ExperimentalFlags.INSTANCE.setEnableSpeculativeDecoding(p.optBoolean("mtp",true));
  Backend backend=p.optString("backend","gpu").equals("cpu")?new Backend.CPU(4,null):new Backend.GPU();
  File cache=new File(context.getCacheDir(),"local-ai");if(!cache.isDirectory()&&!cache.mkdirs())throw new IOException("无法创建模型缓存");
  Engine engine=new Engine(new EngineConfig(file.getAbsolutePath(),backend,null,null,tokens,null,new File(context.getCacheDir(),"local-ai").getAbsolutePath()));boolean initialized=false;
  try{
   if(cancelled)throw new InterruptedIOException("已取消");engine.initialize();initialized=true;if(cancelled)throw new InterruptedIOException("已取消");
   List<Message> initial=new ArrayList<>();for(int i=0;i<messages.length()-1;i++){JSONObject m=messages.getJSONObject(i);initial.add(m.optString("role").equals("assistant")?Message.Companion.model(MainActivity.messageText(m)):Message.Companion.user(MainActivity.messageText(m)));}
   SamplerConfig sampler=new SamplerConfig(p.optInt("topK",64),p.optDouble("topP",0.95),p.optDouble("temperature",1.0),0);
   ConversationConfig config=new ConversationConfig(Contents.Companion.of(system),initial,Collections.emptyList(),sampler,false,null,Collections.emptyMap(),null,false,output,new ThinkingConfig(p.optBoolean("localThinking",false),p.optInt("thinkingBudget",512)));
   Conversation c=engine.createConversation(config);conversation=c;try{
    CountDownLatch done=new CountDownLatch(1);StringBuilder text=new StringBuilder(),reasoning=new StringBuilder();Throwable[] failure={null};
    /*
     * 本地模型没有视觉能力。带图片的这条消息只取文字部分，
     * 并明确告诉模型「图被忽略了」—— 不说的话它可能顺着用户的描述
     * 凭空编出图里的内容，用户会以为它真的看懂了。
     */
    JSONObject lastMessage=messages.getJSONObject(messages.length()-1);
    String lastText=MainActivity.messageText(lastMessage);
    int attachedImages=MainActivity.messageImageCount(lastMessage);
    c.sendMessageAsync(attachedImages>0?(lastText+"\n\n（用户附了 "+attachedImages+" 张图片，本地模型看不到图片内容，以上文字是全部可用信息）").trim():lastText,new MessageCallback(){
     public void onMessage(Message message){text.append(message.toString());String thought=message.getChannels().get("thought");if(thought!=null)reasoning.append(thought);if(progress!=null)progress.update(text.toString(),reasoning.toString());}
     public void onDone(){done.countDown();}
     public void onError(Throwable error){failure[0]=error;done.countDown();}
    });
    while(!done.await(250,TimeUnit.MILLISECONDS)){if(cancelled)c.cancelProcess();}
    if(cancelled)throw new InterruptedIOException("本地生成已取消");if(failure[0]!=null)throw new Exception("本地推理失败："+failure[0].getMessage());
    JSONObject usage=new JSONObject().put("known",false),bench=new JSONObject();int decoded=-1;
    try{BenchmarkInfo b=c.getBenchmarkInfo();decoded=b.getLastDecodeTokenCount();int input=b.getLastPrefillTokenCount();if(input>=0&&decoded>=0)usage.put("known",true).put("input",input).put("output",decoded).put("total",input+decoded);bench.put("prefillTokensPerSecond",b.getLastPrefillTokensPerSecond()).put("decodeTokensPerSecond",b.getLastDecodeTokensPerSecond()).put("firstTokenSeconds",b.getTimeToFirstTokenInSecond());}catch(Exception ignoredStats){}
    boolean incomplete=decoded>=output||text.length()==0;
    return new JSONObject().put("text",text.toString()).put("reasoning",reasoning.toString()).put("usage",usage).put("model",p.optString("model")).put("incomplete",incomplete).put("benchmark",bench);
   }finally{conversation=null;c.close();}
  }catch(OutOfMemoryError e){throw new Exception("本地内存不足，请降低上下文或选择更小的模型");}finally{if(initialized)engine.close();}
 }
}
