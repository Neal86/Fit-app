# Native account bridge contract, version 1

## Status and boundary

This is an **unwired, source-only TypeScript protocol contract**. It is not an Android or iOS plugin, a transport adapter, or evidence that native accounts work. It registers no plugin, performs no requests, installs no native configuration, and stores no credentials. `CloudClient` continues to set its endpoint to `null` on native platforms, and native Account UI remains disabled. A plugin claiming `available: true` must never, by itself, enable that UI.

`src/nativeAccountContract.ts` contains pure validators, immutable copied values, constants, and a port declaration. Its only import is an erased type import for the existing `CloudSession` shape. The existing web cookie transport is unchanged. All tests use synthetic data.

Actual native activation requires a separate approved implementation and review of the native isolation, credential lifetime, transport, lifecycle cancellation, packaging, server configuration, UI consent/confirmation, and physical-device behavior described below. Passing these TypeScript tests does not establish those properties.

## Port and local operations

Every value must have exactly the documented fields. No operation accepts a URL, origin, headers, cookies, bearer, caller-selected limits, redirects, or transport recipient. Version 1 does not negotiate other versions.

```ts
interface NativeAccountPort {
  capabilities(query: { version: 1 }): Promise<{ version: 1; available: boolean }>
  startContext(context: { version: 1; contextId: string }): Promise<{ version: 1; contextId: string }>
  clearContext(context: { version: 1; contextId: string }): Promise<{ version: 1; contextId: string }>
  request(command: {
    version: 1; contextId: string; requestId: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: JsonValue
  }): Promise<{
    version: 1; contextId: string; requestId: string; status: number; body?: JsonValue
  }>
}
```

`capabilities`, `startContext`, and `clearContext` are strictly **local-only and must never make network requests**, including session checks, telemetry, logout, refresh, discovery, or endpoint probes. Capability queries must not load stored credentials. Unconfigured or unsupported implementations report `available: false` without probing a service.

Starting a context establishes a new native-owned generation, cancels prior requests, and removes any prior account/credential. It is not a login. Clearing a matching context discards local credentials and closes that generation. Clearing an old context must never clear a newer one. An acknowledgment must echo the context ID exactly. A clear acknowledgment means only that local context handling finished; it never confirms server logout or revocation.

Contexts and requests use fresh random UUIDs. Validators accept canonical lowercase RFC UUID versions 1–5 with a valid variant; use cryptographically random UUIDv4 values when generating them. The nil UUID, uppercase aliases, malformed IDs, and trailing characters are rejected. IDs are correlation/cancellation identifiers, not authentication credentials. The actual implementation must prevent reused/duplicate request IDs within a context and reject requests for a closed, unknown, or stale context. This stateless contract does not maintain a replay ledger.

## Fixed packaged destination

`nativeAccountEndpoint(packagedConfig, expectedEndpoint)` returns the endpoint only when both trusted native-package values exactly match and are a canonical HTTPS URL ending exactly in `/api/native/v1`. Missing, unsafe, normalized, or mismatched configuration returns `null` and must disable requests before any network access.

Both inputs must come from reviewed, packaged native configuration or compile-time policy. Neither may come from JavaScript, the document origin, a user form, runtime remote configuration, an environment fallback, or another service response. Comparing an untrusted endpoint with itself is not recipient binding.

The parser rejects HTTP, including HTTP localhost/loopback, credentials, query strings and fragments (including empty delimiters), whitespace, backslashes, percent encoding, traversal, wrong prefixes, trailing slashes, uppercase-host normalization, and default-port normalization. HTTPS has no insecure native localhost exception. A canonical non-default HTTPS port is allowed only when it is the exact trusted packaged recipient. A URI parser does not establish ownership of a host or replace TLS validation.

Future native transport must append only the reviewed relative path to that endpoint, recheck the final recipient, reject all redirects and browser-style URL rewriting, validate TLS normally, and disable cookies, caches, referrers, shared WebView network state, and response-header exposure. It must not fall back to WebView fetch, page-origin requests, a generic HTTP plugin, or another endpoint when unavailable.

## Positive logical operation allowlist

Paths are relative, without a leading slash. No URL scheme, query, fragment, encoded character, dot segment, whitespace, extra slash, or arbitrary suffix is accepted. Each method/path combination fixes the allowed successful HTTP status (or the explicitly documented feedback replay pair). `ID` is a canonical lowercase UUID; native dynamic IDs deliberately narrow the web client's generic bounded ID syntax to the native backend's UUID identifiers.

