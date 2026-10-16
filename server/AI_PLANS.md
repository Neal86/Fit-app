# Consent-bound AI composition boundary (disabled)

This source implements a web-only server boundary, not an active AI service. The production entry point injects no AI adapter and no provider policy. `FITFLOW_AI_PLANS_ENABLED=true` alone cannot enable transmission. No live provider, credential, endpoint, model, deployment, or billing integration is supplied or exercised. Tests use synthetic data and an in-process synthetic adapter only.

Composition can only arrange references to the user's explicitly selected movement candidates under the exact submitted constraints. It does not invent movements, modify prescriptions, diagnose conditions, or establish exercise suitability. Resource/feasibility validation is not fitness or medical advice. The local review/save path remains separate from generation.

## Consent and policy

The browser must show the complete exact canonical payload and complete recipient policy, then obtain explicit consent before calling **prepare**, even though prepare sends only a digest and byte count. It must never send candidate data to prepare. It sends the full candidate request only to generate, with explicit consent to the same canonical payload digest, byte length, revision, and full-policy digest.

A policy is a closed JSON object:

```json
{
  "version": 1,
  "revision": "operator-assigned-version",
  "backendOperator": "Exact backend organization receiving the payload",
  "provider": "Exact AI processor",
  "model": "Exact approved model",
  "processingDestination": "Exact processing service/destination disclosure",
  "processingRegion": "Exact processing region disclosure",
  "retention": "Complete backend and provider retention terms",
  "training": "Complete provider training/data-use terms",
  "cost": { "currency": "USD", "maxChargeMinorUnits": 0 },
  "cancellationMayCharge": true,
  "limits": {
    "requestBytes": 65536,
    "outputBytes": 32768,
    "timeoutMs": 15000,
    "intentTtlMs": 300000,
    "resultTtlMs": 600000
  }
}
```

This is a shape example, **not an approved operational policy**. Every disclosure must be truthful, concrete, and complete before any separately authorized activation. Required strings cannot be empty, untrimmed, contain control characters, or exceed 1,024 UTF-8 bytes (revision: 80). Currency is an uppercase three-letter identifier; the declared maximum is an integer from 0 through 100,000 minor units. Zero is used by the synthetic tests. The code cannot verify actual downstream billing, location, retention, or training behavior. The declared per-request cost bound is passed to the trusted adapter; a future adapter must enforce its provider's supported cost controls. There is no exactly-once billing guarantee.

The full policy digest is lowercase SHA-256 over UTF-8 canonical JSON with recursively sorted object keys (`server/security.mjs` canonicalization). It includes every policy field, including version, revision, disclosures, cost, and fixed limits. Changing metadata while retaining the same revision changes this digest and requires new review/consent. The browser must verify the policy digest and recheck account, request, intent, and current full-policy digest before accepting a result for local review/save. Runtime policy and feature configuration are immutable startup snapshots; mutating the original config object is not an activation/revocation control. Replace/close the app instance when changing configuration. Adapter enablement and its full-policy binding are checked live.

## Exact API

All routes use `/api/v1/ai-plans`. They require an authenticated, verified **browser** account, `X-Fitflow-Client: web`, and the current session's `X-CSRF-Token`, including reads. Read requests may omit Origin, as ordinary same-origin browser GETs do; a supplied Origin must exactly match the configured origin, and cross-site fetches are rejected. POST requires the exact Origin and JSON content type. AI paths are deliberately absent from the native allowlist. No credentials or payload are accepted in query strings.

- `GET /policy`: empty body; returns `{policy, policyDigest}`
- `POST /prepare`: exact `{policyRevision, policyDigest, payloadDigest, payloadBytes}`; returns HTTP 201 prepared view
- `POST /:intentId/generate`: exact `{request, consent: {accepted: true, policyRevision, policyDigest, payloadDigest, payloadBytes}}`; returns an intent view after completion or cancellation/timeout. An exact concurrent replay returns HTTP 202 running view and never redispatches
- `GET /:intentId`: empty body; returns current view, including result only while complete and still valid
- `POST /:intentId/cancel`: exact `{}`; cancels and erases any result; repeated cancellation never dispatches

Each view has exactly `{intentId, status, policyDigest, expiresAt}`. `status` is `prepared`, `running`, `complete`, `cancelled`, `expired`, or `failed`. Complete adds `result` containing only the shared closed `AiPlanOutput`. Failed adds a fixed safe `{code, message}` error (`ai_failed`, `ai_timeout`, or `ai_invalid_output`). No raw request, provider text, exception, or response body is echoed. `expiresAt` is an ISO timestamp. Preparation lasts at most five minutes; after dispatch, result/terminal-record retention lasts at most ten minutes, both bounded further by absolute session expiry. Expired metadata-only tombstones can remain for one additional minute. Missing, removed, or pre-restart IDs return 404.

`payloadDigest` is lowercase SHA-256 of UTF-8 `canonicalAiPlanRequest(request)` from the shared `src/aiPlanContract.ts`; its explicit schema property order differs from full-policy sorted-key canonicalization. `payloadBytes` is that exact UTF-8 byte length, not JavaScript string length or arbitrary input JSON length. The server repeats shared strict validation and canonicalization before dispatch. Unknown keys, additional health/profile data, impossible constraints, or mismatched digest/length cannot dispatch. The raw generate envelope is capped at 65,536 + 2,048 bytes, before parsing. Native/unrecognized routes do not receive this larger limit.

