/* Compiles only the selected local snapshot; no Studio login or native bridge. */
(async()=>{
 const [p,vendor]=await Promise.all([fetch('/project.json').then(r=>r.json()),fetch('/local-vendor/manifest.json').then(r=>r.json())]);
 const text=p.files, binaries=p.binaryFiles||{}, output={}, enc=s=>({encoding:'utf8',content:s});
 /**
  * 平台虚拟模块 → 项目里的实际文件。
  *
  * <p>平台构建时用固定的 ASCII 模块名引用内容，避开中文文件名在 URL 里被转码的问题。
  * 这里照搬这个映射：找到对应文件，把内容当字符串导出。
  */
 const VIRTUAL_MODULES={
  'virtual:help-guide':['使用说明.md','使用说明.txt','README.md'],
  /*
   * 下面两个是兼容旧项目用的。
   *
   * 清洗器曾经把 `virtual:help-guide` 的引用改写成
   * `src/generated/help-guide.ts`，理由是「编译器不支持虚拟模块」——
   * 这个判断是错的，而且那个文件只在平台构建时生成，源码里从来没有。
   * 结果就是构建直接报「尚未内置依赖」。
   *
   * 清洗器那边已经改了，但已经被改坏的项目还在。
   * 在这里认一下，让它照样能编，用户不用手动去改源码。
   */
  'src/generated/help-guide.ts':['使用说明.md','使用说明.txt','README.md'],
  'src/generated/help-guide':['使用说明.md','使用说明.txt','README.md'],
 };
 for(const [n,s]of Object.entries(text))output[n]=enc(s);
 for(const [n,s]of Object.entries(binaries))output[n]={encoding:'base64',content:s};
 if(!text['index.html'])throw Error('缺少 index.html。当前本机运行支持 HTML / React / TSX 前端工程。');
 await esbuild.initialize({wasmURL:'/local-vendor/esbuild.wasm',worker:false});
 let pkg={};if(text['package.json'])pkg=JSON.parse(text['package.json']);
 const used=new Set(), warnings=new Set(), patchNotes=[];
 const clean=n=>{let out=[];for(const part of n.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!out.length)throw Error('路径越出项目：'+n);out.pop();}else out.push(part);}return out.join('/')};
 const dir=n=>n.slice(0,n.lastIndexOf('/')+1);
 const exists=n=>Object.hasOwn(text,n)||Object.hasOwn(binaries,n);
 const resolve=n=>{for(const x of [n,n+'.ts',n+'.tsx',n+'.js',n+'.jsx',n+'.json',n+'/index.ts',n+'/index.tsx',n+'/index.js',n+'/index.jsx'])if(exists(x))return x;throw Error('找不到本地文件：'+n)};
 const aliases={'@/':'src/'};
 if(text['tsconfig.json']){try{const t=JSON.parse(text['tsconfig.json'].replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm,'').replace(/,\s*([}\]])/g,'$1'));for(const [k,v]of Object.entries(t.compilerOptions?.paths||{}))if(k.endsWith('/*')&&v[0]?.endsWith('/*'))aliases[k.slice(0,-1)]=clean((t.compilerOptions.baseUrl||'.')+'/'+v[0].slice(0,-1))+'/';}catch(e){warnings.add('tsconfig 使用默认 @/ → src/');}}
 const local=(n,from='')=>{for(const [key,val]of Object.entries(aliases))if(n.startsWith(key))return resolve(clean(val+n.slice(key.length)));return resolve(clean(n.startsWith('/')?n:dir(from)+n))};
 let tw;
 async function css(n,stack=[]){if(stack.includes(n))throw Error('CSS 循环导入：'+n);let s=text[n];
  const re=/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?\s*;/g;let out='',last=0;
  for(const m of s.matchAll(re)){out+=s.slice(last,m.index);if(/^(https?:|\/\/)/.test(m[1]))out+=m[0];else out+=await css(local(m[1],n),[...stack,n]);last=m.index+m[0].length;}s=out+s.slice(last);
  // Resolve CSS resource URLs before inlining so nested resources retain their base directory.
  s=s.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,(all,q,url)=>/^(data:|https?:|\/\/|#)/.test(url)?all:'url("/'+clean(url.startsWith('/')?url:dir(n)+url)+'")');
  return s;
 }
 async function styles(n){let s=await css(n);if(/@(?:tailwind|apply|layer)\b/.test(s)){
   if(!tw){let config={};const src=text['tailwind.config.js']||text['tailwind.config.ts'];if(src){const t=await esbuild.transform(src,{loader:'ts',format:'cjs'});const module={exports:{}};new Function('module','exports','require',t.code)(module,module.exports,n=>{throw Error('本机尚不支持 Tailwind 配置插件：'+n)});config=module.exports.default||module.exports;}tw=NeoTools.createTailwindcss({tailwindConfig:config});}
   s=await tw.generateStylesFromContent(s,Object.entries(text).map(([n,content])=>({content,extension:n.split('.').pop()})));
  }return s;
 }
 const plugin={name:'neo-local-files',setup(b){b.onResolve({filter:/.*/},a=>{
   let n=a.path;
   // 平台虚拟模块：内容其实是项目里的一个文件，只是换了个 ASCII 名字引用。
   //
   // 为什么平台要这么绕：中文文件名直接 import 会让开发服务器生成一条带中文的
   // 模块地址，经过反向代理时可能被转码或拒绝，表现为页面一直停在「加载没有完成」。
   // 所以平台用固定名 'virtual:help-guide'，内容在构建期从 '使用说明.md' 读进来内联。
   //
   // 这里做同样的事：从项目里找到对应的说明文档，把内容当字符串导出。
   // 找不到就当空字符串 —— 让编译继续，总比整个构建失败好。
   if(VIRTUAL_MODULES[n]){
    const candidates=VIRTUAL_MODULES[n];
    for(const c of candidates){
     if(text[c]!==undefined){
      return {path:'\0virtual:'+n,namespace:'virtual-module'};
     }
    }
    return {path:'\0virtual:'+n,namespace:'virtual-module'};
   }
   if(vendor[n]){const v=vendor[n],wanted=pkg.dependencies?.[v.package];if(wanted&&!NeoTools.satisfies(v.version,wanted))throw Error('依赖版本不兼容：'+v.package+' 要求 '+wanted+'，本机内置 '+v.version);used.add(v.package+' '+v.version);if(v.file.endsWith('.css'))return {path:v.file,namespace:'vendor-css'};return {path:'/__vendor/'+v.file,external:true};}
   if(n.startsWith('.')||n.startsWith('/')||Object.keys(aliases).some(k=>n.startsWith(k)))return {path:local(n,a.importer),namespace:'project'};
   throw Error('本机尚未内置依赖：'+n+'。请使用云端运行或改用已支持依赖。');
  });b.onLoad({filter:/.*/,namespace:'vendor-css'},async a=>({contents:await fetch('/local-vendor/'+a.path).then(r=>r.text()),loader:'css'}));
   b.onLoad({filter:/.*/,namespace:'virtual-module'},a=>{
    const key=a.path.replace(/^\0virtual:/,'');
    const candidates=VIRTUAL_MODULES[key]||[];
    let content='';
    for(const c of candidates){if(text[c]!==undefined){content=text[c];break;}}
    // 导出成字符串：平台那边是 export default 字符串
    return {contents:'export default '+JSON.stringify(content),loader:'js'};
   });b.onLoad({filter:/.*/,namespace:'project'},async a=>{
   const ext=a.path.split('.').pop().toLowerCase();
   if(ext==='css')return {contents:await styles(a.path),loader:'css'};
   if(['png','jpg','jpeg','webp','gif','ico','woff','woff2','ttf','mp3','mp4','svg'].includes(ext)){const bytes=binaries[a.path]?Uint8Array.from(atob(binaries[a.path]),c=>c.charCodeAt(0)):new TextEncoder().encode(text[a.path]);return {contents:bytes,loader:'dataurl'};}
   const raw=text[a.path];
   let contents=expandGlob(raw,a.path);
   // 源码适配：给平台专属的源码补上本机环境的能力（录音、选文件）。
   // 源码本身不动，改动只发生在编译产物里 —— 用户看不到源码被改。
   if(typeof NeoAdapters!=='undefined'){
    try{contents=NeoAdapters.apply(a.path,contents,patchNotes);}catch(e){warnings.add('源码适配失败：'+a.path);}
   }
   return {contents,loader:({tsx:'tsx',ts:'ts',jsx:'jsx',js:'jsx',mjs:'js',json:'json'})[ext]||'text'};
  });}};
 /**
  * 把 import.meta.glob 换成真实的文件映射。
  *
  * <p>import.meta.glob 是 Vite 独有的语法，esbuild 不认识 —— 它会在解析阶段
  * 直接报错「Could not resolve import.meta.glob」。
  *
  * <p>做法：在编译每个模块之前，先扫一遍源码，把 glob 模式展开成普通对象字面量。
  * glob 的语义是「按模式找文件，返回路径 → 导入函数」，
  * 但项目里用到的地方多半是 { eager: true, query: '?url', import: 'default' }，
  * 也就是「路径 → 文件的 URL」。
  *
  * <p>这里生成 URL 字符串而不是真的 import ——
  * 图片资源在出包时会原样拷进 assets，路径对得上就能显示。
  *
  * @param src 源码
  * @param from 当前模块路径（用来解析相对路径）
  * @return 替换后的源码
  */
 function expandGlob(src,from){
  if(!src.includes('import.meta.glob'))return src;
  const base=from.includes('/')?from.slice(0,from.lastIndexOf('/')+1):'';
  return src.replace(/import\.meta\.glob\s*\(\s*(['"`])([^'"`]+)\1\s*(,[\s\S]{0,300}?)?\)/g,(all,q,pattern,opts)=>{
   // 把模式转成正则：* 匹配一段，** 匹配多段
   const re=new RegExp('^'+pattern.replace(/[.+^$()|[\]{}]/g,'\\$&').replace(/\*\*/g,'\u0000').replace(/\*/g,'[^/]*').replace(/\u0000/g,'.*')+'$');
   const hits={};
   for(const n of Object.keys(text)){
    const rel=base?resolveRel(base,n):n;
    if(re.test(rel))hits[rel]='"'+rel+'"';
   }
   // 只要了 import:'default' 的就返回字符串，否则返回函数
   const wantFn=!opts||!opts.includes("import:'default'")&&!opts.includes('import: \'default\'');
   if(wantFn){
    const entries=Object.keys(hits).map(k=>k+':()=>Promise.resolve('+hits[k]+')').join(',');
    return '{'+entries+'}';
   }
   return '{'+Object.keys(hits).map(k=>k+':'+hits[k]).join(',')+'}';
  });
 }
 /**
  * 把相对路径从 from 目录解析成项目根的相对路径。
  */
 function resolveRel(base,n){
  const segs=(base+n).split('/');
  const out=[];
  for(const s of segs){if(s==='..')out.pop();else if(s!=='.'&&s!=='')out.push(s);}
  return out.join('/');
 }
 /**
  * 把构建产物里的识别模型搬到 public/ 下（编译前做一次）。
  *
  * <p>为什么要搬：模型权重在 dist/client/web/asr/models/（平台构建时切片写进去的，
  * 共 20 片 79 MB），源码里的 public/asr/ 只有 wasm 和 tokens.txt。
  * 而代码找模型用的是相对路径 './asr/models/.../chunks.json'，
  * 构建时 public/ 的内容会拷到产物根目录 —— 模型必须搬到 public/asr/ 才找得到。
  */
  function relocateModels(){
  // 什么都不做。
  //
  // 这里原本把 dist/client/web/asr/ 下的模型拷一份到 public/，
  // 理由是「构建时 public 会拷到产物根，模型必须在那里才找得到」。
  // 两个地方都错了：
  //
  // ① 运行时代码的默认 base 是 './asr/'，找的是 {页面根}/asr/models/...，
  //    不是 {页面根}/models/...，拷到 public/ 根反而对不上；
  // ② 项目里的模型本来就在 public/asr/ 或 dist/client/web/asr/ 下，
  //    LocalRunner 的请求回退能直接命中，不需要复制。
  //
  // 复制还带来一个副作用：编译产物里多出一整套 79 MB 的副本。
 }
 relocateModels();
 const doc=new DOMParser().parseFromString(text['index.html'],'text/html');
 let count=0;
 for(const script of [...doc.querySelectorAll('script')]){
  const src=script.getAttribute('src'),mod=script.type==='module';if(!src&&!mod)continue;
  if(src&&/^(https?:|\/\/|data:)/.test(src)){warnings.add('外部资源需手动开启联网');continue;}
  if(!mod&&src&&!/\.(?:ts|tsx|jsx)$/.test(src))continue;
  const key='__neo_run_'+count++,opts={bundle:true,write:false,format:mod?'esm':'iife',platform:'browser',target:'chrome110',jsx:'automatic',outfile:'/'+key+'.js',plugins:[plugin],define:{'process.env.NODE_ENV':'"production"','import.meta.env':JSON.stringify({MODE:'production',PROD:true,DEV:false,BASE_URL:'/'}),'import.meta.glob':'__neoGlob'},logLevel:'silent'};
  if(src)opts.entryPoints=['/'+local(src)];else opts.stdin={contents:script.textContent,resolveDir:'/',sourcefile:'inline.tsx',loader:'tsx'};
  const result=await esbuild.build(opts);
  for(const f of result.outputFiles){output[f.path.slice(1)]=enc(f.text);if(f.path.endsWith('.css')){const link=doc.createElement('link');link.rel='stylesheet';link.href=f.path;doc.head.appendChild(link);}}
  script.removeAttribute('integrity');script.textContent='';script.src='/'+key+'.js';
 }
 for(const link of [...doc.querySelectorAll('link[rel=stylesheet]')]){const href=link.getAttribute('href');if(href.startsWith('/__neo_run_'))continue;if(/^(https?:|\/\/)/.test(href)){warnings.add('外部样式需手动开启联网');continue;}const n=local(href);const dest='__neo_style_'+count+++'.css';output[dest]=enc(await styles(n));link.href='/'+dest;}
 if(text['vite.config.ts']||text['vite.config.js'])warnings.add('未执行 Vite 插件；原生桥接与后端需独立验证');
 doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(n=>n.remove());
 output['index.html']=enc('<!doctype html>\n'+doc.documentElement.outerHTML);
 window.__neoBuild={files:output,note:[count?'JS/TSX 已编译':'静态网页',...warnings].join(' · '),libraries:[...used],patches:patchNotes};
})().catch(e=>{window.__neoBuild={error:e.errors?e.errors.map(x=>(x.location?.file||'')+':'+(x.location?.line||'')+' '+x.text).join('\n'):String(e.message||e)}});
