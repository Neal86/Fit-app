# Release readiness and complete-product map

## Scope

Baseline: `81b6705f2602e18b5517396389ffac69be62423a` in `Neal86/Fit-app`.

This development branch now implements the local training/nutrition/planning product plus optional account, manual-sync and consent-scoped coach collaboration foundations. It is **not a declaration that the commercial product, live cloud service, native binaries or store release is finished**. A finalized comprehensive product specification was not present in the repository; unresolved areas are listed explicitly below.

No automatic CI, production deployment, paid service, live email/AI provider, real-user health-data transfer, signing credential or store publication is configured. The owner approved Android INTERNET in this app configuration. Native account transport and device acceptance remain separate release gates.

## Implemented and integrated

### Training, plans and progress
- Metric/imperial weight, load and height input/display, with canonical kg/cm retained across repeated switches, backup and sync; see [measurement behavior](docs/MEASUREMENT_UNITS.md)
- Durable session snapshots; real elapsed start/pause/resume; completed/timed sets, load, reps, RPE, warm-up flags, rest countdown and prior-set references
- Partial completion confirmation, stable identities and duplicate/stale finish protection; editable plans do not rewrite active or historical sessions
- Explicit reviewed mid-session exercise replacement, preserving completed rows and history, assigning fresh identities to blank replacement rows and fencing stale session/route/draft callbacks; see [replacement behavior](docs/SESSION_REPLACEMENT.md)
- Editable schedules, exercises and notes; reusable exercise catalog search/categories from existing templates/user entries
- Weekly schedule preview constrained by the user's chosen days and maximum planned duration; no silent shortening or automatic intensity prescription
- Twenty reversible prior plan versions, with confirmation before restoring/replacing a plan
- Date filters, history search, activity calendar, working-set volume, highest recorded loads and dated weight trends; historical exercise labels are preserved for new logs
- Backdated weight correction keeps the most recent dated weight in the profile; estimates remain labeled and old records are not rewritten into invented measured results

### Nutrition and data durability
- Manual food/water records, serving descriptions, explicit nutrient values, daily totals and optional user-entered date-specific targets
- Edit/delete/cancel confirmation, stable IDs, expected-value stale-write checks, failed-save retention and bounded tab-scoped draft recovery
- AppState v2/v3 → v4 migration retains the existing storage key, initializes empty nutrition/plan history and rejects malformed supplied data
- Shared strict local/cloud schema, unknown-field rejection, numeric/calendar/ID/reference/size limits and non-destructive corrupt-storage recovery
- Transactional full-state saving, visible quota errors, stale-tab snapshot overwrite detection and draft cleanup after successful import/reset/restore
- Private JSON backup/import; native Web Share where available with JSON fallback. Native transfer behavior still requires device acceptance

### Optional accounts and cloud code
- Register/verify/login/logout/reset contracts, salted scrypt, hashed single-use email/session tokens, session expiry/revocation and bounded abuse controls
- Verified account isolation, exact web-origin checks, secure HttpOnly SameSite cookies and session-bound CSRF for protected reads and writes
- Ordered credential/mail generations prevent out-of-order delivery from restoring obsolete passwords; SQLite security migration tested
- Recipient-specific consent plus manual snapshot inspection/review/confirmation; no background upload or auto-merge
- Atomic revision conflicts, per-user durable idempotency, consent-revocation tombstones, password-confirmed account export/deletion
- Disabled-by-default Node/SQLite API and browser client; live email adapter is intentionally not supplied, native cloud transport is unsupported
- Bounded HTTP bodies/concurrency and depth-first structural validation; no request-body logging or secret-bearing URLs
- Real client/server protocol tests using synthetic cookie transport, plus actual loopback HTTP tests; these do not replace browser cookie acceptance

### Optional coach collaboration
- Separate disabled-by-default service, verified recipient invitations/acceptance, and no access on acceptance until the athlete grants specific categories
- Exact accepted identity/category review; positive training/body/nutrition projection allowlists from saved cloud snapshots only, never the full profile or active session
- Server-side current scope/verification/cloud-consent checks, monotonically versioned grants and revocation, replay-safe plaintext feedback/removal and both-account deletion cascades
- Own-only password-confirmed export with collaboration metadata/feedback; previously copied data cannot be recalled and qualifications remain unverified
- No automatic requests/invitations, local persistence of collaborator records, real-user sharing, coaching marketplace, organization administrator or clinical moderation claim

### Delivery foundations
- Locked dependencies; manual lint/test/build commands; no GitHub Actions
- Versioned offline shell precache with exact build assets, app-owned cache cleanup and no account/API response caching
- Full Android Gradle and iOS Xcode/SPM source projects, artwork, privacy resources and platform-aware runtime initialization
- Static Docker/Nginx configuration; optional backend is not included in that deployment image

## Verification

On 2026-10-15, the integrated source passed `npm run check`: 389 frontend unit/component/native-runtime tests, 80 backend security/HTTP/race/migration tests, and 5 real client/server protocol tests (474 total), plus ESLint, TypeScript, Vite and offline-shell generation. This includes mid-session replacement, preserved completed/history snapshots, stale session/route/raw-draft callbacks, storage reload, backup and manual cloud round trips; metric/imperial entry and readouts, canonical-value precision, failed-save and unit-switch draft handling, coach collaboration, async session/view invalidation, recipient-independent invitation budgets, timestamp-ordered prior-set references and exclusion of future-dated imported workouts from the current weekly total. The test harness caps parallel workers at four; the real 10 MiB boundary fixture has a 15-second test-only budget after a shared-CPU five-second timeout, with its assertions unchanged. Overlapping independent aggregate runs encountered timing failures in UI and synthetic-mail tests under shared CPU contention; the integrated aggregate completed successfully. The replacement work did not relax test deadlines or assertions.

