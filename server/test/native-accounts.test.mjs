import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../app.mjs'
import { openDatabase, transaction } from '../database.mjs'
import { configFromEnv, NATIVE_SESSION_TTL_MS, POLICY_VERSION, SESSION_IDLE_MS, validateConfig } from '../config.mjs'
import { csrfFor, digest, hashPassword, nativeCredentialBinding, token } from '../security.mjs'
import { ORIGIN, PASSWORD, PASSWORD_HASH, setup, syncBody } from './fixtures.mjs'

const NEXT_PASSWORD = 'changed native synthetic password 456!'
function fixture(t, options = {}) {
  const f = setup({ ...options, config: { nativeAccountsEnabled: true, ...options.config } })
  t.after(f.close)
  const request = (method, path, body, session, overrides = {}) => f.app.handle({
    method, path: `/api/native/v1${path}`, body: body === undefined ? '' : JSON.stringify(body), ip: '127.0.0.1', ...overrides,
    headers: { 'x-fitflow-client': 'native-v1', 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf } : {}), ...overrides.headers },
  })
  const native = (user = f.seed(), options = {}) => {
    const raw = token(), csrf = csrfFor(raw)
    f.db.prepare('INSERT INTO native_sessions(token_hash,user_id,expires_at,last_seen,credential_binding) VALUES(?,?,?,?,?)')
      .run(digest(raw), user.id, f.now() + NATIVE_SESSION_TTL_MS, f.now(), nativeCredentialBinding(PASSWORD_HASH))
    return { ...user, raw, csrf, ...options }
  }
  return { ...f, native, nativeRequest: request }
}
const count = (db, table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(id).n
const login = (f, user, native = true, password = PASSWORD) => (native ? f.nativeRequest : f.request)('POST', '/auth/login', { email: user.email, password })
const noNativeSecrets = (response, ...raws) => {
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(response.headers['access-control-allow-origin'], undefined)
  assert.equal(response.headers['access-control-allow-credentials'], undefined)
  for (const raw of raws) assert.ok(!JSON.stringify(response).includes(raw))
}

test('native config is default-off, exact boolean opt-in and secure configuration only', () => {
  assert.equal(configFromEnv({}).nativeAccountsEnabled, false)
  for (const value of ['false', 'TRUE', '1', 'yes']) assert.equal(configFromEnv({ FITFLOW_NATIVE_ACCOUNTS_ENABLED: value }).nativeAccountsEnabled, false)
  assert.equal(configFromEnv({ FITFLOW_NATIVE_ACCOUNTS_ENABLED: 'true' }).nativeAccountsEnabled, true)
  assert.equal(validateConfig({ origin: ORIGIN, nativeAccountsEnabled: 'true' }).nativeAccountsEnabled, false)
  assert.throws(() => validateConfig({ origin: 'http://localhost', secureCookies: false, nativeAccountsEnabled: true }), /HTTPS/)
})

test('native manual registration, verification resend, login and logout retain existing shapes except private login envelope', async t => {
  const f = fixture(t), email = 'native-register@example.test'
  const register = await f.nativeRequest('POST', '/auth/register', { email, password: PASSWORD })
  assert.deepEqual(register.body, { status: 'verification_required' }); assert.equal(register.status, 202)
  const first = f.messages[0].token
  assert.equal((await f.nativeRequest('POST', '/auth/verification/request', { email })).status, 202)
  assert.equal((await f.nativeRequest('POST', '/auth/verification/confirm', { token: first })).status, 400)
  const confirmation = await f.nativeRequest('POST', '/auth/verification/confirm', { token: f.messages[1].token })
  assert.deepEqual(confirmation.body, { status: 'verified' }); noNativeSecrets(confirmation, ...f.messages.map(x => x.token))
  const result = await login(f, { email })
  assert.equal(result.status, 200)
  assert.deepEqual(Object.keys(result.body).sort(), ['nativeToken', 'session'])
  assert.deepEqual(Object.keys(result.body.session).sort(), ['csrfToken', 'sessionExpiresAt', 'user'])
  const raw = result.body.nativeToken, session = { raw, csrf: result.body.session.csrfToken }
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(session.csrf, csrfFor(raw))
  assert.equal(Date.parse(result.body.session.sessionExpiresAt), f.now() + 8 * 3600000)
  assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers['access-control-allow-origin'], undefined)
  const stored = f.db.prepare('SELECT * FROM native_sessions').get()
  assert.equal(stored.token_hash, digest(raw)); assert.ok(!JSON.stringify(stored).includes(raw))
  assert.equal(stored.credential_binding, nativeCredentialBinding(f.db.prepare('SELECT password_hash FROM users').get().password_hash))
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
  const current = await f.nativeRequest('GET', '/auth/session', undefined, session)
  assert.deepEqual(current.body, result.body.session); noNativeSecrets(current, raw)
  const logout = await f.nativeRequest('POST', '/auth/logout', {}, session)
  assert.equal(logout.status, 204); noNativeSecrets(logout, raw)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, session)).status, 401)
})

