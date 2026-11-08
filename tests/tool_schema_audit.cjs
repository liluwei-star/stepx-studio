/*
 * 原生 function calling 的工具一致性审计。
 *
 * <p><b>要抓的问题：</b>「原生改造」把工具从「提示词里的纯文本」搬到了
 * 「机器可读的 JSON Schema」。但这是**两份**清单，改一处忘另一处，
 * 就会出现功能的静默回退：
 *
 * <ul>
 *   <li>提示词里有、schema 里没有 → 模型在原生路径下**调不到这个工具**，
 *       功能静默消失（用户只会觉得「AI 好像不会画图了」）</li>
 *   <li>schema 里有、提示词里没有 → 模型知道有这个工具，但不知道何时用；
 *       工具本身也可能没有实现</li>
 *   <li>schema 里有、实现里没有 → 模型调了必然报错</li>
 *   <li>实现里有、schema 里没有 → 同第一种，功能回退</li>
 * </ul>
 *
 * 运行：node tests/tool_schema_audit.cjs
 */
const fs=require('fs');
const path=require('path');

const root=process.cwd();
function readSrc(rel){
  try{return fs.readFileSync(path.join(root,rel),'utf8');}
  catch(e){return fs.readFileSync(path.resolve(__dirname,'..',rel),'utf8');}
}

const schema=readSrc('src/cn/com/scsxrkj/ToolSchema.java');
const impl=readSrc('src/cn/com/scsxrkj/LocalDevTools.java');
const prompt=readSrc('src/cn/com/scsxrkj/LocalDevTools.java');

let passed=0;const failures=[];
function check(cond,name,extra){
  if(cond){passed++;console.log('  PASS  '+name);}
  else{failures.push(name+(extra?' — '+extra:''));console.log('  FAIL  '+name+(extra?' — '+extra:''));}
}

/* ── 1. 解析 schema 里的工具 ──────────────────────────── */
const schemaTools=[...schema.matchAll(/new Tool\("([a-z_]+)"/g)].map(m=>m[1]);
console.log('\n[1] schema 工具清单（共 '+schemaTools.length+' 个）');
const dup=schemaTools.filter((n,i)=>schemaTools.indexOf(n)!==i);
check(dup.length===0,'schema 里没有重名工具',dup.join(','));

/* ── 2. 解析实现里的工具 ──────────────────────────────── */
/* case "xxx": 形式 */
const caseTools=[...impl.matchAll(/case "([a-z_]+)"/g)].map(m=>m[1]);
/* name.equals("xxx") 形式 */
const eqTools=[...impl.matchAll(/name\.equals\("([a-z_]+)"\)/g)].map(m=>m[1]);
const implTools=[...new Set([...caseTools,...eqTools])];
console.log('[2] 实现工具清单（共 '+implTools.length+' 个）');

/* ── 3. schema ↔ 实现 双向比对 ────────────────────────── */
console.log('\n[3] schema 与实现的一致性');
const schemaNoImpl=schemaTools.filter(n=>!implTools.includes(n));
const implNoSchema=implTools.filter(n=>!schemaTools.includes(n));
check(schemaNoImpl.length===0,'schema 里的每个工具都有实现',schemaNoImpl.join(', '));
check(implNoSchema.length===0,'实现里的每个工具都在 schema 里（原生路径调得到）',implNoSchema.join(', '));

/* ── 4. 提示词里提到的工具名 ──────────────────────────── */
/*
 * 提示词里的工具名形式：「name(args)：说明」或「name()：说明」。
 * 只在「工具清单」和「怎么跟用户说话」之外的部分找，避免把普通词误判成工具。
 */
const promptSection=prompt.slice(prompt.indexOf('【工具清单】'));
const promptTools=[...new Set([...promptSection.matchAll(/([a-z_]{3,})\(/g)].map(m=>m[1]))]
  .filter(n=>!['JSON','String','Object','Array'].includes(n));
console.log('[4] 提示词工具清单（共 '+promptTools.length+' 个）');

/* 提示词里的「怎么跟用户说话」等非工具章节会混进普通词，只取明显像工具的 */
const promptOnly=promptTools.filter(n=>!schemaTools.includes(n)&&!implTools.includes(n));
/*
 * 提示词里有些是参数说明里的普通词（比如 run_script 里提到 console.log）。
 * 这些不算漏 —— 真正的漏是「工具名在提示词里被当成能力介绍，但 schema 没有」。
 * 这里只报告，不直接判失败，因为提示词文本很难精确切分。
 */
if(promptOnly.length){
  console.log('  说明：提示词里出现但不在工具清单的词（多为说明性文字，非漏项）：');
  console.log('    '+promptOnly.join(', '));
}

/* ── 5. 关键工具必须齐 ───────────────────────────────── */
console.log('\n[5] 关键能力不能缺');
const mustHave=[
  ['read_file','读文件'],
  ['list_files','列目录'],
  ['search_code','搜代码'],
  ['write_files','写文件'],
  ['patch_file','按行改'],
  ['multi_patch','多文件改'],
  ['diff_mine','自查改动'],
  ['check_project','编译检查'],
  ['build_apk','打包'],
  ['run_tests','跑测试'],
  ['generate_image','绘图'],
  ['web_search','联网搜索'],
  ['web_fetch','抓网页'],
  ['github_push','上传 GitHub'],
  ['remember','记忆'],
  ['read_memory','读记忆'],
  ['list_skills','技能列表'],
  ['read_skill','读技能'],
  ['write_skill','写技能'],
  ['write_plan','写计划'],
  ['read_plan','读计划'],
];
for(const [n,desc] of mustHave){
  check(schemaTools.includes(n),'原生 schema 里有 '+n+'（'+desc+'）');
  check(implTools.includes(n),'实现里有 '+n+'（'+desc+'）');
}

/* ── 6. 参数名必须和实现对得上 ────────────────────────── */
console.log('\n[6] generate_image 的参数与实现一致');
const gi=schema.indexOf('new Tool("generate_image"');
check(gi>=0,'schema 里有 generate_image');
if(gi>=0){
  const block=schema.slice(gi,gi+600);
  for(const arg of ['prompt','path','referenceFile','placeholder']){
    check(block.includes('"'+arg+'"'),'generate_image schema 里有参数 '+arg);
  }
}
/* 实现侧：ArtManager.tool 读的参数名 */
const art=readSrc('src/cn/com/scsxrkj/ArtManager.java');
for(const arg of ['prompt','path','referenceFile']){
  check(art.includes('"'+arg+'"')||art.includes('optString("'+arg+'"')||art.includes('getString("'+arg+'"'),
    '实现侧认参数 '+arg);
}

/* ── 7. 绘图工具有次数限制，schema 要说明 ─────────────── */
console.log('\n[7] 限制写进描述');
const giBlock=gi>=0?schema.slice(gi,gi+600):'';
check(giBlock.includes('3 张')||giBlock.includes('3张'),'generate_image 的描述里说明了每轮上限');

/* ── 汇总 ─────────────────────────────────────────────── */
console.log('\n────────────────────────────────');
console.log('通过 '+passed+' 项，失败 '+failures.length+' 项');
if(failures.length){
  failures.forEach(f=>console.log('  ✗ '+f));
  process.exit(1);
}
console.log('全部通过');
