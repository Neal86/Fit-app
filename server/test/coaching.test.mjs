import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createApp } from '../app.mjs'
import { COACHING_LIMITS, COACHING_POLICY_VERSION, INVITATION_TTL_MS, projectSnapshot } from '../coaching.mjs'
import { configFromEnv, POLICY_VERSION } from '../config.mjs'
import { openDatabase } from '../database.mjs'
import { createHttpServer } from '../http.mjs'
import { fixtureState, ORIGIN, PASSWORD, setup, syncBody } from './fixtures.mjs'

function fixture(t, options = {}) { const f = setup({ config: { coachingEnabled: true }, ...options }); t.after(f.close); return f }
const endpoint = id => `/coaching/relationships/${id}`
const invitePath = id => `/coaching/invitations/${id}`
async function list(f, actor) { const response = await f.request('GET', '/coaching', undefined, actor); assert.equal(response.status, 200); return response.body }
async function invite(f, athlete, coach) {
  const result = await f.request('POST', '/coaching/invitations', { email: coach.email }, athlete)
  assert.deepEqual([result.status, result.body], [202, { status: 'accepted' }])
  const invitation = (await list(f, coach)).invitations.find(item => item.athlete.id === athlete.id)
  assert.ok(invitation)
  return invitation
}
async function connect(f, athlete, coach) {
  const invitation = await invite(f, athlete, coach)
  const result = await f.request('POST', `${invitePath(invitation.id)}/accept`, {}, coach)
  assert.equal(result.status, 200)
  return result.body.relationship
}
async function grant(f, athlete, relationship, scopes = ['training']) {
  const result = await f.request('PUT', `${endpoint(relationship.id)}/consent`, { baseVersion: relationship.version, policyVersion: COACHING_POLICY_VERSION, scopes }, athlete)
  assert.equal(result.status, 200)
  return result.body.relationship
}
async function share(f, scopes = ['training']) {
  const athlete = f.seed('athlete@example.test', true), coach = f.seed('coach@example.test')
  const saved = syncBody(richState())
  assert.equal((await f.request('PUT', '/sync', saved, athlete)).status, 200)
  const relationship = await grant(f, athlete, await connect(f, athlete, coach), scopes)
  return { athlete, coach, relationship, saved }
}
const feedbackBody = relationship => ({ baseVersion: relationship.version, operationId: randomUUID(), text: 'Synthetic training feedback: take a comfortable pace.' })
function richState() {
  const state = fixtureState()
  state.profile.name = 'Excluded synthetic name'
  state.workouts[0].exercises[0].notes = 'Synthetic exercise note'
  state.planHistory = [{ id: 'plan-1', label: 'Synthetic prior plan', savedAt: '2026-10-15T11:00:00Z', workouts: structuredClone(state.workouts) }]
  state.logs = [{ id: 'log-1', workoutId: 'workout-1', title: 'Synthetic saved session', startedAt: '2026-10-15T10:00:00Z', completedAt: '2026-10-15T10:10:00Z', duration: 10, calories: 50, completedExerciseIds: ['exercise-1'], notes: 'Synthetic saved training note', sets: [{ id: 'set-1', exerciseId: 'exercise-1', setNumber: 1, reps: 10, weightKg: 0, seconds: null, rpe: null, warmup: false, completed: true }], exerciseSnapshots: [{ id: 'exercise-1', name: 'Walk', category: 'Cardio' }] }]
  state.activeSession = { id: 'active-1', workout: state.workouts[0], startedAt: '2026-10-15T11:10:00Z', elapsedSeconds: 100, runningSince: null, sets: state.logs[0].sets, notes: 'EXCLUDED ACTIVE SESSION SECRET', restUntil: null }
  state.nutrition = { version: 1, meals: [{ id: 'meal-1', date: '2026-10-15', mealType: 'Lunch', foodName: 'Synthetic meal', serving: 'Synthetic serving', calories: 400, protein: 20, carbs: 40, fat: 10 }], hydration: [{ id: 'hydration-1', date: '2026-10-15', milliliters: 250, note: 'Synthetic hydration note' }], targets: [{ date: '2026-10-15', calories: 2000, protein: 90, carbs: 200, fat: 60, milliliters: 2000 }] }
  return state
}

test('coaching is disabled by default, strict opt-in only, and all endpoints fail closed without data', async t => {
  assert.equal(configFromEnv({}).coachingEnabled, false)
  assert.equal(configFromEnv({ FITFLOW_COACHING_ENABLED: 'TRUE' }).coachingEnabled, false)
  assert.equal(configFromEnv({ FITFLOW_COACHING_ENABLED: 'true' }).coachingEnabled, true)
  const f = fixture(t, { config: {} }), actor = f.seed(undefined, true), id = randomUUID()
  for (const [method, path, body] of [
    ['GET', '/coaching'], ['POST', '/coaching/invitations', { email: 'synthetic@example.test' }], ['POST', '/coaching/invitations/cancel', { email: actor.email }],
    ['POST', `${invitePath(id)}/accept`, {}], ['DELETE', invitePath(id), {}], ['GET', `${endpoint(id)}/snapshot`], ['GET', `${endpoint(id)}/feedback`],
    ['PUT', `${endpoint(id)}/consent`, {}], ['DELETE', endpoint(id), {}], ['POST', `${endpoint(id)}/feedback`, {}], ['DELETE', `${endpoint(id)}/feedback/${id}`, {}], ['OPTIONS', '/coaching'],
  ]) {
    const response = await f.request(method, path, body, actor)
    assert.deepEqual(response.body, { error: { code: 'coaching_disabled', message: 'Coach collaboration is disabled.' } })
    assert.equal(response.status, 503)
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  assert.equal((await f.request('GET', '/coaching')).status, 503)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count, 0)
})

test('invitation requests do not enumerate eligibility, create no mail, and expose pending invites only to recipient', async t => {
  const f = fixture(t), athlete = f.seed('athlete@example.test', true), coach = f.seed('coach@example.test'), unverified = f.seed('unverified@example.test')
  f.db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(unverified.id)
  for (const email of ['missing@example.test', unverified.email, athlete.email, 'COACH@EXAMPLE.TEST', coach.email]) {
    const response = await f.request('POST', '/coaching/invitations', { email }, athlete)
    assert.equal(response.status, 202)
    assert.deepEqual(response.body, { status: 'accepted' })
  }
  assert.deepEqual((await list(f, athlete)).invitations, [])
  assert.deepEqual((await list(f, athlete)).relationships, [])
  const result = await list(f, coach)
  assert.equal(result.coachQualificationsVerified, false)
  assert.equal(result.invitations.length, 1)
  assert.deepEqual(result.invitations[0].athlete, { id: athlete.id, email: athlete.email })
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count, 1)
  assert.equal(f.messages.length, 0)
  const other = f.seed()
  assert.deepEqual((await list(f, other)).invitations, [])
  assert.equal((await f.request('POST', `${invitePath(result.invitations[0].id)}/accept`, {}, other)).status, 404)
  assert.equal((await f.request('POST', `${invitePath(result.invitations[0].id)}/accept`, {}, athlete)).status, 404)
  assert.equal((await f.request('POST', '/coaching/invitations', { email: coach.email, athleteId: other.id }, athlete)).status, 400)
})

