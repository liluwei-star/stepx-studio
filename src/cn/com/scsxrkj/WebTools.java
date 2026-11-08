package cn.com.scsxrkj;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.regex.*;

/**
 * 联网能力：抓网页、查资料。
 *
 * <p>为什么需要它：模型的知识截止到训练那天。遇到新版本的库、改过的 API、
 * 或者一个它没见过的报错，它只能猜 —— 而<b>猜出来的代码和写对的代码看起来一样自信</b>。
 * 能查一下，就少一半瞎猜。
 *
 * <p>安全边界（这些不是「人为限制」，是必须的）：
 * <ul>
 *   <li><b>只允许 http/https</b>，其他协议一律拒（{@code file://} 能读本地文件，
 *       {@code ftp://} 之类没有正当用途）</li>
 *   <li><b>拒绝内网地址</b>：{@code 127.0.0.1}、{@code 192.168.*}、{@code 10.*}、
 *       {@code 172.16-31.*}、{@code 169.254.*}、{@code ::1} 全部拦掉。
 *       手机上这些地址通向你家的路由器、摄像头管理页、NAS —— 让一个语言模型
 *       能请求它们，等于给它开了一扇通往你内网的门</li>
 *   <li><b>响应体积设上限</b>，防止一个大文件把内存吃光</li>
 * </ul>
 */
final class WebTools {
 /** 单次抓取的正文上限。超过就截断 —— 模型也读不完，传过去只是浪费钱。 */
 static final int FETCH_CAP=60000;
 /** 原始响应的硬上限。防大文件把内存打爆。 */
 static final int RAW_CAP=4*1024*1024;
 static final int TIMEOUT=25000;
 /** 最多跟几跳重定向。正常站点 1-2 跳，超过这个数基本是循环或者钓鱼链。 */
 static final int MAX_REDIRECTS=5;

 /** 搜索结果条数上限。 */
 static final int SEARCH_LIMIT=8;

 private final MainActivity a;
 WebTools(MainActivity a){this.a=a;}

 /**
  * 判断一个地址是不是内网/本机。
  *
  * <p>按主机名字符串判断，不做 DNS 解析 —— 解析后再判断会有 TOCTOU 窗口
  * （解析时是公网 IP，连的时候变成内网），而且手机上 DNS 可能很慢。
  * 名字判断拦不住「域名解析到内网 IP」的情况，但这已经挡掉了绝大多数误用和滥用。
  */
 static boolean isPrivate(String host){
  if(host==null)return true;
  String h=host.toLowerCase(java.util.Locale.ROOT);
  if(h.equals("localhost")||h.endsWith(".local")||h.endsWith(".internal"))return true;
  /*
   * IPv6 字面量。::1 是回环，fe80::/10 是链路本地，fc00::/7 是唯一本地地址
   * —— 后两个在家庭网络里就是「同一条网线上的设备」。
   * 主机名不会含冒号，所以进到这个分支的一定是 IPv6 字面量。
   */
  if(h.contains(":")){
   String v6=(h.startsWith("[")&&h.endsWith("]"))?h.substring(1,h.length()-1):h;
   if(v6.equals("::1")||v6.equals("::"))return true;
   if(v6.startsWith("fe80:")||v6.startsWith("fc")||v6.startsWith("fd"))return true;
  }
  /*
   * 这几个域名服务会把域名里的 IP 直接解析出来（127.0.0.1.nip.io → 127.0.0.1）。
   * 它们是绕过「按主机名判断」最省事的办法，直接拦掉。
   */
  if(h.endsWith(".nip.io")||h.endsWith(".sslip.io")||h.endsWith(".xip.io")||h.endsWith(".traefik.me"))return true;
  /*
   * 只认正常主机名里会出现的字符。
   * 这道兜底是为了挡 0x7f.0.0.1 这类十六进制写法 —— 它绕得过上面的数字正则，
   * 但真正发起连接时会被解析成 127.0.0.1。中文域名到这一层已经是 punycode（xn--），
   * 不会误伤。
   */
  if(!h.matches("[a-z0-9.\\-:_\\[\\]]+"))return true;
  /*
   * 十六进制写法的 IP（0x7f.0.0.1 就是 127.0.0.1）。
   * 它只含字母数字和点，上面的字符兜底拦不住，但真正连接时会被解析成回环地址。
   * 正常主机名不会以 0x 开头，也不会出现 .0x 这样的一段。
   */
  if(h.startsWith("0x")||h.contains(".0x"))return true;
  // IPv4 字面量判断
  if(h.matches("\\d{1,3}(\\.\\d{1,3}){3}")){
   String[] p=h.split("\\.");
   try{
    int a0=Integer.parseInt(p[0]),a1=Integer.parseInt(p[1]);
    if(a0==127||a0==10||a0==0)return true;
    if(a0==192&&a1==168)return true;
    if(a0==172&&a1>=16&&a1<=31)return true;
    if(a0==169&&a1==254)return true;
    if(a0==100&&a1>=64&&a1<=127)return true;
   }catch(NumberFormatException ignored){return true;}
  }
  return false;
 }

