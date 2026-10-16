# Native account protocol foundation

This is a **source-only, default-off protocol**, not a released native account feature.
The shipping client remains disabled. No native bridge, device validation, real mail,
real credentials, health-data transfer, public service, or deployment is included.

## Enablement and boundary

`nativeAccountsEnabled: true` (integration config) or exactly
`FITFLOW_NATIVE_ACCOUNTS_ENABLED=true` opts into the separate `/api/native/v1`
namespace. Omission and every other environment value keep it off. Disabled requests
return `503 native_accounts_disabled`. The flag requires secure HTTPS configuration;
it cannot be combined with insecure localhost cookies. Configuration does not prove
TLS termination: an approved HTTPS proxy, hosting/privacy operations and transport
review remain required before real use. Tests use synthetic loopback HTTP with secure
configuration and never claim to validate production TLS.

`/api/v1` keeps its exact web Origin, CSRF, credentialed CORS and
HttpOnly/SameSite=Strict cookie policy. Native requests never impersonate that channel.
The route selects the channel; a client header cannot change it. The immutable
per-request channel and headers are captured through asynchronous password checks.

Every native request must:
- Use an exactly supported method/path under `/api/native/v1`
- Send exactly `X-Fitflow-Client: native-v1`
- Omit **all** Origin, Cookie and Sec-Fetch-* headers, even empty values
- Use JSON for mutations, with no compressed bodies, query, fragment, redirect alias,
  trailing-slash/percent-encoded/dot-segment alias, HEAD or OPTIONS/preflight support

The marker is only a transport discriminator. It does **not** prove installed-app
identity, authenticity or possession of a session. Non-browser clients can set it.
Native responses never grant CORS and never set or clear cookies, including errors,
logout and deletion. HTTP validates raw header pairs before consuming Node's
normalized/discarded values. Declared and undeclared request trailers are rejected before route dispatch, so they
cannot smuggle a second browser/auth context after initial headers.
Case-insensitive duplicates or array-valued authorization,
origin, cookie, client, CSRF, content-*, Sec-Fetch-* and transfer-encoding headers fail
closed; direct `app.handle` calls get equivalent safe key normalization.

## Shared account and business routes

The existing account routes, manual verification/reset, consent, full-state sync,
export and deletion are available under the native prefix through the **same business
implementation**. Existing request/response shapes are unchanged except native login:

```json
{
  "session": {
    "user": { "id": "UUID", "email": "synthetic@example.test", "emailVerified": true, "createdAt": "ISO" },
    "csrfToken": "derived session-context value",
    "sessionExpiresAt": "ISO"
  },
  "nativeToken": "43-character random base64url bearer"
}
```

That login envelope is private to a future native-only bridge. Only login returns the
raw native token. Session reads return the existing session view, without nativeToken.
No response error, export, database record, URL, cookie or application log contains it.
There is no request/body/access logging and no debug credential endpoint.

Every protected native read and write, **including GET /auth/session**, requires:
- Exactly one `Authorization: Bearer <43-character base64url token>`
- `X-CSRF-Token` matching `csrfFor` of that bearer

The CSRF value is deterministically derived from the bearer. It binds the current
account context and is **not an independent authentication factor**. There is no
cookie fallback. A native token cannot authenticate a web cookie, and a web token
cannot authenticate a native bearer.

Native aliases also expose the existing coach/challenge routes. Their independently
default-off gates run on the trusted logical route. Current verification/policy,
recipient/category consent, account scoping, CAS, idempotency, revocation and bounded
invitation/feedback rules remain in the shared implementations. Native account
opt-in never enables either collaboration feature. Shared IP, email, account reauth,
coach and challenge budgets cannot be multiplied by switching transport namespaces.

The general body limit is 8 KiB. Exactly `PUT /api/v1/sync` and
`PUT /api/native/v1/sync` get the existing 10 MiB state plus 1 KiB envelope allowance,
at both app and HTTP body-reader layers. Aliases and other methods do not get it.

## Sessions and database v6

Migration from v5 to v6 is additive in the existing `BEGIN IMMEDIATE` startup
transaction, with the version read under the lock. It creates only `native_sessions`
and its user index; all existing rows and grants are preserved. Every open validates
column types, primary key, NOT NULL, STRICT, cascading user foreign key and the
nonunique/nonpartial user index before committing the schema version. Collisions or
malformed v6 reopens fail closed and roll back all schema/data/version changes. Earlier schemas keep
their existing migrations. The native table has token_hash, user_id, expires_at,
last_seen and credential_binding; user_id references users with ON DELETE CASCADE.

- Raw tokens are 256 random bits and only SHA-256 token hashes are stored
- Native lifetime is a fixed **8 hours absolute**, **30 minutes idle**, with no refresh
- Authentication and post-password reauthentication check a domain-separated digest
  of the **current password hash** against credential_binding
- The binding does not use reset_generation: merely requesting recovery cannot log
  an account out; replacing its password invalidates the binding
- Web sessions remain in their own table with their unchanged seven-day lifetime
- Issuance holds one immediate transaction for credential recheck, pruning, shared
  cap enforcement and insertion. There are at most **10 total sessions per account**
  across both channels; deterministic ordering retains the nine most recently seen
  existing sessions before inserting the new one
- Login rechecks the credential after async hashing under the issuance lock, so
  password replacement/deletion cannot issue a stale session
- Reset/verification confirmation deletes sessions in **both** tables, even with the
  native flag off. Account deletion cascades both. Native logout deletes only its
  authenticated current native session and does not clear browser cookies
- Lazy expiry pruning handles both tables regardless of enablement

V6 readers reject future schemas. The prior v5 server rejects v6 before migration
writes; rolling application code back is therefore **not** a database downgrade.
Never lower user_version manually or attempt a mixed-version live rollout. Any future
operational migration needs approved backups, a synthetic restore rehearsal and a
reviewed roll-forward/recovery plan. Synthetic tests constructing historical fixtures
are not operational downgrade instructions.

## Future bridge and release gates

The native bridge must own the volatile bearer, strip the private login envelope to
the validated existing JS session shape, and never expose bearer, response headers or
cookies to WebView JS/storage. It needs a hardcoded HTTPS origin/path/method allowlist,
no redirect following, an isolated cookie-free transport, and native-owned generation
fences for every operation and token installation. Cancel/logout/background/new login
must prevent delayed results from restoring or clearing newer identity. Clearing a
local token does not prove server revocation; a cancelled/lost login can leave a
bounded server session until expiry.

The current web “check existing session” bootstrap cannot be reused if it first
clears a volatile native token. No native UI or bridge is enabled by this change.
Existing JS generation fences, manual upload review, consent, CAS/conflict/replay and
local-data protections remain necessary. Actual iOS/Android cookie isolation,
redirect behavior, lifecycle cancellation, memory handling and device acceptance
must be independently tested before release. This protocol is not app attestation.

## Synthetic verification

`npm run test:server` runs the existing account/coaching/challenge regressions plus
native protocol tests. They cover parsing on direct calls and loopback HTTP,
default-off/feature gates, token-domain separation, exact login/session contracts,
shared limits/cap, idle/absolute expiry, binding and reset/deletion races, async
reauthentication, consent/CAS/replay/revocation, secret exclusion, atomic migrations,
record preservation, future-schema refusal and foreign-key cascades. The immutable
pre-v6 reader is separately checked against a disposable v6 synthetic database.
No production endpoints, user data, real credentials or mail are used.
