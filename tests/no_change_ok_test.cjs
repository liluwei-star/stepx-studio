/*
 * 在项目里问一句话，不该冒出红色报错。
 *
 * <p>只要选了项目、模式不是「只讨论」，前端就会带 editMode 上来，
 * 后端于是走「写回文件」那段。可纯问答的模型<b>根本不会改文件</b> ——
 * stagedFiles 是 null，从正文里抠 files JSON 当然失败。
 *
 * <p>原来的处理是直接抛：
 * <pre>
 *   模型没有交回可写入的文件改动：……
 * </pre>
 * 于是用户问「这个项目有多少个文件」，模型正常回答了，
 * 屏幕上却多一条报错。用户会以为助手坏了 —— 其实什么都没坏。
 *
 * <p>正确做法：没改动就是没改动。只有「调了改文件的工具但一个都没成功」
 * 才算真出错，而那种情况下工具的报错本来就已经在对话里了，
 * 不用再叠一条吓人的红字。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const main=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/MainActivity.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 纯问答不该报错 ─────────────────────────────────');

check(!/throw new Exception\("模型没有交回可写入的文件改动/.test(main),
 'a question that changes nothing no longer throws');

check(/JSONObject staged=result\.optJSONObject\("stagedFiles"\);\s*if\(staged!=null\)\{\s*changes=staged;\s*\}else\{/.test(main),
 'the empty-change case is now handled instead of thrown');

check(/changes=new JSONObject\(\);\s*\}\s*\}\s*\}\s*JSONObject target=byId/.test(main.replace(/\r/g,'')),
 'an empty change set is used when the model changed nothing');

check(/这一轮没有改动文件/.test(main),
 'the user is told plainly that nothing changed');

// stagedFiles 仍然是第一优先来源
const stagedAt=main.indexOf('JSONObject changes=result.optJSONObject("stagedFiles")');
const parseAt=main.indexOf('changes=ProjectEdits.parse(result.optString("text"))');
check(stagedAt>0&&parseAt>stagedAt,
 'tool-path changes are still preferred over parsing the text');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
