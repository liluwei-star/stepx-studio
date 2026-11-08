/*
 * 取消之后要说清楚：本轮改动不会写回。
 *
 * <p>取消按钮一直是好的 —— 前端发 {@code cancel}，后端断连接、循环退出。
 * 但取消<b>没有任何提示</b>：图标一转、界面复原，看起来像「暂停了一下」。
 *
 * <p>用户的心理预期是「停下来，等下接着来」。实际发生的是
 * 「本轮暂存的文件改动全部丢弃」—— 回头发现文件没动，
 * 他只会觉得助手又骗了一次。
 *
 * <p>所以取消要给一句话：改动没保存。这不是功能问题，是信任问题。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const main=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/MainActivity.java'),'utf8');
const app=fs.readFileSync(path.join(root,'assets/app.js'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 取消要说清后果 ─────────────────────────────────');

check(/case 'cancel':send\('cancel'\);break;/.test(app),
 'the UI sends a cancel action');

check(/case "cancel":\{/.test(main),
 'the backend handles it');

check(/active\.cancel\(\)/.test(main),
 'the running request is actually cancelled');

check(/本轮还没写回的改动不会保存/.test(main),
 'the user is told the staged changes will not be saved');

check(/art\.cancel\(\)/.test(main),
 'cancelling still stops the art task too');

// 不要留两个入口
check(!/case "aiStop"/.test(main),
 'there is only one cancel entry point');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
