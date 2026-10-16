import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createApp } from '../app.mjs'
import { createHttpServer } from '../http.mjs'
import { configFromEnv } from '../config.mjs'
import { AI_PLAN_POLICY_LIMITS, aiPlanPolicyDigest } from '../aiPlans.mjs'
import { canonicalAiPlanRequest } from '../../.server-build/aiPlanContract.js'
import { digest, token } from '../security.mjs'
import { ORIGIN, PASSWORD, setup } from './fixtures.mjs'

const REF = `c_${'1'.repeat(32)}`, OTHER = `c_${'2'.repeat(32)}`
const payload = () => ({ version: 1, candidates: [{ ref: REF, name: 'Synthetic movement only', category: 'Test', sets: 2, reps: '5', restSeconds: 30, equipment: [] }], constraints: { days: [{ day: 'Monday', plannedMinutes: 20 }], minMovementsPerDay: 1, maxMovementsPerDay: 1, maxSetsPerDay: 2, allowCrossDayRepeats: false } })
const output = () => ({ version: 1, days: [{ day: 'Monday', candidateRefs: [REF] }] })
const policy = () => ({ version: 1, revision: 'synthetic-1', backendOperator: 'Synthetic test operator', provider: 'Synthetic in-process test adapter', model: 'synthetic-fixture', processingDestination: 'This test process only', processingRegion: 'No external processing', retention: 'Bounded memory only; no external service', training: 'No model training', cost: { currency: 'USD', maxChargeMinorUnits: 0 }, cancellationMayCharge: true, limits: { ...AI_PLAN_POLICY_LIMITS } })
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, options = {}) {
  const configured = policy(), calls = []
  const adapter = { enabled: true, policyDigest: aiPlanPolicyDigest(configured), async generate(args) { calls.push(args); return options.generate ? options.generate(args) : JSON.stringify(output()) }, ...options.adapter }
  const f = setup({ config: { aiPlansEnabled: true, aiPlanPolicy: configured, nativeAccountsEnabled: true, ...options.config }, aiAdapter: adapter })
  t.after(f.close)
  const binding = (request = payload()) => { const raw = canonicalAiPlanRequest(request); return { policyRevision: configured.revision, policyDigest: aiPlanPolicyDigest(configured), payloadDigest: digest(raw), payloadBytes: Buffer.byteLength(raw) } }
  const prepare = (user, request = payload()) => f.request('POST', '/ai-plans/prepare', binding(request), user)
  const generate = (user, id, request = payload(), overrides) => f.request('POST', `/ai-plans/${id}/generate`, { request, consent: { accepted: true, ...binding(request) } }, user, overrides)
  return { ...f, configured, adapter, calls, binding, prepare, generate }
}
async function prepared(f, user) { const response = await f.prepare(user); assert.equal(response.status, 201); return response.body.intentId }

test('AI defaults disabled and neither flag nor partial/mismatched configuration can activate an adapter', async t => {
  assert.equal(configFromEnv({}).aiPlansEnabled, false)
  for (const config of [{ aiPlansEnabled: false }, { aiPlanPolicy: null }, { aiPlanPolicy: { ...policy(), processingRegion: '' } }, { aiPlanPolicy: { ...policy(), unsupported: true } }, { aiPlanPolicy: { ...policy(), limits: { ...AI_PLAN_POLICY_LIMITS, timeoutMs: 60000 } } }]) {
    const f = fixture(t, { config }), user = f.seed()
    assert.equal((await f.request('GET', '/ai-plans/policy', undefined, user)).status, 503)
    assert.equal(f.calls.length, 0)
  }
  for (const adapter of [{ enabled: false }, { policyDigest: '0'.repeat(64) }, { generate: null }]) {
    const f = fixture(t, { adapter }), user = f.seed()
    assert.equal((await f.request('GET', '/ai-plans/policy', undefined, user)).body.error.code, 'ai_unavailable')
  }
  const f = setup({ config: { aiPlansEnabled: true, aiPlanPolicy: policy() } }); t.after(f.close)
  assert.equal((await f.request('GET', '/ai-plans/policy', undefined, f.seed())).status, 503)
})

