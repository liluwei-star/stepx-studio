package cn.com.scsxrkj;
import android.content.Context;
import android.graphics.*;
import android.security.keystore.*;
import org.json.*;
import com.android.apksig.ApkSigner;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.zip.*;
import javax.security.auth.x500.X500Principal;

/**
 * 手机端离线出包：把纯前端项目编译成可安装的 APK。
 *
 * <p>整个过程完全在这台手机上完成：解包运行壳模板 → 换掉前端资源 →
 * 改包名和版本号 → 用内置密钥签名 → 打包成 APK。不需要电脑、不需要联网。
 *
 * <p>三个可配置项：
 * <ul>
 *   <li><b>自定义包名</b>：留空则自动生成 {@code com.scsxrkj.app.<项目id>}。
 *       用户填的包名会按 Android 规范校验：至少两段、每段以字母开头、
 *       不能占用 android / com.android / com.google / com.stepos 等保留前缀</li>
 *   <li><b>最小权限模板</b>：勾选后只声明联网权限，适合提交应用市场</li>
 *   <li><b>版本号</b>：每次构建编号自动 +1</li>
 * </ul>
 *
 * <p>签名用的是 {@code ~/.neo-signing/neo-release.p12}，minSdk 24，
 * 自动选 v1+v2+v3 全部签名方案，兼容 Android 7 到最新版本。
 */
final class OfflineBuilder {

 /** 自定义包名：为空则返回空串，让调用方走自动生成。校验 Android 包名规范。 */
 static String customPackage(JSONObject p)throws Exception{
  String pkg=p.optString("pkg","").trim();
  if(pkg.isEmpty())return "";
  if(pkg.length()>100)throw new Exception("自定义包名过长（上限 100 字符）");
  if(!pkg.matches("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+"))
   throw new Exception("自定义包名不合法：每段必须以字母开头，只能含字母/数字/下划线，至少两段。例如 cn.example.myapp");
  String lower=pkg.toLowerCase(Locale.ROOT);
  for(String bad:new String[]{"android","com.android","com.google","com.stepos","stepx"})
   if(lower.equals(bad)||lower.startsWith(bad+"."))
    throw new Exception("自定义包名不能使用保留前缀："+bad);
  return pkg;
 }

 /**
  * 打包内容的体积上限。
  *
  * <p>原来是单文件 8 MB、合计 16 MB —— 那个上限是按「纯前端小项目」定的，
  * 但真实的项目会带本地语音识别模型（一个 paraformer 就 78 MB），
  * 16 MB 把它们全挡在门外，等于这个 App 永远出不了包。
  *
  * <p>现在放到 250 MB，配合下面的流式写入，内存占用和文件大小无关。
  */
 static final long MAX_ONE_FILE=100L*1024*1024;
 static final long MAX_TOTAL=250L*1024*1024;

 /**
  * 判断项目是不是「已经构建好的产物」。
  *
  * <p>为什么需要这个判断：本机编译器（{@link LocalCompiler}）是给源码工程用的，
  * 它要把 TSX/模块打包成一个 HTML，产物上限 16 MB。但真实项目往往是在电脑上
  * 用 npm run build 构建好、把 dist 整个导进来的 —— 那些文件已经是 .js 了，
  * 再编译一遍不但没必要，还会撞上限、白等几分钟。
  *
  * <p>判据：入口 HTML 里有没有引用 src/ 下的 .ts/.tsx/.jsx。
  * 有就是源码工程，得编译；没有就是现成产物，直接打包。
  *
  * @param p 项目对象
  * @return true 表示可以跳过编译直接打包
  */
 static boolean isStaticProject(JSONObject p){
  try{
   JSONObject f=p.optJSONObject("files");
   if(f==null||!f.has("index.html"))return false;
   String html=f.optString("index.html","");
   return !java.util.regex.Pattern.compile("(?is)[\"'](?:\\./|/)?src/[^\"']*\\.(?:tsx?|jsx?)['\"]").matcher(html).find();
  }catch(Exception e){return false;}
 }

