# Optional, bounded coach collaboration API

This is a **disabled-by-default, synthetic-tested source feature**, not a live coaching, credential-verification, clinical-advice, email, or health-data service. No deployment, invitation delivery, provider integration, or processing of real health information is included or authorized by this change. No existing client/server configuration enables it automatically.

## Enablement and trust boundary

`FITFLOW_COACHING_ENABLED=false` is the default. Only the exact environment value `true` enables these routes; `createApp` accepts only the boolean `config.coachingEnabled: true`. The account server separately requires `FITFLOW_SERVER_ENABLED=true` at startup. Disabled `/api/v1/coaching` routes, including their preflight, return `503 coaching_disabled` without collaboration data. Account export/deletion remain available, including the user's own existing collaboration records.

The same-site, web-only account protocol in [README.md](README.md) applies unchanged: verified cookie session, exact permitted origins, JSON mutations, `X-Fitflow-Client: web` on mutations, and the current session's `X-CSRF-Token` on **every coaching read and write**. Same-origin reads may omit Origin; an explicit foreign/null/native Origin or cross-site fetch is denied. No wildcard origins, native bearer-token transport, owner selectors, query parameters, public invitation URLs, or debug routes are introduced. Fetch with `credentials: 'include'`; keep the CSRF token in memory. All responses are JSON with `Cache-Control: no-store` and nosniff headers.

A verified email proves control of an account email, **not coaching qualifications**. `coachQualificationsVerified` is always `false`. Nothing in this API checks certifications, licensure, suitability, or professional identity.

## Consent sequence

1. An athlete submits the email of an already verified account. The response never identifies whether that account exists, is eligible, has capacity, or already has a pending/active relationship. No mail is sent. Only the eligible signed-in recipient can find a database-backed pending invitation.
2. The recipient explicitly accepts. A relationship is created with **no category scopes** and no category policy consent. Acceptance alone cannot read health data or leave training feedback.
3. The athlete inspects the exact accepted counterpart's account ID/email, then separately grants any of `training`, `body`, and `nutrition` against the current relationship version and policy version. Empty scopes are valid. Nonempty grants require current athlete cloud-health consent and a still-verified coach.
4. A granted coach can manually fetch only the athlete's latest **saved cloud snapshot**, filtered by the selected categories. Local-only changes are never read. The grant continues to cover later explicitly saved cloud uploads until changed or revoked; the client must explain this before granting.
5. Either party can revoke/leave the accepted relationship. Revocation is terminal for that ID. Athlete cloud-consent revocation also atomically clears every active athlete category grant and increments its version in the same transaction that removes the cloud snapshot. Re-enabling cloud consent, or uploading a new snapshot, does not restore those grants.

Every coaching authorization check and operation is synchronous within one `BEGIN IMMEDIATE` transaction. Reads, feedback replay, acceptance, scope changes, account deletion, and revocation cannot interleave across their database boundary. A read that completed authorization before a later revocation may already have been delivered. Revocation prevents subsequent authorized access; it cannot retract screenshots, copied text, downloads, or prior responses. The client must clear displayed shared data on errors, account switches, and permission changes; never cache it in local storage, service workers, a sync queue, or analytics.

## Exact wire contract

All paths below are relative to `/api/v1`. Unknown request fields are rejected, including client-supplied owner IDs. IDs issued by the server are UUIDs. Versions are positive safe integers; timestamps are ISO UTC strings. `policyVersion` for this collaboration protocol is currently `2026-10-15`, independent of the cloud-health consent policy. It is a protocol revision, **not approved legal/consent text**.

### Views

