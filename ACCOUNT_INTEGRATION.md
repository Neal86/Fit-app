# Account and manual cloud-sync integration

This slice adds a real HTTP client and account page; it does not connect or deploy a provider. No network request runs merely because the page mounts. No credentials, CSRF tokens, snapshots, consent cache, or revision metadata are persisted in localStorage/sessionStorage. The existing local app remains fully usable without an API.

## Route wiring

The main app now exposes `/account` through Profile. For other integrations, import `Account` from `./components/Account` and add an optional `/account` route. The component owns its scoped CSS. Its props are:

- `state: AppState`: the current device state
- `onRestore(next: AppState): boolean`: an atomic device replacement. Return true **only after durable storage succeeds**; false must preserve existing state
- `client?: CloudClient`: optional stable client instance for tests/embedding; normally omit it

Use the existing transaction wrapper, for example:

```tsx
<Route path="/account" element={<Account state={state} onRestore={next => {
  const saved = update(() => next, 'Cloud copy restored')
  if (saved) { clearPlanDraft(); clearNutritionDraft() /* report cleanup failures */ }
  return saved
}} />} />
```

Expose the route through Profile or another appropriate navigation entry. Avoid adding automatic session checks in App. The user can explicitly choose “Check existing session” after returning to the page. Leaving the page aborts outstanding requests and discards the in-memory account context. Existing server cookies may remain until explicit sign-out or expiration; neither route exit nor a failed network logout claims server-side logout.

`Account` passes all downloaded state through the central `parseBackup`, so v2/v3/v4 migration and nutrition/plan-history validation remain the storage layer’s responsibility. It pauses the downloaded active timer before calling the transactional restore callback. On successful restore, the parent should clear stale plan-editor and nutrition drafts and report cleanup failure. Nothing should reset or replace the device dataset on logout, consent revocation, or account deletion.

## Configuration and backend

Set build-time `VITE_FITFLOW_API_URL` to the complete API base URL, for example `https://fitness.example/api/v1` (no credentials, query, fragment). HTTPS is mandatory except localhost/127.0.0.1/[::1] HTTP development. Missing or unsafe configuration disables the account page and the client cannot issue requests. The displayed recipient is this exact configured base URL.

Deploy the web app and API **same-site over HTTPS**, preferably with `/api/v1` reverse-proxied on the web app’s origin. The backend uses SameSite=Strict session cookies; an unrelated cross-site API domain is unsupported. The backend must allow the exact web origin and credentials with its documented CSRF/CORS guards. Never weaken cookies or origin checks to make this work. Native Capacitor cloud accounts are explicitly disabled in this slice; local training/nutrition/backup continue to work.

Every request uses `credentials: 'include'`, `cache: 'no-store'`, `redirect: 'error'`, and `referrerPolicy: 'no-referrer'`. Mutations send JSON and `X-Fitflow-Client: web`; all authenticated reads and mutations (except bootstrap session checks) also send the session’s in-memory `X-CSRF-Token`. Requests abort after 20 seconds. Passwords and manually entered verification/reset tokens clear immediately on submission and mode/route exit. Neither token URL parsing nor token logging is implemented.

Implemented endpoints:

- POST `auth/register` → 202 `verification_required`; POST `auth/login` and GET `auth/session` → session JSON
- POST `auth/logout` → 204
- POST `auth/verification/request` and `auth/password-reset/request` → 202 `accepted`
- POST `auth/verification/confirm` → 200 `verified`; POST `auth/password-reset/confirm` → 200 `password_reset`
- GET/PUT `consent` with policy version `2026-10-15`
- GET `sync`; PUT `sync` with `{baseRevision, operationId: UUID, state}`
- POST `account/export` with password; DELETE `account` with password and literal confirmation `DELETE`

A disabled mail adapter or unavailable backend (503) reports the failure honestly; registration does not invent delivery. The backend is responsible for account/password validation, secure email delivery, revocation/deletion, export authorization, secure cookies, rate limits, CSRF, origin checks, and atomic CAS/idempotency.

## Native protocol foundation, not yet connected to the app

The separate `/api/native/v1` server protocol is disabled by default. Its dedicated Android/iOS channel source and typed adapter remain disabled by empty native recipient policies and are not connected to `CloudClient` or account UI. The source does not remove the native-platform guard, choose a live service destination or send a request merely on startup. The existing native account page remains unavailable. See the [native API contract](server/NATIVE_ACCOUNTS.md) and [unwired bridge contract](docs/NATIVE_ACCOUNT_BRIDGE.md).

Native sessions use a separate database table and bearer authentication. They cannot be used as web cookies, and web sessions cannot be used as native bearers. Native requests reject cookies, browser origins and fetch metadata; no web Origin is forged, no native CORS grant is added, and the web cookie/CSRF policy is unchanged. The existing CSRF value binds requests to the current session; because it is derived from the bearer, it is not an independent authentication factor.

The [platform transport source](docs/NATIVE_ACCOUNT_TRANSPORT.md) retains credentials only in native memory, constrains the packaged HTTPS recipient, refuses redirects and arbitrary URLs/headers, isolates cookies/cache, and fences token installation and callbacks across cancellation, account changes and backgrounding. Its dedicated channels check main-frame, origin and packaged asset source instead of relying on generic plugin calls. Clearing that memory does not establish server logout. The source implementation and its host/synthetic checks do not supply full native compilation or device verification. The web client's existing-session bootstrap must not be reused blindly: it clears local context before checking the browser cookie, whereas clearing a volatile native credential removes the ability to resume it.

Database schema v6 adds native session storage transactionally while preserving existing accounts, web sessions and snapshots. Older servers refuse the newer schema. Keep a private pre-upgrade database backup for deliberate rollback; never lower `user_version` or reuse native credentials as web sessions. Restoring an earlier backup omits subsequent changes and requires its own recovery decision.

