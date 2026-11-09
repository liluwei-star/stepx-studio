/*
 * GitHub 参考检索不能拖慢每一次生成。
 *
 * 这段代码挂在「每条带项目的 AI 消息」前面：先搜 GitHub，再把结果塞进对话。
 * 设计初衷是好的 —— 有现成的开源实现可以少走弯路。
 *
 * 但它站错了位置：它在模型开始生成之前，同步地跑。
 *
 *   连接超时 12 秒 + 读超时 15 秒，再加后续的 contents / license 请求，
 *   手机网络下用户点完发送要先盯十几秒，才看到第一个字。
 *
 *   而且 GitHub 未登录的搜索接口限速很低（约每分钟十次）。
 *   用户连发几条就撞上，之后每次失败，调用方还要往对话里插一句
 *   「本轮检索未成功…」—— 堆几条就把真正的对话挤到后面去了。
 *
 * 三条修法必须同时成立：
 *   ① 超时按「这是可选加分项」来定，不能按主流程定；
 *   ② 失败后退避一段时间，别在限速里连着撞；
 *   ③ 跳过时不往对话里塞系统话术。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const gh = read('src/cn/com/scsxrkj/GithubResearch.java');
const main = read('src/cn/com/scsxrkj/MainActivity.java');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 超时按「可选」来定 ───────────────────────────');
ok('连接超时不长于 6 秒', /setConnectTimeout\(6000\)/.test(gh),
  (gh.match(/setConnectTimeout\((\d+)\)/) || [])[0]);
ok('读超时不长于 8 秒', /setReadTimeout\(8000\)/.test(gh),
  (gh.match(/setReadTimeout\((\d+)\)/) || [])[0]);
ok('旧的 12/15 秒已经改掉',
  !/setConnectTimeout\(12000\)/.test(gh) && !/setReadTimeout\(15000\)/.test(gh));

console.log('\n── 失败要退避，不能连着撞墙 ─────────────────────');
ok('存在退避时间点', /static long quietUntil;/.test(gh));
ok('冷却期内直接跳过', /if\(System\.currentTimeMillis\(\)<quietUntil\)/.test(gh));
ok('跳过的结果带 status=skipped', /put\("status","skipped"\)/.test(gh));
ok('异常时设置冷却期', /quietUntil=System\.currentTimeMillis\(\)\+10\*60\*1000L/.test(gh));
ok('用户主动取消不触发冷却',
  /if\(!\(e instanceof InterruptedIOException\)\)quietUntil=/.test(gh));

console.log('\n── 成功的查询要缓存 ─────────────────────────────');
ok('有结果缓存', /static final java\.util\.LinkedHashMap<String,JSONObject> cache/.test(gh));
ok('缓存有上限（不会无限涨）', /size\(\)>8/.test(gh));
ok('命中缓存直接返回', /JSONObject hit=cache\.get\(query\)/.test(gh));
ok('成功才写缓存', /cache\.put\(query,new JSONObject\(result\.toString\(\)\)\)/.test(gh));

console.log('\n── 跳过时不污染对话 ─────────────────────────────');
ok('skipped 时不插入参考消息',
  /if\(!"skipped"\.equals\(research\.optString\("status"\)\)\)/.test(main));
ok('检索失败仍然明确告诉模型别编造',
  /本轮GitHub检索未成功/.test(main));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
