package cn.com.scsxrkj;
import org.json.*;
import java.util.*;
/**
 * 批量删除对话记录。
 *
 * <p>删对话时只删对话本身，<b>Token 账本和它记录的项目归属要保留</b>，
 * 否则历史用量会凭空少掉，费用对不上账。
 */
final class ChatHistory {
 static JSONArray existingIds(JSONObject state,JSONArray requested)throws Exception{
  Set<String> wanted=new HashSet<>();for(int i=0;i<requested.length();i++){String id=requested.optString(i,"");if(!id.isEmpty())wanted.add(id);}JSONArray ids=new JSONArray(),chats=state.getJSONArray("chats");for(int i=0;i<chats.length();i++){String id=chats.getJSONObject(i).optString("id");if(wanted.remove(id))ids.put(id);}return ids;
 }
 static JSONArray remove(JSONObject state,JSONArray requested)throws Exception{
  JSONArray ids=existingIds(state,requested),chats=state.getJSONArray("chats"),keep=new JSONArray();Map<String,String> projects=new HashMap<>();Set<String> selected=new HashSet<>();for(int i=0;i<ids.length();i++)selected.add(ids.getString(i));
  for(int i=0;i<chats.length();i++){JSONObject chat=chats.getJSONObject(i);if(selected.contains(chat.optString("id")))projects.put(chat.getString("id"),chat.optString("projectId",""));else keep.put(chat);}
  JSONArray usage=state.optJSONArray("usage");if(usage!=null)for(int i=0;i<usage.length();i++){JSONObject row=usage.getJSONObject(i);String project=projects.get(row.optString("chatId"));if(row.optString("projectId").isEmpty()&&project!=null&&!project.isEmpty())row.put("projectId",project);}
  state.put("chats",keep);return ids;
 }
}
