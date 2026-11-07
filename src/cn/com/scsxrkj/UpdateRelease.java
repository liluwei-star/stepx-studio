package cn.com.scsxrkj;
import org.json.*;
/**
 * 解析 GitHub Release 里的一个发布版本。
 *
 * <p>只认正式发布（非草稿、非预发布）。<b>绝不从 Release 说明文字里猜下载地址</b>，
 * 必须是有明确文件名和 SHA-256 的资产，防止发布说明被篡改后诱导安装恶意包。
 */
final class UpdateRelease {
 final String version,notes,url,sha;final long assetId,size;
 UpdateRelease(String v,String n,String u,String h,long id,long bytes){version=v;notes=n;url=u;sha=h;assetId=id;size=bytes;}
 static int compare(String a,String b)throws Exception{String[]aa=parts(a),bb=parts(b);for(int i=0;i<3;i++){long x=Long.parseLong(aa[i]),y=Long.parseLong(bb[i]);if(x!=y)return x>y?1:-1;}return 0;}
 static String[] parts(String v)throws Exception{if(!v.matches("v?[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}"))throw new Exception("版本号不是受支持的正式语义版本");return v.replaceFirst("^v","").split("\\.");}
 static UpdateRelease parse(JSONObject r,String repo)throws Exception{
  if(r.optBoolean("draft")||r.optBoolean("prerelease"))throw new Exception("忽略草稿或预发布版本");String v=r.getString("tag_name");parts(v);String version=v.replaceFirst("^v","");String name="StepXStudio-"+version+"-release.apk";JSONArray assets=r.getJSONArray("assets");JSONObject selected=null;
  for(int i=0;i<assets.length();i++){JSONObject x=assets.getJSONObject(i);if(name.equals(x.optString("name"))&&"uploaded".equals(x.optString("state"))){if(selected!=null)throw new Exception("版本包含重复安装包");selected=x;}}
  if(selected==null)throw new Exception("正式版本尚未提供匹配的APK，稍后再试");String hash=selected.optString("digest");if(!hash.matches("sha256:[0-9a-fA-F]{64}"))throw new Exception("安装包缺少SHA-256校验信息");long size=selected.getLong("size"),id=selected.getLong("id");if(size<=0||size>100*1024*1024||id<=0)throw new Exception("安装包大小或ID无效");String url="https://api.github.com/repos/"+repo+"/releases/assets/"+id;if(!url.equals(selected.optString("url")))throw new Exception("安装包地址不属于更新仓库");
  String notes=r.optString("body","");if(notes.length()>12000)notes=notes.substring(0,12000)+"\n…完整说明见版本页";return new UpdateRelease(version,notes,"https://github.com/"+repo+"/releases/tag/"+v,hash.substring(7).toLowerCase(java.util.Locale.ROOT),id,size);
 }
}
