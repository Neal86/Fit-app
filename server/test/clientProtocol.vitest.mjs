import { afterEach, describe, expect, it } from 'vitest'
import { CloudClient, pausedCloudState } from '../../src/cloud'
import { CoachingClient } from '../../src/coaching'
import { freshState, parseBackup } from '../../src/storage'
import { applyLibraryChange, reviewLibraryCreate, reviewLibraryEdit, reviewLibraryArchive, reviewLibraryCopy, materializeLibraryCopy } from '../../src/exerciseLibrary'
import { finishSession, startSession, setSessionCompletion } from '../../src/session'
import { applySessionReplacement, reviewSessionReplacement } from '../../src/sessionReplacement'
import { applySessionAddition, reviewSessionAddition } from '../../src/sessionAddition'
import { applySessionGrouping, reviewSessionGrouping } from '../../src/sessionGrouping'
import { savePlanRevision, schedulePreview } from '../../src/planning'
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

describe('equipment metadata through the real account and scoped-sharing contract', () => {
  it('preserves explicit none/unknown/listed requirements in own snapshots without expanding coach access', async () => {
    const f = service({ coachingEnabled: true })
    const athlete = (await f.registered('equipment-athlete@example.test')).client
    const coach = (await f.registered('equipment-coach@example.test')).client
    await athlete.setConsent(true); await athlete.inspectSync()
    const state = freshState()
    state.workouts[0].exercises[0].equipment = []
    state.workouts[0].exercises[2].equipment = ['dumbbells', 'bench']
    const startedAt = Date.parse('2026-10-15T10:00:00Z')
    const earlier = startSession(state.workouts[0], startedAt - 86_400_000)
    earlier.sets[0] = { ...earlier.sets[0], completed: true, reps: 8 }
    state.logs = [finishSession(earlier, startedAt - 86_340_000)]
    state.planHistory = [{ id: 'equipment-prior-plan', savedAt: new Date(startedAt).toISOString(), label: 'Synthetic equipment revision', workouts: structuredClone(state.workouts) }]
    state.activeSession = startSession(state.workouts[0], startedAt)
    state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 60
    const originalLogs = structuredClone(state.logs)
    // Changing a future plan never relabels an active session or earlier plan.
    state.workouts[0].exercises[0].equipment = ['barbell', 'weight-plates']
    const expected = pausedCloudState(parseBackup(JSON.stringify(state)))
    expect(expected.activeSession.workout.exercises[0].equipment).toEqual([])
    expect(expected.planHistory[0].workouts[0].exercises[0].equipment).toEqual([])
    expect(expected.workouts[0].exercises[1]).not.toHaveProperty('equipment')
    expect(expected.logs).toEqual(originalLogs)
    expect(expected.logs[0].exerciseSnapshots.every(item => !('equipment' in item))).toBe(true)
    await athlete.upload(state, 0, true)
    const saved = await athlete.inspectSync()
    expect(saved.state).toEqual(expected)
    expect((await athlete.exportAccount(PASSWORD)).sync.state).toEqual(expected)
    expect(parseBackup(JSON.stringify(saved.state))).toEqual(expected)

    const a = new CoachingClient(athlete), c = new CoachingClient(coach)
    await a.invite(coach.session.user.email, true)
    await c.accept((await c.overview()).invitations[0], true)
    await a.consent((await a.overview()).relationships[0], ['training'], true)
    const reviewedRelationship = (await c.overview()).relationships[0]
    const projected = await c.snapshot(reviewedRelationship)
    const training = projected.categories.training
    expect(training.workouts[0].exercises[0]).not.toHaveProperty('equipment')
    expect(training.workouts[0].exercises[2]).not.toHaveProperty('equipment')
    expect(training.planHistory[0].workouts[0].exercises[0]).not.toHaveProperty('equipment')
    expect(training.logs).toEqual(originalLogs)
    expect(JSON.stringify(projected)).not.toContain('"equipment":')
    expect((await coach.exportAccount(PASSWORD)).sync.state).toBeNull()

    const invalid = structuredClone(state)
    invalid.workouts[0].exercises[0].equipment = ['unsupported-equipment']
    await expect(athlete.upload(invalid, saved.revision, true)).rejects.toThrow()
    expect((await athlete.inspectSync()).state).toEqual(expected)
    await athlete.setConsent(false)
    await expect(c.snapshot(reviewedRelationship)).rejects.toMatchObject({ code: 'sharing_unavailable' })
    const revoked = (await c.overview()).relationships[0]
    expect(revoked.scopes).toEqual([])
    await expect(c.snapshot(revoked)).rejects.toMatchObject({ code: 'coaching_conflict' })
    expect((await athlete.exportAccount(PASSWORD)).sync.state).toBeNull()
  })
})

