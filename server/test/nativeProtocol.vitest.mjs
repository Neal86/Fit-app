import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudClient, HEALTH_SYNC_POLICY, pausedCloudState } from '../../src/cloud'
import { CoachingClient } from '../../src/coaching'
import { CHALLENGE_METRIC, CHALLENGE_POLICY, PrivateChallengeClient } from '../../src/privateChallenges'
import { freshState, parseBackup } from '../../src/storage'
import { startSession } from '../../src/session'
import { applySessionGrouping, reviewSessionGrouping } from '../../src/sessionGrouping'
import { readNativeAccountReply, readNativeAccountRequest, readNativeAccountSession } from '../../src/nativeAccountContract'
import { setup, ORIGIN, PASSWORD } from './fixtures.mjs'

// This fixture models the future native peer only. It is neither a production bridge
// nor evidence of Android/iOS cookie, memory, redirect, TLS or process isolation.
const fixtures = []
afterEach(() => fixtures.splice(0).forEach(fixture => fixture.close()))
function service(config = {}) {
  const fixture = setup({ config: { nativeAccountsEnabled: true, ...config } })
  fixture.advance(Date.now() - fixture.now())
  fixtures.push(fixture)
  return fixture
}
class SyntheticNativePeer {
  contextId = randomUUID()
  credential = null
  session = null
  constructor(fixture) { this.fixture = fixture }
  async exchange(method, path, body) {
    const request = readNativeAccountRequest({ version: 1, contextId: this.contextId, requestId: randomUUID(), method, path, ...(body === undefined ? {} : { body }) })
    const result = await this.fixture.app.handle({
      method, path: `/api/native/v1/${path}`, body: body === undefined ? '' : JSON.stringify(body), ip: '127.0.0.1',
      headers: { 'x-fitflow-client': 'native-v1', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...(this.credential ? { authorization: `Bearer ${this.credential}`, 'x-csrf-token': this.session.csrfToken } : {}) },
    })
    expect(result.headers).not.toHaveProperty('set-cookie')
    expect(result.headers).not.toHaveProperty('access-control-allow-origin')
    expect(result.headers).not.toHaveProperty('access-control-allow-credentials')
    return { request, result }
  }
  async login(email) {
    this.credential = null; this.session = null
    const { request, result } = await this.exchange('POST', 'auth/login', { email, password: PASSWORD })
    expect(result.status).toBe(200)
    expect(Object.keys(result.body).sort()).toEqual(['nativeToken', 'session'])
    const envelope = { version: 1, contextId: request.contextId, requestId: request.requestId, status: 200, body: result.body }
    expect(() => readNativeAccountReply(envelope, request, this.fixture.now())).toThrow()
    // The native-side projection is explicit; the JS contract must not strip a raw
    // credential envelope and accidentally make it a supported JS response shape.
    this.session = readNativeAccountSession(result.body.session, this.fixture.now())
    this.credential = result.body.nativeToken
    expect(this.credential).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const reply = readNativeAccountReply({ ...envelope, body: this.session }, request, this.fixture.now())
    expect(JSON.stringify(reply)).not.toContain(this.credential)
    return reply.body
  }
  async ok(method, path, body, status = 200) {
    const { request, result } = await this.exchange(method, path, body)
    expect(result.status).toBe(status)
    const reply = readNativeAccountReply({ version: 1, contextId: request.contextId, requestId: request.requestId, status,
      ...(result.body === undefined ? {} : { body: result.body }) }, request, this.fixture.now())
    if (this.credential) expect(JSON.stringify(reply)).not.toContain(this.credential)
    return reply.body
  }
}
function browser(fixture, initialCookie) {
  let cookie = initialCookie
  return new CloudClient(`${ORIGIN}/api/v1`, async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const result = await fixture.app.handle({ method: init.method, path: new URL(url).pathname,
      headers: { ...headers, origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: init.body ?? '', ip: '127.0.0.1' })
    if (result.headers['set-cookie']) cookie = result.headers['set-cookie'].split(';')[0]
    return new Response(result.status === 204 ? null : JSON.stringify(result.body), { status: result.status, headers: result.headers })
  })
}

