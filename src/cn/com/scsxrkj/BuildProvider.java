package cn.com.scsxrkj;
import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;
/**
 * 把构建产出的 APK 共享给系统安装器的 ContentProvider。
 *
 * <p>Android 7 以后不允许用 file:// 把文件交给别的应用，必须走 ContentProvider。
 * 这个类只开放读权限，且只允许访问 builds 目录下的 .apk 文件，其他路径一律拒绝。
 */
public class BuildProvider extends ContentProvider {
 public boolean onCreate(){return true;}
 File file(Uri u)throws FileNotFoundException{String n=u.getLastPathSegment();if(n==null||!n.matches("[a-zA-Z0-9_-]+\\.apk"))throw new FileNotFoundException();File f=new File(getContext().getFilesDir(),"builds/"+n);if(!f.isFile())throw new FileNotFoundException();return f;}
 public ParcelFileDescriptor openFile(Uri u,String mode)throws FileNotFoundException{if(!"r".equals(mode))throw new FileNotFoundException("Read only");return ParcelFileDescriptor.open(file(u),ParcelFileDescriptor.MODE_READ_ONLY);}
 public String getType(Uri u){return "application/vnd.android.package-archive";}
 public Cursor query(Uri u,String[]p,String s,String[]a,String order){try{File f=file(u);MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});c.addRow(new Object[]{f.getName(),f.length()});return c;}catch(Exception e){return null;}}
 public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}public int update(Uri u,ContentValues v,String s,String[]a){throw new UnsupportedOperationException();}public int delete(Uri u,String s,String[]a){throw new UnsupportedOperationException();}
}
