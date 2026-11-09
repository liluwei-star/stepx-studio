package cn.com.scsxrkj;

/**
 * 从一段文本里定位 JSON 的小工具。
 *
 * <p>模型返回的内容经常是「一段说明 + 一段 JSON」混在一起，要拆开得先找到
 * JSON 的起止位置。这类扫描是纯字符串操作，和网络、Activity、UI 都没有关系。
 *
 * <p><b>为什么单独成一个类：</b>原来这两个方法长在 {@code DevAgent} 里，
 * 而 {@code DevAgent} 依赖 {@code MainActivity} —— 于是 {@code ProjectEdits}
 * 想用一下这两个函数，也得把整个 Activity 拖进来，单元测试根本编不出来。
 * 抽出来之后两边共用同一份实现，也不会出现「两个地方各写一套、行为悄悄不一致」。
 */
final class JsonScan {

    private JsonScan() {}

    /**
     * 找到第一个 {@code {} 或 {@code [} 的下标。
     *
     * @param s 待扫描文本
     * @return 下标；找不到返回 -1
     */
    static int indexOfJsonStart(String s) {
        if (s == null) return -1;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '{' || c == '[') return i;
        }
        return -1;
    }

    /**
     * 从 {@code from} 处开始，按括号配对算出 JSON 结构的结束下标。
     *
     * <p>要跳过字符串里的括号 —— JSON 里可以写 {@code {"text":"有个 } 符号"}}，
     * 不跳过的话会数错配对，提前截断成半个 JSON。也要处理转义引号。
     *
     * @param s    待扫描文本
     * @param from 起始下标（应当是 {@link #indexOfJsonStart} 的结果）
     * @return 配平的那个下标；配不平返回 -1
     */
    static int endOfJsonObject(String s, int from) {
        if (s == null || from < 0 || from >= s.length()) return -1;
        char first = s.charAt(from);
        if (first != '{' && first != '[') return -1;
        boolean inString = false, escaped = false;
        /*
         * 用栈记录还没闭合的括号，而不是只数深度。
         *
         * <p>只数深度的话，{ 和 ] 一样能让深度减一 —— 于是 {"a":1]} 这种
         * 括号类型写串的片段会被当成「在 ] 处配平」，截出一个非法 JSON 的半个字符串，
         * 上层解析必然失败。用栈则能立刻发现「该 ] 却来了 }」，直接判成配不平，
         * 交给调用方按「没有 JSON」处理（继续找、或走重试），
         * 而不是拿一段注定解析不了的文本去撞解析器。
         *
         * <p>另一个好处是：配平位置只认栈真正空掉的那一刻，
         * 不会因为某个多余的右括号把深度数错而提前收工。
         */
        java.util.ArrayDeque<Character> stack = new java.util.ArrayDeque<>();
        for (int i = from; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inString) {
                if (escaped) { escaped = false; continue; }
                if (c == '\\') { escaped = true; continue; }
                if (c == '"') inString = false;
                continue;
            }
            if (c == '"') { inString = true; continue; }
            if (c == '{' || c == '[') { stack.push(c); continue; }
            if (c == '}' || c == ']') {
                char want = c == '}' ? '{' : '[';
                if (stack.isEmpty() || stack.peek() != want) return -1;
                stack.pop();
                if (stack.isEmpty()) return i;
            }
        }
        return -1;
    }
}
