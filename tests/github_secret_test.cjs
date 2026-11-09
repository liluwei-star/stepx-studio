#!/usr/bin/env node
/**
 * 回归测试：往 GitHub 传代码时的密钥过滤。
 *
 * <p>这个功能本身就是把项目推上 GitHub。漏一个密钥，等于把钥匙挂在门上 ——
 * 而且是挂在别人能搜到的地方。所以两条线都必须硬：
 *
 * <p><b>第一条线：认文件名。</b>
 * 原来只精确匹配 .env / .env.local / .env.production / .env.development 四个名字。
 * 但实际项目里满地都是 .env.bak、.env.old、.env.test、.env.staging ——
 * 用户手动备份一份就把密钥备份出来了，这几个一个都拦不住。
 *
 * <p><b>第二条线：认密钥形状。</b>
 * 原来所有的模式都是「键名 + 赋值」，比如 api_key: "xxx"。
 * 但密钥被硬编码进源码时变量名往往毫无提示：
 *
 * <pre>
 * const gh = "ghp_xxxxxxxx";            // 变量名叫 gh
 * const k = "sk-proj-xxxx";             // 变量名叫 k
 * static final String AWS = "AKIA...";  // 变量名叫 AWS
 * </pre>
 *
 * <p>三种写法一个都匹配不上。好在各家密钥有固定前缀，认形状比认变量名可靠。
 *
 * <p><b>同时必须防误伤：</b>宁可多拦一个配置文件，但不能把正常代码全拦下来 ——
 * 那样用户的仓库会莫名其妙缺文件。所以本测试同时列出必须放行的样本。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(path.resolve(__dirname), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

function grabMethod(java, signature) {
  const start = java.indexOf(signature);
  if (start < 0) throw new Error('找不到方法：' + signature);
  let i = java.indexOf('{', start), depth = 0;
  for (; i < java.length; i++) {
    if (java[i] === '{') depth++;
    else if (java[i] === '}') { depth--; if (depth === 0) return java.slice(start, i + 1); }
  }
  throw new Error('方法没闭合：' + signature);
}

const gh = read('src/cn/com/scsxrkj/GitHubTool.java');
const mSecret = grabMethod(gh, 'static String secretReason(String path,String content){');
// secretReason 现在依赖 placeholderValue 判断占位符，要一起取出来
const mPlaceholder = grabMethod(gh, 'static boolean placeholderValue(String v){');

const HARNESS = `
package cn.com.scsxrkj;

/**
 * 探针：跑真实的 secretReason。
 * 这个方法只做字符串判断，不碰网络和 Activity，能独立跑。
 */
public class SecretProbe {

    /** 每个样本用 | 分隔路径和内容，避免双引号转义地狱 */
    static String reason(String path, String content) {
        String r = secretReason(path, content);
        return r == null ? "ALLOW" : "BLOCK";
    }

${mPlaceholder}

${mSecret}

