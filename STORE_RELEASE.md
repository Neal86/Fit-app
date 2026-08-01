# FitFlow Release Guide

FitFlow uses one React/TypeScript codebase for Web, iOS, and Android through Capacitor.

## Shared production build

```bash
npm install
npm run build
```

## Generate or refresh native projects

```bash
npm run native:sync
```

For a new checkout where native folders are not present yet:

```bash
npm run native:add:ios
npm run native:add:android
npm run native:sync
```

## Open native projects

```bash
npm run native:open:ios
npm run native:open:android
```

The iOS target opens in Xcode and the Android target opens in Android Studio.

## Application identity

- App name: FitFlow
- Bundle / application ID: `com.fitflow.app`
- Web output: `dist`
- iOS deployment target: use the current Capacitor-supported minimum
- Android target SDK: use the current Google Play requirement at release time

## Required owner-provided release credentials

Public store publication requires credentials that cannot be stored in source control:

- Apple Developer Program account and distribution certificate
- App Store Connect application record and provisioning profile
- Google Play Console account and Android upload signing key
- Final legal business name, support email, privacy-policy URL, and store contact details
- Final screenshots, store descriptions, pricing, territories, and age-rating answers

## Store privacy declaration

The delivered local-first edition does not send personal fitness information to a server. It uses local device storage, network-state detection, status-bar controls, and haptic feedback. Review `PRIVACY.md` and replace its contact placeholder before submission.

## Web / Coolify

Use the included Dockerfile, expose port `80`, and use `/healthz` as the health endpoint. No GitHub Actions or automated CI workflow is included.
