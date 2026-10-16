# Session-only supersets and circuits

This is an explicit arrangement of existing rows in the **current unfinished session**. It does not author a saved plan, prescribe a training method, create sets or choose intensity. Group names and movement selection are user-entered, not clinical or technique guidance.

## Select and review

Choose 2–6 distinct current movements, their order, an exact number of rounds and a 0–900 second round-rest duration. For every round and movement, explicitly select an existing unfinished, non-warmup, ungrouped row. There is no automatic pairing by set number or movement label. The review shows the exact row mapping; extra rows remain outside the group. A group has 1–50 equal-width rounds; a session has at most 25 groups and retains the existing 2,500-row limit.

Confirming adds grouping metadata only. It does not change recorded or pending input, movement targets, exercise order, completed rows, elapsed time, the current rest countdown, workout estimates, saved plans or previous history. A successful review cannot be applied again against a changed current session. Session/data/account/view/input changes require a fresh review. A failed local save retains the form and review for a retry while its source remains current. Draft grouping forms are temporary page state.

## Completion and rest

- Every row keeps its own identity, reps or seconds, canonical kg load, RPE, warmup and completion state. Group and round IDs reference exact row IDs.
- Complete rows in any order. Only changing the final unfinished row in a round to completed starts that group's positive rest duration.
- Repeating an already-completed request, reloading, restoring a view or receiving a retained callback does not restart rest.
- Intermediate completion, explicit undo and a zero-rest group preserve an existing timer, including an already-expired deadline. Zero rest does not cancel a current countdown.
- Undo and then explicitly complete the last unfinished row again starts a new positive group rest. There is no automatic round completion, next-row focus or movement progression.
- Ungrouped rows continue to use their existing exercise-rest behavior. Group completion does not mark unrelated rows or the whole exercise completed.

## Safe changes and history

A grouped row cannot be deleted or marked warmup. A reviewed group removal is available only while all its referenced rows are unfinished; it removes metadata without changing rows. Completed rows must first be explicitly undone if the user intends to ungroup them. There is no automatic undo, membership editing or stored lifetime completion flag. New sets and session-only added movements are ungrouped.

Reviewed movement replacement keeps completed rows and references unchanged and maps only replaced unfinished rows to their fresh IDs. Round IDs, group IDs, names, order and rest remain intact. Earlier completed rounds can therefore retain the original movement while later unfinished rounds use the explicit replacement. The review discloses affected groups; labels and set numbers are never used as identity.

Finishing a partial session retains every grouped row reference, including unfinished members, plus the existing historical movement labels and recorded values. Read-only history resolves those labels from the log, not the current plan. There is no extra group credit, estimated workload adjustment or group analytics.

## Saved data, private transfer and compatibility

The optional `grouping` wrapper has `version: 1` and appears only on active sessions and workout logs. Each group stores `id`, `name`, `restSeconds` and `rounds`; each round stores `id` and `setIds`. There are no stored completion flags or fixed movement-member lists. The strict validator rejects malformed, unsupported, duplicated, dangling, warmup or cross-owner references atomically. Grouped logs require their saved row and movement-label snapshots.

The top-level app state remains version 4. Grouping is rejected under older v2/v3 inputs, so legacy migration cannot silently discard it. **Version 4 alone does not mean older builds can read this feature.** Earlier strict apps/APIs reject grouping-bearing data; they do not flatten or repair it. Before using grouping, keep a private backup from the previous version if rollback may be needed. Intentional rollback requires preserving/exporting the newer dataset separately and explicitly restoring a compatible pre-feature backup, which omits later changes. There is no automatic downgrade exporter. Older APIs must be upgraded before accepting new grouped snapshots.

Reload, private JSON backup, the owner's explicit manual cloud copy and password-confirmed account export retain grouping. As before, transfer pauses active sessions and clears transient rest timers; it does not replay completion or start a new timer. No background upload is added.

Coach training projections continue to include their existing historical row/label fields, but omit grouping names, IDs, rounds and rest metadata. Active sessions remain excluded entirely. The coach client independently rejects grouping in a response even though the owner's private-state parser accepts it. Private consistency challenges still expose only their separately consented self-recorded day count, at most one per UTC date; groups and rounds add no credit and unfinished active sessions do not count.

## Acceptance boundaries

Source tests cover schema limits, explicit identities, replacement/removal, out-of-order and repeated completion, partial finish, persistence failures, stale callbacks and synthetic transfer projections. Browser layout, keyboard/accessibility, offline behavior, native compilation/devices and store acceptance remain separate unperformed gates. Saved-plan supersets, automatic progression/deload, drop sets and clinical exercise suitability are not implemented by this session-only slice.
