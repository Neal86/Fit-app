# Optional self-hosted account and sync API

This is a tested **source foundation**, not a deployed health-data service. The existing web app stays local-first. No account is created, no mail is sent, and no health state is uploaded just by building or starting the web app.

## Run and test

The optional API requires **Node.js 24.15+** and uses native `node:http`, `node:crypto`, and `node:sqlite`, with no new production dependencies. The web-only app still supports Node 22+. SQLite is a Node release-candidate API in the required runtime; pin and test a supported Node 24 release before operation. Tests use synthetic fixtures and a private in-memory mail adapter. They never send real mail.

```sh
npm ci
npm run test:server
npm run check
```

`server:build` compiles the shared `src/stateValidation.ts` validator into ignored `.server-build/`. `src/storage.ts` re-exports the same validator, so local imports and the API do not maintain competing fitness schemas. The API rejects older backup versions until the client migrates them locally; integrate future schema changes in this shared module. `server/state.mjs` adds a 10 MiB limit and bounded nesting. Build after schema changes.

`npm run server:start` refuses to run unless `FITFLOW_SERVER_ENABLED=true`. `.env.example` provides a synthetic loopback configuration. Native startup has **no live mail adapter**: registration, verification resends, and password-reset requests return `503 email_unavailable`. There is no debug-token endpoint and no token logging mode.

The integration entry points are `openDatabase`, `createApp({db, config, mail, now?})`, and `createHttpServer(app)`. `app.handle` is also used for deterministic integration tests, while HTTP tests start a real loopback server to verify parsing, cookies, request limits, and headers. Do not expose an adapter or database path supplied by an HTTP caller.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FITFLOW_SERVER_ENABLED` | `false` | Explicit server opt-in |
| `FITFLOW_NATIVE_ACCOUNTS_ENABLED` | `false` | Separate native protocol opt-in; requires secure configuration and an independently implemented isolated bridge, see [NATIVE_ACCOUNTS.md](NATIVE_ACCOUNTS.md) |
| `FITFLOW_COACHING_ENABLED` | `false` | Separate opt-in for bounded recipient/category-consented collaboration; see [COACHING.md](COACHING.md) |
| `FITFLOW_SERVER_HOST` | `127.0.0.1` | Bind address; no implicit public listener |
| `FITFLOW_SERVER_PORT` | `3001` | API port |
| `FITFLOW_APP_ORIGIN` | `https://localhost` | One exact permitted web origin, without a trailing slash |
| `FITFLOW_DATABASE_PATH` | `./.fitflow-data/fitflow.sqlite` | Private local SQLite file |
| `FITFLOW_ALLOW_INSECURE_LOCALHOST` | `false` | HTTP loopback development only; never a production bypass |
| `VITE_FITFLOW_API_URL` | empty | Optional client API base, including `/api/v1`; client integration must remain disabled unless explicitly configured |

Production mode expects an independently configured HTTPS reverse proxy; this Node entry point is not a TLS terminator. Never put a public listener in front of it before reviewing the deployment gates below. Forwarding headers are **not trusted**: rate limits use the direct socket address. A proxy therefore shares an IP bucket across clients; establish a vetted trusted-proxy policy and outer limits before scaling. Do not blindly trust `X-Forwarded-For`.

Use the same site for app and API, ideally one origin with `/api/v1` routed to this server. Secure sessions use `__Host-fitflow_session; Path=/; Secure; HttpOnly; SameSite=Strict`, with no Domain attribute. The exact origin allowlist alone does not permit cross-site cookies. In loopback development use the same hostname (`localhost` on both sides), and the explicitly non-Secure `fitflow_session` cookie. Native `capacitor://localhost` and cross-site native `https://localhost` API access are **unsupported** in this slice. Do not work around this by weakening cookies, allowing wildcard origins, or adding bearer-token storage to localStorage.

The separate native protocol foundation does not add WebView origins to this web allowlist. It uses `/api/native/v1`, an isolated session table and no cookie authentication. Its app bridge is deliberately unwired and native cloud access remains unavailable in the shipped UI. The shared SQLite schema advances to v6 transactionally; older servers reject it. Keep and verify a private pre-upgrade backup for deliberate rollback, and do not lower the schema version to force an older reader to open it. See [native security and migration boundaries](NATIVE_ACCOUNTS.md).

