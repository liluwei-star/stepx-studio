package cn.com.scsxrkj;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * 素材体检：核对项目里的分片资源齐不齐。
 *
 * <h3>为什么需要</h3>
 *
 * <p>语音识别模型这类资源没法整份放进项目：平台的项目快照有体积上限，
 * 78 MB 的权重会让快照读取直接失败。所以它们被切成 4 MiB 的片，
 * 旁边放一份 {@code chunks.json} 记录每片应有的字节数。
 *
 * <p>问题在于「缺片」是隐形的：文件浏览器里能看到 20 个
 * {@code model.int8.onnx.partN}，却看不出哪个是空的、哪个根本不存在。
 * 运行时的表现是识别一直不可用，而界面上只会说「当前环境不支持」或者干脆没反应。
 *
 * <h3>判据</h3>
 *
 * <p>只认 {@code chunks.json} 这个格式：键是文件名，值是每片的字节数数组。
 * 逐片对照项目里实际的文件大小 —— 少一片、或者大小对不上，都算不完整。
 * 项目里没有这种清单的资源不参与体检（无从判断，不猜）。
 */
final class AssetAudit {

 /** 清单文件的后缀。 */
 private static final String MANIFEST = "chunks.json";

 /**
  * 跑一次体检。
  *
  * @param p        项目对象
  * @param filesDir 应用私有目录（大文件存在 {@code project-files/} 下）
  * @return 报告：{@code ok} 是否完整；{@code groups} 每个清单的明细；
  *         {@code missingParts} 缺失总片数
  */
 static JSONObject check(JSONObject p, File filesDir) {
  JSONObject files = p.optJSONObject("files");
  JSONObject bins = p.optJSONObject("binaryFiles");
  JSONObject report = new JSONObject();
  JSONArray groups = new JSONArray();
  int missingParts = 0;
  long missingBytes = 0;
  int manifestCount = 0;

  try {
   if (files == null) {
    return report.put("ok", true).put("groups", groups).put("missingParts", 0)
      .put("note", "项目里没有分片清单，无需体检");
   }

   for (Iterator<String> it = files.keys(); it.hasNext(); ) {
    String name = it.next();
    if (!name.endsWith(MANIFEST)) continue;

    JSONObject manifest;
    try {
     manifest = new JSONObject(files.getString(name));
    } catch (Exception bad) {
     // 清单本身坏了就没法判断，报出来而不是当它不存在
     groups.put(new JSONObject().put("manifest", name).put("broken", true)
       .put("parts", 0).put("missing", 0));
     continue;
    }

    manifestCount++;
    // 分片和清单同目录：dir 保留结尾的斜杠
    String dir = name.substring(0, name.length() - MANIFEST.length());

    JSONArray items = new JSONArray();
    int groupMissing = 0;
    long groupMissingBytes = 0;

    for (Iterator<String> k = manifest.keys(); k.hasNext(); ) {
     String file = k.next();
     JSONArray sizes = manifest.optJSONArray(file);
     if (sizes == null || sizes.length() == 0) continue;

     int fileMissing = 0;
     long fileMissingBytes = 0;
     JSONArray gaps = new JSONArray();

     for (int i = 0; i < sizes.length(); i++) {
      long expected = sizes.optLong(i, -1);
      if (expected < 0) continue;
      String part = dir + file + ".part" + i;
      long got = sizeOf(part, files, bins, filesDir);
      if (got == expected) continue;
      fileMissing++;
      fileMissingBytes += expected;
      // 只列前若干条，清单本身要能塞进弹窗
      if (gaps.length() < 30) {
       gaps.put(new JSONObject().put("path", part).put("want", expected).put("got", got));
      }
     }

     if (fileMissing > 0) {
      groupMissing += fileMissing;
      groupMissingBytes += fileMissingBytes;
      items.put(new JSONObject()
        .put("file", file)
        .put("parts", sizes.length())
        .put("missing", fileMissing)
        .put("missingBytes", fileMissingBytes)
        .put("gaps", gaps));
     }
    }

    if (groupMissing > 0) {
     missingParts += groupMissing;
     missingBytes += groupMissingBytes;
     groups.put(new JSONObject()
       .put("manifest", name)
       .put("dir", dir)
       .put("missing", groupMissing)
       .put("missingBytes", groupMissingBytes)
       .put("items", items));
    }
   }

   report.put("ok", missingParts == 0);
   report.put("groups", groups);
   report.put("missingParts", missingParts);
   report.put("missingBytes", missingBytes);
   report.put("manifestCount", manifestCount);
   if (manifestCount == 0) {
    report.put("note", "项目里没有分片清单，无需体检");
   }
  } catch (Exception e) {
   // put 会抛受检异常，在 catch 里再抛一次就编译不过
   try {
    report.put("ok", false).put("error",
      e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
   } catch (Exception ignored) {
   }
  }
  return report;
 }

 /**
  * 取项目里某个路径的实际字节数。
  *
  * <p>三种存法都要管：文本直接算 UTF-8 长度；小二进制是 base64；
  * 大文件是磁盘上的 {@code .bin} 引用 —— 后者不能解码到内存，
  * 几十 MB 的解码在手机上就是一次 OOM。
  *
  * @return 实际字节数；不存在返回 -1
  */
 private static long sizeOf(String path, JSONObject files, JSONObject bins, File filesDir) {
  if (files != null && files.has(path)) {
   try {
    return files.getString(path).getBytes(StandardCharsets.UTF_8).length;
   } catch (Exception e) {
    return -1;
   }
  }
  if (bins != null && bins.has(path)) {
   String ref = bins.optString(path, "");
   if (ref.endsWith(".bin")) {
    File f = new File(new File(filesDir, "project-files"), ref);
    return f.isFile() ? f.length() : -1;
   }
   try {
    return android.util.Base64.decode(ref, android.util.Base64.DEFAULT).length;
   } catch (Exception e) {
    return -1;
   }
  }
  return -1;
 }

 private AssetAudit() {
 }
}
