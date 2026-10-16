import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CHALLENGE_LIMITS, CHALLENGE_METRIC, CHALLENGE_POLICY_VERSION, recordedTrainingDays } from '../challenges.mjs'
import { createApp } from '../app.mjs'
import { configFromEnv, POLICY_VERSION } from '../config.mjs'
import { openDatabase } from '../database.mjs'
import { fixtureState, ORIGIN, PASSWORD, setup, syncBody } from './fixtures.mjs'

const window = { startDate: '2026-10-01', endDate: '2026-10-31' }
const endpoint = id => `/challenges/${id}`
const inviteEndpoint = id => `/challenges/invitations/${id}`
function fixture(t, options = {}) { const f = setup({ config: { challengesEnabled: true }, ...options }); t.after(f.close); return f }
async function overview(f, actor) { const response = await f.request('GET', '/challenges', undefined, actor); assert.equal(response.status, 200); return response.body }
async function invite(f, a, b, dates = window) {
  const response = await f.request('POST', '/challenges/invitations', { email: b.email, ...dates }, a)
  assert.deepEqual([response.status, response.body], [202, { status: 'accepted' }])
  const invitation = (await overview(f, b)).invitations.find(item => item.inviter.id === a.id)
  assert.ok(invitation)
  return invitation
}
async function connect(f, a, b, dates) {
  const invitation = await invite(f, a, b, dates)
  const result = await f.request('POST', `${inviteEndpoint(invitation.id)}/accept`, { baseVersion: invitation.version }, b)
  assert.equal(result.status, 200)
  return result.body.challenge
}
async function current(f, actor, id) { return (await overview(f, actor)).challenges.find(item => item.id === id) }
function grantBody(challenge) { return { baseVersion: challenge.version, policyVersion: CHALLENGE_POLICY_VERSION, metric: CHALLENGE_METRIC, startDate: challenge.startDate, endDate: challenge.endDate, shareTrainingDays: true, recipient: challenge.counterpart } }
async function grant(f, actor, id) {
  const challenge = await current(f, actor, id)
  const response = await f.request('PUT', `${endpoint(id)}/consent`, grantBody(challenge), actor)
  assert.equal(response.status, 200)
  return response.body.challenge
}
async function share(f) {
  const a = f.seed('synthetic-a@example.test', true), b = f.seed('synthetic-b@example.test', true)
  let challenge = await connect(f, a, b)
  await grant(f, a, challenge.id)
  challenge = await grant(f, b, challenge.id)
  return { a, b, challenge }
}
function log(overrides = {}) {
  return { id: randomUUID(), workoutId: 'workout-1', title: 'PRIVATE TRAINING NAME', startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:10:00Z', duration: 10, calories: 123,
    completedExerciseIds: ['exercise-1'], notes: 'PRIVATE NOTE', sets: [{ id: randomUUID(), exerciseId: 'exercise-1', setNumber: 1, reps: 10, seconds: null, weightKg: 42, rpe: 6, warmup: false, completed: true }], ...overrides }
}
const withLogs = logs => ({ ...fixtureState(), logs })
const save = (f, actor, logs, revision = 0) => f.request('PUT', '/sync', syncBody(withLogs(logs), revision), actor)
const counts = (f, actor, id) => f.request('GET', `${endpoint(id)}/counts`, undefined, actor)
function keepSessions(f) { f.db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ?').run(f.now(), f.now() + 86400000) }

// Core contract, security and projection coverage use synthetic seeded accounts; no mail.
test('feature requires exact true and every disabled route, including preflight, fails closed', async t => {
  assert.equal(configFromEnv({}).challengesEnabled, false)
  for (const value of ['TRUE', '1', 'false', '']) assert.equal(configFromEnv({ FITFLOW_CHALLENGES_ENABLED: value }).challengesEnabled, false)
  assert.equal(configFromEnv({ FITFLOW_CHALLENGES_ENABLED: 'true' }).challengesEnabled, true)
  const f = fixture(t, { config: { challengesEnabled: 'true' } }), actor = f.seed(), id = randomUUID()
  for (const [method, path, body] of [
    ['GET', '/challenges'], ['POST', '/challenges/invitations', { email: actor.email, ...window }],
    ['POST', `${inviteEndpoint(id)}/accept`, { baseVersion: 1 }], ['DELETE', inviteEndpoint(id), { baseVersion: 1 }],
    ['GET', `${endpoint(id)}/counts`], ['PUT', `${endpoint(id)}/consent`, {}], ['DELETE', endpoint(id), { baseVersion: 1 }],
    ['POST', `${endpoint(id)}/block`, { baseVersion: 1 }], ['OPTIONS', '/challenges'],
  ]) { const result = await f.request(method, path, body, actor); assert.equal(result.status, 503); assert.equal(result.body.error.code, 'challenges_disabled') }
})

test('invitations have no outgoing receipt/mail, acceptance is separate from each reviewed grant', async t => {
  const f = fixture(t), a = f.seed(undefined, true), b = f.seed()
  const invitation = await invite(f, a, b)
  assert.deepEqual(Object.keys(invitation).sort(), ['createdAt', 'endDate', 'expiresAt', 'id', 'inviter', 'startDate', 'version'])
  assert.equal(invitation.version, 1)
  assert.deepEqual((await overview(f, a)).invitations, [])
  assert.deepEqual((await overview(f, a)).challenges, [])
  assert.equal((await counts(f, a, invitation.id)).status, 404)
  const result = await f.request('POST', `${inviteEndpoint(invitation.id)}/accept`, { baseVersion: 1 }, b)
  const challenge = result.body.challenge
  assert.equal(result.status, 200); assert.equal(challenge.version, 2)
  assert.equal(challenge.ownConsent, false); assert.equal(challenge.peerConsent, false)
  assert.deepEqual(challenge.counterpart, { id: a.id, email: a.email })
  assert.equal((await counts(f, b, challenge.id)).status, 403)
  const aGrant = await grant(f, a, challenge.id)
  assert.equal(aGrant.version, 3); assert.equal(aGrant.ownConsent, true)
  assert.equal((await counts(f, a, challenge.id)).status, 403)
  assert.equal((await f.request('PUT', `${endpoint(challenge.id)}/consent`, grantBody(await current(f, b, challenge.id)), b)).status, 403)
  assert.equal((await f.request('PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION }, b)).status, 200)
  await grant(f, b, challenge.id)
  const score = await counts(f, a, challenge.id)
  assert.deepEqual(score.body, { challengeId: challenge.id, challengeVersion: 4, metric: CHALLENGE_METRIC, selfReported: true, ownRecordedDays: null, peerRecordedDays: null })
  assert.deepEqual(f.messages, [])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users WHERE state_json IS NOT NULL').get().n, 0)
})

test('only completed positive non-warmup sets count once per UTC date; no legacy/timer/future loopholes', () => {
  const positive = log()
  const sets = props => [{ ...positive.sets[0], ...props }]
  const legacy = log(); delete legacy.sets
  const logs = [positive, log(), legacy, log({ sets: [] }),
    log({ sets: sets({ completed: false }) }), log({ sets: sets({ warmup: true }) }), log({ sets: sets({ reps: 0, seconds: 0 }) }),
    log({ startedAt: '2026-10-15T12:00:00Z', completedAt: '2026-10-15T12:01:00Z' }),
    log({ startedAt: '2026-09-30T10:00:00Z', completedAt: '2026-09-30T10:10:00Z' }),
    log({ startedAt: '2026-10-02T10:00:00', completedAt: '2026-10-02T10:10:00' }),
    log({ startedAt: '2026-10-03T00:00:00+14:00', completedAt: '2026-10-03T00:10:00+14:00', sets: sets({ reps: null, seconds: 30 }) }), // UTC Oct 2
    log({ startedAt: '2026-10-04T23:00:00-12:00', completedAt: '2026-10-04T23:10:00-12:00' }), // UTC Oct 5
    log({ startedAt: '2026-10-05T10:00:00Z', completedAt: '2026-10-05T10:10:00Z' }), // duplicate UTC Oct 5
  ]
  assert.equal(recordedTrainingDays(withLogs(logs), window.startDate, window.endDate, Date.parse('2026-10-15T12:00:00Z')), 3)
  for (const item of [legacy, ...logs.slice(3, 10)]) assert.equal(recordedTrainingDays(withLogs([item]), window.startDate, window.endDate, Date.parse('2026-10-15T12:00:00Z')), 0)
  assert.equal(recordedTrainingDays(withLogs([positive]), '2026-10-14', '2026-10-14', Date.parse('2026-10-15T12:00:00Z')), 1)
})

test('counts read latest manually saved snapshots only and strict projection never leaks health fields/dates/revisions', async t => {
  const f = fixture(t), { a, b, challenge } = await share(f)
  assert.equal((await save(f, a, [log(), log()])).status, 200)
  assert.equal((await save(f, b, [])).status, 200)
  const result = await counts(f, a, challenge.id)
  assert.equal(result.status, 200)
  assert.deepEqual(Object.keys(result.body).sort(), ['challengeId', 'challengeVersion', 'metric', 'ownRecordedDays', 'peerRecordedDays', 'selfReported'])
  assert.equal(result.body.ownRecordedDays, 1); assert.equal(result.body.peerRecordedDays, 0)
  for (const secret of ['PRIVATE', '2026-10-14', 'calories', 'weightKg', 'revision', 'updatedAt', 'sets', 'profile', 'nutrition', a.email, b.email]) assert.ok(!JSON.stringify(result.body).includes(secret), secret)
  const unsaved = withLogs([]); assert.equal(unsaved.logs.length, 0)
  assert.equal((await counts(f, b, challenge.id)).body.peerRecordedDays, 1)
  assert.equal((await save(f, a, [], 1)).status, 200)
  assert.equal((await counts(f, b, challenge.id)).body.peerRecordedDays, 0)
})

test('session/CSRF/origin rules apply to counts and overview; all owned endpoint selectors isolate outsiders', async t => {
  const f = fixture(t), { a, b, challenge } = await share(f), outsider = f.seed(undefined, true)
  assert.equal((await f.request('GET', '/challenges')).status, 401)
  for (const path of ['/challenges', `${endpoint(challenge.id)}/counts`]) {
    for (const headers of [{ 'x-csrf-token': '' }, { origin: 'https://evil.example.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await f.request('GET', path, undefined, a, { headers })).status, 403)
    const valid = await f.request('GET', path, undefined, a, { headers: { origin: undefined } })
    assert.equal(valid.status, 200); assert.equal(valid.headers['cache-control'], 'no-store')
  }
  assert.equal((await f.request('DELETE', endpoint(challenge.id), { baseVersion: challenge.version }, a, { headers: { origin: undefined } })).status, 403)
  for (const [method, path, body] of [['GET', `${endpoint(challenge.id)}/counts`], ['PUT', `${endpoint(challenge.id)}/consent`, grantBody(challenge)], ['DELETE', endpoint(challenge.id), { baseVersion: challenge.version }], ['POST', `${endpoint(challenge.id)}/block`, { baseVersion: challenge.version }]]) assert.equal((await f.request(method, path, body, outsider)).status, 404)
  assert.equal((await f.request('POST', `${inviteEndpoint(challenge.id)}/accept`, { baseVersion: challenge.version }, a)).status, 404)
  f.db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(b.id)
  assert.equal((await counts(f, a, challenge.id)).body.error.code, 'sharing_unavailable')
  assert.equal((await counts(f, b, challenge.id)).body.error.code, 'email_unverified')
})

test('strict grant binding rejects changed recipient/window/metric/policy and all extra/missing fields', async t => {
  const f = fixture(t), a = f.seed(undefined, true), b = f.seed(undefined, true), challenge = await connect(f, a, b)
  const body = grantBody(await current(f, a, challenge.id))
  for (const modified of [
    { ...body, recipient: { ...body.recipient, id: randomUUID() } }, { ...body, recipient: { ...body.recipient, email: a.email } },
    { ...body, startDate: '2026-10-02' }, { ...body, endDate: '2026-10-30' }, { ...body, metric: 'calories' },
    { ...body, policyVersion: 'old' }, { ...body, shareTrainingDays: false }, { ...body, recipient: { ...body.recipient, name: 'extra' } },
    { ...body, ownerId: a.id }, { ...body, baseVersion: 0 }, { ...body, baseVersion: 1.5 }, { ...body, baseVersion: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal((await f.request('PUT', `${endpoint(challenge.id)}/consent`, modified, a)).status, 400)
  for (const key of Object.keys(body)) { const missing = { ...body }; delete missing[key]; assert.equal((await f.request('PUT', `${endpoint(challenge.id)}/consent`, missing, a)).status, 400) }
  assert.equal((await counts(f, a, challenge.id)).status, 403)
  assert.equal((await current(f, a, challenge.id)).version, challenge.version)
})

test('date windows reject rollover/invalid/ended/oversized inputs and exact bounds accept', async t => {
  const f = fixture(t), a = f.seed(), b = f.seed()
  for (const dates of [
    { startDate: '2026-02-30', endDate: '2026-10-31' }, { startDate: '2026-10-2', endDate: '2026-10-31' },
    { startDate: '2026-09-30', endDate: '2026-10-31' }, { startDate: '2026-10-31', endDate: '2026-10-01' },
    { startDate: '2026-10-01', endDate: '2026-10-14' }, { startDate: '9999-12-24', endDate: '9999-12-24' },
  ]) assert.equal((await f.request('POST', '/challenges/invitations', { email: b.email, ...dates }, a)).body.error.code, 'invalid_window')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM challenge_invitation_budgets').get().n, 0)
  const one = await invite(f, a, b, { startDate: '2026-10-15', endDate: '2026-10-15' })
  assert.equal(one.expiresAt, '2026-10-16T00:00:00.000Z')
  const c = f.seed()
  assert.ok(await invite(f, a, c, window))
})

test('grant replay/stale mutation fails; leave and consent-revoke are terminal without silently blocking', async t => {
  for (const action of ['', '/consent']) {
    const f = fixture(t), { a, b, challenge } = await share(f)
    const staleBody = grantBody(await current(f, a, challenge.id))
    const changed = await f.request('PUT', `${endpoint(challenge.id)}/consent`, staleBody, a)
    assert.equal(changed.status, 200)
    assert.equal((await f.request('PUT', `${endpoint(challenge.id)}/consent`, staleBody, a)).body.error.code, 'challenge_conflict')
    assert.equal((await f.request('DELETE', `${endpoint(challenge.id)}${action}`, { baseVersion: challenge.version }, b)).status, 409)
    const revoked = await f.request('DELETE', `${endpoint(challenge.id)}${action}`, { baseVersion: changed.body.challenge.version }, b)
    assert.equal(revoked.status, 200); assert.equal(revoked.body.challenge.status, 'revoked')
    assert.equal(revoked.body.challenge.ownConsent, false); assert.equal(revoked.body.challenge.peerConsent, false); assert.ok(revoked.body.challenge.revokedAt)
    assert.equal((await counts(f, a, challenge.id)).status, 403)
    assert.equal((await f.request('PUT', `${endpoint(challenge.id)}/consent`, grantBody(await current(f, a, challenge.id)), a)).body.error.code, 'sharing_unavailable')
    assert.deepEqual((await f.request('DELETE', endpoint(challenge.id), { baseVersion: revoked.body.challenge.version }, b)).body, revoked.body)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM challenge_blocks').get().n, 0)
    const replacement = await connect(f, a, b)
    assert.notEqual(replacement.id, challenge.id); assert.equal(replacement.ownConsent, false); assert.equal(replacement.peerConsent, false)
  }
})

test('cloud revoke atomically clears BOTH grants while active, and stale replay/reenable/upload cannot restore either', async t => {
  const f = fixture(t), { a, b, challenge } = await share(f)
  await save(f, a, [log()])
  const stale = grantBody(await current(f, b, challenge.id))
  assert.equal((await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, a)).status, 200)
  let changed = await current(f, b, challenge.id)
  assert.equal(changed.status, 'active'); assert.equal(changed.version, challenge.version + 1)
  assert.equal(changed.ownConsent, false); assert.equal(changed.peerConsent, false)
  assert.equal((await counts(f, b, challenge.id)).status, 403)
  assert.equal((await f.request('PUT', `${endpoint(challenge.id)}/consent`, stale, b)).status, 409)
  await f.request('PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION }, a)
  assert.equal((await save(f, a, [log()], 2)).status, 200)
  await grant(f, b, challenge.id)
  assert.equal((await counts(f, b, challenge.id)).status, 403)
  changed = await grant(f, a, challenge.id)
  assert.equal((await counts(f, b, challenge.id)).status, 200)
  for (let i = 0; i < 2; i++) await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, b)
  assert.equal((await current(f, a, challenge.id)).version, changed.version + 2)
})

test('explicit known-counterpart block prevents both directions, stale acceptance, grants and counts without a block oracle', async t => {
  const f = fixture(t), a = f.seed(undefined, true), b = f.seed(undefined, true), c = f.seed(undefined, true)
  const invitation = await invite(f, a, b)
  assert.equal((await f.request('POST', `${endpoint(invitation.id)}/block`, { baseVersion: 1 }, b)).status, 204)
  assert.equal((await f.request('POST', `${inviteEndpoint(invitation.id)}/accept`, { baseVersion: 1 }, b)).status, 409)
  assert.equal((await f.request('POST', `${inviteEndpoint(invitation.id)}/accept`, { baseVersion: 2 }, b)).status, 404)
  assert.equal((await f.request('POST', `${endpoint(invitation.id)}/block`, { baseVersion: 2 }, b)).status, 204)
  assert.equal((await f.request('POST', `${endpoint(invitation.id)}/block`, { baseVersion: 2 }, a)).status, 404)
  for (const [sender, recipient] of [[a, b], [b, a]]) assert.deepEqual((await f.request('POST', '/challenges/invitations', { email: recipient.email, ...window }, sender)).body, { status: 'accepted' })
  assert.deepEqual((await overview(f, a)).invitations, []); assert.deepEqual((await overview(f, b)).invitations, [])
  assert.equal((await f.request('POST', `${endpoint(randomUUID())}/block`, { baseVersion: 1 }, b)).status, 404)
  assert.equal((await f.request('POST', '/challenges/blocks', { email: c.email }, b)).status, 404)
  const other = await connect(f, b, c)
  await grant(f, b, other.id); await grant(f, c, other.id)
  const version = (await current(f, b, other.id)).version
  assert.equal((await f.request('POST', `${endpoint(other.id)}/block`, { baseVersion: version }, b)).status, 204)
  assert.equal((await counts(f, c, other.id)).status, 403)
  assert.equal((await current(f, c, other.id)).status, 'revoked')
  assert.ok(!Object.hasOwn(await current(f, c, other.id), 'blocked'))
})

test('admitted invitation budgets match missing/self/unverified/blocked/duplicate/full eligibility at sender boundary', async t => {
  const outcomes = []
  for (const scenario of ['eligible', 'missing', 'self', 'unverified', 'blocked', 'duplicate', 'recipient-full', 'inbox-full']) {
    const f = fixture(t), a = f.seed(), target = f.seed(), control = f.seed()
    f.db.prepare('INSERT INTO challenge_invitation_budgets(user_id,attempts) VALUES(?,49)').run(a.id)
    f.db.prepare('UPDATE challenge_global_budget SET attempts = 49 WHERE id = 1').run()
    if (scenario === 'unverified') f.db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(target.id)
    if (scenario === 'blocked') f.db.prepare('INSERT INTO challenge_blocks(owner_id,target_id,created_at) VALUES(?,?,?)').run(target.id, a.id, f.now())
    if (scenario === 'recipient-full') f.db.prepare('INSERT INTO challenge_invitation_budgets(user_id,attempts) VALUES(?,50)').run(target.id)
    const insert = f.db.prepare("INSERT INTO private_challenges(id,inviter_id,invitee_id,status,start_date,end_date,created_at,expires_at) VALUES(?,?,?,'pending',?,?,?,?)")
    if (scenario === 'duplicate') insert.run(randomUUID(), a.id, target.id, window.startDate, window.endDate, f.now(), f.now() + 86400000)
    if (scenario === 'inbox-full') for (let i = 0; i < 50; i++) insert.run(randomUUID(), f.seed().id, target.id, window.startDate, window.endDate, f.now(), f.now() + 86400000)
    const email = scenario === 'missing' ? 'missing@example.test' : scenario === 'self' ? a.email : target.email
    const result = await f.request('POST', '/challenges/invitations', { email, ...window }, a)
    const next = await f.request('POST', '/challenges/invitations', { email: control.email, ...window }, a)
    outcomes.push([result.status, result.body, next.status, next.body, (await overview(f, control)).invitations])
    assert.equal(f.db.prepare('SELECT attempts FROM challenge_invitation_budgets WHERE user_id = ?').get(a.id).attempts, 50, scenario)
    assert.equal(f.db.prepare('SELECT attempts FROM challenge_global_budget WHERE id = 1').get().attempts, 50, scenario)
  }
  for (const result of outcomes) assert.deepEqual(result, outcomes[0])
})

test('global boundary and simultaneous attempts reserve identically without eligibility-dependent refunds', async t => {
  const outcomes = []
  for (const eligible of [true, false]) {
    const f = fixture(t), a = f.seed(), b = f.seed(), other = f.seed(), controlled = f.seed()
    f.db.prepare('UPDATE challenge_global_budget SET attempts = 9999 WHERE id = 1').run()
    const replies = await Promise.all([
      f.request('POST', '/challenges/invitations', { email: eligible ? b.email : 'absent@example.test', ...window }, a),
      f.request('POST', '/challenges/invitations', { email: controlled.email, ...window }, other),
    ])
    outcomes.push([replies.map(r => [r.status, r.body]), (await overview(f, controlled)).invitations])
    assert.equal(f.db.prepare('SELECT attempts FROM challenge_global_budget WHERE id = 1').get().attempts, 10000)
    assert.equal(f.db.prepare('SELECT attempts FROM challenge_invitation_budgets WHERE user_id = ?').get(a.id).attempts, 1)
    assert.equal(f.db.prepare('SELECT * FROM challenge_invitation_budgets WHERE user_id = ?').get(other.id), undefined)
  }
  assert.deepEqual(outcomes[0], outcomes[1])
})

test('acceptance rechecks own capacity; decline/expiry are versioned and no invitation outcome refunds budgets', async t => {
  const f = fixture(t), a = f.seed(), b = f.seed(), c = f.seed()
  const pending = await invite(f, a, b)
  f.db.prepare('INSERT INTO challenge_invitation_budgets(user_id,attempts) VALUES(?,50)').run(b.id)
  assert.equal((await f.request('POST', `${inviteEndpoint(pending.id)}/accept`, { baseVersion: 1 }, b)).body.error.code, 'challenge_limit')
  assert.equal((await f.request('DELETE', inviteEndpoint(pending.id), { baseVersion: 1 }, b)).status, 204)
  assert.equal((await f.request('DELETE', inviteEndpoint(pending.id), { baseVersion: 1 }, b)).status, 409)
  assert.equal((await f.request('DELETE', inviteEndpoint(pending.id), { baseVersion: 2 }, b)).status, 204)
  const expiring = await invite(f, a, c)
  f.advance(7 * 86400000); keepSessions(f)
  assert.deepEqual((await overview(f, c)).invitations, [])
  assert.equal((await f.request('POST', `${inviteEndpoint(expiring.id)}/accept`, { baseVersion: 2 }, c)).status, 404)
  assert.equal(f.db.prepare('SELECT attempts FROM challenge_invitation_budgets WHERE user_id = ?').get(a.id).attempts, 2)
  assert.equal(f.db.prepare('SELECT attempts FROM challenge_global_budget WHERE id = 1').get().attempts, 2)
})

test('accepted expiry clears grants/version and versions never decrease at safe-integer privacy ceiling', async t => {
  const f = fixture(t), { a, b, challenge } = await share(f)
  assert.equal(challenge.expiresAt, '2026-11-08T00:00:00.000Z')
  f.db.prepare('UPDATE private_challenges SET expires_at = ? WHERE id = ?').run(f.now(), challenge.id)
  const expired = await current(f, a, challenge.id)
  assert.equal(expired.status, 'expired'); assert.equal(expired.version, challenge.version + 1)
  assert.equal(expired.ownConsent, false); assert.equal(expired.peerConsent, false); assert.equal(expired.revokedAt, null)
  assert.equal((await counts(f, b, challenge.id)).status, 403)
  const next = await connect(f, a, b)
  f.db.prepare('UPDATE private_challenges SET version = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER - 1, next.id)
  assert.equal((await f.request('PUT', `${endpoint(next.id)}/consent`, grantBody(await current(f, a, next.id)), a)).body.error.code, 'revision_limit')
  const revoked = await f.request('DELETE', endpoint(next.id), { baseVersion: Number.MAX_SAFE_INTEGER - 1 }, a)
  assert.equal(revoked.body.challenge.version, Number.MAX_SAFE_INTEGER)
  assert.equal((await f.request('DELETE', endpoint(next.id), { baseVersion: Number.MAX_SAFE_INTEGER }, a)).body.challenge.version, Number.MAX_SAFE_INTEGER)
})

test('current policy/verification/block checks cannot be bypassed by score reads or grant retries', async t => {
  const f = fixture(t), { a, b, challenge } = await share(f)
  for (const [sql, args] of [
    ['UPDATE users SET consent_policy = ? WHERE id = ?', ['old', a.id]],
    ['UPDATE users SET consent = 0 WHERE id = ?', [b.id]],
    ['UPDATE users SET verified = 0 WHERE id = ?', [b.id]],
    ['UPDATE private_challenges SET invitee_policy = ? WHERE id = ?', ['old', challenge.id]],
  ]) {
    f.db.prepare(sql).run(...args)
    const response = await counts(f, a, challenge.id)
    assert.equal(response.status, 403); assert.equal(response.body.error.code, 'sharing_unavailable')
    f.db.prepare('UPDATE users SET verified = 1, consent = 1, consent_policy = ?').run(POLICY_VERSION)
    f.db.prepare('UPDATE private_challenges SET invitee_policy = ?').run(CHALLENGE_POLICY_VERSION)
  }
  const revoke = f.request('DELETE', endpoint(challenge.id), { baseVersion: challenge.version }, a)
  const read = counts(f, b, challenge.id)
  assert.equal((await revoke).status, 200); assert.equal((await read).status, 403)
})

test('own export excludes peers/scores/pending outcomes and reads post-reauth state while feature disabled', async t => {
  const f = fixture(t), { a, b, challenge } = await share(f), incoming = f.seed()
  await save(f, b, [log()]); await invite(f, incoming, a)
  const pending = f.request('POST', '/account/export', { password: PASSWORD }, a)
  await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, b)
  const exported = await pending
  assert.equal(exported.status, 200)
  const data = exported.body.challenges
  assert.deepEqual(Object.keys(data).sort(), ['challenges', 'metric', 'policyVersion'])
  assert.equal(data.challenges.length, 1); assert.equal(data.challenges[0].ownConsent, false)
  assert.equal(data.challenges[0].version, challenge.version + 1)
  for (const secret of [b.email, b.id, incoming.email, incoming.id, 'RecordedDays', 'peerConsent', 'counterpart', 'snapshot', 'revision', 'PRIVATE']) assert.ok(!JSON.stringify(data).includes(secret), secret)
  const disabled = createApp({ db: f.db, config: { origin: ORIGIN, secureCookies: true }, now: f.now })
  const result = await disabled.handle({ method: 'POST', path: '/api/v1/account/export', body: JSON.stringify({ password: PASSWORD }), headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-fitflow-client': 'web', cookie: a.cookie, 'x-csrf-token': a.csrf } })
  assert.equal(result.status, 200); assert.deepEqual(result.body.challenges, data)
})

test('deleting either participant cascades challenges/blocks but never refunds another sender or global budget', async t => {
  for (const which of ['a', 'b']) {
    const f = fixture(t), shared = await share(f), { a, b, challenge } = shared
    await f.request('POST', `${endpoint(challenge.id)}/block`, { baseVersion: challenge.version }, b)
    assert.equal((await f.request('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, shared[which])).status, 204)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM private_challenges').get().n, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM challenge_blocks').get().n, 0)
    assert.equal(f.db.prepare('SELECT attempts FROM challenge_global_budget WHERE id = 1').get().attempts, 1)
    assert.equal(f.db.prepare('SELECT attempts FROM challenge_invitation_budgets WHERE user_id = ?').get(a.id)?.attempts, which === 'a' ? undefined : 1)
    assert.equal((await counts(f, shared[which === 'a' ? 'b' : 'a'], challenge.id)).status, 404)
  }
})

test('per-account request and invitation rates persist, including invalid recipients', async t => {
  const f = fixture(t), a = f.seed()
  for (let i = 0; i < 10; i++) assert.equal((await f.request('POST', '/challenges/invitations', { email: `missing-${i}@example.test`, ...window }, a)).status, 202)
  const result = await f.request('POST', '/challenges/invitations', { email: 'last@example.test', ...window }, a)
  assert.equal(result.status, 429); assert.ok(result.headers['retry-after'])
  assert.equal(f.db.prepare('SELECT attempts FROM challenge_invitation_budgets WHERE user_id = ?').get(a.id).attempts, 10)
  assert.equal(CHALLENGE_LIMITS.total, 10000)
})

test('v4 additive migration preserves all existing rows; budgets/blocks/grants survive reopen and newer schema fails closed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-challenges-migration-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'synthetic.sqlite'), f = setup({ db: openDatabase(path), config: { challengesEnabled: true } })
  const a = f.seed(undefined, true), b = f.seed(undefined, true)
  await save(f, a, [log()])
  const tables = ['users', 'sessions', 'email_tokens', 'sync_operations', 'rate_limits', 'coaching_relationships', 'coaching_feedback', 'coaching_invitation_budgets', 'coaching_global_budget']
  const before = Object.fromEntries(tables.map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]))
  f.db.exec('DROP TABLE challenge_blocks; DROP TABLE private_challenges; DROP TABLE challenge_invitation_budgets; DROP TABLE challenge_global_budget; PRAGMA user_version = 4;'); f.close()
  const migrated = openDatabase(path)
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 6)
  for (const table of tables) assert.deepEqual(migrated.prepare(`SELECT * FROM ${table}`).all(), before[table], table)
  const g = setup({ db: migrated, config: { challengesEnabled: true } })
  let challenge = await connect(g, a, b); await grant(g, a, challenge.id); challenge = await grant(g, b, challenge.id)
  await g.request('POST', '/challenges/invitations', { email: 'missing-persist@example.test', ...window }, a)
  g.close()
  const h = setup({ db: openDatabase(path), config: { challengesEnabled: true } })
  assert.equal((await counts(h, b, challenge.id)).body.peerRecordedDays, 1)
  assert.equal(h.db.prepare('SELECT attempts FROM challenge_invitation_budgets WHERE user_id = ?').get(a.id).attempts, 2)
  await h.request('POST', `${endpoint(challenge.id)}/block`, { baseVersion: challenge.version }, b); h.close()
  const i = setup({ db: openDatabase(path), config: { challengesEnabled: true } })
  assert.equal((await counts(i, a, challenge.id)).status, 403)
  assert.deepEqual((await i.request('POST', '/challenges/invitations', { email: b.email, ...window }, a)).body, { status: 'accepted' })
  assert.deepEqual((await overview(i, b)).invitations, []); i.close()
  const future = new DatabaseSync(path); future.exec('PRAGMA user_version = 7'); future.close()
  assert.throws(() => openDatabase(path), /newer/)
})

test('failed v4 challenge migration rolls back all new DDL and version updates', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-challenges-rollback-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'synthetic.sqlite'), prior = new DatabaseSync(path)
  prior.exec('CREATE TABLE private_challenges(id TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 4')
  const before = prior.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all(); prior.close()
  assert.throws(() => openDatabase(path))
  const after = new DatabaseSync(path); t.after(() => after.close())
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 4)
  assert.deepEqual(after.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all(), before)
})