test('policy read is authenticated, verified, CSRF-protected and browser-compatible without Origin', async t => {
  const f = fixture(t), user = f.seed()
  assert.equal((await f.request('GET', '/ai-plans/policy')).status, 401)
  for (const headers of [{ 'x-csrf-token': undefined }, { 'x-fitflow-client': undefined }, { origin: 'https://different.example' }, { 'sec-fetch-site': 'cross-site' }]) assert.ok((await f.request('GET', '/ai-plans/policy', undefined, user, { headers })).status >= 400)
  const response = await f.request('GET', '/ai-plans/policy', undefined, user, { headers: { origin: undefined, 'sec-fetch-site': 'same-origin' } })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { policy: f.configured, policyDigest: f.binding().policyDigest })
  assert.equal(response.headers['cache-control'], 'no-store')
  f.db.prepare('UPDATE users SET verified=0 WHERE id=?').run(user.id)
  assert.equal((await f.request('GET', '/ai-plans/policy', undefined, user)).status, 403)
  assert.equal(f.calls.length, 0)
})

test('native AI paths are absent from the native allowlist and mutating web calls need exact Origin', async t => {
  const f = fixture(t), user = f.seed()
  for (const path of ['/policy', '/prepare', `/${token()}/generate`, `/${token()}/cancel`]) {
    const response = await f.app.handle({ method: path === '/policy' ? 'GET' : 'POST', path: `/api/native/v1/ai-plans${path}`, headers: { 'x-fitflow-client': 'native-v1', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 404)
  }
  assert.equal((await f.request('POST', '/ai-plans/prepare', f.binding(), user, { headers: { origin: undefined } })).status, 403)
  assert.equal(f.calls.length, 0)
})

test('prepare accepts only digest/byte binding and rejects undisclosed metadata or stale full-policy digest', async t => {
  const f = fixture(t), user = f.seed()
  for (const body of [{ ...f.binding(), request: payload() }, { ...f.binding(), policyDigest: '0'.repeat(64) }, { ...f.binding(), policyRevision: 'old' }, { ...f.binding(), payloadBytes: 65537 }, { ...f.binding(), payloadDigest: 'bad' }, { ...f.binding(), provider: 'override' }]) assert.equal((await f.request('POST', '/ai-plans/prepare', body, user)).status, 400)
  const response = await f.prepare(user)
  assert.deepEqual(Object.keys(response.body).sort(), ['expiresAt', 'intentId', 'policyDigest', 'status'])
  assert.equal(response.body.status, 'prepared')
  assert.equal(response.body.policyDigest, f.binding().policyDigest)
  assert.equal(f.calls.length, 0)
  assert.notEqual(aiPlanPolicyDigest({ ...f.configured, training: 'Changed under the same revision' }), f.binding().policyDigest)
})

test('one exact consent dispatches once; duplicate generate/status return closed output without a second call', async t => {
  const f = fixture(t), user = f.seed(), id = await prepared(f, user)
  const response = await f.generate(user, id)
  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'complete')
  assert.deepEqual(response.body.result, output())
  assert.equal(response.body.policyDigest, f.binding().policyDigest)
  assert.equal(f.calls.length, 1)
  assert.ok(Object.isFrozen(f.calls[0].request.candidates[0]))
  assert.ok(Object.isFrozen(f.calls[0].policy.cost))
  assert.equal(f.calls[0].maxOutputBytes, 32768)
  assert.deepEqual((await f.generate(user, id)).body, response.body)
  assert.deepEqual((await f.request('GET', `/ai-plans/${id}`, undefined, user, { headers: { origin: undefined } })).body, response.body)
  assert.equal(f.calls.length, 1)
})

test('missing consent, changed payload, wrong bytes, extra fields and unknown references never dispatch', async t => {
  const f = fixture(t), user = f.seed(), id = await prepared(f, user)
  const valid = { request: payload(), consent: { accepted: true, ...f.binding() } }
  const changed = payload(); changed.candidates[0].name = 'Different exact payload'
  for (const body of [{ ...valid, consent: { ...valid.consent, accepted: false } }, { ...valid, consent: { ...valid.consent, policyDigest: '0'.repeat(64) } }, { ...valid, consent: { ...valid.consent, payloadBytes: valid.consent.payloadBytes + 1 } }, { ...valid, request: changed }, { ...valid, model: 'override' }, { ...valid, request: { ...payload(), profile: { weightKg: 70 } } }]) assert.ok((await f.request('POST', `/ai-plans/${id}/generate`, body, user)).status >= 400)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.generate(user, id)).body.status, 'complete')
})

