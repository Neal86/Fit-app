package com.fitflow.app.accounts;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;
import java.util.TimeZone;
import java.util.regex.Pattern;

/** Dependency-free positive protocol. All inputs have already passed StrictJson preflight. */
public final class NativeAccountProtocol {
    private NativeAccountProtocol() {}
    public static final String ID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private static final Pattern UUID = Pattern.compile(ID);
    private static final Set<String> RESERVED = new HashSet<>(Arrays.asList("nativetoken", "token", "accesstoken", "refreshtoken", "bearer", "authorization", "cookie", "cookies", "set-cookie", "headers", "credential", "credentials", "password"));
    public static final Set<String> LOCAL_ERRORS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList("unavailable", "invalid_request", "invalid_response", "cancelled", "expired", "network_error", "busy", "context_exhausted")));
    public static final class Failure extends RuntimeException {
        private static final long serialVersionUID = 1L;
        public final String code;
        public Failure(String code) { super(LOCAL_ERRORS.contains(code) ? code : "invalid_response", null, false, false); this.code = getMessage(); }
    }
    public static Failure badRequest() { return new Failure("invalid_request"); }
    public static Failure badResponse() { return new Failure("invalid_response"); }
    public static boolean uuid(Object value) { return value instanceof String && UUID.matcher((String)value).matches(); }
    @SuppressWarnings("unchecked")
    public static Map<String,Object> object(Object value) {
        if (!(value instanceof Map)) throw badRequest(); return (Map<String,Object>)value;
    }
    static void fields(Map<String,Object> v, String... names) {
        if (v.size() != names.length || !v.keySet().containsAll(Arrays.asList(names))) throw badRequest();
    }
    static boolean version(Object value) { return value instanceof Number && ((Number)value).doubleValue() == 1; }
    public static Map<String,Object> map(Object... pairs) {
        Map<String,Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String)pairs[i], pairs[i + 1]);
        return Collections.unmodifiableMap(map);
    }
    public static final class Wire {
        public final String callId, operation; public final Map<String,Object> payload;
        Wire(String id, String operation, Map<String,Object> payload) { callId = id; this.operation = operation; this.payload = payload; }
    }
    public static Wire wire(Object value) {
        Map<String,Object> v = object(value); fields(v, "version", "callId", "operation", "payload");
        if (!version(v.get("version")) || !uuid(v.get("callId")) || !(v.get("operation") instanceof String)) throw badRequest();
        String op = (String)v.get("operation");
        if (!Arrays.asList("capabilities", "startContext", "clearContext", "request").contains(op)) throw badRequest();
        return new Wire((String)v.get("callId"), op, object(v.get("payload")));
    }
    public static void capabilities(Map<String,Object> v) { fields(v, "version"); if (!version(v.get("version"))) throw badRequest(); }
    public static String context(Map<String,Object> v) {
        fields(v, "version", "contextId"); if (!version(v.get("version")) || !uuid(v.get("contextId"))) throw badRequest();
        return (String)v.get("contextId");
    }
    public static final class Command {
        public final String contextId, requestId, method, path;
        public final Map<String,Object> body;
        public final int success, requestLimit, responseLimit;
        public final boolean feedbackReplay, publicAuth, barrier, terminalAccount;
        Command(String contextId, String requestId, String method, String path, Map<String,Object> body, int status) {
            this.contextId = contextId; this.requestId = requestId; this.method = method; this.path = path; this.body = body; success = status;
            requestLimit = "PUT".equals(method) && "sync".equals(path) ? NativeAccountPolicy.SNAPSHOT_BYTES : NativeAccountPolicy.REQUEST_BYTES;
            responseLimit = path.equals("account/export") ? NativeAccountPolicy.EXPORT_BYTES : path.startsWith("challenges") ? NativeAccountPolicy.CHALLENGE_BYTES : NativeAccountPolicy.RESPONSE_BYTES;
            feedbackReplay = method.equals("POST") && path.matches("coaching/relationships/" + ID + "/feedback");
            publicAuth = path.startsWith("auth/") && !path.equals("auth/session") && !path.equals("auth/logout");
            terminalAccount = path.equals("auth/logout") || path.equals("account");
            barrier = path.equals("auth/login") || path.equals("auth/register") || path.equals("auth/verification/confirm") || path.equals("auth/password-reset/confirm") || terminalAccount;
        }
        public boolean accepts(int status) { return status == success || feedbackReplay && status == 200; }
        public boolean login() { return path.equals("auth/login"); }
        public boolean session() { return path.equals("auth/session"); }
    }
    public static Command command(Map<String,Object> v) {
        String method = v.get("method") instanceof String ? (String)v.get("method") : "";
        if (method.equals("GET")) fields(v, "version", "contextId", "requestId", "method", "path");
        else fields(v, "version", "contextId", "requestId", "method", "path", "body");
        if (!version(v.get("version")) || !uuid(v.get("contextId")) || !uuid(v.get("requestId")) || !(v.get("path") instanceof String)) throw badRequest();
        String path = (String)v.get("path"); if (path.length() > 512 || !path.matches("[A-Za-z0-9/_-]+")) throw badRequest();
        int status = operation(method, path);
        Map<String,Object> body = method.equals("GET") ? null : object(v.get("body"));
        Command result = new Command((String)v.get("contextId"), (String)v.get("requestId"), method, path, body, status);
        StrictJson.validatePortValue(v, result.requestLimit + 1024);
        if (body != null && StrictJson.bytes(body) > result.requestLimit) throw badRequest();
        return result;
    }
    static int operation(String m, String p) {
        if (m.equals("POST")) {
            if (p.matches("auth/(login|verification/confirm|password-reset/confirm)")) return 200;
            if (p.matches("auth/(register|verification/request|password-reset/request)")) return 202;
            if (p.equals("auth/logout")) return 204;
            if (p.equals("account/export")) return 200;
            if (p.matches("coaching/invitations(/cancel)?") || p.equals("challenges/invitations")) return 202;
            if (p.matches("(coaching|challenges)/invitations/" + ID + "/accept")) return 200;
            if (p.matches("coaching/relationships/" + ID + "/feedback")) return 201;
            if (p.matches("challenges/" + ID + "/block")) return 204;
        } else if (m.equals("GET")) {
            if (p.matches("auth/session|consent|sync|coaching|challenges") || p.matches("coaching/relationships/" + ID + "/(snapshot|feedback)") || p.matches("challenges/" + ID + "/counts")) return 200;
        } else if (m.equals("PUT")) {
            if (p.matches("consent|sync") || p.matches("coaching/relationships/" + ID + "/consent") || p.matches("challenges/" + ID + "/consent")) return 200;
        } else if (m.equals("DELETE")) {
            if (p.equals("account") || p.matches("(coaching|challenges)/invitations/" + ID) || p.matches("coaching/relationships/" + ID + "/feedback/" + ID)) return 204;
            if (p.matches("coaching/relationships/" + ID) || p.matches("challenges/" + ID + "(/consent)?")) return 200;
        }
        throw badRequest();
    }
    private static boolean text(Object value) {
        if (!(value instanceof String) || ((String)value).isEmpty() || ((String)value).length() > 512) return false;
        for (char c : ((String)value).toCharArray()) if (c < 32 || c == 127) return false;
        return true;
    }
    public static long timestamp(Object value) {
        if (!(value instanceof String) || !((String)value).matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")) throw badResponse();
        String v = (String)value;
        int year = Integer.parseInt(v.substring(0, 4)), month = Integer.parseInt(v.substring(5, 7));
        int day = Integer.parseInt(v.substring(8, 10)), hour = Integer.parseInt(v.substring(11, 13));
        int minute = Integer.parseInt(v.substring(14, 16)), second = Integer.parseInt(v.substring(17, 19));
        int millis = Integer.parseInt(v.substring(20, 23));
        if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) throw badResponse();
        int[] days = {31, (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28, 31,30,31,30,31,31,30,31,30,31};
        if (day > days[month - 1]) throw badResponse();
        // Proleptic Gregorian, including ISO year 0000 (Gregorian 1 BCE), matches JS Date.
        java.util.GregorianCalendar calendar = new java.util.GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.ROOT);
        calendar.setGregorianChange(new Date(Long.MIN_VALUE)); calendar.clear(); calendar.setLenient(false);
        calendar.set(java.util.Calendar.ERA, year == 0 ? java.util.GregorianCalendar.BC : java.util.GregorianCalendar.AD);
        calendar.set(java.util.Calendar.YEAR, year == 0 ? 1 : year);
        calendar.set(java.util.Calendar.MONTH, month - 1); calendar.set(java.util.Calendar.DAY_OF_MONTH, day);
        calendar.set(java.util.Calendar.HOUR_OF_DAY, hour); calendar.set(java.util.Calendar.MINUTE, minute);
        calendar.set(java.util.Calendar.SECOND, second); calendar.set(java.util.Calendar.MILLISECOND, millis);
        try { return calendar.getTimeInMillis(); } catch (RuntimeException ignored) { throw badResponse(); }
    }

    public static final class Session {
        public final Map<String,Object> value; public final String account, csrf; public final long expires;
        Session(Map<String,Object> value, String account, String csrf, long expires) { this.value = value; this.account = account; this.csrf = csrf; this.expires = expires; }
    }
    public static Session session(Object input, long now) {
        try {
            Map<String,Object> v = object(input); fields(v, "user", "csrfToken", "sessionExpiresAt");
            Map<String,Object> u = object(v.get("user")); fields(u, "id", "email", "emailVerified", "createdAt");
            if (!text(u.get("id")) || !text(u.get("email")) || !((String)u.get("email")).contains("@") || !(u.get("emailVerified") instanceof Boolean) || !text(v.get("csrfToken")) || StrictJson.bytes(v) > NativeAccountPolicy.REQUEST_BYTES) throw badResponse();
            timestamp(u.get("createdAt")); long expires = timestamp(v.get("sessionExpiresAt"));
            if (expires <= now || expires - now > NativeAccountPolicy.ABSOLUTE_MS) throw badResponse();
            return new Session(v, (String)u.get("id"), (String)v.get("csrfToken"), expires);
        } catch (RuntimeException ignored) { throw badResponse(); }
    }
    public static String csrfFor(String raw) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(("fitflow-csrf-v1:" + raw).getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(64);
            for (byte b : bytes) { out.append("0123456789abcdef".charAt((b & 255) >> 4)); out.append("0123456789abcdef".charAt(b & 15)); }
            return out.toString();
        } catch (Exception ignored) { throw badResponse(); }
    }
    public static final class Reviewed {
        public final int status; public final Map<String,Object> body; public final Session session;
        // This raw credential is consumed only by NativeAccountState.install; never serialized.
        final String nativeToken;
        Reviewed(int status, Map<String,Object> body, Session session, String token) { this.status = status; this.body = body; this.session = session; nativeToken = token; }
    }
    public static Reviewed review(Command c, int status, Object input, long now) {
        try {
            if (status >= 400 && status <= 599) return new Reviewed(status, normalizedError(input, status), null, null);
            if (!c.accepts(status)) throw badResponse();
            if (status == 204) { if (input != null) throw badResponse(); return new Reviewed(status, null, null, null); }
            Map<String,Object> body = object(input); Session session = null; String raw = null;
            if (c.login()) {
                fields(body, "session", "nativeToken"); Object token = body.get("nativeToken");
                if (!(token instanceof String) || !((String)token).matches("[A-Za-z0-9_-]{43}")) throw badResponse();
                raw = (String)token; session = session(body.get("session"), now);
                if (!MessageDigest.isEqual(csrfFor(raw).getBytes(StandardCharsets.US_ASCII), session.csrf.getBytes(StandardCharsets.US_ASCII))) throw badResponse();
                body = session.value;
            } else if (c.session()) session = session(body, now);
            for (String key : body.keySet()) if (RESERVED.contains(key.toLowerCase(Locale.ROOT))) throw badResponse();
            if (StrictJson.bytes(body) > c.responseLimit) throw badResponse();
            return new Reviewed(status, body, session, raw);
        } catch (RuntimeException ignored) { throw badResponse(); }
    }
    private static Map<String,Object> normalizedError(Object input, int status) {
        String code = "service_error"; Map<String,Object> details = null;
        if (input instanceof Map) {
            Object error = ((Map<?,?>)input).get("error");
            if (error instanceof Map) {
                Object upstream = ((Map<?,?>)error).get("code");
                if (status == 403 && "csrf_failed".equals(upstream)) code = "csrf_failed";
                else if (status == 409 && "sync_conflict".equals(upstream)) {
                    code = "sync_conflict"; Object d = ((Map<?,?>)error).get("details");
                    Object revision = d instanceof Map ? ((Map<?,?>)d).get("revision") : null;
                    if (revision instanceof Number) {
                        double n = ((Number)revision).doubleValue();
                        if (Double.isFinite(n) && n >= 0 && n == Math.rint(n) && n <= 9_007_199_254_740_991d) details = map("revision", (long)n);
                    }
                }
            }
        }
        return map("error", details == null ? map("code", code) : map("code", code, "details", details));
    }
    public static Map<String,Object> portReply(Command c, Reviewed result) {
        return result.body == null ? map("version", 1, "contextId", c.contextId, "requestId", c.requestId, "status", result.status) :
            map("version", 1, "contextId", c.contextId, "requestId", c.requestId, "status", result.status, "body", result.body);
    }
    public static String success(String callId, Object value, int bodyLimit) {
        StrictJson.validatePortValue(value, bodyLimit + 1024);
        String wire = StrictJson.stringify(map("version", 1, "callId", callId, "ok", true, "value", value));
        StrictJson.utf8(wire, bodyLimit + 1024); return wire;
    }
    public static String failure(String callId, String code) {
        return StrictJson.stringify(map("version", 1, "callId", callId, "ok", false, "error", LOCAL_ERRORS.contains(code) ? code : "invalid_response"));
    }
}
