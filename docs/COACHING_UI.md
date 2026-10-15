# Manual coach collaboration UI

## Integration

Import the default component from `src/components/Coaching.tsx` and render `<Coaching client={client} />` inside the signed-in Account page. Pass the existing stable `CloudClient`; do not create a second account client, pass device `AppState`, or persist the component/client.

`CloudClient.sessionRevision` is a primitive in-memory generation. `CloudClient.subscribeSession(listener)` returns an unsubscribe function. A clear, logout, expiry, failed/successful account switch, and same-account reauthentication invalidate the view. Account integration should also subscribe and immediately render-gate its own health-data and secret state against its captured generation. After a successful cloud-health-consent revocation, remount Coaching (for example with a local reset key) so its displayed grants cannot outlive that operation. Do not automatically fetch when remounting.

No requests occur on mount, identity notifications, local category choice, review, or Cancel. Native builds and builds without an explicit safe cloud endpoint remain unavailable. The separately configured server feature is off by default; only the manual availability button checks it.

## Authorization model

1. An athlete reviews the known coach email and confirms an invitation. The request can disclose the athlete's account identity to the intended eligible recipient. Generic HTTP 202 means only that the request was accepted; it proves neither account existence nor delivery.
2. The recipient reviews the athlete's email and account ID, then accepts or declines. Acceptance itself gives zero category access. Outgoing pending invitations are deliberately not enumerated; cancellation uses an explicitly reviewed known email.
3. The athlete opens a category selection for the exact accepted account ID/email. All checkboxes start clear, even if an older grant exists. The reviewed selection replaces access; selecting nothing removes every category. A separate confirmation is required.
4. Grants cover the chosen categories in the current and future manually saved cloud snapshots until changed or revoked. This UI never uploads device data. Server consent/version checks remain authoritative.
5. Either party can review and confirm ending the relationship. Own displayed collaborator records and drafts clear before submission; errors and uncertain outcomes require manual refresh and another review. Revocation cannot recall information already seen or copied.

Categories are explicit and independent:

- Training: plans, saved plan versions, workout history, exercise/workout notes
- Body: saved height/weight measurements and weight diary
- Nutrition: food/water entries and notes, manually entered targets

The client rejects ungranted or unknown categories and unknown nested fields. Snapshots exclude active sessions, preferences, credentials, name, birth year and full profile objects. Category fragments use the existing strict state/nutrition validators with synthetic unrelated defaults; the adapter never reads the actual local dataset.

## Read-only view and feedback

A coach manually requests a saved snapshot under the currently inspected relationship version. The view renders explicit category fields as React text, without HTML, Markdown interpretation, linkification, editing, advice generation, camera analysis or medical functionality. Long histories show up to 100 newest records with total counts. This is not a live view; there is no polling or push subscription. Remote revocation is enforced on the next server request; errors remove displayed information, and the UI asks for refresh. Closing the display, hiding the tab, changing identity or unmounting removes displayed data.

Feedback requires active training consent and current server cloud consent. Its exact recipient/text are reviewed before sending. The athlete can manually read retained feedback after revocation and confirm removal. The coach cannot read or send after revocation. A new secure operation ID is created for each explicitly confirmed send; uncertain writes are not retried automatically. Form text is bounded, plain text, with no HTML or links. Received text is rendered escaped even if an incompatible server sends markup-like content.

All counterpart health records, email drafts, feedback drafts and session/CSRF information remain in memory. Nothing is written to localStorage/sessionStorage. Session generations and request generations are rechecked at every transport and adapter await boundary, before cache/session mutations or returning private results. This prevents late responses from reviving data after logout or account replacement; an old logout/delete completion cannot clear a newer account. Hiding the tab also invalidates the view generation, so a delayed read cannot reappear on returning to the tab without a new explicit read. Conflict/403/401 responses clear private view state; there is no automatic permission repair or retry.

## Account export

The optional `coaching` account-export envelope contains the account's authorized invitation/relationship metadata and feedback groups only. The client validates group references, record bounds and coach training eligibility, and never accepts counterpart snapshots inside this envelope. Legacy exports without the field remain valid. Athlete retained feedback can be exported after relationship revocation. The server controls current coach eligibility.

Account export alone has a 64 MiB response cap for up to 50 relationships × 100 bounded feedback items, plus the user's own cloud snapshot. Other cloud requests retain the existing snapshot-sized cap. Export rechecks account generation after the lazy envelope validator loads.

## Verification and limits

Synthetic mocked-request Vitest tests, including deterministic microtask-boundary and hidden/returned-tab regressions, cover no configuration/mount traffic, session/CSRF guards, strict projections, zero-access acceptance, exact recipient/category review, Cancel, failed saves, conflicts, 403/401 clearing, revoke/leave/decline/cancel, duplicate submission, escaped text, session switches, delayed responses, storage absence and own-only export validation. Tests do not send real invitations or health data.

Browser visual verification was intentionally not run for this change. No real provider, deployment, native build, camera/AI integration or professional qualification verification is implied by passing unit/component tests. Live provider/security/legal/privacy acceptance and native release validation remain separate release gates.
