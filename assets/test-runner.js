/*
 * test-runner.js —— 在设备上跑项目的单元测试
 * ================================================================
 * 手机上没有 node，跑不了 vitest / jest 的原生实现。
 * 但绝大多数前端单元测试只做两件事：调用一个函数、断言它的返回值。
 * 这两件事 esbuild + 一个几十行的断言库就能做到，不需要 node。
 *
 * 流程：找测试文件 → esbuild 打包成 IIFE → 执行 → 收集断言结果。
 *
 * 结果写到 window.__neoTest，Java 侧轮询这个变量。
 * ================================================================
 */
(async()=>{
 const p=await fetch('/project.json').then(r=>r.json());
 const text=p.files||{},binaries=p.binaryFiles||{};
 const started=Date.now();

 /* ── 路径工具（和 local-runner 同一套语义）──────────────────── */
 const clean=n=>{const out=[];for(const part of String(n).split('/')){if(!part||part==='.')continue;if(part==='..'){if(!out.length)throw Error('路径越出项目：'+n);out.pop();}else out.push(part);}return out.join('/');};
 const dir=n=>n.slice(0,n.lastIndexOf('/')+1);
 const exists=n=>Object.hasOwn(text,n)||Object.hasOwn(binaries,n);
 const EXT=['','.ts','.tsx','.js','.jsx','.mjs','.json','/index.ts','/index.tsx','/index.js','/index.jsx'];
 const resolvePath=n=>{for(const x of EXT)if(exists(n+x))return n+x;throw Error('找不到本地文件：'+n);};

 /* ── 断言与用例收集 ─────────────────────────────────────────── */
 const suites=[];      // [{name, cases:[{name, ok, error}]}]
 const errors=[];      // 打包/加载阶段的错误
 let passed=0,failed=0,skipped=0;
 let currentSuite=null;
 const hooks={before:[],after:[],beforeEach:[],afterEach:[]};

 const newSuite=name=>{const s={name,cases:[]};suites.push(s);return s;};

 /* 深比较：处理数组、对象、NaN、循环引用（简化为弱循环检测） */
 const deepEqual=(a,b,depth)=>{
  if(a===
     b)return true;
  if(Number.isNaN(a)&&Number.isNaN(b))return true;
  if(typeof a!==typeof b)return false;
  if(a===null||b===null)return false;
  if(typeof a!=='object')return false;
  if((depth||0)>8)return false;
  const aa=Array.isArray(a),bb=Array.isArray(b);
  if(aa!==bb)return false;
  if(aa){
   if(a.length!==b.length)return false;
   for(let i=0;i<a.length;i++)if(!deepEqual(a[i],b[i],(depth||0)+1))return false;
   return true;
  }
  const ka=Object.keys(a),kb=Object.keys(b);
  if(ka.length!==kb.length)return false;
  for(const k of ka)if(!deepEqual(a[k],b[k],(depth||0)+1))return false;
  return true;
 };

 const show=v=>{try{const s=JSON.stringify(v);return s===undefined?String(v):(s.length>300?s.slice(0,300)+'…':s);}catch(e){return String(v);}};

 /*
  * 内建断言库。
  *
  * 只实现最常用的几个 —— 目标是让 AI 写的测试能跑起来，
  * 不是复刻整个 jest。用得最多的就是 toBe / toEqual / toContain / toThrow。
  */
 function expect(actual){
  const fail=msg=>{throw Error(msg);};
  const api={
   toBe(exp){if(actual!==exp)fail('期望 '+show(exp)+'，实际 '+show(actual));},
   toEqual(exp){if(!deepEqual(actual,exp))fail('期望等于 '+show(exp)+'，实际 '+show(actual));},
   toStrictEqual(exp){if(!deepEqual(actual,exp))fail('期望严格等于 '+show(exp)+'，实际 '+show(actual));},
   toBeTruthy(){if(!actual)fail('期望为真，实际 '+show(actual));},
   toBeFalsy(){if(actual)fail('期望为假，实际 '+show(actual));},
   toBeNull(){if(actual!==null)fail('期望 null，实际 '+show(actual));},
   toBeUndefined(){if(actual!==undefined)fail('期望 undefined，实际 '+show(actual));},
   toBeDefined(){if(actual===undefined)fail('期望已定义，实际 undefined');},
   toBeGreaterThan(n){if(!(actual>n))fail('期望大于 '+show(n)+'，实际 '+show(actual));},
   toBeLessThan(n){if(!(actual<n))fail('期望小于 '+show(n)+'，实际 '+show(actual));},
   toBeGreaterThanOrEqual(n){if(!(actual>=n))fail('期望不小于 '+show(n)+'，实际 '+show(actual));},
   toBeLessThanOrEqual(n){if(!(actual<=n))fail('期望不大于 '+show(n)+'，实际 '+show(actual));},
   toBeCloseTo(n,digits){const d=Math.pow(10,-(digits||2));if(Math.abs(actual-n)>d)fail('期望约等于 '+show(n)+'，实际 '+show(actual));},
   toContain(item){
    if(typeof actual==='string'){if(!actual.includes(item))fail('期望包含 '+show(item)+'，实际 '+show(actual));}
    else if(Array.isArray(actual)){if(!actual.some(x=>x===item||deepEqual(x,item)))fail('期望数组包含 '+show(item)+'，实际 '+show(actual));}
    else fail('toContain 只能用于字符串或数组');
   },
   toHaveLength(n){if(!actual||actual.length!==n)fail('期望长度 '+n+'，实际 '+show(actual&&actual.length));},
   toMatch(re){const ok=re instanceof RegExp?re.test(actual):String(actual).includes(re);if(!ok)fail('期望匹配 '+show(re)+'，实际 '+show(actual));},
   toThrow(msg){
    let threw=false,err=null;
    try{actual();}catch(e){threw=true;err=e;}
    if(!threw)fail('期望抛出异常，但没有抛');
    if(msg&&!String(err&&err.message||err).includes(msg))fail('异常信息里没有「'+msg+'」，实际 '+show(String(err&&err.message||err)));
   },
   toBeInstanceOf(cls){if(!(actual instanceof cls))fail('期望是 '+(cls&&cls.name)+' 的实例');},
   get not(){
    return {
     toBe(exp){if(actual===exp)fail('期望不等于 '+show(exp));},
     toEqual(exp){if(deepEqual(actual,exp))fail('期望不等于 '+show(exp));},
     toBeTruthy(){if(actual)fail('期望为假，实际 '+show(actual));},
     toBeFalsy(){if(!actual)fail('期望为真，实际 '+show(actual));},
     toContain(item){if(typeof actual==='string'?actual.includes(item):Array.isArray(actual)&&actual.some(x=>x===item))fail('期望不包含 '+show(item));},
     toThrow(){let threw=false;try{actual();}catch(e){threw=true;}if(threw)fail('期望不抛异常，但抛了');},
    };
   },
  };
  return api;
 }

 /* 注册用例。支持同步和异步（返回 Promise）。 */
 const registry=[];
 const register=(name,fn,suite)=>{
  registry.push({name,fn,suite:suite||currentSuite||newSuite('默认')});
 };
 const describe=(name,fn)=>{
  const prev=currentSuite;
  const s=newSuite(name);
  currentSuite=s;
  try{fn();}catch(e){s.cases.push({name:'（describe 体本身抛出）',ok:false,error:String(e&&e.message||e)});failed++;}
  currentSuite=prev;
 };
 const it=(name,fn)=>register(name,fn);

 /* 暴露到全局，让打包后的测试代码能直接调用 */
 Object.assign(globalThis,{
  describe,it,test:it,expect,
  beforeEach:fn=>hooks.beforeEach.push(fn),
  afterEach:fn=>hooks.afterEach.push(fn),
  beforeAll:fn=>hooks.before.push(fn),
  afterAll:fn=>hooks.after.push(fn),
 });

 /* ── 找测试文件 ─────────────────────────────────────────────── */
 const TEST_RE=/(\.|-)(test|spec)\.(js|jsx|ts|tsx|mjs)$/i;
 /* 单个项目最多跑多少个测试文件。再多就是拖死手机，而且结果也没人看得完。 */
 const TEST_FILE_CAP=50;
 const allPaths=Object.keys(text);
 /*
  * 排除依赖目录和构建产物。
  * node_modules 里的测试文件动辄上千个，每个都要走一遍 esbuild 打包，
  * 在手机上就是直接卡死 —— 而且那些是别人的库，不是用户要验的东西。
  */
 const SKIP_RE=/(^|\/)(node_modules|dist|build|out|\.git|coverage)\//;
 const matched=allPaths.filter(n=>TEST_RE.test(n)&&!SKIP_RE.test(n)).sort();
 const testFiles=matched.slice(0,TEST_FILE_CAP);
 if(!testFiles.length){
  /*
   * 没有测试文件时 ok 必须是 false。
   *
   * <p>原来这里写的是 ok:true —— 理由大概是「没失败就是成功」。
   * 但模型看到 ok:true 就会说「测试通过了」，而实际上一个用例都没跑。
   * 这是<b>假阳性</b>：比明确报错更糟，因为它让人以为验证过了。
   *
   * <p>所以 ok=false，同时用 ran:false 明确说清「是没得跑，不是跑挂了」，
   * 让模型能分清「项目里没有测试」和「测试失败」这两种完全不同的情况。
   */
  window.__neoTest={
   ok:false,ran:false,files:0,passed:0,failed:0,skipped:0,durationMs:Date.now()-started,
   note:'项目里没有测试文件，所以没有任何用例被执行 —— 这不等于测试通过。'
    +'测试文件按 *.test.ts / *.test.js / *.spec.ts 命名，放在源码旁边即可。'
    +'如果要验证这次改动，就自己写一个测试文件，或者改用 run_script 直接验算。',
   suites:[],errors:[],
  };
  return;
 }

 /* ── esbuild 虚拟文件系统 ───────────────────────────────────── */
 await esbuild.initialize({wasmURL:'/local-vendor/esbuild.wasm',worker:false});

 let pkg={};
 try{if(text['package.json'])pkg=JSON.parse(text['package.json']);}catch(e){}

 const globalsShim=[
  'const g=globalThis;',
  'export const describe=g.describe,it=g.it,test=g.test,expect=g.expect;',
  'export const beforeEach=g.beforeEach,afterEach=g.afterEach,beforeAll=g.beforeAll,afterAll=g.afterAll;',
  'export default {describe,it,test,expect,beforeEach,afterEach,beforeAll,afterAll};',
 ].join('\n');

 const plugin={
  name:'neo-test-files',
  setup(b){
   b.onResolve({filter:/^(@jest\/globals|vitest|@vitest\/globals|chai|node:assert|assert)$/},()=>({path:'\0test-globals',namespace:'shim'}));

   b.onResolve({filter:/.*/},a=>{
    const n=a.path;
    if(n.startsWith('.')||n.startsWith('/')||n.startsWith('@/')){
     let path=n;
     if(path.startsWith('@/'))path='src/'+path.slice(2);
     else if(path.startsWith('/'))path=path.slice(1);
     else path=dir(a.importer||'')+path;
     try{return {path:'/'+resolvePath(clean(path)),namespace:'project'};}
     catch(e){return {errors:[{text:e.message}]};}
    }
    /* 内置依赖：交给平台的 vendor 命名空间，和正常编译保持一致 */
    return {path:'/__vendor/'+n,external:true};
   });

   b.onLoad({filter:/.*/,namespace:'shim'},()=>({contents:globalsShim,loader:'js'}));

   b.onLoad({filter:/.*/,namespace:'project'},a=>{
    const path=a.path.slice(1);
    const ext=path.split('.').pop().toLowerCase();
    if(ext==='css')return {contents:'',loader:'css'};
    if(['png','jpg','jpeg','webp','gif','ico','woff','woff2','ttf','mp3','mp4'].includes(ext)){
     const b64=binaries[path];
     if(!b64)return {contents:'',loader:'dataurl'};
     return {contents:Uint8Array.from(atob(b64),c=>c.charCodeAt(0)),loader:'dataurl'};
    }
    const raw=text[path];
    if(raw===undefined)return {errors:[{text:'找不到文件内容：'+path}]};
    return {contents:raw,loader:ext==='tsx'?'tsx':ext==='ts'?'ts':ext==='jsx'?'jsx':ext==='json'?'json':'js'};
   });
  },
 };

 /* ── 逐个打包并执行 ─────────────────────────────────────────── */
 const runOne=async file=>{
  let code;
  try{
   const result=await esbuild.build({
    entryPoints:['/'+file],
    bundle:true,write:false,format:'iife',platform:'browser',target:'chrome110',
    jsx:'automatic',outfile:'/__neo_test.js',plugins:[plugin],
    define:{'process.env.NODE_ENV':'"test"','import.meta.env':JSON.stringify({MODE:'test',DEV:false,PROD:false,BASE_URL:'/'})},
    logLevel:'silent',
   });
   code=result.outputFiles&&result.outputFiles.length?result.outputFiles[0].text:'';
  }catch(e){
   const detail=e&&e.errors&&e.errors.length
    ? e.errors.map(x=>(x.location?(x.location.file+':'+x.location.line+' '):'')+x.text).join('\n')
    : String(e&&e.message||e);
   errors.push({file,error:'打包失败：'+detail});
   return;
  }
  try{
   /* 用 Function 而不是 eval：在全局作用域下执行，能拿到注入的 describe/it/expect */
   new Function(code)();
  }catch(e){
   errors.push({file,error:'执行时抛出：'+String(e&&e.stack||e&&e.message||e)});
  }
 };

 for(const f of testFiles){
  try{await runOne(f);}
  catch(e){errors.push({file:f,error:String(e&&e.message||e)});}
 }

 /* ── 逐个跑用例（含 beforeEach/afterEach）──────────────────── */
 for(const r of registry){
  const suite=r.suite;
  const rec={name:r.name,ok:true};
  try{
   for(const h of hooks.beforeEach)await h();
   await r.fn();
  }catch(e){
   rec.ok=false;
   rec.error=String(e&&e.message||e);
   failed++;
  }
  try{for(const h of hooks.afterEach)await h();}catch(e){}
  if(rec.ok)passed++;
  suite.cases.push(rec);
 }
 for(const h of hooks.after)try{await h();}catch(e){}

 /* 清掉空套件，别让结果里出现一堆「默认」 */
 const cleanSuites=suites.filter(s=>s.cases.length>0).map(s=>({
  name:s.name,
  cases:s.cases.map(c=>c.ok?{name:c.name,ok:true}:{name:c.name,ok:false,error:c.error}),
 }));

 if(matched.length>TEST_FILE_CAP){
  errors.push({file:'（项目）',error:'项目里有 '+matched.length+' 个测试文件，本次只跑了前 '+TEST_FILE_CAP+' 个'});
 }
 window.__neoTest={
  ok:failed===0&&errors.length===0,
  ran:true,
  files:testFiles.length,
  filesList:testFiles,
  matched:matched.length,
  passed,failed,skipped,
  durationMs:Date.now()-started,
  suites:cleanSuites,
  errors,
 };
})().catch(e=>{
 window.__neoTest={ok:false,error:String(e&&e.message||e),passed:0,failed:0,suites:[],errors:[{error:String(e&&e.message||e)}]};
});
