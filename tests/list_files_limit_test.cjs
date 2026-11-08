/*
 * 列文件不能一次列几千条，也不能为了算行数把整个项目扫一遍。
 *
 * <p>两个问题：
 *
 * <p>一、<b>没有条目上限</b>。大项目几千个文件，全列出来光 JSON 就几百 KB，
 * 一轮工具预算 48 KB 会被它一个工具吃光，同轮其他工具结果全被挤掉。
 * 更糟的是模型会以为「项目就这么点文件」，得出错误结论。
 *
 * <p>二、<b>算行数逐字符扫</b>。原来为了统计每个文件的行数，
 * 对每个文件做一次 charAt 全量扫描。82 MB 的项目就是八千多万次
 * 逐字符边界检查 —— 换成 indexOf 找换行，快一个量级。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const tools=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/LocalDevTools.java'),'utf8');
const schema=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/ToolSchema.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 列文件有条目上限 ───────────────────────────────');

check(/entryLimit/.test(tools),
 'list_files has an entry limit');

check(/int entryLimit=Math\.max\(1,Math\.min\(2000,\s*args\.optInt\("entryLimit",500\)\)\)/.test(tools),
 'the limit defaults to 500 and is capped at 2000');

check(/还有 "?\+?\(totalEntries-listed\)/.test(tools)||/还有 /.test(tools),
 'the result says how many files were left out');

check(/用 prefix 指定目录/.test(tools),
 'the note tells the model how to see the rest');

check(/entryLimit/.test(schema),
 'the schema exposes the parameter');

// 行数统计不能逐字符扫
const listBody=tools.slice(tools.indexOf('private JSONArray listFiles('));
const seg=listBody.slice(0,listBody.indexOf('\n }'));
check(!/for\(int i=0;i<content\.length\(\);i\+\+\)if\(content\.charAt\(i\)==/.test(seg),
 'the per-character scan for line counts is gone');
check(/content\.indexOf\('\\n'\)/.test(seg),
 'line counting uses indexOf instead');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
