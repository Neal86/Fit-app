# Replacing an exercise during a session

A replacement is a user-chosen edit to the **current unfinished session**, not a recommendation. The exercise library contains editable starter/user entries; choosing one does not establish suitability, professional review or technique assessment.

## What changes

1. Choose an exercise with unfinished set rows, then select a replacement from the library.
2. Review the original and selected movements, the number of completed rows retained and unfinished rows replaced, and any entered values that will be cleared.
3. Confirm to save the change atomically. Cancel leaves the session unchanged. A failed save keeps the review available for retry and leaves saved data untouched.

All unfinished rows of the selected original exercise are replaced. Their exact count is preserved, up to 50. New rows receive new IDs, set numbers starting at 1, blank reps/seconds/load/RPE, and false warm-up/completion flags. Data from one movement is never copied into another movement's sets.

Completed rows retain their original movement, IDs, set numbers and recorded values. The original exercise remains in the session when completed work exists; otherwise it is replaced in place. Other exercises and their pending input remain unchanged. This operation never rewrites saved plans, previous plan versions or completed workout history.

The selected library entry's planned-set count remains its original 1–20 value. The session's actual remaining-row count can differ, and both are shown explicitly. No extra sets are added or silently truncated to match a template. The operation is unavailable when there is no unfinished work or when preserving completed work would exceed 50 session exercises. Oversized imported per-exercise row collections are not silently reduced.

## Identity and review safety

The new movement receives a fresh session exercise identity. Old movement records and prior-load references are not relabelled or automatically borrowed from the selected template. A finished log records both retained and replacement movement labels in its exercise snapshots.

Review state is temporary, not stored in backups. The apply step rechecks the current session and local review context. A changed/discarded/finished session, restored dataset, route lifetime change or changed pending input requires a new review. Repeated clicks cannot apply the same successful replacement twice. Session timer rerenders do not themselves rewrite saved state.

Valid and invalid measurement drafts remain in their entry unit. Only pending text belonging to the explicitly replaced unfinished rows is discarded after confirmation; completed and unrelated rows are retained. Correct a storage or validation error before navigating away from pending work.

## Persistence and limits

- No storage schema or account permission is added. The changed active session uses the existing strict local/cloud schema.
- Reload and JSON backup preserve the replacement rows and original completed work. The review dialog itself is not recovered.
- There is no automatic upload. The existing explicit manual cloud flow pauses elapsed timing and clears the transient rest countdown in the transferred copy; it preserves movement identities, set values, history and plans.
- Replacement does not reset elapsed time or an existing local rest timer. The workout's original duration/calorie estimates are not recalculated for the replacement.
- Automated source/component/protocol checks do not establish browser focus, responsive/accessibility, native keyboard or physical-device acceptance. Those remain release gates.
