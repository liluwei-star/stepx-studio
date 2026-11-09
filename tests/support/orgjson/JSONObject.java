package org.json;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 测试专用的最小 org.json 替身。
 *
 * <p>Android SDK 里的 android.jar 只有 org.json 的<b>签名</b>，
 * 所有方法体都是 {@code throw new RuntimeException("Stub!")} ——
 * 编译能过，一跑就炸。而单元测试要在桌面上真跑 Java，
 * 就需要一个能用的实现。
 *
 * <p>所以这里只实现被测代码真正用到的那几个方法：字符串值、
 * 嵌套对象、key 遍历、NULL 语义，以及 toString / 解析（生产代码里
 * 有 {@code new JSONObject(x.toString())} 这种复制写法，解析必须真能跑）。
 *
 * <p>这不是给产品用的，也不要拿它替换 Android 的实现 ——
 * 它不支持数字精度、类型推断、JSON 校验等真实行为。
 */
public class JSONObject {

  /** 与 Android 一致：{@code put(name,null)} 存的是 DELETE 语义的占位对象。 */
  public static final Object NULL = new Object() {
    @Override public String toString() { return "null"; }
  };

  private final LinkedHashMap<String, Object> map = new LinkedHashMap<>();

  public JSONObject() {}

  /** 解析一个 JSON 对象文本；文本为空时得到空对象。 */
  public JSONObject(String text) {
    if (text == null || text.trim().isEmpty()) return;
    Parser p = new Parser(text);
    p.skipSpace();
    Map<String, Object> parsed = p.object();
    map.putAll(parsed);
    p.skipSpace();
    if (!p.done()) throw new IllegalArgumentException("JSON 对象后面还有多余内容：" + text.substring(0, Math.min(40, text.length())));
  }

  public JSONObject put(String name, Object value) {
    map.put(name, value == null ? NULL : value);
    return this;
  }

  public JSONObject put(String name, int value) { return put(name, (Object) String.valueOf(value)); }

  public boolean has(String name) { return map.containsKey(name); }

  public Object opt(String name) { return map.get(name); }

  /** 与 Android 一致：键不存在时抛，存在时返回原值。 */
  public Object get(String name) {
    if (!map.containsKey(name)) throw new IllegalArgumentException("没有这个键：" + name);
    return map.get(name);
  }

  public boolean isNull(String name) {
    Object v = map.get(name);
    return v == null || v == NULL;
  }

  public Object remove(String name) { return map.remove(name); }

  public int length() { return map.size(); }

  public Iterator<String> keys() { return map.keySet().iterator(); }

  public String optString(String name) { return optString(name, ""); }

  public String optString(String name, String fallback) {
    Object v = map.get(name);
    return v == null || v == NULL ? fallback : String.valueOf(v);
  }

  public String getString(String name) {
    Object v = map.get(name);
    if (v == null || v == NULL) throw new IllegalArgumentException("没有这个键：" + name);
    return String.valueOf(v);
  }

  public JSONObject getJSONObject(String name) {
    Object v = map.get(name);
    if (!(v instanceof JSONObject)) throw new IllegalArgumentException("不是对象：" + name);
    return (JSONObject) v;
  }

  public JSONObject optJSONObject(String name) {
    Object v = map.get(name);
    return v instanceof JSONObject ? (JSONObject) v : null;
  }

  public JSONArray getJSONArray(String name) {
    Object v = map.get(name);
    if (!(v instanceof JSONArray)) throw new IllegalArgumentException("不是数组：" + name);
    return (JSONArray) v;
  }

  @Override public String toString() {
    StringBuilder sb = new StringBuilder("{");
    boolean first = true;
    for (Map.Entry<String, Object> e : map.entrySet()) {
      if (!first) sb.append(',');
      first = false;
      sb.append(quote(e.getKey())).append(':').append(value(e.getValue()));
    }
    return sb.append('}').toString();
  }

