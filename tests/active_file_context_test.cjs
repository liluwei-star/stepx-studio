#!/usr/bin/env node
/*
 * AI 必须知道用户当前正在看哪个文件。
 *
 * <p>为什么盯这一条：用户嘴里的「这个」「这里」指的是屏幕上的那个文件，
 * 这个信息只有界面知道。如果发消息时不带过去，模型只能反问
 * 「你说的是哪个文件」—— 明明一句话能定位的事，要来回两轮。
 * 这是「AI 不像真人」的典型来源：真人之间不用解释「这里」。
 *
 * <p>所以这条链路必须三段都通：
 *   ① 前端在发消息的那一刻取当前文件和光标行
 *   ② 载荷里带上 activeFile / activeLine
 *   ③ 后端把它写进项目上下文，并且明确告诉模型「这就是他指的东西」
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/MainActivity.java'), 'utf8');
const tools = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/LocalDevTools.java'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('\n【前端：取当前文件和光标】');
ok(/activeFile\s*=/.test(app), '前端会算出 activeFile');
ok(/activeLine\s*=/.test(app), '前端会算出 activeLine');
ok(/selectionStart/.test(app), '光标行号来自 textarea 的 selectionStart');
ok(/split\('\\n'\)\.length/.test(app), '字符偏移换算成行号');
/*
 * 文件名和光标行的取法不一样：
 *   文件跟着 file 变量走 —— 用户切到 AI 页问「这个怎么改」，文件名还在；
 *   光标行要求编辑器真在屏幕上，textarea 不在 DOM 里时光标位置没有意义。
 *
 * 原来两者都绑在 page==='editor' 上，结果一进 AI 页文件名就丢了，
 * 模型只能反问「你说的是哪个文件」—— 而这正是 AI 页最常发生的对话。
 */
ok(/const p0=project\(\);/.test(app), '先确认文件确实在当前项目里');
ok(/Object\.prototype\.hasOwnProperty\.call\(p0\.files,file\)/.test(app),
  '文件不在项目里时不报（避免报一个已删文件）');
ok(/activeFile=file;/.test(app), '文件名不再依赖当前页面');
ok(/if\(page==='editor'\)\{/.test(app), '光标行仍然只在编辑器页面取');

console.log('\n【前端：把当前文件放进请求载荷】');
ok(/activeFile\s*,\s*activeLine/.test(app), 'send 载荷里带上了 activeFile 和 activeLine');

console.log('\n【后端：写进项目上下文】');
ok(/params\.optString\("activeFile"/.test(main), '后端读了 activeFile');
ok(/params\.optInt\("activeLine"/.test(main), '后端读了 activeLine');
ok(/用户当前正在看的文件/.test(main), '上下文里明写「用户当前正在看的文件」');
ok(/光标在第/.test(main), '上下文里带上了光标所在行');
ok(/不在本项目文件里/.test(main), '文件不在项目里时明确提醒，不让模型瞎猜');

console.log('\n【后端：不把文件内容塞进上下文】');
/* 内容必须让模型自己用 read_file 取，否则大文件会把上下文撑爆 */
const ctxBlock = main.slice(main.indexOf('用户当前正在看的文件') - 800, main.indexOf('用户当前正在看的文件') + 800);
ok(!/getString\("content"\)|optString\("content"/.test(ctxBlock),
  '上下文里只给文件名和行号，不塞文件内容');

console.log('\n【提示词：告诉模型这个信息怎么用】');
ok(/用户说「这个」「这里」时/.test(tools), '提示词说明「这个/这里」指的是当前文件');
ok(/别反问是哪个文件/.test(tools), '提示词要求模型别反问是哪个文件');

console.log('\n' + (fail ? `有失败项（${pass} / ${pass + fail}）` : `全部通过（${pass} / ${pass + fail}）`));
process.exit(fail ? 1 : 0);
