/*
 * 只改一行，不该报「行号范围无效」。
 *
 * <p>patch_file 的实现原来是：
 *
 * <pre>
 *   int end = Math.min(lineCount, args.optInt("endLine", 0));
 *   if (end < start) throw new Exception("行号范围无效...");
 * </pre>
 *
 * <p>不传 endLine 就得到 0，接着 end&lt;start 直接抛错 ——
 * 也就是说<b>模型只想改一行的时候，patch_file 一定失败</b>。
 * 而「改一行」是最常见的改法。
 *
 * <p>模型收到「行号范围无效」，会以为自己行号算错了，
 * 于是重新 read_file、重新数行、再试一次，还是错 ——
 * 反复到轮数上限。工具本身是好的，是默认值让最普通的调用必然失败。
 *
 * <p>顺带两个同源的坑：
 *   · 提示词写「行号含首尾」，实现是不含 —— 差一行，改坏代码
 *   · schema 写着「留空表示只改 startLine 那一行」，实现没跟上
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

console.log('\n── 只改一行要能改 ─────────────────────────────────');

check(/int endLineArg=args\.optInt\("endLine",0\);/.test(tools),
 'endLine is read into its own variable');

check(/int endExclusive=endLineArg>0\?Math\.min\(lineCount\+1,Math\.max\(start\+1,endLineArg\)\):start\+1;/.test(tools),
 'a missing endLine now means "one line", and endLine is treated as 1-based and exclusive');

check(/result\.addAll\(list\.subList\(endExclusive-1,lineCount\)\)/.test(tools),
 'the tail is kept from the 1-based index, so no line is eaten by an off-by-one');

check(!/int end=Math\.min\(lineCount,args\.optInt\("endLine",0\)\)/.test(tools),
 'the old zero-default is gone');

check(/endLine 不含在替换范围内/.test(tools)||/按「不含」写/.test(tools),
 'endLine is documented as exclusive, and both readings are tolerated');

check(/boolean endLineClamped=endLineArg>0&&endLineArg<=start;/.test(tools),
 'endLine equal to startLine is tolerated instead of thrown');

check(!/行号从1开始、含首尾/.test(tools),
 'the contradictory "inclusive" wording is gone');

check(/留空表示只改 startLine 那一行/.test(schema),
 'the schema and the implementation now agree');

// multi_patch 走同一套行号规则
check(/endLine 规则和 patch_file 一样/.test(tools),
 'multi_patch is documented with the same rule');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
