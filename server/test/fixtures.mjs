import { randomUUID } from 'node:crypto'
import { createApp } from '../app.mjs'
import { openDatabase } from '../database.mjs'
import { hashPassword, token, digest, csrfFor } from '../security.mjs'
import { POLICY_VERSION, SESSION_TTL_MS } from '../config.mjs'

export const PASSWORD = 'synthetic long password 123!'
export const PASSWORD_HASH = await hashPassword(PASSWORD)
export const ORIGIN = 'https://fitness.example.test'
export const fixtureState = () => ({
  version: 4,
  nutrition: { version: 1, meals: [], hydration: [], targets: [] },
  planHistory: [],
  profile: { name: 'Synthetic Athlete', goal: 'Stay active', level: 'Beginner', weeklyTarget: 3, weightKg: 70, heightCm: 170, birthYear: 1990, unit: 'metric', onboardingComplete: true },
  preferences: { reducedMotion: false, soundEnabled: false, remindersEnabled: false },
  workouts: [{ id: 'workout-1', title: 'Synthetic session', day: 'Monday', duration: 30, calories: 150, difficulty: 'Beginner', description: 'Test only', exercises: [{ id: 'exercise-1', name: 'Walk', sets: 1, reps: '10', restSeconds: 30, category: 'Cardio' }] }],
  logs: [], weightHistory: [{ id: 'weight-1', date: '2026-10-15', weightKg: 70 }], activeSession: null,
})
export function setup(options = {}) {
  const db = options.db || openDatabase()
  let time = Date.parse('2026-10-15T12:00:00Z')
  const messages = []
  const mail = options.mail || { enabled: true, async send(message) { messages.push(message) } }
  const app = createApp({ db, config: { origin: ORIGIN, secureCookies: true, ...options.config }, mail, now: () => time })
  const request = (method, path, body, session, overrides = {}) => app.handle({ method, path: `/api/v1${path}`, body: body === undefined ? '' : JSON.stringify(body), ip: '127.0.0.1', ...overrides, headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-fitflow-client': 'web', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...overrides.headers } })
  function seed(email = `${randomUUID()}@example.test`, consent = false) {
    const id = randomUUID(), raw = token(), expires = time + SESSION_TTL_MS
    db.prepare('INSERT INTO users(id,email,password_hash,verified,created_at,consent,consent_policy,consent_at) VALUES(?,?,?,1,?,?,?,?)').run(id, email, PASSWORD_HASH, time, Number(consent), consent ? POLICY_VERSION : null, consent ? time : null)
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,last_seen) VALUES(?,?,?,?)').run(digest(raw), id, expires, time)
    return { id, raw, email, cookie: `${app.cookieName}=${raw}`, csrf: csrfFor(raw) }
  }
  return { db, app, request, seed, messages, close: () => db.close(), advance: ms => { time += ms }, now: () => time }
}
export const syncBody = (state = fixtureState(), baseRevision = 0, operationId = randomUUID()) => ({ state, baseRevision, operationId })