test('intents are bound to exact account and browser session, not only user identity', async t => {
  const f = fixture(t), first = f.seed(), second = f.seed(), id = await prepared(f, first)
  assert.equal((await f.generate(second, id)).status, 404)
  const anotherRaw = token()
  f.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,last_seen) VALUES(?,?,?,?)').run(digest(anotherRaw), first.id, f.now() + 600000, f.now())
  const { csrfFor } = await import('../security.mjs')
  const another = { ...first, raw: anotherRaw, cookie: `${f.app.cookieName}=${anotherRaw}`, csrf: csrfFor(anotherRaw) }
  assert.equal((await f.generate(another, id)).status, 404)
  assert.equal(f.calls.length, 0)
})

test('cancel before dispatch and expiry leave non-replayable tombstones, including after registry removal', async t => {
  const f = fixture(t), user = f.seed(), id = await prepared(f, user)
  assert.equal((await f.request('POST', `/ai-plans/${id}/cancel`, {}, user)).body.status, 'cancelled')
  assert.equal((await f.generate(user, id)).body.status, 'cancelled')
  const expired = await prepared(f, user)
  f.advance(300001)
  assert.equal((await f.generate(user, expired)).body.status, 'expired')
  f.advance(60001)
  assert.equal((await f.generate(user, expired)).status, 404)
  assert.equal((await f.generate(user, id)).status, 404)
  assert.equal(f.calls.length, 0)
})

test('cancel after dispatch aborts and erases result, while ignored abort keeps the global slot occupied', async t => {
  let release
  const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve }) }), user = f.seed(), id = await prepared(f, user)
  const running = f.generate(user, id)
  await tick()
  assert.equal(f.calls.length, 1)
  assert.equal((await f.generate(user, id)).status, 202)
  assert.equal((await f.request('POST', `/ai-plans/${id}/cancel`, {}, user)).body.status, 'cancelled')
  assert.equal((await running).body.status, 'cancelled')
  assert.equal(f.calls[0].signal.aborted, true)
  const next = await prepared(f, user)
  assert.equal((await f.generate(user, next)).body.error.code, 'ai_busy')
  assert.equal(f.calls.length, 1)
  release(JSON.stringify(output())); await tick()
  assert.equal((await f.generate(user, id)).body.status, 'cancelled')
  f.adapter.generate = async () => JSON.stringify(output()) // Captured adapter function cannot be swapped through mutable config.
  const again = f.generate(user, next); await tick(); release(JSON.stringify(output()))
  assert.equal((await again).body.status, 'complete')
})

test('timeout is bounded, cannot retry the spent intent, and does not free an unsettled provider', async t => {
  let release
  const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve }) }), user = f.seed(), id = await prepared(f, user)
  const running = f.generate(user, id); await tick()
  f.advance(15001)
  assert.equal((await f.request('GET', `/ai-plans/${id}`, undefined, user)).body.error.code, 'ai_timeout')
  assert.equal((await running).body.error.code, 'ai_timeout')
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal((await f.generate(user, id)).body.error.code, 'ai_timeout')
  const next = await prepared(f, user)
  assert.equal((await f.generate(user, next)).body.error.code, 'ai_busy')
  release(JSON.stringify(output())); await tick()
  assert.equal((await f.request('GET', `/ai-plans/${id}`, undefined, user)).body.status, 'failed')
  assert.equal(f.calls.length, 1)
})

test('caller disconnect signal before dispatch or during work cancels permanently', async t => {
  let release
  const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve }) }), user = f.seed()
  const before = new AbortController(); before.abort()
  const beforeId = await prepared(f, user)
  assert.equal((await f.generate(user, beforeId, payload(), { signal: before.signal })).body.status, 'cancelled')
  assert.equal(f.calls.length, 0)
  const id = await prepared(f, user), controller = new AbortController()
  const running = f.generate(user, id, payload(), { signal: controller.signal }); await tick(); controller.abort()
  assert.equal((await running).body.status, 'cancelled')
  assert.equal(f.calls[0].signal.aborted, true)
  release(JSON.stringify(output())); await tick()
  assert.equal((await f.generate(user, id)).body.status, 'cancelled')
})

