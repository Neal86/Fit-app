# Optional private two-person training-day challenges

This is disabled-by-default, synthetic-tested source code, not a deployed service. No actual invitation, email, health-data transmission, device permission, automatic upload, prize, medical prescription, public leaderboard or free-text posting is included. Hosting, approved consent text, operational retention, independent security review, browser/device QA and explicit release/data-transfer approval remain required.

## Trust boundary and lifecycle

Only the exact environment value `FITFLOW_CHALLENGES_ENABLED=true` (or boolean `config.challengesEnabled: true`) enables `/api/v1/challenges` and nested endpoints. Default and all other values are off, including preflight (`503 challenges_disabled`). Existing account startup enablement is separate. Historical own export and account deletion continue while this feature is disabled.

Existing same-site web cookie authentication, verified accounts, JSON mutations, exact allowed Origin, `X-Fitflow-Client: web`, and current in-memory `X-CSRF-Token` apply unchanged. CSRF is required on ALL challenge reads and writes. Explicit foreign/null/native Origin or cross-site requests are denied. Responses are no-store JSON; clients must not persist scores in storage, caches, service workers, analytics or sync queues. No public invitation URLs, directory, arbitrary owner selectors or query parameters exist.

1. Sender chooses a known account email and immutable 1–31 inclusive UTC dates. End date must not be past. Response is generic, no receipt, outgoing pending record, delivery claim or mail. Only an eligible signed-in recipient sees the incoming invitation.
2. Recipient sees inviter identity/window and separately accepts. This does not grant count access. Both now see the accepted exact counterpart ID/email and fixed window.
3. Each participant separately reviews that recipient, window, metric and current protocol policy, then grants their own count sharing. Grantor must have current verified cloud consent; a peer without cloud consent does not prevent the first grant. Peer must remain verified. Both must have current verification/cloud consent AND both challenge grants before either may read counts.
4. Counts come only from the latest manually saved cloud snapshot. No local or live-session data is read and no automatic upload is triggered. A saved log qualifies only if it contains a completed, non-warmup set with positive reps OR positive seconds. Legacy logs without set evidence, empty/incomplete/warmup-only sets, zero reps/seconds, elapsed timer alone and completed flags alone do not count. Both timestamps must include a timezone; completedAt is normalized to UTC. Future completion instants are excluded, including later today. Count at most one qualifying completed UTC date per person within the window. These are self-reported records, not independently verified exercise; edits/removal/later manual saves can change counts, including after the window. There is no frozen result or fraud guarantee.
5. Either party can terminally revoke consent or leave that one challenge. Neither action blocks the person. Explicit Block revokes every open challenge/invitation between the pair and prevents further invitations in either direction. Known incoming pending invitations can be blocked before acceptance. No block list, arbitrary account block lookup, or unblock control is provided in this bounded slice. Blocking is account-level and persists until account deletion; already-known counterpart block state is not exposed.
6. Revoking either account's cloud consent atomically clears BOTH challenge grants and advances their versions in the same transaction as snapshot removal. The challenge remains active; re-enabling cloud consent or re-uploading restores neither grant. Both must review and grant again. Pending invitations expire at the earlier of 7 days after creation or the end of their UTC window. Accepted challenges expire 7 days after the UTC window ends; expiry clears both grants and is terminal.

All challenge permission checks, replay checks, reads and mutations run synchronously in one `BEGIN IMMEDIATE` transaction, with no awaits or provider calls. Current account verification/cloud policy and pair block state are rechecked before grants/reads. A response already authorized before subsequent revocation may already have been delivered; revocation cannot erase screenshots or prior copies.

## Frozen wire contract

