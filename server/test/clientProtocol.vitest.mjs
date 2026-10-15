import { afterEach, describe, expect, it } from 'vitest'
import { CloudClient, pausedCloudState } from '../../src/cloud'
import { CoachingClient } from '../../src/coaching'
import { freshState, parseBackup } from '../../src/storage'
import { finishSession, startSession } from '../../src/session'
import { applySessionReplacement, reviewSessionReplacement } from '../../src/sessionReplacement'
import { createApp } from '../app.mjs'
import { openDatabase } from '../database.mjs'

const ORIGIN = 'https://fitness.example.test'
const PASSWORD = 'Synthetic account password 123!'
const databases = []
afterEach(() => { databases.splice(0).forEach(db => db.close()) })
function service(options = {}) {
  const db = openDatabase(); databases.push(db)
  const messages = []
  const app = createApp({ db, config: { origin: ORIGIN, secureCookies: true, ...options }, mail: { enabled: true, async send(message) { messages.push(message) } } })
  function browser() {
    const jar = { cookie: '' }
    const fetcher = async (url, init) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      headers.origin = ORIGIN; headers.cookie = jar.cookie
      const result = await app.handle({ method: init.method, path: new URL(url).pathname, headers, body: init.body ?? '', ip: '127.0.0.1' })
      if (result.headers?.['set-cookie']) jar.cookie = result.headers['set-cookie'].split(';')[0]
      return new Response(result.status === 204 ? null : JSON.stringify(result.body), { status: result.status, headers: result.headers })
    }
    return { jar, client: new CloudClient(`${ORIGIN}/api/v1`, fetcher) }
  }
  async function registered(email) {
    const result = browser()
    await result.client.register(email, PASSWORD)
    const message = messages.findLast(item => item.to === email && item.kind === 'verify')
    expect(message).toBeDefined()
    await result.client.confirmVerification(message.token)
    await result.client.login(email, PASSWORD)
    return result
  }
  return { app, db, browser, registered }
}

describe('real client/server contract with synthetic cookie transport', () => {
  it('registers, verifies, consents, syncs version4 nutrition/history, exports and deletes', async () => {
    const f = service(), { client } = await f.registered('one@example.test')
    expect((await client.getConsent()).healthSync).toBe(false)
    await expect(client.inspectSync()).rejects.toMatchObject({ code: 'consent_required' })
    await client.setConsent(true)
    expect(await client.inspectSync()).toMatchObject({ revision: 0, state: null })
    const state = freshState(); state.profile.name = 'Synthetic athlete'
    state.nutrition.hydration = [{ id: 'synthetic-water', date: '2026-10-15', milliliters: 250, note: 'Synthetic only' }]
    state.planHistory = [{ id: 'synthetic-plan', savedAt: new Date().toISOString(), label: 'Synthetic prior plan', workouts: structuredClone(state.workouts) }]
    expect(await client.upload(state, 0, true)).toMatchObject({ revision: 1, replayed: false })
    expect((await client.inspectSync()).state).toEqual(state)
    expect((await client.exportAccount(PASSWORD)).sync.state).toEqual(state)
    await client.deleteAccount(PASSWORD, 'DELETE')
    expect(client.session).toBeNull()
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM users').get().count).toBe(0)
  })
  it('detects competing writes, revoked consent and cross-tab cookie identity changes', async () => {
    const f = service(), a = await f.registered('one@example.test'), b = f.browser()
    await b.client.login('one@example.test', PASSWORD)
    await a.client.setConsent(true)
    await a.client.inspectSync(); await b.client.inspectSync()
    await a.client.upload(freshState(), 0, true)
    await expect(b.client.upload(freshState(), 0, true)).rejects.toMatchObject({ code: 'sync_conflict', revision: 1 })
    await b.client.inspectSync()
    await a.client.setConsent(false)
    await expect(b.client.upload(freshState(), 1, true)).rejects.toMatchObject({ code: 'consent_required' })
    const other = await f.registered('two@example.test')
    a.jar.cookie = other.jar.cookie
    await expect(a.client.getConsent()).rejects.toMatchObject({ code: 'account_changed' })
    expect(a.client.session).toBeNull()
    expect((await other.client.getConsent()).healthSync).toBe(false)
  })
})


