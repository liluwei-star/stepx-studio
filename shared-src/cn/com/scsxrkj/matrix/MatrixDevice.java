package cn.com.scsxrkj.matrix;
import android.content.Context;import android.os.Bundle;import java.lang.reflect.*;import org.json.*;
/**
 * STEPX Neo 背屏硬件的原生接口封装。
 *
 * <p>用反射去调系统才有的接口，所以设备不支持时能优雅降级（{@link #available} 返回 false），
 * 不会因为找不到类就崩溃。
 *
 * <p>不申请隐藏 API 豁免、不越权授予权限、不改 Binder 身份。
 */
public final class MatrixDevice {
 final Context context;final Object manager;final Method set,clear;boolean submitted;
 public MatrixDevice(Context c)throws Exception{context=c.getApplicationContext();manager=c.getSystemService("display_ext");if(manager==null)throw new Exception("当前固件未提供 Neo 原生背屏服务");Class<?> cls=manager.getClass();set=cls.getMethod("setBackScreenAgentFrame",int[].class,Bundle.class);clear=cls.getMethod("clearBackScreenAgentFrame");}
 public static boolean available(Context c){try{new MatrixDevice(c);return true;}catch(Exception e){return false;}}
 public void prepare(boolean keepLit)throws Exception{
  if(!((Boolean)manager.getClass().getMethod("isBackScreenEnabled").invoke(manager)))throw new Exception("请先在系统设置开启背屏显示");
  if(keepLit){int prior=(Integer)manager.getClass().getMethod("getBackScreenDisplayMode").invoke(manager);if(prior!=1){if(!context.getSharedPreferences("matrix-display-restore",0).edit().putInt("mode",prior).commit())throw new Exception("无法保存原背屏设置");manager.getClass().getMethod("setBackScreenDisplayMode",int.class).invoke(manager,1);}}
 }
 public void restore()throws Exception{android.content.SharedPreferences p=context.getSharedPreferences("matrix-display-restore",0);if(!p.contains("mode"))return;int mode=(Integer)manager.getClass().getMethod("getBackScreenDisplayMode").invoke(manager);if(mode==1)manager.getClass().getMethod("setBackScreenDisplayMode",int.class).invoke(manager,p.getInt("mode",0));p.edit().clear().commit();}
 public static void recover(Context c){if(!MatrixService.alive)try{new MatrixDevice(c).restore();}catch(Exception ignored){}}
 public void frame(JSONArray a)throws Exception{int[] pixels=new int[391];for(int i=0;i<391;i++)pixels[i]=a.getInt(i);try{set.invoke(manager,pixels,null);submitted=true;}catch(InvocationTargetException e){throw new Exception("固件拒绝原生背屏调用："+e.getCause().getClass().getSimpleName());}}
 public void clear()throws Exception{if(submitted)try{clear.invoke(manager);submitted=false;}catch(InvocationTargetException e){throw new Exception("固件拒绝清帧");}}
}
