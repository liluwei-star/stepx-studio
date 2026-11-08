/**
 * 把 npm 上的浏览器版包转成 StepX Studio 能用的内置依赖。
 *
 * 为什么需要这个
 * ============================================================
 * Studio 的本机编译器用 esbuild.wasm 编译项目。esbuild 只管语法，
 * 不管依赖 —— 遇到 `import JSZip from 'jszip'` 时，它不知道这个包
 * 从哪来，只能报错「本机尚未内置依赖：jszip」。
 *
 * Studio 里已有的内置依赖（react、react-router-dom 这些）就是这么来的：
 * 从 npm 取发布包 → 取它的浏览器版（UMD）→ 去掉 UMD 包装 →
 * 前面加一段 require 垫片 → 末尾补 ESM 导出。
 *
 * 这个脚本就是把这个过程自动化，新增一个内置依赖只需要：
 *   node tools/make-vendor-dep.mjs jszip@3.10.1
 *
 * 生成的产物
 * ============================================================
 *   assets/local-vendor/v_<包名去横线>.js   转好的模块
 *   assets/local-vendor/manifest.json       追加一条映射
 *
 * 依赖
 * ============================================================
 *   · 只用 Node 内置模块（fs / path / https），不需要 npm install
 *   · 默认走 registry.npmmirror.com（国内快），可用 NPM_REGISTRY 覆盖
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

// esbuild 用现成的：C:/Users/llw/tools/neo-sign/node_modules 里已经装好了。
// 不在项目里另装一份 —— 这个脚本只是打包工具，不需要把依赖带进 APK。
const require = createRequire(import.meta.url)
const ESBUILD_PATHS = [
  'C:/Users/llw/tools/neo-sign/node_modules/esbuild',
  'esbuild',
]
let esbuild = null
for (const p of ESBUILD_PATHS) {
  try {
    esbuild = require(p)
    break
  } catch (e) {
    /* 继续找下一个 */
  }
}
if (!esbuild) {
  console.error('找不到 esbuild。装一个：npm i -g esbuild，或改 ESBUILD_PATHS 指向现有安装。')
  process.exit(1)
}

const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com'
const VENDOR_DIR = path.resolve('assets/local-vendor')

/**
 * 从 npm registry 取包的元数据。
 * @param {string} name 包名
 * @param {string} version 版本号
 */
async function fetchMeta(name, version) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}/${version}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`取包信息失败 ${name}@${version}：HTTP ${res.status}`)
  return res.json()
}

/**
 * 下载 tarball 并解出 package/ 目录的内容。
 * @param {string} tarballUrl 下载地址
 * @param {string} dest 解压目标
 */
async function downloadAndExtract(tarballUrl, dest) {
  const res = await fetch(tarballUrl)
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  // 自己解 tar —— 不能调系统 tar：
  // Windows 上 git-bash 的 tar 会把 "C:\Users\..." 当成远程主机名，
  // 报 "Cannot connect to C: resolve failed"。
  const tar = zlib.gunzipSync(buf)
  let off = 0
  let longName = null
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break

    // 字段是 8 位 ASCII，末尾可能是 NUL
    const str = (start, len) => {
      const s = header.subarray(start, start + len)
      const end = s.indexOf(0)
      return s.subarray(0, end === -1 ? s.length : end).toString('utf8')
    }
    const name = longName || str(0, 100)
    longName = null
    const size = parseInt(str(124, 12).trim() || '0', 8) || 0
    const type = String.fromCharCode(header[156])
    off += 512
    const body = tar.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512

    if (type === 'L') {
      // GNU 长文件名扩展：下一条记录的真正名字
      longName = body.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type !== '0' && type !== '\0') continue // 只要普通文件

    const rel = name.replace(/^\.\//, '')
    if (!rel.startsWith('package/')) continue
    const outPath = path.join(dest, rel)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, body)
  }
  const pkgDir = path.join(dest, 'package')
  if (!fs.existsSync(pkgDir)) throw new Error('解压后没找到 package 目录')
  return pkgDir
}

/**
 * 找一个包里适合浏览器用的入口文件。
 *
 * 优先顺序：browser 字段 → unpkg 的 ?module → dist 里的 UMD → main。
 * 判断 UMD 的办法：文件里有 `typeof exports === "object"` 或 `define.amd`。
 *
 * @param {string} pkgDir 包目录
 * @param {object} meta 包元数据
 */