describe('real coaching client/server protocol with synthetic accounts only', () => {
  it('requires accepted scoped access, preserves export isolation and revokes future reads', async () => {
    const f = service({ coachingEnabled: true })
    const athlete = (await f.registered('athlete@example.test')).client
    const coach = (await f.registered('coach@example.test')).client
    const a = new CoachingClient(athlete), c = new CoachingClient(coach)
    await athlete.setConsent(true); await athlete.inspectSync()
    const state = freshState(); state.profile.name = 'Synthetic private athlete'
    state.nutrition.hydration = [{ id: 'synthetic-water', date: '2026-10-15', milliliters: 250, note: 'Synthetic only' }]
    await athlete.upload(state, 0, true)
    await expect(a.invite(coach.session.user.email, false)).rejects.toMatchObject({ code: 'confirmation_required' })
    expect((await c.overview()).invitations).toHaveLength(0)
    await a.invite(coach.session.user.email, true)
    const accepted = await c.accept((await c.overview()).invitations[0], true)
    expect(accepted.scopes).toEqual([])
    let relationship = (await a.overview()).relationships[0]
    relationship = await a.consent(relationship, ['body', 'nutrition'], true)
    let coachRelationship = (await c.overview()).relationships[0]
    const projected = await c.snapshot(coachRelationship)
    expect(Object.keys(projected.categories)).toEqual(['body', 'nutrition'])
    expect(projected.categories.nutrition.hydration[0].milliliters).toBe(250)
    expect(JSON.stringify(projected)).not.toContain(state.profile.name)
    await expect(c.sendFeedback(coachRelationship, 'Synthetic training note', true)).rejects.toMatchObject({ code: 'coaching_conflict' })
    relationship = await a.consent(relationship, ['training'], true)
    coachRelationship = (await c.overview()).relationships[0]
    expect(Object.keys((await c.snapshot(coachRelationship)).categories)).toEqual(['training'])
    await c.sendFeedback(coachRelationship, 'Synthetic training note', true)
    expect((await a.feedback(relationship)).feedback[0].text).toBe('Synthetic training note')
    const athleteExport = await athlete.exportAccount(PASSWORD)
    expect(athleteExport.coaching.feedback[0].items[0].text).toBe('Synthetic training note')
    const coachExport = await coach.exportAccount(PASSWORD)
    expect(coachExport.sync.state).toBeNull()
    expect(JSON.stringify(coachExport)).not.toContain(state.profile.name)
    await athlete.setConsent(false)
    await expect(c.snapshot(coachRelationship)).rejects.toMatchObject({ code: 'sharing_unavailable' })
    await expect(c.feedback(coachRelationship)).rejects.toMatchObject({ code: 'sharing_unavailable' })
    await athlete.setConsent(true)
    const empty = await athlete.inspectSync()
    expect(empty.state).toBeNull()
    await athlete.upload(state, empty.revision, true)
    relationship = (await a.overview()).relationships[0]
    expect(relationship.scopes).toEqual([])
    expect((await c.overview()).relationships[0].scopes).toEqual([])
    relationship = await a.consent(relationship, ['training'], true)
    coachRelationship = (await c.overview()).relationships[0]
    await a.revoke(relationship, true)
    await expect(c.snapshot(coachRelationship)).rejects.toMatchObject({ code: 'sharing_unavailable' })
    const revoked = (await a.overview()).relationships[0]
    expect(revoked.status).toBe('revoked')
    const feedback = (await a.feedback(revoked)).feedback[0]
    await a.removeFeedback(revoked, feedback, true)
    expect((await a.feedback(revoked)).feedback).toEqual([])
    await athlete.deleteAccount(PASSWORD, 'DELETE')
    expect((await c.overview()).relationships).toEqual([])
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count).toBe(0)
  })
  it('keeps collaboration disabled on the default server', async () => {
    const f = service(), { client } = await f.registered('local-default@example.test')
    await expect(new CoachingClient(client).overview()).rejects.toMatchObject({ code: 'coaching_disabled', status: 503 })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count).toBe(0)
  })
})


