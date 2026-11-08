/*
 * 读文件越界，不能返回空内容。
 *
 * <p>原来 startLine 超出文件行数时，循环一次都不执行，
 * 返回 {@code {path, totalLines:100, content:""}}。
 *
 * <p>模型拿到这个结果会怎么想？两种可能，都糟：
 *   · 「这 100 行都是空行」→ 以为文件没内容，去改别的地方
 *   · 「读不出来」→ 换个行号再试，白烧几轮
 *
 * <p>所以越界必须直接报错并说出真实行数。只读到一部分时也要说明还有多少，
 * 否则模型不知道后面还有内容，会以为看全了。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const tools=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/LocalDevTools.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── 读文件越界要报错 ───────────────────────────────');

const i=tools.indexOf('case "read_file":{');
check(i>0,'read_file is a proper block');
const seg=tools.slice(i,tools.indexOf('case "search_code"',i));

check(/if\(start>lines\.length\)throw new Exception\("起始行 "/.test(seg),
 'starting past the end of the file now throws');

check(/一共 "\s*\+lines\.length\+" 行/.test(seg)||/一共 /.test(seg),
 'the error states the real line count');

check(/returnedLines/.test(seg),
 'the result says how many lines were actually returned');

check(/startLine",start\)\.put\("endLine",end\)/.test(seg),
 'the result states the range that was read');

check(/后面还有 "/.test(seg),
 'a partial read says how many lines are left');

check(/startLine="\+\(end\+1\)/.test(seg),
 'a partial read tells the model the exact line to continue from');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
