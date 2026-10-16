# Isolated native account transport: source and acceptance boundary

## Activation remains gated

This source implements a narrow native account boundary for the separate `/api/native/v1` API. It does not configure a recipient or activate native account UI. Both platform endpoint policies and their independent endpoint allowlists are empty. The Web `CloudClient` native guard remains unchanged; merely compiling a channel or returning a capability value must not turn it on.

Before activation, a release owner must approve the exact service recipient, complete real platform compilation and adversarial device acceptance, and review live email, hosting, privacy/retention and operational arrangements. Existing user consent for manual cloud snapshots and specific coach/challenge recipients remains mandatory. No startup discovery, account check, automatic upload or invitation is added.

See [the API protocol](../server/NATIVE_ACCOUNTS.md), [the typed port contract](NATIVE_ACCOUNT_BRIDGE.md), and [the complete-product release gates](../RELEASE_READINESS.md).

## Dedicated channel

The fixed channel name is `FitflowNativeAccounts`. Its string input is exactly:

```ts
{
  version: 1,
  callId: canonicalUuid,
  operation: 'capabilities' | 'startContext' | 'clearContext' | 'request',
  payload: portArgument
}
```

Its string output is either `{version:1, callId, ok:true, value:portResult}` or `{version:1, callId, ok:false, error:fixedCode}`. Only `unavailable`, `invalid_request`, `invalid_response`, `cancelled`, `expired`, `network_error`, `busy`, and `context_exhausted` are local error codes. Local failures include no input, URL, upstream message, header or exception text. The existing port contract continues to validate operation payloads and business reply envelopes.

The total serialized channel message, including both envelopes, is bounded by the applicable body budget plus 1,024 bytes. Capability and context operations are local only. No operation accepts an arbitrary transport URL, recipient, headers, callback name or limit override. A business consent field naming a reviewed counterpart is not a transport-recipient override and must be preserved.

The typed adapter is explicitly constructed and invoked. It has no module-initialization network or plugin action, no Web fetch fallback, and no production account-UI import. Android uses the dedicated message object's captured message callback; iOS uses the dedicated WebKit handler's Promise reply. Unknown or unattributable stale Android messages cannot invalidate a newer context. Correlated errors affect only their captured generation. Adapter disposal is local cleanup, never evidence of server logout.

## Caller and packaged-content provenance

A generic Capacitor account plugin is deliberately avoided. In the installed Capacitor 8.5.3 implementation, the Android message path may fall back to an all-frame JavaScript interface; native plugin calls do not retain reliable caller-frame evidence. The iOS generic plugin dispatcher drops WebKit frame provenance and its normal reply path logs part of successful results. Private account responses must not traverse those paths.

Android uses an AndroidX `WebMessageListener`, with an exact packaged-origin allowlist, intended WebView identity and `isMainFrame` checks. It has no legacy account-interface fallback. iOS uses `WKScriptMessageHandlerWithReply`, validating the intended WebView, main-frame flag, security origin and frame request URL. Each operation retains its own native reply handle; private replies are not JavaScript source evaluated into a page.

Origin alone does not prove the source of the page: Capacitor exposes mutable asset roots and can serve different bytes under the same local origin. The shell must seal the packaged asset source, reject or permanently invalidate account access after root mutation, and recheck that source at entry and delivery. URL/history/navigation, foreground and `/account` route guards complement the root checks. JS cleanup is supplemental; it cannot substitute for native checks.

The special Capacitor file/content/proxy routes are blocked for all frames and subresources. A same-origin iframe could otherwise call through its parent, and script loads need not invoke a navigation delegate. Android also requires a matching committed packaged-document load; changing a URL with the History API cannot establish document authority. Large input validation and request/reply encoding run off the lifecycle owner, with a final native state check before publication.

Existing WebView profiles are a separate upgrade-provenance gate. A service worker or cached content left by an older mutable-root build must not be assumed trustworthy merely because the new root is sealed. Current native startup does not register the Web service worker, but that does not prove historical profile contents are absent. Activation requires an explicit profile migration/isolation design and adversarial upgrade tests; this source does not clear users' existing app data or claim that gate has passed.

This boundary does not make compromised trusted application JavaScript harmless. Code running as the intended app can still request app-authorized operations. The native vault limits raw bearer exposure; application integrity, strict domain validation, deliberate recipient/consent review and server authorization remain necessary.

## Native credential ownership and cancellation

Only native code receives the raw login `{session,nativeToken}` envelope. It validates its exact shape, the 43-character base64url token, the sanitized session and the SHA-256 CSRF binding before storing credentials in native memory. JavaScript receives only the existing sanitized session shape. Request envelopes have no bearer or CSRF override. The CSRF field is session-context binding, not an independent factor.

The native owner tracks context, generation, account, pending operations, used request identities and expiry. Bounded non-evicting replay ledgers reject exhaustion rather than silently forget old identifiers. At most two network operations may be active. Login and account-changing actions form barriers: obsolete work is cancelled and cannot install credentials or return private data after a newer context is established. Reauthentication of the same account still changes generation.

