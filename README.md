# FitFlow

FitFlow is a responsive, offline-first workout planning and progress tracking application built with React, TypeScript, and Vite.

## Delivered product scope

- Guided first-run onboarding
- Personalized goals, experience level, height, weight, and weekly target
- Responsive desktop and mobile navigation
- Dashboard with weekly completion, calories, minutes, and next-workout recommendation
- Searchable workout library
- Structured exercise-by-exercise workout flow
- Live session timer, exercise completion, notes, calories, and duration logging
- Workout history with delete support
- Body-weight logging and trend summary
- Correct BMI calculation from saved height and weight
- Local versioned persistence with safe fallback
- JSON backup export and import
- Reset controls and accessibility preference for reduced motion
- Empty states, confirmation feedback, and runtime error recovery
- Installable PWA metadata and offline service worker
- Production Docker image with Nginx SPA fallback, health check, cache policy, and security headers

## Local development

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Local verification

```bash
npm run check
```

This local command runs ESLint, Vitest, TypeScript, and the Vite production build. The repository does not include GitHub Actions or other CI workflows.

## Static hosting

- Build command: `npm run build`
- Output directory: `dist`
- Configure unknown routes to serve `index.html`

Suitable hosts include Vercel, Netlify, Cloudflare Pages, and similar static platforms.

## Docker / Coolify

The repository includes a production multi-stage `Dockerfile`.

- Container port: `80`
- Health endpoint: `/healthz`
- No environment variables are required for the offline-first edition

In Coolify, select **Dockerfile** as the build pack and expose port `80`.

## Data and privacy

The delivered edition is intentionally single-user and local-first. Profile details, workout history, settings, and weight entries remain in the browser on the current device. Users can export a JSON backup from the Profile page.

No medical diagnosis or treatment guidance is provided. Calorie values are estimates and should not be treated as clinical measurements.

## Commercial multi-user extension

Cloud accounts, subscriptions, coach dashboards, and cross-device sync require an authenticated backend and privacy/compliance review. The versioned domain model in `src/types.ts` is ready to be placed behind an API without redesigning the user interface.
