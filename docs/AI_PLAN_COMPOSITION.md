# Optional AI composition: source and activation boundary

## Implemented scope

This slice implements a closed composition contract, exact request review, guarded browser client, consent-bound server boundary and a separate local result review/save. Synthetic adapters exercise the whole flow. **No real model adapter, provider account, credential, live processing or billing is supplied or activated.** Both AI flags are off in `.env.example`. The server entry point has neither a recipient policy nor an adapter, so enabling a flag alone cannot send anything to a provider. Native account/AI UI remains unavailable.

The proposed model task is to choose and order references to exact exercises the user selected. It cannot invent exercises, targets, load, calories, timing estimates, instructions, notes, IDs, groups or clinical advice. Existing manual/starter exercise content is not expert verification. Passing structural or equipment checks does not establish suitability, safety or effective programming.

## Explicit local choices and transmitted fields

Sources are exact rows from the current saved plan or active user-authored personal library. Archived entries, history and the active session are not sources. Duplicate descriptive content is not silently merged. Original frozen source-row tokens bind the displayed source object/content; copied or fabricated tokens fail.

The user selects one to seven distinct days, local session titles/descriptions/difficulty labels, planned minutes, candidate rows, minimum/maximum movements, maximum sets and whether a candidate may repeat across days. Optional available-equipment matching requires every selected candidate's explicit requirements to match; unknown requirements are not equivalent to none. The labels and limits are user choices, not an AI assessment. Planned minutes do not establish actual duration.

The exact outbound JSON contains only:

- Version and request-local random candidate references
- Selected exercise names, categories, sets, rep text, rest seconds and optional equipment requirements
- Selected days/planned minutes, movement/set caps, cross-day repetition choice and optional available-equipment categories

Names, categories and target text can themselves disclose private health information. The complete JSON is shown before the unchecked consent control. Notes, titles/descriptions/difficulty, account/profile/body/nutrition records, history, active session, saved IDs and library ancestry are not in the provider request. Full frozen exercise snapshots, including notes and historical library ancestry, stay local for the subsequent result review.

The recipient review displays the configured API, backend operator, provider/model, processing destination/region, retention/training disclosures, declared charge and cancellation warning. Policy and payload hashes are bindings, **not anonymization**. Checking cloud-sync consent does not authorize AI processing; AI has its own exact request consent. Visiting the account page does not check policy, prepare, generate, poll or upload.

## Closed output and resource limits

The only accepted result is `version:1` with exactly the selected days and ordered candidate references for each day. References must come from the reviewed manifest. Within-day duplicates are forbidden; cross-day reuse requires the explicit choice. Every selected target is copied exactly. Extra fields, tool calls, prose, unknown references, target changes and unsupported versions fail closed without repair prompts or retries.

Technical bounds are 100 candidates, 1–12 movements/day, 240 sets/day, 1–600 user-planned minutes/day, 64 KiB canonical request and 32 KiB result. These limits are resource constraints, not training recommendations. A bounded deterministic feasibility check rejects impossible constraints and explicitly reports search-limit exhaustion rather than silently relaxing a constraint. Unicode byte counts, descriptors, array density, prototypes and serialization shape are checked.

## One reviewed request and local save

1. Explicitly inspect service policy without sending candidate data
2. Select exact local source rows and constraints; review the full payload and recipient disclosures
3. Check the initially unchecked consent and explicitly generate
4. Prepare sends only the exact policy/payload digest and byte count to obtain a server-issued intent
5. Generate sends the reviewed payload and exact policy/payload consent for that intent, once
6. Review resolved local exercise snapshots, order, targets, notes, equipment, ancestry and replacement-plan differences
7. Explicitly confirm local save; recheck the same account, current policy, current complete intent and unchanged result before the atomic state update

The server binds each intent to the verified web session, account, password/reset generation and complete policy digest. It atomically marks dispatch before awaiting the adapter. A replay reads status; it never dispatches again. Unknown, expired or lost-after-restart intents cannot be reconstructed. Requests use the existing web cookie/CSRF/origin boundary, a narrow route allowlist, bounded streaming reads and explicit abort signals. AI routes are not added to the native allowlist. See [the exact server contract](../server/AI_PLANS.md).

Source, input, account, route and visibility changes invalidate old reviews and callbacks, including observed edit/revert/archive cycles. Cancel, hide or leaving the page discards the local review and attempts to cancel its server intent. Late responses cannot re-enable Save. There is no automatic polling or provider retry. Cancellation or timeout can still incur charges and does not prove processing or retained remote copies stopped.

Saving creates fresh workout/exercise IDs, copies selected local snapshots, sets calories explicitly unknown, and saves the prior plan in the existing twenty-version history. It does not change the active session, completed history, library, profile or nutrition. The replacement has no inferred supersets/circuits; the review discloses removed grouping and possible oldest-version eviction. An unfinished editor draft is cleared only after successful persistence; failed saves preserve it and the result review. A failed draft cleanup is reported explicitly.

## Persistence and compatibility

No AI request, consent token, intent or unapplied result is added to AppState, browser storage, backups, manual sync, account exports or service-worker caches. The server stores bounded ephemeral intent/results in memory and only hashed prepare/dispatch quota counters in SQLite. A non-cooperative adapter can retain its one in-flight request until it settles; the process keeps its concurrency slot occupied and refuses further provider work. No local timeout can guarantee remote erasure or a billing cap.

Applied plans use the existing version-4 plan schema and the previously introduced explicit unknown-calorie marker. Earlier readers that cannot understand that marker reject it without overwriting their original bytes. There is no new database or persisted AI-schema migration. Existing local backup/restore, plan rollback, manual sync and account export preserve the applied plans. Their notes/targets may later be sent through separately consented ordinary cloud transfers and existing training-category coach projections; AI consent does not expand those sharing categories.

## Still required before real use

- Owner/operator decisions on audience and nonclinical scope, exact provider/model/API and processing organization/region
- Approved, truthful recipient/privacy/retention/training terms and consent language, including provider deletion limits
- A reviewed real adapter with fixed endpoint/model, credential custody, bounded network/stream handling, cancellation behavior and no retry/fallback surprises
- Payer, pricing, request/daily spending controls and verification of the provider's actual charging behavior; declared minor-unit limits alone are not billing enforcement
- Approved email/HTTPS account service, operational retention/backup/abuse monitoring and appropriate multi-instance controls before scaling
- Browser cookie/layout/accessibility acceptance and, separately, native transport compilation, UI integration and real-device acceptance

The automated checks use only synthetic identities, payloads and adapters. They do not measure model quality, prove medical safety, establish legal compliance, verify real charges or constitute production/native acceptance.