test('logout, reset request, account deletion and password changes invalidate pending output', async t => {
  for (const action of ['logout', 'reset', 'delete', 'password', 'session-expiry']) {
    let release
    const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve }) }), user = f.seed(), id = await prepared(f, user)
    const running = f.generate(user, id); await tick()
    if (action === 'logout') assert.equal((await f.request('POST', '/auth/logout', {}, user)).status, 204)
    if (action === 'reset') assert.equal((await f.request('POST', '/auth/password-reset/request', { email: user.email }, user)).status, 202)
    if (action === 'delete') assert.equal((await f.request('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, user)).status, 204)
    if (action === 'password') f.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('changed synthetic binding', user.id)
    if (action === 'session-expiry') f.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(f.now(), user.id)
    release(JSON.stringify(output()))
    const response = await running
    assert.equal(response.status, 401, action)
    assert.equal(response.body.result, undefined, action)
    assert.equal(f.calls[0].signal.aborted, true, action)
    await tick()
  }
})

test('policy change in the adapter binding invalidates an in-flight request', async t => {
  let release
  const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve }) }), user = f.seed(), id = await prepared(f, user)
  const running = f.generate(user, id); await tick()
  f.adapter.policyDigest = aiPlanPolicyDigest({ ...f.configured, retention: 'Changed retention under same revision' })
  release(JSON.stringify(output()))
  assert.equal((await running).status, 401)
  assert.equal((await f.request('GET', '/ai-plans/policy', undefined, user)).status, 503)
  await tick()
})

test('raw oversized UTF-8, unexpected keys, provider text, invalid days and invented refs never become results', async t => {
  for (const raw of [' '.repeat(32769), '🙂'.repeat(8193), 'not-json SECRET_PROVIDER_ERROR', JSON.stringify({ ...output(), advice: 'unrequested medical advice' }), JSON.stringify({ version: 1, days: [{ day: 'Tuesday', candidateRefs: [REF] }] }), JSON.stringify({ version: 1, days: [{ day: 'Monday', candidateRefs: [OTHER] }] }), output()]) {
    const f = fixture(t, { generate: async () => raw }), user = f.seed(), id = await prepared(f, user)
    const response = await f.generate(user, id)
    assert.equal(response.body.status, 'failed')
    assert.deepEqual(response.body.error, { code: 'ai_invalid_output', message: 'AI composition returned an invalid result.' })
    assert.equal(response.body.result, undefined)
    assert.equal(JSON.stringify(response).includes('SECRET_PROVIDER_ERROR'), false)
    assert.equal((await f.generate(user, id)).body.status, 'failed')
    assert.equal(f.calls.length, 1)
  }
})

test('adapter exceptions are safe, terminal and never retried', async t => {
  const f = fixture(t, { generate: async () => { throw new Error('SECRET request/provider data') } }), user = f.seed(), id = await prepared(f, user)
  const response = await f.generate(user, id)
  assert.equal(response.body.error.code, 'ai_failed')
  assert.equal(JSON.stringify(response).includes('SECRET'), false)
  assert.equal((await f.generate(user, id)).body.error.code, 'ai_failed')
  assert.equal(f.calls.length, 1)
})

test('global concurrency is shared across app instances and account intent capacity is bounded', async t => {
  let release
  const first = fixture(t, { generate: () => new Promise(resolve => { release = resolve }) }), second = fixture(t)
  const a = first.seed(), b = second.seed(), id = await prepared(first, a), other = await prepared(second, b)
  const pending = first.generate(a, id); await tick()
  assert.equal((await second.generate(b, other)).body.error.code, 'ai_busy')
  await prepared(second, b)
  assert.equal((await second.prepare(b)).body.error.code, 'ai_capacity')
  release(JSON.stringify(output())); await pending; await tick()
  assert.equal((await second.generate(b, other)).body.status, 'complete')
})

test('registry is bounded without evicting live intent bindings', async t => {
  const f = fixture(t)
  // Seed a fixed prepare window, then straddle its end without expiring the later intents.
  await prepared(f, f.seed())
  f.advance(3400000)
  let first, firstId
  for (let index = 0; index < 128; index++) {
    if (index === 119) f.advance(200001)
    const user = f.seed(), id = await prepared(f, user)
    if (!index) { first = user; firstId = id }
  }
  assert.equal((await f.prepare(f.seed())).body.error.code, 'ai_capacity')
  assert.equal((await f.request('GET', `/ai-plans/${firstId}`, undefined, first)).body.status, 'prepared')
  assert.equal(f.calls.length, 0)
})