describe('session-only additions through the real account and scoped-sharing contract', () => {
  it('retains added blank rows in own snapshots, excludes active work from coach access and snapshots completed labels', async () => {
    const f = service({ coachingEnabled: true })
    const athlete = (await f.registered('addition-athlete@example.test')).client
    const coach = (await f.registered('addition-coach@example.test')).client
    await athlete.setConsent(true); await athlete.inspectSync()
    const state = freshState(); state.profile.unit = 'imperial'
    const startedAt = Date.parse('2026-10-15T10:00:00Z')
    const earlier = startSession(state.workouts[0], startedAt - 86_400_000)
    earlier.sets[0] = { ...earlier.sets[0], completed: true, reps: 8, weightKg: 24.123456789 }
    state.logs = [finishSession(earlier, startedAt - 86_340_000)]
    state.planHistory = [{ id: 'addition-prior-plan', savedAt: new Date(startedAt).toISOString(), label: 'Synthetic prior plan', workouts: structuredClone(state.workouts) }]
    state.activeSession = startSession(state.workouts[0], startedAt)
    state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 123.5
    state.activeSession.restUntil = startedAt + 200_000
    state.activeSession.sets[0] = { ...state.activeSession.sets[0], completed: true, reps: 9, weightKg: 31.123456789, rpe: 7.5, warmup: true }
    const original = structuredClone(state)
    const selected = { id: 'session-only-source', name: 'Synthetic session-only timed movement', sets: 2, reps: '25 sec', restSeconds: 40, category: 'Synthetic test category', notes: 'Synthetic active-entry note', equipment: ['exercise-mat'] }
    const added = applySessionAddition(state, reviewSessionAddition(state, selected))
    const movement = added.activeSession.workout.exercises.at(-1)
    expect(movement).toEqual({ ...selected, id: expect.any(String) })
    expect(movement.id).not.toBe(selected.id)
    expect(added.activeSession.sets.slice(0, original.activeSession.sets.length)).toEqual(original.activeSession.sets)
    expect(added.activeSession.sets.slice(-2)).toEqual([1, 2].map(setNumber => ({ id: expect.any(String), exerciseId: movement.id, setNumber, reps: null, seconds: null, weightKg: null, rpe: null, completed: false, warmup: false })))
    expect(added.activeSession.elapsedSeconds).toBe(123.5)
    expect(added.activeSession.restUntil).toBe(original.activeSession.restUntil)
    expect(state).toEqual(original)
    const expected = pausedCloudState(parseBackup(JSON.stringify(added)))
    await athlete.upload(added, 0, true)
    const saved = await athlete.inspectSync()
    expect(saved.state).toEqual(expected)
    expect(saved.state.activeSession.restUntil).toBeNull()
    expect((await athlete.exportAccount(PASSWORD)).sync.state).toEqual(expected)
    const a = new CoachingClient(athlete), c = new CoachingClient(coach)
    await a.invite(coach.session.user.email, true)
    await c.accept((await c.overview()).invitations[0], true)
    await a.consent((await a.overview()).relationships[0], ['training'], true)
    const relationship = (await c.overview()).relationships[0]
    const before = await c.snapshot(relationship)
    expect(before.categories.training.logs).toEqual(original.logs)
    expect(before.categories.training.workouts).toEqual(original.workouts)
    expect(JSON.stringify(before)).not.toContain(selected.name)
    expect(JSON.stringify(before)).not.toContain('activeSession')
    const restored = parseBackup(JSON.stringify(saved.state))
    const row = restored.activeSession.sets.find(item => item.exerciseId === movement.id)
    row.seconds = 25; row.completed = true; row.weightKg = 3.123456789
    const completed = finishSession(restored.activeSession, startedAt + 300_000)
    restored.activeSession = null; restored.logs = [completed, ...restored.logs]
    await athlete.upload(restored, saved.revision, true)
    const final = (await athlete.inspectSync()).state
    expect(final).toEqual(restored)
    expect(final.logs[0].exerciseSnapshots).toContainEqual({ id: movement.id, name: selected.name, category: selected.category })
    expect(final.logs[0].sets.find(item => item.id === row.id)).toEqual(row)
    expect(final.logs[1]).toEqual(original.logs[0])
    expect(final.workouts).toEqual(original.workouts); expect(final.planHistory).toEqual(original.planHistory)
    const after = await c.snapshot(relationship)
    expect(after.categories.training.logs[0]).toEqual(final.logs[0])
    expect(JSON.stringify(after)).not.toContain('"equipment":')
    expect(JSON.stringify(after)).not.toContain(selected.notes)
    expect((await coach.exportAccount(PASSWORD)).sync.state).toBeNull()
    await athlete.setConsent(false)
    await expect(c.snapshot(relationship)).rejects.toMatchObject({ code: 'sharing_unavailable' })
  })
})


