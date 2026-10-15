# Measurement preferences

Choose **Metric (kg, cm)** or **Imperial (lb, in)** during setup or in Profile. Save the profile to apply the preference across the app. Imperial height uses decimal inches, not separate feet/inches fields.

## Canonical data and display

- Stored body weights, exercise loads and height remain `weightKg` and `heightCm`. Backups, manual cloud snapshots and coach projection schemas are unchanged.
- Conversion uses exactly 0.45359237 kilograms per international pound and 2.54 centimetres per inch.
- Inputs and readouts show up to two decimal places. The original canonical number is retained for an unchanged field; changing units repeatedly or saving an unrelated profile edit does not round or rewrite historical values.
- Exercise volume remains calculated from completed working sets in canonical kilograms, then converts for display. Unit selection does not change which sets, records or personal bests are included.
- Nutrition continues to use its explicitly labelled grams and millilitres. Choosing imperial body/load units does not reinterpret food or water entries.
- Optional coach views use the viewer's preference. This does not disclose the athlete's profile preference or expand granted data categories.

## Entry behavior

Use a decimal point for fractional input. Negative, non-finite, exponent, comma-separated and non-numeric values are rejected. Existing storage bounds remain 30–300 kg for body weight, 120–230 cm for height and 0–1000 kg for external load. These are application input bounds, not recommended targets. Imperial range labels include the canonical bounds because rounded endpoint labels are approximate.

Body weight and height are required. A blank exercise-load field means no recorded external load; an explicit `0` remains a recorded zero. Incomplete decimal text is retained while editing. Changing profile units with an invalid measurement is blocked until the entry is corrected. If the saved preference changes while a session/progress draft is invalid, that draft remains labelled in its original entry unit rather than being silently reinterpreted.

Session loads save on leaving the field, pressing Enter, completing its set or finishing the workout. A failed save retains the text on the current page; correct the error and retry before leaving. Completion and finish validate pending load text rather than silently recording the previous load. Other session changes retain immediate persistence. Profile and dated weight entries use their explicit Save buttons.

## Acceptance limits

Automated source and component tests cover conversion boundaries, unchanged-value preservation, repeated switches, invalid/partial input, save failures, history and volume display, session reloads and local backup restoration. Browser keyboard/focus behavior, real responsive/accessibility acceptance and native device keyboards remain release gates. No native SDK or device acceptance is implied by source tests or asset synchronization.
