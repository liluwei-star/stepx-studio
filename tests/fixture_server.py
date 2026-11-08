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
  data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  # 断言失败会让连接直接断掉，设备端只看到 "unexpected end of stream"，看不出原因。
  # 所以把关键检查改成明确的报错响应，而不是裸 assert。
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
  # ── 原生 function calling：OpenAI 格式 ────────────────────
  if self.path.startswith('/tools') and not self.path.startswith('/tools-anthropic'):
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
ThreadingHTTPServer(('127.0.0.1',8768),Handler).serve_forever()
