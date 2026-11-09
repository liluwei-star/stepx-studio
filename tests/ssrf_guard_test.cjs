#!/usr/bin/env node
/*
 * web_fetch 不能被绕过去访问本机和内网。
 *
 * <p>为什么盯这一条：模型可以自由构造 URL。如果 fetch 能读内网地址，
 * 那么一个被诱导的模型（网页里藏一句「顺便读一下这个地址」）就能
 * 把内网服务、云厂商实例元数据接口（169.254.169.254，
 * 上面通常挂着临时凭据）的内容读出来塞进对话里。
 *
 * <p>而且这些绕过写法极其朴素：Java 的 DNS 解析接受
 *   2130706433  -> 127.0.0.1   （十进制整数）
 *   127.1       -> 127.0.0.1   （短形式）
 * 看着像普通网址，一眼看不出来，但连过去就是本机。
 *
 * <p>另外还有 DNS rebinding：主机名是正常的公网域名，
 * 但它现在解析到的是内网 IP。所以除了看主机名，还得看解析结果。
 *
 * <p><b>这里做的是真的行为验证</b>：把 Java 判定逻辑原样抽出来编译运行，
 * 逐个地址喂进去看拦没拦住。而不是在源码里 grep 字面量 ——
 * 判定写的是数值比较，源码里本来就不该出现「127.0.0.1」这种字符串。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const wt = fs.readFileSync(path.join(ROOT, 'src/cn/com/scsxrkj/WebTools.java'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

/* ── 把 Java 里的判定逻辑抽出来，编成一个能跑的小程序 ────────── */
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
  const isPrivate = extractMethod(wt, 'static boolean isPrivate(String host)');
  const isPrivateAddress = extractMethod(wt, 'static boolean isPrivateAddress(java.net.InetAddress addr)');
  javaSrc = `
import java.net.*;
import java.util.*;
public class Probe{
 ${isPrivateAddress}
 ${isPrivate}
 public static void main(String[] a){
  for(String h:a){
   try{System.out.println((isPrivate(h)?"BLOCK":"ALLOW")+"\\t"+h);}
   catch(Throwable e){System.out.println("ERROR\\t"+h+"\\t"+e);}
  }
 }
}`;
} catch (e) {
  console.log('  ✗ 抽不出 Java 判定逻辑：' + e.message);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssrf-'));
const javaFile = path.join(tmp, 'Probe.java');
fs.writeFileSync(javaFile, javaSrc, 'utf8');

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
let output = '';
try {
  execFileSync(path.join(JAVA_HOME, 'bin', 'javac'), [javaFile], { stdio: 'pipe' });
  const HOSTS = [
    'localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1',
    '169.254.169.254', '2130706433', '127.1', '127.0.1', '0x7f000001',
    '::1', 'fd00::1', 'fe80::1', '10.0.0.1.nip.io', '017700000001',
    '192.0.2.1', '198.51.100.1', '8.8.8.8', 'example.com', '1.1.1.1',
    '172.32.0.1', '100.64.0.1', '0177.0.0.1',
  ];
  output = execFileSync(path.join(JAVA_HOME, 'bin', 'java'), ['-cp', tmp, 'Probe', ...HOSTS],
    { encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  console.log('  ✗ 编译/运行 Java 探针失败：' + (e.stderr || e.message).toString().slice(0, 400));
  process.exit(1);
}

const verdict = {};
for (const line of output.trim().split(/\r?\n/)) {
  const parts = line.split('\t');
  if (parts.length >= 2) verdict[parts[1]] = parts[0];
}

console.log('\n【内网地址必须被拦住】');
const MUST_BLOCK = [
  'localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1',
  '169.254.169.254', '2130706433', '127.1', '127.0.1', '0x7f000001',
  '::1', 'fd00::1', 'fe80::1', '10.0.0.1.nip.io',
  '100.64.0.1',
];
for (const h of MUST_BLOCK) {
  ok(verdict[h] === 'BLOCK', h + ' 被拦住（实际判定：' + (verdict[h] || '无') + '）');
}

console.log('\n【八进制写法：Java 按十进制解析，不是绕过】');
/* 017700000001 在 Java 里直接解析失败 —— 连都连不上，无害；
   0177.0.0.1 被当成十进制 177.0.0.1（公网），也不是绕过。
   这两种写法在 C 系解析器里能绕过，但 Java 不吃这一套。 */
ok(verdict['0177.0.0.1'] === 'ALLOW', '0177.0.0.1 按十进制解析成公网，放行正确');

console.log('\n【公网地址必须放行】');
const MUST_ALLOW = [
  '8.8.8.8', 'example.com', '1.1.1.1', '192.0.2.1', '198.51.100.1',
  /* 172.32 不在私网段 172.16-31 内，是公网地址 —— 必须放行，
     早先把它列进「必须拦」是把公网当私网了 */
  '172.32.0.1',
];
for (const h of MUST_ALLOW) {
  ok(verdict[h] === 'ALLOW', h + ' 放行（实际判定：' + (verdict[h] || '无') + '）');
}

console.log('\n【DNS rebinding：连之前看解析结果】');
ok(/checkResolved/.test(wt), '建连接前会检查域名当前解析到的 IP');
ok(/getAllByName/.test(wt), '检查所有解析结果，不只看第一个');
ok(/UnknownHostException/.test(wt), '解析失败时放行，交给真正的连接去报错');

console.log('\n【重定向每一跳都重新检查】');
const fetchBlock = wt.slice(wt.indexOf('JSONObject fetch(String rawUrl)'), wt.indexOf('JSONObject fetch(String rawUrl)') + 3000);
const redirectIdx = fetchBlock.indexOf('Location');
ok(redirectIdx > 0, '有重定向处理');
ok(/checkUrl\(next\.toString\(\)\)/.test(fetchBlock.slice(redirectIdx)), '每一跳重新校验 URL');
ok(/checkResolved\(url\)/.test(fetchBlock), '每一跳都重新查解析结果');

console.log('\n' + (fail ? `有失败项（${pass} / ${pass + fail}）` : `全部通过（${pass} / ${pass + fail}）`));
process.exit(fail ? 1 : 0);