test('restart loses intent authority, not persistent dispatch quota; no raw payload or output enters database/export', async t => {
  const f = fixture(t), user = f.seed()
  let id
  for (let index = 0; index < 3; index++) {
    id = await prepared(f, user)
    assert.equal((await f.generate(user, id)).body.status, 'complete')
    await f.request('POST', `/ai-plans/${id}/cancel`, {}, user)
  }
  const next = await prepared(f, user)
  assert.equal((await f.generate(user, next)).status, 429)
  const reboot = createApp({ db: f.db, config: { origin: ORIGIN, aiPlansEnabled: true, aiPlanPolicy: f.configured }, aiAdapter: f.adapter, now: f.now })
  t.after(() => reboot.close())
  const call = (method, path, body) => reboot.handle({ method, path: `/api/v1${path}`, headers: { origin: ORIGIN, 'x-fitflow-client': 'web', 'content-type': 'application/json', cookie: user.cookie, 'x-csrf-token': user.csrf }, body: JSON.stringify(body || {}) })
  assert.equal((await call('POST', `/ai-plans/${id}/generate`, { request: payload(), consent: { accepted: true, ...f.binding() } })).status, 404)
  const newId = (await call('POST', '/ai-plans/prepare', f.binding())).body.intentId
  assert.equal((await call('POST', `/ai-plans/${newId}/generate`, { request: payload(), consent: { accepted: true, ...f.binding() } })).status, 429)
  const accountExport = await f.request('POST', '/account/export', { password: PASSWORD }, user)
  assert.equal(accountExport.status, 200)
  assert.equal(Object.keys(accountExport.body).some(key => /ai/i.test(key)), false)
  const tables = f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  const stored = tables.map(({ name }) => JSON.stringify(f.db.prepare(`SELECT * FROM ${name}`).all())).join('\n')
  assert.equal(stored.includes('Synthetic movement only'), false)
  assert.equal(stored.includes(REF), false)
  assert.equal(stored.includes(id), false)
  const counters = f.db.prepare('SELECT * FROM rate_limits WHERE key_hash IN (?,?,?)').all(digest(`ai-dispatch:hour:${user.id}`), digest(`ai-dispatch:day:${user.id}`), digest('ai-dispatch:global-day'))
  assert.equal(counters.length, 3)
  assert.ok(counters.every(counter => counter.count === 3 && /^[a-f0-9]{64}$/.test(counter.key_hash)))
})

test('result retention expires and cannot be recovered by replaying generation', async t => {
  const f = fixture(t), user = f.seed(), id = await prepared(f, user)
  assert.equal((await f.generate(user, id)).body.status, 'complete')
  f.advance(600001)
  const expired = await f.request('GET', `/ai-plans/${id}`, undefined, user)
  assert.equal(expired.body.status, 'expired')
  assert.equal(expired.body.result, undefined)
  assert.equal((await f.generate(user, id)).body.status, 'expired')
  assert.equal(f.calls.length, 1)
})

test('generate request envelope has a raw UTF-8 body cap before validation or dispatch', async t => {
  const f = fixture(t), user = f.seed(), id = await prepared(f, user)
  const response = await f.request('POST', `/ai-plans/${id}/generate`, undefined, user, { body: ' '.repeat(65536 + 2049) })
  assert.equal(response.status, 413)
  assert.equal(f.calls.length, 0)
})

test('per-account daily dispatch budget is durable across hourly windows', async t => {
  const f = fixture(t), user = f.seed()
  for (let index = 0; index < 10; index++) {
    if (index && index % 3 === 0) { f.advance(3600001); f.db.prepare('UPDATE sessions SET last_seen=? WHERE user_id=?').run(f.now(), user.id) }
    const id = await prepared(f, user)
    assert.equal((await f.generate(user, id)).body.status, 'complete')
    await f.request('POST', `/ai-plans/${id}/cancel`, {}, user)
  }
  const id = await prepared(f, user)
  assert.equal((await f.generate(user, id)).status, 429)
  assert.equal(f.calls.length, 10)
})

test('global daily dispatch budget applies across distinct accounts', async t => {
  const f = fixture(t)
  for (let index = 0; index < 30; index++) {
    const user = f.seed(), id = await prepared(f, user)
    assert.equal((await f.generate(user, id)).body.status, 'complete')
    await f.request('POST', `/ai-plans/${id}/cancel`, {}, user)
  }
  const user = f.seed(), id = await prepared(f, user)
  assert.equal((await f.generate(user, id)).status, 429)
  assert.equal(f.calls.length, 30)
})

