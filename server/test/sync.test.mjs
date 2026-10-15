import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fixtureState, PASSWORD, setup, syncBody } from './fixtures.mjs'
import { POLICY_VERSION } from '../config.mjs'

function fixture(t) { const f = setup(); t.after(f.close); return f }
const allow = (f, user) => f.request('PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION }, user)

test('health data is unavailable until explicit versioned consent; consent cannot cross accounts', async t => {
  const f = fixture(t), a = f.seed(), b = f.seed()
  assert.equal((await f.request('GET', '/sync', undefined, a)).status, 403)
  assert.equal((await f.request('PUT', '/sync', syncBody(), a)).status, 403)
  assert.equal((await f.request('PUT', '/consent', { healthSync: true, policyVersion: 'old' }, a)).status, 400)
  assert.equal((await f.request('PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION, userId: b.id }, a)).status, 400)
  const consent = await allow(f, a)
  assert.equal(consent.body.healthSync, true)
  assert.equal((await f.request('GET', '/consent', undefined, b)).body.healthSync, false)
  assert.deepEqual((await f.request('GET', '/sync', undefined, a)).body, { revision: 0, state: null, updatedAt: null })
})

test('sync stores valid state durably and is strictly scoped to the session user', async t => {
  const f = fixture(t), a = f.seed('a@example.test', true), b = f.seed('b@example.test', true)
  const request = syncBody()
  const written = await f.request('PUT', '/sync', request, a)
  assert.equal(written.status, 200)
  assert.deepEqual(written.body, { revision: 1, updatedAt: new Date(f.now()).toISOString(), replayed: false })
  assert.deepEqual((await f.request('GET', '/sync', undefined, a)).body.state, request.state)
  assert.equal((await f.request('GET', '/sync', undefined, b)).body.state, null)
  for (const suffix of [`/sync/${a.id}`, `/users/${a.id}/sync`, `/sync?userId=${a.id}`]) assert.notEqual((await f.request('GET', suffix, undefined, b)).status, 200)
  assert.equal((await f.request('PUT', '/sync', { ...request, userId: b.id }, a)).status, 400)
  assert.equal((await f.request('GET', '/sync')).status, 401)
})

test('optimistic concurrency reports explicit conflicts without overwriting state', async t => {
  const f = fixture(t), user = f.seed(undefined, true), first = syncBody()
  assert.equal((await f.request('PUT', '/sync', first, user)).status, 200)
  const stale = syncBody(); stale.state.profile.name = 'Stale device'
  const result = await f.request('PUT', '/sync', stale, user)
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'sync_conflict')
  assert.deepEqual(result.body.error.details, { revision: 1 })
  assert.deepEqual((await f.request('GET', '/sync', undefined, user)).body.state, first.state)
  assert.equal((await f.request('PUT', '/sync', { ...stale, baseRevision: 1 }, user)).body.revision, 2)
})

test('parallel writes to the same base cannot both win', async t => {
  const f = fixture(t), user = f.seed(undefined, true)
  const results = await Promise.all([f.request('PUT', '/sync', syncBody(), user), f.request('PUT', '/sync', syncBody(), user)])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  assert.equal((await f.request('GET', '/sync', undefined, user)).body.revision, 1)
})

test('idempotency is per-user, persistent across later writes and rejects changed payloads', async t => {
  const f = fixture(t), a = f.seed(undefined, true), b = f.seed(undefined, true), request = syncBody()
  await f.request('PUT', '/sync', request, a)
  const duplicate = await f.request('PUT', '/sync', request, a)
  assert.equal(duplicate.body.replayed, true)
  assert.equal(duplicate.body.revision, 1)
  await f.request('PUT', '/sync', syncBody(fixtureState(), 1), a)
  const replay = await f.request('PUT', '/sync', { state: request.state, operationId: request.operationId, baseRevision: 0 }, a)
  assert.equal(replay.body.revision, 1)
  assert.equal((await f.request('GET', '/sync', undefined, a)).body.revision, 2)
  assert.equal((await f.request('PUT', '/sync', request, b)).body.replayed, false)
  const modified = structuredClone(request); modified.state.profile.name = 'Changed'
  const conflict = await f.request('PUT', '/sync', modified, a)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'idempotency_conflict')
})

test('revoking consent deletes cloud data and leaves a monotonic revision tombstone', async t => {
  const f = fixture(t), user = f.seed(undefined, true), request = syncBody()
  await f.request('PUT', '/sync', request, user)
  assert.equal((await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, user)).status, 200)
  assert.equal((await f.request('GET', '/sync', undefined, user)).status, 403)
  const stored = f.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
  assert.equal(stored.state_json, null)
  assert.equal(stored.revision, 2)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sync_operations').get().count, 0)
  await allow(f, user)
  assert.equal((await f.request('PUT', '/sync', request, user)).status, 409)
  assert.equal((await f.request('GET', '/sync', undefined, user)).body.state, null)
  assert.equal((await f.request('PUT', '/sync', syncBody(fixtureState(), 2), user)).body.revision, 3)
})

test('malformed states, IDs, revisions, and invalid nested records cannot alter the snapshot', async t => {
  const f = fixture(t), user = f.seed(undefined, true)
  const cases = []
  for (const baseRevision of [-1, 0.1, '0', Number.MAX_SAFE_INTEGER + 1]) cases.push({ ...syncBody(), baseRevision })
  for (const operationId of ['', 'user-1', 'x'.repeat(300)]) cases.push({ ...syncBody(), operationId })
  for (const modify of [
    state => { state.version = 2 }, state => { state.profile.weightKg = -1 },
    state => { state.workouts[0].exercises.push(state.workouts[0].exercises[0]) },
    state => { state.weightHistory[0].date = '2026-02-30' }, state => { state.logs = [{}] },
    state => { state.activeSession = {} }, state => { state.profile = null },
    state => { let nested = {}; state.extra = nested; for (let i = 0; i < 20; i++) { nested.child = {}; nested = nested.child } },
  ]) { const state = fixtureState(); modify(state); cases.push(syncBody(state)) }
  for (const body of cases) assert.equal((await f.request('PUT', '/sync', body, user)).status, 400)
  assert.equal((await f.request('GET', '/sync', undefined, user)).body.revision, 0)
})

test('export requires password and returns only the current account with no secret hashes', async t => {
  const f = fixture(t), a = f.seed('export-a@example.test', true), b = f.seed('export-b@example.test', true)
  await f.request('PUT', '/sync', syncBody(), a)
  assert.equal((await f.request('POST', '/account/export', { password: 'wrong password long' }, a)).status, 401)
  const result = await f.request('POST', '/account/export', { password: PASSWORD }, a)
  assert.equal(result.status, 200)
  assert.equal(result.body.format, 'fitflow-account-export')
  assert.equal(result.body.user.id, a.id)
  assert.equal(result.body.sync.revision, 1)
  for (const forbidden of [b.email, b.id, PASSWORD, 'password_hash', 'token_hash', a.raw]) assert.ok(!JSON.stringify(result.body).includes(forbidden))
  assert.equal((await f.request('POST', '/account/export', { password: PASSWORD, userId: b.id }, a)).status, 400)
})

test('account deletion requires password and confirmation; cascades only that account', async t => {
  const f = fixture(t), a = f.seed('delete-a@example.test', true), b = f.seed('delete-b@example.test', true)
  await f.request('PUT', '/sync', syncBody(), a)
  await f.request('POST', '/auth/password-reset/request', { email: a.email })
  assert.equal((await f.request('DELETE', '/account', { password: PASSWORD, confirmation: 'yes' }, a)).status, 400)
  assert.equal((await f.request('DELETE', '/account', { password: 'wrong password long', confirmation: 'DELETE' }, a)).status, 401)
  const result = await f.request('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, a)
  assert.equal(result.status, 204)
  assert.match(result.headers['set-cookie'], /Max-Age=0/)
  assert.equal(f.db.prepare('SELECT * FROM users WHERE id = ?').get(a.id), undefined)
  for (const table of ['sessions', 'email_tokens', 'sync_operations']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(a.id).count, 0)
  assert.equal((await f.request('GET', '/auth/session', undefined, a)).status, 401)
  assert.equal((await f.request('GET', '/auth/session', undefined, b)).status, 200)
  assert.equal((await f.request('POST', '/auth/password-reset/confirm', { token: f.messages[0].token, password: PASSWORD })).status, 400)
})

test('revision and operation limits fail closed', async t => {
  const f = fixture(t), user = f.seed(undefined, true)
  f.db.prepare('UPDATE users SET revision = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER, user.id)
  const result = await f.request('PUT', '/sync', syncBody(fixtureState(), Number.MAX_SAFE_INTEGER, randomUUID()), user)
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'revision_limit')
})


test('wide and unknown-extension payloads are rejected without growing a pending-node queue', async t => {
  const f = fixture(t), user = f.seed(undefined, true)
  for (const state of [
    { ...fixtureState(), extra: Array(1000000).fill(0) },
    { ...fixtureState(), extra: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`field${i}`, 0])) },
    { ...fixtureState(), extra: 'unsupported' },
  ]) {
    const response = await f.request('PUT', '/sync', syncBody(state), user)
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'invalid_state')
  }
  assert.equal((await f.request('GET', '/sync', undefined, user)).body.revision, 0)
})
