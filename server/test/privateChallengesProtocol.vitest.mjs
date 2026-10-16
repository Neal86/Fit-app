import { afterEach, describe, expect, it } from 'vitest'
import { CloudClient } from '../../src/cloud'
import { PrivateChallengeClient } from '../../src/privateChallenges'
import { freshState } from '../../src/storage'
import { finishSession, startSession } from '../../src/session'
import { applySessionAddition, reviewSessionAddition } from '../../src/sessionAddition'
import { createApp } from '../app.mjs'
import { openDatabase } from '../database.mjs'

const ORIGIN = 'https://fitness.example.test'
const PASSWORD = 'Synthetic challenge password 123!'
const databases = []
afterEach(() => { databases.splice(0).forEach(db => db.close()) })

function service(enabled = true) {
  const db = openDatabase(); databases.push(db)
  const messages = [], now = Date.now()
  const app = createApp({ db, now: () => now, config: { origin: ORIGIN, secureCookies: true, challengesEnabled: enabled }, mail: { enabled: true, async send(message) { messages.push(message) } } })
  const requests = []
  async function account(email) {
    const jar = { cookie: '' }
    const fetcher = async (url, init) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      headers.origin = ORIGIN; headers.cookie = jar.cookie
      const path = new URL(url).pathname
      requests.push({ path, method: init.method })
      const result = await app.handle({ method: init.method, path, headers, body: init.body ?? '', ip: '127.0.0.1' })
      if (result.headers?.['set-cookie']) jar.cookie = result.headers['set-cookie'].split(';')[0]
      return new Response(result.status === 204 ? null : JSON.stringify(result.body), { status: result.status, headers: result.headers })
    }
    const cloud = new CloudClient(`${ORIGIN}/api/v1`, fetcher)
    await cloud.register(email, PASSWORD)
    await cloud.confirmVerification(messages.findLast(message => message.to === email && message.kind === 'verify').token)
    await cloud.login(email, PASSWORD)
    return { cloud, challenges: new PrivateChallengeClient(cloud), jar }
  }
  return { db, now, requests, account }
}
const day = time => new Date(time).toISOString().slice(0, 10)
function recordedLog(state, time, options = {}) {
  const session = startSession(state.workouts[0], time - 60_000)
  session.sets[0] = { ...session.sets[0], completed: true, reps: 8, ...options }
  return finishSession(session, time)
}