  static String value(Object v) {
    if (v == null || v == NULL) return "null";
    if (v instanceof JSONObject || v instanceof JSONArray) return v.toString();
    return quote(String.valueOf(v));
  }

  static String quote(String s) {
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n"); break;
        case '\r': sb.append("\\r"); break;
        case '\t': sb.append("\\t"); break;
        default: sb.append(c);
      }
    }
    return sb.append('"').toString();
  }

  /** 够用的递归下降解析器：对象、数组、字符串、字面量。 */
  static final class Parser {
    private final String s;
    private int i;

    Parser(String s) { this.s = s; }

    boolean done() { return i >= s.length(); }

    void skipSpace() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

    private char peek() {
      if (i >= s.length()) throw new IllegalArgumentException("JSON 意外结束");
      return s.charAt(i);
    }

    private void expect(char c) {
      skipSpace();
      if (peek() != c) throw new IllegalArgumentException("期望 " + c + "，实际 '" + peek() + "'（位置 " + i + "）");
      i++;
    }

    Map<String, Object> object() {
      LinkedHashMap<String, Object> out = new LinkedHashMap<>();
      expect('{');
      skipSpace();
      if (peek() == '}') { i++; return out; }
      while (true) {
        skipSpace();
        String k = string();
        expect(':');
        out.put(k, val());
        skipSpace();
        char c = peek();
        i++;
        if (c == '}') return out;
        if (c != ',') throw new IllegalArgumentException("对象里出现非法字符 '" + c + "'");
      }
    }

    java.util.List<Object> array() {
      java.util.List<Object> out = new java.util.ArrayList<>();
      expect('[');
      skipSpace();
      if (peek() == ']') { i++; return out; }
      while (true) {
        out.add(val());
        skipSpace();
        char c = peek();
        i++;
        if (c == ']') return out;
        if (c != ',') throw new IllegalArgumentException("数组里出现非法字符 '" + c + "'");
      }
    }

    Object val() {
      skipSpace();
      char c = peek();
      if (c == '"') return string();
      if (c == '{') return new JSONObject(toText(object()));
      if (c == '[') return new JSONArray(toText(array()));
      if (s.startsWith("true", i)) { i += 4; return "true"; }
      if (s.startsWith("false", i)) { i += 5; return "false"; }
      if (s.startsWith("null", i)) { i += 4; return NULL; }
      int start = i;
      while (i < s.length() && ",}] \t\r\n".indexOf(s.charAt(i)) < 0) i++;
      if (start == i) throw new IllegalArgumentException("看不懂的内容（位置 " + i + "）");
      /* 数字按原文存字符串：被测代码只做相等比较，不参与运算 */
      return s.substring(start, i);
    }

    String string() {
      skipSpace();
      if (peek() != '"') throw new IllegalArgumentException("期望字符串（位置 " + i + "）");
      i++;
      StringBuilder sb = new StringBuilder();
      while (true) {
        char c = peek();
        i++;
        if (c == '"') return sb.toString();
        if (c != '\\') { sb.append(c); continue; }
        char e = peek();
        i++;
        switch (e) {
          case 'n': sb.append('\n'); break;
          case 'r': sb.append('\r'); break;
          case 't': sb.append('\t'); break;
          case 'b': sb.append('\b'); break;
          case 'f': sb.append('\f'); break;
          case 'u':
            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
            i += 4;
            break;
          default: sb.append(e);
        }
      }
    }

    /** 把解析出来的结构再序列化回去，供构造嵌套对象用。 */
    @SuppressWarnings("unchecked")
    static String toText(Object o) {
      if (o instanceof Map) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
          if (!first) sb.append(',');
          first = false;
          sb.append(quote(e.getKey())).append(':').append(value(e.getValue()));
        }
        return sb.append('}').toString();
      }
      StringBuilder sb = new StringBuilder("[");
      boolean first = true;
      for (Object v : (java.util.List<Object>) o) {
        if (!first) sb.append(',');
        first = false;
        sb.append(value(v));
      }
      return sb.append(']').toString();
    }
  }
}
