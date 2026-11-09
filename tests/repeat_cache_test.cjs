#!/usr/bin/env node
/*
 * 重复调用识别表不许存结果全文。
 *
 * <p>为什么盯这一条：那张表以前存的是工具结果的完整 JSON。
 * read_file 一个结果能到几百 KB，条数上限 200 —— 上限管住了条数，
 * 管不住每条多大，200 条就是几十 MB，手机上直接 OOM。
 * 这正是当初花大力气治过的毛病，不能改回去。
 *
 * <p>现在表里只放「长度 + 哈希」这样的指纹：判重语义完全一样，
 * 内存从几十 MB 降到几十 KB。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/cn/com/scsxrkj/LocalDevTools.java');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

/* 取出 callOnce 方法体 */
function methodBody(text, signature) {
  const i = text.indexOf(signature);
  if (i < 0) return '';
  const j = text.indexOf('{', i);
  if (j < 0) return '';
  let depth = 0;
  for (let k = j; k < text.length; k++) {
    const c = text[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(j, k + 1); }
  }
  return '';
}

const callOnce = methodBody(src, 'JSONObject callOnce(');

console.log('\n【重复识别表只存指纹，不存全文】');
ok(callOnce.length > 0, 'callOnce 方法找得到');
/* 关键：结果字符串必须先过指纹函数再进表 */
ok(/fingerprint\(\s*r==null\?"":r\.toString\(\)\s*\)/.test(callOnce),
  '工具结果先算指纹再拿去比较');
ok(!/String\s+now\s*=\s*r==null\?"":r\.toString\(\)/.test(callOnce),
  '结果全文不再直接进 lastResult');
ok(/lastResult\.put\(\s*sig\s*,\s*now\s*\)/.test(callOnce),
  '进表的是算过指纹的值');
ok(/String\s+sig\s*=\s*name\+"\|"\s*\+\s*fingerprint\(/.test(callOnce),
  '签名也压成指纹，参数里可能带着整份文件清单');

console.log('\n【指纹函数本身】');
ok(/static\s+String\s+fingerprint\(String\s+s\)/.test(src),
  'fingerprint 方法存在');
ok(/s\.length\(\)\s*\+\s*"-"\s*\+\s*Integer\.toHexString\(s\.hashCode\(\)\)/.test(src),
  '指纹由长度加哈希组成，固定长度');

console.log('\n【容量上限还在】');
ok(/REPEAT_CACHE_CAP\s*=\s*\d+/.test(src),
  '条数上限仍然存在');
ok(/removeEldestEntry/.test(src),
  '超出上限会淘汰最老的一条');

console.log('\n【自测断言存在】');
const selfTest = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/SelfTest.java'), 'utf8');
ok(/repeatCacheChars\(\)\s*<\s*4096/.test(selfTest),
  '自测断言这张表不会长大到危险尺寸');

console.log('\n' + (fail ? `有失败项（${pass} / ${pass + fail}）` : `全部通过（${pass} / ${pass + fail}）`));
process.exit(fail ? 1 : 0);
