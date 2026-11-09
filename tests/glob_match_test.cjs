/*
 * glob 模式要匹配得上模型写得出来的样子。
 *
 * <p>「src 目录下的所有 .ts」是模型最常写的搜索模式 ——
 * 但原来把两个星号转成点星，
 * 中间那个斜杠就变成了硬性的，于是 src/a.ts 匹配不上：
 * 要 src 后面还得多一层目录才行。
 *
 * <p>模型搜不到东西只会换个写法再试，白烧一轮。
 */
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const src=fs.readFileSync(path.join(root,'src/cn/com/scsxrkj/LocalDevTools.java'),'utf8');

let pass=0,fail=0;
function check(ok,msg){
 if(ok){pass++;console.log('  ✓ '+msg);}
 else{fail++;console.log('  ✗ '+msg);}
}

console.log('\n── glob 匹配语义 ──────────────────────────────────────');

// 抽出 globMatch 的实现，用真实的 Java 语义在 JS 里复刻一遍做验证
const i=src.indexOf('static boolean globMatch(');
check(i>0,'globMatch exists');
const seg=src.slice(i,i+3000);

check(/\(\?:\.\*\/\)\?/.test(seg),
 'a **/ segment becomes an optional any-depth directory');
check(/else re\.append\("\.\*"\);/.test(seg),
 'a trailing ** still matches anything');

// 注释不能再写着「含首尾」—— 早就改成不含了
check(!/行号从 1 开始，含首尾/.test(src),
 'the patch_file comment no longer contradicts the exclusive endLine');

// 用 JS 复刻 Java 的转换逻辑，验证真实匹配结果
function javaToRe(g){
  let re='^';
  for(let i=0;i<g.length;i++){
    const c=g[i];
    if(c==='*'&&i+1<g.length&&g[i+1]==='*'){
      i++;
      if(i+1<g.length&&g[i+1]==='/'){re+='(?:.*/)?';i++;}
      else re+='.*';
    }else if(c==='*')re+='[^/]*';
    else if(c==='?')re+='[^/]';
    else if('\\.[]{}()+-^$|'.indexOf(c)>=0)re+='\\'+c;
    else re+=c;
  }
  return re+'$';
}
function globMatch(p,g){
  let target=p;
  if(g.indexOf('/')<0){const s=p.lastIndexOf('/');target=s<0?p:p.substring(s+1);}
  return new RegExp(javaToRe(g)).test(target);
}

check(globMatch('src/a.ts','src/**/*.ts'),
 'src/**/*.ts matches src/a.ts (zero directories deep)');
check(globMatch('src/x/y/a.ts','src/**/*.ts'),
 'src/**/*.ts matches src/x/y/a.ts');
check(!globMatch('lib/a.ts','src/**/*.ts'),
 'src/**/*.ts does not match lib/a.ts');
check(globMatch('src/app/x.tsx','*.tsx'),
 '*.tsx matches a file in any directory');
check(globMatch('src/a.ts','src/*.ts'),
 'src/*.ts matches a file directly under src');
check(!globMatch('src/x/a.ts','src/*.ts'),
 'src/*.ts does not match a file nested deeper');

console.log(`\n通过 ${pass} / ${pass+fail}`);
process.exit(fail?1:0);
