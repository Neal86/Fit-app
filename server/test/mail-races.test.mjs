import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PASSWORD, PASSWORD_HASH, setup } from './fixtures.mjs'
import { openDatabase, pruneExpired } from '../database.mjs'
import { digest, verifyPassword } from '../security.mjs'

const NEW_PASSWORD = 'newer synthetic password 789!'
function delayedMail() {
  const messages = [], pending = []
  let paused = false
  return {
    enabled: true, messages, pending,
    pause() { paused = true },
    async send(message) {
      messages.push(message)
      if (paused) await new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
    },
  }
}
async function until(predicate) {
  const end = Date.now() + 4500
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for the synthetic mail boundary')
    await new Promise(resolve => setImmediate(resolve))
  }
}
function fixture(t, mail = delayedMail()) { const f = setup({ mail }); t.after(f.close); return { ...f, mail } }
const register = (f, email, password) => f.request('POST', '/auth/register', { email, password })
const verify = (f, index) => f.request('POST', '/auth/verification/confirm', { token: f.mail.messages[index].token })
const login = (f, email, password) => f.request('POST', '/auth/login', { email, password })

test('resend during re-registration delivery can only verify the newest requested password', async t => {
  const f = fixture(t), email = 'resend-race@example.test'
  await register(f, email, PASSWORD)
  f.mail.pause()
  const registration = register(f, email, NEW_PASSWORD)
  await until(() => f.mail.pending.length === 1)
  const resend = f.request('POST', '/auth/verification/request', { email })
  await until(() => f.mail.pending.length === 2)
  f.mail.pending[0].resolve()
  assert.equal((await registration).status, 202)
  f.mail.pending[1].resolve()
  assert.equal((await resend).status, 202)
  assert.equal((await verify(f, 1)).status, 400)
  assert.equal((await verify(f, 2)).status, 200)
  assert.equal((await login(f, email, NEW_PASSWORD)).status, 200)
  assert.equal((await login(f, email, PASSWORD)).status, 401)
})

test('older registration mail arriving last cannot supersede newer registration credentials', async t => {
  const f = fixture(t), email = 'reordered-register@example.test'
  f.mail.pause()
  const old = register(f, email, PASSWORD)
  await until(() => f.mail.pending.length === 1)
  const current = register(f, email, NEW_PASSWORD)
  await until(() => f.mail.pending.length === 2)
  f.mail.pending[1].resolve(); assert.equal((await current).status, 202)
  f.mail.pending[0].resolve(); assert.equal((await old).status, 202)
  assert.equal((await verify(f, 0)).status, 400)
  assert.equal((await verify(f, 1)).status, 200)
  assert.equal((await login(f, email, NEW_PASSWORD)).status, 200)
  assert.equal((await login(f, email, PASSWORD)).status, 401)
})

test('registration reserves its generation before hashing, and resend cannot use an old hash in that window', async t => {
  const f = fixture(t), email = 'hash-race@example.test'
  const older = register(f, email, PASSWORD)
  const newer = register(f, email, NEW_PASSWORD)
  const resend = await f.request('POST', '/auth/verification/request', { email })
  assert.equal(resend.status, 503)
  assert.equal(resend.body.error.code, 'auth_busy')
  assert.deepEqual((await Promise.all([older, newer])).map(result => result.status), [202, 202])
  assert.equal(f.mail.messages.length, 1)
  assert.equal((await verify(f, 0)).status, 200)
  assert.equal((await login(f, email, NEW_PASSWORD)).status, 200)
  assert.equal((await login(f, email, PASSWORD)).status, 401)
})

test('failed newest delivery does not reactivate older verification mail and resend keeps newest password', async t => {
  const f = fixture(t), email = 'failed-newest@example.test'
  f.mail.pause()
  const old = register(f, email, PASSWORD)
  await until(() => f.mail.pending.length === 1)
  const current = register(f, email, NEW_PASSWORD)
  await until(() => f.mail.pending.length === 2)
  f.mail.pending[1].reject(new Error('synthetic delivery failure'))
  assert.equal((await current).status, 503)
  f.mail.pending[0].resolve(); assert.equal((await old).status, 202)
  assert.equal((await verify(f, 0)).status, 400)
  assert.equal((await verify(f, 1)).status, 400)
  const resend = f.request('POST', '/auth/verification/request', { email })
  await until(() => f.mail.pending.length === 3)
  f.mail.pending[2].resolve(); assert.equal((await resend).status, 202)
  assert.equal((await verify(f, 2)).status, 200)
  assert.equal((await login(f, email, NEW_PASSWORD)).status, 200)
})

