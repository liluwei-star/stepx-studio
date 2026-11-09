/*
 * 用户手动存的存档，不能被自动存档顶掉。
 *
 * <p>原来的裁剪是无脑「只留最后一份/最后两份」：
 * AI 每改一轮代码就自动追加一份存档，用户之前手动点的那份
 * 就被挤掉了 —— 「变更」视图的基准悄悄换了，用户毫无察觉。
 *
 * <p>现在自动存档和用户存档分开算：自动的只留最近几份，用户的全留。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const cloud=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/CloudFiles.java'),'utf8');
const edits=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/ProjectEdits.java'),'utf8');
const main=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/MainActivity.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 用户存档不会被自动存档顶掉 ───────────────────────');

check(/isUserSnapshot/.test(cloud),
 'snapshots know which ones the user made');

check(/static boolean isUserSnapshot\(JSONObject s\)/.test(cloud),
 'there is a helper that tells user snapshots apart');

// 老存档（没有 source）必须当作用户的
check(/if\(src\.isEmpty\(\)\)return true;/.test(cloud),
 'an old snapshot with no source field counts as the user\'s');

// 自动存档要留最近的，不是最老的
check(/autoSeen<=autoDrop\)continue;/.test(cloud),
 'the oldest automatic snapshots are the ones dropped');

// 用户手动存档标记成 user
check(/CloudFiles\.snapshot\(proj,null,"user"\)/.test(main),
 'a manual snapshot is marked as the user\'s');

// AI 改动走同一套裁剪
check(/CloudFiles\.trimSnapshots\(snaps,mine\)/.test(edits),
 'AI edits go through the same trimming so they cannot evict a user snapshot');

// 自动存档标成 auto
check(/put\("source","auto"\)/.test(edits),
 'an automatic snapshot is marked as automatic');

// 状态清洗也不能把用户存档丢掉
check(/CloudFiles\.isUserSnapshot\(s\)\)keepList\.add\(s\)/.test(main),
 'state cleanup keeps every user snapshot');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