test('recipient acceptance is explicit, replay-safe and creates no initial sharing scope', async t => {
  const f = fixture(t), athlete = f.seed(undefined, true), coach = f.seed(), invitation = await invite(f, athlete, coach)
  assert.equal((await f.request('GET', `${endpoint(invitation.id)}/snapshot`, undefined, coach)).status, 404)
  assert.equal((await f.request('PUT', `${endpoint(invitation.id)}/consent`, { baseVersion: 1, policyVersion: COACHING_POLICY_VERSION, scopes: ['training'] }, athlete)).status, 404)
  const accepted = await f.request('POST', `${invitePath(invitation.id)}/accept`, {}, coach)
  assert.equal(accepted.status, 200)
  assert.deepEqual(accepted.body.relationship.scopes, [])
  assert.equal(accepted.body.relationship.version, 1)
  assert.equal(accepted.body.relationship.policyVersion, null)
  assert.equal(accepted.body.relationship.role, 'coach')
  assert.deepEqual(accepted.body.relationship.counterpart, { id: athlete.id, email: athlete.email })
  assert.deepEqual((await f.request('POST', `${invitePath(invitation.id)}/accept`, {}, coach)).body, accepted.body)
  assert.equal((await f.request('GET', `${endpoint(invitation.id)}/snapshot`, undefined, coach)).status, 403)
  assert.equal((await f.request('POST', `${endpoint(invitation.id)}/feedback`, feedbackBody(accepted.body.relationship), coach)).status, 403)
  assert.equal((await list(f, athlete)).relationships[0].counterpart.id, coach.id)
  assert.deepEqual((await list(f, coach)).invitations, [])
})

test('decline, cancellation, and exact expiry invalidate invitation IDs; retries never resurrect them', async t => {
  const f = fixture(t), athlete = f.seed(undefined, true), coach = f.seed(), other = f.seed()
  const first = await invite(f, athlete, coach)
  assert.equal((await f.request('DELETE', invitePath(first.id), {}, athlete)).status, 404)
  assert.equal((await f.request('DELETE', invitePath(first.id), {}, coach)).status, 204)
  assert.equal((await f.request('DELETE', invitePath(first.id), {}, coach)).status, 204)
  assert.equal((await f.request('POST', `${invitePath(first.id)}/accept`, {}, coach)).status, 404)
  const second = await invite(f, athlete, coach)
  assert.notEqual(first.id, second.id)
  for (const email of ['missing@example.test', coach.email]) {
    const result = await f.request('POST', '/coaching/invitations/cancel', { email }, other)
    assert.deepEqual([result.status, result.body], [202, { status: 'accepted' }])
  }
  assert.equal((await list(f, coach)).invitations.length, 1)
  assert.equal((await f.request('POST', '/coaching/invitations/cancel', { email: coach.email }, athlete)).status, 202)
  assert.equal((await f.request('POST', `${invitePath(second.id)}/accept`, {}, coach)).status, 404)
  const third = await invite(f, athlete, coach)
  f.db.prepare('UPDATE coaching_relationships SET expires_at = ? WHERE id = ?').run(f.now(), third.id)
  assert.equal(Date.parse(third.expiresAt) - Date.parse(third.createdAt), INVITATION_TTL_MS)
  assert.equal((await f.request('POST', `${invitePath(third.id)}/accept`, {}, coach)).status, 404)
  assert.deepEqual((await list(f, coach)).invitations, [])
  assert.deepEqual((await list(f, athlete)).relationships, [])
})