```ts
type Scope = 'training' | 'body' | 'nutrition'
type Person = { id: string; email: string }
type Invitation = {
  id: string; athlete: Person; createdAt: string; expiresAt: string
}
type Relationship = {
  id: string; role: 'athlete' | 'coach'; counterpart: Person
  status: 'active' | 'revoked'; version: number; scopes: Scope[]
  policyVersion: string | null; consentUpdatedAt: string | null
  createdAt: string; acceptedAt: string; revokedAt: string | null
}
type Feedback = {
  id: string; text: string; format: 'plain_text'; createdAt: string
}
type Overview = {
  policyVersion: '2026-10-15'; coachQualificationsVerified: false
  invitations: Invitation[]; relationships: Relationship[]
}
```

### Invitation and relationship endpoints

| Method / path | Exact request | Success |
|---|---|---|
| `GET /coaching` | No body | `200 Overview` |
| `POST /coaching/invitations` | `{email}` | `202 {status:'accepted'}` |
| `POST /coaching/invitations/cancel` | `{email}` | `202 {status:'accepted'}` |
| `POST /coaching/invitations/:id/accept` | `{}` | `200 {relationship:Relationship}` |
| `DELETE /coaching/invitations/:id` | `{}` | `204`, recipient decline |
| `PUT /coaching/relationships/:id/consent` | `{baseVersion,policyVersion:'2026-10-15',scopes:Scope[]}` | `200 {relationship:Relationship}`, athlete only |
| `DELETE /coaching/relationships/:id` | `{baseVersion}` | `200 {relationship:Relationship}`, either accepted party |

Overview lists **incoming pending invitations only** and **accepted active/revoked relationships only**, with role/counterpart relative to the caller. It never lists outgoing pending requests, rejected/nonexistent recipient receipts, or declined/cancelled/expired invitations. Pending invitations expire after seven days, checked at access time. Accepting an expired/declined/cancelled/revoked invitation cannot restore it. Declining an already-declined invitation is idempotent. Accepting an already-active invitation is idempotent and returns its current relationship without resetting scopes/version. Cancelling by email only changes the caller's own pending request and never affects an accepted relationship.

Invitation and cancellation responses are identical for syntactically valid emails across eligible, missing, unverified, self, duplicate, and capacity-blocked targets. Invitation POST reserves sender/global capacity before looking up the recipient: each admitted attempt consumes the same unit even when no invitation row is created. Subsequent attempts to a controlled account therefore cannot use remaining capacity to distinguish target eligibility. Cancellation, decline, expiry and account deletion never refund global attempts or another sender's attempts. Invalid email/body syntax can return 400; general abuse limits can return 429. Neither 202 nor the absence of an inbox row claims delivery or recipient eligibility. No outbound mail or other notification is attempted. Response timing is not constant-time; this is not a claim of perfect account-enumeration resistance.

Scope grants use optimistic concurrency. Each successful consent PUT increments `version`, even if scopes are unchanged. Active-to-revoked increments version and clears scopes/policy. A replay with the pre-revocation version returns `409 coaching_conflict`; a repeated revoke with the current already-revoked version returns the same terminal relationship without incrementing again. New invitations after terminal relationships use new random IDs and start with zero scopes after acceptance. At the safe-integer version ceiling, new grants fail closed while privacy revocation remains possible; counters never decrease.

### Scoped saved snapshot

`GET /coaching/relationships/:id/snapshot` is coach-only. It requires the relationship to be active, both accounts verified, current athlete cloud-health consent, current category-policy consent, and at least one selected scope. No saved snapshot returns `404 snapshot_unavailable`. Success:

```ts
{
  relationshipId: string; relationshipVersion: number
  revision: number; updatedAt: string
  categories: {
    training?: { workouts: Workout[]; logs: WorkoutLog[]; planHistory: PlanRevision[] }
    body?: { measurements: { weightKg: number; heightCm: number }; weightHistory: WeightEntry[] }
    nutrition?: { version: 1; meals: MealEntry[]; hydration: HydrationEntry[]; targets: DailyNutritionTargets[] }
  }
}
```

Unselected keys are **absent**, not blank placeholder datasets. The v4 state is validated using the shared AppState validator; each category then uses positive nested field allowlists. Future state fields do not automatically broaden coach access:

