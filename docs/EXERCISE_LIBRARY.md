# Personal exercise library

This is a persistent library of exercises the user writes manually. It is not an expert-reviewed instruction catalog, a suitability assessment, an AI recommendation or a live technique service. Existing starter and saved-plan entries remain available; no exercises are harvested or saved into the personal library automatically.

## Authoring and recovery

Open **Your exercise library** from the plan builder or exercise pickers. Start with a blank form and enter a name, category, 1–20 sets, target text, 0–900 seconds of rest, optional notes and optional equipment categories. Unknown equipment remains distinct from an explicit empty list. Review exact content and destination, then confirm before persistence. The form is temporary; unsuccessful saves retain it and its review, while cancelling/leaving can discard it. Do not rely on an unsaved library form as a backup.

Entries have stable identities, a positive safe-integer content revision, an active/archived status and canonical UTC creation/update timestamps. Actual content changes increment the revision. Identical content saves are no-ops; archiving/restoring does not increment the content revision. Backward or invalid update times are rejected without changing existing data. At the maximum revision, content edits are blocked while status changes remain possible.

Archive hides an entry from new personal-library copy choices; restore makes it available again. Both require review. Neither rewrites existing plan/session/history copies. No permanent entry deletion is exposed. There can be at most 500 entries, including archived entries. Archiving does not free capacity; nothing is evicted or truncated automatically.

## Copies and historical ancestry

Plan, session-addition and session-replacement pickers expose active personal entries with their identity/revision rather than merging distinct entries because they have equal names. Choosing a personal entry captures an exact review. The plan confirmation adds a fresh-identity copy to the unsaved plan draft; **Save workout plan** persists the plan. Session addition/replacement use their existing exact session review and preserve completed work, unfinished unrelated input, timers and history. A replacement retains the count of unfinished rows being replaced, even if the library's planned set count differs.

Copies capture `libraryOrigin: {version:1, entryId, revision}`. This records historical ancestry only. The destination may subsequently be edited. It is not a live foreign key, proof of current library content, expert approval or evidence the copied targets remain suitable. A valid historical origin can exist without any local library, after backup/plan restoration, or after the source is archived or edited. UI labels use the captured revision rather than resolving current library names or values.

Review tokens are ephemeral. They bind to the current state/library/source objects and their serialized values. An edit/revert or archive/restore cycle invalidates an outstanding copy review even if its content revision is unchanged. Route, account/data generation, draft changes, cancelled or completed attempts and delayed callbacks are independently fenced. Failed persistence does not consume a still-current review or overwrite prior saved bytes.

Fresh destination IDs are reserved against all current data and pending drafts, including source entry IDs and orphaned historical origin references. Plan rename/copy/schedule, session start/add/replace/finish and plan history preserve ancestry by independent snapshot copies. Ordinary custom movements do not acquire invented ancestry.

## Schema and compatibility

AppState remains version 4 with optional `exerciseLibrary: {version:1, entries}`. Absence is left absent; an explicitly present empty library is valid. Each entry contains exactly `id`, `revision`, `status`, `createdAt`, `updatedAt` and `exercise`; its exercise content excludes an exercise ID and origin. Library metadata is permitted only at its defined root or exercise/snapshot locations. Null/undefined-present wrappers, unsupported versions, unknown fields, sparse arrays, duplicate or aliased library identities, invalid timestamps and unsafe revisions are rejected without repair.

Legacy v2/v3 data without the extension still migrates normally. Library/origin metadata anywhere in a v2/v3 object is rejected before a migration could discard it. **Earlier strict v4 clients and APIs reject the new optional metadata rather than flattening it.** Upgrade compatible readers before transferring it. Preserve a private pre-feature backup for any deliberate rollback and a separate new full export to retain later work. Restoring an older backup omits later records. There is no automatic downgrade or destructive metadata stripping.

Local writes check the complete compact UTF-8 JSON against the existing 10 MiB reader limit before touching saved bytes. Quota errors, size failures and stale-tab compare-and-swap conflicts leave previous bytes intact. Backup export uses compact JSON and validates the finalized paused snapshot before offering it for download or sharing. This avoids creating a whitespace-expanded or newly over-limit backup that its own reader cannot import.

## Private transfers and sharing

A local full backup, the owner's explicitly confirmed manual cloud snapshot and own account export include active **and archived** entries, notes, targets, equipment and copied ancestry. Consent/upload/import summaries disclose these records. Plan-only restoration leaves the current personal library unchanged. No background synchronization, new recipient or external content service is added.

The library itself and `libraryOrigin` are omitted from all coach projections. The coach client separately rejects either field rather than inheriting the broader private-state schema. Names, notes and targets explicitly copied into a saved training plan remain ordinary training fields covered by the existing separately accepted coach training category. Equipment and planned/executed grouping retain their existing exclusions. Private challenges still count only qualifying saved self-recorded training days; creating, copying or archiving library entries adds no activity credit.

All automated account tests use synthetic accounts/data and an in-process service. Passing these tests is separate from browser layout/accessibility, native SDK compilation, devices, real service operation and store acceptance. Those platform gates remain unverified.