test('consent requires exact fields, explicit recognized scopes, current policy, current cloud consent and athlete identity', async t => {
  const f = fixture(t), athlete = f.seed(), coach = f.seed(), relationship = await connect(f, athlete, coach)
  const body = { baseVersion: 1, policyVersion: COACHING_POLICY_VERSION, scopes: ['training'] }
  assert.equal((await f.request('PUT', `${endpoint(relationship.id)}/consent`, body, athlete)).status, 403)
  assert.equal((await f.request('PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION }, athlete)).status, 200)
  assert.equal((await f.request('PUT', `${endpoint(relationship.id)}/consent`, body, coach)).status, 404)
  for (const change of [{ scopes: ['all'] }, { scopes: ['training', 'training'] }, { scopes: null }, { scopes: 'training' }, { policyVersion: 'old' }, { baseVersion: 0 }, { baseVersion: 1.5 }, { athleteId: athlete.id }]) {
    assert.equal((await f.request('PUT', `${endpoint(relationship.id)}/consent`, { ...body, ...change }, athlete)).status, 400)
  }
  const granted = await grant(f, athlete, relationship, ['training'])
  assert.equal(granted.version, 2)
  const stale = await f.request('PUT', `${endpoint(relationship.id)}/consent`, body, athlete)
  assert.equal(stale.status, 409)
  assert.deepEqual(stale.body.error.details, { version: 2 })
  assert.equal((await grant(f, athlete, granted, [])).scopes.length, 0)
})

test('each category reveals only the intended saved fields and no active session, preferences, identity or credentials', async t => {
  const f = fixture(t), { athlete, coach, relationship, saved } = await share(f)
  let current = relationship
  for (const scope of ['training', 'body', 'nutrition']) {
    if (scope !== 'training') current = await grant(f, athlete, current, [scope])
    const result = await f.request('GET', `${endpoint(current.id)}/snapshot`, undefined, coach)
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.body).sort(), ['categories', 'relationshipId', 'relationshipVersion', 'revision', 'updatedAt'])
    assert.equal(result.body.revision, 1)
    assert.equal(result.body.relationshipVersion, current.version)
    assert.deepEqual(Object.keys(result.body.categories), [scope])
    assert.deepEqual(result.body.categories, projectSnapshot(saved.state, [scope]))
    const raw = JSON.stringify(result.body)
    for (const excluded of ['activeSession', 'EXCLUDED ACTIVE', 'preferences', 'password', 'birthYear', 'Excluded synthetic name', athlete.email, coach.email, athlete.raw, coach.csrf, 'onboardingComplete']) assert.ok(!raw.includes(excluded), excluded)
  }
  assert.deepEqual((await f.request('GET', `${endpoint(current.id)}/snapshot`, undefined, coach)).body.categories.nutrition, saved.state.nutrition)
  const all = await grant(f, athlete, current, ['training', 'body', 'nutrition'])
  const response = await f.request('GET', `${endpoint(all.id)}/snapshot`, undefined, coach)
  assert.deepEqual(response.body.categories.body.measurements, { weightKg: 70, heightCm: 170 })
  assert.equal(Object.keys(response.body.categories).length, 3)
  assert.equal((await f.request('GET', `${endpoint(all.id)}/snapshot`, undefined, athlete)).status, 404)
})

test('allowlist projection excludes new nested fields even if a future state schema starts accepting them', () => {
  const state = richState()
  state.workouts[0].secret = 'new field'; state.workouts[0].exercises[0].secret = 'new field'
  state.logs[0].secret = 'new field'; state.logs[0].sets[0].secret = 'new field'; state.logs[0].exerciseSnapshots[0].secret = 'new field'
  state.planHistory[0].secret = 'new field'; state.weightHistory[0].secret = 'new field'; state.nutrition.meals[0].secret = 'new field'
  state.nutrition.hydration[0].secret = 'new field'; state.nutrition.targets[0].secret = 'new field'
  assert.ok(!JSON.stringify(projectSnapshot(state, ['training', 'body', 'nutrition'])).includes('secret'))
})

test('sharing follows latest saved cloud revision, never an unsaved client payload, and does not modify records', async t => {
  const f = fixture(t), { athlete, coach, relationship, saved } = await share(f)
  const path = `${endpoint(relationship.id)}/snapshot`
  const local = richState(); local.workouts[0].title = 'Synthetic changed cloud plan'
  assert.equal((await f.request('GET', path, { state: local }, coach)).status, 400)
  assert.equal((await f.request('GET', path, undefined, coach)).body.categories.training.workouts[0].title, saved.state.workouts[0].title)
  assert.equal((await f.request('PUT', '/sync', syncBody(local, 1), athlete)).status, 200)
  const next = await f.request('GET', path, undefined, coach)
  assert.equal(next.body.revision, 2)
  assert.equal(next.body.categories.training.workouts[0].title, local.workouts[0].title)
  assert.equal((await f.request('PUT', path, { state: saved.state }, coach)).status, 404)
  assert.equal((await f.request('PUT', '/sync', { ...syncBody(local), userId: athlete.id }, coach)).status, 403)
  assert.equal((await f.request('GET', '/sync', undefined, athlete)).body.revision, 2)
})

test('training feedback is bounded plaintext, idempotent, read-only to training state and removable only by athlete', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f), path = `${endpoint(relationship.id)}/feedback`, body = feedbackBody(relationship)
  const before = f.db.prepare('SELECT state_json,revision FROM users WHERE id = ?').get(athlete.id)
  assert.equal((await f.request('POST', path, body, athlete)).status, 404)
  const first = await f.request('POST', path, body, coach)
  assert.equal(first.status, 201); assert.equal(first.body.replayed, false)
  assert.equal(first.body.feedback.format, 'plain_text'); assert.equal(first.body.feedback.text, body.text)
  const replay = await f.request('POST', path, body, coach)
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.feedback.id, first.body.feedback.id)
  assert.equal((await f.request('POST', path, { ...body, text: 'Changed text' }, coach)).status, 409)
  assert.deepEqual((await f.request('GET', path, undefined, athlete)).body.feedback, [first.body.feedback])
  assert.deepEqual((await f.request('GET', path, undefined, coach)).body.feedback, [first.body.feedback])
  assert.deepEqual(f.db.prepare('SELECT state_json,revision FROM users WHERE id = ?').get(athlete.id), before)
  const itemPath = `${path}/${first.body.feedback.id}`
  assert.equal((await f.request('DELETE', itemPath, { baseVersion: relationship.version }, coach)).status, 404)
  assert.equal((await f.request('DELETE', itemPath, { baseVersion: relationship.version - 1 }, athlete)).status, 409)
  assert.equal((await f.request('DELETE', itemPath, { baseVersion: relationship.version }, athlete)).status, 204)
  assert.equal((await f.request('DELETE', itemPath, { baseVersion: relationship.version }, athlete)).status, 204)
  assert.deepEqual((await f.request('GET', path, undefined, coach)).body.feedback, [])
  const deletedReplay = await f.request('POST', path, body, coach)
  assert.equal(deletedReplay.status, 409); assert.equal(deletedReplay.body.error.code, 'feedback_removed')
  const row = f.db.prepare('SELECT * FROM coaching_feedback').get()
  assert.equal(row.text, null); assert.equal(typeof row.request_hash, 'string')
})

test('feedback rejects scripts, URLs, Markdown links, controls, oversized text, invalid IDs and extra owner fields', async t => {
  const f = fixture(t), { coach, relationship } = await share(f), path = `${endpoint(relationship.id)}/feedback`, body = feedbackBody(relationship)
  for (const text of ['', ' ', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'https://example.test', 'www.example.test', '[visit](example.test)', 'javascript:alert(1)', 'data:text/html,x', 'a\u0000b', 'a\u202eb', 'x'.repeat(2001), '界'.repeat(1400)]) {
    const result = await f.request('POST', path, { ...body, text }, coach)
    assert.equal(result.status, 400, text.slice(0, 30))
    assert.equal(result.body.error.code, 'invalid_feedback')
  }
  for (const change of [{ operationId: 'not-uuid' }, { userId: coach.id }, { format: 'html' }]) assert.equal((await f.request('POST', path, { ...body, ...change }, coach)).status, 400)
  assert.equal((await f.request('POST', path, { ...body, text: 'Synthetic line one\nLine two\tcomfortable pace.' }, coach)).status, 201)
})

test('body/nutrition scope alone never allows training feedback', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f, ['body', 'nutrition']), path = `${endpoint(relationship.id)}/feedback`
  assert.equal((await f.request('GET', path, undefined, coach)).status, 403)
  assert.equal((await f.request('POST', path, feedbackBody(relationship), coach)).status, 403)
  assert.deepEqual((await f.request('GET', path, undefined, athlete)).body.feedback, [])
})

test('both parties can revoke immediately; stale grants, acceptance replay, feedback and snapshot access cannot reopen sharing', async t => {
  for (const role of ['athlete', 'coach']) {
    const f = fixture(t), { athlete, coach, relationship } = await share(f), path = endpoint(relationship.id), body = feedbackBody(relationship)
    const feedback = await f.request('POST', `${path}/feedback`, body, coach)
    const result = await f.request('DELETE', path, { baseVersion: relationship.version }, role === 'athlete' ? athlete : coach)
    assert.equal(result.status, 200); assert.equal(result.body.relationship.status, 'revoked'); assert.deepEqual(result.body.relationship.scopes, [])
    const version = result.body.relationship.version
    assert.equal((await f.request('DELETE', path, { baseVersion: relationship.version }, athlete)).status, 409)
    assert.equal((await f.request('DELETE', path, { baseVersion: version }, athlete)).status, 200)
    assert.equal((await f.request('GET', `${path}/snapshot`, undefined, coach)).status, 403)
    assert.equal((await f.request('GET', `${path}/feedback`, undefined, coach)).status, 403)
    assert.equal((await f.request('POST', `${path}/feedback`, body, coach)).status, 403)
    assert.equal((await f.request('POST', `${invitePath(relationship.id)}/accept`, {}, coach)).status, 404)
    assert.equal((await f.request('PUT', `${path}/consent`, { baseVersion: version, policyVersion: COACHING_POLICY_VERSION, scopes: ['training'] }, athlete)).status, 403)
    assert.equal((await f.request('GET', `${path}/feedback`, undefined, athlete)).body.feedback.length, 1)
    assert.equal((await f.request('DELETE', `${path}/feedback/${feedback.body.feedback.id}`, { baseVersion: version }, athlete)).status, 204)
    assert.equal((await list(f, athlete)).relationships[0].status, 'revoked')
  }
})