- Training: saved workouts/exercises, prior plan versions, completed logs, saved training notes, exercise snapshots, completed-set values including exercise load and RPE. Exercise load is training data, not the athlete's body-weight history
- Body: profile weight/height and recorded body-weight history, using explicit kg/cm field names
- Nutrition: user-entered meals, hydration and notes, and manually entered daily targets, with the existing NutritionState fields
- Never included: full profile, name, birth year, goal, level/weekly-target profile settings, preferred units, onboarding state, device preferences, active/live session, account/security fields, session or password/reset credentials

No operation modifies an athlete's workouts, nutrition, measurements, notes, saved snapshot, or local app state. The response revision is the athlete's saved-cloud revision, not a relationship mutation counter. Clients must reject unexpected fields/categories and stale relationship versions rather than merging them into local app state.

### Plain-text training feedback

| Method / path | Exact request | Success |
|---|---|---|
| `GET /coaching/relationships/:id/feedback` | No body | `200 {relationshipId,relationshipVersion,feedback:Feedback[]}` |
| `POST /coaching/relationships/:id/feedback` | `{baseVersion,operationId:UUID,text}` | `201 {relationshipVersion,feedback:Feedback,replayed:false}` |
| `DELETE /coaching/relationships/:id/feedback/:feedbackId` | `{baseVersion}` | `204`, athlete only |

Coach reading/writing requires current training scope and all current sharing conditions, even when replaying an operation. Athlete reading/removal remains available after relationship/cloud-consent revocation. A coach cannot edit/remove athlete records or feedback. Body/nutrition grants alone never allow feedback access.

Text must be nonblank, at most 2,000 JavaScript string units and 4,000 UTF-8 bytes. The server rejects HTML angle delimiters, explicit common URL schemes, `www.`, Markdown link syntax, C0 controls except whitespace separators, DEL, and bidi override/isolate controls. JSON remains text; **clients must render React text/textContent only, never HTML, Markdown, linkification, embedded media, executable templates, or automatic URL navigation**. The text filter is defense in depth, not a substitute for safe rendering and not a semantic/clinical moderation system. There is no automated clinical advice or generated treatment recommendation.

The operation UUID is per relationship. An identical current-permission/current-version replay returns 200 and `replayed:true`, preserving the original feedback ID/time. Changing payload under the same UUID returns `409 idempotency_conflict`. Deletion removes text but retains a bounded ID/hash tombstone; a replay returns `409 feedback_removed` instead of recreating it. A removed entry still consumes the lifetime feedback bound. Relationship versions do not change for feedback additions/removals; they track consent/relationship state. Clients should explicitly refresh feedback after a change.

## Account export and deletion

Password-reauthenticated `POST /account/export` preserves its existing format/version/user/consent/sync fields and adds this bounded `coaching` field. Clients may treat it as optional for historical exports:

```ts
coaching: Overview & {
  feedback: { relationshipId: string; items: Feedback[] }[]
}
```

This contains only the caller's incoming invitations, accepted relationship metadata/consents, and permitted feedback. It never includes another athlete's shared snapshot. Athletes retain their received feedback export after revocation. Coaches only export their authored feedback while current training/category/cloud permission still allows access; revoked/ineligible groups are omitted, so export cannot bypass access revocation. Removed feedback text and internal operation hashes/IDs are omitted. A reauthenticated export that was waiting on password hashing rechecks current permissions afterward. Export continues when coaching routes are disabled. The combined maximum own snapshot plus collaboration export is bounded; client response handling should allow up to 64 MiB for this endpoint rather than silently dropping the optional field.

Deleting **either** account cascades all associated pending/terminal/accepted relationships and all their feedback/tombstones. Deletion removes that account's own invitation-budget row; the non-identifying global attempt total is retained, and another sender's attempt total is not refunded. Existing account session/token/sync-operation cascades still apply. The other party loses those API records immediately. Deletion does not erase already exported copies, external backups, or local-only app data. A production retention/backup-erasure policy is still required.

