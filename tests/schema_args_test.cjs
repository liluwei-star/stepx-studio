#!/usr/bin/env node
/*
 * schema 声明的参数名，必须和实现里实际读取的参数名对得上。
 *
 * <p>为什么盯这一条：原生 function calling 里，模型完全靠 schema 知道
 * 该传什么参数名。如果 schema 写 "path"、实现读 "filePath"，
 * 模型传的是对的、实现拿到的却是默认值 —— 不报错，只是默默不生效。
 *
 * <p>这种 bug 最阴险：不崩溃、不报错，用户看到「AI 说改了但没改」，
 * 而且极难定位 —— 因为协议层看起来完全正常。
 *
 * <p>解析方式：先把每个 new Tool(...) 那一段切出来（按括号配平），
 * 再从 obj(...) 里按「"名字", str(/num(/bool(/req(」的顺序取参数名。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ts = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/ToolSchema.java'), 'utf8');
const ld = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/LocalDevTools.java'), 'utf8');
const de = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/DevAgent.java'), 'utf8');
/* 工具实现可能分散在多个类里，漏扫一个就会把「实现缺」误报成 bug */
const am = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/ArtManager.java'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

/* 从某个位置开始做括号配平，返回配平结束的下标 */
function balanced(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/* 抽出每个工具的名字和它 obj(...) 里声明的参数名 */
function parseSchemas() {
  const out = {};
  let idx = 0;
  while (true) {
    const at = ts.indexOf('new Tool("', idx);
    if (at < 0) break;
    const nameStart = at + 'new Tool("'.length;
    const nameEnd = ts.indexOf('"', nameStart);
    const name = ts.slice(nameStart, nameEnd);
    const callStart = ts.indexOf('(', at);
    const callEnd = balanced(ts, callStart);
    if (callEnd < 0) break;
    const body = ts.slice(callStart, callEnd + 1);
    /*
     * 找顶层 obj(...) 的位置。
     *
     * <p>不能用 lastIndexOf('obj(') —— 「jobj(」里也含「obj(」，
     * 取最后一个会命中嵌套的那个，参数名就全错了。
     * 用 \bobj\( 加边界：jobj( 里的 obj 前面是 j（单词字符），不匹配。
     */
    const objAt = body.search(/\bobj\(/);
    if (objAt >= 0) {
      const objStart = objAt + 'obj('.length - 1;
      const objEnd = balanced(body, objStart);
      const objSrc = body.slice(objStart, objEnd + 1);
      /* 参数名：形如 "名字", 后面跟着 str( / num( / bool( / req( */
      const props = [];
      /* 参数类型可能是 str/num/bool，也可能是 jobj/jarr（对象/数组）；
         req(...) 只是「必填」标记，可能套在这两层外面。
         所以这里允许任意几层 req 包裹，再匹配真正的类型名。 */
      const re = /"(\w+)"\s*,\s*(?:req\(\s*)*(?:str|num|bool|jobj|jarr)\(/g;
      let m;
      while ((m = re.exec(objSrc)) !== null) props.push(m[1]);
      out[name] = props;
    } else {
      out[name] = [];
    }
    idx = callEnd + 1;
  }
  return out;
}

const schemas = parseSchemas();
const toolCount = Object.keys(schemas).length;

console.log('\n【schema 能解析出工具】');
const allNames = [...ts.matchAll(/new Tool\("(\w+)"/g)].map(m => m[1]);
const missed = allNames.filter(n => !schemas[n]);
if (missed.length) console.log('  未解析到的工具: ' + missed.join(', '));
ok(toolCount === allNames.length, '解析出全部 ' + toolCount + '/' + allNames.length + ' 个工具的 schema');

/* 实现里实际读取的参数名全集 */
const implArgs = new Set();
const argRe = /(?:optString|getString|optInt|optBoolean|getBoolean|optLong|getLong|optJSONArray|getJSONArray|optJSONObject|getJSONObject)\(\s*"(\w+)"/g;
let m2;
while ((m2 = argRe.exec(ld)) !== null) implArgs.add(m2[1]);
while ((m2 = argRe.exec(de)) !== null) implArgs.add(m2[1]);
while ((m2 = argRe.exec(am)) !== null) implArgs.add(m2[1]);

/* 关键工具：schema 里必须有的参数，实现必须认得 */
const MUST = {
  read_file: ['path', 'startLine', 'lineCount'],
  list_files: ['prefix', 'depth'],
  write_files: ['files'],
  patch_file: ['path', 'startLine', 'endLine'],
  search_code: ['query'],
  replace_text: ['path', 'oldText', 'newText'],
  multi_patch: ['patches'],
  write_plan: ['steps'],
  update_memory: ['content'],
  remember: ['text'],
  read_skill: ['name'],
  write_skill: ['name'],
  generate_image: ['prompt'],
  search_connectors: ['query'],
  run_script: ['code'],
  web_fetch: ['url'],
};

console.log('\n【关键工具的参数：schema 声明了，实现也得认得】');
for (const [tool, params] of Object.entries(MUST)) {
  const decl = schemas[tool];
  if (!decl) { ok(false, tool + ' 在 schema 里找得到'); continue; }
  for (const p of params) {
    const inSchema = decl.includes(p);
    const inImpl = implArgs.has(p);
    ok(inSchema && inImpl,
      tool + '.' + p + (inSchema ? '' : '（schema 缺）') + (inImpl ? '' : '（实现缺）'));
  }
}

/* 反向：schema 声明的参数，实现里完全没读过 —— 可能是拼写漂移 */
console.log('\n【反向检查：schema 里的参数名，实现侧都认得】');
const drift = [];
for (const [tool, props] of Object.entries(schemas)) {
  for (const p of props) {
    if (!implArgs.has(p)) drift.push(tool + '.' + p);
  }
}
if (drift.length === 0) {
  ok(true, '没有拼写漂移的参数');
} else {
  ok(false, 'schema 声明了但实现没读：' + drift.join('、'));
}

console.log('\n' + (fail ? `有失败项（${pass} / ${pass + fail}）` : `全部通过（${pass} / ${pass + fail}）`));
process.exit(fail ? 1 : 0);