## Single-use intent and auth lifecycle

The server creates an unpredictable 256-bit intent ID and stores its account, exact browser-session token hash, absolute session expiry, password binding, verification/reset generations, policy digest, payload digest, and byte count in a bounded memory registry. Client-supplied IDs never create entries. The first permitted dispatch transitions the existing intent synchronously to running before the only adapter call. Replays of running or terminal states cannot dispatch again. Cancellation, timeout, expiration, deletion, and server restart cannot restore a previously issued intent. After TTL eviction/restart, the old ID is simply unknown; a new reviewed consent flow is required for a new server-issued ID.

Authentication is checked immediately before the outbound call, during a pending call, immediately after settlement, and before exposing a response/status. Logout, replacement/eviction of a browser session, password-reset request/confirmation, and account deletion revoke associated intents and erase results. Password changes, reset/verification generation changes, session expiry/idle expiry, and deleted users are checked against live database records, not a pre-await authentication snapshot. Timers erase expired results without waiting for another API request.

An actual premature HTTP disconnect reaches `app.handle` as an AbortSignal: `req.aborted` or `res.close` before `res.writableFinished`. Normal `IncomingMessage.close` after reading a request is **not** treated as cancellation. Cancellation signals the adapter and erases the result, but cannot retract already transmitted data, guarantee the provider stops, or prevent a provider charge. A timeout has the same limitation. Starting a different intent is a separately consented attempt and can cause another charge while an earlier external request's outcome remains unknown after a process crash.

## Resource and privacy controls

- At most 128 registry entries, including retained tombstones; at most two prepared/running/complete intents per account
- At most one provider call in flight across all app instances **in this Node process**; no queue
- A 15-second response timeout, no automatic retry, no fallback provider/model
- Cancellation/timeout does **not** release provider concurrency until the adapter's promise actually settles; an adapter that ignores abort and never settles keeps the boundary closed to new dispatches
- Prepare quotas: six per account per hour, twelve per account per day, 120 globally per hour, and 240 globally per day; cancellation never refunds preparation budget, preventing one account from filling the registry through prepare/cancel churn
- Conservative reserved-dispatch quotas: three per account per hour, ten per account per day, and thirty globally per day; fixed windows start at the first counted attempt, using existing durable hashed `rate_limits` counters and an atomic transaction
- Validation, busy, or quota refusals before transition do not dispatch; the server never automatically retries them. A reserved attempt can count against quotas even if cancelled immediately before the adapter is entered
- Request canonical data is bounded to 64 KiB; raw provider JSON text is bounded to 32 KiB **before** JSON parsing and then passed through the closed shared output validator
- No new database table, request/output persistence, request-body logging, provider-error logging, analytics event, account-export field, or backup format field is introduced
- Only prepare/dispatch counter hashes/counts/windows are added to persistent storage; payload/intent/policy bindings and generated output stay in bounded process memory

Hashed abuse counters are not anonymous guarantees. Account deletion invalidates live intents and removes exposed results; minimal in-memory replay tombstones remain until their bounded expiry. It does not remove shared-table counters immediately. Their windows expire within one day; expired rows are removed by the existing request-time pruning, so a completely idle database may retain expired rows until it is next used. Production retention and backup cleanup remain operator acceptance requirements.

A trusted adapter can retain its own references while running; the boundary cannot erase an ignored-abort adapter's memory. The global slot bounds that unresolved work to one call. Multi-process/horizontally scaled live operation is outside this disabled slice: it needs a separately approved distributed concurrency/spend design, provider controls, privacy review, and truthful policy. Restart prevents intent replay but is not proof that a previously submitted external operation stopped or was not charged. Quotas are technical throttles, not billing guarantees.

## Adapter integration contract

`createApp` takes `aiAdapter`; configuration takes `aiPlansEnabled: true` and `aiPlanPolicy`. All three, including the exact valid full-policy digest, are necessary. Incomplete/invalid policy, missing/disabled adapter, or policy-binding mismatch fails closed. Main supplies neither policy nor adapter. No live HTTP adapter, arbitrary request URL, or client-selected endpoint/model exists.

A trusted injected adapter has `{enabled: true, policyDigest, generate}`. `generate` receives `{request, policy, policyDigest, signal, maxOutputBytes}` and returns a promise for raw JSON **text**. It must implement the approved recipient/model, enforce the passed cost/output bounds, honor abort where possible, avoid logging sensitive payloads, and return at most the raw UTF-8 output limit. It must not mutate the frozen request/policy. The function is captured at setup; changing its method later does not swap the active implementation. The boundary rechecks adapter enablement and policy binding before/after dispatch. Tests inject synthetic implementations only.

## Verification

Focused tests cover disabled/malformed configuration, full-policy binding, exact canonical consent, web-only authenticated access, native rejection, replay/cancellation/restart, auth mutation during dispatch, output closure/byte bounds, ignored-abort concurrency, registry and durable quotas, no raw database/export data, normal HTTP body close, and premature HTTP disconnect. Run with already installed tools after compiling the shared contract; no registry install or live provider is needed:

```sh
node node_modules/typescript/bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir .server-build --skipLibCheck src/stateValidation.ts src/aiPlanContract.ts
node --test --test-concurrency=1 server/test/ai-plans.test.mjs server/test/http.test.mjs
node node_modules/eslint/bin/eslint.js server --max-warnings=0
```