test('cloud consent revocation atomically erases snapshot and all athlete grants, invalidates versions, and needs separate renewed category consent', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f), secondCoach = f.seed(), second = await grant(f, athlete, await connect(f, athlete, secondCoach), ['body'])
  const feedback = await f.request('POST', `${endpoint(relationship.id)}/feedback`, feedbackBody(relationship), coach)
  assert.equal(feedback.status, 201)
  const before = relationship.version
  assert.equal((await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, athlete)).status, 200)
  for (const [actor, relation] of [[coach, relationship], [secondCoach, second]]) {
    assert.equal((await f.request('GET', `${endpoint(relation.id)}/snapshot`, undefined, actor)).status, 403)
    assert.equal((await f.request('GET', `${endpoint(relation.id)}/feedback`, undefined, actor)).status, 403)
  }
  const views = (await list(f, athlete)).relationships
  for (const view of views) { assert.deepEqual(view.scopes, []); assert.equal(view.policyVersion, null); assert.equal(view.version, before + 1) }
  assert.equal(f.db.prepare('SELECT state_json FROM users WHERE id = ?').get(athlete.id).state_json, null)
  assert.equal((await f.request('PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION }, athlete)).status, 200)
  assert.equal((await f.request('PUT', '/sync', syncBody(richState(), 2), athlete)).status, 200)
  assert.equal((await f.request('GET', `${endpoint(relationship.id)}/snapshot`, undefined, coach)).status, 403)
  assert.equal((await f.request('PUT', `${endpoint(relationship.id)}/consent`, { baseVersion: before, policyVersion: COACHING_POLICY_VERSION, scopes: ['training'] }, athlete)).status, 409)
  const renewed = await grant(f, athlete, views.find(view => view.id === relationship.id))
  assert.equal((await f.request('GET', `${endpoint(renewed.id)}/snapshot`, undefined, coach)).status, 200)
  assert.equal((await f.request('GET', `${endpoint(second.id)}/snapshot`, undefined, secondCoach)).status, 403)
})

test('permission checks always consult current verification and policy, including pre-existing sessions', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f), path = `${endpoint(relationship.id)}/snapshot`
  f.db.prepare("UPDATE users SET consent_policy = 'old' WHERE id = ?").run(athlete.id)
  assert.equal((await f.request('GET', path, undefined, coach)).status, 403)
  f.db.prepare('UPDATE users SET consent_policy = ? WHERE id = ?').run(POLICY_VERSION, athlete.id)
  f.db.prepare("UPDATE coaching_relationships SET consent_policy = 'old' WHERE id = ?").run(relationship.id)
  assert.equal((await f.request('GET', path, undefined, coach)).status, 403)
  f.db.prepare('UPDATE coaching_relationships SET consent_policy = ? WHERE id = ?').run(COACHING_POLICY_VERSION, relationship.id)
  for (const account of [athlete, coach]) {
    f.db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(account.id)
    assert.equal((await f.request('GET', path, undefined, coach)).status, 403)
    f.db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(account.id)
  }
  assert.equal((await f.request('GET', path, undefined, coach)).status, 200)
})

test('ownership is session-derived across snapshots, scopes, feedback, and identifier collisions', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f), outsider = f.seed(undefined, true), otherCoach = f.seed()
  const otherRelationship = await grant(f, outsider, await connect(f, outsider, otherCoach))
  const feedback = await f.request('POST', `${endpoint(relationship.id)}/feedback`, feedbackBody(relationship), coach)
  for (const [method, tail, body] of [['GET', '/snapshot'], ['GET', '/feedback'], ['PUT', '/consent', { baseVersion: relationship.version, policyVersion: COACHING_POLICY_VERSION, scopes: ['training'] }], ['DELETE', '', { baseVersion: relationship.version }], ['POST', '/feedback', feedbackBody(relationship)], ['DELETE', `/feedback/${feedback.body.feedback.id}`, { baseVersion: relationship.version }]]) {
    assert.equal((await f.request(method, endpoint(relationship.id) + tail, body, outsider)).status, 404)
    assert.equal((await f.request(method, endpoint(randomUUID()) + tail, body, outsider)).status, 404)
  }
  assert.equal((await f.request('DELETE', `${endpoint(otherRelationship.id)}/feedback/${feedback.body.feedback.id}`, { baseVersion: otherRelationship.version }, outsider)).status, 404)
  assert.equal((await f.request('GET', `${endpoint(relationship.id)}/snapshot?userId=${athlete.id}`, undefined, coach)).status, 400)
})

test('all coaching reads and writes require a valid current session, CSRF, and allowed origin', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f), outsider = f.seed()
  for (const [method, path, body, actor] of [['GET', '/coaching', undefined, coach], ['GET', `${endpoint(relationship.id)}/snapshot`, undefined, coach], ['GET', `${endpoint(relationship.id)}/feedback`, undefined, athlete], ['POST', '/coaching/invitations', { email: outsider.email }, athlete], ['PUT', `${endpoint(relationship.id)}/consent`, { baseVersion: relationship.version, policyVersion: COACHING_POLICY_VERSION, scopes: [] }, athlete], ['DELETE', endpoint(relationship.id), { baseVersion: relationship.version }, athlete]]) {
    assert.equal((await f.request(method, path, body)).status, 401)
    for (const csrf of ['', outsider.csrf]) assert.equal((await f.request(method, path, body, actor, { headers: { 'x-csrf-token': csrf } })).status, 403)
    for (const origin of ['https://evil.test', 'capacitor://localhost', 'null']) assert.equal((await f.request(method, path, body, actor, { headers: { origin } })).status, 403)
    assert.equal((await f.request(method, path, body, actor, { headers: { origin: '', 'sec-fetch-site': 'cross-site' } })).status, 403)
  }
})

test('concurrent consent writes have one winner and revocation defeats stale grant/feedback operations', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f), path = endpoint(relationship.id)
  const body = { baseVersion: relationship.version, policyVersion: COACHING_POLICY_VERSION, scopes: ['training'] }
  const changes = await Promise.all([f.request('PUT', `${path}/consent`, body, athlete), f.request('PUT', `${path}/consent`, { ...body, scopes: ['body'] }, athlete)])
  assert.deepEqual(changes.map(change => change.status), [200, 409])
  const current = changes[0].body.relationship
  const [revoked, staleGrant, staleFeedback, staleRead] = await Promise.all([
    f.request('DELETE', path, { baseVersion: current.version }, athlete),
    f.request('PUT', `${path}/consent`, { ...body, baseVersion: current.version }, athlete),
    f.request('POST', `${path}/feedback`, feedbackBody(current), coach),
    f.request('GET', `${path}/snapshot`, undefined, coach),
  ])
  assert.deepEqual([revoked.status, staleGrant.status, staleFeedback.status, staleRead.status], [200, 409, 403, 403])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_feedback').get().count, 0)
})