## Consent and conflict behavior

The consent checkbox names the configured recipient and health categories: training plans/history with saved equipment requirements, profile/weight, nutrition, preferences, and active session. Temporary available-equipment filter choices are not part of AppState and are not transferred. Equipment metadata is included in the owner's full snapshot/export but deliberately omitted by existing coach projection allowlists. Enabling consent sends only the consent decision. Each transfer is manual:

1. Explicitly check/enable consent and inspect the latest cloud snapshot
2. Review a frozen, validated device snapshot for upload, or review the cloud snapshot for restore
3. Confirm replacement for the named signed-in account and recipient

Upload rechecks server consent, sends a paused timer snapshot and a cryptographically generated UUID, and uses the inspected revision as CAS. A conflict, failed/uncertain PUT, or successful PUT invalidates the upload revision. There is no blind retry/overwrite: inspect again and make a new choice. Restore rechecks consent and downloads/validates the snapshot again; a changed revision requires a new review. A failed local transaction never reports success.

Revocation requires confirmation, removes local cached consent/snapshot/revision/review, and preserves the authenticated session plus device records. Its backend response must represent deletion of the cloud snapshot. Account deletion requires a password plus typed DELETE; successful deletion clears the account context and preserves device data. Full sensitive account export is downloaded only after a user submits the password-confirmed export form; it excludes unsynced device changes and should be kept private.

## Verification

Synthetic Vitest/RTL tests cover configuration/native disablement, no page-visit requests, headers/credentials, in-memory secrets, explicit consent and confirmation, per-upload consent recheck, CAS conflicts, paused timers, strict snapshot validation, account switching, expiration/401, revoke/delete/export, double-submit guards, cancellation on navigation, restore revision changes, and storage failure. No real user data, account, email adapter, live credential, service, browser, or deployment was used. Browser/device visual QA and real same-site HTTPS integration remain required before release.


## Coach collaboration integration

The signed-in, verified Account view embeds `Coaching` with the same stable `CloudClient`. No collaboration request occurs on mount. The separate `FITFLOW_COACHING_ENABLED` flag defaults false; see `server/COACHING.md` and `docs/COACHING_UI.md` for the exact invitation, category, feedback and account-export contracts.

The account view subscribes to the client's primitive session revision and hides any private review/snapshot/secrets from an earlier revision before cleanup. Same-account reauthentication invalidates old views just like an account switch. Session-bound account actions capture that revision and check it immediately before applying restored local data, downloading exports, or updating consent/private views. A request-level transport check alone is not enough because the shared session can change between promise continuations.

A successful cloud-consent revocation remounts the collaboration view to clear stale grants, without issuing a request. Its server transaction clears coach scopes and advances relationship versions; future cloud opt-in does not recreate access. Upload review explains that accepted coaches with current explicit category grants can read those categories in the newly uploaded snapshot. No collaborator snapshot is restored into the athlete's local dataset.

The combined suite includes real `CloudClient`/`CoachingClient` calls against the actual synthetic server/cookie transport, covering separate acceptance/consent, positive category projections, feedback/export isolation, revocation, fresh opt-in and account-deletion cascades. This is not real browser cookie acceptance or live sharing.

## Private consistency challenges

The verified Account view also provides a separately collapsed private-challenge section using the same stable in-memory `CloudClient`. It receives no device dataset. Opening/collapsing the section, viewing/cancelling a review and account/session notifications issue no requests. A deliberate availability read is required before actions. The service remains disabled unless `FITFLOW_CHALLENGES_ENABLED` is explicitly enabled; the default local-only app remains unchanged. See [server contract](server/CHALLENGES.md) and [UI boundaries](docs/PRIVATE_CHALLENGES_UI.md).

Acceptance identifies the two accounts but shares no health count. Each participant separately confirms one exact counterpart, the immutable UTC date window and the count-only metric. Current grants and cloud consent from both accounts are necessary for manual reads. All values are self-recorded and unverified. Counts come only from manually saved cloud snapshots, with one qualifying completed-work day per UTC date; they are not read from unsaved device state. No challenge response is restored into device records.

The transport adapter checks session generations and strict response identities, fields, windows and count bounds. The component additionally invalidates hidden/returned or changed views and retained callbacks, including after a same-account session replacement. A successful cloud-consent revocation clears both challenge grants server-side and remounts private views without fetching. Leaving ends one challenge; an explicitly reviewed block ends all pair challenges and prevents new requests in either direction. This version has no unblock control. Account export accepts historical responses without challenge metadata, and validates any supplied metadata without including peer counts or snapshots.

Synthetic client/server protocol tests cover separate acceptance/grants, daily deduplication and excluded records, null-vs-zero cloud copies, count-only projection, account export isolation, cloud-consent revocation without grant resurrection, switched cookies, block and account deletion. These tests do not establish real browser cookie, focus, accessibility, network or native acceptance.


### Session grouping compatibility and privacy

The owner's manually uploaded v4 snapshot may include optional version-1 session grouping on active sessions and logs. It retains exact group/round/set references through account export and backup; paused transfer never starts round rest. Earlier strict APIs reject this extension instead of flattening it, so update the API before accepting grouped copies. Preserve a compatible pre-feature backup for any deliberate rollback; restoring it omits later work. See [session grouping](docs/SESSION_GROUPING.md).

Grouping names, IDs, rounds and rest metadata are not added to the separately consented coach training projection. Its existing historical row/label fields remain unchanged, active sessions remain excluded, and the client rejects unexpected grouping in coach responses. Private challenge counts still use only saved positive completed non-warmup rows and one self-recorded day per UTC date; group metadata contributes no additional credit.
