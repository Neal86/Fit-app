# Equipment-aware plan editing

Equipment requirements are user-entered metadata for a chosen exercise variant. Matching a list means only that its recorded equipment categories occur in the selected available categories. It does not assess technique, health, training intensity, exact machine design, resistance, load capacity or suitability. The app never infers requirements from a movement's name, prescribes a replacement or changes targets automatically.

## Explicit requirements

Each saved exercise can have one of three states:

- **Not specified:** the optional `equipment` property is absent. This is unknown, not a no-equipment declaration
- **No equipment:** the user explicitly chooses this state; the saved property is `[]`
- **Listed equipment:** every selected category is required. Choosing this mode without a category is an unfinished edit, not an implicit no-equipment declaration

The closed categories are barbell, weight plates, dumbbells, kettlebell, resistance bands, cable machine, weight machine, bench, squat rack, pull-up bar, step/platform, stability ball, exercise mat, stationary bike, treadmill, rowing machine and elliptical. Requirements outside these categories should remain unspecified rather than being relabelled as a match. Categories deliberately do not claim that any two pieces of equipment are interchangeable. Starter entries remain unspecified until the user records their chosen variant's requirements.

## Selecting and checking

Available-equipment choices are optional and temporary view state. They are not an equipment inventory, a saved profile preference, part of the JSON backup or sent to cloud accounts. Turning on a matching filter is an explicit choice. Unknown entries never become matches, an explicitly empty requirement list matches an empty available list, and a nonempty list requires **all** its categories.

The exercise library combines text/category filters with the selected equipment check. Turning the matching filter off leaves manual selection available. The plan editor shows recorded requirements and missing/unknown states for the current draft. The weekly schedule builder uses the same recorded metadata with its existing day and planned-time choices. A mismatch must be resolved deliberately; the app does not silently delete a selected day, substitute an exercise, shorten a workout or alter set targets.

Changing requirements or available equipment invalidates a prior review. Saving still uses transactional local storage and the existing reversible plan-history flow. A failed save retains the edit. Source-plan, route and dataset-generation changes require a current review rather than allowing an old callback to overwrite newer data.

A recovered tab draft has no trustworthy source-version marker. If it differs from the currently saved workout with the same identity, saving requires an additional confirmation naming that saved workout and explaining that the saved data may have changed. Cancel or failed storage keeps both the draft and saved data. A confirmed successful save archives the current plan before applying the draft. This is an explicit recovery choice, not an assertion that a conflict was proven. An identical draft or a recovered new workout does not need an overwrite confirmation.

Removing a selected workout always names the currently saved workout, even if the draft has a different title. The confirmation discloses that unsaved/recovered draft edits are discarded only after removal saves successfully. Cancellation or a storage failure preserves both. The removed saved plan remains in previous versions; completed logs and the active session are kept.

## Identity, history and portability

- Metadata corrections keep the exercise identity. A different selected library entry is copied under a fresh identity; equipment lists distinguish catalog variants, while list order alone does not
- Saving a plan affects future sessions. Full active-session workout snapshots and previous plan versions retain their original requirements
- Completed logs retain their existing movement-name/category snapshots and set values. This slice does not backfill or invent historical equipment records
- Session replacement preserves the selected entry's metadata in its new active-session movement, without changing already completed rows or saved plans
- The additive optional field retains AppState version 4 and the existing storage key. Legacy version 2/3/4 data without it remains valid and unknown; malformed, duplicate, unsupported or oversized lists are rejected by the shared validator
- Older app builds with the former strict validator can reject backups containing the new field. Upgrade the receiving app first; do not remove fields from the only copy of a backup. An optional cloud installation also needs the matching shared-validator version before accepting these snapshots
- Saved requirements are included in private local backups and explicitly confirmed full-state cloud uploads/account exports. Temporary available-equipment selections are not included
- Existing coach projection allowlists deliberately omit the new equipment field, including previous-plan entries. This slice does not expand a coach's authorized data fields. Private challenges still expose only their consented count metric

No new provider, request, permission, dependency or automatic sharing is needed for local equipment planning. Source-level tests and resource synchronization do not establish browser/device acceptance or native compilation.
