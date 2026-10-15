# FitFlow

FitFlow is a single-codebase fitness application for Web, iOS, and Android. The React/TypeScript application runs on the web and is packaged for native mobile platforms with Capacitor.

## Current implemented scope

- Guided first-run onboarding
- Personalized goals, experience level, height, weight, and weekly target
- Metric/imperial body measurements and training loads, with canonical-safe entry, history and progress readouts
- Responsive desktop, mobile web, iPhone, iPad, and Android layouts
- Dashboard with weekly completion, calories, minutes, and next-workout recommendation
- Searchable workout library
- Editable workout plans with schedules, exercises, sets, rep targets, rest times, and notes
- Per-set reps, weight, timed sets, optional RPE, warm-up flags, last-session reference, and rest timer
- Durable unfinished sessions, wall-clock start/pause/resume, actual duration, and estimated calories
- Partial-session confirmation and duplicate-save protection
- Explicit mid-session exercise replacement with review, fresh unfinished rows and preserved completed work/history
- Date-filtered/searchable workout history, activity calendar and recorded working-set load summaries
- Dated body-weight entries and trends; backdated corrections do not replace the latest profile weight
- Reusable exercise entries from saved plans and starter templates, with category/search filters
- Explicit exercise equipment requirements, temporary available-equipment checks and optional all-required library/schedule filtering, with unknown kept distinct from no equipment
- Reviewed weekly schedule builder with time limits and reversible previous plan versions
- Manual food/water diary, user-entered daily targets, edit/delete flows and session-scoped draft recovery
- Optional web account/consent/manual cloud-sync UI, disabled without explicit configuration
- Tested account/session/reset/verification API, isolated SQLite storage, CAS/idempotent sync and password-confirmed export/deletion
- Optional default-off coach collaboration: accepted identities, explicitly scoped saved-cloud access, revocation and reviewed plain-text feedback
- Optional default-off private consistency challenges: two accepted accounts, separate exact-window grants and count-only self-recorded training days from manual cloud copies
- Correct BMI calculation from saved height and weight
- Version 2/3 to 4 migration, strict shared local/cloud validation, stale-tab overwrite protection and non-destructive corrupt-data recovery
- JSON backup export and import
- Reset controls and reduced-motion preference
- Empty states, confirmation feedback, and runtime error recovery
- Web PWA installation and offline service worker
- Complete Capacitor iOS (Swift Package Manager) and Android projects with FitFlow icons and launch screens
- Native status bar, Android back-button behavior, network-state integration, and haptic support
- iOS safe-area and Android full-screen viewport handling
- Apple privacy manifest and Android secure-network configuration
- Production Docker image with Nginx SPA fallback, health check, caching, and security headers

See [measurement preferences](docs/MEASUREMENT_UNITS.md) for entry behavior, canonical storage and validation bounds.

See [session exercise replacement](docs/SESSION_REPLACEMENT.md) for exactly what changes, what remains intact and stale-review safeguards.

See [equipment-aware planning](docs/EQUIPMENT_PLANNING.md) for user-entered requirements, exact category matching, unknown states and backup/sharing boundaries. Matching equipment is not an assessment of an exercise's suitability.

Coach collaboration requires separate service activation and explicit recipient/category consent. It is not professional verification or a live coaching service. See [backend contract](server/COACHING.md), [UI integration](docs/COACHING_UI.md) and [data handling](PRIVACY.md).

Private challenges require separate service activation and both participants' explicit consent to one another, a fixed UTC window and the count-only field. They have no public feed, prizes or verified exercise claims. See [challenge contract](server/CHALLENGES.md) and [private view behavior](docs/PRIVATE_CHALLENGES_UI.md).

## Install and run the Web application

The local-only Web build requires Node.js 22 or newer. The optional SQLite server and complete `npm run check` suite require Node.js 24.15 or newer.

```bash
npm ci
npm run dev
```

Open `http://localhost:5173`.

## Production Web build

```bash
npm run build
```

The output directory is `dist`.

## iOS and Android

The native projects are checked in. Install the locked dependencies and sync the Web bundle:

```bash
npm ci
npm run native:sync
```

Open the projects:

```bash
npm run native:open:ios
npm run native:open:android
```

After any Web code change, refresh both native applications with:

```bash
npm run native:sync
```

Application identity:

- Product name: `FitFlow`
- iOS bundle ID: `com.fitflow.app`
- Android application ID: `com.fitflow.app`
- App version: `3.0.0`; initial native build number / version code: `1`
- Xcode scheme: `App` (display name: FitFlow)

Capacitor 8 requires Node.js 22+, Xcode 26+ on macOS for iOS, and Android Studio 2025.2.1+ with SDK 36 / JDK 21 for this Android project. See the [official environment setup](https://capacitorjs.com/docs/getting-started/environment-setup).

The `native:add:*` commands are only for a deliberately new platform whose directory does not exist. Do not delete these checked-in projects or run `cap add` over them: that would discard the privacy manifest integration, secure-network/backup rules, and native artwork.

Native scaffolding and asset synchronization are separate from compiling and testing an iOS or Android app. A successful Web build does not establish native release readiness. Web exports download a JSON file. Native exports use Web Share when available, with a copyable JSON fallback; native sharing, clipboard, file import, and device-specific flows still need on-device acceptance testing. Web and native have separate local data stores. Do not uninstall a native app until its records are backed up and the backup has been verified.

See `STORE_RELEASE.md` for signing and submission instructions.

## Docker / Coolify

- Build pack: Dockerfile
- Container port: `80`
- Health endpoint: `/healthz`
- Environment variables: none required for the local-first edition

No GitHub Actions or automatic CI workflow is included.

## Data and privacy

The default build keeps fitness/nutrition data on the device and sends no account/cloud requests. Optional Web cloud access requires an explicitly configured same-site HTTPS API, a verified account, recipient-specific consent and manual transfer confirmation. Native cloud access is disabled. No live email provider, production host or real health-data processor is configured. Review `PRIVACY.md`, `ACCOUNT_INTEGRATION.md` and `server/README.md` before enabling cloud services; the privacy document remains an operator-review draft.

FitFlow is not a medical device. Calories and BMI are informational estimates and are not medical diagnosis or treatment guidance.

## Optional account server

The server is off by default and requires Node.js 24.15+. API/storage source and synthetic tests are in `server/`. It provides register/verify/login/logout/reset, session-bound reads/writes, consent, versioned full-state sync, export and account deletion. The supplied startup deliberately has no live email adapter; it cannot create a usable verified account until an approved adapter is implemented and configured.

Read [server setup and security boundaries](server/README.md) and [account UI integration](ACCOUNT_INTEGRATION.md). `.env.example` contains no credentials and enables nothing. Do not set an API destination for real health data until hosting, privacy, retention and data-transfer scope are approved. The Dockerfile currently packages only the default static local-first Web app; it does not deploy the account server.

## Verification and remaining product scope

Run manual checks with `npm run check`. Browser journeys are in `e2e/`; run `npm run test:e2e:install`, then `npm run test:e2e` after building. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an already installed Chromium. No automatic CI is configured.

See [release readiness](RELEASE_READINESS.md) for passed checks, blocked checks, acceptance criteria, and the remaining production-service/native/AI/commercial scope. The local-first edition is not the complete multi-user commercial product.

## Store publication boundary

The source code and native platform projects are included. Producing signed App Store and Google Play binaries requires the owner's Apple Developer and Google Play credentials, signing certificates/keys, final legal contact details, screenshots, pricing, and store-account approvals. Native compilation and physical-device acceptance are required before publication. These secrets must not be committed to GitHub.