function pickBrowserEntry(pkgDir, meta) {
  // esbuild 能把 CommonJS 依赖树打成自包含的 IIFE，
  // 这样 qrcode 这种「入口只有 2 KB、逻辑散在 lib/ 里」的包也能用。
  // 所以优先走 esbuild 打包，失败再退回找预构建的浏览器版。
  try {
    // 入口要从装好的 node_modules 里找（package.json 的 main/module/browser）
    const installedMeta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const picked = pickRawEntry(pkgDir, installedMeta)
    const entryPoint = picked.file
    const out = esbuild.buildSync({
      entryPoints: [entryPoint],
      bundle: true,
      format: 'iife',
      globalName: '__neoPkg',
      platform: 'browser',
      target: 'chrome110',
      write: false,
      minify: true,
      legalComments: 'none',
      // Node 内置模块在浏览器端没有 —— 给个空壳，让打包能过。
      // 真用到这些的包（比如 qrcode 的 fs）运行时才会暴露问题，
      // 但 qrcode 的 browser 字段已经把 fs 排除了。
      external: ['fs', 'path', 'os', 'crypto', 'stream', 'util', 'zlib', 'http', 'https', 'child_process'],
    })
    const code = out.outputFiles[0].text
    return { bundled: true, code, rel: picked.rel }
  } catch (e) {
    // 完整打印错误 —— 只取第一行会丢掉 esbuild 真正的报错位置
    const details = (e.errors || []).map((x) => `    ${x.text}\n      在 ${x.location?.file}:${x.location?.line}`).join('\n')
    console.log(`  esbuild 打包失败：\n${details || e.message}`)
    console.log('  改用预构建版本')
  }
  return { bundled: false, ...pickRawEntry(pkgDir, meta) }
}

/**
 * 找出包的原始入口（不打包）。
 */
function pickRawEntry(pkgDir, meta) {
  const candidates = []

  // package.json 的 browser 字段可能指向别的文件
  if (typeof meta.browser === 'string') {
    candidates.push(meta.browser)
  } else if (meta.browser && typeof meta.browser === 'object') {
    // 形如 { "./lib/index": "./dist/x.js" }
    const main = meta.main || 'index.js'
    if (meta.browser[main]) candidates.push(meta.browser[main])
    for (const v of Object.values(meta.browser)) {
      if (typeof v === 'string' && v.endsWith('.js')) candidates.push(v)
    }
  }

  // module 字段（ESM 版，优先）
  if (meta.module) candidates.push(meta.module)

  // dist 里常见的 UMD 名
  for (const name of ['dist/index.min.js', 'dist/index.js', 'dist/bundle.js', 'dist/xgplayer.js']) {
    candidates.push(name)
  }

  if (meta.main) candidates.push(meta.main)
  candidates.push('index.js')

  for (const c of candidates) {
    const rel = c.replace(/^\.\//, '')
    const full = path.join(pkgDir, rel)
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const src = fs.readFileSync(full, 'utf8')
      if (src.length < 20) continue
      // ESM 版直接能用，跳过
      if (/^\s*(export\s+|import\s+[\w{*])/m.test(src) && !/typeof exports/.test(src)) {
        return { file: full, rel, esm: true }
      }
      return { file: full, rel, esm: false }
    }
  }
  throw new Error('找不到可用的浏览器入口')
}

/**
 * 在入口文件里找出真正的导出名。
 *
 * <p>esbuild 的 IIFE 产物把导出挂在 {@code __neoPkg} 上，
 * 但项目里 {@code import JSZip from 'jszip'} 拿的是 default。
 * 所以要按包的实际情况决定 default 指向谁：
 * <ul>
 *   <li>导出里有 default → 用它</li>
 *   <li>只有命名导出 → 把整个命名空间当 default（CommonJS 的老规矩）</li>
 * </ul>
 */

/**
 * 剥掉 UMD 包装，把模块体抠出来。
 *
 * UMD 常见三种形态：
 *   1. `(function(global, factory){ ... })(this, function(){ ... })`
 *   2. `!function(e,t){ ... }(this, function(){ ... })`
 *   3. `(function(){ ... }).call(this)`  ← 里面直接 return 导出对象
 *
 * 这里不做通用解析（太脆），而是让转换后的文件在运行时自己判断：
 * 把原始 UMD 完整保留，只在末尾用一个小探针把导出对象取出来。
 *
 * @param {string} src 原始源码
 */
function stripUmd(src) {
  // 找出 factory 函数的参数表和函数体
  // 形态 1/2：xxx(function(global, factory){...})(this, function(...){...})
  const m = src.match(/function\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{/)
  if (!m) return { body: src, probe: null }

  // 找到 factory 调用的那个函数：从 "function(" 之后开始做括号配平
  const start = src.indexOf('function', m.index)
  let depth = 0, i = start, bodyStart = -1
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') {
      depth++
      if (depth === 1) bodyStart = i + 1
    } else if (ch === ')') {
      depth--
      if (depth === 0) break
    }
  }
  if (bodyStart < 0) return { body: src, probe: null }
  return { body: src, probe: src.slice(bodyStart, i) }
}

