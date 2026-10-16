# Saved-plan supersets and circuits

Saved grouping is a user-authored arrangement of existing planned sets for **future sessions**. It does not choose exercises, create additional sets, prescribe intensity, assess suitability or change workload estimates. Runtime completion and rest reuse the existing [session grouping model](SESSION_GROUPING.md).

## Author, review and save

Choose a name, 0–900 seconds of round rest, 2–6 ordered movements and 1–20 rounds. Explicitly select one existing planned set for each movement in each round. Selectors do not pair rows automatically. A planned slot is the exact pair of exercise identity and planned set number; duplicate exercise names are not identity.

Every round uses the same distinct movements in the same order. Each planned slot can belong to at most one round across all groups. A workout may have at most 25 groups; existing limits of 50 movements and 20 planned sets per movement remain unchanged. Extra, unselected sets stay ungrouped.

The review shows exact movement labels, set numbers, order, round rest and ungrouped slots. Confirming the review changes the editor draft. **Save workout plan** is still required to persist it and include it in backups. Group-only changes create a reversible plan revision through the existing 20-version history.

Remove a group explicitly before deleting one of its referenced movements or saving a set count that makes its references invalid. No membership is silently truncated, reassigned or removed. Increasing a movement's set count leaves the additional slots ungrouped. Renaming a movement remaps its identity and all planned references atomically when the workout is saved.

Draft recovery preserves supported grouping structure even while an ordinary numeric field is incomplete. Such a draft must be corrected or explicitly ungrouped before it can be saved or started. Malformed or unsupported saved definitions are rejected without normalization; rejected storage bytes are not silently overwritten. Failed saves retain the draft for a fresh explicit retry while its source is current.

## Start and execute

Starting a session resolves every selected planned slot through the newly created row map. The session, each set, each runtime group and each runtime round receive fresh identities. Names, exact membership order and chosen rest are copied into the existing `SessionGrouping` representation; no completion flag, measurement or timer is invented.

The active workout snapshot omits the saved `plannedGrouping` wrapper after this deliberate conversion. Only saved workouts and historical plan revisions retain that wrapper. Imported active snapshots containing it are rejected rather than flattened. This avoids dangling planned references when a user later adds or replaces movements in the session.

Later plan edits or restoring an earlier plan do not alter an active session, its raw entries, completed rows or past logs. Runtime replacement, additions, explicit ungrouping, partial finish and rest retain their existing behavior. Completing the last unfinished row in a round starts positive round rest; replay, hydration and duplicate callbacks do not restart it. Zero rest preserves an existing timer.

The pre-start view exposes the saved arrangement. Starting is bound to the reviewed saved-workout snapshot as well as current session, route and data/account generation. A stale or delayed updater cannot start an unseen mapping or create a second session after its original attempt has ended.

## Copies and historical plans

The first selected occurrence in a weekly schedule preserves its identities. A repeated occurrence receives fresh workout, exercise, group and round identities, with every planned member remapped together. Nested metadata is copied independently. A rename preserves the edited group's and round's identities while remapping changed exercise identities.

Each current plan and each individual historical plan validates planned identities independently. Revisions intentionally retain snapshot identities, so identical identities across separate revisions are not treated as corruption. New identity allocation avoids the supplied current dataset and fails atomically after bounded collision attempts.

## Schema and compatibility

`Workout.plannedGrouping` is optional and contains `{version:1, groups}`. Each group contains `id`, `name`, `restSeconds` and `rounds`; each round contains `id` and `members`; each member contains `exerciseId` and `setNumber`. There are no saved completion flags, group-type prescriptions or plan-to-session identity links. Remove the optional wrapper when its last group is removed; a present empty, null, undefined or unsupported wrapper is invalid saved data.

The top-level AppState remains version 4 and retains its existing storage key. Legacy data without planned grouping is unchanged. Supplied planned grouping anywhere under v2/v3 is rejected before a migration can discard it. Unknown fields, sparse arrays, invalid numbers, duplicate slots, cross-workout references and identity aliases are rejected atomically.

**Older strict v4 clients and APIs cannot read this new optional field.** They reject a definition-bearing dataset rather than flatten it. Keep a compatible private pre-feature backup if rollback may be needed. Preserve the newer full export separately before deliberately restoring an older backup, which omits later work. There is no automatic downgrade exporter. Upgrade the API before uploading newly grouped plans.

## Private data and acceptance

The owner's JSON backup, explicit manual cloud snapshot, account export and plan revisions preserve exact definitions. Transfer continues to pause active sessions and clear transient rest timers without replaying completion. No background upload is added.

Coach training projections omit planned definitions in both current and historical plans, and the coach client independently rejects them. Runtime group metadata and active sessions remain excluded. Private consistency challenges continue to expose only their separately consented self-recorded day count; planned groups and rounds add no credit.

Source, component, persistence and synthetic client/server tests are separate from browser layout, keyboard/accessibility, native compilation, device and store acceptance. Those platform gates remain unverified. This feature adds no permissions, service destination or provider.
