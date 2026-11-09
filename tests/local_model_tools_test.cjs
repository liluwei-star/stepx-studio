/*
 * 本地离线模型不能被 function calling 那套协议坑死。
 *
 * 这条是真会让功能整体不可用的 BUG，而且现象完全不指向原因：
 *
 *   远端模型一切正常 → 切到本地模型 → 第一句话就报「请先保存 API Key」。
 *
 * 而本地模型根本不需要密钥。原因在继承上：
 *
 *   DevAgent 在「服务端支持原生 function calling」时调 6 参数
 *   request(p, key, messages, system, debug, toolDefs)；
 *   LocalAiClient 只覆写了 5 参数那个版本。
 *
 * 于是带工具的请求顺着继承落到父类 ApiClient —— 父类是真发 HTTP 的，
 * 用本地模型配置里的 endpoint、配一把本来为空的密钥，
 * 开口就是「请先保存 API Key」。
 *
 * 修法两条，必须同时成立：
 *   ① LocalAiClient 补上 6 参数覆写，忽略 tools 走本地生成；
 *   ② 本地协议一开始就不挂 tools，让提示词走文本 JSON 协议 ——
 *      否则提示词说「直接调工具」，本地引擎不会调，模型只回一段人话，
 *      一个文件都没改，用户以为助手偷懒。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const local = read('src/cn/com/scsxrkj/LocalAiClient.java');
const agent = read('src/cn/com/scsxrkj/DevAgent.java');
const main = read('src/cn/com/scsxrkj/MainActivity.java');
const api = read('src/cn/com/scsxrkj/ApiClient.java');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 父类的两个重载都在 ───────────────────────────');
ok('ApiClient 有 5 参数 request', /JSONObject request\(JSONObject p,String secret,JSONArray messages,String system,boolean debug\)/.test(api));
ok('ApiClient 有 6 参数 request（带 tools）', /JSONObject request\(JSONObject p,String secret,JSONArray messages,String system,boolean debug,JSONArray tools\)/.test(api));
ok('DevAgent 发起的是 6 参数那版',
  /client\.request\(profile,key,messages,[^,]+,[^,]+,\s*toolDefs\)/.test(agent));

console.log('\n── ① LocalAiClient 必须覆写 6 参数版本 ──────────');
ok('6 参数覆写存在',
  /@Override\s+JSONObject request\(JSONObject p,String ignored,JSONArray messages,String system,boolean debug,JSONArray tools\)/.test(local),
  '没覆写 —— 带工具的请求会落到父类去发 HTTP');
ok('覆写里没有真的发 HTTP（不建连接、不设 Authorization）',
  !/openConnection|Authorization/.test(local));
ok('覆写委托回本地生成',
  /return request\(p,ignored,messages,system,debug\);/.test(local));

console.log('\n── ② 本地协议一开始就不挂 tools ─────────────────');
ok('DevAgent 对 local 协议关闭 nativeTools',
  /boolean nativeTools=!"local"\.equals\(protocol\)/.test(agent)
  || /nativeTools\s*=\s*!"local"\.equals\(protocol\)/.test(agent),
  '没判 local —— 提示词会说要它直接调工具，而本地引擎不会调');
ok('提示词初值也按 local 关闭',
  /final boolean nativeTools=!"local"\.equals\(profile\.optString\("protocol"\)\)/.test(main));

console.log('\n── 本地模型仍然走本地客户端 ─────────────────────');
ok('sendAi 仍按 protocol 选客户端',
  /onDevice\?new LocalAiClient\(this\):new ApiClient\(\)/.test(main));
ok('本地模型不要求密钥',
  /onDevice\?"":vault\.get\(/.test(main) || /String key=onDevice\?"":/.test(main));

console.log('\n── 远端路径没被改坏 ─────────────────────────────');
ok('远端仍然按 isNoNativeTools 决定降级',
  /isNoNativeTools\(profile\.optString\("id",""\)\)/.test(agent));
ok('降级提示词仍然会被追加',
  /【协议更正】/.test(agent));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
