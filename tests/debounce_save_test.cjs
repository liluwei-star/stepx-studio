/*
 * 打字不能被「每键全量保存」拖住。
 *
 * 编辑器原来每敲一个字符就 saveProject()，原生那边保存是把整份
 * workspace.json 重写一遍 —— 实测 7.5 MB。打字时每秒好几个字符，
 * 就是每秒重写好几遍 7.5 MB：打字卡顿、手机发热、闪存反复擦写。
 *
 * 但也不能简单改成「只在不敲了才保存」：用户敲完立刻切走、
 * 或者应用被系统回收，最后那几个字符就丢了。
 *
 * 所以规则是：
 *   ① 敲字只改内存，400 毫秒内没有新输入才落盘；
 *   ② 任何可能离开编辑或要让机器读文件的动作之前，先 flushNow()。
 *
 * ② 是最容易被漏掉的一半 —— 少了它，「防抖」就变成了「丢字」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* 源码是 CRLF；断言里写的是 \n，先归一化再比，否则全部对不上 */
const app = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('── 保存改成防抖 ────────────────────────────────');
ok('存在 saveSoon', /function saveSoon\(\)/.test(app));
ok('存在 flushNow', /function flushNow\(\)/.test(app));
ok('防抖窗口是 400ms', /setTimeout\(\(\)=>\{saveTimer=null;try\{saveProject\(\);\}catch\(e\)\{\}\},400\)/.test(app));
const iCode = app.indexOf("$('#code').value=currentContent(p,file)");
const iInput = iCode >= 0 ? app.indexOf("addEventListener('input'", iCode) : -1;
/* 只取 input 这一个监听器的体，别把后面的 keydown（里面确实有 saveProject）算进来 */
const iKeydown = iInput >= 0 ? app.indexOf("addEventListener('keydown'", iInput) : -1;
const inputSeg = iInput >= 0 ? app.slice(iInput, iKeydown > iInput ? iKeydown : iInput + 600) : '';
ok('输入事件走 saveSoon，不再每键写盘', inputSeg.indexOf('saveSoon()') >= 0);
ok('输入事件里没有直接 saveProject()', inputSeg.indexOf('saveProject()') < 0,
  '还在每键全量保存');
ok('失焦立刻落盘', app.indexOf("addEventListener('blur',()=>flushNow())") >= 0);

console.log('\n── 关键动作之前必须 flush ──────────────────────');
const mustFlush = [
  ["切换文件", "case 'file':flushNow();"],
  ["原生要求打开文件", "if(type==='openFile'){flushNow();"],
  ["打开项目", "if(type==='projectOpen'){\n  flushNow();"],
  ["AI 改动落盘", "if(type==='filesApplied'){\n  /* 待写的内容先落盘"],
  ["发送给 AI", "function sendMessage(){\n  if(busy)return;"],
];
for (const [name, needle] of mustFlush) {
  ok(name + ' 之前 flush', app.indexOf(needle) >= 0, needle.slice(0, 40));
}
{
  const iSend = app.indexOf('function sendMessage()');
  const sendSeg = iSend >= 0 ? app.slice(iSend, iSend + 500) : '';
  ok('sendMessage 里确实调用了 flushNow', sendSeg.indexOf('flushNow()') >= 0);
}

console.log('\n── Ctrl+S 仍然立刻保存 ─────────────────────────');
ok('快捷键走 saveProject（用户主动要求立刻存）',
  app.indexOf("e.key==='s'") >= 0 && app.indexOf('saveProject()}') >= 0);

console.log('\n── 撤销栈仍然即时可用 ─────────────────────────');
ok('input 里仍然维护 undo/redo',
  inputSeg.indexOf('undo.push(') >= 0 && inputSeg.indexOf('undo.shift()') >= 0);

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
