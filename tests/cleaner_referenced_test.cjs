#!/usr/bin/env node
/**
 * 回归测试：清洗项目之前，必须先算出「源码还在 import 的文件」，这些一律不删。
 *
 * <p><b>为什么这条是底线：</b>删文件不删 import，组件树当场断掉，
 * 而界面只显示一行「找不到本地文件」，极难定位。这个坑已经踩过五次
 * （pwa/、dev-report.ts、help-guide、capsule/manifest.json），
 * 靠一条条补规则永远补不完 —— 每换一个项目就有新的引用关系。
 *
 * <p>所以清洗器反过来做：先把引用关系算出来，凡是被引用的，一律不删。
 *
 * <p><b>原来的抓法只认两种写法</b>（关键字后面紧跟空白再加引号）：
 *
 * <pre>
 * import './x'
 * from './x'
 * </pre>
 *
 * <p>于是下面两类全漏了：
 *
 * <pre>
 * const mod = await import('./lazy/page');          // 动态 import，关键字后面是括号
 * const manifest = require('./capsule/manifest.json');
 * </pre>
 *
 * <p>动态 import 是代码分割和懒加载的标准写法，JSON 配置用 require 也很常见。
 * 漏判的后果和普通 import 一样：文件被当成平台痕迹删掉，
 * 运行到那一行才炸。
 *
 * <p>本测试从源码取出真实的 collectReferenced / resolveSpec / stripExt /
 * isReferenced 编译运行，喂真实源码片段，看解析出来的引用集合对不对。
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

const pc = read('src/cn/com/scsxrkj/ProjectCleaner.java');

// ── 取真实实现 ────────────────────────────────────────────────
const mCollect = grabMethod(pc, 'static java.util.Set<String> collectReferenced(JSONObject files) {');
const mResolve = grabMethod(pc, 'static String resolveSpec(String from, String spec) {');
const mStrip = grabMethod(pc, 'static String stripExt(String n) {');
const mIsRef = grabMethod(pc, 'static boolean isReferenced(java.util.Set<String> referenced, String n) {');

// IMPORT_SPEC 是整个类共享的正则，要在探针里原样重建
const specMatch = pc.match(/IMPORT_SPEC\s*=\s*\n?\s*java\.util\.regex\.Pattern\.compile\("((?:[^"\\]|\\.)*)"\)/);
if (!specMatch) { console.error('✗ 找不到 IMPORT_SPEC 正则'); process.exit(1); }
const specLiteral = specMatch[1];
if (!/require/.test(specLiteral)) {
  ok('引用扫描认得 require', false, ' IMPORT_SPEC 里没有 require');
}
if (!/\\\\\(/.test(specLiteral) && !/\\\(/.test(specLiteral)) {
  ok('引用扫描认得动态 import 的左括号', false, ' IMPORT_SPEC 里没有可选左括号');
}

const HARNESS = `
package cn.com.scsxrkj;

import org.json.JSONObject;
import java.util.*;

/**
 * 探针：跑真实的 collectReferenced / resolveSpec / stripExt / isReferenced。
 * 这些方法只处理 JSON 和字符串，不碰 Activity。
 */
public class CleanProbe {

    private static final java.util.regex.Pattern IMPORT_SPEC =
            java.util.regex.Pattern.compile("${specLiteral}");

${mStrip}

${mResolve}

${mCollect}

${mIsRef}

    /** 把集合按字典序拼成一行，方便比对 */
    static String dump(Set<String> s) {
        java.util.List<String> l = new java.util.ArrayList<>(s);
        Collections.sort(l);
        return String.join(",", l);
    }

    static void probe(String label, String file, String code) throws Exception {
        JSONObject files = new JSONObject();
        files.put(file, code);
        System.out.println("R_" + label + "=" + dump(collectReferenced(files)));
    }