    public static void main(String[] a) throws Exception {
        StringBuilder out = new StringBuilder();

        // ── 必须拦住：密钥文件名 ──────────────────────────────
        out.append("K_ENV=").append(reason(".env", "")).append('\\n');
        out.append("K_ENV_LOCAL=").append(reason(".env.local", "")).append('\\n');
        out.append("K_ENV_BAK=").append(reason(".env.bak", "")).append('\\n');
        out.append("K_ENV_OLD=").append(reason(".env.old", "")).append('\\n');
        out.append("K_ENV_TEST=").append(reason("config/.env.test", "")).append('\\n');
        out.append("K_ENV_STAGING=").append(reason(".env.staging", "")).append('\\n');
        out.append("K_ENV_DOT_END=").append(reason("prod.env", "")).append('\\n');
        out.append("K_ENVRC=").append(reason(".envrc", "")).append('\\n');
        out.append("K_GITCRED=").append(reason(".git-credentials", "")).append('\\n');
        out.append("K_KEYSTORE=").append(reason("release.keystore", "")).append('\\n');
        out.append("K_JKS=").append(reason("debug.jks", "")).append('\\n');
        out.append("K_PEM=").append(reason("cert.pem", "")).append('\\n');
        out.append("K_IDRSA=").append(reason("id_rsa", "")).append('\\n');
        out.append("K_SSHDIR=").append(reason(".ssh/config", "")).append('\\n');
        out.append("K_NPMRC=").append(reason(".npmrc", "")).append('\\n');

        // ── 必须拦住：键名 + 赋值（原来的能力，不能退化）───────
        out.append("K_ASSIGN_JSON=").append(reason("config.json", "{\\"api_key\\": \\"abcdefghijklmnop\\"}")).append('\\n');
        out.append("K_ASSIGN_ENV=").append(reason("app.config", "API_KEY=abcdefghijklmnop")).append('\\n');
        out.append("K_PASSWORD=").append(reason("db.yml", "password: \\"hunter2hunter2\\"")).append('\\n');
        out.append("K_PRIVATE=").append(reason("a.txt", "-----BEGIN RSA PRIVATE KEY-----\\nMIIE...")).append('\\n');

        // ── 必须拦住：已知密钥形状（本轮新增）─────────────────
        out.append("S_OPENAI=").append(reason("src/a.ts", "const k = \\"sk-proj-abc123def456ghi789jkl012\\";")).append('\\n');
        out.append("S_ANTHROPIC=").append(reason("src/b.ts", "const k = \\"sk-ant-api03-abcdefghijklmnopqrst\\";")).append('\\n');
        out.append("S_GH_PAT=").append(reason("src/c.js", "const gh = \\"ghp_abcdefghijklmnopqrstuvwxyz0123\\";")).append('\\n');
        out.append("S_GH_FINE=").append(reason("src/d.js", "const t = \\"github_pat_11ABCDEFG0abcdefghijklmnop\\";")).append('\\n');
        out.append("S_AWS=").append(reason("src/e.js", "const AWS = \\"AKIAIOSFODNN7EXAMPLE\\";")).append('\\n');
        out.append("S_GOOGLE=").append(reason("src/f.js", "const g = \\"AIzaSyA1234567890abcdefghijklmnopqrstu\\";")).append('\\n');
        out.append("S_SLACK=").append(reason("src/g.js", "const s = \\"xoxb-1234567890-abcdefghij\\";")).append('\\n');
        out.append("S_GITLAB=").append(reason("src/h.rb", "token = \\"glpat-abcdefghijklmnop\\"")).append('\\n');
        out.append("S_HF=").append(reason("src/i.py", "t = \\"hf_abcdefghijklmnopqrstuvwxyz012345\\"")).append('\\n');

        // ── 必须放行：正常代码不能误伤 ────────────────────────
        out.append("A_HTML=").append(reason("index.html", "<h1>Hello</h1><script src=\\"a.js\\"></script>")).append('\\n');
        out.append("A_CSS=").append(reason("style.css", "body{margin:0;color:#333}")).append('\\n');
        out.append("A_JS=").append(reason("app.js", "function add(a,b){return a+b}\\nconsole.log(add(1,2));")).append('\\n');
        out.append("A_WORD_TOKEN=").append(reason("doc.md", "用 token 表示词元，tokenize 是分词。")).append('\\n');
        out.append("A_WORD_SECRET=").append(reason("readme.md", "Never commit secrets to the repo.")).append('\\n');
        out.append("A_SHORT_KEY=").append(reason("cfg.json", "{\\"api_key\\": \\"short\\"}")).append('\\n');
        out.append("A_PLACEHOLDER=").append(reason("cfg.json", "{\\"api_key\\": \\"YOUR_KEY_HERE\\"}")).append('\\n');
        out.append("A_CODE_SK=").append(reason("a.js", "const task = \\"sk-learn\\"; // 普通字符串")).append('\\n');
        out.append("A_README_ENV=").append(reason("README.md", "复制 .env.example 为 .env 再填值")).append('\\n');
        out.append("A_TS_TYPE=").append(reason("a.ts", "type Token = string; const t: Token = getToken();")).append('\\n');
        out.append("A_JSON_NORMAL=").append(reason("package.json", "{\\"name\\":\\"app\\",\\"version\\":\\"1.0.0\\"}")).append('\\n');

        System.out.print(out);
    }
}
`;

const tmpDir = path.join(__dirname, '.tmp-secret');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'SecretProbe.java'), HARNESS);

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
try {
  execFileSync(path.join(JAVA_HOME, 'bin', 'javac.exe'),
    ['-encoding', 'UTF-8', '-nowarn', '-d', path.join(tmpDir, 'out'),
      path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'SecretProbe.java')], { stdio: 'pipe' });
} catch (e) {
  console.error('编译失败：\n' + (e.stdout || '').toString() + (e.stderr || '').toString());
  process.exit(1);
}

const raw = execFileSync(path.join(JAVA_HOME, 'bin', 'java.exe'),
  ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', path.join(tmpDir, 'out'),
    'cn.com.scsxrkj.SecretProbe'], { encoding: 'utf8' });
const v = {};
for (const line of raw.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) v[m[1]] = m[2].trim();
}

console.log('\n── 密钥文件名：.env 全族都要拦住 ──────────────');
for (const [k, label] of [
  ['K_ENV', '.env'], ['K_ENV_LOCAL', '.env.local'], ['K_ENV_BAK', '.env.bak'],
  ['K_ENV_OLD', '.env.old'], ['K_ENV_TEST', 'config/.env.test'],
  ['K_ENV_STAGING', '.env.staging'], ['K_ENV_DOT_END', 'prod.env'], ['K_ENVRC', '.envrc'],
]) ok(label + ' 被拦下', v[k] === 'BLOCK', v[k]);
ok('.git-credentials 被拦下', v.K_GITCRED === 'BLOCK', v.K_GITCRED);
ok('release.keystore 被拦下', v.K_KEYSTORE === 'BLOCK', v.K_KEYSTORE);
ok('debug.jks 被拦下', v.K_JKS === 'BLOCK', v.K_JKS);
ok('cert.pem 被拦下', v.K_PEM === 'BLOCK', v.K_PEM);
ok('id_rsa 被拦下', v.K_IDRSA === 'BLOCK', v.K_IDRSA);
ok('.ssh/ 目录被拦下', v.K_SSHDIR === 'BLOCK', v.K_SSHDIR);
ok('.npmrc 被拦下', v.K_NPMRC === 'BLOCK', v.K_NPMRC);

console.log('\n── 键名 + 赋值：原有能力不能退化 ──────────────');
ok('JSON 里的 api_key 被拦下', v.K_ASSIGN_JSON === 'BLOCK', v.K_ASSIGN_JSON);
ok('.env 风格的 API_KEY= 被拦下', v.K_ASSIGN_ENV === 'BLOCK', v.K_ASSIGN_ENV);
ok('YAML 里的 password 被拦下', v.K_PASSWORD === 'BLOCK', v.K_PASSWORD);
ok('私钥块被拦下', v.K_PRIVATE === 'BLOCK', v.K_PRIVATE);

console.log('\n── 已知密钥形状：变量名没有提示也要拦住 ────────');
ok('OpenAI sk-proj- 被拦下', v.S_OPENAI === 'BLOCK', v.S_OPENAI);
ok('Anthropic sk-ant- 被拦下', v.S_ANTHROPIC === 'BLOCK', v.S_ANTHROPIC);
ok('GitHub ghp_ 被拦下', v.S_GH_PAT === 'BLOCK', v.S_GH_PAT);
ok('GitHub github_pat_ 被拦下', v.S_GH_FINE === 'BLOCK', v.S_GH_FINE);
ok('AWS AKIA 被拦下', v.S_AWS === 'BLOCK', v.S_AWS);
ok('Google AIza 被拦下', v.S_GOOGLE === 'BLOCK', v.S_GOOGLE);
ok('Slack xoxb- 被拦下', v.S_SLACK === 'BLOCK', v.S_SLACK);
ok('GitLab glpat- 被拦下', v.S_GITLAB === 'BLOCK', v.S_GITLAB);
ok('HuggingFace hf_ 被拦下', v.S_HF === 'BLOCK', v.S_HF);

console.log('\n── 正常代码必须放行，不能误伤 ──────────────────');
ok('HTML 放行', v.A_HTML === 'ALLOW', v.A_HTML);
ok('CSS 放行', v.A_CSS === 'ALLOW', v.A_CSS);
ok('普通 JS 放行', v.A_JS === 'ALLOW', v.A_JS);
ok('正文里出现 token 这个词放行', v.A_WORD_TOKEN === 'ALLOW', v.A_WORD_TOKEN);
ok('正文里出现 secrets 这个词放行', v.A_WORD_SECRET === 'ALLOW', v.A_WORD_SECRET);
ok('太短的值不算密钥', v.A_SHORT_KEY === 'ALLOW', v.A_SHORT_KEY);
ok('占位符 YOUR_KEY_HERE 放行', v.A_PLACEHOLDER === 'ALLOW', v.A_PLACEHOLDER);
ok('普通 sk- 开头的短字符串放行', v.A_CODE_SK === 'ALLOW', v.A_CODE_SK);
ok('README 里提到 .env.example 放行', v.A_README_ENV === 'ALLOW', v.A_README_ENV);
ok('TypeScript 类型声明放行', v.A_TS_TYPE === 'ALLOW', v.A_TS_TYPE);
ok('package.json 放行', v.A_JSON_NORMAL === 'ALLOW', v.A_JSON_NORMAL);

console.log('\n----------------------------------------------------');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED ' + fail) + ' (github_secret_test)  ' + pass + ' 项');
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
