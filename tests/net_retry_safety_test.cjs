/*
 * 网络重试的安全边界。
 *
 * 重试本身是好东西：一次工具循环要连发几十次请求，
 * 中断一次就全作废。但重试有一个绝对不能越过的红线：
 *
 *   已经在界面上显示过内容，就不能重发。
 *
 * 因为重发的效果不是「恢复」，而是把同一段正文再说一遍。
 * 用户看到的是重复文本，比直接报错更让人困惑 ——
 * 而且这一轮服务端已经计过费了。
 *
 * 这个测试锁死三件事：
 *   ① 重试前必须检查「已输出」标记；
 *   ② 这个标记必须由真正流到界面的进度回调来置位，不能靠猜；
 *   ③ 每次新的 HTTP 请求都要复位，否则一次工具循环里
 *      「上一轮说过话」会永久污染后面所有轮次的重试判断。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 重试红线：说过话就不许重放 ──────────────────');
const api = read('src/cn/com/scsxrkj/ApiClient.java');

ok('存在「已输出」标记字段',
  /volatile\s+boolean\s+delivered\s*;/.test(api));

ok('重试分支里先检查已输出标记',
  /if\(delivered\)\s*throw\s+e\s*;/.test(api));

// 检查顺序：取消判断 → delivered 判断 → HTTP 判断
const iCancel = api.indexOf('if(cancelled||e instanceof InterruptedIOException)throw e;');
const iDelivered = api.indexOf('if(delivered)throw e;');
const iHttp = api.indexOf('if(m.startsWith("HTTP "))throw e;');
ok('取消判断在最前', iCancel >= 0 && iCancel < iDelivered, 'iCancel=' + iCancel);
ok('已输出判断在 HTTP 判断之前', iDelivered >= 0 && iDelivered < iHttp,
  'iDelivered=' + iDelivered + ' iHttp=' + iHttp);

console.log('\n── 标记来自真实进度回调，不是猜的 ──────────────');
ok('进度回调被包了一层用来置位',
  /if\(realProgress!=null\)progress=new Progress\(\)/.test(api));
ok('置位条件看正文或思维链是否非空',
  /text!=null&&!text\.isEmpty\(\)\)\|\|\(reasoning!=null&&!reasoning\.isEmpty\(\)\)\)delivered=true/.test(api));
ok('读完恢复原回调，不污染调用方',
  /finally\{progress=realProgress;\}/.test(api));

console.log('\n── 每次新请求都要复位 ─────────────────────────');
// 复位必须发生在 requestOnce 里，且在发请求之前
const iOnce = api.indexOf('JSONObject requestOnce(');
const iReset = api.indexOf('delivered=false;');
const iBody = api.indexOf('JSONObject body=requestBody(', iOnce);
ok('requestOnce 内有 delivered 复位', iOnce >= 0 && iReset > iOnce);
ok('复位发生在构造请求体之前', iReset > 0 && iBody > 0 && iReset < iBody,
  'iReset=' + iReset + ' iBody=' + iBody);

console.log('\n── 重试次数仍然有界 ───────────────────────────');
ok('重试上限是 2 次（总计最多 3 次尝试）',
  /NET_RETRY_ATTEMPTS\s*=\s*2\s*;/.test(api));
ok('非 DeepSeek 读超时放宽到 300 秒',
  /setReadTimeout\(ModelLimits\.deepSeek\(.+\?0:300000\)/.test(api));

console.log('\n── 回归测试同步更新 ───────────────────────────');
const retryTest = read('tests/net_retry_test.cjs');
ok('net_retry_test 也断言了已输出不重试',
  /delivered/.test(retryTest));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