test('native logout revokes only current native row and leaves other native and web sessions intact', async t => {
  const f = fixture(t), web = f.seed(), a = f.native(web), b = f.native(web)
  assert.equal((await f.nativeRequest('POST', '/auth/logout', {}, a)).status, 204)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, a)).status, 401)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, b)).status, 200)
  assert.equal((await f.request('GET', '/auth/session', undefined, web)).status, 200)
  assert.equal((await f.request('POST', '/auth/logout', {}, web)).status, 204)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, b)).status, 200)
})

test('native fixed absolute and idle deadlines never refresh; bad context does not extend idle', async t => {
  const f = fixture(t), session = f.native()
  const expires = f.db.prepare('SELECT expires_at FROM native_sessions').get().expires_at
  f.advance(SESSION_IDLE_MS - 1)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, session, { headers: { 'x-csrf-token': 'wrong' } })).status, 403)
  assert.equal(f.db.prepare('SELECT last_seen FROM native_sessions').get().last_seen, f.now() - SESSION_IDLE_MS + 1)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, session)).status, 200)
  assert.equal(f.db.prepare('SELECT expires_at FROM native_sessions').get().expires_at, expires)
  f.advance(SESSION_IDLE_MS)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, session)).status, 401)
  const absolute = f.native()
  f.advance(NATIVE_SESSION_TTL_MS)
  f.db.prepare('UPDATE native_sessions SET last_seen = ?').run(f.now())
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, absolute)).status, 401)
})

test('password reset requests do not revoke credential-bound sessions; successful reset revokes both channels', async t => {
  const f = fixture(t), web = f.seed(), native = f.native(web)
  assert.equal((await f.nativeRequest('POST', '/auth/password-reset/request', { email: web.email })).status, 202)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, native)).status, 200)
  assert.equal((await f.request('POST', '/auth/password-reset/request', { email: web.email })).status, 202)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, native)).status, 200)
  const result = await f.nativeRequest('POST', '/auth/password-reset/confirm', { token: f.messages.at(-1).token, password: NEXT_PASSWORD })
  assert.equal(result.status, 200); noNativeSecrets(result, native.raw)
  for (const table of ['native_sessions', 'sessions', 'email_tokens']) assert.equal(count(f.db, table, web.id), 0)
  assert.equal((await f.request('GET', '/auth/session', undefined, web)).status, 401)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, native)).status, 401)
  assert.equal((await login(f, web, true, NEXT_PASSWORD)).status, 200)
})

test('web reset/deletion revoke native rows even while native feature is disabled', async t => {
  for (const deletion of [false, true]) {
    const f = fixture(t), web = f.seed(), native = f.native(web)
    const disabled = createApp({ db: f.db, config: { origin: ORIGIN }, mail: { enabled: true, async send(message) { f.messages.push(message) } }, now: f.now })
    const request = (method, path, body) => disabled.handle({ method, path: `/api/v1${path}`, body: JSON.stringify(body), headers: { origin: ORIGIN, 'x-fitflow-client': 'web', 'content-type': 'application/json', cookie: web.cookie, 'x-csrf-token': web.csrf } })
    if (deletion) assert.equal((await request('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' })).status, 204)
    else {
      assert.equal((await request('POST', '/auth/password-reset/request', { email: web.email })).status, 202)
      assert.equal((await request('POST', '/auth/password-reset/confirm', { token: f.messages[0].token, password: NEXT_PASSWORD })).status, 200)
    }
    assert.equal(count(f.db, 'native_sessions', web.id), 0)
    assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, native)).status, 401)
  }
})

