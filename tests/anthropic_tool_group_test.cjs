/*
 * Anthropic 原生协议：上下文裁剪不能把 tool_use 和 tool_result 拆散。
 *
 * <p>Anthropic 的规则是硬性的：
 * 一条带 tool_use 块的 assistant 消息，下一条<b>必须</b>是 user 消息，
 * 里面放着配对的 tool_result 块。中间不能夹任何别的消息。
 * 少了任何一半，下一轮请求直接被服务端拒（400），整个 AGENT 循环当场崩掉。
 *
 * <p><b>原来为什么会拆散：</b>
 * 裁剪时把 messages 切成「组」，靠判断一条消息「是不是工具调用消息」来决定
 * 要不要连它后面的工具结果一起保留。而这个判断写得太严：
 * assistant 的 content 数组里<b>必须全是</b> tool_use 块才算工具调用消息。
 *
 * <p>可是 assistantToolCallMessage() 在 Anthropic 路径下会把模型这一轮说的
 * 正文作为 text 块，<b>和</b> tool_use 块放进同一个 content 数组
 * （这是对的 —— 模型说过的话不能从历史里消失）。
 * 于是正文越长，这条消息越不像「工具调用消息」，越容易被判成普通消息，
 * 它的 tool_result 就被留成了独立的一组。
 *
 * <p>更糟的是 appendAutoCheck()：自动验证编译的结果，会以 text 块的形态
 * <b>追加进已有的 user 消息</b>的 content 数组里。而那条 user 消息原本
 * 是纯 tool_result 组 —— 追加之后「全是 tool_result」的判断同样失败，
 * 分组再一次断裂。
 *
 * <p>后果是：裁剪把 tool_use 丢掉、把 tool_result 留下（或者反过来），
 * 协议不完整，服务端 400。用户看到的现象是「AI 改着改着突然报错」，
 * 而且报错完全看不出跟上下文裁剪有关。
 *
 * 这个测试跑真实的裁剪方法，不是查源码里有没有那行字。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

/*
 * 把 Java 里的方法抽出来，放进独立类里真跑。
 * 直接抄源码里的方法体 —— 源码改了而测试没改，这里会立刻暴露。
 */
function grabMethod(java, signature) {
  const start = java.indexOf(signature);
  if (start < 0) throw new Error(signature + ' not found');
  let i = java.indexOf('{', start), depth = 0;
  for (; i < java.length; i++) {
    if (java[i] === '{') depth++;
    else if (java[i] === '}') { depth--; if (depth === 0) return java.slice(start, i + 1); }
  }
  throw new Error(signature + ' unterminated');
}

const java = read('src/cn/com/scsxrkj/DevAgent.java');

/* 裁剪要用到这几个方法 */
const body = [
  'static final int MAX_TOOL_RESULT_CHARS = 24*1024;',
  'static final int MAX_ROUND_TOOL_CHARS = 48*1024;',
  grabMethod(java, 'static JSONArray trimToolHistory(JSONArray messages,int budgetChars)'),
  grabMethod(java, 'static void mergeAdjacentSameRole(java.util.ArrayList<Object> list)'),
  grabMethod(java, 'static boolean hasToolBlocks(JSONObject m)'),
  grabMethod(java, 'static void appendAutoCheck(JSONArray messages,String text,String protocol)'),
  grabMethod(java, 'static JSONObject assistantToolCallMessage(JSONObject response,JSONArray calls,String protocol)'),
].join('\n');