describe('session grouping through own backup, account and scoped-sharing boundaries', () => {
  it('round-trips exact rows and partial historical groups while keeping private grouping out of coach responses', async () => {
    const f = service({ coachingEnabled: true })
    const athlete = (await f.registered('group-athlete@example.test')).client
    const coach = (await f.registered('group-coach@example.test')).client
    await athlete.setConsent(true); await athlete.inspectSync()
    let state = freshState(); state.profile.unit = 'imperial'
    const time = Date.parse('2026-10-15T10:00:00Z')
    state.activeSession = startSession(state.workouts[0], time)
    state.activeSession.elapsedSeconds = 123.5; state.activeSession.runningSince = null
    state.activeSession.restUntil = time + 60_000
    const source = structuredClone(state)
    const movements = state.activeSession.workout.exercises.slice(0, 2)
    const rounds = [0, 1].map(index => movements.map(exercise => state.activeSession.sets.filter(row => row.exerciseId === exercise.id)[index].id))
    state = applySessionGrouping(state, reviewSessionGrouping(state, { name: 'Synthetic private group marker', restSeconds: 45, rounds }))
    expect(state.workouts).toEqual(source.workouts)
    expect(state.activeSession.sets).toEqual(source.activeSession.sets)
    const grouping = structuredClone(state.activeSession.grouping)
    const backup = parseBackup(JSON.stringify(state))
    expect(backup.activeSession.grouping).toEqual(grouping)
    expect(backup.activeSession.sets).toEqual(source.activeSession.sets)
    await athlete.upload(state, 0, true)
    const saved = await athlete.inspectSync(), expected = pausedCloudState(state)
    expect(saved.state).toEqual(expected)
    expect(saved.state.activeSession.grouping).toEqual(grouping)
    expect(saved.state.activeSession.restUntil).toBeNull()
    expect((await athlete.exportAccount(PASSWORD)).sync.state).toEqual(expected)
    const a = new CoachingClient(athlete), c = new CoachingClient(coach)
    await a.invite(coach.session.user.email, true)
    await c.accept((await c.overview()).invitations[0], true)
    await a.consent((await a.overview()).relationships[0], ['training'], true)
    const relationship = (await c.overview()).relationships[0]
    expect(JSON.stringify(await c.snapshot(relationship))).not.toContain('Synthetic private group marker')

    let restored = parseBackup(JSON.stringify(saved.state))
    // Complete only the first round, in the opposite member order. The second round remains partial.
    for (const [index, id] of [...rounds[0]].reverse().entries()) {
      restored.activeSession.sets.find(row => row.id === id).reps = 8
      restored = setSessionCompletion(restored, id, true, 21.123456789, time + 150_000 + index)
    }
    expect(restored.activeSession.restUntil).toBe(time + 195_001)
    const finished = finishSession(restored.activeSession, time + 300_000)
    expect(finished.grouping).toEqual(grouping)
    expect(finished.sets.filter(row => row.completed)).toHaveLength(2)
    expect(finished.grouping.groups[0].rounds[1].setIds.every(id => !finished.sets.find(row => row.id === id).completed)).toBe(true)
    restored.logs = [finished]; restored.activeSession = null
    restored.workouts[0].exercises[0].name = 'Changed future plan label'
    expect(finished.exerciseSnapshots.find(exercise => exercise.id === movements[0].id).name).toBe(movements[0].name)
    await athlete.upload(restored, saved.revision, true)
    const final = (await athlete.inspectSync()).state
    expect(final).toEqual(restored)
    expect(parseBackup(JSON.stringify(final))).toEqual(final)
    expect((await athlete.exportAccount(PASSWORD)).sync.state).toEqual(final)
    const projected = (await c.snapshot(relationship)).categories.training
    const projectedLog = structuredClone(finished); delete projectedLog.grouping
    expect(projected.logs).toEqual([projectedLog])
    expect(JSON.stringify(projected)).not.toContain('grouping')
    expect(JSON.stringify(projected)).not.toContain('Synthetic private group marker')
    expect((await coach.exportAccount(PASSWORD)).sync.state).toBeNull()
    await athlete.setConsent(false)
    await expect(c.snapshot(relationship)).rejects.toMatchObject({ code: 'sharing_unavailable' })
  })
})


