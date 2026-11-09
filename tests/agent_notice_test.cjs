/*
 * 助手正文不被系统提示覆盖 —— 回归测试
 * ---------------------------------------------------------------
 * 要守住的行为：
 *   1. 熔断 / 轮数上限发生时，模型这一轮说过的话必须保留，
 *      系统说明追加在后面，不能整段覆盖掉。
 *   2. 模型没说话时，输出就是系统说明本身（不能多出空白）。
 *
 * 为什么重要：
 *   原来三处都是 response.put("text", ...) 直接覆盖。
 *   模型说「我改好了 X，现在跑一下编译」，用户看到的却只有
 *   「连续 3 轮工具调用全部失败」—— 助手的声音直接消失。
 *   用户是要跟助手对话，不是读运行日志。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/cn/com/scsxrkj/DevAgent.java');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const src = fs.readFileSync(SRC, 'utf8');

/* ---------- 1. appendNotice 必须存在 ---------- */
ok(/static\s+String\s+appendNotice\s*\(String\s+body\s*,\s*String\s+notice\)/.test(src),
   'appendNotice(body, notice) 辅助方法存在');

/* ---------- 2. appendNotice 的语义（用等价 JS 复刻一份验证） ---------- */
function appendNotice(body, notice) {
  const b = (body == null ? '' : String(body)).trim();
  if (b === '') return notice;
  return b + '\n\n' + notice;
}
ok(appendNotice('我改好了按钮', '到上限了') === '我改好了按钮\n\n到上限了',
   '模型正文保留，系统说明追加在后面');
ok(appendNotice('', '到上限了') === '到上限了',
   '模型没说话时只输出系统说明');
ok(appendNotice('   ', '到上限了') === '到上限了',
   '模型正文只有空白时视为没说话');
ok(appendNotice('话', '说明').indexOf('话') < appendNotice('话', '说明').indexOf('说明'),
   '正文排在说明前面（结论优先）');

/* ---------- 3. 三处熔断/上限都必须是追加，不能是覆盖 ---------- */
/* 覆盖写法：response.put("text", "连续 ...")
/* 追加写法：response.put("text", appendNotice(response.optString("text",""), ...)) */
const overwriteCount = (src.match(/response\.put\("text",\s*"连续 /g) || []).length;
const overwriteCount2 = (src.match(/response\.put\("text",\s*"已达到本轮 /g) || []).length;
ok(overwriteCount === 0, '没有「直接 put 覆盖熔断文案」的写法（应为 0，实际 ' + overwriteCount + '）');
ok(overwriteCount2 === 0, '没有「直接 put 覆盖轮数上限文案」的写法（应为 0，实际 ' + overwriteCount2 + '）');

const appendCalls = (src.match(/response\.put\("text",\s*appendNotice\(/g) || []).length;
ok(appendCalls >= 4, '四处（原生熔断/原生上限/降级熔断/降级上限）都走 appendNotice，实际 ' + appendCalls);

/* ---------- 4. 原生路径也得有轮数上限提示（原来只有降级路径有） ---------- */
/* 原生路径的分支体里必须出现「已达到本轮」 */
const nativeBranchStart = src.indexOf('路径一');
const nativeBranchEnd = src.indexOf('路径二');
ok(nativeBranchStart > 0 && nativeBranchEnd > nativeBranchStart,
   '能定位原生 / 降级两条路径的分支');
const nativePart = src.slice(nativeBranchStart, nativeBranchEnd);
ok(nativePart.includes('已达到本轮'),
   '原生路径也有轮数上限提示（原来只有降级路径有）');
ok(nativePart.includes('appendNotice'),
   '原生路径的轮数上限提示也是追加而不是覆盖');

/* ---------- 5. 提示内容要说清楚「改好的会写回」 ---------- */
ok(src.includes('已经改好的文件仍然会写回项目'),
   '轮数上限提示写明「改好的文件仍会写回」');


/* ---------- 6. 停止原因要传到界面，不能一律说「达到轮数上限」 ---------- */
ok(src.includes('"stopReason","tool_failure"'), '熔断时写入 stopReason=tool_failure');
ok((src.match(/"stopReason","round_limit"/g) || []).length >= 2,
   '两条路径的轮数上限都写入 stopReason=round_limit');

const mainSrc = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/MainActivity.java'), 'utf8');
ok(mainSrc.includes('"tool_failure".equals(reason)'),
   'MainActivity 按 stopReason 区分提示文案');
ok(mainSrc.includes('连续几轮工具调用都失败了'),
   '熔断文案说清「工具连续失败」，不是「没跑够」');
ok(mainSrc.includes('本轮工具调用达到了轮数上限'),
   '轮数上限文案保留');

/* ---------- 7. 界面必须真的把 partialNote 显示出来 ---------- */
const appJs = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8');
ok(appJs.includes('m.edit.partialNote'),
   '前端渲染 partialNote（原来只有 message，用户看不到「这轮没做完」）');

/* ---------- 8. partialNote 必须能存进对话历史 ---------- */
ok(/JSONObject\s+editForStore/.test(mainSrc), 'editForStore 存在');
const storeBlock = mainSrc.slice(mainSrc.indexOf('JSONObject editForStore'), mainSrc.indexOf('JSONObject editForStore') + 1400);
ok(!/"partial"|"partialNote"/.test(storeBlock.replace(/\/\*\*?[\s\S]*?\*\//g, '')),
   'editForStore 没有把 partial/partialNote 剔掉（要保留才对，这里只确认没被误删）');

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '（' + pass + ' / ' + (pass + fail) + '）');
process.exit(fail === 0 ? 0 : 1);
