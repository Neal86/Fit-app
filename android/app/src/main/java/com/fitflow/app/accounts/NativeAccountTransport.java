package com.fitflow.app.accounts;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.Authenticator;
import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSink;

/** Private network stack, created lazily only after native policy and caller guards pass. */
final class NativeAccountTransport {
    private final NativeAccountState state;
    private final NativeAccountState.Clock clock;
    private final OkHttpClient client;
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final class Attempt {
        final String url; final NativeAccountState.Ticket ticket; final AtomicBoolean used = new AtomicBoolean();
        Attempt(String url, NativeAccountState.Ticket ticket) { this.url = url; this.ticket = ticket; }
    }
    NativeAccountTransport(NativeAccountState state, NativeAccountState.Clock clock) {
        this.state = state; this.clock = clock;
        client = new OkHttpClient.Builder()
            .cookieJar(CookieJar.NO_COOKIES).cache(null)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).fastFallback(false)
            .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
            .callTimeout(NativeAccountPolicy.TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .connectTimeout(NativeAccountPolicy.TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(NativeAccountPolicy.TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(NativeAccountPolicy.TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .addNetworkInterceptor(chain -> {
                Request request = chain.request(); Attempt attempt = request.tag(Attempt.class);
                String endpoint = NativeAccountPolicy.endpoint();
                if (attempt == null || !attempt.used.compareAndSet(false, true) || !state.live(attempt.ticket) || endpoint == null ||
                    !attempt.url.equals(endpoint + "/" + attempt.ticket.command.path) || !attempt.url.equals(request.url().toString()) ||
                    request.header("Cookie") != null || request.header("Origin") != null || request.header("Referer") != null ||
                    !"identity".equals(request.header("Accept-Encoding"))) throw new IOException("network_error");
                return chain.proceed(request);
            }).build();
    }
    Call prepare(NativeAccountState.Ticket ticket) {
        state.requireLive(ticket);
        String endpoint = NativeAccountPolicy.endpoint(); if (endpoint == null) throw new NativeAccountProtocol.Failure("unavailable");
        NativeAccountProtocol.Command command = ticket.command; String url = endpoint + "/" + command.path;
        RequestBody body = null;
        if (command.body != null) {
            final byte[] bytes = StrictJson.utf8(StrictJson.stringify(command.body), command.requestLimit);
            body = new RequestBody() {
                private final AtomicBoolean written = new AtomicBoolean();
                @Override public MediaType contentType() { return JSON; }
                @Override public long contentLength() { return bytes.length; }
                @Override public boolean isOneShot() { return true; }
                @Override public void writeTo(BufferedSink sink) throws IOException {
                    if (!written.compareAndSet(false, true)) throw new IOException("network_error");
                    sink.write(bytes);
                }
            };
        }
        Request.Builder builder = new Request.Builder().url(url).method(command.method, body)
            .header("Accept", "application/json").header("Accept-Encoding", "identity")
            .header("X-Fitflow-Client", "native-v1").tag(Attempt.class, new Attempt(url, ticket));
        if (!command.publicAuth) {
            String raw = ticket.bearer(), csrf = ticket.csrf();
            if (raw == null || csrf == null) throw new NativeAccountProtocol.Failure("unavailable");
            builder.header("Authorization", "Bearer " + raw).header("X-CSRF-Token", csrf);
        }
        Request request = builder.build();
        if (!request.url().toString().equals(url)) throw new NativeAccountProtocol.Failure("unavailable");
        Call call = client.newCall(request);
        long remaining = ticket.deadline - clock.elapsed(); if (remaining <= 0) throw new NativeAccountProtocol.Failure("expired");
        call.timeout().deadlineNanoTime(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(remaining));
        return call;
    }
    NativeAccountProtocol.Reviewed execute(Call call, NativeAccountState.Ticket ticket) throws IOException {
        try (Response response = call.execute()) {
            state.requireLive(ticket);
            int status = response.code(); NativeAccountProtocol.Command c = ticket.command;
            if (!(status >= 400 && status <= 599) && !c.accepts(status)) throw NativeAccountProtocol.badResponse();
            String encoding = response.header("Content-Encoding");
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw NativeAccountProtocol.badResponse();
            ResponseBody body = response.body();
            if (status == 204) {
                if (body != null && (body.contentLength() > 0 || body.byteStream().read() != -1)) throw NativeAccountProtocol.badResponse();
                return NativeAccountProtocol.review(c, status, null, clock.wall());
            }
            int limit = status >= 400 ? NativeAccountPolicy.ERROR_BYTES : c.responseLimit;
            if (body == null) {
                if (status < 400) throw NativeAccountProtocol.badResponse();
                return NativeAccountProtocol.review(c, status, null, clock.wall());
            }
            if (body.contentLength() > limit) throw NativeAccountProtocol.badResponse();
            if (status >= 400 && body.contentLength() == 0) return NativeAccountProtocol.review(c, status, null, clock.wall());
            String type = response.header("Content-Type");
            if (type == null || !type.matches("(?i)application/json(?:\\s*;\\s*charset=(?:utf-8|\"utf-8\"))?")) throw NativeAccountProtocol.badResponse();
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(limit, 8192));
            byte[] buffer = new byte[8192]; int total = 0;
            try (InputStream in = body.byteStream()) {
                int count;
                while ((count = in.read(buffer)) != -1) {
                    state.requireLive(ticket);
                    if (count > limit - total) throw NativeAccountProtocol.badResponse();
                    out.write(buffer, 0, count); total += count;
                }
            }
            state.requireLive(ticket);
            if (total == 0 && status >= 400) return NativeAccountProtocol.review(c, status, null, clock.wall());
            Object parsed;
            try { parsed = StrictJson.parse(out.toByteArray(), limit); }
            catch (StrictJson.Rejected ignored) { throw NativeAccountProtocol.badResponse(); }
            state.requireLive(ticket);
            return NativeAccountProtocol.review(c, status, parsed, clock.wall());
        }
    }
    void close() { client.dispatcher().cancelAll(); client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown(); }
}
