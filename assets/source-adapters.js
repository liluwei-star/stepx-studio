/**
 * 源码适配器：在编译阶段给项目源码打补丁，补上本机环境缺失的能力。
 *
 * 为什么需要
 * ============================================================
 * 云端项目的源码是按平台环境写的。本机编译出来的 APK 跑在 Android WebView 里，
 * 平台专属的能力（录音、选文件等）拿不到，页面就会显示「当前环境不支持录音」。
 *
 * 两种修法：
 * <ul>
 *   <li>改用户源码 —— 不可取。用户没要求改他的代码，改了他也不知道。</li>
 *   <li>编译时注入 —— 这里做的。源码原样保留，编译产物里才有适配。</li>
 * </ul>
 *
 * 原则
 * ============================================================
 * <ol>
 *   <li><b>不静默</b> —— 每次注入都记进报告，用户在出包前能看到改了什么</li>
 *   <li><b>幂等</b> —— 重复编译不会叠加补丁</li>
 *   <li><b>能退化就不报错</b> —— 补丁失败时退回原始行为，而不是让整个构建失败</li>
 * </ol>
 */

/**
 * 一条注入记录。
 *
 * @typedef {{path:string, feature:string, detail:string}} PatchNote
 */

/**
 * 录音能力的浏览器实现。
 *
 * 用 MediaRecorder + getUserMedia —— Android WebView 原生支持这两个 API。
 * 壳的 WebChromeClient 已经处理了 onPermissionRequest，
 * 会弹框问用户要麦克风权限，用户同意后 AUDIO_CAPTURE 才可用。
 *
 * 注意几个细节：
 * <ul>
 *   <li>必须用 webm/opus —— Android WebView 只支持这两种编码</li>
 *   <li>单段 5 分钟 —— 长时间录音在部分机型上会整页重载（项目里也是这么切片的）</li>
 *   <li>用完要 stop() 掉所有音轨，否则麦克风指示灯一直亮</li>
 * </ul>
 */
const RECORD_PATCH = `
/* ---- 本机编译注入：浏览器录音实现 ---- */
const __neoRecorder = {
  stream: null as MediaStream | null,
  recorder: null as MediaRecorder | null,
  chunks: [] as Blob[],
  startedAt: 0,
  maxMs: 300000,
  stopResolve: null as ((v: unknown) => void) | null,
  timer: 0 as any,
};
async function __neoRecordAudio(params: any): Promise<any> {
  if (__neoRecorder.recorder && __neoRecorder.recorder.state === 'recording') {
    throw new Error('already recording');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('recording not supported');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  __neoRecorder.stream = stream;
  __neoRecorder.chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime });
  __neoRecorder.recorder = rec;
  rec.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) __neoRecorder.chunks.push(e.data);
  };
  rec.start(1000);
  __neoRecorder.startedAt = Date.now();
  __neoRecorder.timer = setTimeout(() => {
    if (__neoRecorder.recorder && __neoRecorder.recorder.state === 'recording') {
      __neoRecorder.stopRecordAudio().catch(() => {});
    }
  }, __neoRecorder.maxMs);
  return { started: true, mimeType: mime };
}
async function __neoStopRecordAudio(params: any): Promise<any> {
  const rec = __neoRecorder.recorder;
  if (!rec) throw new Error('not recording');
  clearTimeout(__neoRecorder.timer);
  const duration = Math.round((Date.now() - __neoRecorder.startedAt) / 1000);
  const chunks = __neoRecorder.chunks.slice();
  const stream = __neoRecorder.stream;
  const done = new Promise((resolve) => { __neoRecorder.stopResolve = resolve; });
  rec.onstop = () => {
    if (__neoRecorder.stopResolve) { __neoRecorder.stopResolve(true); __neoRecorder.stopResolve = null; }
  };
  if (rec.state !== 'inactive') rec.stop();
  await done;
  if (stream) { stream.getTracks().forEach((t: MediaStreamTrack) => t.stop()); }
  __neoRecorder.recorder = null;
  __neoRecorder.stream = null;
  __neoRecorder.chunks = [];
  const blob = new Blob(chunks, { type: 'audio/webm' });
  return { tempFilePath: '', duration, size: blob.size, mimeType: 'audio/webm' };
}
`

