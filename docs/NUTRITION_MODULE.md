# Local nutrition diary

## Scope

Manual food and water records, daily totals, per-date optional manual targets, date/history browsing, edit/discard/delete confirmation, and visible persistence errors. No lookup service, prescribed calorie target, automatic nutrition calculation from serving text, diagnosis, weight-loss advice, external transmission, or new permission is used.

All food nutrient fields describe the **entire amount entered**. Users must supply each value; the form never guesses missing facts. Calories use kcal, protein/carbohydrates/fat use grams, and water uses milliliters. Display totals round to two decimal places while source values retain their precision. Blank/zero targets mean unset. Target changes apply only to the selected date.

## Integration contract (implemented in the main development branch)

1. In `types.ts`, import `NutritionState` from `./nutrition` and add required `nutrition: NutritionState` to `AppState`.
2. In `data.ts`, import `createNutritionState` and add `nutrition: createNutritionState()` to the initial state.
3. In the shared `stateValidation.ts`, import `parseNutritionState`. Parse the nutrition field before returning the validated cloned AppState, and include that parsed result in the return object. `parseNutritionState(undefined)` initializes a missing legacy diary; it does **not** treat null, malformed supplied data, unknown keys, duplicate IDs/dates, or unsupported nutrition versions as empty.
4. If moving the outer AppState schema to version 4, accept versions 2/3 as migrations, keep the existing storage key, and reject a missing nutrition field for version 4. Do not default a malformed new-format field. Existing v2 active-session migration remains required. Export/import/reset must include nutrition through the shared AppState path.
5. In `App.tsx`, import the default `Nutrition` component and add an accessible `/nutrition` navigation item/route. Suggested route:

   ```tsx
   <Route path="/nutrition" element={<Nutrition
     state={state.nutrition}
     onUpdate={change => update(current => ({
       ...current,
       nutrition: change(current.nutrition),
     }))}
   />} />
   ```

   `update` must synchronously evaluate the transform against the latest state, persist the **whole next AppState**, and apply React state only after persistence succeeds. Return `false` on failure. Do not enqueue the transform for later and return success early. The component owns its success message; no parent success toast is needed.
6. Review mobile navigation capacity after adding the route, and include meal/water/target record counts in backup replacement confirmation. Existing backup data is now more sensitive: retain local-only export/import behavior and explain its contents.
7. Import `clearNutritionDraft` from `./nutritionDraft` and call it only after successful backup import, app reset, corrupt-data reset/recovery, or cloud restore. It removes the session draft and remembered date. It returns `false` when removal fails; surface a warning rather than reporting verified cleanup. Failed imports/restores must retain drafts.
8. Add central integration tests for v2/v3 migration, v4 required fields, corrupt nutrition recovery, import/export round trips, route persistence across reload, reset, and quota failures. This branch intentionally does not change AppState, shared storage, navigation, dependencies, or package files.

## Validation and operation contracts

- `NutritionState`: `{ version: 1, meals: MealEntry[], hydration: HydrationEntry[], targets: DailyNutritionTargets[] }`
- Food entries require a stable ID, real calendar date, known meal type, nonblank food name and serving note, and four finite nonnegative nutrition values
- Water entries require a stable ID, date, positive finite amount, and optional string note
- IDs are unique across both food and water; targets are unique by date
- Dates use local-calendar `YYYY-MM-DD`, bounded to 1900–2200; day movement uses UTC calendar arithmetic to avoid DST shifts
- Bounds: 50,000 kcal, 10,000 g per nutrient, 20,000 ml, and 20,000 records per collection. These are technical validation limits, **not recommended intakes**
- Unknown object fields and sparse/missing records are rejected. Parser returns an isolated clone; callers' objects are not mutated
- `saveMealEntry` / `saveHydrationEntry`: pass `null` for a new entry or the exact previously displayed entry for an edit. New IDs cannot silently overwrite an existing item. Editing keeps the original ID
- `deleteMealEntry` / `deleteHydrationEntry`: pass the previously displayed entry. Stale edits/deletes and removed entries are rejected rather than overwriting or resurrecting them
- `saveDailyTargets`: pass the previous target or `null`; all-zero targets remove the per-date target record
- `createNutritionId` checks both collections and handles UUID collisions. A single draft retains its ID across failed-save retries
- The component preserves forms after failed persistence. Dirty drafts warn before date/editor switching and reload/close. Bounded sessionStorage drafts preserve all food, water, and target input strings, the selected date, stable ID and expected saved snapshot across app-route navigation/remount/reload within the tab. Drafts are separate from valid diary data and backups; closing the tab may discard them. Completed/cancelled forms are cleared while the selected date is retained. A restored form is visibly identified. Unreadable/oversized draft bytes stay untouched until the user starts a new form or changes date; malformed drafts never affect saved diary state. Draft read/write/cleanup failures are visible and never claim draft persistence. Restored stale edits remain subject to the same expected-value checks

## Verification

Verified in the isolated nutrition worktree on 2026-10-15:

- `npm run check`: passed lint, 127 tests across eight files, TypeScript, Vite production build, and offline-shell generation
- Nutrition-specific tests: 82 passed (40 pure module, 14 draft helper, 28 React Testing Library)
- Tests cover strict parsing, numeric/date/size bounds, legacy defaults, sums, zero/unset targets, stable/duplicate IDs, stale-write rejection, date moves/history, same-day edits, failure/retry, cancel/delete, target isolation, empty states, labeled controls, navigation restoration of invalid/incomplete input, malformed/oversized drafts, draft-storage failures and restored stale-value protection
- Layout is scoped and responsive, with one-column forms and two-column totals on small screens; minimum button height is 44px
- Browser E2E, screenshots, measured 360px overflow/visual/accessibility acceptance, and native-device acceptance are **not run**, per the executor restriction. No browser escalation or SDK installation was attempted
- The integrated development branch runs the full frontend/backend/protocol checks after AppState/navigation/storage integration. The production bundle in this isolated branch does not expose the new route until that integration happens