 /** 校验并规范化 URL。只放行 http/https 的公网地址。 */
 static URL checkUrl(String raw)throws Exception{
  String text=raw==null?"":raw.trim();
  if(text.isEmpty())throw new Exception("网址不能为空");
  if(!text.contains("://"))text="https://"+text;
  URL url;
  try{url=new URL(text);}catch(Exception e){throw new Exception("网址格式不对："+raw);}
  String protocol=url.getProtocol().toLowerCase(java.util.Locale.ROOT);
  if(!protocol.equals("http")&&!protocol.equals("https"))throw new Exception("只支持 http 和 https，不支持 "+protocol);
  if(isPrivate(url.getHost()))throw new Exception("出于安全考虑，不能访问本机和内网地址（"+url.getHost()+"）");
  return url;
 }

 /**
  * 从 Content-Type 里取字符集。
  *
  * <p>这一步不能省：国内很多站点还是 GBK/GB2312。按 UTF-8 解码会得到一片乱码，
  * 模型读到的就是垃圾，还会以为页面本身是坏的。
  */
 static Charset charsetOf(String contentType,String body){
  if(contentType!=null){
   Matcher m=Pattern.compile("charset=([A-Za-z0-9_\\-]+)",Pattern.CASE_INSENSITIVE).matcher(contentType);
   if(m.find()){
    try{return Charset.forName(m.group(1));}catch(Exception ignored){}
   }
  }
  // 没有声明就从 HTML 头部猜
  if(body!=null){
   Matcher m=Pattern.compile("charset=[\"']?([A-Za-z0-9_\\-]+)",Pattern.CASE_INSENSITIVE).matcher(body.substring(0,Math.min(2048,body.length())));
   if(m.find()){
    String cs=m.group(1).toLowerCase(java.util.Locale.ROOT);
    if(cs.equals("gb2312")||cs.equals("gbk"))return Charset.forName("GBK");
    try{return Charset.forName(cs);}catch(Exception ignored){}
   }
  }
  return StandardCharsets.UTF_8;
 }

 /** 读原始字节，超过硬上限就停。 */
 static byte[] readCapped(InputStream in,int cap)throws IOException{
  ByteArrayOutputStream out=new ByteArrayOutputStream();
  byte[] buf=new byte[8192];
  int n,total=0;
  while((n=in.read(buf))>0){
   total+=n;
   if(total>cap){out.write(buf,0,cap-(total-n));break;}
   out.write(buf,0,n);
  }
  return out.toByteArray();
 }