| Gate | Evidence/status |
|---|---|
| Local lint/unit/component/API/protocol/build | Passed: 389 frontend + 80 backend + 5 protocol tests (474 total), lint and production build |
| Production dependency audit | Re-run 2026-10-15: 0 known production vulnerabilities |
| Android + iOS `cap sync` | Passed again on integrated build; copies assets/plugins only, not native compilation |
| Native XML/plist/Xcode resource parsing | Passed again on integrated projects: Android XML, iOS plist/privacy and shared scheme syntax |
| Chromium desktop/mobile E2E | Written but **not executed**: browser process could not start in this executor, including isolated retry |
| Browser screenshots, responsive overflow, accessibility, offline/cookie acceptance | **Not verified** |
| Android APK/AAB build | **Not run**, SDK/Studio not available |
| iOS simulator/archive | **Not run**, macOS/Xcode not available; deferred while source work proceeds |
| Physical devices, native export/import, app-store acceptance | **Not run** |
| Container build, deployed HTTP/HTTPS and service operation | **Not run**; Docker unavailable and no deployment configured |

Manual commands (Node 24.15+ for the complete suite):

```sh
npm ci
npm run check
npm run native:sync
npm audit --omit=dev
# Only in a browser-capable approved environment, after build:
npm run test:e2e:install
npm run test:e2e
```

The local-only frontend can use Node 22+ with `npm run lint`, `npm run test`, `npm run build`. `cap sync` is not native compilation. A successful source test is not device/store approval.

Independent review rechecked the earlier delayed-email/password race, wide-payload memory amplification, nutrition drafts and account guards. The account/coaching review independently passed 37 backend tests, 95 frontend tests and 3 isolated regressions, plus four capacity-probe scenarios. Its three findings are closed: invitation capacity no longer distinguishes eligible recipients, hidden views cannot revive delayed collaborator reads, and session invalidation cancels local restore/export. A subsequent independent unit-preference review passed 150 focused tests and 9 additional probes, including 3,000 seeded exact round-trip cases, with no actionable findings. The replacement review independently passed 140 focused tests, including 31 additional probes. It closed retained-callback and raw-edit/route-return invalidation gaps, verified unchanged completed/history rows and capacity boundaries, and found no unresolved actionable defect in the final snapshot. These retained-callback cases use synthetic component probes, not observed browser interactions. This is source review, not a penetration test or production certification.

## Full-product gap matrix

| Area | Current code | Remaining final-product gate |
|---|---|---|
| Training execution | Durable set/session workflow, reviewed mid-session movement replacement and canonical-safe metric/imperial load entry | Supersets/drop sets, reviewed progression/deload rules and device/keyboard/accessibility QA |
| Individual plans | User-chosen weekly schedule, editable templates, prior versions | Assessment/equipment-driven plan design and reviewed adjustment policy; no AI prescription is claimed |
| Exercise content | Searchable reusable starter/user entries and notes | Reviewed instruction catalog, equipment/muscle taxonomy, licensed demonstrations/videos, variants and content provenance |
| Accounts | Tested account/session/recovery API and optional Web UI | Approved live email adapter, deployed same-site HTTPS service, browser/session acceptance, optional social sign-in, operational support |
| Cloud sync | Consent/manual full-state CAS and durable idempotency | Native transport, intentional offline queue/deltas if desired, monitoring, encrypted backups/restore drill and load/concurrency acceptance |
| Health-data privacy | Local default, explicit cloud recipient/consent, export/revoke/delete code | Approved hosting/processors/residency, finalized notice/scope/retention, encryption, backup deletion process and operator review |
| AI plans/action guidance | Not implemented | Product/safety contract, server model adapter/structured output, consent, bounded cost/quotas/timeouts; reviewed camera/pose permissions if chosen |
| Nutrition | Manual diary/water/targets | Licensed food database/barcode/portion model if desired and reviewed non-clinical content; no prescribed diet or invented nutrition values |
| Subscriptions | Not implemented | Entitlement/pricing/trial decisions, StoreKit/Play Billing, receipt/webhook validation, restore/cancel/refund tests and approved store accounts |
| Coach/admin | Default-off accepted identity and category-consented saved-snapshot access; revocation, scoped plaintext feedback and own-data export | Professional verification, organizations/admin roles, assignment tooling, production audit/abuse/retention model, operational support and browser acceptance |
| Community/challenges | Not implemented | Visibility defaults, moderation/report/block, scoring integrity and content/safety policies |
| Wearables/health platforms | Not implemented | Explicit provider scopes/adapters, revocation/deletion, deduplication/provenance and consented tests |
| Reminders/push | No delivery | Permission UX, local vs server design, timezone/quiet-hours, opt-out and delivery acceptance |
| Analytics | Local filtered activity/weight/load summaries | Chosen product metrics and any external analytics consent; no external analytics collection is installed |
| Web production | Tested build and static container config | Container acceptance, real HTTPS/domain/CSP/proxy, deployed SHA, cache updates and incident/runbook checks |
| iOS/Android | Source projects and sync workflow | SDK compile, device QA, native cloud design, signing and store acceptance |
| Brand/legal/store | Placeholder FitFlow name/IDs | Ownership, final legal/support/privacy details, real screenshots, territories/pricing and audience/age-rating decisions |

Do not replace these gates with an unsupported percentage-complete score. Do not add placeholder buttons that pretend unavailable services function. Further provider work must use explicit destinations, privacy/cost choices and approved credentials; source development does not authorize activation or real-data processing.
