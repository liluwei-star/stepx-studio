package org.json;

import java.util.ArrayList;
import java.util.List;

/**
 * 测试专用的最小 JSONArray 替身。
 *
 * <p>和 {@link JSONObject} 一样，只为在桌面上真跑被测代码而存在；
 * 产品里跑的是 Android 自带实现。这里只支持字符串/对象元素和按序号取值。
 */
public class JSONArray {

  private final List<Object> list = new ArrayList<>();

  public JSONArray() {}

  public JSONArray(String text) {
    if (text == null || text.trim().isEmpty()) return;
    JSONObject.Parser p = new JSONObject.Parser(text);
    p.skipSpace();
    list.addAll(p.array());
  }

  public JSONArray put(Object value) {
    list.add(value == null ? JSONObject.NULL : value);
    return this;
  }

  public int length() { return list.size(); }

  public Object opt(int index) {
    return index >= 0 && index < list.size() ? list.get(index) : null;
  }

  /**
   * 与 Android 一致：取对象元素，取不到就返回 null。
   *
   * <p>DevAgent 的上下文裁剪要按序号遍历消息数组并区分
   * 「对象消息」和「普通消息」，没有这个方法就测不了。
   */
  public JSONObject optJSONObject(int index) {
    Object v = opt(index);
    return v instanceof JSONObject ? (JSONObject) v : null;
  }

  public Object get(int index) {
    if (index < 0 || index >= list.size()) throw new RuntimeException("index out of range");
    return list.get(index);
  }

  public JSONArray getJSONArray(int index) { return (JSONArray) get(index); }

  public String getString(int index) {
    Object v = opt(index);
    if (v == null || v == JSONObject.NULL) throw new IllegalArgumentException("这个位置没有值：" + index);
    return String.valueOf(v);
  }

  public JSONObject getJSONObject(int index) {
    Object v = opt(index);
    if (!(v instanceof JSONObject)) throw new IllegalArgumentException("这个位置不是对象：" + index);
    return (JSONObject) v;
  }

  @Override public String toString() {
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < list.size(); i++) {
      if (i > 0) sb.append(',');
      sb.append(JSONObject.value(list.get(i)));
    }
    return sb.append(']').toString();
  }
  /** 按位置删除元素，Android 的 JSONArray 有这个方法。 */
  public Object remove(int index) {
    if (index < 0 || index >= list.size()) return null;
    return list.remove(index);
  }
}
