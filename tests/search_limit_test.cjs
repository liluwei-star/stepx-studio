/*
 * 搜索结果不能没有上限。
 *
 * <p>search_code 的 schema 一直写着「最多返回多少条，默认 50」，
 * 但实现里是：
 *
 * <pre>
 * int limit = Math.max(1, args.optInt("limit", Integer.MAX_VALUE));
 * </pre>
 *
 * <p>Integer.MAX_VALUE 意味着<b>模型不传 limit 就是真的没有上限</b> ——
 * 服务端一般不会替模型填 schema 里的默认值。
 *
 * <p>这不是小问题。搜个 "import"、"const"、"e" 这种常见词，
 * 在几千个文件的项目里能命中几万行；每行最多 400 字符，
 * 就是几 MB 的 JSON。先把内存吃光（和之前那次 OOM 一模一样），
 * 再被外层整体截断成<b>非法 JSON</b> —— 模型收到半个数组，
 * 既不知道自己搜全了没有，也没法拉出上下文继续。
 *
 * <p>所以要三件事：
 *   1. 默认值改成 50（跟 schema 一致）；
 *   2. 硬上限 200（模型传 1000000 也不行）；
 *   3. 撞到上限时明说「可能还有更多」——
 *      不说的话，模型会以为这 50 条就是全部，
 *      于是得出「项目里只有这些地方用到它」这种错误结论。
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

console.log('\n── 搜索结果有上限 ───────────────────────────────');

check(!/optInt\("limit",Integer\.MAX_VALUE\)/.test(tools),
 'the unbounded default is gone');

check(/int limit=Math\.min\(\s*200\s*,\s*Math\.max\(1,\s*args\.optInt\("limit",\s*50\)\s*\)\s*\)/.test(tools),
 'limit defaults to 50 and is capped at 200');

check(/possiblyMore/.test(tools),
 'the result says whether there might be more matches');

check(/结果已达上限/.test(tools),
 'the note tells the model the results were cut off');

check(/out\.put\("possiblyMore",true\)/.test(tools),
 'the truncation flag is in the tool result');

check(/private JSONObject searchCode\(/.test(tools),
 'searchCode returns the matches together with the flag');

check(/JSONObject sr=searchCode\(files,args\)/.test(tools),
 'the call site reads the new return shape');

check(/最多 200/.test(schema),
 'the schema states the hard cap');

// 语义检查：上限必须真的被执行，而不是只写在注释里
const body=tools.slice(tools.indexOf('private JSONObject searchCode('));
const seg=body.slice(0,body.indexOf('\n }'));
check(/matches\.length\(\)>=limit/.test(seg),
 'the loop actually stops at the limit');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
