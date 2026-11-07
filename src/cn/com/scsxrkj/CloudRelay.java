package cn.com.scsxrkj;
import org.json.*;
/**
 * 「云端接力开发」的状态机。
 *
 * <p>规则很硬：只有当某个上传快照完整校验通过之后，才允许打开对应的云端项目。
 * 这样可以杜绝「以为传完了、其实传了一半」导致的数据丢失。
 */
final class CloudRelay {
 final String localId;final JSONObject hashes;String destinationId;
 CloudRelay(JSONObject project)throws Exception{localId=project.getString("id");hashes=CloudFiles.hashes(CloudFiles.entries(project));JSONObject cloud=project.optJSONObject("cloud");destinationId=cloud==null?"":cloud.optString("id");if(hashes.length()==0)throw new Exception("项目没有可接力的文件");}
 void associate(String id)throws Exception{if(id.isEmpty()||(!destinationId.isEmpty()&&!destinationId.equals(id)))throw new Exception("云端项目关联已变化，请重新接力");destinationId=id;}
 String finish(JSONObject project)throws Exception{
  if(!localId.equals(project.optString("id")))throw new Exception("接力项目不匹配");JSONObject cloud=project.getJSONObject("cloud");if(destinationId.isEmpty()||!destinationId.equals(cloud.optString("id")))throw new Exception("云端项目关联已变化，请重新接力");
  if(cloud.optBoolean("newUpload")||!ProjectEdits.same(hashes,CloudFiles.hashes(CloudFiles.entries(project))))throw new Exception("同步期间本地文件已变化，请重新接力");JSONObject base=cloud.getJSONObject("base");for(java.util.Iterator<String> i=hashes.keys();i.hasNext();){String name=i.next();if(!hashes.getString(name).equals(base.optString(name)))throw new Exception("部分文件尚未完成云端核验，接力已停止");}
  return "请接力开发当前 Studio 项目。最新本地源码与资源已上传并完成逐文件核验。请先阅读现有文件、确认当前功能和待办，在现有实现上继续，不要重新创建项目或整套替换代码。保留已有功能和资源，修改后检查构建与运行结果，并明确说明未验证的部分。\n\n本轮希望完成的具体修改：";
 }
}
