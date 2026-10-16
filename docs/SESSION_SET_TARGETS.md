# Manual session set targets

## User-authored session data

An explicit per-row form, review and confirmation saves or removes a target for an unfinished existing session row. Reps/seconds and optional load remain separate from recorded actual values. Blank load is unspecified; zero is explicit zero. Targets do not fill actuals, infer completion, change rest or recommend intensity. Existing timed/repetition entry mode is preserved. Saved-plan targets and drop chains are outside this slice.

Completed targeted rows require the existing explicit Undo action before a fresh target edit. Row deletion requires target removal first. Exercise replacement explicitly reviews discarded unfinished-row targets; completed targets and actuals remain exact. Partial finish preserves targets on completed and unfinished rows. History reads saved row/exercise snapshots, not current plans. Plans and manual-library ancestry are unchanged.

## Persistence and compatibility

The optional active-session/log field is `setTargets: { version: 1, targets: [{ setId, metric: 'reps' | 'seconds', amount, weightKg? }] }`. There are no new fields on actual set rows. Targets reference owner-local rows exactly once. Reps are integers 1–999, seconds 1–86,400 and optional canonical load is finite 0–1,000 kg. These are data bounds, not recommendations. The wrapper is removed when empty.

The v4 state/storage key is unchanged. Unsupported legacy metadata is rejected before migration can discard it. Frozen pre-feature readers reject active and historical target metadata without overwriting original storage. Before deliberately downgrading, preserve the complete newer export separately and use a compatible pre-feature backup. No stripping or automatic downgrade is provided.

Atomic saving retains previous storage and the current review/draft on quota failure. Session, account, route, visibility and observed edit cycles invalidate stale reviews. Changing units preserves canonical load precision and unrelated raw actual-input drafts. A target cannot be applied through a retained callback after its context changes.

## Private-transfer boundaries

Own backup, manual cloud snapshots and account export retain exact metadata. Private upload review discloses target counts and scope. Coach projections exclude these targets. Private challenge counts still depend solely on actual completed-row evidence. AI composition payloads exclude targets and row identities; reviewed local AI application preserves existing sessions and history. No real account, invitation, provider or health-data transmission was used for verification.

## Verification and acceptance

The integrated source `40b498a3bbf0df53c0f5dd1a02d63de8824dde38` passed 3,079 tests (2,848 frontend, 199 backend and 32 actual client/server protocol), lint, TypeScript and production/offline build. The slice retains 107 independent regressions plus actual App persistence and synthetic protocol cases. No assertions or timeouts were relaxed and no complete-gate retry was needed.

Browser E2E/layout/accessibility/performance, Android/iOS compilation and devices remain unverified. Earlier paused browser/native operations were not retried. There is no automatic CI, deployment, store release, real AI adapter or production service activation. See [release readiness](../RELEASE_READINESS.md) for the full remaining product and acceptance gates.