test('account deletion on either side cascades invitations, relationships and feedback, leaving no reusable access', async t => {
  for (const role of ['athlete', 'coach']) {
    const f = fixture(t), { athlete, coach, relationship } = await share(f), pendingCoach = f.seed()
    await invite(f, athlete, pendingCoach)
    const posted = await f.request('POST', `${endpoint(relationship.id)}/feedback`, feedbackBody(relationship), coach)
    assert.equal(posted.status, 201)
    const target = role === 'athlete' ? athlete : coach, remaining = role === 'athlete' ? coach : athlete
    assert.equal((await f.request('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, target)).status, 204)
    assert.equal((await f.request('GET', `${endpoint(relationship.id)}/snapshot`, undefined, remaining)).status, 404)
    assert.equal((await f.request('GET', `${endpoint(relationship.id)}/feedback`, undefined, remaining)).status, 404)
    assert.equal((await f.request('GET', '/coaching', undefined, target)).status, 401)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_feedback').get().count, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships WHERE athlete_id = ? OR coach_id = ?').get(target.id, target.id).count, 0)
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  }
})

test('row and request bounds fail safely without revealing invite eligibility', async t => {
  const f = fixture(t), athlete = f.seed(undefined, true), coach = f.seed()
  const insert = f.db.prepare("INSERT INTO coaching_relationships(id,athlete_id,coach_id,status,created_at,expires_at) VALUES(?,?,?,'declined',?,?)")
  for (let i = 0; i < COACHING_LIMITS.relationshipsPerAccount; i++) insert.run(randomUUID(), athlete.id, coach.id, f.now(), f.now() + INVITATION_TTL_MS)
  f.db.prepare('INSERT INTO coaching_invitation_budgets(athlete_id,attempts) VALUES(?,?)').run(athlete.id, COACHING_LIMITS.relationshipsPerAccount)
  for (const email of ['missing@example.test', coach.email]) assert.deepEqual((await f.request('POST', '/coaching/invitations', { email }, athlete)).body, { status: 'accepted' })
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count, COACHING_LIMITS.relationshipsPerAccount)
  assert.deepEqual((await list(f, coach)).invitations, [])
  const outsider = f.seed()
  assert.equal((await f.request('POST', '/coaching/invitations', { email: coach.email }, outsider)).status, 202)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count, COACHING_LIMITS.relationshipsPerAccount + 1)
  assert.equal((await list(f, coach)).invitations.length, 1)
  assert.equal((await f.request('POST', '/coaching/invitations', { email: 'x'.repeat(9000) }, outsider)).status, 413)
})

test('feedback limit counts removed tombstones and cannot be bypassed by deleting entries', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f), path = `${endpoint(relationship.id)}/feedback`
  const insert = f.db.prepare('INSERT INTO coaching_feedback(id,relationship_id,operation_id,request_hash,text,created_at,removed_at) VALUES(?,?,?,?,NULL,?,?)')
  for (let i = 0; i < COACHING_LIMITS.feedbackPerRelationship; i++) insert.run(randomUUID(), relationship.id, randomUUID(), 'synthetic-hash', f.now(), f.now())
  const limited = await f.request('POST', path, feedbackBody(relationship), coach)
  assert.equal(limited.status, 409); assert.equal(limited.body.error.code, 'feedback_limit')
  assert.deepEqual((await f.request('GET', path, undefined, athlete)).body.feedback, [])
})

test('coaching rate controls include ineligible invites, survive errors and cannot be bypassed by spoofed IP headers', async t => {
  const f = fixture(t), athlete = f.seed(undefined, true)
  for (let i = 0; i < 10; i++) assert.equal((await f.request('POST', '/coaching/invitations', { email: `missing${i}@example.test` }, athlete, { headers: { 'x-forwarded-for': `192.0.2.${i}` } })).status, 202)
  const limited = await f.request('POST', '/coaching/invitations', { email: 'another@example.test' }, athlete)
  assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '86400')
  const coach = f.seed()
  for (let i = 0; i < 20; i++) assert.equal((await f.request('POST', `${endpoint(randomUUID())}/feedback`, {}, coach)).status, 404)
  assert.equal((await f.request('POST', `${endpoint(randomUUID())}/feedback`, {}, coach)).status, 429)
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM rate_limits').all()).includes(athlete.email))
})

test('schema v2 migration preserves verified accounts, cloud snapshots and every existing security field', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-coaching-migration-synthetic-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'legacy.sqlite'), old = setup({ db: openDatabase(path) }), athlete = old.seed('migration@example.test', true)
  await old.request('PUT', '/sync', syncBody(richState()), athlete)
  old.db.prepare('UPDATE users SET verify_generation = ?, reset_generation = ? WHERE id = ?').run(randomUUID(), randomUUID(), athlete.id)
  old.db.prepare('INSERT INTO email_tokens(token_hash,user_id,purpose,expires_at,ready,password_hash,generation) VALUES(?,?,?, ?,1,?,?)').run('synthetic-token-hash', athlete.id, 'reset', old.now() + 10000, null, 'synthetic-generation')
  const tables = ['users', 'sessions', 'email_tokens', 'sync_operations', 'rate_limits']
  const before = Object.fromEntries(tables.map(table => [table, old.db.prepare(`SELECT * FROM ${table}`).all()]))
  old.db.exec('DROP TABLE coaching_feedback; DROP TABLE coaching_relationships; DROP TABLE coaching_invitation_budgets; DROP TABLE coaching_global_budget; PRAGMA user_version = 2;')
  old.close()
  const migrated = openDatabase(path)
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 4)
  for (const table of tables) assert.deepEqual(migrated.prepare(`SELECT * FROM ${table}`).all(), before[table], table)
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count, 0)
  assert.equal(migrated.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  migrated.close()
  const reopened = openDatabase(path); t.after(() => reopened.close())
  for (const table of tables) assert.deepEqual(reopened.prepare(`SELECT * FROM ${table}`).all(), before[table])
})