## Bounds and abuse controls

- At most 50 outgoing invitation attempts plus explicitly accepted incoming relationships per account. An admitted attempt consumes one lifetime unit regardless of missing/unverified/self/duplicate/full-recipient status; no target address is stored in the budget
- Separately, at most 50 current incoming pending invitations per recipient; unsolicited declined/cancelled/expired incoming rows do not consume their accepted/outgoing-attempt capacity. Decline/cancel/expiry frees pending-inbox slots; acceptance rechecks capacity in its transaction
- At most 10,000 lifetime admitted invitation attempts globally, which also bounds relationship rows. Reservations are atomic and independent of eligibility. No cancellation, expiry, deletion, automatic eviction or restart refunds the aggregate budget
- At most 100 feedback rows per relationship, including removed tombstones; 2,000-character/4,000-byte text limits
- Existing 8 KiB general HTTP bodies, 10 MiB saved-state limit, global/IP limits, four in-flight requests and socket/time limits apply
- Persisted account limits: 90 coaching requests/minute, 10 invitation attempts/day including ineligible attempts, and 20 feedback-post attempts/hour including failures; spoofed forwarding headers cannot change these buckets

Capacity-blocked invite POSTs still return generic accepted. Account/global lifetime attempt bounds can be exhausted even by ineligible or duplicate requests, requiring operator intervention or a later reviewed retention design; this is a bounded small-service foundation, not a production anti-spam or abuse-response system. Incoming pending invites can temporarily fill an inbox; decline/expiry releases capacity. A large number of separately verified hostile accounts can still pressure global capacity. There is no public directory, search, messaging attachment, escalation workflow, or professional verification.

## Migration and verification

SQLite schema **v4** adds eligibility-independent sender/global invitation budgets. V3→v4 seeds them once from existing outgoing/global relationship counts, then persists all admitted attempts including those without a recipient row. Existing v3 relationships, scopes, versions and feedback are unchanged. The v2→v3 relationship/feedback migration remains additive. Every DDL statement and `PRAGMA user_version` update is in the same `BEGIN IMMEDIATE` transaction; the version is read after obtaining the lock. Concurrent startup re-reads current schema instead of replaying stale ALTERs. Failed migrations roll back DDL/version and close the connection. Newer schemas are refused. Verified users, password hashes, generations, sessions, email tokens, cloud-consent/snapshot/revision fields, idempotency rows and rate-limit rows from v2/v3 are unchanged. Missing-recipient attempts after migration survive reopen, and neither recipient nor source-account deletion refunds the aggregate global total. The existing v1 security upgrade still invalidates unbound email tokens and clears unsafe unverified pending credentials; verified account data is preserved.

`npm run test:server` covers default-off behavior, verified recipient acceptance/decline/cancel/expiry, generic enumeration-resistant replies, independent category grants, positive projection allowlists, future saved revision behavior, CSRF/origin/session and ownership isolation, training-only safe text, feedback replay/removal, concurrent consent/revocation, current verification/policy changes, cloud-consent reset, both-account deletion, bounds/rates, retained export isolation, revocation during export, file reopen and v1/v2/v3 migration/rollback/concurrent-open behavior, and eligibility-independent capacity near both sender/global ceilings. It uses only synthetic fixtures and actual loopback HTTP where applicable. No real invitations, mail, browsers, provider accounts or health data are used.

Before real data or release, the existing account deployment gates still apply, plus approved specific recipient/category consent text, warnings about ongoing saved-cloud sharing and copied data, coach qualification disclaimers, abuse/retention/support design, safe text rendering, broader accessibility/browser/device QA, encryption/backup/incident controls, independent security review and explicit deployment/data-transfer authorization. Passing source tests does not establish legal compliance, clinical safety, professional qualifications or production readiness.