 /**
  * 把磁盘上的文件流式写进 APK。
  *
  * <p>为什么不复用 {@link #put}：那个方法要一个完整的 {@code byte[]}，
  * 因为 APK 里的 STORED 条目必须预先写死长度和 CRC32，而算 CRC 要读完整份内容。
  * 一个 78 MB 的模型读进 byte[]，手机上直接 OutOfMemory。
  *
  * <p>这里改成两遍流式读取：第一遍只算 CRC32，第二遍才真正写。
  * 两遍都用 64 KB 缓冲，峰值内存和文件大小无关 —— 100 MB 的文件也只占 64 KB。
  *
  * @param o   目标 ZIP 输出流
  * @param n   APK 内的路径
  * @param src 磁盘上的源文件
  */
 static void putFile(ZipOutputStream o,String n,File src)throws Exception{
  long size=src.length();
  CRC32 crc=new CRC32();
  try(java.io.FileInputStream in=new java.io.FileInputStream(src)){
   byte[]buf=new byte[65536];int r;
   while((r=in.read(buf))!=-1)crc.update(buf,0,r);
  }
  ZipEntry e=new ZipEntry(n);
  e.setTime(315532800000L);
  e.setMethod(ZipEntry.STORED);
  e.setSize(size);
  e.setCompressedSize(size);
  e.setCrc(crc.getValue());
  long offset=((AlignedZip)o).counter.count+30+n.getBytes(StandardCharsets.UTF_8).length+4;
  int pad=(int)((4-offset%4)%4);
  byte[]extra=new byte[4+pad];extra[0]=(byte)0xfe;extra[1]=(byte)0xca;extra[2]=(byte)pad;
  e.setExtra(extra);
  o.putNextEntry(e);
  try(java.io.FileInputStream in=new java.io.FileInputStream(src)){
   byte[]buf=new byte[65536];int r;
   while((r=in.read(buf))!=-1)o.write(buf,0,r);
  }
  o.closeEntry();
 }

static JSONObject build(MainActivity c,JSONObject p,int number)throws Exception{
  // 已构建好的产物不走本机编译器：省几分钟，也不撞 16 MB 的编译上限。
  final boolean staticBuild=isStaticProject(p);
  JSONObject compiled=null,outputFiles;
  final LinkedHashMap<String,File> bigFiles=new LinkedHashMap<>();
  if(staticBuild){
   outputFiles=new JSONObject();
   JSONObject f=p.getJSONObject("files");
   for(Iterator<String> it=f.keys();it.hasNext();){String n=it.next();outputFiles.put(n,new JSONObject().put("encoding","utf8").put("content",f.getString(n)));}
   JSONObject bins=p.optJSONObject("binaryFiles");
   if(bins!=null)for(Iterator<String> it=bins.keys();it.hasNext();){
    String n=it.next(),ref=bins.getString(n);
    if(ref.endsWith(".bin")){
     // 大文件留在磁盘上，写 APK 时流式拷贝 —— 不读进内存
     File src=new File(new File(c.getFilesDir(),"project-files"),ref);
     if(!src.isFile())throw new Exception("大文件缺失，请重新同步或导入："+n);
     bigFiles.put(n,src);
    }else{
     outputFiles.put(n,new JSONObject().put("encoding","base64").put("content",ref));
    }
   }
  }else{
   // 源码工程：编译产物只有 JS/CSS/HTML，
   // 但 public/ 下的资源（图片、模型、worker）不进编译产物 ——
   // 它们是运行时按原路径加载的，必须原样带进 APK。
   compiled=LocalCompiler.compile(c,p);
   outputFiles=compiled.getJSONObject("files");
   // 资源要在编译产物之后再收集 —— 目标路径已存在时不覆盖编译结果
   collectPublicAssets(p,bigFiles,outputFiles,c.getFilesDir());
   // 静态资源收集结果记到日志：模型有没有真的进包，只看 APK 体积猜不准
   try{
    long bigTotal=0;
    for(java.util.Map.Entry<String,File> en:bigFiles.entrySet())bigTotal+=en.getValue().length();
    android.util.Log.i("NeoBuild","assets bigFiles="+bigFiles.size()+" bytes="+bigTotal+" outputFiles="+outputFiles.length());
    for(java.util.Map.Entry<String,File> en:bigFiles.entrySet())
     android.util.Log.i("NeoBuild","  big "+en.getKey()+" "+en.getValue().length());
   }catch(Exception ignored){}
  }
  validateOutput(outputFiles,bigFiles);
  String id=p.getString("id");if(!id.matches("[a-zA-Z0-9_-]{1,100}"))throw new Exception("项目 ID 不适合打包");String pkg=customPackage(p);if(pkg.isEmpty()){String suffix=id.replaceAll("[^a-zA-Z0-9]","").toLowerCase(Locale.ROOT);if(suffix.length()<20)suffix=UUID.nameUUIDFromBytes(id.getBytes(StandardCharsets.UTF_8)).toString().replace("-", "");suffix=suffix.substring(0,19);if(!Character.isLetter(suffix.charAt(0)))suffix="p"+suffix;pkg="com.scsxrkj.app."+suffix;}String version="0.1."+(number-1);String template=p.optBoolean("minPermissions",false)?"runtime-template-min.apk":"runtime-template.apk";
  File dir=new File(c.getFilesDir(),"builds");dir.mkdirs();File unsigned=new File(dir,id+"-unsigned.apk"),output=new File(dir,id+"-"+number+".apk");
  JSONObject files=p.getJSONObject("files");if(files.has("neo-matrix.json"))cn.com.scsxrkj.matrix.MatrixSpec.parse(files.getString("neo-matrix.json"));if(!files.has("index.html"))throw new Exception("项目缺少 index.html");
  try(ZipInputStream in=new ZipInputStream(c.getAssets().open(template));ZipOutputStream out=new AlignedZip(new Counter(new FileOutputStream(unsigned)))){
   ZipEntry entry;while((entry=in.getNextEntry())!=null){String n=entry.getName();if(n.startsWith("META-INF/")||entry.isDirectory())continue;byte[] b=MainActivity.readLimited(in,4*1024*1024);if(n.equals("AndroidManifest.xml"))b=manifest(b,pkg,p.optString("name","App"),version,number);if(n.equals("res/drawable/icon.png"))b=icon(p.optString("name","Neo"));put(out,n,b);}
   for(Iterator<String> it=outputFiles.keys();it.hasNext();){String n=it.next();put(out,"assets/project/"+n,CloudFiles.bytes(outputFiles.getJSONObject(n)));}
   // 大文件（模型分片、wasm、打包好的 js）流式写，峰值内存只有 64 KB 一块
   for(Map.Entry<String,File> en:bigFiles.entrySet())putFile(out,"assets/project/"+en.getKey(),en.getValue());
   // 内置依赖要打进 APK —— 否则生成的 App 里那些
   // import "/__vendor/m0.js" 会全部 404，页面一片白。
   //
   // 带哪些：编译产物里实际引用到的（compiled.libraries）+ 静态产物模式下全带。
   // 静态产物没法统计引用（产物里已经是编译好的 js），只能全带 ——
   // 反正总共才 16 MB，比漏一个导致白屏划算得多。
   Set<String> names=new TreeSet<>();
   JSONObject manifest;try(InputStream v=c.getAssets().open("local-vendor/manifest.json")){manifest=new JSONObject(new String(MainActivity.readLimited(v,1024*1024),StandardCharsets.UTF_8));}
   if(compiled!=null&&compiled.optJSONArray("libraries")!=null&&compiled.getJSONArray("libraries").length()>0){
    for(Iterator<String>it=manifest.keys();it.hasNext();)names.add(manifest.getJSONObject(it.next()).getString("file"));
   }else{
    for(Iterator<String>it=manifest.keys();it.hasNext();)names.add(manifest.getJSONObject(it.next()).getString("file"));
   }
   names.add("LICENSES.txt");
   for(String n:names){if(!CloudFiles.path(n))throw new Exception("内置依赖路径无效");try(InputStream v=c.getAssets().open("local-vendor/"+n)){put(out,"assets/project/__vendor/"+n,MainActivity.readLimited(v,4*1024*1024));}}
   put(out,"assets/project.json",new JSONObject().put("id",id).put("name",p.optString("name")).put("version",version).toString().getBytes(StandardCharsets.UTF_8));
  }
  KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);String alias="neo-offline-apk-signing";
  if(!ks.containsAlias(alias)){KeyPairGenerator g=KeyPairGenerator.getInstance("RSA","AndroidKeyStore");g.initialize(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_SIGN|KeyProperties.PURPOSE_VERIFY).setKeySize(2048).setDigests(KeyProperties.DIGEST_SHA256,KeyProperties.DIGEST_SHA512).setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1).setCertificateSubject(new X500Principal("CN=StepX Studio")).setCertificateSerialNumber(java.math.BigInteger.ONE).setCertificateNotBefore(new Date(0)).setCertificateNotAfter(new Date(4102444800000L)).build());g.generateKeyPair();}
  PrivateKey key=(PrivateKey)ks.getKey(alias,null);X509Certificate certificate=(X509Certificate)ks.getCertificate(alias);
  // 签名方案必须和 APK 自己声明的 minSdk 对齐。
  //
  // 这里原来写死 setMinSdkVersion(30) 且关掉 v1，结果是：APK 声明能装到 Android 7（minSdk 24），
  // 但签名只有 v2/v3 —— Android 7 只认 v1/v2，装上去直接报「解析包时出现问题」。
  // 应用市场做兼容性检测时也会因为「签名方案与 minSdk 不匹配」打回。
  //
  // 现在按 minSdk 24 生成 v1+v2+v3 全套：v1 兜住 Android 7，v2/v3 给新系统做完整性校验。
  ApkSigner.SignerConfig signer=new ApkSigner.SignerConfig.Builder("neo-local",key,Collections.singletonList(certificate)).build();
  try{new ApkSigner.Builder(Collections.singletonList(signer)).setInputApk(unsigned).setOutputApk(output).setMinSdkVersion(24).setV1SigningEnabled(true).setV2SigningEnabled(true).setV3SigningEnabled(true).setV4SigningEnabled(false).build().sign();}finally{unsigned.delete();}
  MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(output)){byte[]b=new byte[8192];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format(Locale.ROOT,"%02x",b&255));
  return new JSONObject().put("number",number).put("version",version).put("package",pkg).put("file",output.getName()).put("bytes",output.length()).put("sha256",hash.toString()).put("time",System.currentTimeMillis()).put("route","offline-device").put("compiled",true).put("compilerNote",compiled==null?(staticBuild?"已构建产物，直接打包":"") :compiled.optString("note")).put("libraries",compiled==null?new JSONArray():compiled.optJSONArray("libraries"));
 }
 

 /**
  * 收集要「原样带进 APK」的资源。
  *
  * <p><b>为什么要单独处理</b>
  *
  * <p>Vite 这类构建工具的规矩：{@code public/} 下的文件在构建时<b>原样拷到产物根目录</b>，
  * 不参与打包也不改内容。源码里有 {@code public/asr/sherpa/x.wasm.gz}，
  * 构建后它就在产物的 {@code asr/sherpa/x.wasm.gz}。
  *
  * <p>本机编译器只处理 JS/CSS/HTML，不碰 public/ ——
  * 结果就是 public/ 下的图片、字体、模型全都不在 APK 里，运行时按原路径加载就 404。
  *
  * <p><b>模型尤其要小心</b>
  *
  * <p>语音识别权重 79 MB，切成 20 片。走编译通道（evaluateJavascript 传 JSON）
  * 峰值内存会超过 300 MB，手机会被系统直接杀掉。
  * 所以这类文件一律从项目<b>流式拷贝</b>，内存占用与文件大小无关。
  *
  * @param p        项目对象
  * @param bigFiles 出参：大文件映射（产物路径 → 磁盘文件）
  * @param filesDir 应用私有目录
  */
 /** 项目路径 → 产物根路径；返回 null 表示不进产物。
  *
  * <p>三条来源，都落到产物根：
  * <ul>
  *   <li>{@code public/} —— 去掉前缀，这是 Vite 的规矩</li>
  *   <li>{@code public/asr/} —— 连 asr/ 一起去掉。运行时代码按
  *       {@code {页面根}/models/}、{@code {页面根}/sherpa/} 找模型，
  *       中间的 asr/ 是平台部署结构，App 里没有这一层</li>
  *   <li>{@code dist/client/web/asr/} —— 同理。平台把模型切片写在这里</li>
  * </ul>
  *
  * <p>用最长前缀匹配：先判 asr/ 系列，再判通用的 public/，
  * 否则 {@code public/asr/x} 会被当成 {@code asr/x}。
  */
 static String assetDest(String n){
  /*
   * 只剥掉打包工具自己的前缀，其余原样保留。
   *
   *   public/xxx            → xxx          （Vite 的规矩：public 下的内容拷到产物根）
   *   public/asr/xxx        → asr/xxx
   *   dist/client/web/asr/xxx → asr/xxx
   *
   * 这里最容易搞错的是 asr 那一层。运行时代码的默认 base 是 './asr/'，
   * 探测的候选是 {页面根}/asr/、{页面根}/web/asr/、/aiapp/asr/、/aiapp/web/asr/，
   * 所以模型和 wasm 必须落在产物根的 asr/ 下面。
   *
   * 曾经把 asr/ 也一起剥掉，模型放进了 models/ 和 sherpa/ ——
   * 文件都在包里，运行时却一路 404，报「安装包里没找到本地识别模型」。
   * 这种错最难查：体积正常、体检正常、就是跑不起来。
   */
  if(n.startsWith(DIST_WEB))return n.substring(DIST_WEB.length());
  if(n.startsWith("public/"))return n.substring("public/".length());
  return null;
 }
 /** 平台把成品写在这里，这一层是打包工具自己的，要剥掉。 */
 static final String DIST_WEB="dist/client/web/";

 /**
  * 收集要「原样带进 APK」的静态资源。
  *
  * <p>本机编译器只处理 JS/CSS/HTML，不碰 public/ —— 资源得单独带。
  *
  * <p>文本资源也要带：模型目录里的 {@code chunks.json}（记录每片字节数）
  * 和 {@code tokens.txt}（词表）都是文本，少了它们，20 个分片齐全也读不起来。
  *
  * @param bigFiles    出参：大文件映射（产物路径 → 磁盘文件），流式拷贝不进内存
  * @param outputFiles 出参：文本与 base64 小文件
  */
 static void collectPublicAssets(JSONObject p,Map<String,File> bigFiles,JSONObject outputFiles,File filesDir){
  try{
   JSONObject files=p.optJSONObject("files");
   JSONObject bins=p.optJSONObject("binaryFiles");
   if(files==null)return;
   File bigDir=new File(filesDir,"project-files");
   /*
    * 必须同时扫两个集合：大文件只存在 binaryFiles 里，不在 files 里。
    * 只遍历 files 的话，78 MB 的模型分片一个都抓不到 ——
    * 表现就是 APK 建出来只有几 MB，装上去识别不了。
    */
   if(bins!=null)for(Iterator<String> it=bins.keys();it.hasNext();){
    String n=it.next();
    String dest=assetDest(n);
    if(dest==null||dest.isEmpty()||!CloudFiles.path(dest))continue;
    if(bigFiles.containsKey(dest)||outputFiles.has(dest))continue;
    String ref=bins.getString(n);
    if(ref.endsWith(".bin")){
     File src=new File(bigDir,ref);
     if(src.isFile())bigFiles.put(dest,src);
    }else if(ref.length()<2000000){
     outputFiles.put(dest,new JSONObject().put("encoding","base64").put("content",ref));
    }
   }
   for(Iterator<String> it=files.keys();it.hasNext();){
    String n=it.next();
    if(bins!=null&&bins.has(n))continue;
    String dest=assetDest(n);
    if(dest==null||dest.isEmpty()||!CloudFiles.path(dest))continue;
    if(bigFiles.containsKey(dest)||outputFiles.has(dest))continue;
    Object raw=files.get(n);
    if(raw instanceof String){
     outputFiles.put(dest,new JSONObject().put("encoding","utf8").put("content",(String)raw));
    }
   }
  }catch(Exception ignored){
   // 收集失败不阻断构建：资源缺失最多是模型用不了，不该让整个构建挂掉
  }
 }
 /**
  * 检查要打进 APK 的内容能不能打。
  *
  * <p>体积上限放到单文件 100 MB、合计 250 MB。原来的 8 MB / 16 MB
  * 是按纯前端小项目定的，带本地模型的项目永远过不去。
  *
  * <p>大文件（磁盘上的）单独统计体积，不算进 JSON 条目里 ——
  * 它们不占内存，只占磁盘和 APK 体积。
  *
  * @param entries  内存里的条目（文本、base64 小二进制）
  * @param bigFiles 磁盘上的大文件
  */
 static void validateOutput(JSONObject entries,Map<String,File> bigFiles)throws Exception{
  final int bigCount=bigFiles==null?0:bigFiles.size();
  if(!entries.has("index.html")&&bigCount==0)throw new Exception("打包内容缺少 index.html 入口");
  if(entries.length()+bigCount>3000)throw new Exception("打包文件过多："+(entries.length()+bigCount)+" 个，上限 3000");
  long total=0;
  for(Iterator<String>it=entries.keys();it.hasNext();){
   String n=it.next();
   if(!CloudFiles.path(n)||CloudFiles.excluded(n)||n.equals("neo-runtime.js")||n.startsWith("__vendor/"))throw new Exception("文件路径不适合打包："+n);
   byte[] b=CloudFiles.bytes(entries.getJSONObject(n));
   total+=b.length;
   if(b.length>MAX_ONE_FILE)throw new Exception("单个文件超过 100 MB："+n);
  }
  if(bigFiles!=null)for(Map.Entry<String,File> en:bigFiles.entrySet()){
   String n=en.getKey();
   if(!CloudFiles.path(n)||CloudFiles.excluded(n)||n.equals("neo-runtime.js")||n.startsWith("__vendor/"))throw new Exception("文件路径不适合打包："+n);
   long len=en.getValue().length();
   total+=len;
   if(len>MAX_ONE_FILE)throw new Exception("单个文件超过 100 MB："+n);
  }
  if(total>MAX_TOTAL)throw new Exception("打包内容合计 "+(total/1048576)+" MB，超过 250 MB 上限");
 }
 static final class Counter extends FilterOutputStream {long count;Counter(OutputStream o){super(o);}public void write(int b)throws IOException{out.write(b);count++;}public void write(byte[]b,int off,int len)throws IOException{out.write(b,off,len);count+=len;}}
 static final class AlignedZip extends ZipOutputStream {final Counter counter;AlignedZip(Counter c){super(c);counter=c;}}
 static void put(ZipOutputStream o,String n,byte[] b)throws Exception{ZipEntry e=new ZipEntry(n);e.setTime(315532800000L);e.setMethod(ZipEntry.STORED);e.setSize(b.length);e.setCompressedSize(b.length);CRC32 crc=new CRC32();crc.update(b);e.setCrc(crc.getValue());long offset=((AlignedZip)o).counter.count+30+n.getBytes(StandardCharsets.UTF_8).length+4;int pad=(int)((4-offset%4)%4);byte[]extra=new byte[4+pad];extra[0]=(byte)0xfe;extra[1]=(byte)0xca;extra[2]=(byte)pad;e.setExtra(extra);o.putNextEntry(e);o.write(b);o.closeEntry();}
 static byte[] icon(String name)throws Exception{Bitmap b=Bitmap.createBitmap(192,192,Bitmap.Config.ARGB_8888);Canvas c=new Canvas(b);Paint p=new Paint(3);p.setShader(new LinearGradient(0,0,192,192,new int[]{0xffe6edf2,0xff465660,0xffb6c7cc},null,Shader.TileMode.CLAMP));c.drawRoundRect(0,0,192,192,40,40,p);p.setShader(new LinearGradient(0,15,0,177,new int[]{0xff175f58,0xff072c31,0xff147b70},null,Shader.TileMode.CLAMP));c.drawRoundRect(13,13,179,179,30,30,p);p.setShader(null);p.setColor(0x50ffffff);c.drawRoundRect(20,20,172,90,23,23,p);p.setColor(Color.WHITE);p.setTextAlign(Paint.Align.CENTER);p.setTypeface(Typeface.create("sans-serif",Typeface.BOLD));p.setTextSize(68);String text=name.replace("Neo","").trim();if(text.isEmpty())text="N";c.drawText(text.substring(0,Math.min(2,text.length())),96,124,p);ByteArrayOutputStream o=new ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.PNG,100,o);b.recycle();return o.toByteArray();}
 static int i(byte[]b,int n){return ByteBuffer.wrap(b,n,4).order(ByteOrder.LITTLE_ENDIAN).getInt();}
 static int h(byte[]b,int n){return ByteBuffer.wrap(b,n,2).order(ByteOrder.LITTLE_ENDIAN).getShort()&65535;}
 static void putI(byte[]b,int n,int v){ByteBuffer.wrap(b,n,4).order(ByteOrder.LITTLE_ENDIAN).putInt(v);}
 static void le(ByteArrayOutputStream o,int v){o.write(v&255);o.write(v>>>8&255);o.write(v>>>16&255);o.write(v>>>24&255);}
 static int[] len8(byte[]b,int n){int x=b[n++]&255;return (x&128)==0?new int[]{x,n}:new int[]{((x&127)<<8)|(b[n++]&255),n};}
 static int[] len16(byte[]b,int n){int x=h(b,n);n+=2;return(x&32768)==0?new int[]{x,n}:new int[]{((x&32767)<<16)|h(b,n),n+2};}
 static void length8(ByteArrayOutputStream o,int n)throws Exception{if(n>32767)throw new Exception("Manifest 字符串过长");if(n>127)o.write((n>>8)|128);o.write(n&255);}
 static byte[] manifest(byte[]src,String pkg,String name,String version,int number)throws Exception{
  if(h(src,0)!=3)throw new Exception("模板 Manifest 无效");ByteArrayOutputStream chunks=new ByteArrayOutputStream();List<String> names=new ArrayList<>();
  for(int at=h(src,2);at<src.length;){int type=h(src,at),size=i(src,at+4);if(size<8||at+size>src.length)throw new Exception("模板块长度无效");byte[]chunk=Arrays.copyOfRange(src,at,at+size);
   if(type==1){int count=i(chunk,8),styleCount=i(chunk,12),flags=i(chunk,16),start=i(chunk,20),header=h(chunk,2);if(styleCount!=0)throw new Exception("不支持带样式的模板字符串池");ByteArrayOutputStream data=new ByteArrayOutputStream();int[] offsets=new int[count];
    for(int x=0;x<count;x++){int pos=start+i(chunk,header+4*x);String s;if((flags&256)!=0){int[]a=len8(chunk,pos),b=len8(chunk,a[1]);s=new String(chunk,b[1],b[0],StandardCharsets.UTF_8);}else{int[]a=len16(chunk,pos);s=new String(chunk,a[1],a[0]*2,StandardCharsets.UTF_16LE);}names.add(s);if(s.equals("cn.com.scsxrkj.template"))s=pkg;if(s.equals("NEO_TEMPLATE_TITLE"))s=name;if(s.equals("0.1.TEMPLATE"))s=version;offsets[x]=data.size();byte[]u=s.getBytes(StandardCharsets.UTF_8);length8(data,s.length());length8(data,u.length);data.write(u);data.write(0);}
    while(data.size()%4!=0)data.write(0);ByteArrayOutputStream pool=new ByteArrayOutputStream();le(pool,0x001c0001);le(pool,28+count*4+data.size());le(pool,count);le(pool,0);le(pool,256);le(pool,28+count*4);le(pool,0);for(int off:offsets)le(pool,off);pool.write(data.toByteArray());chunk=pool.toByteArray();
   }else if(type==0x0102){int start=16+h(chunk,24),width=h(chunk,26),count=h(chunk,28);for(int x=0;x<count;x++){int pos=start+x*width;int index=i(chunk,pos+4);if(index>=0&&index<names.size()&&names.get(index).equals("versionCode"))putI(chunk,pos+16,number);}}
   chunks.write(chunk);at+=size;
  }
  ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(Arrays.copyOf(src,8));out.write(chunks.toByteArray());byte[]result=out.toByteArray();putI(result,4,result.length);return result;
 }
}
