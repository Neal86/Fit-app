import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.mjs'
import { configFromEnv, POLICY_VERSION, validateConfig } from '../config.mjs'
import { openDatabase, rateLimit } from '../database.mjs'
import { ORIGIN, PASSWORD, setup, syncBody } from './fixtures.mjs'

function fixture(t, options) { const f = setup(options); t.after(f.close); return f }

test('foreign, missing, null, and native origins cannot mutate or read through cross-origin requests', async t => {
  const f = fixture(t), user = f.seed(undefined, true)
  for (const origin of ['https://evil.test', 'null', 'capacitor://localhost', 'https://localhost', '']) {
    const result = await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, user, { headers: { origin } })
    assert.equal(result.status, 403)
    assert.ok(!result.headers['access-control-allow-origin'])
  }
  assert.equal((await f.request('GET', '/auth/session', undefined, user, { headers: { origin: 'https://evil.test' } })).status, 403)
  assert.equal((await f.request('GET', '/auth/session', undefined, user, { headers: { origin: '', 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await f.request('GET', '/auth/session', undefined, user, { headers: { origin: '' } })).status, 200)
  assert.equal((await f.request('GET', '/consent', undefined, user)).body.healthSync, true)
})

test('CSRF token is tied to one session; missing custom headers and non-JSON mutations fail', async t => {
  const f = fixture(t), a = f.seed(undefined, true), b = f.seed()
  const body = { healthSync: false, policyVersion: POLICY_VERSION }
  for (const csrf of ['', 'bad', b.csrf]) assert.equal((await f.request('PUT', '/consent', body, a, { headers: { 'x-csrf-token': csrf } })).status, 403)
  assert.equal((await f.request('POST', '/auth/login', { email: a.email, password: PASSWORD }, undefined, { headers: { 'x-fitflow-client': '' } })).status, 403)
  assert.equal((await f.request('POST', '/auth/login', { email: a.email, password: PASSWORD }, undefined, { headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await f.request('PUT', '/consent', body, a)).status, 200)
})

test('CORS preflight is restricted and credentialed responses are never cached', async t => {
  const f = fixture(t)
  const preflight = await f.request('OPTIONS', '/auth/login', undefined, undefined, { headers: { 'access-control-request-method': 'POST' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN)
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true')
  assert.equal(preflight.headers.vary, 'Origin')
  assert.equal(preflight.headers['cache-control'], 'no-store')
  assert.equal((await f.request('OPTIONS', '/auth/login', undefined, undefined, { headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' } })).status, 403)
  assert.equal((await f.request('OPTIONS', '/auth/login', undefined, undefined, { headers: { 'access-control-request-method': 'TRACE' } })).status, 403)
})

test('request body bounds, invalid JSON, and secret-bearing URLs fail before changes', async t => {
  const f = fixture(t), user = f.seed(undefined, true)
  const tooBig = await f.request('POST', '/auth/login', { email: user.email, password: 'a'.repeat(9000) })
  assert.equal(tooBig.status, 413)
  assert.equal((await f.request('PUT', '/sync', undefined, user, { body: '{invalid' })).status, 400)
  assert.equal((await f.request('PUT', '/sync', undefined, user, { body: 'x'.repeat(10 * 1024 * 1024 + 1025) })).status, 413)
  assert.equal((await f.request('GET', '/auth/session?token=must-not-be-used', undefined, user)).status, 400)
  assert.equal((await f.request('PUT', '/sync', null, user)).status, 400)
})

test('authorization fails on every data endpoint with missing and forged sessions', async t => {
  const f = fixture(t)
  for (const [method, path, body] of [['GET', '/auth/session'], ['GET', '/consent'], ['GET', '/sync'], ['PUT', '/sync', syncBody()], ['PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION }], ['POST', '/account/export', { password: PASSWORD }], ['DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }], ['POST', '/auth/logout', {}]]) {
    assert.equal((await f.request(method, path, body)).status, 401)
  }
})

test('email and IP rate limits persist, include retry-after, and ignore spoofed forwarding headers', async t => {
  const f = fixture(t), email = 'rate@example.test'
  for (let i = 0; i < 10; i++) assert.equal((await f.request('POST', '/auth/password-reset/request', { email }, undefined, { headers: { 'x-forwarded-for': `192.0.2.${i}` } })).status, 202)
  const limited = await f.request('POST', '/auth/password-reset/request', { email }, undefined, { headers: { 'x-forwarded-for': '198.51.100.1' } })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers['retry-after'], '900')
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM rate_limits').all()).includes(email))
  const restarted = createApp({ db: f.db, config: { origin: ORIGIN, secureCookies: true }, now: f.now, mail: { enabled: true, async send() {} } })
  const replay = await restarted.handle({ method: 'POST', path: '/api/v1/auth/password-reset/request', body: JSON.stringify({ email }), ip: '127.0.0.1', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-fitflow-client': 'web' } })
  assert.equal(replay.status, 429)
  f.advance(15 * 60000)
  assert.equal((await f.request('POST', '/auth/password-reset/request', { email })).status, 202)
})

test('rate-limit state has a fixed upper bound and fails closed at capacity', async t => {
  const f = fixture(t)
  f.db.exec('BEGIN')
  const insert = f.db.prepare('INSERT INTO rate_limits(key_hash,count,window_end) VALUES(?,1,?)')
  for (let i = 0; i < 10000; i++) insert.run(`synthetic-${i}`, f.now() + 1000)
  f.db.exec('COMMIT')
  assert.throws(() => rateLimit(f.db, 'extra', 10, 1000, f.now()), error => error.status === 503)
  assert.doesNotThrow(() => rateLimit(f.db, 'extra', 10, 1000, f.now() + 1000))
})

test('file database persists state and session hashes, with restrictive file permissions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-synthetic-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const f = setup({ db: openDatabase(path) })
  const user = f.seed(undefined, true), operation = syncBody()
  assert.equal((await f.request('PUT', '/sync', operation, user)).status, 200)
  f.close()
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const g = setup({ db: openDatabase(path) }); t.after(g.close)
  assert.equal((await g.request('GET', '/sync', undefined, user)).body.revision, 1)
  assert.equal((await g.request('PUT', '/sync', operation, user)).body.replayed, true)
  const rows = JSON.stringify(g.db.prepare('SELECT * FROM sessions').all())
  assert.ok(!rows.includes(user.raw))
})

test('config is off by default and rejects unsafe origin/cookie/binding combinations', () => {
  assert.equal(configFromEnv({}).enabled, false)
  assert.equal(configFromEnv({ FITFLOW_ALLOW_INSECURE_LOCALHOST: 'true', FITFLOW_APP_ORIGIN: 'http://localhost:5173' }).secureCookies, false)
  for (const config of [
    { origin: 'http://remote.example', secureCookies: false }, { origin: 'http://localhost', secureCookies: true },
    { origin: 'https://example.test/', secureCookies: true }, { origin: 'capacitor://localhost', secureCookies: true },
  ]) assert.throws(() => validateConfig(config))
  assert.throws(() => configFromEnv({ FITFLOW_ALLOW_INSECURE_LOCALHOST: 'true', FITFLOW_APP_ORIGIN: 'http://localhost:5173', FITFLOW_SERVER_HOST: '0.0.0.0' }))
  assert.throws(() => configFromEnv({ FITFLOW_SERVER_PORT: 'NaN' }))
})


test('protected reads bind cookie identity to the current client session token', async t => {
  const f = fixture(t), a = f.seed(undefined, true), b = f.seed(undefined, true)
  for (const path of ['/consent', '/sync']) {
    assert.equal((await f.request('GET', path, undefined, b, { headers: { 'x-csrf-token': a.csrf } })).status, 403)
    assert.equal((await f.request('GET', path, undefined, a, { headers: { 'x-csrf-token': '' } })).status, 403)
    assert.equal((await f.request('GET', path, undefined, a)).status, 200)
  }
  assert.equal((await f.request('GET', '/auth/session', undefined, b, { headers: { 'x-csrf-token': '' } })).status, 200)
})