test('real loopback HTTP enforces CSRF and demonstrates invitation, saved projection, and immediate revocation', async t => {
  const f = fixture(t), athlete = f.seed(undefined, true), coach = f.seed(), server = createHttpServer(f.app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/api/v1`
  const request = (method, path, actor, body, headers = {}) => fetch(url + path, { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Fitflow-Client': 'web', Cookie: actor.cookie, 'X-CSRF-Token': actor.csrf, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  assert.equal((await request('GET', '/coaching', coach, undefined, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await request('POST', '/coaching/invitations', athlete, { email: coach.email })).status, 202)
  const inbox = await (await request('GET', '/coaching', coach)).json()
  const accepted = await (await request('POST', `${invitePath(inbox.invitations[0].id)}/accept`, coach, {})).json()
  const id = accepted.relationship.id
  const granted = await (await request('PUT', `${endpoint(id)}/consent`, athlete, { baseVersion: 1, policyVersion: COACHING_POLICY_VERSION, scopes: ['body'] })).json()
  assert.equal((await request('GET', `${endpoint(id)}/snapshot`, coach)).status, 404)
  assert.equal((await request('PUT', '/sync', athlete, syncBody(richState()))).status, 200)
  const snapshot = await request('GET', `${endpoint(id)}/snapshot`, coach)
  assert.equal(snapshot.headers.get('cache-control'), 'no-store')
  assert.equal(snapshot.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.deepEqual(Object.keys((await snapshot.json()).categories), ['body'])
  assert.equal((await request('DELETE', endpoint(id), athlete, { baseVersion: granted.relationship.version })).status, 200)
  assert.equal((await request('GET', `${endpoint(id)}/snapshot`, coach)).status, 403)
})

test('unsolicited terminal invitations cannot exhaust recipient relationship capacity, and pending inbox capacity frees on decline', async t => {
  const f = fixture(t), coach = f.seed(), previousSender = f.seed(), athlete = f.seed(undefined, true)
  const insert = f.db.prepare('INSERT INTO coaching_relationships(id,athlete_id,coach_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?)')
  for (let i = 0; i < COACHING_LIMITS.relationshipsPerAccount; i++) insert.run(randomUUID(), previousSender.id, coach.id, ['declined', 'expired', 'cancelled'][i % 3], f.now(), f.now() - 1)
  const relationship = await connect(f, athlete, coach)
  assert.equal(relationship.status, 'active')
  const incoming = []
  for (let i = 0; i < COACHING_LIMITS.pendingInvitationsPerRecipient; i++) {
    const sender = f.seed(), id = randomUUID()
    insert.run(id, sender.id, coach.id, 'pending', f.now(), f.now() + INVITATION_TTL_MS)
    incoming.push(id)
  }
  const newSender = f.seed()
  assert.equal((await f.request('POST', '/coaching/invitations', { email: coach.email }, newSender)).status, 202)
  assert.equal((await list(f, coach)).invitations.length, COACHING_LIMITS.pendingInvitationsPerRecipient)
  assert.equal((await f.request('DELETE', invitePath(incoming[0]), {}, coach)).status, 204)
  const fresh = await invite(f, newSender, coach)
  assert.equal((await list(f, coach)).invitations.length, COACHING_LIMITS.pendingInvitationsPerRecipient)
  assert.equal((await f.request('POST', `${invitePath(fresh.id)}/accept`, {}, coach)).status, 200)
})

test('acceptance atomically rechecks bounded recipient capacity, even when pending requests were created earlier', async t => {
  const f = fixture(t), coach = f.seed(), athlete = f.seed(), invitation = await invite(f, athlete, coach), priorAthlete = f.seed()
  const insert = f.db.prepare("INSERT INTO coaching_relationships(id,athlete_id,coach_id,status,created_at,expires_at,accepted_at,revoked_at) VALUES(?,?,?,'revoked',?,?,?,?)")
  for (let i = 0; i < COACHING_LIMITS.relationshipsPerAccount; i++) insert.run(randomUUID(), priorAthlete.id, coach.id, f.now(), f.now(), f.now(), f.now())
  const result = await f.request('POST', `${invitePath(invitation.id)}/accept`, {}, coach)
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'relationship_limit')
  assert.equal(f.db.prepare('SELECT status FROM coaching_relationships WHERE id = ?').get(invitation.id).status, 'pending')
  assert.equal((await f.request('DELETE', invitePath(invitation.id), {}, coach)).status, 204)
  const other = f.seed()
  assert.equal((await f.request('POST', '/coaching/invitations', { email: coach.email }, other)).status, 202)
  assert.equal((await list(f, coach)).invitations.length, 0)
})

test('global row capacity fails closed with the same generic invitation response', async t => {
  const f = fixture(t), sender = f.seed(), recipient = f.seed(), athlete = f.seed(), coach = f.seed()
  const insert = f.db.prepare("INSERT INTO coaching_relationships(id,athlete_id,coach_id,status,created_at,expires_at) VALUES(?,?,?,'expired',?,?)")
  f.db.exec('BEGIN')
  for (let i = 0; i < COACHING_LIMITS.relationshipsTotal; i++) insert.run(randomUUID(), sender.id, recipient.id, f.now(), f.now())
  f.db.prepare('UPDATE coaching_global_budget SET attempts = ? WHERE id = 1').run(COACHING_LIMITS.relationshipsTotal)
  f.db.exec('COMMIT')
  for (const email of [coach.email, 'absent@example.test']) assert.deepEqual((await f.request('POST', '/coaching/invitations', { email }, athlete)).body, { status: 'accepted' })
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count, COACHING_LIMITS.relationshipsTotal)
  assert.deepEqual((await list(f, coach)).invitations, [])
})

test('password-authenticated export includes bounded own collaboration records without another athlete snapshot or arbitrary users', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f), outsider = f.seed(), waitingAthlete = f.seed()
  await invite(f, waitingAthlete, coach)
  const posted = await f.request('POST', `${endpoint(relationship.id)}/feedback`, feedbackBody(relationship), coach)
  assert.equal(posted.status, 201)
  assert.equal((await f.request('POST', '/account/export', { password: 'incorrect password long' }, coach)).status, 401)
  for (const actor of [athlete, coach]) {
    const result = await f.request('POST', '/account/export', { password: PASSWORD }, actor)
    assert.equal(result.status, 200)
    assert.equal(result.body.format, 'fitflow-account-export')
    assert.equal(result.body.version, 1)
    const exported = result.body.coaching
    assert.deepEqual(Object.keys(exported).sort(), ['coachQualificationsVerified', 'feedback', 'invitations', 'policyVersion', 'relationships'])
    assert.equal(exported.coachQualificationsVerified, false)
    assert.deepEqual(exported.feedback, [{ relationshipId: relationship.id, items: [posted.body.feedback] }])
    assert.equal(exported.relationships[0].role, actor === athlete ? 'athlete' : 'coach')
    const raw = JSON.stringify(exported)
    for (const hidden of [outsider.email, outsider.id, 'categories', 'activeSession', 'weightHistory', 'password_hash', athlete.raw, coach.raw, 'Synthetic saved training note']) assert.ok(!raw.includes(hidden), hidden)
    if (actor === coach) {
      assert.equal(result.body.sync.state, null)
      assert.equal(exported.invitations.length, 1)
      assert.equal(exported.invitations[0].athlete.id, waitingAthlete.id)
    } else assert.deepEqual(exported.invitations, [])
  }
})

test('revocation during export password hashing cannot leak coach feedback and athlete can export retained feedback while feature is disabled', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f)
  const posted = await f.request('POST', `${endpoint(relationship.id)}/feedback`, feedbackBody(relationship), coach)
  const pendingExport = f.request('POST', '/account/export', { password: PASSWORD }, coach)
  assert.equal((await f.request('DELETE', endpoint(relationship.id), { baseVersion: relationship.version }, athlete)).status, 200)
  const exported = await pendingExport
  assert.equal(exported.status, 200)
  assert.deepEqual(exported.body.coaching.feedback, [])
  assert.equal(exported.body.coaching.relationships[0].status, 'revoked')
  const disabled = createApp({ db: f.db, config: { origin: ORIGIN, secureCookies: true }, now: f.now })
  const response = await disabled.handle({ method: 'POST', path: '/api/v1/account/export', body: JSON.stringify({ password: PASSWORD }), headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-fitflow-client': 'web', cookie: athlete.cookie, 'x-csrf-token': athlete.csrf } })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.coaching.feedback, [{ relationshipId: relationship.id, items: [posted.body.feedback] }])
})

test('cloud consent revoke during export omits coach feedback and repeated consent removal never lowers versions', async t => {
  const f = fixture(t), { athlete, coach, relationship } = await share(f)
  await f.request('POST', `${endpoint(relationship.id)}/feedback`, feedbackBody(relationship), coach)
  const pendingExport = f.request('POST', '/account/export', { password: PASSWORD }, coach)
  for (let i = 0; i < 2; i++) assert.equal((await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, athlete)).status, 200)
  const exported = await pendingExport
  assert.equal(exported.status, 200)
  assert.deepEqual(exported.body.coaching.feedback, [])
  assert.equal(exported.body.coaching.relationships[0].version, relationship.version + 2)
  assert.deepEqual(exported.body.coaching.relationships[0].scopes, [])
})

test('existing coaching consent, feedback and replay tombstones persist after file-database restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-coaching-reopen-synthetic-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite'), f = setup({ db: openDatabase(path), config: { coachingEnabled: true } })
  const { athlete, coach, relationship } = await share(f), body = feedbackBody(relationship)
  const posted = await f.request('POST', `${endpoint(relationship.id)}/feedback`, body, coach)
  assert.equal(posted.status, 201)
  f.close()
  const g = fixture(t, { db: openDatabase(path) })
  assert.equal((await g.request('GET', `${endpoint(relationship.id)}/snapshot`, undefined, coach)).status, 200)
  const replay = await g.request('POST', `${endpoint(relationship.id)}/feedback`, body, coach)
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.feedback.id, posted.body.feedback.id)
  assert.equal((await g.request('DELETE', endpoint(relationship.id), { baseVersion: relationship.version }, athlete)).status, 200)
})

test('schema migration rolls back all DDL on failure and refuses newer versions without changes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-coaching-atomic-synthetic-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'invalid.sqlite'), prior = new DatabaseSync(path)
  prior.exec("CREATE TABLE coaching_relationships (id TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 2")
  const original = prior.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()
  prior.close()
  assert.throws(() => openDatabase(path))
  const unchanged = new DatabaseSync(path)
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 2)
  assert.deepEqual(unchanged.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all(), original)
  unchanged.exec('PRAGMA user_version = 5'); unchanged.close()
  assert.throws(() => openDatabase(path), /newer/)
  const future = new DatabaseSync(path); t.after(() => future.close())
  assert.equal(future.prepare('PRAGMA user_version').get().user_version, 5)
  assert.deepEqual(future.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all(), original)
})

test('concurrent v1 migration openers re-read schema under the write lock instead of repeating ALTER', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-coaching-concurrent-migration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'legacy.sqlite'), prior = new DatabaseSync(path)
  prior.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, consent INTEGER NOT NULL DEFAULT 0, consent_policy TEXT, consent_at INTEGER, revision INTEGER NOT NULL DEFAULT 0, state_json TEXT, state_at INTEGER) STRICT;
    CREATE TABLE email_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, password_hash TEXT) STRICT;
    INSERT INTO users(id,email,password_hash,verified,created_at) VALUES('synthetic','migration@example.test','preserved-synthetic-hash',1,1);
    PRAGMA user_version = 1;
  `)
  prior.close()
  const script = `import { openDatabase } from ${JSON.stringify(new URL('../database.mjs', import.meta.url).href)}; process.stdout.write('ready\\n'); process.stdin.once('data', () => { const db = openDatabase(process.argv[1]); process.stdout.write(String(db.prepare('PRAGMA user_version').get().user_version)); db.close() });`
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    const ready = new Promise(resolve => child.stdout.once('data', resolve))
    const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error(errors))) })
    t.after(() => { if (child.exitCode === null) child.kill() })
    return { child, ready, finished }
  })
  await Promise.all(children.map(child => child.ready))
  for (const { child } of children) child.stdin.end('start')
  assert.deepEqual(await Promise.all(children.map(child => child.finished)), ['ready\n4', 'ready\n4'])
  const result = openDatabase(path); t.after(() => result.close())
  assert.equal(result.prepare("SELECT password_hash FROM users WHERE id = 'synthetic'").get().password_hash, 'preserved-synthetic-hash')
  assert.equal(result.prepare('PRAGMA user_version').get().user_version, 4)
})

