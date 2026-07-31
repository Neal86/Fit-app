# Fit

A responsive fitness planning and workout tracking application built with React, TypeScript, and Vite.

## Included

- Responsive desktop and mobile navigation
- Personalized dashboard and weekly activity summary
- Structured workout plans with exercise-by-exercise completion
- Workout history, calories, minutes, and consistency metrics
- Editable user goals and profile settings
- Browser persistence with versioned local storage
- Installable web app manifest
- ESLint, strict TypeScript, and GitHub Actions CI

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Quality checks

```bash
npm run lint
npm run build
```

## Production deployment

Build command: `npm run build`

Output directory: `dist`

The project can be deployed directly to Vercel, Netlify, Cloudflare Pages, or any static hosting provider. Configure SPA fallback so unknown routes serve `index.html`.

## Data model

This client-ready MVP stores profile, workout plans, and workout logs in the browser. For a multi-user commercial release, replace the storage adapter in `src/App.tsx` with an authenticated API or managed backend while keeping the existing domain types in `src/types.ts`.