 /**
  * 把 HTML 转成能读的纯文本。
  *
  * <p>不用完整的 HTML 解析器（APK 体积 + 容错性都要考虑），
  * 而是做足够好的清洗：去脚本样式、块级标签转换行、去标签、解实体、压空白。
  * 目标是「模型能读懂内容」，不是「完美还原结构」。
  */
 static String htmlToText(String html){
  if(html==null)return "";
  String s=html;
  s=Pattern.compile("<script[^>]*>.*?</script>",Pattern.CASE_INSENSITIVE|Pattern.DOTALL).matcher(s).replaceAll(" ");
  s=Pattern.compile("<style[^>]*>.*?</style>",Pattern.CASE_INSENSITIVE|Pattern.DOTALL).matcher(s).replaceAll(" ");
  s=Pattern.compile("<noscript[^>]*>.*?</noscript>",Pattern.CASE_INSENSITIVE|Pattern.DOTALL).matcher(s).replaceAll(" ");
  s=Pattern.compile("<svg[^>]*>.*?</svg>",Pattern.CASE_INSENSITIVE|Pattern.DOTALL).matcher(s).replaceAll(" ");
  s=Pattern.compile("<!--.*?-->",Pattern.DOTALL).matcher(s).replaceAll(" ");
  // 块级元素前后断行，否则整页会挤成一行
  s=Pattern.compile("</?(p|div|br|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|pre|blockquote)[^>]*>",Pattern.CASE_INSENSITIVE).matcher(s).replaceAll("\n");
  s=Pattern.compile("<[^>]+>").matcher(s).replaceAll(" ");
  s=s.replace("&nbsp;"," ").replace("&amp;","&").replace("&lt;","<").replace("&gt;",">")
   .replace("&quot;","\"").replace("&#39;","'").replace("&apos;","'").replace("&mdash;","—").replace("&hellip;","…");
  // 数字实体
  Matcher m=Pattern.compile("&#(\\d+);").matcher(s);
  StringBuffer sb=new StringBuffer();
  while(m.find()){
   try{m.appendReplacement(sb,new String(Character.toChars(Integer.parseInt(m.group(1)))));}
   catch(Exception e){m.appendReplacement(sb," ");}
  }
  m.appendTail(sb);
  s=sb.toString();
  s=s.replaceAll("[ \\t\\x0B\\f\\r]+"," ");
  s=s.replaceAll(" ?\\n ?","\n");
  s=s.replaceAll("\\n{3,}","\n\n");
  return s.trim();
 }

 /**
  * 抓一个网址，返回纯文本。HTML 会转成文本，其他类型原样返回。
  *
  * <p><b>重定向必须手动跟。</b>如果用 {@code setInstanceFollowRedirects(true)}，
  * 只有第一次请求的地址会过安全检查 —— 一个公网页面只要 302 跳到
  * {@code http://192.168.1.1/}，就能绕过内网限制。所以这里关掉自动跳转，
  * 每一跳都重新走一遍 {@link #checkUrl}，并且限次防循环。
  */
 JSONObject fetch(String rawUrl)throws Exception{
  URL url=checkUrl(rawUrl);
  for(int hop=0;hop<MAX_REDIRECTS;hop++){
   HttpURLConnection c=(HttpURLConnection)url.openConnection();
   try{
    c.setConnectTimeout(15000);
    c.setReadTimeout(TIMEOUT);
    c.setInstanceFollowRedirects(false);          // 自己跟，每一跳都要查
    c.setRequestProperty("User-Agent","Mozilla/5.0 (Linux; Android 14) StepXStudio/1.0");
    c.setRequestProperty("Accept","text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8");
    int code=c.getResponseCode();

    if(code>=300&&code<400){
     String location=c.getHeaderField("Location");
     if(location==null||location.trim().isEmpty())throw new Exception("HTTP "+code+" 但服务端没给重定向地址");
     URL next=new URL(url,location.trim());       // 相对地址基于当前地址解析
     url=checkUrl(next.toString());                // 关键：每一跳都重新校验
     continue;
    }

    if(code<200||code>=400)throw new Exception("HTTP "+code+" "+c.getResponseMessage());
    String contentType=c.getContentType();
    byte[] bytes;
    try(InputStream in=c.getInputStream()){bytes=readCapped(in,RAW_CAP);}
    String charsetName=charsetOf(contentType,new String(bytes,0,Math.min(2048,bytes.length),StandardCharsets.ISO_8859_1)).name();
    String text=new String(bytes,Charset.forName(charsetName));
    boolean html=contentType!=null&&contentType.toLowerCase(java.util.Locale.ROOT).contains("html");
    String plain=html?htmlToText(text):text;
    boolean truncated=plain.length()>FETCH_CAP;
    if(truncated)plain=plain.substring(0,FETCH_CAP);
    return new JSONObject().put("url",url.toString()).put("status",code)
     .put("contentType",contentType==null?"":contentType)
     .put("charset",charsetName).put("format",html?"text":"raw")
     .put("redirects",hop).put("chars",plain.length())
     .put("truncated",truncated).put("content",plain);
   }finally{c.disconnect();}
  }
  throw new Exception("重定向超过 "+MAX_REDIRECTS+" 次，可能是循环跳转");
 }

