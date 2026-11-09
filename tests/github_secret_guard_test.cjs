#!/usr/bin/env node
/*
 * 上传到 GitHub 的项目里不能夹带密钥。
 *
 * <p>为什么盯这一条：「上传项目到 GitHub」这个功能最危险的一个口子
 * 就是密钥跟着代码一起进仓库。项目里往往躺着 .env、keystore、
 * 签名配置，还有写着 API Key 的 config.json ——
 * 它们都是纯文本，体积也不大，所以「只传文本文件」和「单文件大小上限」
 * 这两道既有的过滤全都拦不住。
 *
 * <p>后果不是「代码泄露」，是「密钥泄露」：哪怕仓库默认私有，
 * 日后有人转公开、或者协作者有读权限，密钥就等于公开了。
 * GitHub 的密钥扫描一旦命中还会主动通知。
 *
 * <p>这里做的是真的行为验证：把 Java 判定逻辑抽出来编译运行，
 * 逐个文件喂进去看拦没拦住。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const gh = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/GitHubTool.java'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

/* ── 把 secretReason 抽出来编译运行 ─────────────────────────── */
function extractMethod(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error('找不到方法: ' + signature);
  let i = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  return src.slice(at, end + 1);
}

let javaSrc;
try {
  const m = extractMethod(gh, 'static String secretReason(String path,String content)');
  javaSrc = `
public class Probe{
 ${m}
 public static void main(String[] a){
  for(int i=0;i+1<a.length;i+=2){
   String r=secretReason(a[i],a[i+1]);
   System.out.println((r==null?"ALLOW":"BLOCK")+"\\t"+a[i]+"\\t"+(r==null?"":r));
  }
 }
}`;
} catch (e) {
  console.log('  ✗ 抽不出 Java 判定逻辑：' + e.message);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-'));
fs.writeFileSync(path.join(tmp, 'Probe.java'), javaSrc, 'utf8');

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
const CASES = [
  ['.env', 'API_KEY=abc'],
  ['.env.local', 'x=1'],
  ['src/.env', 'x=1'],
  ['.npmrc', '_authToken=abc'],
  ['keystore.properties', 'storePassword=abc'],
  ['local.properties', 'sdk.dir=/x'],
  ['signing.properties', 'storePassword=abc'],
  ['server.pem', '-----BEGIN CERTIFICATE-----'],
  ['private.key', 'xx'],
  ['release.p12', 'xx'],
  ['sign.jks', 'xx'],
  ['id_rsa', 'xx'],
  ['config.json', '{"api_key":"sk-abcdef1234567890abcdef"}'],
  ['src/config.json', '{"apiKey":"sk-abcdef1234567890abcdef"}'],
  ['app.js', 'const access_token = "ghp_abcdefghijklmnop1234";'],
  ['settings.yaml', 'client_secret: "abcdefghijklmnop1234"'],
  ['script.py', 'password = "hunter2000"'],
  ['aws.yml', 'aws_secret_access_key: "abcdefghijklmnop1234"'],
  ['src/main.js', 'function secretKey() { return 1; }'],
  ['index.html', '<p>hello</p>'],
  ['src/app.ts', 'export const apiUrl = "https://example.com";'],
  ['README.md', '# 项目说明\n\n这是一个示例项目。'],
];
let output = '';
try {
  execFileSync(path.join(JAVA_HOME, 'bin', 'javac'), [path.join(tmp, 'Probe.java')], { stdio: 'pipe' });
  const flat = [];
  for (const [f, c] of CASES) { flat.push(f, c); }
  output = execFileSync(path.join(JAVA_HOME, 'bin', 'java'), ['-cp', tmp, 'Probe', ...flat],
    { encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  console.log('  ✗ 编译/运行 Java 探针失败：' + (e.stderr || e.message).toString().slice(0, 600));
  process.exit(1);
}

const verdict = {};
for (const line of output.trim().split(/\r?\n/)) {
  const parts = line.split('\t');
  if (parts.length >= 2) verdict[parts[1]] = parts[0];
}

console.log('\n【含密钥的文件必须被拦下】');
const MUST_BLOCK = [
  '.env', '.env.local', 'src/.env', '.npmrc', 'keystore.properties',
  'local.properties', 'signing.properties', 'server.pem', 'private.key',
  'release.p12', 'sign.jks', 'id_rsa', 'config.json', 'src/config.json',
  'app.js', 'settings.yaml', 'script.py', 'aws.yml',
];
for (const f of MUST_BLOCK) {
  ok(verdict[f] === 'BLOCK', f + ' 被拦下（实际：' + (verdict[f] || '无') + '）');
}

console.log('\n【普通代码不能被误伤】');
const MUST_ALLOW = [
  'src/main.js', 'index.html', 'src/app.ts', 'README.md',
];
for (const f of MUST_ALLOW) {
  ok(verdict[f] === 'ALLOW', f + ' 放行（实际：' + (verdict[f] || '无') + '）');
}

console.log('\n【上传时真的调用了这个判定】');
ok(/secretReason\(path,content\)/.test(gh), 'push 时逐文件调用 secretReason');
ok(/skipped\.put\(new JSONObject\(\)\.put\("path",path\)\.put\("reason",secretReason\)\)/.test(gh),
  '被拦的文件进了 skipped');
ok(/put\("skipped",skipped\)/.test(gh), 'skipped 出现在返回结果里');
/* 三个返回分支都要带 skipped —— 少一个，用户就看不到「哪些没上传」 */
const skippedCount = (gh.match(/put\("skipped",skipped\)/g) || []).length;
ok(skippedCount >= 3, '三个返回分支都带上了 skipped（实际 ' + skippedCount + ' 处）');

console.log('\n' + (fail ? `有失败项（${pass} / ${pass + fail}）` : `全部通过（${pass} / ${pass + fail}）`));
process.exit(fail ? 1 : 0);
