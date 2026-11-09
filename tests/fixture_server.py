from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import json
"""
自测用的假模型服务端。

除基础响应外，额外提供两个**原生 function calling** 端点，
用来验证 Studio 的工具循环真的按协议在跑，而不是把 JSON 塞在正文里蒙混过关：

  /tools             第一次请求返回一个 tool_calls，第二次返回最终答案。
                      服务端会检查第二轮 messages 里有没有 role=tool 的结果消息，
                      有没有带回第一次的 tool_call_id —— 这是服务端唯一认的凭证。
  /tools-anthropic   Anthropic 版本同款，检查 tool_result 与 tool_use_id。
"""
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  # 必须按 UTF-8 解码。请求体里有中文（system 提示词、项目名），
  # 而 json.loads 对 bytes 会用 detect_encoding 去猜 ——
  # 在中文 Windows 上它会按 GBK 解，碰到字节序列就抛 UnicodeDecodeError。
  #
  # 这个异常的杀伤力在于：它发生在 handler 里，连接被直接掐断，
  # 设备端只看到一句 "unexpected end of stream"，
  # 完全看不出是服务端解码问题 —— 排查成本极高。
  raw_body=self.rfile.read(int(self.headers['Content-Length']))
  try:
   data=json.loads(raw_body.decode('utf-8'))
  except Exception as e:
   self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
   self.wfile.write(json.dumps({'error':'request body is not valid UTF-8 JSON','detail':str(e),'preview':raw_body[:200].decode('utf-8',errors='replace')}).encode());return
  # 断言失败会让连接直接断掉，设备端只看到 "unexpected end of stream"，看不出原因。
  # 所以把关键检查改成明确的报错响应，而不是裸 assert。
  # ── 概览探针端点（端口 8770）────────────────────────────
  #
  # 自测里有一条「项目概览真的进了系统提示词」的断言。
  # 它的验证方式就是问模型「这个项目有多少个文件？」——
  # 如果模型能答出真实文件数，说明概览确实在提示词里；
  # 答不出，说明概览没进去。
  #
  # 所以这里要读收到的 system 提示词，数出「【当前项目】」那一段里的文件条数，
  # 再把答案原样说出来。模型答对了 = 概览进了提示词。
  if data.get('model')=='overview-probe':
    if data.get('stream') is not False:
      self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
      self.wfile.write(json.dumps({'error':'overview model/stream mismatch','got':{'model':data.get('model'),'stream':data.get('stream')}}).encode());return
    # system 的位置随协议不同：
    #   Anthropic 走顶层 system 字段；
    #   OpenAI 兼容协议是 messages[0] = {role:system, content:...}。
    # 只读顶层字段的话，兼容协议永远拿不到提示词 —— 探针恒返回 400，
    # 设备端只看到一句「模型参数或上下文超限」，完全指不到这里。
    sys_txt=data.get('system')
    if not isinstance(sys_txt,str) or not sys_txt:
      msgs=data.get('messages') or []
      for m in msgs:
        if isinstance(m,dict) and m.get('role')=='system':
          c=m.get('content')
          sys_txt=c if isinstance(c,str) else json.dumps(c,ensure_ascii=False)
          break
    if not isinstance(sys_txt,str) or not sys_txt:
      self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
      self.wfile.write(json.dumps({'error':'overview system missing','keys':list(data.keys())}).encode());return
    # 概览段落：LocalDevTools.overview() 生成的文本里，每个文件一行。
    # 数「有 N 个文件」这句，找不到就说明概览没进提示词。
    import re as _re
    m=_re.search(r'共\s*(\d+)\s*个文件', sys_txt)
    if not m:
      # 换个说法：直接数概览区里的路径行
      seg=sys_txt
      idx=sys_txt.find('【当前项目】')
      if idx>=0: seg=sys_txt[idx:idx+4000]
      paths=set(_re.findall(r'([\w./-]+\.(?:html|css|js|ts|tsx|jsx|json|md|txt|svg|png|jpg))', seg))
      answer='OVERVIEW_MISSING' if not paths else 'OVERVIEW_OK 共 %d 个文件'%len(paths)
    else:
      answer='OVERVIEW_OK 共 %s 个文件'%m.group(1)
    print('OVERVIEW SYSTEM SAMPLE:',sys_txt[:800].replace('\n',' | '),flush=True)
    print('OVERVIEW ANSWER:',answer,flush=True)
    r={'choices':[{'message':{'content':answer}}],'usage':{'prompt_tokens':10,'completion_tokens':5}}
    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(r).encode());return

  if data.get('model')!='fixture' or data.get('stream') is not False:
   self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
   self.wfile.write(json.dumps({'error':'model/stream mismatch','got':{'model':data.get('model'),'stream':data.get('stream')}}).encode());return
  if data.get('max_tokens')!=128:
   self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
   self.wfile.write(json.dumps({'error':'max_tokens mismatch','got':data.get('max_tokens')}).encode());return
  # Anthropic 用 x-api-key 头，不是 Authorization —— 判定要放在通用分支之前。
  if self.path.startswith('/anthropic') or self.path.startswith('/tools-anthropic'):
   # 注意：Studio 传过来的 system 是拼接过工具说明、技能、记忆的完整提示词，
   # 不是字面的 "system" —— 这里只校验它是非空字符串。
   if self.headers.get('x-api-key')!='fixture-secret' or not isinstance(data.get('system'),str) or not data.get('system'):
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'anthropic auth/system mismatch','key':self.headers.get('x-api-key'),'system':data.get('system')}).encode());return
   r={'content':[{'type':'text','text':'anthropic reply'}],'usage':{'input_tokens':10,'output_tokens':20,'cache_read_input_tokens':80,'cache_creation_input_tokens':30}}
  else:
   if self.headers.get('Authorization')!='Bearer fixture-secret' or not data['messages'] or data['messages'][0].get('role')!='system':
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'bearer/system mismatch','auth':self.headers.get('Authorization'),'first':data['messages'][0] if data.get('messages') else None}).encode());return
   r={'choices':[{'message':{'content':'fixture reply'}}],'usage':{'prompt_tokens':100,'completion_tokens':40,'prompt_tokens_details':{'cached_tokens':60},'completion_tokens_details':{'reasoning_tokens':10}}}
  if self.path.startswith('/thinking'):assert data['thinking']=={'type':'disabled'}
  if self.path.startswith('/incomplete'):
   r['choices']=[{'finish_reason':'length','message':{'content':'','reasoning_content':'partial analysis'}}]
  if self.path.startswith('/missing'):r.pop('usage')
  if self.path.startswith('/bad'):self.send_response(401);self.end_headers();return
  if self.path.startswith('/redirect'):self.send_response(307);self.send_header('Location','http://127.0.0.1:8768/leak');self.end_headers();return
  # ── 原生 function calling：模型通过工具改文件 ────────────
  #
  # 这个端点测的是最要命的一条链路：
  # 模型把文件内容放在 tool_calls（write_files）里，最终文本是人话回答。
  #
  # <p>以前 Studio 只从「最终文本」里抠 files JSON，
  # 而原生路径的最终文本根本没有 JSON —— 模型改对了，改动却被整个丢掉。
  # 这里让 fixture 模拟真实模型的行为：改文件 + 说人话，不在文本里塞 JSON。
  if self.path.startswith('/tools-edit'):
   if not isinstance(data.get('tools'),list) or not data['tools']:
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'tools missing from request'}).encode());return
   already_called=any(m.get('role')=='tool' for m in data['messages'])
   if not already_called:
    # 第一轮：调 write_files 改一个文件
    payload=json.dumps({'files':{'src/main.js':'console.log("edited by agent")'}})
    r={'choices':[{'finish_reason':'tool_calls','message':{'content':'','tool_calls':[
     {'id':'call_edit_1','type':'function','function':{'name':'write_files','arguments':payload}}]}}]}
   else:
    tool_msgs=[m for m in data['messages'] if m.get('role')=='tool']
    if not tool_msgs:
     self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
     self.wfile.write(json.dumps({'error':'tool result missing'}).encode());return
    if tool_msgs[0].get('tool_call_id')!='call_edit_1':
     self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
     self.wfile.write(json.dumps({'error':'tool_call_id mismatch','got':tool_msgs[0].get('tool_call_id')}).encode());return
    # 第二轮：人话回答，文本里【没有】files JSON —— 这正是原生路径的真实形态
    r={'choices':[{'finish_reason':'stop','message':{'content':'已经把 src/main.js 改成新内容了。'}}]}
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(r).encode());return

  # ── 原生 function calling：完整的多轮流程 ─────────────────
  #
  # 这个端点模拟一个真正干活的模型：
  #   第 1 轮 读文件        → 看清楚现在是什么内容
  #   第 2 轮 写文件        → 用上一轮读到的内容改出新内容
  #   第 3 轮 编译检查      → 确认改完没坏
  #   第 4 轮 人话回答      → 告诉用户改了什么
  #
  # 关键点：第 2 轮的写入内容**依赖第 1 轮读到的内容**。
  # 以前 Studio 丢工具结果、丢 staged 改动，问题都会在这一环暴露。
  if self.path.startswith('/tools-flow'):
   if not isinstance(data.get('tools'),list) or not data['tools']:
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'tools missing from request'}).encode());return
   tool_msgs=[m for m in data['messages'] if m.get('role')=='tool']
   n=len(tool_msgs)
   if n==0:
    # 第 1 轮：读 index.html
    payload=json.dumps({'path':'index.html'})
    r={'choices':[{'finish_reason':'tool_calls','message':{'content':'','tool_calls':[
     {'id':'call_flow_1','type':'function','function':{'name':'read_file','arguments':payload}}]}}]}
   elif n==1:
    # 第 2 轮：把读到的标题换掉 —— 内容依赖上一轮工具结果
    old=tool_msgs[0].get('content','')
    marker='旧标题'
    if marker in old:
     new=old.replace(marker,'会议助手')
    else:
     new=old+'\n<!-- 会议助手 -->\n'
    payload=json.dumps({'files':{'index.html':new}})
    r={'choices':[{'finish_reason':'tool_calls','message':{'content':'','tool_calls':[
     {'id':'call_flow_2','type':'function','function':{'name':'write_files','arguments':payload}}]}}]}
   elif n==2:
    # 第 3 轮：编译检查
    payload=json.dumps({})
    r={'choices':[{'finish_reason':'tool_calls','message':{'content':'','tool_calls':[
     {'id':'call_flow_3','type':'function','function':{'name':'check_project','arguments':payload}}]}}]}
   else:
    # 第 4 轮：人话回答
    r={'choices':[{'finish_reason':'stop','message':{'content':'标题已改成「会议助手」，并跑了一次编译检查。'}}]}
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(r).encode());return

  # ── 原生 function calling：工具连续失败 ───────────────────
  #
  # 这个端点测的是熔断：模型每次都调 read_file 读一个不存在的文件，
  # 工具永远失败。以前 Studio 会一直循环到 40 轮上限 ——
  # 用户等几分钟，最后拿到的还是一句失败，还白烧了几十次请求。
  #
  # 正确行为是：连续几轮全败就停下来，并把失败原因说清楚。
  if self.path.startswith('/tools-fail'):
   if not isinstance(data.get('tools'),list) or not data['tools']:
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'tools missing from request'}).encode());return
   n=len([m for m in data['messages'] if m.get('role')=='tool'])
   payload=json.dumps({'path':'definitely/not/here-%d.ts'%n})
   r={'choices':[{'finish_reason':'tool_calls','message':{'content':'','tool_calls':[
    {'id':'call_fail_%d'%n,'type':'function','function':{'name':'read_file','arguments':payload}}]}}]}
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(r).encode());return

  # ── 原生 function calling：OpenAI 格式 ────────────────────
  if self.path.startswith('/tools') and not self.path.startswith('/tools-anthropic') and not self.path.startswith('/tools-edit'):
   if not isinstance(data.get('tools'),list) or not data['tools']:
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'tools missing from request','keys':list(data.keys())}).encode());return
   tool_names=[t['function']['name'] for t in data['tools']]
   if 'read_file' not in tool_names:
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'read_file schema missing','names':tool_names}).encode());return
   already_called=any(m.get('role')=='tool' for m in data['messages'])
   if not already_called:
    r={'choices':[{'finish_reason':'tool_calls','message':{'content':'','tool_calls':[
     {'id':'call_fixture_1','type':'function','function':{'name':'list_files','arguments':'{"prefix":"src/"}'}}]}}]}
   else:
    tool_msgs=[m for m in data['messages'] if m.get('role')=='tool']
    if not tool_msgs:
     self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
     self.wfile.write(json.dumps({'error':'tool result message missing in second round','messages':data['messages']}).encode());return
    if tool_msgs[0].get('tool_call_id')!='call_fixture_1':
     self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
     self.wfile.write(json.dumps({'error':'tool_call_id mismatch','got':tool_msgs[0].get('tool_call_id')}).encode());return
    r={'choices':[{'finish_reason':'stop','message':{'content':'已经看过了，src 下面有 3 个文件。'}}]}
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(r).encode());return

  # ── 原生 function calling：Anthropic 格式 ────────────────
  if self.path.startswith('/tools-anthropic'):
   if not isinstance(data.get('tools'),list) or not data['tools']:
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'tools missing from request','keys':list(data.keys())}).encode());return
   if 'input_schema' not in data['tools'][0]:
    self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
    self.wfile.write(json.dumps({'error':'anthropic tool schema malformed','first':data['tools'][0]}).encode());return
   already=any(m.get('role')=='user' and isinstance(m.get('content'),list)
               and any(isinstance(b,dict) and b.get('type')=='tool_result' for b in m['content'])
               for m in data['messages'])
   if not already:
    r={'stop_reason':'tool_use','content':[{'type':'tool_use','id':'toolu_fixture_1','name':'list_files','input':{'prefix':'src/'}}]}
   else:
    blocks=[b for m in data['messages'] if m.get('role')=='user' and isinstance(m.get('content'),list)
            for b in m['content'] if isinstance(b,dict) and b.get('type')=='tool_result']
    if not blocks:
     self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
     self.wfile.write(json.dumps({'error':'tool_result block missing','messages':data['messages']}).encode());return
    print('ANTHROPIC ROUND2 MESSAGES:',json.dumps(data['messages'],ensure_ascii=False)[:1500],flush=True)
    if blocks[0].get('tool_use_id')!='toolu_fixture_1':
     self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers()
     self.wfile.write(json.dumps({'error':'tool_use_id mismatch','got':blocks[0].get('tool_use_id')}).encode());return
    r={'stop_reason':'end_turn','content':[{'type':'text','text':'已经看过了，src 下面有 3 个文件。'}]}
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(r).encode());return

  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(r).encode())
def serve(port):
  ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()

# 8768：通用 fixture 端点（模型、工具协议、Anthropic 等）
# 8770：概览探针端点 —— 分开是因为它对 model 名和 system 的检查更严，
#       混在一起的话通用端点的请求会被误判。
import threading
threading.Thread(target=serve,args=(8770,),daemon=True).start()
ThreadingHTTPServer(('127.0.0.1',8768),Handler).serve_forever()