test('near sender capacity, eligible and ineligible probes consume the same budget before a controlled inbox check', async t => {
  const outcomes = []
  for (const scenario of ['eligible', 'missing', 'unverified', 'self', 'duplicate', 'recipient-full']) {
    const f = fixture(t), athlete = f.seed(), target = f.seed(), controlled = f.seed(), filler = f.seed()
    const insert = f.db.prepare('INSERT INTO coaching_relationships(id,athlete_id,coach_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    for (let i = 0; i < 49; i++) insert.run(randomUUID(), athlete.id, scenario === 'duplicate' && i === 0 ? target.id : filler.id, scenario === 'duplicate' && i === 0 ? 'pending' : 'declined', f.now(), f.now() + INVITATION_TTL_MS)
    f.db.prepare('INSERT INTO coaching_invitation_budgets(athlete_id,attempts) VALUES(?,49)').run(athlete.id)
    f.db.prepare('UPDATE coaching_global_budget SET attempts = 49 WHERE id = 1').run()
    if (scenario === 'unverified') f.db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(target.id)
    if (scenario === 'recipient-full') f.db.prepare('INSERT INTO coaching_invitation_budgets(athlete_id,attempts) VALUES(?,50)').run(target.id)
    const email = scenario === 'missing' ? 'missing-probe@example.test' : scenario === 'self' ? athlete.email : target.email
    const probe = await f.request('POST', '/coaching/invitations', { email }, athlete)
    const control = await f.request('POST', '/coaching/invitations', { email: controlled.email }, athlete)
    const inbox = await list(f, controlled)
    outcomes.push({ probe: [probe.status, probe.body], control: [control.status, control.body], invitations: inbox.invitations })
    assert.equal(f.db.prepare('SELECT attempts FROM coaching_invitation_budgets WHERE athlete_id = ?').get(athlete.id).attempts, 50, scenario)
    assert.equal(f.db.prepare('SELECT attempts FROM coaching_global_budget WHERE id = 1').get().attempts, 50, scenario)
    assert.deepEqual(inbox.invitations, [], scenario)
  }
  for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0])
})