/**
 * 生成转换后的模块文件。
 *
 * 产出结构（照抄 Studio 里 m6.js 的做法）：
 *   import * as __neoReact from "/__vendor/m0.js";
 *   ...
 *   var require=(n)=>{ ... };
 *   <原始 UMD 源码>
 *   export { ... }
 *
 * @param {string} raw 原始包源码
 * @param {string} pkgName 包名（用于导出名）
 */
function buildModule(raw, pkgName) {
  // 原始 UMD 通常会检测 module.exports / define。
  // 在 ESM 环境里 module 是 undefined，会走全局分支，把导出挂到 globalThis。
  // 所以先定义一个 module 变量，让它走 CommonJS 分支，导出就落在 module.exports 上。
  const guard = `
var module=typeof module!=="undefined"?module:{exports:{}};var exports=module.exports;
`
  const tail = `
var __neoExport=module.exports||{};
var __neoDefault=__neoExport&&__neoExport.default!==undefined?__neoExport.default:__neoExport;
export{__neoExport as __neoAll,__neoDefault as default};
`
  return guard + raw + tail
}

/**
 * 给 esbuild 的 IIFE 产物补上 ESM 导出。
 *
 * <p>esbuild 用 globalName 打包后，导出挂在全局变量上（这里叫 __neoPkg）。
 * 但项目代码写的是 `import JSZip from 'jszip'` —— 要的是 default。
 *
 * <p>esbuild 会生成 `var __neoPkg = (() => { ... })()`，
 * 里面通过 `__export` 辅助函数把命名导出挂到返回对象上。
 * 所以这里要做的：
 * <ul>
 *   <li>把产物里的 `var __neoPkg =` 改成 `var __neoPkg =` 后紧跟一个取值动作
 *   <li>如果有 default 导出，default 指向它；否则把命名空间整体当 default</li>
 * </ul>
 */
function buildFromEsbuild(code) {
  // esbuild 的 IIFE 形式：var __neoPkg = (() => { ... })();
  // 把它包一层，导出 default。
  const tail = `
var __neoNs=(typeof __neoPkg!=="undefined"&&__neoPkg)||{};
var __neoDef=(__neoNs&&__neoNs.default!==undefined)?__neoNs.default:__neoNs;
export{__neoNs as __neoAll,__neoDef as default};
`
  return code + tail
}

/**
 * 主流程。
 */
async function main() {
  const spec = process.argv[2]
  if (!spec) {
    console.error('用法：node tools/make-vendor-dep.mjs <包名[@版本]>')
    process.exit(1)
  }
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  const version = at > 0 ? spec.slice(at + 1) : 'latest'

  console.log(`取 ${name}@${version} …`)
  const meta = await fetchMeta(name, version)
  const realVersion = meta.version

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-dep-'))
  try {
    // 用 npm install 而不是只下 tarball ——
    // 只下 tarball 的话，esbuild 打包时找不到传递依赖
    // （jszip 依赖 lie / pako / readable-stream / setimmediate），
    // 报 "Could not resolve pako" 之类。
    // npm install 会把整棵依赖树装齐，打包才有东西可打。
    const pkgJson = { name: 'vendor-dep-tmp', version: '1.0.0', private: true, dependencies: { [name]: version } }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkgJson, null, 2))
    console.log('  npm install（拉传递依赖）…')
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error',
      '--registry', REGISTRY], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    const pkgDir = path.join(tmp, 'node_modules', name)
    if (!fs.existsSync(pkgDir)) throw new Error('npm install 后没找到包目录')
    const entry = pickBrowserEntry(pkgDir, meta)
    let content
    let desc
    if (entry.bundled) {
      content = buildFromEsbuild(entry.code)
      desc = `esbuild 打包 ${entry.rel} → ${(content.length / 1024).toFixed(0)} KB`
    } else {
      const raw = fs.readFileSync(entry.file, 'utf8')
      desc = `预构建 ${entry.rel}  ${(raw.length / 1024).toFixed(0)} KB  ${entry.esm ? 'ESM' : 'UMD'}`
      content = entry.esm ? raw : buildModule(raw, name)
    }
    console.log(`  ${desc}`)

    const outName = 'v_' + name.replace(/[@/]/g, '_').replace(/[^a-zA-Z0-9_]/g, '') + '.js'
    const outPath = path.join(VENDOR_DIR, outName)
    fs.writeFileSync(outPath, content, 'utf8')
    console.log(`  生成：${path.relative(process.cwd(), outPath)}  ${(content.length / 1024).toFixed(0)} KB`)

    // 更新 manifest.json
    const mfPath = path.join(VENDOR_DIR, 'manifest.json')
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'))
    mf[name] = { file: outName, version: realVersion, package: name }
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 0) + '\n', 'utf8')
    console.log(`  manifest 已登记：${name} → ${outName} (${realVersion})`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})