describe('replacement session preservation through the real sync contract', () => {
  it('round-trips paused replacement rows and finished movement snapshots without rewriting earlier records', async () => {
    const f = service(), { client } = await f.registered('replacement@example.test')
    await client.setConsent(true); await client.inspectSync()
    const state = freshState(); state.profile.unit = 'imperial'
    const startedAt = Date.parse('2026-10-15T10:00:00Z')
    const earlier = startSession(state.workouts[0], startedAt - 86_400_000)
    earlier.sets[0] = { ...earlier.sets[0], reps: 8, weightKg: 24.123456789, completed: true }
    state.logs = [finishSession(earlier, startedAt - 86_340_000)]
    state.planHistory = [{ id: 'synthetic-prior-plan', savedAt: new Date(startedAt).toISOString(), label: 'Synthetic prior plan', workouts: structuredClone(state.workouts) }]
    state.activeSession = startSession(state.workouts[0], startedAt)
    state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 123.5
    state.activeSession.restUntil = Date.now() + 30_000
    state.activeSession.sets[0] = { ...state.activeSession.sets[0], reps: 8, weightKg: 31.123456789, rpe: 7.5, warmup: true, completed: true }
    state.activeSession.sets[1] = { ...state.activeSession.sets[1], reps: 9, weightKg: 32.5, rpe: 8 }
    const original = structuredClone(state)
    const sourceId = state.activeSession.workout.exercises[0].id
    const selected = state.workouts[1].exercises[0]
    const remaining = state.activeSession.sets.filter(set => set.exerciseId === sourceId && !set.completed)
    const replaced = applySessionReplacement(state, reviewSessionReplacement(state, sourceId, selected))
    const movement = replaced.activeSession.workout.exercises.find(exercise => !state.activeSession.workout.exercises.some(previous => previous.id === exercise.id))
    expect(movement).toBeDefined()
    const replacementRows = replaced.activeSession.sets.filter(set => set.exerciseId === movement.id)
    expect(replacementRows).toHaveLength(remaining.length)
    expect(replacementRows.every(set => !set.completed && !set.warmup && set.reps === null && set.seconds === null && set.weightKg === null && set.rpe === null)).toBe(true)
    expect(replaced.activeSession.sets.find(set => set.id === original.activeSession.sets[0].id)).toEqual(original.activeSession.sets[0])
    expect(replaced.workouts).toEqual(original.workouts); expect(replaced.logs).toEqual(original.logs); expect(replaced.planHistory).toEqual(original.planHistory)
    expect(state).toEqual(original)
    const expected = pausedCloudState(parseBackup(JSON.stringify(replaced)))
    await client.upload(replaced, 0, true)
    const saved = await client.inspectSync()
    expect(saved.state).toEqual(expected)
    expect(saved.state.activeSession.runningSince).toBeNull(); expect(saved.state.activeSession.restUntil).toBeNull()
    expect((await client.exportAccount(PASSWORD)).sync.state).toEqual(expected)

    const restored = parseBackup(JSON.stringify(saved.state))
    const newSet = restored.activeSession.sets.find(set => set.exerciseId === movement.id)
    newSet.completed = true; newSet.weightKg = 12.3456789
    if (/sec/i.test(movement.reps)) newSet.seconds = 20
    else newSet.reps = 8
    const completed = finishSession(restored.activeSession, startedAt + 150_000)
    restored.activeSession = null; restored.logs = [completed, ...restored.logs]
    await client.upload(restored, saved.revision, true)
    const final = (await client.inspectSync()).state
    expect(final).toEqual(restored)
    expect(final.logs[0].exerciseSnapshots).toContainEqual({ id: sourceId, name: original.activeSession.workout.exercises[0].name, category: original.activeSession.workout.exercises[0].category })
    expect(final.logs[0].exerciseSnapshots).toContainEqual({ id: movement.id, name: selected.name, category: selected.category })
    expect(final.logs[1]).toEqual(original.logs[0])
    expect(final.workouts).toEqual(original.workouts); expect(final.planHistory).toEqual(original.planHistory)
    const other = (await f.registered('replacement-other@example.test')).client
    await other.setConsent(true)
    expect((await other.inspectSync()).state).toBeNull()
  })
})