const HARNESS = `
package cn.com.scsxrkj;
import org.json.*;
import java.util.*;

public class Agent {
${body}

  /* 造一条 Anthropic 风格的 assistant 工具调用消息（可能带 text 块） */
  static JSONObject anthAssistant(String id,String said){
    JSONArray content=new JSONArray();
    if(said!=null&&!said.isEmpty())
      content.put(new JSONObject().put("type","text").put("text",said));
    content.put(new JSONObject().put("type","tool_use").put("id",id)
      .put("name","read_file").put("input",new JSONObject().put("path","index.html")));
    return new JSONObject().put("role","assistant").put("content",content);
  }

  /* 造一条 Anthropic 风格的 tool_result 消息 */
  static JSONObject anthResult(String id,String body){
    JSONArray content=new JSONArray()
      .put(new JSONObject().put("type","tool_result").put("tool_use_id",id)
        .put("content",body).put("is_error",false));
    return new JSONObject().put("role","user").put("content",content);
  }

  /* 检查裁剪结果里有没有「孤儿」：tool_use 没有配对的 tool_result，反之亦然 */
  static List<String> orphans(JSONArray msgs){
    List<String> bad=new ArrayList<>();
    for(int i=0;i<msgs.length();i++){
      JSONObject m=msgs.optJSONObject(i);
      if(m==null)continue;
      Object raw=m.opt("content");
      if(!(raw instanceof JSONArray))continue;
      JSONArray arr=(JSONArray)raw;
      for(int c=0;c<arr.length();c++){
        JSONObject blk=arr.optJSONObject(c);
        if(blk==null)continue;
        String type=blk.optString("type","");
        if(!"tool_use".equals(type)&&!"tool_result".equals(type))continue;
        String id="tool_use".equals(type)?blk.optString("id"):blk.optString("tool_use_id");
        boolean found=false;
        for(int j=0;j<msgs.length();j++){
          if(j==i)continue;
          JSONObject o=msgs.optJSONObject(j);
          if(o==null)continue;
          Object raw2=o.opt("content");
          if(!(raw2 instanceof JSONArray))continue;
          JSONArray arr2=(JSONArray)raw2;
          for(int d=0;d<arr2.length();d++){
            JSONObject b2=arr2.optJSONObject(d);
            if(b2==null)continue;
            String t2=b2.optString("type","");
            String id2="tool_use".equals(t2)?b2.optString("id"):b2.optString("tool_use_id");
            if(!id2.isEmpty()&&id2.equals(id)){found=true;break;}
          }
          if(found)break;
        }
        if(!found)bad.add(type+":"+id);
      }
    }
    return bad;
  }

  /* 检查有没有连续两条同角色消息（严格交替的路径会 400） */
  static List<String> sameRoleRuns(JSONArray msgs){
    List<String> bad=new ArrayList<>();
    String prev="";
    for(int i=0;i<msgs.length();i++){
      JSONObject m=msgs.optJSONObject(i);
      if(m==null)continue;
      String role=m.optString("role","");
      if(role.equals(prev))bad.add("第 "+i+" 条与上一条同为 "+role);
      prev=role;
    }
    return bad;
  }

  public static void main(String[] a)throws Exception{
    int bad=0;

    /* ① 扫预算：任何预算下都不能出现孤儿
     *
     * <p><b>为什么要扫：</b>孤儿只出现在一个很窄的窗口里。
     * 一组工具交互 = assistant 消息（A）+ tool_result 消息（R）。
     * 裁剪从最新往回装整组，只要 A+R 能装进预算，两半就都装得下 ——
     * 这时候永远不会拆散。
     *
     * <p>坏窗口是「剩余预算落在 [R, R+A) 之间」：
     * R 装得下、A 装不下，于是 tool_use 被丢掉，只剩 tool_result。
     * 固定一个预算未必落在这个窗口里 —— 所以要遍历一组预算扫过去。
     *
     * <p>这是唯一能确定性命中的测法：不是「构造一个坏情况」，
     * 而是「证明任何预算下都不会坏」。
     */
    {
      boolean anyTrimmed=false;
      boolean foundOrphan=false;
      String detail="";
      for(int budget=2000;budget<=90000;budget+=500){
        JSONArray msgs=new JSONArray();
        msgs.put(new JSONObject().put("role","user").put("content","原始任务"));
        /* 正文长度和结果长度刻意不一样，制造宽窄不一的窗口 */
        for(int i=0;i<8;i++){
          msgs.put(anthAssistant("tu_"+i,"第 "+i+" 轮我先看看这个文件"));
          msgs.put(anthResult("tu_"+i,"文件内容 ".repeat(200+i*37)));
        }
        JSONArray trimmed=trimToolHistory(msgs,budget);
        if(trimmed.length()!=msgs.length())anyTrimmed=true;
        /* 裁剪不能把用户的原始提问弄丢 —— 丢了模型就不知道自己在做什么 */
        String head=trimmed.length()>0?trimmed.optJSONObject(0).optString("content",""):"";
        if(!head.startsWith("原始任务")){
          foundOrphan=true;
          detail="budget="+budget+" 原始提问丢了 head="+head;
          break;
        }
        List<String> orph=orphans(trimmed);
        if(!orph.isEmpty()){
          foundOrphan=true;
          detail="budget="+budget+" 孤儿 "+orph;
          break;
        }
      }
      if(!anyTrimmed){System.out.println("FAIL 1a: 扫了这么多预算，一次都没裁剪过，测例本身有问题");bad++;}
      if(foundOrphan){System.out.println("FAIL 1: 扫预算时出现孤儿 tool 消息 "+detail);bad++;}
    }

    /* ② 自动验证编译的结果追加进 tool_result 消息后，不能把分组拆断 */
    {
      JSONArray msgs=new JSONArray();
      msgs.put(new JSONObject().put("role","user").put("content","原始任务"));
      for(int i=0;i<30;i++){
        msgs.put(anthAssistant("tu_"+i,"第 "+i+" 轮的话"));
        msgs.put(anthResult("tu_"+i,"内容 ".repeat(4000)));
      }
      /* 只给最后一条加编译结果 */
      appendAutoCheck(msgs,"编译通过","anthropic");
      JSONArray trimmed=trimToolHistory(msgs,200*1024);
      List<String> orph=orphans(trimmed);
      if(!orph.isEmpty()){System.out.println("FAIL 2: 自动编译结果追加后 tool_use/tool_result 被拆散 "+orph);bad++;}
    }

    /* ③ 纯 tool_use（模型没说话）的老路径也不能被拆散 */
    {
      JSONArray msgs=new JSONArray();
      msgs.put(new JSONObject().put("role","user").put("content","原始任务"));
      for(int i=0;i<30;i++){
        msgs.put(anthAssistant("tu_"+i,null));
        msgs.put(anthResult("tu_"+i,"内容 ".repeat(4000)));
      }
      JSONArray trimmed=trimToolHistory(msgs,200*1024);
      List<String> orph=orphans(trimmed);
      if(!orph.isEmpty()){System.out.println("FAIL 3: 纯 tool_use 也出孤儿 "+orph);bad++;}
    }

    /* ④ 裁剪结果里不能出现连续两条同角色消息 */
    {
      JSONArray msgs=new JSONArray();
      msgs.put(new JSONObject().put("role","user").put("content","原始任务"));
      for(int i=0;i<30;i++){
        msgs.put(anthAssistant("tu_"+i,"第 "+i+" 轮的话"));
        msgs.put(anthResult("tu_"+i,"内容 ".repeat(4000)));
      }
      JSONArray trimmed=trimToolHistory(msgs,200*1024);
      List<String> runs=sameRoleRuns(trimmed);
      if(!runs.isEmpty()){System.out.println("FAIL 4: 裁剪后出现连续同角色消息 "+runs);bad++;}
    }

    /* ⑤ tool_result 必须在紧邻的下一条消息里，中间不能夹东西 */
    {
      JSONArray msgs=new JSONArray();
      msgs.put(new JSONObject().put("role","user").put("content","原始任务"));
      for(int i=0;i<30;i++){
        msgs.put(anthAssistant("tu_"+i,"第 "+i+" 轮的话"));
        msgs.put(anthResult("tu_"+i,"内容 ".repeat(4000)));
      }
      JSONArray trimmed=trimToolHistory(msgs,200*1024);
      for(int i=0;i<trimmed.length();i++){
        JSONObject m=trimmed.optJSONObject(i);
        if(m==null)continue;
        Object raw=m.opt("content");
        if(!(raw instanceof JSONArray))continue;
        JSONArray arr=(JSONArray)raw;
        boolean hasUse=false;
        for(int c=0;c<arr.length();c++){
          JSONObject b=arr.optJSONObject(c);
          if(b!=null&&"tool_use".equals(b.optString("type","")))hasUse=true;
        }
        if(!hasUse)continue;
        /* 下一条必须是含 tool_result 的 user 消息 */
        boolean nextOk=false;
        if(i+1<trimmed.length()){
          JSONObject nx=trimmed.optJSONObject(i+1);
          if(nx!=null&&"user".equals(nx.optString("role",""))){
            Object raw2=nx.opt("content");
            if(raw2 instanceof JSONArray){
              JSONArray arr2=(JSONArray)raw2;
              for(int c=0;c<arr2.length();c++){
                JSONObject b=arr2.optJSONObject(c);
                if(b!=null&&"tool_result".equals(b.optString("type","")))nextOk=true;
              }
            }
          }
        }
        if(!nextOk){System.out.println("FAIL 5: 第 "+i+" 条的 tool_use 后面没有紧跟 tool_result");bad++;break;}
      }
    }

    /* ⑥ 合并不能动带工具块的消息 —— 否则配对关系就断了 */
    {
      java.util.ArrayList<Object> list=new java.util.ArrayList<>();
      list.add(anthAssistant("tu_1","话"));
      list.add(anthResult("tu_1","ok"));
      int before=list.size();
      mergeAdjacentSameRole(list);
      if(list.size()!=before){System.out.println("FAIL 6: 带工具块的消息被合并了");bad++;}
    }

    /* ⑦ 两条纯文字 user 消息要合并成一条 */
    {
      java.util.ArrayList<Object> list=new java.util.ArrayList<>();
      list.add(new JSONObject().put("role","user").put("content","原始任务"));
      list.add(new JSONObject().put("role","user").put("content","已移除的说明"));
      mergeAdjacentSameRole(list);
      if(list.size()!=1){System.out.println("FAIL 7: 两条纯文字 user 消息没有合并");bad++;}
      else{
        JSONObject m=(JSONObject)list.get(0);
        String c=m.optString("content","");
        if(!c.contains("原始任务")||!c.contains("已移除的说明")){
          System.out.println("FAIL 7b: 合并后内容丢了 "+c);bad++;
        }
      }
    }

    /* ⑧ 合并不能修改原消息对象（裁剪结果必须是新对象） */
    {
      JSONObject orig=new JSONObject().put("role","user").put("content","原始任务");
      java.util.ArrayList<Object> list=new java.util.ArrayList<>();
      list.add(orig);
      list.add(new JSONObject().put("role","user").put("content","说明"));
      mergeAdjacentSameRole(list);
      if(!"原始任务".equals(orig.optString("content",""))){
        System.out.println("FAIL 8: 合并把原消息改掉了，原文变成 "+orig.optString("content",""));bad++;
      }
    }

    System.out.println(bad==0?"OK":"BAD="+bad);
  }
}
`;