Paths are relative to `/api/v1`. Unknown fields and missing required fields are rejected, including nested recipient fields. IDs are server UUIDs. Versions are positive safe integers. Timestamps are canonical UTC ISO strings (`YYYY-MM-DDTHH:mm:ss.sssZ`). Dates are real, exact `YYYY-MM-DD`; challenge windows are immutable, inclusive 1–31 days; create requires end date not ended and no later than `9999-12-23` to preserve timestamp representation. `2026-10-15` is a protocol revision, NOT approved legal/consent text.

```ts
type Policy = '2026-10-15'
type Metric = 'recorded_training_days'
type Person = { id: string; email: string }
type Invitation = {
  id: string; inviter: Person; startDate: string; endDate: string
  version: number; createdAt: string; expiresAt: string
}
type Challenge = {
  id: string; role: 'inviter' | 'invitee'; counterpart: Person
  startDate: string; endDate: string
  status: 'active' | 'revoked' | 'expired'; version: number
  ownConsent: boolean; peerConsent: boolean; policyVersion: Policy
  createdAt: string; acceptedAt: string; expiresAt: string; revokedAt: string | null
}
type Overview = {
  policyVersion: Policy; metric: Metric
  invitations: Invitation[] // incoming pending only, max 50
  challenges: Challenge[] // accepted only, max 50
}
type Counts = {
  challengeId: string; challengeVersion: number; metric: Metric; selfReported: true
  ownRecordedDays: number | null; peerRecordedDays: number | null
}
type OwnChallengeMetadata = Omit<Challenge, 'counterpart' | 'peerConsent' | 'policyVersion'>
type AccountChallengeExport = {
  policyVersion: Policy; metric: Metric; challenges: OwnChallengeMetadata[]
}
```

Challenge policyVersion is always non-null. Active rows have revokedAt null. Revoked rows have revokedAt non-null, both consents false. Expired rows have revokedAt null, both consents false. Expiry never changes an already-revoked row. Counts are integers from 0 through the inclusive window length; null means the account has no saved cloud snapshot. A saved snapshot with no qualifying completed work returns 0. Counts response has exactly the listed six keys, no snapshot/date/revision/update-time fields. No overview/export response contains counts.

| Method / path | Exact request | Success |
|---|---|---|
| GET `/challenges` | No body | 200 `Overview` |
| POST `/challenges/invitations` | `{email,startDate,endDate}` | 202 `{status:'accepted'}` |
| POST `/challenges/invitations/:id/accept` | `{baseVersion}` | 200 `{challenge:Challenge}` |
| DELETE `/challenges/invitations/:id` | `{baseVersion}` | 204, recipient decline |
| PUT `/challenges/:id/consent` | `{baseVersion,policyVersion,metric,startDate,endDate,shareTrainingDays:true,recipient:Person}` | 200 `{challenge:Challenge}` |
| DELETE `/challenges/:id/consent` | `{baseVersion}` | 200 `{challenge:Challenge}`, terminal revoke this challenge |
| DELETE `/challenges/:id` | `{baseVersion}` | 200 `{challenge:Challenge}`, terminal leave this challenge |
| GET `/challenges/:id/counts` | No body | 200 `Counts` |
| POST `/challenges/:id/block` | `{baseVersion}` | 204, explicit pair block |

Every mutation besides generic invitation creation requires exact baseVersion. Acceptance increments 1→2 and grants start false. Each successful consent PUT increments, even if already true. Successful pending decline and active/pending revocation increment; terminal mutation with current version is idempotent. Accepting already-active with current version returns current view. Replaying an old version returns `409 challenge_conflict` with `error.details.version`; no operation-ID queue or replay resurrection. Terminal grant attempts fail. DELETE on an already-expired accepted challenge returns its terminal expired view. Block also accepts known incoming pending/declined/expired invitation IDs, but never unknown/outgoing pending IDs; current-version repeat returns 204 without revealing existing block state. New invitation after leave/consent revoke may create a NEW random ID with no grants; blocking prevents it. Opposite-direction duplicate open pair invitations are disallowed. Dates, parties and metric cannot be edited.