    public static void main(String[] a) throws Exception {
        // ── 基础：静态 import / export from ──────────────────
        probe("STATIC", "src/main.tsx", "import { App } from './app';");
        probe("DEFAULT", "src/main.tsx", "import App from \\"./App\\";");
        probe("EXPORT_FROM", "src/index.ts", "export * from './shared/bridge';");
        probe("SIDE_EFFECT", "src/main.tsx", "import './styles.css';");

        // ── 本轮补的：动态 import / require ──────────────────
        probe("DYNAMIC", "src/routes.ts",
              "const page = await import('./lazy/Page');");
        probe("REQUIRE", "src/bridge/mock.ts",
              "const manifest = require('./capsule/manifest.json');");
        /*
         * 从 src/config.ts 出发的 ../../../ 会越出项目根，resolveSpec 返回 null ——
         * 那是正确行为（不许跳出项目）。这里换成恰好落在根上的层级：
         * src/shared/config.ts 上跳两级 → 项目根。
         */
        probe("REQUIRE_JSON", "src/shared/config.ts",
              "const cfg = require('../../capsule/manifest.json');");

        // ── 别名 ────────────────────────────────────────────
        probe("ALIAS", "src/main.tsx", "import { speak } from '@/shared/speech/generate';");

        // ── 相对路径的层级解析 ──────────────────────────────
        probe("UP_LEVELS", "src/shared/bridge/mock.ts",
              "import m from '../../../capsule/manifest.json';");
        probe("SAME_DIR", "src/a/b.ts", "import c from './c';");

        // ── 不该被当成引用的写法 ────────────────────────────
        probe("BARE_PKG", "src/main.tsx", "import React from 'react';");
        probe("VARIABLE", "src/a.ts", "const m = await import(somePath);");

        // ── 非 src/ 的文件不参与扫描 ────────────────────────
        probe("NON_SRC", "index.html",
              "<script src=\\"./src/main.tsx\\"></script>");

        // ── isReferenced：带不带扩展名都要认 ────────────────
        /*
         * isReferenced 的第二个参数是「项目里的完整路径」，不是裸文件名。
         * 引用集里存的是 src/types（相对路径解析后的结果），
         * 所以这里必须传 src/types.ts —— 传 types.ts 是调用方用错了。
         */
        JSONObject files = new JSONObject();
        files.put("src/main.tsx", "import x from './types';");
        Set<String> refs = collectReferenced(files);
        System.out.println("ISREF_TS=" + isReferenced(refs, "src/types.ts"));
        System.out.println("ISREF_NONE=" + isReferenced(refs, "src/unrelated.ts"));
        System.out.println("ISREF_WITH_EXT=" + isReferenced(refs, "src/types"));
    }
}
`;

const tmpDir = path.join(__dirname, '.tmp-clean');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'org', 'json'), { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, 'support', 'orgjson'))) {
  fs.copyFileSync(path.join(__dirname, 'support', 'orgjson', f), path.join(tmpDir, 'src', 'org', 'json', f));
}
fs.writeFileSync(path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'CleanProbe.java'), HARNESS);

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Users/llw/tools/jdk/jdk-21.0.2';
try {
  execFileSync(path.join(JAVA_HOME, 'bin', 'javac.exe'),
    ['-encoding', 'UTF-8', '-nowarn', '-d', path.join(tmpDir, 'out'),
      path.join(tmpDir, 'src', 'cn', 'com', 'scsxrkj', 'CleanProbe.java'),
      path.join(tmpDir, 'src', 'org', 'json', 'JSONObject.java'),
      path.join(tmpDir, 'src', 'org', 'json', 'JSONArray.java')], { stdio: 'pipe' });
} catch (e) {
  console.error('编译失败：\n' + (e.stdout || '').toString() + (e.stderr || '').toString());
  process.exit(1);
}

const raw = execFileSync(path.join(JAVA_HOME, 'bin', 'java.exe'),
  ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', path.join(tmpDir, 'out'),
    'cn.com.scsxrkj.CleanProbe'], { encoding: 'utf8' });
const v = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) v[m[1]] = m[2].trim();
}

console.log('\n── 静态 import：原有能力不能退化 ──────────────');
/*
 * import 常常省略扩展名（写 ./app，实际文件是 app.tsx），
 * collectReferenced 会把「带扩展名」和「去掉扩展名」两种形式都记下来 ——
 * 但只有原本就带扩展名的那份才会再生成一条无扩展名版本。
 * 所以 ./app 这种写法解析出的集合只有一个元素，./styles.css 有两个。
 */
ok('具名 import 解析出来', v.R_STATIC === 'src/app', v.R_STATIC);
ok('默认 import 解析出来', v.R_DEFAULT === 'src/App', v.R_DEFAULT);
ok('export from 解析出来', v.R_EXPORT_FROM === 'src/shared/bridge', v.R_EXPORT_FROM);
ok('副作用 import 带扩展名，会额外记一份无扩展名版本', v.R_SIDE_EFFECT === 'src/styles,src/styles.css', v.R_SIDE_EFFECT);
ok('@/ 别名解析到 src/', v.R_ALIAS === 'src/shared/speech/generate', v.R_ALIAS);

console.log('\n── 本轮修复：动态 import 与 require ────────────');
ok('动态 import 单引号', v.R_DYNAMIC === 'src/lazy/Page', v.R_DYNAMIC);
ok('require 相对路径', /capsule\/manifest\.json/.test(v.R_REQUIRE || ''), v.R_REQUIRE);
ok('require 两级上跳到项目根', v.R_REQUIRE_JSON === 'capsule/manifest,capsule/manifest.json', v.R_REQUIRE_JSON);

console.log('\n── 相对路径层级 ────────────────────────────────');
/*
 * 集合是按字典序拼的，capsule/manifest 排在 capsule/manifest.json 前面，
 * 所以不能用 ^ 断言 —— 直接比完整字符串。
 */
ok('../../../ 正确上跳到项目根', v.R_UP_LEVELS === 'capsule/manifest,capsule/manifest.json', v.R_UP_LEVELS);
ok('同目录相对引用', v.R_SAME_DIR === 'src/a/c', v.R_SAME_DIR);

console.log('\n── 不能误判 ────────────────────────────────────');
ok('裸包名不进引用集', v.R_BARE_PKG === '', '这是 npm 包，不该当项目内文件：' + v.R_BARE_PKG);
ok('变量形式的动态 import 不算', v.R_VARIABLE === '', v.R_VARIABLE);
ok('非 src/ 文件不扫描', v.R_NON_SRC === '', v.R_NON_SRC);

console.log('\n── isReferenced：带不带扩展名都要认 ────────────');
ok('import 写 ./types 能保护 types.ts', v.ISREF_TS === 'true', v.ISREF_TS);
ok('无关文件不会被保护', v.ISREF_NONE === 'false', v.ISREF_NONE);
ok('不带扩展名的形式也能对上', v.ISREF_WITH_EXT === 'true', v.ISREF_WITH_EXT);

console.log('\n── 正则本身必须支持 require 和括号 ────────────');
ok('IMPORT_SPEC 认 require', /require/.test(specLiteral), specLiteral);
ok('IMPORT_SPEC 允许 import 后面跟左括号', /\\\(/.test(specLiteral.replace(/\\\\\(/g, '\\(')), specLiteral);

console.log('\n----------------------------------------------------');
console.log((fail === 0 ? 'ALL PASS' : 'FAILED ' + fail) + ' (cleaner_referenced_test)  ' + pass + ' 项');
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
