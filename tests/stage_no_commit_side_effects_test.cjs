/*
 * 暂存不产生提交副作用。
 *
 * AI 走工具路径改文件时（write_files / patch_file / multi_patch / replace_text），
 * 改的是本轮内存里的暂存副本。这本该是纯计算。
 *
 * 可它原来调的是 ProjectEdits.apply() —— 那是提交语义：
 * 塞一份差量快照、写一条 history、刷新 updated。
 *
 * 后果：一个 40 轮的工具循环，每改一次文件就往暂存副本里堆一份快照、
 * 记一条历史。用户翻项目历史全是「AI 暂存 · 1 个文件」，
 * 真正该保留的「AI 动手之前」那份快照还会被挤出裁剪窗口。
 *
 * 这个测试锁住：stage 只合并 + 校验，apply 才做提交副作用。
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

const edits = read('src/cn/com/scsxrkj/ProjectEdits.java');
const tools = read('src/cn/com/scsxrkj/LocalDevTools.java');
const art = read('src/cn/com/scsxrkj/ArtManager.java');

console.log('── stage 是纯合并，不带提交副作用 ───────────────');
const iStage = edits.indexOf('static void stage(JSONObject project,JSONObject changes)');
ok('stage 存在', iStage > 0);
const stageBody = iStage > 0 ? edits.slice(iStage, edits.indexOf('static JSONObject mergeChecked(')) : '';
ok('stage 只改 files，不写 snapshots', !/snapshots/.test(stageBody));
ok('stage 不写 history', !/history/.test(stageBody));
ok('stage 不刷新 updated 时间戳', !/put\("updated"/.test(stageBody));
ok('stage 调用同一套校验（mergeChecked）', /mergeChecked\(/.test(stageBody));

console.log('\n── apply 仍然保留提交副作用 ─────────────────────');
const iApply = edits.indexOf('static JSONObject apply(JSONObject p,JSONObject base');
ok('apply 存在', iApply > 0);
const applyBody = iApply > 0 ? edits.slice(iApply, iApply + 6000) : '';
ok('apply 仍写 snapshots', /snapshots/.test(applyBody));
ok('apply 仍写 history', /history/.test(applyBody));
ok('apply 仍刷新 updated', /put\("updated"/.test(applyBody));
ok('apply 复用同一套合并校验', /mergeChecked\(/.test(applyBody));
ok('apply 仍然拒绝过期基线',
  /if\(!same\(p\.getJSONObject\("files"\),base\)\)throw new Exception\("文件已变化/.test(applyBody));

console.log('\n── 所有暂存调用点都已切换 ───────────────────────');
ok('LocalDevTools 不再用 apply 做暂存',
  !/ProjectEdits\.apply\(staged/.test(tools),
  (tools.match(/ProjectEdits\.apply\(staged/g) || []).length + ' 处仍在用');
ok('LocalDevTools 用 stage 做暂存',
  (tools.match(/ProjectEdits\.stage\(staged/g) || []).length >= 3,
  (tools.match(/ProjectEdits\.stage\(staged/g) || []).length + ' 处');
ok('ArtManager 的暂存引用也改用 stage',
  !/ProjectEdits\.apply\(staged/.test(art));

console.log('\n── 真提交路径仍然是 apply ───────────────────────');
const main = read('src/cn/com/scsxrkj/MainActivity.java');
/*
 * 两条提交路径都必须最终落到 ProjectEdits.apply —— 那是唯一会写快照、
 * 写 history、刷时间戳的提交语义。它们现在都先经过 applyAiChanges：
 * 基线漂移时按文件三方判断抢救，没冲突的照常提交，冲突的跳过并点名。
 * 真正写盘的仍然是 apply。
 */
ok('MainActivity 提交 AI 改动用 apply（经抢救包装）',
  /applyAiChanges\(target,baseline,changes,edit\)/.test(main)
  && /return ProjectEdits\.apply\(target,baseline,changes/.test(main));
ok('审查应用同样走抢救包装，最终仍是 apply',
  /applyAiChanges\(p,q\.getJSONObject\("base"\)/.test(main)
  && /JSONObject updated=ProjectEdits\.apply\(target,liveBase,safe/.test(main));

console.log('\n── 差异计算不再绕道提交路径 ─────────────────────');
const iCalc = tools.indexOf('JSONObject finalChanges(');
ok('finalChanges 存在', iCalc > 0);
const calcBody = iCalc > 0 ? tools.slice(iCalc, iCalc + 1600) : '';
ok('finalChanges 不调用 ProjectEdits.apply',
  !/ProjectEdits\.apply\(/.test(calcBody),
  '仍在绕道 apply —— 校验一失败，整轮改动就静默丢失');
ok('finalChanges 直接比两张文件表',
  /optJSONObject\("files"\)/.test(calcBody));
ok('finalChanges 用 NULL 表示删除',
  /JSONObject\.NULL/.test(calcBody));
/*
 * 降级路径（服务端不支持原生工具）下，模型把整个 files 写进正文，
 * 那些内容不在暂存区 —— 必须靠 finalChanges 合进去，
 * 否则差异算出来是空的，降级路径的改动全丢。
 */
ok('finalChanges 会把传入的 changes 合进暂存副本',
  /ProjectEdits\.stage\(staged,changes\);/.test(calcBody),
  '没有合并 —— 降级路径（模型把 files 写进正文）的改动会全丢');
ok('合并前先剥掉模型带回来的行号前缀',
  /stripLineNumbers\(\(String\)v\)/.test(calcBody));

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
