# FitFlow data handling summary

Release-review draft, updated 2026-10-15. This describes the source code; it is not a finalized operator privacy notice. The distributing business must finalize its identity, contact, audiences, hosting/processors, retention and legal notice before public release or enabling real-data cloud services.

## Local data

The default build works without an account or API. Profile/body measurements, goals, workout plans and previous plan versions (including explicitly recorded exercise equipment requirements), training sets/notes, active sessions, weight entries, manual food/water entries and daily targets, and preferences are stored in this application's local browser/WebView storage. It is not application-layer encrypted. Browser and native installations have separate stores. Available-equipment filter selections are temporary view state, not saved inventory or uploaded profile data.

Unfinished plan and nutrition edits use sessionStorage for recovery within the current tab. They are not part of saved backups. Successful import/reset/cloud restoration clears these drafts; cleanup failures are reported. Closing a tab, clearing storage or uninstalling can remove local records. Verify a private backup before uninstalling or clearing app storage.

There is no analytics SDK, ad SDK, external font request, food-database lookup, AI-model request, camera capture or wearable integration in this build.

## Optional cloud account and manual transfers

Cloud accounts are disabled unless a build-time API URL is explicitly configured. The account page shows the exact recipient. No request runs merely by visiting that page. Native cloud accounts are currently unsupported; native local training, nutrition and backup features remain available.

When an enabled web service is used:
- Account actions send the email and submitted password or verification/reset token to the configured service over its approved transport
- Passwords are salted and hashed on the server; session/email tokens are stored as hashes. Browser sessions use HttpOnly cookies; CSRF/session metadata stays in memory, not localStorage or sessionStorage
- Registration and recovery require an implemented, approved email adapter. The supplied executable deliberately has no live email provider and returns an unavailable error rather than inventing email delivery
- Cloud fitness access requires explicit recipient-specific consent. Each upload or device restore then requires a separate manual review and confirmation
- A full fitness snapshot includes profile/body measurements, training/notes and prior plan versions with saved equipment requirements, weight history, nutrition/targets, preferences and the paused active session. Records can reveal sensitive health information
- There is no background sync, third-party AI analysis or automatic health-data transmission
- Conflicts require another inspection and choice; local and cloud records are not automatically merged

The SQLite server stores the current snapshot. File access restrictions are not encryption. Real-data hosting requires separately approved processors, encrypted storage/backups, controlled access, retention and recovery arrangements. Those services are not configured by this source change.

## Optional coach collaboration

The separate coaching service is disabled by default. A signed-in user must manually request its availability. An invitation identifies one known account email; it sends no health snapshot and does not claim the person is a qualified coach. The recipient must explicitly accept. Every new accepted relationship starts with no health-data access.

The athlete then reviews the exact accepted account identity and explicitly chooses training, body measurements and/or nutrition categories. This is ongoing permission for the selected categories in current and future saved cloud snapshots until revoked. Training includes private workout/exercise notes and saved plan versions; body includes height/weight and the weight diary; nutrition includes manual food/water records, notes and targets. Full profile identity, birth year, preferences, equipment-requirement metadata and active/live sessions are never included in a coach projection. The coach sees only manual reads of already-uploaded snapshots, not unsaved device changes.

Permission and account verification are checked server-side on every read/write. Either accepted party may end a relationship; revocation stops future permitted reads. Revoking cloud-health consent also clears every coach category grant; re-enabling cloud consent never re-enables those grants. These controls cannot recall previously read, copied or exported data. Operators still need approved recipient/category consent text, retention and abuse-response policies before enabling real sharing.

Training-scoped coaches may submit bounded plain-text feedback, with a separate review before each submission. Feedback is not automated advice and professional qualifications are not verified. The athlete can read or remove their received feedback after revocation. No public directory, community feed, attached media, automatic invitations, model provider, or clinical moderation service is implemented.

## Optional private consistency challenges

A separate disabled-by-default service supports two known accounts and an immutable, inclusive UTC window of 1–31 dates. An invitation reveals account identities and the proposed dates to an eligible recipient, but no training count. Acceptance also grants no count access. Each participant separately reviews the exact counterpart account ID/email, date window, count field and current/future manually saved cloud scope before granting access. A count of training days is still health-related information even though raw workouts are excluded.

Both current challenge grants, verified accounts and cloud-health consent are required before a manual count read. The only shared metric is the number of UTC dates with a saved completed non-warmup set containing positive reps or seconds, capped at one per date. Legacy logs without set evidence, empty flags, timezone-ambiguous timestamps and future completions do not count. These are self-recorded values, not independently verified exercise, a ranking or a clinical recommendation. Counts can change after later manual uploads; no local data is automatically uploaded or scored for a peer. Raw dates, movements, notes, sets, loads, body/nutrition records and snapshot revisions are excluded from the challenge response.

Leaving or revoking access ends that challenge. A separately confirmed block ends all challenges between the two accounts and prevents further invitations in either direction; this bounded version does not provide an unblock control. Cloud-health consent revocation clears both participants' grants on affected active challenges, and later cloud opt-in does not restore them. Grants also have a documented expiry. Displayed challenge data remains in the mounted view only and is cleared on closing, hiding, account changes and errors. Previously viewed/copied information cannot be recalled. There is no public feed, free-text posting, notification delivery or prize service. Operators still need reviewed consent, abuse/retention handling and real browser acceptance before enabling this service.

## Export, revocation and deletion

Local JSON backups and password-confirmed cloud account exports contain private records; keep them in a private location. A cloud export excludes unsynced local changes and another athlete’s snapshot. It includes the caller’s coaching relationships, incoming invitations and currently permitted authored/received feedback; removed feedback text is excluded. Optional challenge export contains only the caller's own accepted/terminal challenge metadata, excluding counterpart identity, peer consent and all counts/snapshots. Exported copies are controlled separately by whoever saves them.

Local reset removes the saved device dataset after confirmation. Cloud consent revocation removes the server fitness snapshot and sync operation metadata, clears coach category grants and clears both grants on affected active private challenges. Password-confirmed cloud account deletion removes that account, its sessions, email tokens, consent, snapshot, associated coaching relationships/invitations/feedback and challenge records/blocks on both sides. Cloud revocation and deletion preserve local device data. Deletion from the running database does not establish deletion of operator backups or previously exported files; a final deployment must define and verify that retention process.

## Device capabilities and release review

Native source includes network connectivity/status, haptics, splash/status-bar and keyboard behavior. The owner approved the Android manifest’s INTERNET permission. This does not add camera, location or health-platform access, and native cloud transport is still unsupported. No camera, microphone, precise location, contacts, photos, Apple Health or Health Connect integration is implemented.

Fitness/calorie information is not diagnosis or treatment, and manual nutrition targets are not prescribed by the app. Audience/age requirements, final business contact information, support channels and store disclosures remain operator release decisions. Do not publish this draft as a completed compliance claim.