test('durable prepare quotas prevent one account exhausting the registry by prepare/cancel churn', async t => {
  const f = fixture(t), user = f.seed()
  for (let index = 0; index < 6; index++) {
    const id = await prepared(f, user)
    assert.equal((await f.request('POST', `/ai-plans/${id}/cancel`, {}, user)).body.status, 'cancelled')
  }
  assert.equal((await f.prepare(user)).status, 429)
  assert.equal((await f.prepare(f.seed())).status, 201)
  const reboot = createApp({ db: f.db, config: { origin: ORIGIN, aiPlansEnabled: true, aiPlanPolicy: f.configured }, aiAdapter: f.adapter, now: f.now })
  t.after(() => reboot.close())
  const response = await reboot.handle({ method: 'POST', path: '/api/v1/ai-plans/prepare', headers: { origin: ORIGIN, 'x-fitflow-client': 'web', 'content-type': 'application/json', cookie: user.cookie, 'x-csrf-token': user.csrf }, body: JSON.stringify(f.binding()) })
  assert.equal(response.status, 429)
  assert.equal(f.calls.length, 0)
})

test('policy configuration rejects non-JSON shapes without evaluating disclosure getters', async t => {
  let evaluated = false
  const getterPolicy = policy()
  Object.defineProperty(getterPolicy, 'provider', { enumerable: true, get() { evaluated = true; return 'unsafe getter' } })
  for (const aiPlanPolicy of [getterPolicy, { ...policy(), cost: { currency: new String('USD'), maxChargeMinorUnits: 0 } }, Object.assign(Object.create({}), policy())]) {
    const f = fixture(t, { config: { aiPlanPolicy } })
    assert.equal((await f.request('GET', '/ai-plans/policy', undefined, f.seed())).status, 503)
  }
  assert.equal(evaluated, false)
})

test('the actual timeout timer aborts a pending call without a status poll', async t => {
  let release
  const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve }) }), user = f.seed()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = await prepared(f, user), running = f.generate(user, id)
  await tick()
  t.mock.timers.tick(15000)
  assert.equal((await running).body.error.code, 'ai_timeout')
  assert.equal(f.calls[0].signal.aborted, true)
  release(JSON.stringify(output())); await tick()
  t.mock.timers.reset()
})

test('real HTTP disconnect reaches the synthetic provider through app.handle and keeps its slot held', { timeout: 5000 }, async t => {
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const f = fixture(t, { generate: () => { entered(); return new Promise(resolve => { release = resolve }) } })
  const server = createHttpServer(f.app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { release?.(JSON.stringify(output())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await tick() })
  const user = f.seed(), id = await prepared(f, user)
  const request = httpRequest(`http://127.0.0.1:${server.address().port}/api/v1/ai-plans/${id}/generate`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Fitflow-Client': 'web', Cookie: user.cookie, 'X-CSRF-Token': user.csrf } })
  request.on('error', () => {})
  request.end(JSON.stringify({ request: payload(), consent: { accepted: true, ...f.binding() } }))
  await started; await tick()
  assert.equal(f.calls[0].signal.aborted, false)
  const aborted = new Promise(resolve => f.calls[0].signal.addEventListener('abort', resolve, { once: true }))
  request.destroy(); await aborted
  assert.equal((await f.request('GET', `/ai-plans/${id}`, undefined, user)).body.status, 'cancelled')
  const other = f.seed(), next = await prepared(f, other)
  assert.equal((await f.generate(other, next)).body.error.code, 'ai_busy')
  release(JSON.stringify(output())); await tick()
  assert.equal((await f.generate(user, id)).body.status, 'cancelled')
  assert.equal(f.calls.length, 1)
})

test('late provider settlement cannot win a delayed timeout callback or expose late output', async t => {
  let release
  const f = fixture(t, { generate: () => new Promise(resolve => { release = resolve }) }), user = f.seed(), id = await prepared(f, user)
  const running = f.generate(user, id); await tick()
  f.advance(15000)
  release(JSON.stringify(output()))
  const response = await running
  assert.equal(response.body.status, 'failed')
  assert.equal(response.body.error.code, 'ai_timeout')
  assert.equal(response.body.result, undefined)
  assert.equal(f.calls[0].signal.aborted, true)
  await tick()
})