## API contract

All routes below are relative to `/api/v1`. Responses and request bodies are JSON except `204` responses, which have no body. No query parameters are accepted; never put email/reset/session tokens in URLs sent to the API. All responses use `Cache-Control: no-store`.

Every mutation requires:
- `Origin` exactly matching `FITFLOW_APP_ORIGIN`
- `Content-Type: application/json`
- `X-Fitflow-Client: web`
- For all authenticated requests, including consent/sync reads (except the bootstrap `GET /auth/session`), `X-CSRF-Token` from the current login/session response

Fetch with `credentials: 'include'`. Keep the CSRF token in memory. A same-origin GET may omit Origin; an explicitly foreign Origin or `Sec-Fetch-Site: cross-site` is rejected. Credentialed preflights allow only GET/POST/PUT/DELETE and the three listed request headers. API health is `GET /health` outside `/api/v1` and returns `{status:'ok'}` without data, paths, configuration, or mail credentials.

### Accounts

| Method and route | Body | Success |
|---|---|---|
| `POST /auth/register` | `{email,password}` | `202 {status:'verification_required'}`; no session |
| `POST /auth/verification/request` | `{email}` | `202 {status:'accepted'}` |
| `POST /auth/verification/confirm` | `{token}` | `200 {status:'verified'}` |
| `POST /auth/login` | `{email,password}` | `200` session view + Set-Cookie |
| `GET /auth/session` | none | `200` session view or `401` |
| `POST /auth/logout` | `{}` | `204`, revoke current session and expire cookie |
| `POST /auth/password-reset/request` | `{email}` | `202 {status:'accepted'}` |
| `POST /auth/password-reset/confirm` | `{token,password}` | `200 {status:'password_reset'}`; revoke every session and email token |

Session view:

```json
{
  "user": {"id":"UUID","email":"synthetic@example.test","emailVerified":true,"createdAt":"2026-10-15T12:00:00.000Z"},
  "csrfToken":"opaque value",
  "sessionExpiresAt":"2026-10-22T12:00:00.000Z"
}
```

Passwords are 12–128 characters, at most 512 UTF-8 bytes. Spaces are preserved. Emails are ASCII, normalized to lowercase, and at most 254 characters; internationalized addresses are not supported. Successful registration does not imply delivery if the address already belongs to a verified account. Request endpoints return the same accepted response for unknown/ineligible users; a provider failure returns a clear 503. Network/provider timing may still reveal differences; this is not a claim of perfect anti-enumeration.

Verification tokens expire after 24 hours; reset tokens after 30 minutes. Tokens are one-use, purpose-bound, and tied to a persisted request generation. A new request invalidates older tokens of that purpose immediately, before delivery. Only the current generation can be activated or consumed, so late mail cannot supersede a newer request. Delivery failure never leaves a usable new token or reactivates an old one. Re-registration reserves its generation before password hashing and retains its pending password separately; resend uses only that latest password. A resend while the newest password is still hashing returns `503 auth_busy`, asking the client to retry. Verification itself never auto-signs-in.