/**
 * 选文件能力的浏览器实现。
 *
 * 平台的 chooseMessageFile 在壳里是原生文件选择器；
 * 浏览器版用 <input type="file"> 顶上，能力上够用（拿文件名和内容）。
 */
const CHOOSE_FILE_PATCH = `
/* ---- 本机编译注入：浏览器文件选择 ---- */
function __neoChooseFile(params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = params && params.multiple === true;
    if (params && params.accept) input.accept = params.accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve({ files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) });
    });
    input.addEventListener('cancel', () => { input.remove(); reject(new Error('cancelled')); });
    input.click();
  });
}
`

/**
 * 把补丁注入到 browser.ts 的能力表和实现里。
 *
 * <p>注入点有两处：
 * <ol>
 *   <li>{@code browser-capabilities.json} 的 supported 数组 —— 加名字</li>
 *   <li>{@code browser.ts} 的 {@code available()} 和 {@code createBrowserSdk()} —— 加实现</li>
 * </ol>
 *
 * @param path 文件路径
 * @param src 源码
 * @param notes 注入记录收集器
 * @return 打了补丁的源码
 */
function patchBrowserBridge(path, src, notes) {
  if (!path.endsWith('src/shared/bridge/browser.ts')) return src
  // 幂等：已经打过就别再打
  if (src.includes('__neoRecordAudio')) return src

  let out = src

  // ① 在 available() 的 switch 里加分支
  const availAnchor = "    case 'canIUse':\n    case 'getNetworkType':\n    case 'hideKeyboard':\n      return true"
  if (out.includes(availAnchor)) {
    out = out.replace(
      availAnchor,
      `    case 'recordAudio':
    case 'stopRecordAudio':
      return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    case 'chooseMessageFile':
      return 'files' in document.createElement('input')
${availAnchor}`
    )
    notes.push({
      path,
      feature: '录音能力',
      detail: 'available() 增加 recordAudio / stopRecordAudio 判断（MediaRecorder + getUserMedia）',
    })
  }

  // ② 注入实现函数（放在文件末尾的 export 之前）
  const implAnchor = /export\s+function\s+createBrowserSdk[\s\S]{0,200}?\{/
  const m = implAnchor.exec(out)
  if (m) {
    const at = m.index
    out = out.slice(0, at) + RECORD_PATCH + CHOOSE_FILE_PATCH + '\n' + out.slice(at)
    notes.push({
      path,
      feature: '录音能力',
      detail: '注入 __neoRecordAudio / __neoStopRecordAudio（MediaRecorder 实现）',
    })
    notes.push({
      path,
      feature: '文件选择',
      detail: '注入 __neoChooseFile（input[type=file] 实现）',
    })
  }

  // ③ 在 sdk 的实现表里挂上这三个方法
  const sdkAnchor = "    canIUse:"
  if (out.includes(sdkAnchor)) {
    out = out.replace(
      sdkAnchor,
      `    recordAudio: __neoRecordAudio,
    stopRecordAudio: __neoStopRecordAudio,
    chooseMessageFile: __neoChooseFile,
${sdkAnchor}`
    )
    notes.push({
      path,
      feature: '桥接注册',
      detail: 'sdk 挂上 recordAudio / stopRecordAudio / chooseMessageFile',
    })
  }

  return out
}

/**
 * 给 browser-capabilities.json 补能力声明。
 *
 * @param src JSON 源码
 * @param notes 注入记录收集器
 * @return 补完的 JSON
 */
function patchBrowserCapabilities(src, notes) {
  let obj
  try {
    obj = JSON.parse(src)
  } catch {
    return src
  }
  const list = Array.isArray(obj.supported) ? obj.supported : []
  const add = ['recordAudio', 'stopRecordAudio', 'chooseMessageFile']
  const missing = add.filter(function(x){return !list.includes(x)})
  if (missing.length === 0) return src
  list.push(...missing)
  obj.supported = list
  notes.push({
    path: 'src/shared/bridge/browser-capabilities.json',
    feature: '能力声明',
    detail: `supported 增加 ${missing.join('、')}`,
  })
  return JSON.stringify(obj, null, 2)
}


/**
 * 给 bridge/loader.ts 打补丁：没有平台壳时退到浏览器实现。
 *
 * 项目原本的规则是：非 PWA 构建、又探测不到 window.capsule，
 * 就直接抛「原生能力不可用」。这条规则在平台的壳里成立 —— 平台会注入 capsule。
 *
 * 但 StepX Studio 生成的独立 App 里没有 capsule（也不该有，那是平台的 SDK），
 * 于是整条桥接链在初始化时就断了：录音、选文件、定位、剪贴板全部报「当前环境不支持」。
 *
 * 浏览器本来就能做这些事（录音有 MediaRecorder，选文件有 input[type=file]），
 * 所以把那个 throw 换成浏览器实现。有壳时仍然优先用壳，行为不变。
 *
 * @param path 文件路径
 * @param src 源码
 * @param notes 注入记录收集器
 * @return 打了补丁的源码
 */
function patchBridgeLoader(path, src, notes) {
  if (!path.endsWith('src/shared/bridge/loader.ts')) return src
  // 幂等
  if (src.includes('__neoBrowserFallback')) return src

  // 锚点必须带上前面那行，才能落在 loadBridge() 里。
  // mockHandle() 末尾有一模一样的 throw —— 只匹配 throw 会改错地方。
  // 换行风格跟随源文件：项目的 .ts 是 CRLF，
  // 用 '\n' 拼出来的锚点在 CRLF 文件里永远匹配不上。
  const eol = src.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const anchorLines = [
    "    if (import.meta.env.DEV && forced !== 'native') return mockHandle()",
    "    throw new BridgeError('unsupported', 'initBridge', '原生能力不可用')",
  ];
  const anchor = anchorLines.join(eol);
  if (!src.includes(anchor)) return src

  const replacement = [
    "    if (import.meta.env.DEV && forced !== 'native') return mockHandle()",
    "    // __neoBrowserFallback：没有平台壳的独立 App 走浏览器实现。",
    "    // 录音有 MediaRecorder、选文件有 input[type=file]，浏览器本来就能做，",
    "    // 不该因为缺一个平台 SDK 就把整条桥接链判死。",
    "    {",
    "      const { createBrowserSdk: __neoBrowserSdk } = await import('./browser')",
    "      return { mode: 'browser', sdk: __neoBrowserSdk() }",
    "    }",
  ].join(eol);

  const out = src.replace(anchor, replacement);
  notes.push({
    path,
    feature: '桥接回退',
    detail: '没有平台壳时改用浏览器实现；否则录音、选文件、定位全部报不支持',
  });
  return out;
}

/**
 * 统一入口：给一个源文件打适配补丁。
 *
 * @param path 文件路径
 * @param src  源码
 * @param notes 注入记录收集器
 * @return 打了补丁的源码
 */
function apply(path, src, notes) {
  if (path.endsWith('browser-capabilities.json')) {
    return patchBrowserCapabilities(src, notes)
  }
  if (path.endsWith('src/shared/bridge/loader.ts')) {
    return patchBridgeLoader(path, src, notes)
  }
  return patchBrowserBridge(path, src, notes)
}


// 挂到全局：local-runner.html 用普通 <script> 加载，
// 不是 type="module"，所以不能用 ESM 的 export。
var NeoAdapters = {
  apply: apply,
  patchBrowserBridge: patchBrowserBridge,
  patchBrowserCapabilities: patchBrowserCapabilities,
  patchBridgeLoader: patchBridgeLoader,
};



