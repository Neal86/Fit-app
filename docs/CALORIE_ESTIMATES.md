# Workout calorie estimates and explicit unknown values

Workout energy figures are estimates. The application does not measure energy expenditure or establish the suitability of a workout. No new calorie formula, prescription, external processing or nutrition target is introduced by this change.

## Saved representation

The existing `Workout.calories` and `WorkoutLog.calories` fields accept either:

- The existing finite numeric value, with its existing bound: 0–10,000 for a plan and 0–10,000,000 for a log
- The exact versioned value `{ "version": 1, "status": "unknown" }`

There is no numeric sentinel. Zero is a known recorded estimate of zero; it does not mean missing. Missing fields, `null`, numeric strings, arrays, unsupported versions, extra marker fields and other status values are invalid. Existing numbers are not rounded, re-estimated or converted on load, migration, copy or transfer. Precision is the existing JSON/JavaScript number precision; this is not a new arbitrary-precision format.

The marker is allowed only at existing workout/log calorie fields, including workout snapshots in active sessions and previous plan versions. It is not accepted for food entries, nutrient targets, body records, exercises or arbitrary extra fields. Nutrition retains its existing numeric contract.

## Editing, recording and display

Leaving the optional workout estimate empty explicitly selects “unknown.” Entering zero retains a known zero estimate. Existing draft, source-change, quota and stale-tab protections apply; a failed save must retain both previous persisted data and the editable draft.

Starting a session copies the selected plan's estimate into the session snapshot. Finishing a session with an unknown estimate records unknown, including partial sessions. A known numeric estimate retains the existing elapsed-time scaling behavior; this remains an estimate, not a measurement. Later plan edits do not change an active session or saved log.

Individual unknown values display as unavailable. Aggregate views distinguish:

- No sessions: no recorded session estimates
- All estimates present: the sum of the recorded estimates
- Some estimates absent: the known subtotal and the number of sessions without an estimate
- Every estimate absent: an unavailable total, rather than zero

The aggregation API returns a complete total only when every included estimate is known. A mixed subtotal is never labeled a complete total. Duration, set counts, recorded loads, training-day counts and nutrition sums do not depend on calorie availability.

## Compatibility and recovery

This is an explicitly versioned field extension of AppState version 4, like the existing versioned grouping/library extensions. Numeric-only version 4 data remains unchanged. Numeric legacy version 2/3 data follows the existing local migration.

Version 2/3 inputs containing the unknown marker are rejected before migration, including markers in fields that an old migration would otherwise discard. There is no silent stripping or downgrade. Current strict readers reject malformed marker data before storage is replaced.

**Earlier application/server versions cannot read records containing this marker.** Their numeric validators reject it. The older-reader regression fixture verifies that original saved bytes remain available rather than being overwritten with defaults. Do not run an older build against the only copy of a newer dataset. Export and verify a complete backup first; a rollback requires an explicitly chosen compatible earlier backup. Do not change unknown values to zero to manufacture compatibility.

The database schema is unchanged: snapshots remain validated JSON blobs. A server with an older validator rejects a newer unknown-containing upload before changing its existing revision. Upgrade compatible readers together before using this data with them.

## Private transfers and sharing

Own JSON export/import, manual cloud sync and account export preserve the exact unknown marker, numeric zero, fractional estimates, active snapshots and previous plans. The local byte limit and compare-and-swap guards remain in effect. No automatic upload or new recipient is added.

The already consented coach training projection contains a calorie field. That same field can now explicitly report that no estimate was recorded; its surrounding positive field allowlists are unchanged. Personal library metadata, equipment, grouping, active sessions and unrelated categories do not become shared. Separate recipient/category consent and current access checks remain required. Previously shared information cannot be recalled.

Private challenge counts use the existing recorded-set evidence rules, not calories. Unknown energy estimates do not create or remove challenge credit. No real account invitations or sharing are performed during synthetic verification.

## Relationship to future AI composition

An independently composed future workout has no supported calorie estimate merely because its exercises came from saved workouts. This representation allows such a draft to remain explicit about missing information. It does not implement or activate an AI provider. Provider selection, model, data-processing terms, exact request consent, credentials, cost limits and review-before-apply remain separate gates.

Browser/device rendering, native compilation and live service acceptance remain unverified; see [release readiness](../RELEASE_READINESS.md).
