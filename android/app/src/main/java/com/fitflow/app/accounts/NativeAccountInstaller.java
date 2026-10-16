package com.fitflow.app.accounts;

import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.fitflow.app.MainActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.WebViewLocalServer;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.Call;

/** Installation-only Capacitor plugin: deliberately has NO @PluginMethod and no generic account API.
 * Private results travel only through the originating main frame's captured reply proxy. */
@CapacitorPlugin(name = "FitflowNativeAccountInstaller")
public final class NativeAccountInstaller extends Plugin {
    private static final String CHANNEL = "FitflowNativeAccounts";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final NativeAccountState.Clock clock = new NativeAccountState.Clock() {
        @Override public long wall() { return System.currentTimeMillis(); }
        @Override public long elapsed() { return SystemClock.elapsedRealtime(); }
    };
    private final NativeAccountState state = new NativeAccountState(clock);
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(2));
    private final Set<String> usedCalls = new HashSet<>();
    private WebView intended;
    private BridgeWebViewClient guardedClient;
    private WebViewLocalServer packagedServer;
    private NativeAccountTransport transport;
    private boolean installed, foreground, destroyed, callLedgerExhausted;
    private long documentEpoch;
    private String lastUrl, pendingDocument;
    private final AtomicBoolean documentAuthority = new AtomicBoolean();

    @Override public void load() {
        intended = bridge.getWebView();
        if (!(getActivity() instanceof MainActivity) || intended == null || !configurationSafe() ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        guardedClient = new BridgeWebViewClient(bridge) {
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                poisonDocument(); lastUrl = url;
                if (view == intended && NativeAccountPolicy.packagedDocument(url)) pendingDocument = documentKey(url);
                else view.stopLoading();
                super.onPageStarted(view, url, icon);
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                // A history replacement cannot mint document authority. Only a matching committed
                // load from the fixed packaged SPA route set, with the original native root, can.
                if (view == intended && url != null && documentKey(url).equals(pendingDocument) && NativeAccountPolicy.packagedDocument(url) && rootSafe()) documentAuthority.set(true);
                else poisonDocument();
                pendingDocument = null;
                super.onPageCommitVisible(view, url);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (NativeAccountPolicy.forbiddenResource(url) || request.isForMainFrame() && !NativeAccountPolicy.packagedDocument(url)) {
                    // IO callback: revoke the atomic document bit before hopping to the UI owner.
                    // Block file/content/proxy helpers in ALL frames, including same-origin frames
                    // that could otherwise call through their parent's message object.
                    documentAuthority.set(false); main.post(() -> poisonDocument());
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }
            @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                if (!NativeAccountPolicy.packagedDocument(url)) poisonDocument();
                else if (reload || !NativeAccountPolicy.ACCOUNT_URL.equals(url) || lastUrl != null && !lastUrl.equals(url)) invalidate();
                lastUrl = url; super.doUpdateVisitedHistory(view, url, reload);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (NativeAccountPolicy.forbiddenResource(url) || !NativeAccountPolicy.packagedDocument(url)) {
                    poisonDocument(); return true;
                }
                if (request.isForMainFrame()) poisonDocument();
                return super.shouldOverrideUrlLoading(view, request);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) poisonDocument(); super.onReceivedError(view, request, error);
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                poisonDocument(); installed = false; return super.onRenderProcessGone(view, detail);
            }
        };
        bridge.setWebViewClient(guardedClient);
        try {
            WebViewCompat.addWebMessageListener(intended, CHANNEL, Collections.singleton(NativeAccountPolicy.APP_ORIGIN),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> receive(view, message, sourceOrigin, isMainFrame, replyProxy));
            installed = true;
        } catch (RuntimeException ignored) { installed = false; invalidate(); }
    }
    private boolean configurationSafe() {
        String[] navigation = bridge.getConfig().getAllowNavigation();
        return bridge.getServerUrl() == null && "localhost".equals(bridge.getConfig().getHostname()) &&
            "https".equals(bridge.getConfig().getAndroidScheme()) && (navigation == null || navigation.length == 0) &&
            bridge.getPlugin("WebView") != null && bridge.getPlugin("WebView").getInstance() instanceof PackagedWebView;
    }
    private static String documentKey(String url) { return NativeAccountPolicy.APP_ORIGIN.equals(url) ? url + "/" : url; }
    private boolean rootSafe() {
        if (!installed || destroyed || bridge.getWebView() != intended || bridge.getWebViewClient() != guardedClient || !configurationSafe()) return false;
        WebViewLocalServer server = bridge.getLocalServer();
        if (server == null || !NativeAccountPolicy.ASSET_ROOT.equals(server.getBasePath())) return false;
        // MainActivity forces ASSET_PATH after startup deploy restoration. PackagedWebView blocks ALL
        // JS root mutation, including hostFiles("public"). Identity is captured only after that setup.
        if (packagedServer == null) packagedServer = server;
        return packagedServer == server;
    }
    private boolean packaged() {
        if (!foreground || !documentAuthority.get() || !rootSafe()) return false;
        String url = intended.getUrl();
        if (url == null || !url.startsWith(NativeAccountPolicy.APP_ORIGIN + "/")) return false;
        Uri uri = Uri.parse(url);
        return "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && uri.getPort() == -1 && uri.getUserInfo() == null;
    }
    private boolean account() { return packaged() && NativeAccountPolicy.ACCOUNT_URL.equals(intended.getUrl()); }
    private void invalidate() { ++documentEpoch; state.clearAll(); }
    private void poisonDocument() { documentAuthority.set(false); pendingDocument = null; invalidate(); }
    private static final class Incoming {
        final WebView view; final Uri origin; final boolean mainFrame; final JavaScriptReplyProxy reply;
        final long document, generation, entered; final String context, account;
        final AtomicBoolean replied = new AtomicBoolean();
        Incoming(WebView view, Uri origin, boolean mainFrame, JavaScriptReplyProxy reply, long document, long generation, long entered, String context, String account) {
            this.view = view; this.origin = origin; this.mainFrame = mainFrame; this.reply = reply;
            this.document = document; this.generation = generation; this.entered = entered; this.context = context; this.account = account;
        }
    }
    private boolean source(Incoming call) {
        return call.mainFrame && call.view == intended && NativeAccountPolicy.APP_ORIGIN.equals(call.origin.toString()) &&
            call.document == documentEpoch && packaged();
    }
    private void receive(WebView view, WebMessageCompat message, Uri origin, boolean mainFrame, JavaScriptReplyProxy reply) {
        if (Looper.myLooper() != Looper.getMainLooper() || callLedgerExhausted) return;
        if (!mainFrame || view != intended || origin == null || !NativeAccountPolicy.APP_ORIGIN.equals(origin.toString()) || !packaged()) { state.clearAll(); return; }
        final String raw;
        try { if (message.getType() != WebMessageCompat.TYPE_STRING) return; raw = message.getData(); }
        catch (RuntimeException ignored) { return; }
        if (raw == null || raw.length() > NativeAccountPolicy.SNAPSHOT_BYTES + 1024) return;
        Incoming call = new Incoming(view, origin, mainFrame, reply, documentEpoch, state.generation(), clock.elapsed(), state.context(), state.account());
        // Local clear/context/capability envelopes are tiny. Validate and dispatch them on the
        // lifecycle owner so a saturated network/large-JSON queue cannot delay cancellation.
        // At most 1,024 UTF-16 units / 4 KiB UTF-8 can take this bounded synchronous path.
        if (raw.length() <= 1024) {
            try { dispatch(call, prepareWire(raw, 4096)); }
            catch (RuntimeException ignored) { /* malformed wire has no trusted correlation */ }
            return;
        }
        try {
            workers.execute(() -> {
                PreparedWire prepared;
                try { prepared = prepareWire(raw, NativeAccountPolicy.SNAPSHOT_BYTES + 1024); }
                catch (RuntimeException ignored) { return; } // No trustworthy callId exists for malformed wire.
                main.post(() -> dispatch(call, prepared));
            });
        } catch (RejectedExecutionException ignored) { /* bounded admission; never retain more unparsed messages */ }
    }
    private static final class PreparedWire {
        final NativeAccountProtocol.Wire wire;
        final NativeAccountProtocol.Command command;
        final String error;
        PreparedWire(NativeAccountProtocol.Wire wire, NativeAccountProtocol.Command command, String error) {
            this.wire = wire; this.command = command; this.error = error;
        }
    }
    private static PreparedWire prepareWire(String raw, int limit) {
        NativeAccountProtocol.Wire wire = NativeAccountProtocol.wire(StrictJson.parseWire(raw, limit));
        try {
            // Large command/body validation stays on a bounded worker, before the owner queue hop.
            NativeAccountProtocol.Command command = "request".equals(wire.operation) ? NativeAccountProtocol.command(wire.payload) : null;
            return new PreparedWire(wire, command, null);
        } catch (RuntimeException ignored) { return new PreparedWire(wire, null, "invalid_request"); }
    }
    private void dispatch(Incoming incoming, PreparedWire prepared) {
        NativeAccountProtocol.Wire wire = prepared.wire;
        if (!source(incoming) || !state.matches(incoming.generation, incoming.context, incoming.account)) return;
        if (usedCalls.contains(wire.callId)) return; // No second terminal result for a duplicate channel call.
        if (usedCalls.size() >= NativeAccountPolicy.LEDGER_LIMIT) {
            state.clearAll(); localFailure(incoming, wire.callId, "context_exhausted"); callLedgerExhausted = true; return;
        }
        usedCalls.add(wire.callId);
        if (prepared.error != null) { localFailure(incoming, wire.callId, prepared.error); return; }
        try {
            switch (wire.operation) {
                case "capabilities":
                    NativeAccountProtocol.capabilities(wire.payload);
                    localSuccess(incoming, wire.callId, NativeAccountProtocol.map("version", 1, "available", NativeAccountPolicy.endpoint() != null)); return;
                case "clearContext": {
                    String id = NativeAccountProtocol.context(wire.payload); state.clear(id);
                    localSuccess(incoming, wire.callId, NativeAccountProtocol.map("version", 1, "contextId", id)); return;
                }
                case "startContext": {
                    String id = NativeAccountProtocol.context(wire.payload);
                    if (!account() || NativeAccountPolicy.endpoint() == null) throw new NativeAccountProtocol.Failure("unavailable");
                    state.start(id);
                    localSuccess(incoming, wire.callId, NativeAccountProtocol.map("version", 1, "contextId", id)); return;
                }
                case "request": {
                    NativeAccountProtocol.Command command = prepared.command;
                    // StrictJson's preflight already applied the per-route total channel budget.
                    if (command == null) throw NativeAccountProtocol.badRequest();
                    if (!account() || NativeAccountPolicy.endpoint() == null) throw new NativeAccountProtocol.Failure("unavailable");
                    request(incoming, wire.callId, command); return;
                }
                default: throw NativeAccountProtocol.badRequest();
            }
        } catch (NativeAccountProtocol.Failure failure) { localFailure(incoming, wire.callId, failure.code); }
        catch (RuntimeException ignored) { localFailure(incoming, wire.callId, "invalid_request"); }
    }
    private void localSuccess(Incoming incoming, String callId, Object value) {
        if (!source(incoming) || !incoming.replied.compareAndSet(false, true)) return;
        // Synchronous on the UI owner: no lifecycle or state mutation can interleave with publication.
        try { incoming.reply.postMessage(NativeAccountProtocol.success(callId, value, NativeAccountPolicy.REQUEST_BYTES)); }
        catch (RuntimeException ignored) { invalidate(); }
    }
    private void localFailure(Incoming incoming, String callId, String code) {
        if (!source(incoming) || !incoming.replied.compareAndSet(false, true)) return;
        try { incoming.reply.postMessage(NativeAccountProtocol.failure(callId, code)); }
        catch (RuntimeException ignored) { invalidate(); }
    }
    private void request(Incoming incoming, String callId, NativeAccountProtocol.Command command) {
        NativeAccountState.Ticket ticket = state.begin(command, incoming.entered);
        try { if (transport == null) transport = new NativeAccountTransport(state, clock); }
        catch (RuntimeException failure) { state.finish(ticket); throw failure; }
        Runnable timeout = () -> {
            if (!state.current(ticket)) return;
            boolean canReply = source(incoming) && account();
            state.timeout(ticket); // Fence first, then cancellation and fixed acknowledgement.
            if (canReply) localFailure(incoming, callId, "expired");
        };
        main.postDelayed(timeout, Math.max(0, ticket.deadline - clock.elapsed()));
        try {
            workers.execute(() -> {
                NativeAccountProtocol.Reviewed response = null; String error = null; String encodedReply = null;
                try {
                    // Request encoding (up to 10 MiB) and response encoding (up to 64 MiB) never
                    // occupy the lifecycle owner. The cancellation handle attaches race-safely.
                    Call call = transport.prepare(ticket); state.attachCancel(ticket, call::cancel);
                    state.requireLive(ticket);
                    response = transport.execute(call, ticket);
                    encodedReply = NativeAccountProtocol.success(callId, NativeAccountProtocol.portReply(ticket.command, response),
                        response.status >= 400 ? NativeAccountPolicy.ERROR_BYTES : ticket.command.responseLimit);
                    state.requireLive(ticket);
                }
                catch (NativeAccountProtocol.Failure failure) { error = failure.code; }
                catch (IOException ignored) { error = clock.elapsed() >= ticket.deadline ? "expired" : "network_error"; }
                catch (RuntimeException ignored) { error = "invalid_response"; }
                final NativeAccountProtocol.Reviewed result = response; final String failure = error; final String wireReply = encodedReply;
                main.post(() -> {
                    main.removeCallbacks(timeout);
                    deliver(incoming, callId, ticket, result, wireReply, failure);
                });
            });
        } catch (RejectedExecutionException ignored) {
            main.removeCallbacks(timeout);
            if (state.finish(ticket)) localFailure(incoming, callId, "busy");
        }
    }
    private void deliver(Incoming incoming, String callId, NativeAccountState.Ticket ticket, NativeAccountProtocol.Reviewed result, String encodedReply, String error) {
        if (!source(incoming) || !account()) { if (state.current(ticket)) invalidate(); return; }
        if (!state.current(ticket)) return;
        try {
            state.requireLive(ticket);
            if (error != null) {
                if (error.equals("invalid_response")) state.malformed(ticket);
                String wire = NativeAccountProtocol.failure(callId, error);
                if (source(incoming) && account() && state.current(ticket) && state.finish(ticket) && incoming.replied.compareAndSet(false, true)) incoming.reply.postMessage(wire);
                return;
            }
            // Large encoding finished on the worker. This final owner turn does only fixed/small
            // session checks, credential install and the exact originating frame's publication.
            if (encodedReply == null || result == null) throw NativeAccountProtocol.badResponse();
            if (!source(incoming) || !account()) { invalidate(); return; }
            state.accept(ticket, result); // Token install has the same UI-thread frame/root/generation guard.
            if (source(incoming) && account() && state.live(ticket) && state.finish(ticket) && incoming.replied.compareAndSet(false, true)) incoming.reply.postMessage(encodedReply);
        } catch (NativeAccountProtocol.Failure failure) {
            state.malformed(ticket);
            if (source(incoming) && account() && state.current(ticket) && state.finish(ticket)) localFailure(incoming, callId, failure.code);
        } catch (RuntimeException ignored) {
            state.malformed(ticket);
            if (state.finish(ticket)) localFailure(incoming, callId, "invalid_response");
        }
    }
    private final Runnable expiry = new Runnable() {
        @Override public void run() {
            if (destroyed || !foreground) return;
            if (!account() && state.context() != null) invalidate(); else state.sweep();
            main.postDelayed(this, 1000);
        }
    };
    @Override protected void handleOnResume() { foreground = true; main.removeCallbacks(expiry); main.post(expiry); }
    @Override protected void handleOnPause() { foreground = false; invalidate(); main.removeCallbacks(expiry); }
    @Override protected void handleOnStop() { foreground = false; invalidate(); main.removeCallbacks(expiry); }
    @Override protected void handleOnDestroy() {
        destroyed = true; foreground = false; invalidate(); main.removeCallbacksAndMessages(null);
        if (installed && intended != null) {
            try { WebViewCompat.removeWebMessageListener(intended, CHANNEL); } catch (RuntimeException ignored) { }
        }
        installed = false; workers.shutdownNow(); if (transport != null) transport.close();
    }
}