test('reset deliveries are generation-bound, and late older mail cannot invalidate a current recovery', async t => {
  const f = fixture(t), user = f.seed('reset-order@example.test')
  f.mail.pause()
  const old = f.request('POST', '/auth/password-reset/request', { email: user.email })
  const current = f.request('POST', '/auth/password-reset/request', { email: user.email })
  await until(() => f.mail.pending.length === 2)
  f.mail.pending[1].resolve(); assert.equal((await current).status, 202)
  f.mail.pending[0].resolve(); assert.equal((await old).status, 202)
  const reset = index => f.request('POST', '/auth/password-reset/confirm', { token: f.mail.messages[index].token, password: NEW_PASSWORD })
  assert.equal((await reset(0)).status, 400)
  assert.equal((await reset(1)).status, 200)
  assert.equal((await reset(1)).status, 400)
  assert.equal((await f.request('GET', '/auth/session', undefined, user)).status, 401)
  assert.equal((await login(f, user.email, NEW_PASSWORD)).status, 200)
})

test('a new reset request supersedes an already-hashing confirmation without applying its password', async t => {
  const f = fixture(t), user = f.seed('reset-confirm-race@example.test')
  await f.request('POST', '/auth/password-reset/request', { email: user.email })
  const confirmation = f.request('POST', '/auth/password-reset/confirm', { token: f.mail.messages[0].token, password: NEW_PASSWORD })
  await f.request('POST', '/auth/password-reset/request', { email: user.email })
  assert.equal((await confirmation).status, 400)
  assert.equal(await verifyPassword(PASSWORD, f.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id).password_hash), true)
  const result = await f.request('POST', '/auth/password-reset/confirm', { token: f.mail.messages[1].token, password: NEW_PASSWORD })
  assert.equal(result.status, 200)
})

test('verification confirmation cannot leave another in-flight delivery usable', async t => {
  const f = fixture(t), email = 'verify-consume@example.test'
  await register(f, email, PASSWORD)
  f.mail.pause()
  const stale = f.request('POST', '/auth/verification/request', { email })
  const latest = f.request('POST', '/auth/verification/request', { email })
  await until(() => f.mail.pending.length === 2)
  f.mail.pending[1].resolve(); await latest
  assert.equal((await verify(f, 2)).status, 200)
  f.mail.pending[0].resolve(); await stale
  assert.equal((await verify(f, 1)).status, 400)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM email_tokens').get().count, 0)
})

test('account deletion while reset mail is pending cannot recreate tokens or accounts', async t => {
  const f = fixture(t), user = f.seed('delete-pending@example.test')
  f.mail.pause()
  const pending = f.request('POST', '/auth/password-reset/request', { email: user.email })
  await until(() => f.mail.pending.length === 1)
  assert.equal((await f.request('DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }, user)).status, 204)
  f.mail.pending[0].resolve(); assert.equal((await pending).status, 202)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM email_tokens').get().count, 0)
  assert.equal((await f.request('POST', '/auth/password-reset/confirm', { token: f.mail.messages[0].token, password: NEW_PASSWORD })).status, 400)
})

test('pruning unverified registration during pending mail or password hashing never resurrects it', async t => {
  const f = fixture(t)
  f.mail.pause()
  const pending = register(f, 'pruned-mail@example.test', PASSWORD)
  await until(() => f.mail.pending.length === 1)
  f.advance(7 * 86400000)
  pruneExpired(f.db, f.now())
  f.mail.pending[0].resolve(); assert.equal((await pending).status, 202)
  assert.equal((await verify(f, 0)).status, 400)
  const hashing = register(f, 'pruned-hash@example.test', PASSWORD)
  f.advance(7 * 86400000)
  pruneExpired(f.db, f.now())
  assert.equal((await hashing).status, 202)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
  assert.equal(f.mail.messages.length, 1)
})

test('v1 security migration invalidates unbound tokens and requires fresh unverified registration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'fitflow-migration-synthetic-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'legacy.sqlite'), legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, consent INTEGER NOT NULL DEFAULT 0, consent_policy TEXT, consent_at INTEGER, revision INTEGER NOT NULL DEFAULT 0, state_json TEXT, state_at INTEGER) STRICT;
    CREATE TABLE email_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, password_hash TEXT) STRICT;
    PRAGMA user_version = 1;
  `)
  legacy.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('synthetic-user', 'migration@example.test', '', Date.now())
  legacy.prepare('INSERT INTO users(id,email,password_hash,created_at,verified) VALUES(?,?,?,?,1)').run('verified-user', 'verified-migration@example.test', PASSWORD_HASH, Date.now())
  legacy.prepare('INSERT INTO email_tokens(token_hash,user_id,purpose,expires_at,ready,password_hash) VALUES(?,?,?,?,1,?)').run(digest('synthetic-token'), 'synthetic-user', 'verify', Date.now() + 100000, PASSWORD_HASH)
  legacy.close()
  const db = openDatabase(path); t.after(() => db.close())
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM email_tokens').get().count, 0)
  const migrated = db.prepare("SELECT * FROM users WHERE id = 'synthetic-user'").get()
  assert.equal(migrated.pending_password_hash, null)
  assert.equal(migrated.password_hash, '')
  assert.equal(db.prepare("SELECT password_hash FROM users WHERE id = 'verified-user'").get().password_hash, PASSWORD_HASH)
  assert.equal(migrated.verify_generation, '')
  assert.equal(migrated.reset_generation, '')
})
