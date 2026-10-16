# Private consistency challenge UI

This optional web-only feature uses the Account page’s existing stable `CloudClient`. It never receives the device dataset and never computes or uploads a score from local records. No background request, polling, automatic upload, feed, comments, prizes or medical advice is part of this feature.

## Reviewed sharing

An invitation targets a known account email and fixes an inclusive UTC date window of 1–31 dates. Acceptance reveals the two account identities but grants no training-data access. Both participants must separately review the exact counterpart email and account ID, the immutable window, the precise count-only metric, and access to current and future manually saved cloud copies. All consent checkboxes start unchecked; the final reviewed mutation needs a separate explicit confirmation.

The metric is self-recorded, unverified training days. A UTC day qualifies only when a manually saved cloud snapshot contains a completed non-warmup set with positive reps or seconds on that date. At most one day is counted per UTC date. Legacy records without set evidence, empty/completed-flag-only records and future timestamps do not count. Displayed totals are bounded by the reviewed window and have no rank, winner or prize.

Only both participants’ current cloud consent and both explicit challenge grants permit a score read. Neither accepting an invitation nor granting access automatically reads scores or uploads data. A participant may grant access with their own cloud consent while waiting for the other person. Later manual uploads can change the count while consent remains enabled. No raw training dates, movements, notes, logs, body measurements, food records, loads or snapshot revisions belong in the challenge response.

Leaving ends the selected challenge. Blocking explicitly ends all challenges between this pair and prevents new invitations in either direction; this bounded version has no unblock control. Revoking cloud consent clears both participants’ challenge grants, and enabling cloud consent again does not restore them. Previously viewed or copied information cannot be recalled.

## Private view lifecycle

The feature starts collapsed. Opening controls, viewing a review, cancelling, closing, account/session notifications and remounts make no requests. A manual availability check is required before actions. Native and unconfigured builds remain unavailable.

Private identities, reviews, drafts and count results live only in the mounted view. They are never written to localStorage, sessionStorage, the service worker cache or a retry queue. Closing/collapsing, hiding the document, refreshing, unmounting, session replacement/expiry, local invitation/challenge expiry, revoke/leave/block submissions and errors clear them. A chunked local timer clears views and reviews at the earliest reviewed access deadline without network activity; in-flight reads and mutation notices crossing that deadline are discarded. Timers are cleaned up when the view changes or unmounts. Hidden-and-returned views require a fresh manual availability read. Duplicate submits are blocked synchronously. Every render captures a view epoch; edits, selection/review cancellation and error clearing advance it so retained old handlers cannot restore stale drafts or reviews.

Every async transport, adapter and component boundary checks its account/session generation. The view also checks its visibility generation. Late reads and mutations cannot revive a review or count result after a session or view change. There are no automatic retries or repairs; uncertain outcomes require a fresh read and review.

## Account export

The optional historical challenge envelope is validated independently before an account export is downloaded. It contains only your own accepted/terminal challenge metadata. Counterpart identity, peer consent, incoming invitations, block lists, challenge counts, raw training records and counterpart snapshots are excluded. Older exports without this envelope remain supported.

## Verification and release limits

Tests use only synthetic in-memory transports and deterministic time/visibility/session changes. Browser visual checks, native execution, configured providers, real invitations, live sharing, deployment and security/legal/privacy release acceptance are separate gates and are not implied by component or unit test success.

Focused coverage includes strict response and historical export validation, consent-bound requests, terminal/ceiling version handling, shared Account/Coaching invalidation, count expiry and long-deadline timer cleanup, and retained row/form/checkbox/confirm callback regressions. Full aggregate verification is coordinated in the integrated checkout.