test('changed password hash invalidates native binding without relying on reset generation or row deletion', async t => {
  const f = fixture(t), native = f.native()
  f.db.prepare('UPDATE users SET reset_generation = ? WHERE id = ?').run(randomUUID(), native.id)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, native)).status, 200)
  f.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(NEXT_PASSWORD), native.id)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, native)).status, 401)
  assert.equal(count(f.db, 'native_sessions', native.id), 1)
})

test('shared session cap is ten total and concurrent native/web login preserves both new sessions', async t => {
  const f = fixture(t), user = f.seed()
  for (let i = 0; i < 8; i++) { f.advance(1); f.native(user) }
  f.advance(1)
  assert.equal(count(f.db, 'sessions', user.id) + count(f.db, 'native_sessions', user.id), 9)
  const results = await Promise.all([login(f, user, true), login(f, user, false)])
  assert.deepEqual(results.map(r => r.status), [200, 200])
  assert.equal(count(f.db, 'sessions', user.id) + count(f.db, 'native_sessions', user.id), 10)
  const raw = results[0].body.nativeToken
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, { raw, csrf: csrfFor(raw) })).status, 200)
  const cookie = results[1].headers['set-cookie'].split(';')[0]
  assert.equal((await f.request('GET', '/auth/session', undefined, { cookie, csrf: results[1].body.csrfToken })).status, 200)
  assert.equal((await f.request('GET', '/auth/session', undefined, user)).status, 401)
})

test('auth email, IP, global and reauthentication budgets cannot be bypassed by changing channel', async t => {
  const f = fixture(t), user = f.seed(), native = f.native(user)
  for (let i = 0; i < 10; i++) assert.equal((await (i % 2 ? f.nativeRequest : f.request)('POST', '/auth/password-reset/request', { email: 'missing@example.test' })).status, 202)
  assert.equal((await f.request('POST', '/auth/password-reset/request', { email: 'missing@example.test' })).status, 429)
  assert.equal((await f.nativeRequest('POST', '/auth/password-reset/request', { email: 'missing@example.test' })).status, 429)
  f.advance(15 * 60000)
  for (let i = 0; i < 30; i++) assert.equal((await (i % 2 ? f.nativeRequest : f.request)('POST', '/auth/password-reset/request', { email: `missing${i}@example.test` })).status, 202)
  assert.equal((await f.nativeRequest('POST', '/auth/password-reset/request', { email: 'another@example.test' })).status, 429)
  assert.equal((await f.request('POST', '/auth/password-reset/request', { email: 'another@example.test' })).status, 429)
  f.advance(15 * 60000)
  f.db.prepare('UPDATE sessions SET last_seen = ?').run(f.now()); f.db.prepare('UPDATE native_sessions SET last_seen = ?').run(f.now())
  for (let i = 0; i < 5; i++) assert.equal((await (i % 2 ? f.nativeRequest : f.request)('POST', '/account/export', { password: 'wrong synthetic long password' }, i % 2 ? native : user)).status, 401)
  assert.equal((await f.nativeRequest('POST', '/account/export', { password: PASSWORD }, native)).status, 429)
  assert.equal((await f.request('POST', '/account/export', { password: PASSWORD }, user)).status, 429)
  f.advance(60000)
  for (let i = 0; i < 180; i++) assert.equal((await (i % 2 ? f.nativeRequest : f.request)('GET', '/auth/session', undefined, i % 2 ? native : user)).status, 200)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, native)).status, 429)
  assert.equal((await f.request('GET', '/auth/session', undefined, user)).status, 429)
})

