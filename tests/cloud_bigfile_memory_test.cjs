#!/usr/bin/env node
/**
 * 回归测试：云端大文件通道不能在 JS 堆里同时持有两份完整内容。
 *
 * <p>缺陷背景：83 MB 的模型文件在同步时，前端有两处会「先攒一份、再拼一份」：
 * <ul>
 *   <li>{@code readBig()} —— 分块读进来先进 {@code parts} 数组，
 *       再 {@code new Uint8Array(total)} 拼起来。峰值两份 = 166 MB。</li>
 *   <li>{@code bytes(response)} —— 同理，先 {@code chunks} 后拼。</li>
 * </ul>
 * 加上 base64 中转（1.33 倍），手机 JS 堆直接被顶穿，被系统杀掉。
 *
 * <p>本测试从 {@code assets/cloud-projects.js} 里提出这两段真实实现跑一遍，
 * 断言内容逐字节正确，并断言代码不再走「攒完再拼」的老路。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(path.resolve(__dirname), '..');
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const SRC = (ROOT + '/assets/cloud-projects.js').split(String.fromCharCode(92)).join('/');
const src = fs.readFileSync(SRC, 'utf8');

/** 从源码里抠出一段 `const name=async(...)=>{...};` */
function extract(name) {
  const re = new RegExp('const ' + name + '=async[\\s\\S]*?\\n \\};');
  const m = src.match(re);
  return m ? m[0] : null;
}

const B64_DECODE = (s) => Buffer.from(s, 'base64').toString('binary');

async function main() {
  /* ---------------------------------------------------------------- *
   * 判据一：readBig 按已知大小一次分配，边读边填
   * ---------------------------------------------------------------- */
  console.log('\n── 判据一：readBig 一次分配，边读边填 ──────');
  const SIZE = 5 * 1024 * 1024;
  const content = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) content[i] = (i * 31 + 7) & 0xff;

  let reads = 0;
  const native = {
    cloudSize: async () => SIZE,
    cloudRead: async (id, key, off, len) => {
      reads++;
      return content.subarray(off, Math.min(off + len, SIZE)).toString('base64');
    },
  };

  const readBigSrc = extract('readBig');
  ok('能从源码里定位 readBig', !!readBigSrc);
  if (readBigSrc) {
    ok('readBig 不再先攒 parts 再拼', !readBigSrc.includes('const parts=[]'));
    ok('readBig 按 cloudSize 一次分配', /new Uint8Array\(size\)/.test(readBigSrc));
    ok('readBig 边读边写进同一块', /out\.set\(part,at\)/.test(readBigSrc));

    const readBig = new Function('window', 'atob', 'Uint8Array', 'Promise',
      `${readBigSrc}; return readBig;`)(
      { NeoCloudNative: native }, B64_DECODE, Uint8Array, Promise);

    const got = await readBig('p1', 'assets/model.onnx', 'abc.bin');
    ok('读回来的字节数与文件一致', got.length === SIZE, 'got=' + got.length);
    let same = true;
    for (let i = 0; i < SIZE; i++) if (got[i] !== content[i]) { same = false; break; }
    ok('读回来的内容逐字节一致', same);
    ok('按 1 MB 分块读，共 5 次', reads === 5, 'reads=' + reads);
  }

  /* ---------------------------------------------------------------- *
   * 判据二：bytes() 有 content-length 时不留 chunks
   * ---------------------------------------------------------------- */
  console.log('\n── 判据二：bytes() 有长度时不留 chunks ──────');
  const B = 3 * 1024 * 1024;
  const payload = Buffer.alloc(B, 0x5a);

  const bytesSrc = extract('bytes');
  ok('能从源码里定位 bytes', !!bytesSrc);
  if (bytesSrc) {
    ok('有长度时一次分配', /new Uint8Array\(len\)/.test(bytesSrc));
    ok('无长度时才退回攒 chunks', /chunks=buf\?null:\[\]/.test(bytesSrc));
    ok('写入偏移用已读字节数', /buf\.set\(x\.value,n-x\.value\.length\)/.test(bytesSrc));

    const response = {
      headers: { get: (k) => (k === 'content-length' ? String(B) : null) },
      body: {
        getReader() {
          let at = 0;
          return {
            async read() {
              if (at >= B) return { done: true };
              const n = Math.min(256 * 1024, B - at);
              const v = Uint8Array.from(payload.subarray(at, at + n));
              at += n;
              return { done: false, value: v };
            },
            cancel() { return Promise.resolve(); },
          };
        },
      },
    };

    const bytesFn = new Function('Uint8Array', 'Number', 'Promise', 'Error', 'Math',
      `const FILE=100*1024*1024;${bytesSrc}; return bytes;`)(
      Uint8Array, Number, Promise, Error, Math);

    const got2 = await bytesFn(response);
    ok('读回来的长度与声明一致', got2.length === B, 'got=' + got2.length);
    let same2 = true;
    for (let i = 0; i < B; i++) if (got2[i] !== 0x5a) { same2 = false; break; }
    ok('内容逐字节一致', same2);
  }

  /* ---------------------------------------------------------------- *
   * 判据三：没有长度时仍然要能读（分块传输）
   * ---------------------------------------------------------------- */
  console.log('\n── 判据三：没有 content-length 时也不能读坏 ──────');
  if (bytesSrc) {
    const C = 700 * 1024;
    const payload2 = Buffer.alloc(C, 0x11);
    const response2 = {
      headers: { get: () => null },
      body: {
        getReader() {
          let at = 0;
          return {
            async read() {
              if (at >= C) return { done: true };
              const n = Math.min(100 * 1024, C - at);
              const v = Uint8Array.from(payload2.subarray(at, at + n));
              at += n;
              return { done: false, value: v };
            },
            cancel() { return Promise.resolve(); },
          };
        },
      },
    };
    const bytesFn = new Function('Uint8Array', 'Number', 'Promise', 'Error', 'Math',
      `const FILE=100*1024*1024;${bytesSrc}; return bytes;`)(
      Uint8Array, Number, Promise, Error, Math);
    const got3 = await bytesFn(response2);
    ok('无长度时也读全了', got3.length === C, 'got=' + got3.length);
  }

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('  ✗ 测试本身出错 -> ' + e.message);
  console.log('\n通过 ' + pass + ' / 失败 ' + (fail + 1));
  process.exit(1);
});