test('near global capacity, eligible and missing probes give identical later observations from a different controlled sender', async t => {
  const outcomes = []
  for (const eligible of [true, false]) {
    const f = fixture(t), historical = f.seed(), historicalRecipient = f.seed(), athlete = f.seed(), target = f.seed(), controlledSender = f.seed(), controlledRecipient = f.seed()
    const insert = f.db.prepare("INSERT INTO coaching_relationships(id,athlete_id,coach_id,status,created_at,expires_at) VALUES(?,?,?,'expired',?,?)")
    f.db.exec('BEGIN')
    for (let i = 0; i < 9999; i++) insert.run(randomUUID(), historical.id, historicalRecipient.id, f.now(), f.now())
    f.db.prepare('UPDATE coaching_global_budget SET attempts = 9999 WHERE id = 1').run()
    f.db.exec('COMMIT')
    const probe = await f.request('POST', '/coaching/invitations', { email: eligible ? target.email : 'missing-global@example.test' }, athlete)
    const control = await f.request('POST', '/coaching/invitations', { email: controlledRecipient.email }, controlledSender)
    const inbox = await list(f, controlledRecipient)
    outcomes.push({ probe: [probe.status, probe.body], control: [control.status, control.body], invitations: inbox.invitations })
    assert.equal(f.db.prepare('SELECT attempts FROM coaching_global_budget WHERE id = 1').get().attempts, 10000)
    assert.equal(f.db.prepare('SELECT attempts FROM coaching_invitation_budgets WHERE athlete_id = ?').get(athlete.id).attempts, 1)
    assert.deepEqual(inbox.invitations, [])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count, eligible ? 10000 : 9999)
  }
  assert.deepEqual(outcomes[0], outcomes[1])
})

test('invitation budgets charge duplicates and ineligible targets, and cancellation, decline, expiry or recipient deletion never refunds them', async t => {
  const f = fixture(t), athlete = f.seed(), cancelled = f.seed(), declined = f.seed(), expired = f.seed(), deleted = f.seed()
  const cancelledInvite = await invite(f, athlete, cancelled)
  assert.equal((await f.request('POST', '/coaching/invitations', { email: cancelled.email }, athlete)).status, 202)
  assert.equal((await f.request('POST', '/coaching/invitations/cancel', { email: cancelled.email }, athlete)).status, 202)
  assert.equal((await f.request('POST', `${invitePath(cancelledInvite.id)}/accept`, {}, cancelled)).status, 404)
  const declinedInvite = await invite(f, athlete, declined)
  assert.equal((await f.request('DELETE', invitePath(declinedInvite.id), {}, declined)).status, 204)
  const expiredInvite = await invite(f, athlete, expired)
  f.db.prepare('UPDATE coaching_relationships SET expires_at = ? WHERE id = ?').run(f.now(), expiredInvite.id)
  assert.deepEqual((await list(f, expired)).invitations, [])
  await invite(f, athlete, deleted)
  assert.equal((await f.request('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, deleted)).status, 204)
  assert.equal((await f.request('POST', '/coaching/invitations', { email: 'missing-budget@example.test' }, athlete)).status, 202)
  assert.equal(f.db.prepare('SELECT attempts FROM coaching_invitation_budgets WHERE athlete_id = ?').get(athlete.id).attempts, 6)
  assert.equal(f.db.prepare('SELECT attempts FROM coaching_global_budget WHERE id = 1').get().attempts, 6)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_relationships').get().count, 3)
  assert.equal((await f.request('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, athlete)).status, 204)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM coaching_invitation_budgets WHERE athlete_id = ?').get(athlete.id).count, 0)
  assert.equal(f.db.prepare('SELECT attempts FROM coaching_global_budget WHERE id = 1').get().attempts, 6)
})

test('concurrent invitation attempts cannot overrun sender or global reservation budgets', async t => {
  for (const boundary of ['sender', 'global']) {
    const f = fixture(t), athlete = f.seed(), controlled = f.seed()
    if (boundary === 'sender') f.db.prepare('INSERT INTO coaching_invitation_budgets(athlete_id,attempts) VALUES(?,49)').run(athlete.id)
    else f.db.prepare('UPDATE coaching_global_budget SET attempts = 9999 WHERE id = 1').run()
    const responses = await Promise.all([
      f.request('POST', '/coaching/invitations', { email: 'missing-racing@example.test' }, athlete),
      f.request('POST', '/coaching/invitations', { email: controlled.email }, athlete),
    ])
    assert.deepEqual(responses.map(response => [response.status, response.body]), [[202, { status: 'accepted' }], [202, { status: 'accepted' }]])
    assert.deepEqual((await list(f, controlled)).invitations, [])
    assert.equal(f.db.prepare('SELECT attempts FROM coaching_invitation_budgets WHERE athlete_id = ?').get(athlete.id).attempts, boundary === 'sender' ? 50 : 1)
    assert.equal(f.db.prepare('SELECT attempts FROM coaching_global_budget WHERE id = 1').get().attempts, boundary === 'global' ? 10000 : 1)
  }
})

test('v3 budget migration preserves relationship/security data and reserved missing-recipient attempts survive reopen', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-coaching-budget-migration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'v3.sqlite'), f = setup({ db: openDatabase(path), config: { coachingEnabled: true } })
  const { athlete, coach, relationship } = await share(f)
  await f.request('POST', `${endpoint(relationship.id)}/feedback`, feedbackBody(relationship), coach)
  const tables = ['users', 'sessions', 'email_tokens', 'sync_operations', 'rate_limits', 'coaching_relationships', 'coaching_feedback']
  const before = Object.fromEntries(tables.map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]))
  f.db.exec('DROP TABLE coaching_invitation_budgets; DROP TABLE coaching_global_budget; PRAGMA user_version = 3;')
  f.close()
  const g = setup({ db: openDatabase(path), config: { coachingEnabled: true } })
  assert.equal(g.db.prepare('PRAGMA user_version').get().user_version, 4)
  for (const table of tables) assert.deepEqual(g.db.prepare(`SELECT * FROM ${table}`).all(), before[table], table)
  assert.equal(g.db.prepare('SELECT attempts FROM coaching_invitation_budgets WHERE athlete_id = ?').get(athlete.id).attempts, 1)
  assert.equal(g.db.prepare('SELECT attempts FROM coaching_global_budget WHERE id = 1').get().attempts, 1)
  assert.equal((await g.request('POST', '/coaching/invitations', { email: 'missing-persisted@example.test' }, athlete)).status, 202)
  g.close()
  const h = fixture(t, { db: openDatabase(path) })
  assert.equal(h.db.prepare('SELECT attempts FROM coaching_invitation_budgets WHERE athlete_id = ?').get(athlete.id).attempts, 2)
  assert.equal(h.db.prepare('SELECT attempts FROM coaching_global_budget WHERE id = 1').get().attempts, 2)
  assert.equal((await h.request('GET', `${endpoint(relationship.id)}/snapshot`, undefined, coach)).status, 200)
})
