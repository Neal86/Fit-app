package com.fitflow.app.accounts;

import java.util.Map;
import java.util.UUID;

/** Independent synthetic review scenarios against the real dependency-free production core. */
public final class IndependentReviewTest {
    private static final String CONTEXT = "00000001-a192-42bf-8c12-b75575810302";
    private static final String REQUEST = "00000002-a192-42bf-8c12-b75575810302";
    private static final String TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    private static int scenarios;

    private static final class Clock implements NativeAccountState.Clock {
        long wall = 1_800_000_000_000L, elapsed = 1000;
        public long wall() { return wall; }
        public long elapsed() { return elapsed; }
    }
    private static Map<String,Object> map(Object... pairs) { return NativeAccountProtocol.map(pairs); }
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    private static void scenario(String name, Runnable run) {
        run.run(); scenarios++; System.out.println("PASS independent " + name);
    }
    private static NativeAccountProtocol.Command command(String path, String method) {
        return NativeAccountProtocol.command(method.equals("GET")
            ? map("version", 1, "contextId", CONTEXT, "requestId", UUID.randomUUID().toString(), "method", method, "path", path)
            : map("version", 1, "contextId", CONTEXT, "requestId", UUID.randomUUID().toString(), "method", method, "path", path, "body", map()));
    }
    private static NativeAccountProtocol.Reviewed loginResult(NativeAccountProtocol.Command command, Clock clock) {
        String expiry = java.time.Instant.ofEpochMilli(clock.wall + NativeAccountPolicy.ABSOLUTE_MS).toString().replace("Z", ".000Z");
        return NativeAccountProtocol.review(command, 200, map("session", map(
            "user", map("id", "account-a", "email", "a@example.test", "emailVerified", true, "createdAt", "2020-01-01T00:00:00.000Z"),
            "csrfToken", NativeAccountProtocol.csrfFor(TOKEN), "sessionExpiresAt", expiry), "nativeToken", TOKEN), clock.wall);
    }
    private static void login(NativeAccountState state, Clock clock) {
        NativeAccountProtocol.Command command = command("auth/login", "POST");
        NativeAccountState.Ticket ticket = state.begin(command, clock.elapsed);
        state.accept(ticket, loginResult(command, clock)); check(state.finish(ticket));
    }
    private static NativeAccountState fixture(Clock clock) {
        NativeAccountState state = new NativeAccountState(clock); state.start(CONTEXT); login(state, clock); return state;
    }
    public static void main(String[] args) {
        scenario("same-account reauthentication cancels and cannot resurrect an old private request", () -> {
            Clock clock = new Clock(); NativeAccountState state = fixture(clock);
            NativeAccountState.Ticket old = state.begin(command("sync", "GET"), clock.elapsed);
            final int[] cancelled = {0}; state.attachCancel(old, () -> cancelled[0]++);
            login(state, clock);
            check(!state.current(old) && cancelled[0] == 1 && !state.finish(old));
            check("account-a".equals(state.account()));
        });
        scenario("late old logout timeout cannot erase a newer same-account session", () -> {
            Clock clock = new Clock(); NativeAccountState state = fixture(clock);
            NativeAccountState.Ticket logout = state.begin(command("auth/logout", "POST"), clock.elapsed);
            check(state.account() == null);
            login(state, clock); state.timeout(logout);
            check("account-a".equals(state.account()) && !state.current(logout));
        });
        scenario("matching local clear disposes bearer copies captured by pending logout", () -> {
            Clock clock = new Clock(); NativeAccountState state = fixture(clock);
            NativeAccountState.Ticket logout = state.begin(command("auth/logout", "POST"), clock.elapsed);
            check(TOKEN.equals(logout.bearer()) && logout.csrf() != null);
            state.clear(CONTEXT);
            check(logout.bearer() == null && logout.csrf() == null && !state.current(logout));
            check(state.account() == null && state.context() == null);
        });
        scenario("idle lifetime expires at its exact monotonic boundary without a wall-clock change", () -> {
            Clock clock = new Clock(); NativeAccountState state = fixture(clock);
            clock.elapsed += NativeAccountPolicy.IDLE_MS - 1; state.sweep();
            check("account-a".equals(state.account()));
            clock.elapsed++; state.sweep();
            check(state.account() == null && state.context() == null);
        });
        scenario("maximum port-depth request survives exactly one outer wire envelope", () -> {
            Object body = 0; for (int index = 0; index < 31; index++) body = map("value", body);
            Map<String,Object> payload = map("version", 1, "contextId", CONTEXT, "requestId", REQUEST, "method", "PUT", "path", "sync", "body", body);
            NativeAccountProtocol.command(payload);
            Object wire = StrictJson.parseWire(StrictJson.stringify(map("version", 1, "callId", REQUEST, "operation", "request", "payload", payload)), NativeAccountPolicy.SNAPSHOT_BYTES + 1024);
            check(StrictJson.stringify(NativeAccountProtocol.wire(wire).payload).equals(StrictJson.stringify(payload)));
        });
        System.out.println("PASS " + scenarios + " independent synthetic host scenarios; no Android framework or transport execution");
    }
}
