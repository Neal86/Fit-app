import test from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, setup } from './fixtures.mjs'
import { digest, hashPassword, token, verifyPassword } from '../security.mjs'
import { SESSION_IDLE_MS, SESSION_TTL_MS, VERIFY_TTL_MS } from '../config.mjs'

function fixture(t, options) { const f = setup(options); t.after(f.close); return f }

test('registration, verification, login, session, logout are real and use protected cookies', async t => {
  const f = fixture(t)
  const register = await f.request('POST', '/auth/register', { email: 'Synthetic@EXAMPLE.test', password: PASSWORD })
  assert.equal(register.status, 202)
  assert.equal(f.messages.length, 1)
  const user = f.db.prepare('SELECT * FROM users').get()
  assert.equal(user.email, 'synthetic@example.test')
  assert.match(user.pending_password_hash, /^scrypt\$131072\$8\$1\$/)
  assert.equal(user.password_hash, '')
  assert.ok(!user.pending_password_hash.includes(PASSWORD))
  const storedToken = f.db.prepare('SELECT * FROM email_tokens').get()
  assert.equal(storedToken.token_hash, digest(f.messages[0].token))
  assert.ok(!JSON.stringify(register).includes(f.messages[0].token))
  assert.equal((await f.request('POST', '/auth/login', { email: user.email, password: PASSWORD })).status, 403)
  assert.equal((await f.request('POST', '/auth/verification/confirm', { token: f.messages[0].token })).status, 200)
  assert.equal((await f.request('POST', '/auth/verification/confirm', { token: f.messages[0].token })).status, 400)
  const login = await f.request('POST', '/auth/login', { email: user.email, password: PASSWORD })
  assert.equal(login.status, 200)
  assert.match(login.headers['set-cookie'], /^__Host-fitflow_session=/)
  assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict; Max-Age=604800; Secure$/)
  assert.ok(!login.headers['set-cookie'].includes('Domain='))
  const session = { cookie: login.headers['set-cookie'].split(';')[0], csrf: login.body.csrfToken }
  const current = await f.request('GET', '/auth/session', undefined, session)
  assert.equal(current.body.user.id, user.id)
  assert.equal(current.body.csrfToken, session.csrf)
  assert.equal(current.headers['cache-control'], 'no-store')
  assert.equal((await f.request('POST', '/auth/logout', {}, session)).status, 204)
  assert.equal((await f.request('GET', '/auth/session', undefined, session)).status, 401)
})

test('unknown account and wrong password share invalid_credentials; malformed inputs rejected', async t => {
  const f = fixture(t), user = f.seed()
  const unknown = await f.request('POST', '/auth/login', { email: 'missing@example.test', password: PASSWORD })
  const wrong = await f.request('POST', '/auth/login', { email: user.email, password: 'wrong synthetic password' })
  assert.deepEqual(unknown.body, wrong.body)
  assert.equal(unknown.status, 401)
  for (const password of ['short', 'a'.repeat(129), null]) assert.equal((await f.request('POST', '/auth/login', { email: user.email, password })).status, 400)
  assert.equal((await f.request('POST', '/auth/register', { email: 'bad', password: PASSWORD })).status, 400)
  assert.equal((await f.request('POST', '/auth/register', { email: user.email, password: PASSWORD, verified: true })).status, 400)
})

test('disabled email adapter fails clearly before account creation or recovery', async t => {
  const f = fixture(t, { mail: { enabled: false } })
  const result = await f.request('POST', '/auth/register', { email: 'disabled@example.test', password: PASSWORD })
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'email_unavailable')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
  assert.equal((await f.request('POST', '/auth/password-reset/request', { email: 'missing@example.test' })).status, 503)
})

test('delivery failure never exposes or activates a token, and registration can be retried', async t => {
  let fail = true
  const sent = []
  const f = fixture(t, { mail: { enabled: true, async send(message) { sent.push(message); if (fail) throw new Error('private mail credentials') } } })
  const body = { email: 'failure@example.test', password: PASSWORD }
  const failed = await f.request('POST', '/auth/register', body)
  assert.equal(failed.status, 503)
  assert.ok(!JSON.stringify(failed).includes('private'))
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM email_tokens').get().count, 0)
  assert.equal((await f.request('POST', '/auth/verification/confirm', { token: sent[0].token })).status, 400)
  fail = false
  assert.equal((await f.request('POST', '/auth/register', body)).status, 202)
  assert.equal((await f.request('POST', '/auth/verification/confirm', { token: sent[1].token })).status, 200)
})