 /** 当前配置的搜索服务。空表示没配。 */
 String provider(){return a.prefs.getString("searchProvider","").trim().toLowerCase(java.util.Locale.ROOT);}
 String searchKey(){return a.prefs.getString("searchKey","").trim();}

 boolean searchReady(){return !provider().isEmpty()&&!searchKey().isEmpty();}

 /**
  * 联网搜索。
  *
  * <p>搜索必须走第三方服务 —— 没有哪家搜索引擎会允许匿名程序化查询。
  * 所以这项能力依赖用户自己填一个密钥（Tavily 有免费额度，也可以填 Serper）。
  * 没配就明确说清楚怎么配，而不是静默降级成「搜不到」。
  */
 JSONObject search(String query,int limit)throws Exception{
  String q=query==null?"":query.trim();
  if(q.isEmpty())throw new Exception("搜索词不能为空");
  if(!searchReady())throw new Exception("还没有配置搜索服务。请在「AI 设置」里填搜索服务（tavily 或 serper）和对应的 Key，"
   +"没配置时只能用 web_fetch 直接抓已知网址");
  int n=Math.max(1,Math.min(SEARCH_LIMIT,limit<=0?5:limit));
  String prov=provider();

  if(prov.equals("tavily")){
   JSONObject body=new JSONObject().put("api_key",searchKey()).put("query",q)
    .put("max_results",n).put("include_answer",false).put("search_depth","basic");
   JSONObject r=postJson("https://api.tavily.com/search",body,null);
   JSONArray raw=r.optJSONArray("results");
   JSONArray out=new JSONArray();
   if(raw!=null)for(int i=0;i<raw.length()&&i<n;i++){
    JSONObject o1=raw.optJSONObject(i);
    if(o1==null)continue;
    out.put(new JSONObject().put("title",o1.optString("title")).put("url",o1.optString("url"))
     .put("snippet",trim(o1.optString("content"),600)));
   }
   return new JSONObject().put("query",q).put("provider",prov).put("results",out);
  }

  if(prov.equals("serper")){
   JSONObject body=new JSONObject().put("q",q).put("num",n);
   JSONObject r=postJson("https://google.serper.dev/search",body,searchKey());
   JSONArray out=new JSONArray();
   JSONArray organic=r.optJSONArray("organic");
   if(organic!=null)for(int i=0;i<organic.length()&&i<n;i++){
    JSONObject o1=organic.optJSONObject(i);
    if(o1==null)continue;
    out.put(new JSONObject().put("title",o1.optString("title")).put("url",o1.optString("link"))
     .put("snippet",trim(o1.optString("snippet"),600)));
   }
   JSONObject answer=r.optJSONObject("answerBox");
   JSONObject extra=new JSONObject();
   if(answer!=null)extra.put("answerBox",new JSONObject().put("title",answer.optString("title")).put("answer",trim(answer.optString("answer"),800)));
   return new JSONObject().put("query",q).put("provider",prov).put("results",out).put("extra",extra);
  }

  throw new Exception("不认识的搜索服务："+prov+"（只支持 tavily 或 serper）");
 }

 static String trim(String s,int cap){
  String t=s==null?"":s.trim();
  return t.length()>cap?t.substring(0,cap)+"…":t;
 }

 /** 发一个 JSON POST，读回 JSON。 */
 JSONObject postJson(String url,JSONObject body,String bearer)throws Exception{
  HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();
  try{
   c.setRequestMethod("POST");
   c.setDoOutput(true);
   c.setConnectTimeout(15000);
   c.setReadTimeout(TIMEOUT);
   c.setRequestProperty("Content-Type","application/json; charset=utf-8");
   if(bearer!=null&&!bearer.isEmpty())c.setRequestProperty("X-API-KEY",bearer);
   byte[] payload=body.toString().getBytes(StandardCharsets.UTF_8);
   c.setFixedLengthStreamingMode(payload.length);
   try(OutputStream out=c.getOutputStream()){out.write(payload);}
   int code=c.getResponseCode();
   InputStream in=code>=400?c.getErrorStream():c.getInputStream();
   String text=in==null?"":new String(readCapped(in,RAW_CAP),StandardCharsets.UTF_8);
   if(code<200||code>=400)throw new Exception("搜索服务返回 HTTP "+code+"："+trim(text,300));
   return new JSONObject(text);
  }finally{c.disconnect();}
 }
}
