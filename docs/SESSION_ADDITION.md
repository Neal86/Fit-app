# Adding a movement during a session

An addition is an explicit edit to the **current unfinished session**. Choose a reusable library entry or enter a custom movement, edit the fields, review the exact result, and confirm. The app does not choose a movement, load or training intensity for you. Starter and user entries have not been assessed for personal suitability or technique.

## Review and save

- Review the name, category, exact 1–20 set count, rep/seconds target, rest, notes and equipment requirements before saving.
- Equipment can be unknown, explicitly none, or a list of supported required categories. An unfinished listed selection is not treated as no equipment.
- Confirmation appends one movement and exactly the reviewed number of blank set rows. New movement/row identities are distinct from identities in saved plans, sessions, history and prior plan versions.
- New rows start with blank reps, seconds, load and RPE; warm-up and completion are off. Recorded values and prior-load references are never borrowed from the selected entry.
- Cancel or back does not change saved data. A storage failure keeps the review and existing input available for correction or retry; it does not append a partial movement.

Existing movements, completed and unfinished rows, IDs, values, elapsed/running time, rest countdown and session notes stay intact. Existing valid and invalid pending load text stays in its entry unit. Saved plans, prior plan versions and previous workout logs are unchanged. The workout's original duration/calorie estimates are **not recalculated** for this addition.

The session can contain at most 50 movements and 2,500 set rows. An addition that exceeds either limit is rejected in full; no reviewed sets are silently dropped. The added movement can subsequently use the existing set controls and reviewed replacement flow.

## Current-context safeguards

The reviewed movement is a frozen snapshot. Session changes, finish/discard, dataset/account-generation changes, navigation or changes to pending load text require a fresh review. Editing the addition draft also invalidates its previous review, even if the text is changed back. Repeated clicks and retained callbacks cannot append the same successful review twice. A failed save can be retried only while the source context remains current.

The addition form and review are temporary page state. They are not automatically recovered after leaving the page. Confirmed additions are saved as part of the active session under the existing strict state schema; no new storage format or permission is introduced.

## History, backups and optional sharing

- Reload and private JSON backup preserve a confirmed active-session addition, including its exact metadata and recorded rows.
- Finishing uses the existing history format: exercise snapshots retain each movement's identity, name and category; set rows retain their recorded values. Exercise targets, rest, per-exercise notes and equipment are not added to historical label snapshots. Session notes remain a separate existing history field.
- There is no automatic upload. Explicit manual cloud transfer preserves the active addition in the owner's snapshot, pauses the transferred session and clears its transient rest countdown.
- Active sessions remain excluded from coach projections. A finished and explicitly uploaded log can appear under an already-consented training category, with the same existing label/set/session-note allowlist. Equipment metadata is not included, and no coach permission is expanded.
- Private challenges still count self-recorded completed-work days, at most once per UTC date. Additional movements or sets do not create additional counted days; unfinished sessions do not count.

Synthetic model/component/protocol tests do not replace browser focus, keyboard, responsive/accessibility or physical-device acceptance. Those checks remain separate release gates.
