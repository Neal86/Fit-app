package com.fitflow.app.accounts;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Two passes: validate UTF-8, complete JSON grammar/depth/node budgets, THEN construct containers.
 * No platform JSON coercion, duplicate-key overwrite, trailing input, nonfinite/negative-zero numbers,
 * lone surrogates, extension syntax, file access, or application callbacks. */
public final class StrictJson {
    private StrictJson() {}
    public static final class Rejected extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public Rejected() { super("invalid_json", null, false, false); }
    }
    static Rejected bad() { return new Rejected(); }
    public static byte[] utf8(String value, int limit) {
        if (value == null || value.length() > limit) throw bad();
        try {
            ByteBuffer bytes = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(value));
            if (bytes.remaining() > limit) throw bad();
            byte[] result = new byte[bytes.remaining()]; bytes.get(result); return result;
        } catch (CharacterCodingException ignored) { throw bad(); }
    }
    public static Object parse(byte[] bytes, int limit) {
        if (bytes == null || bytes.length > limit) throw bad();
        final String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException ignored) { throw bad(); }
        new Reader(text, false, NativeAccountPolicy.DEPTH, NativeAccountPolicy.NODES).document();
        return new Reader(text, true, NativeAccountPolicy.DEPTH, NativeAccountPolicy.NODES).document();
    }
    public static Object parse(String text, int limit) { return parse(utf8(text, limit), limit); }
    public static Object parseWire(String text, int limit) {
        byte[] bytes = utf8(text, limit);
        Reader preflight = new Reader(text, false, NativeAccountPolicy.DEPTH + 1, NativeAccountPolicy.NODES + 4);
        preflight.wireBudget = true;
        preflight.document();
        int bodyLimit = "request".equals(preflight.wireOperation) && "PUT".equals(preflight.wireMethod) && "sync".equals(preflight.wirePath)
            ? NativeAccountPolicy.SNAPSHOT_BYTES : NativeAccountPolicy.REQUEST_BYTES;
        if (bytes.length > bodyLimit + 1024) throw bad();
        if (preflight.bodyStart >= 0) utf8(text.substring(preflight.bodyStart, preflight.bodyEnd), bodyLimit);
        if (!"request".equals(preflight.wireOperation) && preflight.payloadStart >= 0)
            utf8(text.substring(preflight.payloadStart, preflight.payloadEnd), "capabilities".equals(preflight.wireOperation) ? 64 : 128);
        return new Reader(text, true, NativeAccountPolicy.DEPTH + 1, NativeAccountPolicy.NODES + 4).document();
    }
    public static void validatePortValue(Object value, int limit) {
        String text = stringify(value); utf8(text, limit);
        new Reader(text, false, NativeAccountPolicy.DEPTH, NativeAccountPolicy.NODES).document();
    }
    public static String stringify(Object value) {
        StringBuilder out = new StringBuilder(); write(value, out); return out.toString();
    }
    public static int bytes(Object value) { return utf8(stringify(value), NativeAccountPolicy.EXPORT_BYTES + 2048).length; }
    private static void write(Object v, StringBuilder out) {
        if (v == null) { out.append("null"); return; }
        if (v instanceof Boolean || v instanceof Number) { out.append(v); return; }
        if (v instanceof String) { quote((String) v, out); return; }
        if (v instanceof Map) {
            out.append('{'); boolean comma = false;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (comma) out.append(','); comma = true;
                quote((String)e.getKey(), out); out.append(':'); write(e.getValue(), out);
            }
            out.append('}'); return;
        }
        if (v instanceof List) {
            out.append('['); boolean comma = false;
            for (Object item : (List<?>)v) { if (comma) out.append(','); comma = true; write(item, out); }
            out.append(']'); return;
        }
        throw bad();
    }
    private static void quote(String s, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break; case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break; case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break; case '\r': out.append("\\r"); break; case '\t': out.append("\\t"); break;
                default: if (c < 32) { out.append("\\u00"); out.append("0123456789abcdef".charAt(c >> 4)); out.append("0123456789abcdef".charAt(c & 15)); }
                    else out.append(c);
            }
        }
        out.append('"');
    }
    private static final class Reader {
        final String s; final boolean build; final int maxDepth, maxNodes; int at; int nodes;
        boolean wireBudget, inPayload, captureString;
        String wireOperation, wireMethod, wirePath;
        int payloadStart = -1, payloadEnd, bodyStart = -1, bodyEnd;
        Reader(String s, boolean build, int maxDepth, int maxNodes) { this.s = s; this.build = build; this.maxDepth = maxDepth; this.maxNodes = maxNodes; }
        Object document() { Object v = value(0); space(); if (at != s.length()) throw bad(); return v; }
        void space() { while (at < s.length() && (s.charAt(at) == ' ' || s.charAt(at) == '\t' || s.charAt(at) == '\n' || s.charAt(at) == '\r')) at++; }
        char take() { if (at >= s.length()) throw bad(); return s.charAt(at++); }
        boolean eat(char c) { space(); if (at < s.length() && s.charAt(at) == c) { at++; return true; } return false; }
        Object value(int depth) {
            if (depth > maxDepth || ++nodes > maxNodes) throw bad();
            space(); if (at == s.length()) throw bad(); char c = s.charAt(at);
            if (c == '"') return string();
            if (c == '{') {
                at++; Map<String,Object> result = build ? new LinkedHashMap<>() : null;
                if (!eat('}')) {
                    do {
                        space(); if (at == s.length() || s.charAt(at) != '"') throw bad();
                        String key = string(build || wireBudget); if (!eat(':')) throw bad();
                        boolean rootPayload = wireBudget && depth == 0 && "payload".equals(key);
                        boolean body = wireBudget && inPayload && depth == 1 && "body".equals(key);
                        boolean oldPayload = inPayload, oldCapture = captureString;
                        if (rootPayload) { inPayload = true; payloadStart = at; }
                        if (body) bodyStart = at;
                        captureString = wireBudget && (depth == 0 && "operation".equals(key) || inPayload && depth == 1 && ("method".equals(key) || "path".equals(key)));
                        Object v = value(depth + 1);
                        if (wireBudget && v instanceof String) {
                            if (depth == 0 && "operation".equals(key)) wireOperation = (String)v;
                            if (inPayload && depth == 1 && "method".equals(key)) wireMethod = (String)v;
                            if (inPayload && depth == 1 && "path".equals(key)) wirePath = (String)v;
                        }
                        if (rootPayload) payloadEnd = at;
                        if (body) bodyEnd = at;
                        inPayload = oldPayload; captureString = oldCapture;
                        if (build) { if (result.containsKey(key)) throw bad(); result.put(key, v); }
                    } while (eat(','));
                    if (!eat('}')) throw bad();
                }
                return build ? Collections.unmodifiableMap(result) : null;
            }
            if (c == '[') {
                at++; List<Object> result = build ? new ArrayList<>() : null;
                if (!eat(']')) {
                    do { Object v = value(depth + 1); if (build) result.add(v); } while (eat(','));
                    if (!eat(']')) throw bad();
                }
                return build ? Collections.unmodifiableList(result) : null;
            }
            if (c == 't') { literal("true"); return Boolean.TRUE; }
            if (c == 'f') { literal("false"); return Boolean.FALSE; }
            if (c == 'n') { literal("null"); return null; }
            int start = at; if (c == '-') at++;
            char first = take();
            if (first == '0') { if (at < s.length() && digit(s.charAt(at))) throw bad(); }
            else { if (first < '1' || first > '9') throw bad(); while (at < s.length() && digit(s.charAt(at))) at++; }
            if (at < s.length() && s.charAt(at) == '.') { at++; int p = at; while (at < s.length() && digit(s.charAt(at))) at++; if (p == at) throw bad(); }
            if (at < s.length() && (s.charAt(at) == 'e' || s.charAt(at) == 'E')) {
                at++; if (at < s.length() && (s.charAt(at) == '+' || s.charAt(at) == '-')) at++;
                int p = at; while (at < s.length() && digit(s.charAt(at))) at++; if (p == at) throw bad();
            }
            try {
                double v = Double.parseDouble(s.substring(start, at));
                if (!Double.isFinite(v) || Double.doubleToRawLongBits(v) == Long.MIN_VALUE) throw bad();
                if (!build) return null;
                if (v == Math.rint(v) && Math.abs(v) <= 9_007_199_254_740_991d) return Long.valueOf((long)v);
                return Double.valueOf(v);
            } catch (NumberFormatException ignored) { throw bad(); }
        }
        void literal(String v) { if (!s.startsWith(v, at)) throw bad(); at += v.length(); }
        static boolean digit(char c) { return c >= '0' && c <= '9'; }
        String string() { return string(build || captureString); }
        String string(boolean collect) {
            if (take() != '"') throw bad(); StringBuilder out = collect ? new StringBuilder() : null;
            boolean high = false;
            while (true) {
                char c = take(); if (c == '"') { if (high) throw bad(); return collect ? out.toString() : null; }
                if (c < 32) throw bad();
                if (c == '\\') {
                    c = take();
                    switch (c) {
                        case '"': case '\\': case '/': break;
                        case 'b': c = '\b'; break; case 'f': c = '\f'; break; case 'n': c = '\n'; break;
                        case 'r': c = '\r'; break; case 't': c = '\t'; break;
                        case 'u': int n = 0; for (int i = 0; i < 4; i++) { char h = take(); int d = h >= '0' && h <= '9' ? h - '0' : h >= 'a' && h <= 'f' ? h - 'a' + 10 : h >= 'A' && h <= 'F' ? h - 'A' + 10 : -1; if (d < 0) throw bad(); n = n * 16 + d; } c = (char)n; break;
                        default: throw bad();
                    }
                }
                if (high) { if (!Character.isLowSurrogate(c)) throw bad(); high = false; }
                else if (Character.isHighSurrogate(c)) high = true;
                else if (Character.isLowSurrogate(c)) throw bad();
                if (collect) out.append(c);
            }
        }
    }
}