Errors retain existing `{error:{code,message,details?}}` envelope:

- 503 `challenges_disabled`: feature off
- 403 `email_unverified`: caller's own account is not verified
- 403 `sharing_unavailable`: generic current sharing failure, no peer-specific reason
- 404 `not_found`: absent, unowned or unavailable item
- 400 `invalid_request`: fields/positive baseVersion invalid
- 400 `invalid_window`: malformed, ended or outside 1–31-day window
- 400 `invalid_consent`: reviewed recipient ID/email/window/metric/policy/true acknowledgment mismatch
- 409 `challenge_conflict`: known owned version changed; details contain only version
- 409 `challenge_limit`: recipient's OWN accepted/outgoing capacity prevents acceptance
- 409 `revision_limit`: no more grants at version ceiling; privacy revocation remains possible
- Existing authentication, origin, CSRF, JSON/body/media, rate and generic internal errors unchanged

## Non-enumeration, bounds and account lifecycle

Every valid invitation attempt reserves one sender/global lifetime unit BEFORE target lookup, whether eligible, missing, unverified, self, blocked, duplicate or recipient-full. A later attempt to a controlled inbox therefore cannot distinguish target eligibility from remaining admitted-attempt budget. Full sender/global capacity also returns the same 202 body. No recipient eligibility error or outgoing receipt is returned. Rate/body/syntax errors depend only on the caller/request. Timing is not constant-time; this is not a claim of perfect enumeration resistance.

- Max 50 outgoing admitted attempts plus accepted incoming records per account; unsolicited incoming historical records do not consume recipient acceptance capacity
- Max 50 current incoming pending invitations; decline/expiry releases that inbox capacity
- Max 10,000 lifetime globally admitted attempts, bounding all challenge records; no expiry, decline, leave, cancellation, deletion or restart refunds global/another sender's budget
- Each block must derive from a known challenge; max 10,000 target pairs per account and 20,000 directed blocks globally by construction, without arbitrary target insertion
- Persisted 90 challenge requests/minute/account and 10 invitation attempts/day/account, plus existing IP/rate/body/socket bounds
- No free text, workout names, calories, body/nutrition, exercise loads, dates of activity, raw snapshots or snapshot revisions in challenge responses

Password-reauthenticated `/account/export` keeps format/version and existing fields, and adds optional `challenges: AccountChallengeExport`. Historical exports may omit it. This is only the caller's accepted metadata/ownConsent, never pending send outcomes, counterpart identities, peer consent, peer score or peer snapshot. The caller's existing own sync export remains unchanged. Export rechecks metadata after password hashing and still works with challenge routes disabled. Export metadata is bounded to 50 records. Blocking data is enforced internally and is not an identity-discovery/export bypass.

Deleting either account cascades pair challenge records and directed blocks. The deleted account's own invitation budget is removed; another sender's budget and non-identifying global total are retained. No grants or blocks can resurrect on re-created IDs; deletion removes live relationships. Deletion does not erase copies/backups already held elsewhere. Production backup/retention and abuse support remain open release gates. Lifetime budgets intentionally fail closed rather than unbounded automatic eviction.

## Database and tests

Schema v5 is additive from v4: private_challenges, challenge_blocks, challenge_invitation_budgets, challenge_global_budget and indexes. Existing users/sessions/tokens/consent/snapshots/revisions/coaching rows remain untouched. All DDL and version changes share the existing immediate migration transaction; newer schemas are refused and failures roll back. V1–v4 migration paths remain supported. Reopen preserves budgets, blocks and revocation. Safe integer versions never decrease; at the ceiling privacy clearing still works while new grants fail closed.

Targeted synthetic tests: `npm run server:build && node --test --test-concurrency=1 server/test/challenges.test.mjs`. Existing aggregate is parent-coordinated to avoid parallel scrypt saturation. No CI, deployment, installs, browser work, mail or real-data processing is exercised.
