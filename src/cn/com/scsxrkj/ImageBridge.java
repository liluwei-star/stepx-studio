package cn.com.scsxrkj;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import java.io.*;

/**
 * 把用户选中的图片读成可以直接塞进对话的 data URL。
 *
 * <p>为什么要压缩，不能原图直传：
 * 手机拍的照片动辄 3-8 MB，base64 之后还要再涨 1/3。
 * 一张图就能把请求体撑到十几兆，慢、贵、而且未必传得上去。
 * 视觉模型本身也会把图缩到一两千像素再处理，传原始尺寸是纯浪费。
 *
 * <p>所以这里的策略是两级降采样：
 * <ol>
 *   <li>先只读图片头拿尺寸（{@code inJustDecodeBounds}），算出一个采样率，
 *       解码时直接跳过像素 —— 这一步能把 8 MB 的图读成几百 KB，
 *       而且不会因为中间过程把内存撑爆</li>
 *   <li>再把长边精确缩到 {@link #MAX_SIDE}，质量 85 输出 JPEG</li>
 * </ol>
 * 如果这样还是太大，就再降一次质量。
 *
 * <p><b>注意不处理 EXIF 旋转</b>：主要用例是用户截屏后从相册选图，
 * 截图没有方向标记。为了处理横竖拍的照片去引一个额外依赖，
 * 换来的收益不划算 —— 真需要的时候再加。
 */
final class ImageBridge {
 /**
  * 长边上限。
  *
  * <p>视觉模型那边 1568 是常见的经济尺寸，但这里压到 1280 是有原因的：
  * 压完的图要转成 base64 再通过 {@code evaluateJavascript} 交回前端，
  * 1568 的图 base64 之后有 400-700 KB，这么大的字符串走 JS 桥会明显卡顿，
  * 极端情况下还会失败。1280 对截图里的文字仍然够清楚，
  * 传回去的体积少了将近一半。
  */
 static final int MAX_SIDE=1280;
 /**
  * 输出体积的硬上限。超过就降质量重压。
  *
  * <p>不是按「磁盘能存多少」定的，是按「JS 桥一次能舒服地传多少」定的。
  */
 static final int BYTES_CAP=1500*1024;

 private ImageBridge(){}

 /**
  * 读一张图，返回 {@code data:image/jpeg;base64,...}。
  *
  * @throws Exception 图读不出来、或者格式不支持
  */
 static String readAsDataUrl(Context context,Uri uri)throws Exception{
  InputStream probe=null;
  BitmapFactory.Options bounds=new BitmapFactory.Options();
  bounds.inJustDecodeBounds=true;
  try{
   probe=context.getContentResolver().openInputStream(uri);
   if(probe==null)throw new Exception("打不开这张图");
   BitmapFactory.decodeStream(probe,null,bounds);
  }finally{closeQuietly(probe);}

  if(bounds.outWidth<=0||bounds.outHeight<=0)throw new Exception("这张图读不出尺寸，可能不是图片文件");

  // 算采样率：解码时就跳过像素，比先解全图再缩省一个数量级的内存
  int sample=1;
  int longest=Math.max(bounds.outWidth,bounds.outHeight);
  while(longest/(sample*2)>=MAX_SIDE)sample*=2;

  BitmapFactory.Options opts=new BitmapFactory.Options();
  opts.inSampleSize=sample;
  opts.inPreferredConfig=Bitmap.Config.ARGB_8888;
  Bitmap bitmap;
  InputStream in=null;
  try{
   in=context.getContentResolver().openInputStream(uri);
   if(in==null)throw new Exception("打不开这张图");
   bitmap=BitmapFactory.decodeStream(in,null,opts);
  }finally{closeQuietly(in);}
  if(bitmap==null)throw new Exception("这张图解码失败，可能格式不受支持（HEIC 等）");

  try{
   int w=bitmap.getWidth(),h=bitmap.getHeight();
   int longEdge=Math.max(w,h);
   if(longEdge>MAX_SIDE){
    float scale=(float)MAX_SIDE/longEdge;
    Bitmap scaled=Bitmap.createScaledBitmap(bitmap,Math.max(1,Math.round(w*scale)),Math.max(1,Math.round(h*scale)),true);
    if(scaled!=bitmap){bitmap.recycle();bitmap=scaled;}
   }

   byte[] jpeg=compress(bitmap,85);
   if(jpeg.length>BYTES_CAP)jpeg=compress(bitmap,70);
   if(jpeg.length>BYTES_CAP)jpeg=compress(bitmap,55);
   if(jpeg.length>BYTES_CAP)jpeg=compress(bitmap,40);
   if(jpeg.length>BYTES_CAP)throw new Exception("这张图压缩后仍有 "+(jpeg.length/1024)+" KB，太大了");

   String encoded=Base64.encodeToString(jpeg,Base64.NO_WRAP);
   return "data:image/jpeg;base64,"+encoded;
  }finally{
   if(bitmap!=null&&!bitmap.isRecycled())bitmap.recycle();
  }
 }

 static byte[] compress(Bitmap bitmap,int quality)throws IOException{
  ByteArrayOutputStream out=new ByteArrayOutputStream();
  if(!bitmap.compress(Bitmap.CompressFormat.JPEG,quality,out))throw new IOException("图片压缩失败");
  return out.toByteArray();
 }

 static void closeQuietly(Closeable c){if(c!=null)try{c.close();}catch(Exception ignored){}}
}
