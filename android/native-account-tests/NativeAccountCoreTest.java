package com.fitflow.app.accounts;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;

/** Synthetic host-only scenarios exercising the SAME production parser, protocol, policy and state.
 * No Android/OkHttp stubs, live endpoints, credentials, user data, installations or dependency fetches. */
public final class NativeAccountCoreTest {
    private static int scenarios;
    private static final String C1 = "11111111-1111-4111-8111-11111111111a";
    private static final String C2 = "22222222-2222-4222-8222-222222222222";
    private static final String RAW = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    private static class Time implements NativeAccountState.Clock {
        long wall = 1_800_000_000_000L, elapsed = 1000;
        public long wall() { return wall; } public long elapsed() { return elapsed; }
        void advance(long ms) { elapsed += ms; wall += ms; }
    }
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    private static void rejected(Runnable run) {
        try { run.run(); } catch (StrictJson.Rejected | NativeAccountProtocol.Failure expected) { return; }
        throw new AssertionError("accepted invalid synthetic input");
    }
    private static void failure(String code, Runnable run) {
        try { run.run(); } catch (NativeAccountProtocol.Failure e) { check(code.equals(e.code)); return; }
        throw new AssertionError("missing failure " + code);
    }
    private static void scenario(String name, Runnable run) { run.run(); scenarios++; System.out.println("PASS " + name); }
    private static Map<String,Object> map(Object... pairs) { return NativeAccountProtocol.map(pairs); }
    private static NativeAccountProtocol.Command command(String context, String method, String path) { return command(context, UUID.randomUUID().toString(), method, path, map()); }
    private static NativeAccountProtocol.Command command(String context, String requestId, String method, String path, Object body) {
        return NativeAccountProtocol.command(method.equals("GET") ? map("version", 1, "contextId", context, "requestId", requestId, "method", method, "path", path) : map("version", 1, "contextId", context, "requestId", requestId, "method", method, "path", path, "body", body));
    }
    private static Map<String,Object> session(Time time, String account) {
        return map("user", map("id", account, "email", "synthetic@example.invalid", "emailVerified", true, "createdAt", "2020-01-01T00:00:00.000Z"),
            "csrfToken", NativeAccountProtocol.csrfFor(RAW), "sessionExpiresAt", iso(time.wall + NativeAccountPolicy.ABSOLUTE_MS));
    }
    private static String iso(long millis) { return new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.ROOT) {{ setTimeZone(java.util.TimeZone.getTimeZone("UTC")); }}.format(new java.util.Date(millis)); }
    private static NativeAccountProtocol.Reviewed loginResult(NativeAccountProtocol.Command c, Time time, String account) { return NativeAccountProtocol.review(c, 200, map("session", session(time, account), "nativeToken", RAW), time.wall); }
    private static NativeAccountState.Ticket login(NativeAccountState s, Time time, String account) {
        NativeAccountProtocol.Command c = command(C1, "POST", "auth/login"); NativeAccountState.Ticket t = s.begin(c, time.elapsed);
        s.accept(t, loginResult(c, time, account)); check(s.live(t)); return t;
    }
    public static void main(String[] args) {
        scenario("strict JSON grammar, duplicate keys and surrogate handling", () -> {
            for (String value : Arrays.asList("{'x':1}", "{x:1}", "[1,]", "{\"x\":1,}", "[01]", "[+1]", "[.1]", "[1.]", "[1e]", "[NaN]", "[Infinity]", "[1e999]", "[-0]", "[-0.0]", "[-1e-999]", "{}{}", "/*x*/{}", "{\"x\":1,\"x\":2}", "\"\\ud800\"", "\"\\udc00\"", "\"\\u000g\"", "\"line\nline\"")) rejected(() -> StrictJson.parse(value, 8192));
            check(StrictJson.parse("{\"emoji\":\"\\ud83d\\ude00\",\"number\":1.25e2}",8192) instanceof Map);
            rejected(() -> StrictJson.parse(new byte[]{(byte)0xc0,(byte)0xaf},8192));
            rejected(() -> StrictJson.parse(new byte[]{(byte)0xef,(byte)0xbb,(byte)0xbf,'{','}'},8192));
            rejected(() -> StrictJson.utf8("\ud800",8192));
        });
        scenario("byte, depth and node preflight boundaries", () -> {
            check(StrictJson.parse("\"é\"",4).equals("é")); rejected(() -> StrictJson.parse("\"é\"",3));
            String valid = "0"; for (int i=0;i<32;i++) valid="["+valid+"]"; StrictJson.parse(valid,1000);
            final String deep="["+valid+"]"; rejected(() -> StrictJson.parse(deep,1000));
            StringBuilder many=new StringBuilder("["); for(int i=0;i<1_000_000;i++){if(i>0)many.append(',');many.append('0');}many.append(']');
            rejected(() -> StrictJson.parse(many.toString(),3_000_000));
        });
        scenario("canonical wire and local operations exact fields", () -> {
            Object valid = StrictJson.parseWire(StrictJson.stringify(map("version",1,"callId",C1,"operation","capabilities","payload",map("version",1))),8192);
            check(NativeAccountProtocol.wire(valid).operation.equals("capabilities"));
            rejected(() -> NativeAccountProtocol.wire(map("version",1,"callId",C1,"operation","capabilities","payload",map("version",1),"url","https://example.invalid")));
            rejected(() -> NativeAccountProtocol.wire(map("version",1,"callId",C1.toUpperCase(),"operation","fetch","payload",map("version",1))));
            rejected(() -> NativeAccountProtocol.capabilities(map("version",1,"endpoint","bad")));
            check(NativeAccountProtocol.context(map("version",1,"contextId",C1)).equals(C1));
            for(String id:Arrays.asList("00000000-0000-0000-0000-000000000000", "11111111-1111-6111-8111-111111111111", "11111111-1111-4111-7111-111111111111", C1+"x")) rejected(() -> NativeAccountProtocol.context(map("version",1,"contextId",id)));
        });
        scenario("source-only default-off endpoint and canonical binding", () -> {
            check(NativeAccountPolicy.endpoint()==null);
            String endpoint="https://accounts.example.invalid/api/native/v1";
            check(endpoint.equals(NativeAccountPolicy.validatedEndpoint(endpoint, Collections.singleton(endpoint))));
            check(NativeAccountPolicy.validatedEndpoint(endpoint,Collections.emptySet())==null);
            for(String bad:Arrays.asList("http://localhost/api/native/v1","https://ACCOUNTS.example.invalid/api/native/v1","https://accounts.example.invalid:443/api/native/v1","https://accounts.example.invalid:08443/api/native/v1",endpoint+"?",endpoint+"#",endpoint+"/","https://user@accounts.example.invalid/api/native/v1","https://accounts.example.invalid/a/../api/native/v1","https://accounts.example.invalid/api/native/%76%31")) check(NativeAccountPolicy.validatedEndpoint(bad,Collections.singleton(bad))==null);
            String nonDefault="https://accounts.example.invalid:8443/api/native/v1";
            check(nonDefault.equals(NativeAccountPolicy.validatedEndpoint(nonDefault,Collections.singleton(nonDefault))));
        });
        scenario("packaged document whitelist rejects alternate-byte URL aliases", () -> {
            for (String path : Arrays.asList("", "/", "/index.html", "/account", "/workouts/abc-123", "/plan", "/schedule", "/nutrition", "/progress", "/profile")) check(NativeAccountPolicy.packagedDocument("https://localhost" + path));
            for (String url : Arrays.asList("https://localhost/_capacitor_file_/private/evil.html", "https://localhost/_capacitor_content_/provider/evil", "https://localhost/_capacitor_http_interceptor_?u=x", "blob:https://localhost/id", "data:text/html,evil", "https://localhost/%61ccount", "https://localhost/account?x=1", "https://localhost/account#x", "https://localhost/account/", "https://localhost/assets/other.html", "https://localhost.evil.invalid/account", "https://localhost:443/account")) check(!NativeAccountPolicy.packagedDocument(url));
            check(NativeAccountPolicy.forbiddenResource("https://localhost/%5fcapacitor_file_/private/evil.html"));
            check(NativeAccountPolicy.forbiddenResource("https://localhost/_capacitor_content_/provider/evil"));
            check(!NativeAccountPolicy.forbiddenResource("https://localhost/assets/app.js"));
        });
        scenario("all positive operation/status pairs and business recipient preservation", () -> {
            String[][] routes={{"POST","auth/login","200"},{"GET","auth/session","200"},{"POST","auth/register","202"},{"POST","auth/logout","204"},{"POST","auth/verification/request","202"},{"POST","auth/password-reset/request","202"},{"POST","auth/verification/confirm","200"},{"POST","auth/password-reset/confirm","200"},{"GET","consent","200"},{"PUT","consent","200"},{"GET","sync","200"},{"PUT","sync","200"},{"POST","account/export","200"},{"DELETE","account","204"},{"GET","coaching","200"},{"POST","coaching/invitations","202"},{"POST","coaching/invitations/cancel","202"},{"POST","coaching/invitations/"+C1+"/accept","200"},{"DELETE","coaching/invitations/"+C1,"204"},{"PUT","coaching/relationships/"+C1+"/consent","200"},{"DELETE","coaching/relationships/"+C1,"200"},{"GET","coaching/relationships/"+C1+"/snapshot","200"},{"GET","coaching/relationships/"+C1+"/feedback","200"},{"POST","coaching/relationships/"+C1+"/feedback","201"},{"DELETE","coaching/relationships/"+C1+"/feedback/"+C2,"204"},{"GET","challenges","200"},{"POST","challenges/invitations","202"},{"POST","challenges/invitations/"+C1+"/accept","200"},{"DELETE","challenges/invitations/"+C1,"204"},{"PUT","challenges/"+C1+"/consent","200"},{"DELETE","challenges/"+C1,"200"},{"DELETE","challenges/"+C1+"/consent","200"},{"POST","challenges/"+C1+"/block","204"},{"GET","challenges/"+C1+"/counts","200"}};
            for(String[] r:routes){NativeAccountProtocol.Command c=command(C1,r[0],r[1]);check(c.accepts(Integer.parseInt(r[2])));check(!c.accepts(302));}
            check(command(C1,"POST","coaching/relationships/"+C1+"/feedback").accepts(200));
            Map<String,Object> b=map("recipient",map("id",C2,"email","reviewed@example.invalid"),"notes","Bearer cookie nativeToken are legitimate business words");
            check(command(C1,UUID.randomUUID().toString(),"PUT","challenges/"+C1+"/consent",b).body.equals(b));
            for(String path:Arrays.asList("/consent","consent?x=1","sync/","auth/login/extra","challenges/../account","https://example.invalid","challenges/"+C1.toUpperCase()+"/counts")) rejected(() -> command(C1,"GET",path));
            rejected(() -> command(C1,"PATCH","consent")); rejected(() -> command(C1,C2,"POST","auth/logout",null));
        });
        scenario("request, challenge, export, error and total-wire fixed budgets", () -> {
            StringBuilder b=new StringBuilder(); for(int i=0;i<8190;i++)b.append('a');
            rejected(() -> command(C1,C2,"POST","auth/register",map("value",b.toString())));
            check(command(C1,C2,"PUT","sync",map("value",b.toString())).requestLimit==NativeAccountPolicy.SNAPSHOT_BYTES);
            check(command(C1,"POST","account/export").responseLimit==64*1024*1024);
            check(command(C1,"GET","challenges").responseLimit==256*1024);
            StringBuilder large=new StringBuilder();for(int i=0;i<256*1024;i++)large.append('a');
            rejected(() -> NativeAccountProtocol.review(command(C1,"GET","challenges"),200,map("value",large.toString()),0));
            rejected(() -> NativeAccountProtocol.success(C1,map("value",b.toString()),1));
        });
        scenario("per-route wire byte preflight and reply envelope depth", () -> {
            StringBuilder big = new StringBuilder(); for (int i = 0; i < 9000; i++) big.append('x');
            Object body = map("value", big.toString());
            Object ordinary = map("version",1,"callId",C2,"operation","request","payload",map("version",1,"contextId",C1,"requestId",C2,"method","PUT","path","consent","body",body));
            rejected(() -> StrictJson.parseWire(StrictJson.stringify(ordinary),NativeAccountPolicy.SNAPSHOT_BYTES+1024));
            Object sync = map("payload",map("body",body,"path","sync","method","PUT","requestId",C2,"contextId",C1,"version",1),"operation","request","callId",C2,"version",1);
            check(StrictJson.parseWire(StrictJson.stringify(sync),NativeAccountPolicy.SNAPSHOT_BYTES+1024) instanceof Map);
            String nested="0";for(int i=0;i<31;i++)nested="["+nested+"]";
            Object deep=StrictJson.parse("{\"value\":"+nested+"}",8192);
            NativeAccountProtocol.Command c=command(C1,"GET","consent");
            NativeAccountProtocol.Reviewed result=NativeAccountProtocol.review(c,200,deep,0);
            rejected(() -> NativeAccountProtocol.success(C2,NativeAccountProtocol.portReply(c,result),c.responseLimit));
        });
        scenario("canonical timestamps including leap days and ISO year zero", () -> {
            check(NativeAccountProtocol.timestamp("0000-01-01T00:00:00.000Z")==-62167219200000L);
            check(NativeAccountProtocol.timestamp("2000-02-29T00:00:00.000Z")==951782400000L);
            for(String bad:Arrays.asList("1900-02-29T00:00:00.000Z","2026-02-30T00:00:00.000Z","2026-01-01T24:00:00.000Z","2026-01-01T00:00:60.000Z","2026-01-01T00:00:00Z","2026-01-01T00:00:00.000+00:00"))rejected(() -> NativeAccountProtocol.timestamp(bad));
        });
        scenario("login envelope extraction, CSRF binding and session validation", () -> {
            Time t=new Time(); NativeAccountProtocol.Command c=command(C1,"POST","auth/login");
            NativeAccountProtocol.Reviewed r=loginResult(c,t,"synthetic-account");
            String wire=NativeAccountProtocol.success(C2,NativeAccountProtocol.portReply(c,r),c.responseLimit);
            check(!wire.contains(RAW)&&!wire.contains("nativeToken")&&wire.contains("csrfToken"));
            rejected(() -> NativeAccountProtocol.review(c,200,session(t,"synthetic-account"),t.wall));
            rejected(() -> NativeAccountProtocol.review(c,200,map("session",session(t,"synthetic-account"),"nativeToken","bad"),t.wall));
            Map<String,Object> wrong=map("user",session(t,"a").get("user"),"csrfToken","wrong","sessionExpiresAt",session(t,"a").get("sessionExpiresAt"));
            rejected(() -> NativeAccountProtocol.review(c,200,map("session",wrong,"nativeToken",RAW),t.wall));
            rejected(() -> NativeAccountProtocol.session(session(t,"a"),t.wall+NativeAccountPolicy.ABSOLUTE_MS));
            rejected(() -> NativeAccountProtocol.session(session(t,"a"),t.wall-1));
        });
        scenario("successful bodies reject primitives and reserved credential envelopes", () -> {
            NativeAccountProtocol.Command c=command(C1,"GET","consent");
            for(Object body:Arrays.asList("token",null,true,1,Collections.emptyList(),map("NativeToken","secret"),map("headers",map()),map("cookie","secret")))rejected(() -> NativeAccountProtocol.review(c,200,body,0));
            check(NativeAccountProtocol.review(c,200,map("notes",map("nativeToken","business data")),0).body!=null);
            for(int status:new int[]{0,100,201,301,399,600})rejected(() -> NativeAccountProtocol.review(c,status,map(),0));
            rejected(() -> NativeAccountProtocol.review(command(C1,"POST","auth/logout"),204,map(),0));
        });
        scenario("remote errors retain only normalized status/code/revision", () -> {
            NativeAccountProtocol.Command c=command(C1,"PUT","sync");
            NativeAccountProtocol.Reviewed r=NativeAccountProtocol.review(c,409,map("error",map("code","sync_conflict","message","secret","details",map("revision",7,"secret","private")),"nativeToken",RAW),0);
            String wire=NativeAccountProtocol.success(C2,NativeAccountProtocol.portReply(c,r),1024);
            check(wire.contains("sync_conflict")&&wire.contains("revision")&&!wire.contains("secret")&&!wire.contains(RAW));
            check(StrictJson.stringify(NativeAccountProtocol.review(c,500,map("error",map("code","csrf_failed")),0).body).contains("service_error"));
            check(StrictJson.stringify(NativeAccountProtocol.review(c,403,map("error",map("code","csrf_failed")),0).body).contains("csrf_failed"));
        });
        scenario("context replacement, old clear, closed-context replay and bounded context ledger", () -> {
            Time t=new Time(); NativeAccountState s=new NativeAccountState(t,2);s.start(C1);s.start(C2);s.clear(C1);check(s.context().equals(C2));s.clear(C2);check(s.context()==null);
            failure("invalid_request",()->s.start(C1));failure("context_exhausted",()->s.start(UUID.randomUUID().toString()));
            failure("cancelled",()->s.begin(command(C2,"POST","auth/login"),t.elapsed));
        });
        scenario("in-flight limit and non-evicting request ledger including busy failures", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t,8);s.start(C1);
            NativeAccountProtocol.Command c=command(C1,"POST","auth/verification/request");NativeAccountState.Ticket a=s.begin(c,t.elapsed);
            s.begin(command(C1,"POST","auth/password-reset/request"),t.elapsed);
            NativeAccountProtocol.Command busy=command(C1,"POST","auth/verification/request");failure("busy",()->s.begin(busy,t.elapsed));
            s.finish(a);failure("invalid_request",()->s.begin(c,t.elapsed));failure("invalid_request",()->s.begin(busy,t.elapsed));
        });
        scenario("request ledger exhaustion clears credentials and pending work", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t,2);s.start(C1);s.finish(login(s,t,"a"));
            NativeAccountState.Ticket read=s.begin(command(C1,"GET","consent"),t.elapsed);
            failure("context_exhausted",()->s.begin(command(C1,"GET","sync"),t.elapsed));check(!s.current(read)&&s.account()==null&&s.context()==null);
        });
        scenario("clear/background fences delayed login and terminal response replay", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t);s.start(C1);
            NativeAccountProtocol.Command c=command(C1,"POST","auth/login");NativeAccountState.Ticket ticket=s.begin(c,t.elapsed);boolean[] cancelled={false};s.attachCancel(ticket,()->cancelled[0]=true);
            s.clearAll();check(cancelled[0]);failure("cancelled",()->s.accept(ticket,loginResult(c,t,"a")));check(s.account()==null);
            s.start(C2);check(!s.finish(ticket));
        });
        scenario("same-account reauthentication rotates generation and fences old private replies", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t);s.start(C1);s.finish(login(s,t,"a"));long gen=s.generation();
            NativeAccountState.Ticket old=s.begin(command(C1,"GET","sync"),t.elapsed);
            NativeAccountState.Ticket fresh=login(s,t,"a");check(s.generation()>gen&&!s.current(old)&&s.live(fresh));check(s.finish(fresh)&&!s.finish(fresh));
        });
        scenario("late logout cannot clear newer login, local clear is not logout success", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t);s.start(C1);s.finish(login(s,t,"a"));
            NativeAccountProtocol.Command logout=command(C1,"POST","auth/logout");NativeAccountState.Ticket old=s.begin(logout,t.elapsed);check(s.account()==null);
            s.finish(login(s,t,"b"));failure("cancelled",()->s.accept(old,NativeAccountProtocol.review(logout,204,null,t.wall)));check(s.account().equals("b"));
        });
        scenario("absolute expiry uses monotonic time and session reads never extend it", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t);s.start(C1);Map<String,Object> initial=session(t,"a");s.finish(login(s,t,"a"));
            for(int i=0;i<17;i++){t.advance(28*60*1000L);NativeAccountProtocol.Command c=command(C1,"GET","auth/session");NativeAccountState.Ticket read=s.begin(c,t.elapsed);s.accept(read,NativeAccountProtocol.review(c,200,initial,t.wall));s.finish(read);}
            t.wall-=4*60*60*1000L;t.elapsed+=5*60*1000L;s.sweep();check(s.account()==null);
        });
        scenario("idle deadline and independent server wall expiry", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t);s.start(C1);s.finish(login(s,t,"a"));t.advance(NativeAccountPolicy.IDLE_MS);s.sweep();check(s.account()==null);
            Time t2=new Time();NativeAccountState s2=new NativeAccountState(t2);s2.start(C1);s2.finish(login(s2,t2,"a"));t2.wall+=NativeAccountPolicy.ABSOLUTE_MS;s2.sweep();check(s2.account()==null);
        });
        scenario("timeout fences asynchronous results without extending the deadline", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t);s.start(C1);NativeAccountProtocol.Command c=command(C1,"POST","auth/login");NativeAccountState.Ticket late=s.begin(c,t.elapsed);
            t.advance(NativeAccountPolicy.TIMEOUT_MS);failure("expired",()->s.accept(late,loginResult(c,t,"a")));s.timeout(late);check(!s.current(late)&&s.account()==null);
        });
        scenario("malformed auth, account mismatch, unauthorized and CSRF clear natively", () -> {
            Time t=new Time();NativeAccountState s=new NativeAccountState(t);s.start(C1);s.finish(login(s,t,"a"));
            NativeAccountProtocol.Command c=command(C1,"GET","auth/session");NativeAccountState.Ticket read=s.begin(c,t.elapsed);
            failure("invalid_response",()->s.accept(read,NativeAccountProtocol.review(c,200,session(t,"b"),t.wall)));check(s.account()==null);s.finish(read);
            s.finish(login(s,t,"a"));NativeAccountProtocol.Command p=command(C1,"GET","consent");NativeAccountState.Ticket denied=s.begin(p,t.elapsed);s.accept(denied,NativeAccountProtocol.review(p,401,null,t.wall));check(s.account()==null);s.finish(denied);
            s.finish(login(s,t,"a"));NativeAccountProtocol.Command p2=command(C1,"GET","consent");NativeAccountState.Ticket csrf=s.begin(p2,t.elapsed);s.accept(csrf,NativeAccountProtocol.review(p2,403,map("error",map("code","csrf_failed")),t.wall));check(s.account()==null);s.finish(csrf);
            s.finish(login(s,t,"a"));NativeAccountState.Ticket malformed=s.begin(command(C1,"GET","auth/session"),t.elapsed);s.malformed(malformed);check(s.account()==null);
        });
        System.out.println("PASS "+scenarios+" synthetic host scenarios; Android/OkHttp/device build not run");
    }
}