test('re-registration of an unverified address binds verification to the latest requested password', async t => {
  const f = fixture(t), email = 'reregister@example.test', next = 'new synthetic password 789!'
  await f.request('POST', '/auth/register', { email, password: PASSWORD })
  const firstToken = f.messages[0].token
  await f.request('POST', '/auth/register', { email, password: next })
  // Resending must preserve the requested replacement password rather than restore the old one.
  await f.request('POST', '/auth/verification/request', { email })
  assert.equal((await f.request('POST', '/auth/verification/confirm', { token: firstToken })).status, 400)
  assert.equal((await f.request('POST', '/auth/verification/confirm', { token: f.messages.at(-1).token })).status, 200)
  assert.equal((await f.request('POST', '/auth/login', { email, password: PASSWORD })).status, 401)
  assert.equal((await f.request('POST', '/auth/login', { email, password: next })).status, 200)
})

test('password reset is single-use, expiring and revokes all sessions', async t => {
  const f = fixture(t), user = f.seed('reset@example.test'), next = 'changed synthetic password 123!'
  await f.request('POST', '/auth/password-reset/request', { email: user.email })
  const raw = f.messages[0].token
  assert.equal(f.messages[0].kind, 'reset')
  assert.equal((await f.request('POST', '/auth/verification/confirm', { token: raw })).status, 400)
  assert.equal((await f.request('POST', '/auth/password-reset/confirm', { token: raw, password: next })).status, 200)
  assert.equal((await f.request('GET', '/auth/session', undefined, user)).status, 401)
  assert.equal((await f.request('POST', '/auth/password-reset/confirm', { token: raw, password: next })).status, 400)
  assert.equal((await f.request('POST', '/auth/login', { email: user.email, password: PASSWORD })).status, 401)
  assert.equal((await f.request('POST', '/auth/login', { email: user.email, password: next })).status, 200)
  await f.request('POST', '/auth/password-reset/request', { email: user.email })
  f.advance(30 * 60000)
  assert.equal((await f.request('POST', '/auth/password-reset/confirm', { token: f.messages.at(-1).token, password: PASSWORD })).status, 400)
})

test('sessions expire at idle and absolute deadlines, forged and duplicate cookies fail', async t => {
  const f = fixture(t), user = f.seed()
  for (const cookie of ['__Host-fitflow_session=bad', `__Host-fitflow_session=${token()}`, `${user.cookie}; ${user.cookie}`]) assert.equal((await f.request('GET', '/auth/session', undefined, user, { headers: { cookie } })).status, 401)
  f.advance(SESSION_IDLE_MS)
  assert.equal((await f.request('GET', '/auth/session', undefined, user)).status, 401)
  const another = f.seed()
  f.advance(SESSION_TTL_MS)
  f.db.prepare('UPDATE sessions SET last_seen = ? WHERE user_id = ?').run(f.now(), another.id)
  assert.equal((await f.request('GET', '/auth/session', undefined, another)).status, 401)
})

test('expired verification tokens cannot be used and old requests do not expose account existence', async t => {
  const f = fixture(t)
  await f.request('POST', '/auth/register', { email: 'expired@example.test', password: PASSWORD })
  f.advance(VERIFY_TTL_MS)
  assert.equal((await f.request('POST', '/auth/verification/confirm', { token: f.messages[0].token })).status, 400)
  const a = await f.request('POST', '/auth/password-reset/request', { email: 'missing@example.test' })
  const b = await f.request('POST', '/auth/password-reset/request', { email: 'expired@example.test' })
  assert.deepEqual(a.body, b.body)
  assert.equal(f.messages.length, 1)
})

test('password hashing uses unique random salts and verifies exactly', async () => {
  const a = await hashPassword(PASSWORD), b = await hashPassword(PASSWORD)
  assert.notEqual(a, b)
  assert.equal(await verifyPassword(PASSWORD, a), true)
  assert.equal(await verifyPassword(`${PASSWORD}x`, a), false)
})