describe('saved planned grouping through own account and scoped sharing', () => {
  it('preserves copied/revised definitions and exact runtime rows through backup, manual sync, partial finish and export', async () => {
    const f = service({ coachingEnabled: true })
    const athlete = (await f.registered('planned-athlete@example.test')).client
    const coach = (await f.registered('planned-coach@example.test')).client
    await athlete.setConsent(true); await athlete.inspectSync()
    let state = freshState()
    state.workouts = [structuredClone(state.workouts[0])]
    state.workouts[0].exercises = state.workouts[0].exercises.slice(0, 2).map(exercise => ({ ...exercise, sets: 3 }))
    const workout = structuredClone(state.workouts[0])
    workout.plannedGrouping = { version: 1, groups: [{ id: 'planned-private-group', name: 'Private chosen arrangement', restSeconds: 37,
      rounds: [1, 3].map(setNumber => ({ id: `planned-private-round-${setNumber}`, members: workout.exercises.map(exercise => ({ exerciseId: exercise.id, setNumber })) })) }] }
    state = savePlanRevision(state, [workout], 'Before explicitly chosen grouping')
    const scheduled = schedulePreview(state.workouts, [{ day: 'Monday', workoutId: workout.id }, { day: 'Wednesday', workoutId: workout.id }], 600, { reserved: state })
    expect(scheduled[0].plannedGrouping).toEqual(workout.plannedGrouping)
    expect(scheduled[1].plannedGrouping.groups[0].id).not.toBe(workout.plannedGrouping.groups[0].id)
    expect(scheduled[1].plannedGrouping.groups[0].rounds[0].members.map(member => member.exerciseId)).toEqual(scheduled[1].exercises.map(exercise => exercise.id))
    state = savePlanRevision(state, scheduled, 'Before repeated weekly days')
    const startedAt = Date.parse('2026-10-15T10:00:00Z')
    state.activeSession = startSession(state.workouts[1], startedAt, { reserved: state })
    expect(state.activeSession.workout).not.toHaveProperty('plannedGrouping')
    expect(state.activeSession.grouping.groups[0].id).not.toBe(scheduled[1].plannedGrouping.groups[0].id)
    expect(state.activeSession.restUntil).toBeNull()
    const beforeActive = structuredClone(state.activeSession)
    const changedPlan = structuredClone(state.workouts)
    changedPlan[1].plannedGrouping.groups[0].name = 'Changed future-only private label'
    state = savePlanRevision(state, changedPlan, 'Before future arrangement edit')
    expect(state.activeSession).toEqual(beforeActive)
    const activeGroup = state.activeSession.grouping.groups[0]
    for (let index = 0; index < activeGroup.rounds.length; index++) {
      const rows = activeGroup.rounds[index].setIds.map(id => state.activeSession.sets.find(row => row.id === id))
      expect(rows.map(row => ({ exerciseId: row.exerciseId, setNumber: row.setNumber }))).toEqual(scheduled[1].plannedGrouping.groups[0].rounds[index].members)
      expect(rows.every(row => !row.completed && row.reps === null && row.weightKg === null)).toBe(true)
    }
    const own = pausedCloudState(state, startedAt + 123_000)
    expect(parseBackup(JSON.stringify(own))).toEqual(own)
    await athlete.upload(own, 0, true)
    const saved = await athlete.inspectSync()
    expect(saved.state).toEqual(own)
    expect((await athlete.exportAccount(PASSWORD)).sync.state).toEqual(own)
    const a = new CoachingClient(athlete), c = new CoachingClient(coach)
    await a.invite(coach.session.user.email, true)
    await c.accept((await c.overview()).invitations[0], true)
    await a.consent((await a.overview()).relationships[0], ['training'], true)
    const relationship = (await c.overview()).relationships[0]
    const before = await c.snapshot(relationship)
    expect(JSON.stringify(before)).not.toContain('plannedGrouping')
    expect(JSON.stringify(before)).not.toContain('Private chosen arrangement')
    expect(JSON.stringify(before)).not.toContain('Changed future-only private label')
    expect(JSON.stringify(before)).not.toContain('activeSession')
    let restored = parseBackup(JSON.stringify(saved.state))
    const round = restored.activeSession.grouping.groups[0].rounds[0]
    for (const id of round.setIds) {
      restored.activeSession.sets.find(row => row.id === id).reps = 8
      restored = setSessionCompletion(restored, id, true, 12.123456789, startedAt + 124_000)
    }
    expect(restored.activeSession.restUntil).toBe(startedAt + 161_000)
    const log = finishSession(restored.activeSession, startedAt + 300_000)
    restored = { ...restored, activeSession: null, logs: [log, ...restored.logs] }
    await athlete.upload(restored, saved.revision, true)
    const finished = (await athlete.inspectSync()).state
    expect(finished).toEqual(restored)
    expect(finished.workouts).toEqual(own.workouts); expect(finished.planHistory).toEqual(own.planHistory)
    expect(finished.logs[0].grouping).toEqual(beforeActive.grouping)
    expect(finished.logs[0].sets.some(row => !row.completed)).toBe(true)
    const projected = await c.snapshot(relationship)
    expect(projected.categories.training.logs[0]).not.toHaveProperty('grouping')
    expect(projected.categories.training.logs[0].sets).toEqual(finished.logs[0].sets)
    expect(JSON.stringify(projected)).not.toContain('plannedGrouping')
    expect((await athlete.exportAccount(PASSWORD)).sync.state).toEqual(finished)
    expect((await coach.exportAccount(PASSWORD)).sync.state).toBeNull()
  })
})


