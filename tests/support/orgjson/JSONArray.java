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
}
