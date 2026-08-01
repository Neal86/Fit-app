# FitFlow

FitFlow is a single-codebase fitness application for Web, iOS, and Android. The React/TypeScript application runs on the web and is packaged for native mobile platforms with Capacitor.

## Delivered product scope

- Guided first-run onboarding
- Personalized goals, experience level, height, weight, and weekly target
- Responsive desktop, mobile web, iPhone, iPad, and Android layouts
- Dashboard with weekly completion, calories, minutes, and next-workout recommendation
- Searchable workout library
- Structured exercise-by-exercise workout flow
- Live session timer, exercise completion, notes, calories, and duration logging
- Workout history with delete support
- Body-weight logging and trend summary
- Correct BMI calculation from saved height and weight
- Versioned local persistence with safe fallback
- JSON backup export and import
- Reset controls and reduced-motion preference
- Empty states, confirmation feedback, and runtime error recovery
- Web PWA installation and offline service worker
- Capacitor iOS and Android runtime configuration
- Native status bar, Android back-button behavior, network-state integration, and haptic support
- iOS safe-area and Android full-screen viewport handling
- Apple privacy manifest and Android secure-network configuration
- Production Docker image with Nginx SPA fallback, health check, caching, and security headers

## Install and run the Web application

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Production Web build

```bash
npm run build
```

The output directory is `dist`.

## iOS and Android

Create the native project folders once after installing dependencies:

```bash
npm run native:add:ios
npm run native:add:android
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

See `STORE_RELEASE.md` for signing and submission instructions.

## Docker / Coolify

- Build pack: Dockerfile
- Container port: `80`
- Health endpoint: `/healthz`
- Environment variables: none required for the local-first edition

No GitHub Actions or automatic CI workflow is included.

## Data and privacy

Profile details, workout history, settings, notes, and weight entries remain on the user's device. The application does not require a cloud account and does not transmit fitness data in the delivered local-first edition. Review `PRIVACY.md` before public distribution and replace the business contact placeholder.

FitFlow is not a medical device. Calories and BMI are informational estimates and are not medical diagnosis or treatment guidance.

## Store publication boundary

The source code and native platform configuration are included. Producing signed App Store and Google Play binaries requires the owner's Apple Developer and Google Play credentials, signing certificates/keys, final legal contact details, screenshots, pricing, and store-account approvals. These secrets must not be committed to GitHub.