Callbacks recheck state after asynchronous work and again immediately before credential installation or private delivery. Clearing a context advances its fence before cancellation acknowledgment. Old clear/logout/login completions cannot affect newer account state. Backgrounding, route departure, navigation, renderer/lifecycle loss and expiry discard local access; returning to foreground does not restore it. The eight-hour absolute and thirty-minute idle limits use native elapsed time as well as the server's wall-clock expiry, with no refresh or absolute-lifetime extension from a session read.

Only a currently correlated explicit logout 204 confirms server logout. Local clear, disposal, network failure, timeout and process death do not establish remote revocation. An uncertain upload requires fresh cloud inspection; it must not be blindly retried or described as saved.

Credentials and private bodies are not intentionally persisted, copied to a clipboard, logged or exported through error diagnostics. Disposal and reference release are implemented; guaranteed zeroization of every framework/runtime string or networking buffer is not claimed.

## Network isolation

Android declares the pinned `com.squareup.okhttp3:okhttp:5.5.0` dependency and creates a private client. Cookies, cache, redirects, authenticators and ordinary connection retries are disabled. Mutating bodies are one-shot and a per-call exchange fence is required because the connection-retry setting alone does not prevent every HTTP follow-up. No global `CookieHandler`, Capacitor cookie manager, shared client or general-purpose HTTP bridge is used.

iOS uses a dedicated ephemeral `URLSession` with cookie, cache and credential stores explicitly disabled. Ephemeral alone is insufficient: it normally still has in-memory stores. Responses are streamed with fixed byte limits, redirects and cache proposals are rejected, and only normal server-trust validation is allowed. A native absolute watchdog bounds the operation. There is no app-level retry loop. Apple's documented automatic idempotent retry behavior must be accounted for with one-shot streamed mutation bodies; absence of an app loop alone is not a zero-retransmission guarantee.

Both transports keep normal TLS verification, exact packaged-recipient checks and a positive logical path/method allowlist. They do not broaden navigation, permit cleartext, accept arbitrary certificates or add a live endpoint. Body limits apply before parsing and bridging, including decompressed content. UTF-8, JSON structure, numeric types, depth, node count, reply status and credential-envelope exclusion are checked. Existing application/domain validators still decide whether a successful business body is usable.

## Dependency and API evidence

- [Maven Central: OkHttp 5.5.0](https://central.sonatype.com/artifact/com.squareup.okhttp3/okhttp/5.5.0) verifies the established artifact coordinates and the project's current Lysine source location
- [Pinned upstream README](https://raw.githubusercontent.com/lysine-dev/okhttp/parent-5.5.0/README.md) states Android API 21+ and Java 8+ requirements; this app's minimum is API 24. Kotlin/Okio and AndroidX Startup are transitive implementation considerations
- [Pinned retry implementation](https://raw.githubusercontent.com/lysine-dev/okhttp/parent-5.5.0/okhttp/src/commonJvmAndroid/kotlin/okhttp3/internal/http/RetryAndFollowUpInterceptor.kt) documents why one connection-retry flag is not an all-follow-up guard
- [AndroidX message listener API](https://developer.android.com/reference/androidx/webkit/WebViewCompat.WebMessageListener) provides caller origin, frame status and a reply handle
- [Apple ephemeral configuration](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/ephemeral) and [credential storage](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/urlcredentialstorage) distinguish a private session from disabled stores
- [Apple automatic retry guidance](https://developer.apple.com/library/archive/qa/qa1941/_index.html) explains idempotent retry behavior and streamed-body constraints

These are source/API compatibility checks, not dependency-resolution, supply-chain audit, merged-manifest or platform-build evidence. No native package was downloaded or installed for this slice.

## Verification gates

Host Java lifecycle tests, typed-adapter synthetic tests, API protocol tests and source/build-wiring guards can run without an Android SDK or Xcode. They exercise their actual production core or clearly identified source contracts; framework stubs are not accepted as native compilation. Xcode project parsing and XML/plist validation establish syntax/references only.

Still required before activation:

1. Resolve and audit the pinned native dependencies; inspect the merged Android manifest and packaged libraries
2. Compile the complete Android application and Swift/Xcode targets against the exact pinned Capacitor APIs
3. Exercise main-frame, iframe, script/subresource, alternate-root, stale-profile/service-worker upgrade, navigation, process/renderer loss and background races on real WebViews
4. Observe cookie/cache/redirect/authentication/retry isolation against controlled synthetic HTTPS services, including oversized/slow/malformed responses and timeout/cancel races
5. Verify no private logging, storage, backup or crash-diagnostic leakage; test simultaneous account/session changes and one-shot mutation outcomes
6. Complete responsive/accessibility, native export/import, physical-device and store-release acceptance

The previous native asset-sync operation remains unverified and paused. This source slice does not rerun it and does not turn resource parsing or host tests into an Android/iOS build claim.
