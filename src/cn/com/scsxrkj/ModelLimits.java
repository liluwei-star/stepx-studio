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
 static int context(String endpoint,String model){return deepSeek(endpoint,model)?1048576:0;}
 static int output(String endpoint,String model){return deepSeek(endpoint,model)?393216:32768;}
 static int transportChars(String endpoint,String model){return deepSeek(endpoint,model)?8*1048576:95000;}
}