test('native and web sync share consent, ownership, CAS, replay and revocation tombstones', async t => {
  const f = fixture(t), web = f.seed(), native = f.native(web), other = f.native()
  assert.equal((await f.nativeRequest('GET', '/sync', undefined, native)).status, 403)
  assert.equal((await f.nativeRequest('PUT', '/consent', { healthSync: true, policyVersion: 'old' }, native)).status, 400)
  assert.equal((await f.nativeRequest('PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION }, native)).status, 200)
  assert.equal((await f.request('GET', '/consent', undefined, web)).body.healthSync, true)
  const first = syncBody()
  assert.equal((await f.nativeRequest('PUT', '/sync', first, native)).status, 200)
  assert.equal((await f.request('PUT', '/sync', first, web)).body.replayed, true)
  const changed = structuredClone(first); changed.state.profile.name = 'Changed'
  assert.equal((await f.nativeRequest('PUT', '/sync', changed, native)).body.error.code, 'idempotency_conflict')
  const writes = await Promise.all([f.request('PUT', '/sync', syncBody(first.state, 1), web), f.nativeRequest('PUT', '/sync', syncBody(first.state, 1), native)])
  assert.deepEqual(writes.map(r => r.status).sort(), [200, 409])
  assert.equal((await f.nativeRequest('GET', '/sync', undefined, other)).status, 403)
  assert.equal((await f.nativeRequest('PUT', '/sync', { ...first, userId: other.id }, native)).status, 400)
  assert.equal((await f.nativeRequest('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, native)).status, 200)
  assert.equal((await f.request('GET', '/sync', undefined, web)).status, 403)
  assert.equal((await f.request('PUT', '/consent', { healthSync: true, policyVersion: POLICY_VERSION }, web)).status, 200)
  assert.equal((await f.nativeRequest('PUT', '/sync', first, native)).body.error.code, 'sync_conflict')
  const current = await f.nativeRequest('GET', '/sync', undefined, native)
  assert.equal(current.body.revision, 3); assert.equal(current.body.state, null); noNativeSecrets(current, native.raw)
  f.db.prepare('UPDATE users SET consent_policy = ? WHERE id = ?').run('stale', web.id)
  assert.equal((await f.nativeRequest('GET', '/sync', undefined, native)).status, 403)
})

test('native export and deletion reauthenticate, exclude secrets and cascade only current account', async t => {
  const f = fixture(t), web = f.seed(undefined, true), native = f.native(web), other = f.native()
  assert.equal((await f.nativeRequest('PUT', '/sync', syncBody(), native)).status, 200)
  assert.equal((await f.nativeRequest('POST', '/account/export', { password: 'wrong synthetic long password' }, native)).status, 401)
  const exported = await f.nativeRequest('POST', '/account/export', { password: PASSWORD }, native)
  assert.equal(exported.status, 200); assert.equal(exported.body.user.id, native.id)
  noNativeSecrets(exported, native.raw, web.raw, other.raw, PASSWORD, PASSWORD_HASH, other.email, 'credential_binding', 'token_hash')
  assert.equal((await f.nativeRequest('DELETE', '/account', { password: PASSWORD, confirmation: 'yes' }, native)).status, 400)
  const deleted = await f.nativeRequest('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, native)
  assert.equal(deleted.status, 204); noNativeSecrets(deleted, native.raw)
  for (const table of ['native_sessions', 'sessions', 'sync_operations', 'email_tokens']) assert.equal(count(f.db, table, native.id), 0)
  assert.equal((await f.request('GET', '/auth/session', undefined, web)).status, 401)
  assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, other)).status, 200)
})

test('login cannot survive password replacement or deletion while password hashing is pending in either channel', async t => {
  const replacement = await hashPassword(NEXT_PASSWORD)
  for (const isNative of [false, true]) for (const remove of [false, true]) {
    const f = fixture(t), user = f.seed()
    const pending = login(f, user, isNative)
    if (remove) f.db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
    else transaction(f.db, () => {
      f.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(replacement, user.id)
      f.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
      f.db.prepare('DELETE FROM native_sessions WHERE user_id = ?').run(user.id)
    })
    const result = await pending
    assert.equal(result.status, 401)
    assert.equal(count(f.db, 'native_sessions', user.id) + count(f.db, 'sessions', user.id), 0)
    assert.equal(result.headers['set-cookie'], undefined)
  }
})

test('native export/deletion recheck immutable session context after async reauthentication', async t => {
  const replacement = await hashPassword(NEXT_PASSWORD)
  for (const operation of ['export', 'delete']) for (const revoke of ['session', 'credential', 'account']) {
    const f = fixture(t), user = f.seed(), native = f.native(user), other = f.native()
    const pending = operation === 'export' ? f.nativeRequest('POST', '/account/export', { password: PASSWORD }, native) : f.nativeRequest('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, native)
    // Unrelated concurrent web/native requests must never change the captured channel.
    assert.equal((await f.request('GET', '/auth/session', undefined, user)).status, 200)
    assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, other)).status, 200)
    if (revoke === 'session') f.db.prepare('DELETE FROM native_sessions WHERE token_hash = ?').run(digest(native.raw))
    if (revoke === 'credential') f.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(replacement, user.id)
    if (revoke === 'account') f.db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
    const result = await pending
    assert.equal(result.status, 401); noNativeSecrets(result, native.raw, other.raw)
    if (revoke !== 'account') assert.ok(f.db.prepare('SELECT id FROM users WHERE id = ?').get(user.id))
    assert.equal((await f.nativeRequest('GET', '/auth/session', undefined, other)).status, 200)
  }
})

function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name)
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

test('v5 to v6 migration preserves every existing record atomically and v6 reopens with native FK cascade', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-native-migration-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'synthetic.sqlite'), old = setup({ db: openDatabase(path) })
  const a = old.seed('migration-a@example.test', true), b = old.seed('migration-b@example.test', true)
  await old.request('PUT', '/sync', syncBody(), a)
  await old.request('POST', '/auth/password-reset/request', { email: a.email })
  const relationship = randomUUID(), challenge = randomUUID()
  old.db.prepare("INSERT INTO coaching_relationships(id,athlete_id,coach_id,status,created_at,expires_at) VALUES(?,?,?,'pending',?,?)").run(relationship, a.id, b.id, old.now(), old.now() + 60000)
  old.db.prepare('INSERT INTO coaching_feedback(id,relationship_id,operation_id,request_hash,text,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), relationship, randomUUID(), digest('synthetic'), 'Synthetic record', old.now())
  old.db.prepare('INSERT INTO coaching_invitation_budgets VALUES(?,1)').run(a.id)
  old.db.prepare('UPDATE coaching_global_budget SET attempts = 1').run()
  old.db.prepare("INSERT INTO private_challenges(id,inviter_id,invitee_id,status,start_date,end_date,created_at,expires_at) VALUES(?,?,?,'pending','2026-10-15','2026-10-16',?,?)").run(challenge, a.id, b.id, old.now(), old.now() + 60000)
  old.db.prepare('INSERT INTO challenge_blocks VALUES(?,?,?)').run(a.id, b.id, old.now())
  old.db.prepare('INSERT INTO challenge_invitation_budgets VALUES(?,1)').run(a.id)
  old.db.prepare('UPDATE challenge_global_budget SET attempts = 1').run()
  // Synthetic historical fixture construction only, never an operational downgrade.
  old.db.exec('DROP TABLE native_sessions; PRAGMA user_version = 5')
  const before = snapshot(old.db)
  for (const rows of Object.values(before)) assert.ok(rows.length > 0)
  old.close()
  const upgraded = openDatabase(path)
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 6)
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows, table)
  assert.deepEqual(upgraded.prepare('SELECT * FROM native_sessions').all(), [])
  const raw = token()
  upgraded.prepare('INSERT INTO native_sessions VALUES(?,?,?,?,?)').run(digest(raw), a.id, Date.now() + 60000, Date.now(), nativeCredentialBinding(PASSWORD_HASH))
  upgraded.close()
  const reopened = openDatabase(path); t.after(() => reopened.close())
  assert.equal(count(reopened, 'native_sessions', a.id), 1)
  assert.equal(reopened.prepare('PRAGMA foreign_key_check').all().length, 0)
  reopened.prepare('DELETE FROM users WHERE id = ?').run(a.id)
  assert.equal(count(reopened, 'native_sessions', a.id), 0)
  assert.ok(reopened.prepare('SELECT id FROM users WHERE id = ?').get(b.id))
})

test('failed v6 migration rolls back DDL/version and future schema readers fail closed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-native-rollback-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'synthetic.sqlite'), old = new DatabaseSync(path)
  old.exec('CREATE TABLE native_sessions(token_hash TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 5')
  const before = old.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all(); old.close()
  assert.throws(() => openDatabase(path))
  const check = new DatabaseSync(path)
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 5)
  assert.deepEqual(check.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all(), before)
  check.exec('PRAGMA user_version = 7'); check.close()
  assert.throws(() => openDatabase(path), /newer/)
  const after = new DatabaseSync(path); t.after(() => after.close())
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 7)
  assert.deepEqual(after.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all(), before)
})
