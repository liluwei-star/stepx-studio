package cn.com.scsxrkj;
import java.net.URI;
/**
 * 各模型的上下文长度限制。
 *
 * <p>超过限制的请求会被服务端直接拒绝，或者悄悄截断导致回答质量暴跌。
 * 这里在发请求前就按模型的实际上限做检查，把问题提前拦住。
 */
final class ModelLimits {
 static boolean deepSeek(String endpoint,String model){try{return "https".equalsIgnoreCase(new URI(endpoint).getScheme())&&"api.deepseek.com".equalsIgnoreCase(new URI(endpoint).getHost())&&java.util.Arrays.asList("deepseek-flash","deepseek-v4-flash","deepseek-v4-pro","deepseek-v4-flash-vision-exp").contains(model);}catch(Exception e){return false;}}
 /**
  * 模型的上下文长度（字符数）。
  *
  * <p>只填确定的值 —— 猜错了会让请求被服务端拒绝，
  * 那比重试一次糟糕得多。已知的：DeepSeek 1M、MiniMax 1M。
  *
  * @param endpoint 接口地址
  * @param model    模型 ID
  * @return 字符数；不知道返回 0
  */
 static int context(String endpoint,String model){
  if(deepSeek(endpoint,model))return 1048576;
  try{
   URI u=new URI(endpoint);
   String host=u.getHost()==null?"":u.getHost().toLowerCase(java.util.Locale.ROOT);
   // MiniMax 主力模型是 1M 上下文
   if(host.contains("minimax"))return 1048576;
  }catch(Exception ignored){
  }
  return 0;
 }
 static int output(String endpoint,String model){return deepSeek(endpoint,model)?393216:32768;}
 /**
  * 允许放进上下文的字符数上限。
  *
  * <p>原来非 DeepSeek 一律按 95000 拦 —— 那是「本地传输管道」的保守值，
  * 不是模型真正的上下文长度。MiniMax、Qwen、GLM 这类模型上下文都是百万级，
  * 拿 95K 去拦它们，结果就是「项目稍微大一点就说超限」，
  * 而实际上根本传得过去。
  *
  * <p>真正的硬限制在两处：{@code ApiClient} 的 32 MB 请求体上限，
  * 和服务端自己的上下文窗口。这里取模型窗口的四分之一，
  * 留出输出和工具回填的余量。
  *
  * @param endpoint 接口地址
  * @param model    模型 ID
  * @return 字符数上限
  */
 static int transportChars(String endpoint,String model){
  int ctx=context(endpoint,model);
  if(ctx>0)return ctx/4;
  // 不知道模型上限时放开到 8 M 字符（约 8 MB UTF-8 中文，或 24 MB 纯 ASCII）。
  // 这已经远大于 ApiClient 的 32 MB 请求体上限之下能放的内容，
  // 真正的拦截交给服务端 —— 它才知道自己吃不吃得下。
  return 8*1024*1024;
 }
}