| Method | Relative path | Success |
| --- | --- | --- |
| POST | `auth/login` | 200 |
| GET | `auth/session` | 200 |
| POST | `auth/register` | 202 |
| POST | `auth/logout` | 204 |
| POST | `auth/verification/request`, `auth/password-reset/request` | 202 |
| POST | `auth/verification/confirm`, `auth/password-reset/confirm` | 200 |
| GET, PUT | `consent`, `sync` | 200 |
| POST | `account/export` | 200 |
| DELETE | `account` | 204 |
| GET | `coaching` | 200 |
| POST | `coaching/invitations`, `coaching/invitations/cancel` | 202 |
| POST | `coaching/invitations/ID/accept` | 200 |
| DELETE | `coaching/invitations/ID` | 204 |
| PUT | `coaching/relationships/ID/consent` | 200 |
| DELETE | `coaching/relationships/ID` | 200 |
| GET | `coaching/relationships/ID/snapshot`, `coaching/relationships/ID/feedback` | 200 |
| POST | `coaching/relationships/ID/feedback` | 201 creation; 200 same-operation replay |
| DELETE | `coaching/relationships/ID/feedback/ID` | 204 |
| GET | `challenges` | 200 |
| POST | `challenges/invitations` | 202 |
| POST | `challenges/invitations/ID/accept` | 200 |
| DELETE | `challenges/invitations/ID` | 204 |
| PUT | `challenges/ID/consent` | 200 |
| DELETE | `challenges/ID`, `challenges/ID/consent` | 200 |
| POST | `challenges/ID/block` | 204 |
| GET | `challenges/ID/counts` | 200 |

Feedback POST admits the server’s 201 creation and 200 same-operation replay transport statuses. This does not authorize an automatic retry or bypass the existing domain checks of `replayed`, feedback content, and relationship version. The current coaching client may still reject an unexpected replay.

GET forbids a body. Every write requires a JSON object body, including `{}` for operations without parameters. The contract checks transport structure and JSON bounds; it does not replace account, state, coaching, challenge, or server validators.

The existing challenge consent body legitimately contains a reviewed counterpart in `body.recipient`. The bridge must preserve that business field exactly, as it preserves invitation email, relationship/challenge IDs, versions, policy versions, confirmation, and consent scopes. It must not rewrite recipients or widen consent. Transport-level `recipient`/`endpoint` overrides are prohibited. Deep immutable copies prevent later caller mutation from changing a reviewed command. The caller and server must still verify the intended counterpart and enforce the existing explicit-review/confirmation workflow; a UUID or transport validator does not grant consent.

## Credential and response boundary

The native server's successful login wire shape is:

```ts
{ session: { user, csrfToken, sessionExpiresAt }, nativeToken: raw }
```

**Only native code may receive or extract `nativeToken`.** It must positively validate this wire envelope inside the isolated transport and install the raw bearer only after checking that the captured native generation/context/account is still current. The raw wire envelope must never be passed to JavaScript for validation or redaction.

The bridge's successful login and session body is exactly the existing sanitized `CloudSession` shape:

```ts
{
  user: { id, email, emailVerified, createdAt },
  csrfToken,
  sessionExpiresAt
}
```

The TypeScript validator rejects unknown keys at both levels, missing fields, malformed data, expired sessions, and expiry more than eight hours after the explicit validation clock. It rejects `{ session, nativeToken }` and a `nativeToken`, bearer, cookie, header, password, or other extra field alongside the permitted fields; it does not silently strip raw secrets. Timestamps use canonical UTC millisecond ISO strings. The returned session and user are detached and frozen.

The native layer retains its validated session CSRF context and adds the protocol header itself. Request envelopes intentionally have **no `csrfToken` input**. The sanitized response retains the existing field for shape compatibility, but JavaScript cannot override the native-held value. This CSRF value is derived from the bearer and provides protocol/session context binding, **not an independent factor or additional proof of possession**. JavaScript context/request IDs separately bind views, requests, and cancellation. Neither mechanism replaces native bearer authentication.