describe('private challenge real client/server protocol, synthetic records only', () => {
  it('requires two exact grants and projects only counted days from manual cloud copies', async () => {
    const f = service(), a = await f.account('challenge-a@example.test'), b = await f.account('challenge-b@example.test'), outsider = await f.account('challenge-outsider@example.test')
    const window = { startDate: day(f.now - 6 * 86_400_000), endDate: day(f.now) }
    const state = freshState(); state.profile.name = 'Synthetic private marker'; state.workouts[0].description = 'Not challenge content'
    const previousDay = Date.parse(`${day(f.now - 86_400_000)}T12:00:00Z`)
    const twoDaysAgo = previousDay - 86_400_000
    const legacy = recordedLog(state, previousDay - 2 * 86_400_000); delete legacy.sets
    state.logs = [
      recordedLog(state, previousDay), recordedLog(state, previousDay + 30_000),
      recordedLog(state, twoDaysAgo, { reps: null, seconds: 30 }),
      recordedLog(state, previousDay - 3 * 86_400_000, { warmup: true }),
      recordedLog(state, previousDay - 4 * 86_400_000, { reps: null, seconds: null }),
      recordedLog(state, f.now + 60_000), legacy,
    ]
    state.nutrition.hydration = [{ id: 'private-water', date: day(f.now), milliliters: 333, note: 'Not challenge content' }]
    await a.cloud.setConsent(true); await a.cloud.inspectSync(); await a.cloud.upload(state, 0, true)
    await b.cloud.setConsent(true)
    await expect(a.challenges.invite(b.cloud.session.user.email, window, false)).rejects.toMatchObject({ code: 'confirmation_required' })
    expect((await b.challenges.overview()).invitations).toEqual([])
    await a.challenges.invite(b.cloud.session.user.email, window, true)
    let theirs = await b.challenges.accept((await b.challenges.overview()).invitations[0], true)
    let mine = (await a.challenges.overview()).challenges[0]
    expect(mine).toMatchObject({ ...window, ownConsent: false, peerConsent: false, counterpart: { id: b.cloud.session.user.id, email: b.cloud.session.user.email } })
    await expect(a.challenges.counts(mine)).rejects.toBeDefined()
    mine = await a.challenges.consent(mine, true)
    await expect(a.challenges.counts(mine)).rejects.toBeDefined()
    theirs = (await b.challenges.overview()).challenges[0]
    theirs = await b.challenges.consent(theirs, true)
    mine = (await a.challenges.overview()).challenges[0]
    const counts = await a.challenges.counts(mine)
    expect(counts).toEqual({ challengeId: mine.id, challengeVersion: mine.version, metric: 'recorded_training_days', selfReported: true, ownRecordedDays: 2, peerRecordedDays: null })
    await expect(outsider.challenges.counts(mine)).rejects.toMatchObject({ code: 'not_found', status: 404 })
    expect((await outsider.challenges.overview()).challenges).toEqual([])
    expect(Object.keys(await b.challenges.counts(theirs)).sort()).toEqual(Object.keys(counts).sort())
    expect((await b.challenges.counts(theirs)).peerRecordedDays).toBe(2)
    const exported = await b.cloud.exportAccount(PASSWORD)
    expect(exported.challenges.challenges).toHaveLength(1)
    expect(exported.sync.state).toBeNull()
    expect(JSON.stringify(exported)).not.toContain(state.profile.name)
    const ownMetadata = exported.challenges.challenges[0]
    for (const key of ['counterpart', 'peerConsent', 'ownRecordedDays', 'peerRecordedDays', 'state', 'revision']) expect(ownMetadata).not.toHaveProperty(key)

    await b.cloud.setConsent(false)
    await expect(a.challenges.counts(mine)).rejects.toBeDefined()
    mine = (await a.challenges.overview()).challenges[0]
    expect(mine).toMatchObject({ status: 'active', ownConsent: false, peerConsent: false })
    await b.cloud.setConsent(true)
    expect((await b.challenges.overview()).challenges[0]).toMatchObject({ ownConsent: false, peerConsent: false })
    mine = await a.challenges.consent(mine, true)
    theirs = await b.challenges.consent((await b.challenges.overview()).challenges[0], true)
    mine = (await a.challenges.overview()).challenges[0]
    expect((await a.challenges.counts(mine)).ownRecordedDays).toBe(2)
    await b.cloud.inspectSync(); await b.cloud.upload(freshState(), 1, true)
    expect((await a.challenges.counts(mine)).peerRecordedDays).toBe(0)
    const corrected = { ...state, logs: [state.logs[0]] }
    await a.cloud.inspectSync(); await a.cloud.upload(corrected, 1, true)
    expect((await b.challenges.counts(theirs)).peerRecordedDays).toBe(1)
    expect(state.logs).toHaveLength(7)

    const beforeSwitch = { ...mine }, originalCookie = a.jar.cookie
    a.jar.cookie = b.jar.cookie
    await expect(a.challenges.counts(beforeSwitch)).rejects.toMatchObject({ code: 'account_changed' })
    expect(a.cloud.session).toBeNull()
    a.jar.cookie = originalCookie
    await a.cloud.checkSession()
    mine = (await a.challenges.overview()).challenges[0]
    await a.challenges.block(mine, true)
    expect((await b.challenges.overview()).challenges[0].status).toBe('revoked')
    await expect(b.challenges.counts(theirs)).rejects.toBeDefined()
    await b.challenges.invite(a.cloud.session.user.email, window, true)
    expect((await a.challenges.overview()).invitations).toEqual([])
    await a.cloud.deleteAccount(PASSWORD, 'DELETE')
    expect((await b.challenges.overview()).challenges).toEqual([])
  })

  it('keeps server default-off and an unconfigured client entirely local', async () => {
    const f = service(false), a = await f.account('challenge-off@example.test')
    await expect(a.challenges.overview()).rejects.toMatchObject({ code: 'challenges_disabled', status: 503 })
    let calls = 0
    const client = new PrivateChallengeClient(new CloudClient('', async () => { calls++; throw new Error('Unexpected request') }))
    await expect(client.overview()).rejects.toBeDefined()
    expect(calls).toBe(0)
  })

  it('does not count added movements or an unfinished session as extra completed-work days', async () => {
    const f = service(), a = await f.account('addition-count-a@example.test'), b = await f.account('addition-count-b@example.test')
    const window = { startDate: day(f.now - 6 * 86_400_000), endDate: day(f.now) }
    const time = Date.parse(`${day(f.now - 86_400_000)}T12:00:00Z`)
    const state = freshState()
    state.logs = [recordedLog(state, time)]
    state.activeSession = startSession(state.workouts[0], time + 60_000)
    state.activeSession.runningSince = null
    const movement = { id: 'count-only-draft', name: 'Synthetic addition count marker', category: 'Synthetic', sets: 2, reps: '8', restSeconds: 30, equipment: [] }
    const added = applySessionAddition(state, reviewSessionAddition(state, movement))
    await a.cloud.setConsent(true); await a.cloud.inspectSync(); await a.cloud.upload(added, 0, true)
    await b.cloud.setConsent(true)
    await a.challenges.invite(b.cloud.session.user.email, window, true)
    await b.challenges.accept((await b.challenges.overview()).invitations[0], true)
    await a.challenges.consent((await a.challenges.overview()).challenges[0], true)
    await b.challenges.consent((await b.challenges.overview()).challenges[0], true)
    const mine = (await a.challenges.overview()).challenges[0]
    const before = await a.challenges.counts(mine)
    expect(before).toEqual({ challengeId: mine.id, challengeVersion: mine.version, metric: 'recorded_training_days', selfReported: true, ownRecordedDays: 1, peerRecordedDays: null })
    const saved = await a.cloud.inspectSync()
    const restored = saved.state
    for (const row of restored.activeSession.sets.slice(-2)) { row.reps = 8; row.completed = true }
    const log = finishSession(restored.activeSession, time + 180_000)
    restored.logs = [log, ...restored.logs]; restored.activeSession = null
    await a.cloud.upload(restored, saved.revision, true)
    expect((await a.cloud.inspectSync()).state.logs).toHaveLength(2)
    expect(await a.challenges.counts(mine)).toEqual(before)
    const theirs = (await b.challenges.overview()).challenges[0]
    const peer = await b.challenges.counts(theirs)
    expect(peer.peerRecordedDays).toBe(1)
    expect(JSON.stringify(peer)).not.toContain(movement.name)
    expect(Object.keys(peer).sort()).toEqual(Object.keys(before).sort())
  })
})