Database schema v5 adds the bounded, independent [private challenge tables](CHALLENGES.md#database-and-tests) without changing existing grants or snapshots. V4 added eligibility-independent invitation-attempt budgets to v3. The earlier v3 upgrade adds bounded coaching relationships/feedback to v2. Existing account/security/sync data and established relationships are preserved. All schema creation and migrations run in one immediate transaction, with the version read after acquiring the write lock. V1 databases also receive the existing security migration before the additive v3/v4/v5 migrations. The migration invalidates every existing email token. Because v1 could race unverified password binding, unverified accounts must register again with their chosen password; old pending credentials are cleared rather than reused by resend. Verified accounts, their password hashes, sessions, consent, and snapshots are preserved. Run the migration against a synthetic restored copy and review backups before any future production upgrade.

### Consent

`GET /consent` returns:

```json
{"healthSync":false,"policyVersion":"2026-10-15","updatedAt":null}
```

`PUT /consent` accepts exactly `{healthSync: boolean, policyVersion:'2026-10-15'}` and returns the updated view. The policy version is a protocol consent revision, **not approved legal text**. Consent must be informed by the actual complete state being uploaded, including profile, weight/body measurements, workouts/notes, previous plan versions, nutrition entries/manual targets, active session, preferences, and any future schema additions. Updating the scope may require a new version and renewed consent.

The server requires a verified account and current explicit consent for both sync reads and writes. Revocation synchronously removes the cloud snapshot and idempotency records, increments the monotonic revision as a tombstone, and leaves local data alone. Re-enabling consent does not restore deleted data. Export and account deletion remain available without sync consent.

### Versioned full-state sync

`GET /sync` returns `{revision, state, updatedAt}`. A new account has `revision:0`, `state:null`, `updatedAt:null`. Revisions are nonnegative safe integers; timestamps are ISO UTC strings.

`PUT /sync`:

```json
{"baseRevision":0,"operationId":"18aba8ca-ef7a-4bb9-b2e0-caa57cf65f55","state":{"version":4,"...":"valid current AppState"}}
```

Success is `200 {revision:1,updatedAt:'ISO',replayed:false}`. The whole state must pass the same validator as local backups. The server derives the owner exclusively from the session; a client-supplied `userId` or other unexpected envelope field fails. It never accepts a destination user ID.

On stale revision, `409 sync_conflict` includes `error.details.revision`, but does not silently overwrite or merge. Fetch the latest snapshot and ask the user to choose how to resolve it. The server clock establishes the revision; client timestamps never decide the winning write. Two writes from the same base cannot both win. Replaying an operation ID with the same canonical request returns the **original** revision/time and `replayed:true`, even after later writes; callers must GET current state instead of treating an old replay as the latest server revision. Reusing the ID with a changed payload returns `409 idempotency_conflict`.

Operation IDs are UUIDs, scoped per account and retained until consent revocation/account deletion. At 100,000 operations per account the server fails with `409 operation_limit` rather than silently forgetting deduplication. It stores only request hashes and result metadata in operation records, not old health snapshots. There is no background sync, queue, auto-merge, delta history, or cross-device push service in this backend. Client retry/queue behavior must preserve operation IDs and stop on explicit conflicts.

### Export and deletion

`POST /account/export` requires `{password}` and CSRF. It returns:

```json
{"format":"fitflow-account-export","version":1,"exportedAt":"ISO","user":{},"consent":{},"sync":{"revision":0,"state":null,"updatedAt":null}}
```

Only the current user's account/profile and health snapshot are exported. The optional-compatible `coaching` extension contains the caller's own related invitation/consent metadata and permitted authored/received feedback, never another athlete's snapshot; see the exact [coaching export contract](COACHING.md#account-export-and-deletion). The optional `challenges` extension includes only the caller’s accepted challenge metadata and own consent, never peer identity/consent/counts or pending-send receipts; see the [private challenge contract](CHALLENGES.md#frozen-wire-contract). Password hashes, session/reset tokens, rate-limit keys, and other users are excluded. Treat the downloaded file as sensitive. Local-only edits are not in this server export; export local app data separately when needed.

`DELETE /account` requires `{password,confirmation:'DELETE'}` and CSRF. It removes that account, cloud state, all sessions, all email tokens, operation metadata, and every associated coaching relationship/feedback row and private challenge/block row in one transaction, expires the cookie, and returns 204. Wrong password, missing confirmation, CSRF mismatch, and foreign account identifiers fail. Database deletion does **not** promise erasure of external backups or previously exported files; those need an approved retention/purge process. Local data is not remotely erased.

### Errors

```json
{"error":{"code":"sync_conflict","message":"Cloud data changed. Fetch it and choose how to resolve the conflict.","details":{"revision":2}}}
```

Use `code`, not message text, for client decisions. Important codes include `invalid_request`, `invalid_json`, `invalid_state`, `invalid_password`, `invalid_email`, `invalid_token` (400); `unauthenticated`, `invalid_credentials` (401); `origin_forbidden`, `csrf_failed`, `email_unverified`, `consent_required` (403); `sync_conflict`, `idempotency_conflict`, `operation_limit`, `revision_limit` (409); `body_too_large`, `state_too_large` (413); `unsupported_media_type`, `unsupported_encoding` (415); `rate_limited` (429, with Retry-After); `email_unavailable`, `auth_busy`, `server_busy`, `rate_limit_capacity` (503). Unexpected errors return a generic 500 without private diagnostic data.

## Optional coach collaboration

The separately default-off [coaching API](COACHING.md) implements verified recipient invitations/acceptance, independent athlete category consent, read-only saved-cloud projections, bounded plain-text training feedback, and immediate revocation checks. It sends no invitations, verifies no coaching qualifications, and provides no clinical advice. Account/cloud-consent deletion does not silently restore old grants. Its source tests and API contract do not authorize deployment or real health-data sharing.

## Email adapter boundary

Inject an explicitly enabled adapter:

```js
const mail = {
  enabled: true,
  async send({ kind, to, token, expiresAt }) {
    // Approved provider integration goes here. This repository supplies none.
  },
}
```

`kind` is `verify` or `reset`. The adapter must protect the address and token, avoid logs, use a verified application URL, and resolve only when delivery has been accepted. The service waits at most five seconds and activates the token only after success. If a provider may deliver after timeout, that message carries an inactive token; the user must request another. Put the token in a frontend URL fragment rather than a query when designing a mail link; frontend code should clear it after use and POST it in JSON. No automatic link consumption is supplied by the backend. A provider callback must not mutate the database or call the API internally. No payment, AI, OAuth, or mail provider is faked or enabled here.

## Security and operational limits

Implemented controls:
- Salted scrypt with N=131072/r=8/p=1 (128 MiB memory), a fixed reviewed policy, timing-safe comparison, dummy password work for unknown users, and at most two concurrent derivations
- 256-bit random sessions/email tokens, SHA-256 token storage, idle timeout 30 minutes and absolute session timeout 7 days; at most 10 sessions/account; reset/delete revocation
- Exact-origin checks, explicit custom request header, session-bound CSRF, JSON-only mutation bodies, no bearer tokens or tokens in browser storage
- SQLite parameterized queries, foreign-key cascades, immediate write transactions, persisted hashed rate buckets, per-email/IP/reauth limits, and bounded limiter-key storage
- 8 KiB general request bodies, 10 MiB state plus 1 KiB sync-envelope allowance, no compressed bodies, bounded JSON depth, four in-flight HTTP requests, 64 sockets, header/body timeouts
- No request/body/access logging; errors do not expose provider/database data; secure response headers and no-store responses; no service-worker API caching changes
- Private database file mode 0600 and newly created directory mode 0700; DELETE journaling and `secure_delete`; startup uses umask 077. Idle/expired auth rows and unverified registrations older than seven days are pruned lazily on API traffic

SQLite is a **single-process foundation**, not a multi-region service. Synchronous DB work can block the event loop, and counters/CPU limits need load testing and outer proxy controls. The database and user health state are not application-layer encrypted; file mode is not encryption. Use an approved encrypted volume, controlled access, backup encryption, retention, and restore verification before processing real data. Hashed rate-limit keys are pseudonymous, not proof of anonymization. No IP or user-agent audit trail is stored.

Before any real-data deployment: approve hosting/processors and location; finalize privacy/consent/retention text and scope; implement and review a real email adapter; establish HTTPS and same-site routing; review CSP/session lifetime and password recovery abuse; configure safe monitoring without request contents; verify encrypted backups and deletion across backup retention; exercise restore, incident response, and concurrent/load behavior; review independent security findings; validate actual browser cookie/privacy behavior; obtain explicit permission for deployment and data transfers. Native cloud auth needs a separately reviewed transport design. This source change does not authorize any of these steps.

## References

- [Node SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [Node crypto scrypt](https://nodejs.org/download/release/latest-v24.x/docs/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

The independently default-off [private challenge API](CHALLENGES.md) supports exactly two known accounts sharing only self-reported counts of recorded UTC training days over immutable 1–31-day windows. Both accept the relationship and separately review count consent; no prizes, public rankings, free text or automatic uploads. Explicit block prevents further pair requests. Cloud consent removal clears both challenge grants atomically; later opt-in never restores them.