Every non-204 successful body must be a JSON object; scalar values (including a bare token string), null, and arrays are rejected before any result is returned. A successful generic business response is bounded immutable JSON and still must pass the existing `CloudClient`, `coaching.ts`, `privateChallenges.ts`, and state/backup validators before use or restore. Every successful response also rejects top-level reserved credential/transport envelope fields (case-insensitively), including `nativeToken`, `token`, `accessToken`, `refreshToken`, `bearer`, `authorization`, `headers`, cookie fields, credentials and passwords. This prevents a raw login or HTTP envelope from passing under a different business route. Nested business field names and user notes are not scanned for words such as `Bearer`, `cookie`, or `nativeToken`: such content may be legitimate user data. Transport credentials and metadata must be excluded by the native implementation's positive response shaping, not by scanning business strings.

Replies must exactly echo the reviewed command's version, context ID, and request ID. Unexpected success statuses, informational statuses, redirects, status zero, noninteger statuses, and statuses outside 400–599 for errors are rejected. A successful 204 must omit `body`; other successful statuses require it. Correlation validation is necessary but does not detect a repeated reply: the implementation and caller must accept only one terminal result for each currently pending request.

Errors may omit the body or use only:

```ts
{ error: { code: 'service_error' } }
{ error: { code: 'csrf_failed' } } // only HTTP 403
{ error: { code: 'sync_conflict', details?: { revision: nonnegativeSafeInteger } } } // only HTTP 409
```

Native code must map other upstream codes to the fixed `service_error` code and preserve the HTTP status. It must discard upstream error messages, headers, cookies, arbitrary details, and exception text. This is a deliberate normalized future protocol, not an existing live CloudClient adapter. Current source branches specially only on `csrf_failed` and `sync_conflict`; other user messages depend on status. Validator failures expose only a static `NativeAccountContractError` message and never include input or upstream values. Local failures such as cancellation/timeouts must also use fixed native error codes/messages without private diagnostics.

## Fixed JSON and resource budgets

Limits are source-controlled and immutable; callers cannot override them:

- Ordinary request body: 8,192 UTF-8 JSON bytes
- `PUT sync` body: 10 MiB + 1,024 UTF-8 JSON bytes, aligned with the native API
- Ordinary successful response body: 10 MiB + 64 KiB, matching the existing cloud read budget
- Challenge successful response body: 256 KiB
- Account export successful response body: 64 MiB
- Sanitized error body: 1,024 bytes
- Total envelope: applicable maximum body budget plus at most 1,024 bytes; exact envelope fields impose an additional narrow bound
- Depth: 32; total JSON nodes: 1,000,000 per validated value
- Native request timeout: 20 seconds; native absolute session lifetime: eight hours; idle lifetime: 30 minutes; no refresh

Native code must enforce byte limits while reading the wire, before parsing/bridging it. JavaScript validators operate on already-decoded values and do not prevent allocation of an oversized native response. They count serialized UTF-8 JSON bytes, including escaping, and reject undefined values, nonfinite numbers, negative zero, bigint, functions, symbols, cycles, sparse/extended arrays, accessors, hidden properties, custom prototypes, `toJSON` hooks, and excessive depth/node count. JSON data is copied and frozen only inside the validation call; a malformed value returns no partial reviewed result and never mutates caller data. Pure validators do not execute native actions.

## Required native lifecycle and isolation implementation

A future implementation must enforce these properties independently on both Android and iOS:

1. Restrict access to the intended packaged top-level application context. No arbitrary WebView, remote navigation, frame, URL scheme, or injected bridge wrapper may select the service or obtain credential material. Keep network/credential ownership outside JavaScript and shared WebView cookie stores.
2. Own the authoritative session generation, account identity, current context, token, CSRF binding, pending-request ledger, timeout, absolute expiry and idle deadline in native memory. Do not store bearer tokens, passwords, CSRF data, or private responses in preferences, SQLite, WebView storage, backups, logs, analytics, crash messages, URLs, or clipboard. No implicit restoration after process death.
3. Clear locally on account-route departure, backgrounding, process death, account change, session expiry, context clear, and malformed authentication responses. Lifecycle hooks are a prerequisite, not a feature inferred from capabilities. Returning to foreground must require a fresh context/login as appropriate.
4. Capture the native generation/context/account before each asynchronous operation. Check them again before credentials are installed, before every private response is emitted, and after each parse, disk/network callback, or other asynchronous boundary. Late login/session callbacks must never install a token, resurrect a cleared account, or clear a newer account. Rotate native session generation on successful reauthentication even for the same account.
5. Make timeout/abort terminal and advance the relevant cancellation fence before cancellation acknowledgment. Aborting an HTTP task is insufficient: queued callbacks must be unable to install credentials or emit private data afterward. Do not blindly retry writes. Require a fresh state/revision inspection after an uncertain upload outcome, preserving the existing CAS/idempotency rules.
6. Enforce eight-hour absolute and 30-minute idle expiration natively without extending the absolute deadline. Never refresh or silently reauthenticate. Server checks remain authoritative too; capability/context operations do not count as network session activity.
7. Treat `clearContext` only as local credential disposal. Only a successfully correlated explicit `POST auth/logout` 204 may confirm server logout. A network failure, timeout, local clear, background event, or process death must never be described as server logout/revocation. A late old logout must not clear a newer session.
8. Preserve existing authorization, verification, consent, recipient review, typed destructive confirmation, revision inspection, and response/domain validation. Never auto-upload device data or auto-grant coaching/challenge access as part of startup, capability discovery, login, or session checking.

## Design evidence and primary references

Reviewed against installed `@capacitor/core`, `@capacitor/android`, and `@capacitor/ios` version **8.5.3**. Recheck native behavior when upgrading; the following observations are version-bound.

- [Capacitor HTTP documentation](https://capacitorjs.com/docs/apis/http): native `fetch`/`XMLHttpRequest` patching defaults off; direct native HTTP helper methods are also available and accept general URLs/headers. Default-off patching is not an account-specific isolation boundary.
- [Capacitor Cookies documentation](https://capacitorjs.com/docs/apis/cookies): native cookie helpers and optional `document.cookie` patching are separate exposed capabilities; patching defaults off. Installed Android `CapacitorCookies.java` registers a default `CookieHandler` during plugin loading, and `CapacitorCookieManager.java` uses the WebView cookie manager. Installed iOS `CapacitorCookieManager.swift` uses shared cookie storage and synchronizes with the WebView; `HttpRequestHandler.swift` also invokes that synchronization.
- [Capacitor configuration documentation](https://capacitorjs.com/docs/config): remote `server.url`, cleartext traffic, and expanded `allowNavigation` are development-oriented options marked unsuitable for production. Account transport must not depend on broadening navigation or weakening transport configuration.
- [Android HttpURLConnection documentation](https://developer.android.com/reference/java/net/HttpURLConnection): cookie management can be VM-wide through `CookieHandler.setDefault`. A new `HttpURLConnection` alone is therefore not proof of a separate cookie context.

The requirement for a custom, narrow, credential-owning account boundary is **this project's design inference** from those references, the installed native source, and the stated privacy/lifecycle requirements. These sources do not mandate this exact protocol, its method names, lifetime policy, or implementation architecture. A real plugin must demonstrate isolation with native implementation evidence and device tests; this contract does not provide it.

## Exports and verification

- `nativeAccountEndpoint(packagedConfig: unknown, expectedEndpoint: unknown): string | null`
- `readNativeAccountCapabilitiesQuery(value: unknown): NativeAccountCapabilitiesQuery`
- `readNativeAccountCapabilities(value: unknown): NativeAccountCapabilities`
- `readNativeAccountContext(value: unknown): NativeAccountContext`
- `readNativeAccountContextReply(value: unknown, context: NativeAccountContext): NativeAccountContext`
- `readNativeAccountRequest(value: unknown): NativeAccountRequest`
- `readNativeAccountSession(value: unknown, now: number): NativeAccountSession`
- `readNativeAccountReply(value: unknown, request: NativeAccountRequest, now: number): NativeAccountReply`

`now` is an explicit epoch-millisecond integer so session validation is deterministic; the implementation must supply a trusted current clock and enforce idle/absolute lifetime itself. Reviewed commands, capabilities, contexts, sessions and reply data are detached immutable copies. The reply reader revalidates the supplied expected command before correlating the reply.

Run the synthetic contract suite together with the existing native-disablement regression in `src/cloud.test.ts`. Also run TypeScript, lint and `git diff --check`. No native sync, platform build, browser, production credentials or live service calls are required for this contract. Native activation remains a separate, blocked release milestone until a real isolated plugin and its lifecycle/negative-path tests are approved.
