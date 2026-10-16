package com.fitflow.app.accounts;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** In-memory authority. Identity mutations and final-delivery checks run on the Android UI owner.
 * Synchronization also protects transport fence reads and race-safe cancellation-handle attachment.
 * No persistence or refresh. */
public final class NativeAccountState {
    public interface Clock { long wall(); long elapsed(); }
    private final Clock clock;
    private final int ledgerLimit;
    private final Set<String> contexts = new HashSet<>();
    private final Set<String> requests = new HashSet<>();
    private final Map<String,Ticket> pending = new LinkedHashMap<>();
    private String context, account, token, csrf;
    private long generation, wallExpiry, absoluteExpiry, idleExpiry;
    public NativeAccountState(Clock clock) { this(clock, NativeAccountPolicy.LEDGER_LIMIT); }
    NativeAccountState(Clock clock, int ledgerLimit) { this.clock = clock; this.ledgerLimit = ledgerLimit; }
    public static final class Ticket {
        public final NativeAccountProtocol.Command command;
        public final long deadline;
        long generation;
        String account;
        private String token, csrf;
        private boolean terminal;
        private Runnable cancel;
        Ticket(NativeAccountProtocol.Command c, long generation, String account, String token, String csrf, long deadline) {
            command = c; this.generation = generation; this.account = account; this.token = token; this.csrf = csrf; this.deadline = deadline;
        }
        synchronized String bearer() { return token; }
        synchronized String csrf() { return csrf; }
        synchronized void disposeCredentials() { token = null; csrf = null; }
    }
    public synchronized long generation() { return generation; }
    public synchronized boolean matches(long generation, String context, String account) {
        return this.generation == generation && Objects.equals(this.context, context) && Objects.equals(this.account, account);
    }
    public synchronized String context() { return context; }
    public synchronized String account() { return account; }
    public synchronized int inFlight() { return pending.size(); }
    public synchronized void start(String next) {
        if (!NativeAccountProtocol.uuid(next)) throw NativeAccountProtocol.badRequest();
        if (contexts.contains(next)) throw NativeAccountProtocol.badRequest();
        if (contexts.size() >= ledgerLimit) { clearAll(); throw new NativeAccountProtocol.Failure("context_exhausted"); }
        clearAll(); contexts.add(next); context = next; requests.clear();
    }
    public synchronized void clear(String expected) {
        if (!NativeAccountProtocol.uuid(expected)) throw NativeAccountProtocol.badRequest();
        if (Objects.equals(context, expected)) clearAll();
    }
    public synchronized void clearAll() {
        ++generation; context = null; eraseSession(); cancelPending(); requests.clear();
    }
    private void eraseSession() { account = null; token = null; csrf = null; wallExpiry = absoluteExpiry = idleExpiry = 0; }
    private void cancelPending() {
        ArrayList<Ticket> old = new ArrayList<>(pending.values()); pending.clear();
        for (Ticket t : old) { t.terminal = true; t.disposeCredentials(); if (t.cancel != null) t.cancel.run(); t.cancel = null; }
    }
    private void barrier() { ++generation; eraseSession(); cancelPending(); }
    private boolean expired() { return token != null && (clock.wall() >= wallExpiry || clock.elapsed() >= absoluteExpiry || clock.elapsed() >= idleExpiry); }
    public synchronized void sweep() { if (expired()) clearAll(); }
    public synchronized Ticket begin(NativeAccountProtocol.Command c, long enteredAt) {
        if (!Objects.equals(context, c.contextId) || context == null) throw new NativeAccountProtocol.Failure("cancelled");
        if (expired()) { clearAll(); throw new NativeAccountProtocol.Failure("expired"); }
        if (clock.elapsed() - enteredAt >= NativeAccountPolicy.TIMEOUT_MS) throw new NativeAccountProtocol.Failure("expired");
        if (requests.contains(c.requestId)) throw NativeAccountProtocol.badRequest();
        if (requests.size() >= ledgerLimit) { clearAll(); throw new NativeAccountProtocol.Failure("context_exhausted"); }
        requests.add(c.requestId); // Never evict or release IDs, including rejected/busy requests.
        if (!c.publicAuth && token == null) throw new NativeAccountProtocol.Failure("unavailable");
        String heldToken = c.publicAuth ? null : token, heldCsrf = c.publicAuth ? null : csrf;
        if (c.barrier) barrier();
        if (pending.size() >= 2) throw new NativeAccountProtocol.Failure("busy");
        Ticket t = new Ticket(c, generation, account, heldToken, heldCsrf, enteredAt + NativeAccountPolicy.TIMEOUT_MS);
        pending.put(c.requestId, t); return t;
    }
    public synchronized void attachCancel(Ticket t, Runnable cancel) {
        if (!current(t)) cancel.run(); else t.cancel = cancel;
    }
    public synchronized boolean current(Ticket t) {
        return !t.terminal && pending.get(t.command.requestId) == t && matches(t.generation, t.command.contextId, t.account);
    }
    public synchronized boolean live(Ticket t) {
        return current(t) && clock.elapsed() < t.deadline && !expired();
    }
    public synchronized void requireLive(Ticket t) {
        if (!current(t)) throw new NativeAccountProtocol.Failure("cancelled");
        if (clock.elapsed() >= t.deadline || expired()) throw new NativeAccountProtocol.Failure("expired");
    }
    /** Rechecked by the caller against the originating main frame and packaged root immediately before this. */
    public synchronized void accept(Ticket t, NativeAccountProtocol.Reviewed response) {
        requireLive(t);
        if (response.status >= 400) {
            boolean csrfError = response.status == 403 && "csrf_failed".equals(NativeAccountProtocol.object(response.body.get("error")).get("code"));
            if (!t.command.publicAuth && (response.status == 401 || csrfError)) invalidateKeeping(t);
            return;
        }
        if (t.command.login()) {
            NativeAccountProtocol.Session s = response.session;
            if (s == null || response.nativeToken == null) { invalidateKeeping(t); throw NativeAccountProtocol.badResponse(); }
            // Re-validate against the delivery clock; response parsing may have waited in another queue.
            NativeAccountProtocol.session(s.value, clock.wall());
            ++generation; cancelExcept(t); t.generation = generation;
            account = s.account; token = response.nativeToken; csrf = s.csrf; t.account = account;
            wallExpiry = s.expires;
            absoluteExpiry = clock.elapsed() + Math.min(NativeAccountPolicy.ABSOLUTE_MS, s.expires - clock.wall());
            idleExpiry = Math.min(absoluteExpiry, clock.elapsed() + NativeAccountPolicy.IDLE_MS);
        } else if (t.command.session()) {
            NativeAccountProtocol.Session s = response.session;
            if (s == null || !Objects.equals(account, s.account) || !Objects.equals(csrf, s.csrf) || s.expires != wallExpiry) {
                invalidateKeeping(t); throw NativeAccountProtocol.badResponse();
            }
            NativeAccountProtocol.session(s.value, clock.wall());
            idleExpiry = Math.min(absoluteExpiry, clock.elapsed() + NativeAccountPolicy.IDLE_MS);
        } else if (token != null) idleExpiry = Math.min(absoluteExpiry, clock.elapsed() + NativeAccountPolicy.IDLE_MS);
    }
    private void cancelExcept(Ticket keep) {
        for (Ticket t : new ArrayList<>(pending.values())) {
            if (t == keep) continue; pending.remove(t.command.requestId); t.terminal = true; t.disposeCredentials();
            if (t.cancel != null) t.cancel.run(); t.cancel = null;
        }
    }
    private void invalidateKeeping(Ticket t) {
        ++generation; eraseSession(); cancelExcept(t); t.generation = generation; t.account = null; t.disposeCredentials();
    }
    public synchronized void malformed(Ticket t) {
        if (current(t) && (t.command.login() || !t.command.publicAuth)) invalidateKeeping(t);
    }
    public synchronized void timeout(Ticket t) {
        if (!current(t)) return;
        // Timeout is terminal for this request; it cannot install a credential later.
        Runnable cancel = t.cancel; finish(t); if (cancel != null) cancel.run();
    }
    public synchronized boolean finish(Ticket t) {
        if (!current(t)) return false;
        pending.remove(t.command.requestId); t.terminal = true; t.disposeCredentials(); t.cancel = null; return true;
    }
}