describe('personal exercise library through the real private sync and sharing contract', () => {
  it('preserves exact ancestry, archived entries and independent session/history snapshots', async () => {
    const f = service({ coachingEnabled: true })
    const athlete = (await f.registered('library-athlete@example.test')).client
    const coach = (await f.registered('library-coach@example.test')).client
    await athlete.setConsent(true); await athlete.inspectSync()
    const time = Date.parse('2026-10-15T10:00:00.000Z')
    const content = { name: 'Manual synthetic movement', category: 'User-authored', sets: 2, reps: '8', restSeconds: 25, notes: 'Copied training note', equipment: [] }
    let state = freshState()
    state = applyLibraryChange(state, reviewLibraryCreate(state, content), { now: time })
    const entryId = state.exerciseLibrary.entries[0].id
    const first = materializeLibraryCopy(state, reviewLibraryCopy(state, entryId))
    state = { ...state, workouts: [{ ...state.workouts[0], exercises: [...state.workouts[0].exercises, first] }, ...state.workouts.slice(1)] }
    state = savePlanRevision(state, state.workouts.map((workout, index) => index === 0 ? { ...workout, title: 'Copied library plan' } : workout), 'Library snapshot', new Date(time))
    expect(state.planHistory).toHaveLength(1)
    state = { ...state, activeSession: startSession(state.workouts[0], time + 1_000, { reserved: state }) }
    const additionToken = reviewLibraryCopy(state, entryId)
    state = applySessionAddition(state, reviewSessionAddition(state, additionToken.exercise, additionToken))
    const sourceId = state.activeSession.workout.exercises[0].id
    const replacementToken = reviewLibraryCopy(state, entryId)
    state = applySessionReplacement(state, reviewSessionReplacement(state, sourceId, replacementToken.exercise, replacementToken))
    const captured = structuredClone({ workouts: state.workouts, planHistory: state.planHistory, active: state.activeSession })
    state = applyLibraryChange(state, reviewLibraryEdit(state, entryId, { ...content, name: 'Private library-only revised label', notes: 'Private unselected note' }), { now: time + 2_000 })
    state = applyLibraryChange(state, reviewLibraryArchive(state, entryId, true), { now: time + 3_000 })
    expect(state.exerciseLibrary.entries[0]).toMatchObject({ revision: 2, status: 'archived' })
    expect(state.workouts).toEqual(captured.workouts); expect(state.planHistory).toEqual(captured.planHistory); expect(state.activeSession).toEqual(captured.active)
    const own = pausedCloudState(state, time + 4_000)
    expect(parseBackup(JSON.stringify(own))).toEqual(own)
    await athlete.upload(own, 0, true)
    const saved = await athlete.inspectSync()
    expect(saved.state).toEqual(own); expect((await athlete.exportAccount(PASSWORD)).sync.state).toEqual(own)
    const a = new CoachingClient(athlete), c = new CoachingClient(coach)
    await a.invite(coach.session.user.email, true); await c.accept((await c.overview()).invitations[0], true)
    await a.consent((await a.overview()).relationships[0], ['training'], true)
    const relationship = (await c.overview()).relationships[0]
    const projection = await c.snapshot(relationship)
    expect(JSON.stringify(projection)).not.toMatch(/exerciseLibrary|libraryOrigin|Private library-only revised label|Private unselected note/)
    expect(JSON.stringify(projection)).toContain('Copied training note')
    let restored = parseBackup(JSON.stringify(saved.state))
    const row = restored.activeSession.sets.find(row => row.exerciseId === first.id)
    row.reps = 8; row.weightKg = 12.123456789; row.completed = true
    const log = finishSession(restored.activeSession, time + 60_000)
    expect(log.exerciseSnapshots.filter(exercise => exercise.libraryOrigin).every(exercise => exercise.libraryOrigin.revision === 1)).toBe(true)
    restored = { ...restored, activeSession: null, logs: [log, ...restored.logs] }
    await athlete.upload(restored, saved.revision, true)
    expect((await athlete.inspectSync()).state).toEqual(restored)
    expect(JSON.stringify(await c.snapshot(relationship))).not.toContain('libraryOrigin')
    expect((await coach.exportAccount(PASSWORD)).sync.state).toBeNull()
    await athlete.setConsent(false)
    await expect(c.snapshot(relationship)).rejects.toMatchObject({ code: 'sharing_unavailable' })
    expect((await athlete.exportAccount(PASSWORD)).sync.state).toBeNull()
  })
})
