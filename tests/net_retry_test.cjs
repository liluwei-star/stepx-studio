#!/usr/bin/env node
/*
 * 网络失败要能重试。
 *
 * <p>为什么盯这一条：一次工具循环要连着发几十次请求，每次都重新建连接。
 * 中途任何一次连接被服务商回收、或者手机网络切一下，整轮几十次工具调用
 * 全部作废 —— 模型已经改好的文件、已经读到的内容，全都白费。
 * 用户看到的是「AI 干了一半突然报网络错误」。
 *
 * <p>而且原来读超时只有 120 秒：模型思考期间服务端不吐字，
 * 一个复杂问题想两分钟很常见，一超就 SocketTimeoutException。
 *
 * <p>这里锁住三件事：
 * ① 网络类失败会重试；
 * ② 服务端明确拒绝（HTTP 4xx/5xx）不重试 —— 重试没有意义；
 * ③ 读超时放宽到 300 秒。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/ApiClient.java'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('\n【重试外层存在】');
ok(/NET_RETRY_ATTEMPTS\s*=\s*\d+/.test(src), '重试次数有明确上限，不是无限重试');
ok(/for\s*\(\s*int\s+attempt\s*=\s*1;\s*attempt\s*<=\s*NET_RETRY_ATTEMPTS\s*\+\s*1/.test(src),
  '重试循环按 NET_RETRY_ATTEMPTS 走');

console.log('\n【哪些失败该重试】');
ok(/catch\s*\(\s*IOException\s+\w+\s*\)/.test(src), '网络失败被 IOException 捕获');
ok(/m\.startsWith\("HTTP "\)/.test(src), '服务端明确拒绝（HTTP xxx）不重试');
ok(/InterruptedIOException/.test(src), '用户主动取消不重试');

console.log('\n【退避】');
ok(/Thread\.sleep\(\s*800L\s*\*\s*attempt\s*\)/.test(src),
  '重试之间有退避，不是连着撞墙');

console.log('\n【读超时】');
ok(/setReadTimeout\(ModelLimits\.deepSeek\(p\.optString\("endpoint"\),p\.optString\("model"\)\)\?0:300000\)/.test(src),
  '非 DeepSeek 的读超时放宽到 300 秒');
ok(!/setReadTimeout\([^)]*\?\s*0\s*:\s*120000\s*\)/.test(src),
  '120 秒的旧读超时已经改掉');

console.log('\n【重试不会让用户看到两遍】');
ok(src.indexOf('if(retrying&&progress!=null)progress.update(') >= 0,
  '重试前先清掉上一轮已经推到前端的字');
/*
 * 但「清掉字」只是表面功夫，真正挡住重影的是下面这条红线：
 * 只要已经往界面吐过内容，就根本不重试。
 */
ok(/if\(delivered\)throw e;/.test(src),
  '已经输出过内容就不再重试（delivered 红线）');
ok(/if\(realProgress!=null\)progress=new Progress\(\)/.test(src),
  '已输出标记由真实进度回调置位');

console.log('\n【原有功能没被破坏】');
ok(/JSONObject\s+requestBody\s*\(/.test(src), '请求体构造还在');
ok(/setFixedLengthStreamingMode/.test(src), '请求体长度仍然固定');
ok(/data\.length\s*>\s*32\s*\*\s*1024\s*\*\s*1024/.test(src), '32 MB 请求体上限还在');

console.log('\n' + (fail ? `有失败项（${pass} / ${pass + fail}）` : `全部通过（${pass} / ${pass + fail}）`));
process.exit(fail ? 1 : 0);
