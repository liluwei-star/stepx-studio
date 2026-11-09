/*
 * 请求结束后要摘掉「进行中」标记。
 *
 * 这个标记只为一件事存在：应用被杀、请求半途夭折时，下次启动能补一句
 * 「上次生成中断了，未完成的代码没有写入」。它原来只在成功提交那条路上被清掉，
 * 请求失败（服务端 400、超时、网络断）时它就留在存档里 ——
 * 用户下次打开应用，凭空多出一条「上次生成因应用退出或系统回收而中断」，
 * 可上一轮其实已经把错误说清楚了，项目也没被动过。
 *
 * 反向也要守住：真被杀了的时候（finally 根本没机会跑），标记必须还在，
 * 否则中断恢复就失效了。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/MainActivity.java'), 'utf8')
  .replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 「进行中」标记的生命周期 ────────────────────');

ok('请求开始时会写下标记',
  /state\.put\("pendingAi",new JSONObject\(\)\.put\("id",rid\)/.test(main));
ok('启动时看到标记会补一条中断说明',
  /上次生成因应用退出或系统回收而中断/.test(main));
ok('成功提交后会摘掉标记',
  /state\.remove\("pendingAi"\);saveState\(\);\}catch\(Exception commitError\)/.test(main));

/* 定位 finally：请求结束唯一会走的地方 */
const iFinally = main.indexOf('liveEdit=null;event("aiLive"');
ok('finally 里存在', iFinally > 0);

const before = iFinally > 0 ? main.slice(Math.max(0, iFinally - 900), iFinally) : '';
ok('finally 里也会摘掉标记（失败路径不再留下假中断）',
  /state\.remove\("pendingAi"\)/.test(before),
  '请求失败时标记会留到下次启动，凭空多出一条「上次生成中断」');
ok('摘标记是加锁的，不和别处的读写抢',
  /synchronized\(this\)\{state\.remove\("pendingAi"\);\}/.test(before),
  '没加锁，可能在别的线程遍历 state 时抛并发修改');
ok('摘完立刻落盘（否则马上关掉应用还是假中断）',
  /synchronized\(this\)\{state\.remove\("pendingAi"\);\}saveState\(\);/.test(before));

/*
 * 另一个方向：进程被杀时 finally 不会跑，标记自然还在 ——
 * 这条不用代码保证，但要确认恢复逻辑用的是「启动时读存档」而不是内存状态。
 */
ok('恢复逻辑读的是存档里的标记',
  /JSONObject pending=state\.optJSONObject\("pendingAi"\)/.test(main));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