describe('native protocol and unwired JS contract with synthetic native peers', () => {
  it('registers and verifies without cookies, then manually round-trips grouped data and deletes both session channels', async () => {
    const f = service(), peer = new SyntheticNativePeer(f), email = 'native-protocol@example.test'
    expect(await peer.ok('POST', 'auth/register', { email, password: PASSWORD }, 202)).toEqual({ status: 'verification_required' })
    expect(f.messages).toHaveLength(1)
    expect(await peer.ok('POST', 'auth/verification/confirm', { token: f.messages[0].token })).toEqual({ status: 'verified' })
    const session = await peer.login(email)
    const web = browser(f); await web.login(email, PASSWORD)
    expect(await peer.ok('GET', 'consent')).toMatchObject({ healthSync: false })
    expect((await peer.exchange('GET', 'sync')).result.status).toBe(403)
    await peer.ok('PUT', 'consent', { healthSync: true, policyVersion: HEALTH_SYNC_POLICY })
    expect(await peer.ok('GET', 'sync')).toMatchObject({ state: null, revision: 0 })

    let state = freshState()
    state.workouts[0].exercises[0].equipment = ['dumbbells']
    state.activeSession = startSession(state.workouts[0], f.now())
    const movements = state.activeSession.workout.exercises.slice(0, 2)
    const rounds = [0, 1].map(index => movements.map(exercise => state.activeSession.sets.filter(row => row.exerciseId === exercise.id)[index].id))
    state = applySessionGrouping(state, reviewSessionGrouping(state, { name: 'Synthetic native group', restSeconds: 45, rounds }))
    state.activeSession.restUntil = f.now() + 60_000
    const paused = pausedCloudState(state, f.now() + 15_000)
    const upload = { state: paused, baseRevision: 0, operationId: randomUUID() }
    expect(await peer.ok('PUT', 'sync', upload)).toMatchObject({ revision: 1, replayed: false })
    expect(await peer.ok('PUT', 'sync', upload)).toMatchObject({ revision: 1, replayed: true })
    const saved = await peer.ok('GET', 'sync')
    expect(saved.state).toEqual(paused)
    expect(parseBackup(JSON.stringify(saved.state))).toEqual(paused)
    expect(saved.state.activeSession.grouping).toEqual(state.activeSession.grouping)
    expect(saved.state.activeSession.restUntil).toBeNull()
    expect(saved.state.activeSession.runningSince).toBeNull()
    expect((await web.inspectSync()).state).toEqual(paused)
    expect((await peer.ok('POST', 'account/export', { password: PASSWORD })).sync.state).toEqual(paused)
    await peer.ok('DELETE', 'account', { password: PASSWORD, confirmation: 'DELETE' }, 204)
    await expect(web.getConsent()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM native_sessions WHERE user_id = ?').get(session.user.id).count).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(session.user.id).count).toBe(0)
  })

  it('shares the same consent, revision conflict and revocation tombstone across web and native channels', async () => {
    const f = service(), seeded = f.seed('shared-native@example.test'), peer = new SyntheticNativePeer(f)
    await peer.login(seeded.email)
    const web = browser(f, seeded.cookie); await web.checkSession()
    await web.setConsent(true); await web.inspectSync()
    expect(await peer.ok('GET', 'sync')).toMatchObject({ revision: 0 })
    const first = { state: freshState(), baseRevision: 0, operationId: randomUUID() }
    await peer.ok('PUT', 'sync', first)
    await expect(web.upload(freshState(), 0, true)).rejects.toMatchObject({ code: 'sync_conflict', revision: 1 })
    await web.setConsent(false)
    expect((await peer.exchange('GET', 'sync')).result.status).toBe(403)
    expect((await peer.exchange('PUT', 'sync', first)).result.status).toBe(403)
    await peer.ok('PUT', 'consent', { healthSync: true, policyVersion: HEALTH_SYNC_POLICY })
    expect(await peer.ok('GET', 'sync')).toMatchObject({ revision: 2, state: null })
    expect((await peer.exchange('PUT', 'sync', first)).result).toMatchObject({ status: 409, body: { error: { code: 'sync_conflict' } } })
    expect((await web.inspectSync()).state).toBeNull()
  })

  it('keeps credentials channel-bound and rejects stale bridge correlation without exposing the raw native envelope', async () => {
    const f = service(), seeded = f.seed('isolated-native@example.test'), peer = new SyntheticNativePeer(f)
    await peer.login(seeded.email)
    const webWithNativeToken = browser(f, `${f.app.cookieName}=${peer.credential}`)
    await expect(webWithNativeToken.checkSession()).rejects.toMatchObject({ code: 'unauthorized' })
    const nativeWithWebToken = new SyntheticNativePeer(f)
    nativeWithWebToken.credential = seeded.raw
    nativeWithWebToken.session = { csrfToken: seeded.csrf }
    expect((await nativeWithWebToken.exchange('GET', 'consent')).result.status).toBe(401)
    const { request, result } = await peer.exchange('GET', 'consent')
    const reply = { version: 1, contextId: request.contextId, requestId: request.requestId, status: 200, body: result.body }
    expect(() => readNativeAccountReply({ ...reply, contextId: randomUUID() }, request, f.now())).toThrow()
    expect(() => readNativeAccountReply({ ...reply, requestId: randomUUID() }, request, f.now())).toThrow()
    expect(() => readNativeAccountReply({ ...reply, headers: { Authorization: `Bearer ${peer.credential}` } }, request, f.now())).toThrow()
  })

  it('preserves scoped coaching and bilateral count-only consent across native and web, with no grant resurrection', async () => {
    const f = service({ coachingEnabled: true, challengesEnabled: true })
    const athlete = f.seed('web-athlete-native-peer@example.test'), colleague = f.seed('native-colleague@example.test')
    const web = browser(f, athlete.cookie); await web.checkSession()
    const peer = new SyntheticNativePeer(f); await peer.login(colleague.email)
    await web.setConsent(true); await web.inspectSync()
    const state = freshState(); state.profile.name = 'Synthetic private athlete marker'
    await web.upload(state, 0, true)
    const coaching = new CoachingClient(web)
    await coaching.invite(colleague.email, true)
    const invitation = (await peer.ok('GET', 'coaching')).invitations[0]
    const accepted = (await peer.ok('POST', `coaching/invitations/${invitation.id}/accept`, {})).relationship
    expect(accepted.scopes).toEqual([])
    expect((await peer.exchange('GET', `coaching/relationships/${accepted.id}/snapshot`)).result.status).toBe(403)
    const relationship = await coaching.consent((await coaching.overview()).relationships[0], ['body'], true)
    const projected = await peer.ok('GET', `coaching/relationships/${relationship.id}/snapshot`)
    expect(Object.keys(projected.categories)).toEqual(['body'])
    expect(JSON.stringify(projected)).not.toContain(state.profile.name)
    expect(JSON.stringify(projected)).not.toContain('nutrition')

    await peer.ok('PUT', 'consent', { healthSync: true, policyVersion: HEALTH_SYNC_POLICY })
    const day = new Date(f.now()).toISOString().slice(0, 10)
    await peer.ok('POST', 'challenges/invitations', { email: athlete.email, startDate: day, endDate: day }, 202)
    const challenges = new PrivateChallengeClient(web)
    const theirs = await challenges.accept((await challenges.overview()).invitations[0], true)
    let mine = (await peer.ok('GET', 'challenges')).challenges[0]
    expect(mine).toMatchObject({ ownConsent: false, peerConsent: false })
    expect((await peer.exchange('GET', `challenges/${mine.id}/counts`)).result.status).toBe(403)
    mine = (await peer.ok('PUT', `challenges/${mine.id}/consent`, {
      baseVersion: mine.version, policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC,
      startDate: mine.startDate, endDate: mine.endDate, shareTrainingDays: true, recipient: mine.counterpart,
    })).challenge
    expect((await peer.exchange('GET', `challenges/${mine.id}/counts`)).result.status).toBe(403)
    await challenges.consent((await challenges.overview()).challenges[0], true)
    const counts = await peer.ok('GET', `challenges/${mine.id}/counts`)
    expect(counts).toMatchObject({ selfReported: true, ownRecordedDays: null, peerRecordedDays: 0 })
    expect(Object.keys(counts).sort()).toEqual(['challengeId', 'challengeVersion', 'metric', 'ownRecordedDays', 'peerRecordedDays', 'selfReported'])
    expect(theirs.id).toBe(mine.id)

    await web.setConsent(false)
    expect((await peer.exchange('GET', `coaching/relationships/${relationship.id}/snapshot`)).result.status).toBe(403)
    expect((await peer.exchange('GET', `challenges/${mine.id}/counts`)).result.status).toBe(403)
    await web.setConsent(true)
    expect((await peer.ok('GET', 'challenges')).challenges[0]).toMatchObject({ ownConsent: false, peerConsent: false })
    expect((await peer.ok('GET', 'coaching')).relationships[0].scopes).toEqual([])
    expect((await peer.exchange('GET', `coaching/relationships/${relationship.id}/snapshot`)).result.status).toBe(403)
    expect((await peer.exchange('GET', `challenges/${mine.id}/counts`)).result.status).toBe(403)
    const ownExport = await peer.ok('POST', 'account/export', { password: PASSWORD })
    expect(ownExport.sync.state).toBeNull()
    expect(JSON.stringify(ownExport)).not.toContain(state.profile.name)
    await web.deleteAccount(PASSWORD, 'DELETE')
    expect((await peer.ok('GET', 'coaching')).relationships).toEqual([])
    expect((await peer.ok('GET', 'challenges')).challenges).toEqual([])
  })
})