console.log('── Anthropic 工具分组：裁剪不能拆散 tool_use/tool_result ──');

const dir = path.join(ROOT, 'tests', '.tmp-anthropic');
fs.mkdirSync(path.join(dir, 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(dir, 'cn', 'com', 'scsxrkj', 'Agent.java'), HARNESS);

const shimDir = path.join(ROOT, 'tests', 'support', 'orgjson');
const sources = [
  path.join(shimDir, 'JSONObject.java'),
  path.join(shimDir, 'JSONArray.java'),
  path.join(dir, 'cn', 'com', 'scsxrkj', 'Agent.java'),
];
const jdkHome = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const exe = n => path.join(jdkHome, 'bin', process.platform === 'win32' ? n + '.exe' : n);

let out = '';
try {
  execFileSync(exe('javac'), ['-encoding', 'UTF-8', '-d', dir].concat(sources), { stdio: 'pipe' });
  out = execFileSync(exe('java'),
    ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', dir, 'cn.com.scsxrkj.Agent'],
    { encoding: 'utf8' });
} catch (e) {
  ok('裁剪方法可以编译并运行', false,
    [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').slice(0, 1500));
  console.log('\n失败 ' + fail + ' 项');
  process.exit(1);
}
ok('裁剪方法可以编译并运行', true);
ok('带正文的 Anthropic 工具调用不会被裁剪拆散',
  out.includes('OK'),
  out.trim().split('\n').filter(l => l.startsWith('FAIL')).join(' | '));

console.log('\n── 分组判据不能太严 ─────────────────────────────────');
/*
 * 判据写在源码里，这里检查它认的是「含有 tool_use」而不是「全是 tool_use」。
 * 写死字面量容易脆，但这条判据一旦回退，症状是 400 而不是编译错误，
 * 必须有测试钉住。
 */
ok('assistant 的工具调用判据允许同数组里混着 text 块',
  !/if\(blk==null\|\|!"tool_use"\.equals\(blk\.optString\("type",""\)\)\)\{allToolUse=false;break;\}/.test(java),
  '裁剪仍要求 content 数组里全是 tool_use 块 —— 混着正文就会被判成普通消息');
ok('user 消息的工具结果判据允许同数组里混着 text 块',
  !/if\(blk==null\|\|!"tool_result"\.equals\(blk\.optString\("type",""\)\)\)\{toolResult=false;break;\}/.test(java),
  '裁剪仍要求 content 数组里全是 tool_result 块 —— 自动编译结果追加进去就会断组');

ok('裁剪后会把相邻同角色消息合并掉',
  /mergeAdjacentSameRole\(list\)/.test(java),
  '裁剪插入了 role:"user" 的说明消息，紧跟原始提问 —— 连续两条 user，严格交替的路径会 400');

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
