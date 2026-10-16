import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../database.mjs'
import { createHttpServer } from '../http.mjs'
import { csrfFor, digest, nativeCredentialBinding, token } from '../security.mjs'
import { NATIVE_SESSION_TTL_MS, POLICY_VERSION } from '../config.mjs'
import { ORIGIN, PASSWORD, PASSWORD_HASH, setup } from './fixtures.mjs'

// Independent synthetic security probes. No real account, mail or native bridge.
const PREFIX = '/api/native/v1'
const nativeHeaders = session => ({
  'content-type': 'application/json', 'x-fitflow-client': 'native-v1',
  authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf,
})
function nativeSession(f, user) {
  const raw = token()
  f.db.prepare('INSERT INTO native_sessions VALUES(?,?,?,?,?)')
    .run(digest(raw), user.id, f.now() + NATIVE_SESSION_TTL_MS, f.now(), nativeCredentialBinding(PASSWORD_HASH))
  return { ...user, raw, csrf: csrfFor(raw) }
}
function fixture(t) {
  const f = setup({ config: { nativeAccountsEnabled: true } })
  t.after(f.close)
  return f
}
function noSecrets(response, secrets) {
  const serialized = JSON.stringify(response)
  for (const secret of secrets) assert.equal(serialized.includes(secret), false)
}

for (const channel of ['native', 'web']) for (const action of ['export', 'delete']) {
  test(`${channel} ${action} keeps the original identity when caller headers mutate during password verification`, async t => {
    const f = fixture(t), a = f.seed('review-a@example.test'), b = f.seed('review-b@example.test')
    const nativeA = nativeSession(f, a), nativeB = nativeSession(f, b)
    const headers = channel === 'native' ? nativeHeaders(nativeA) : {
      'content-type': 'application/json', 'x-fitflow-client': 'web', origin: ORIGIN,
      cookie: a.cookie, 'x-csrf-token': a.csrf,
    }
    const method = action === 'export' ? 'POST' : 'DELETE'
    const path = `${channel === 'native' ? PREFIX : '/api/v1'}/account${action === 'export' ? '/export' : ''}`
    const pending = f.app.handle({ method, path, headers, body: JSON.stringify({ password: PASSWORD, ...(action === 'delete' ? { confirmation: 'DELETE' } : {}) }) })
    // The async password check has begun. Reuse and mutate the caller's original object,
    // then interleave a different user's opposite-channel request before it resumes.
    Object.keys(headers).forEach(key => delete headers[key])
    Object.assign(headers, channel === 'native' ? {
      origin: ORIGIN, cookie: b.cookie, 'x-fitflow-client': 'web', 'x-csrf-token': b.csrf,
    } : nativeHeaders(nativeB))
    const other = channel === 'native'
      ? await f.request('GET', '/auth/session', undefined, b)
      : await f.app.handle({ method: 'GET', path: `${PREFIX}/auth/session`, headers: nativeHeaders(nativeB) })
    assert.equal(other.status, 200)
    assert.equal(other.body.user.id, b.id)
    const result = await pending
    assert.equal(result.status, action === 'export' ? 200 : 204, JSON.stringify(result.body))
    if (action === 'export') assert.equal(result.body.user.id, a.id)
    assert.ok(f.db.prepare('SELECT id FROM users WHERE id = ?').get(b.id))
    assert.equal(!!f.db.prepare('SELECT id FROM users WHERE id = ?').get(a.id), action === 'export')
    assert.equal(!!result.headers['set-cookie'], channel === 'web' && action === 'delete')
    if (channel === 'native') {
      assert.equal(result.headers['access-control-allow-origin'], undefined)
      assert.equal(result.headers['set-cookie'], undefined)
    }
    noSecrets(result, [nativeA.raw, nativeB.raw, a.raw, b.raw, PASSWORD, PASSWORD_HASH, b.email])
  })
}

async function wire(server, headers, trailers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: server.address().port,
      method: 'PUT', path: `${PREFIX}/consent`, agent: false,
      headers: { ...headers, 'transfer-encoding': 'chunked' },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode, headers: response.headers, body: raw ? JSON.parse(raw) : undefined })
      })
    })
    request.once('error', reject)
    request.setTimeout(10000, () => request.destroy(new Error('Synthetic trailer probe timed out')))
    request.write(JSON.stringify({ healthSync: true, policyVersion: POLICY_VERSION }))
    if (trailers) request.addTrailers(trailers)
    request.end()
  })
}

test('declared and undeclared browser or credential trailers are rejected before native business code', async t => {
  const f = fixture(t), user = f.seed(), session = nativeSession(f, user)
  let routed = 0
  const server = createHttpServer({ handle: request => { routed++; return f.app.handle(request) } })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const candidates = [
    { Cookie: 'browser-cookie=synthetic' }, { Origin: 'https://foreign.example.test' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Authorization: `Bearer ${session.raw}` },
    { 'X-CSRF-Token': session.csrf }, { 'X-Fitflow-Client': 'native-v1' },
    { 'Content-Type': 'application/json' }, { 'X-Synthetic-Trailer': 'otherwise harmless' },
  ]
  for (const declared of [false, true]) for (const trailers of candidates) {
    const response = await wire(server, { ...nativeHeaders(session), ...(declared ? { Trailer: Object.keys(trailers).join(', ') } : {}) }, trailers)
    assert.equal(response.status, 400, `${declared ? 'declared' : 'undeclared'} ${Object.keys(trailers)}`)
    assert.equal(response.body.error.code, 'invalid_request')
    assert.equal(response.headers['access-control-allow-origin'], undefined)
    assert.equal(response.headers['set-cookie'], undefined)
    noSecrets(response, [session.raw, user.raw, user.email])
  }
  assert.equal(routed, 0)
  assert.equal(f.db.prepare('SELECT consent FROM users WHERE id = ?').get(user.id).consent, 0)
  const clean = await wire(server, nativeHeaders(session))
  assert.equal(clean.status, 200)
  assert.equal(routed, 1)
  assert.equal(f.db.prepare('SELECT consent FROM users WHERE id = ?').get(user.id).consent, 1)
})

const schema = db => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
const nativeDdl = `CREATE TABLE native_sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,credential_binding TEXT NOT NULL
) STRICT`
const corruptions = [
  ['missing credential column', db => db.exec(`DROP TABLE native_sessions; ${nativeDdl.replace(',credential_binding TEXT NOT NULL', '')}`)],
  ['missing cascade', db => db.exec(`DROP TABLE native_sessions; ${nativeDdl.replace(' ON DELETE CASCADE', '')}`)],
  ['non-strict table', db => db.exec(`DROP TABLE native_sessions; ${nativeDdl.replace(' STRICT', '')}`)],
  ['unique user index', db => db.exec('DROP INDEX native_sessions_user; CREATE UNIQUE INDEX native_sessions_user ON native_sessions(user_id)')],
  ['partial user index', db => db.exec('DROP INDEX native_sessions_user; CREATE INDEX native_sessions_user ON native_sessions(user_id) WHERE expires_at > 0')],
  ['index owned by web sessions', db => db.exec('DROP INDEX native_sessions_user; CREATE INDEX native_sessions_user ON sessions(user_id)')],
]
for (const version of [5, 6]) {
  test(`schema ${version} rejects native table and index corruption without committing migration side effects`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'fitflow-independent-native-schema-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    for (const [index, [label, corrupt]] of corruptions.entries()) {
      const path = join(directory, `${index}.sqlite`), initial = openDatabase(path)
      initial.prepare('INSERT INTO users(id,email,password_hash,verified,created_at) VALUES(?,?,?,1,?)')
        .run('preserved-user', 'preserved@example.test', 'synthetic-preserved-hash', 123)
      initial.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('preserved-session-hash', 'preserved-user', 999999, 123)
      corrupt(initial)
      initial.exec(`PRAGMA user_version = ${version}`)
      const before = { schema: schema(initial), users: initial.prepare('SELECT * FROM users').all(), sessions: initial.prepare('SELECT * FROM sessions').all() }
      initial.close()
      assert.throws(() => openDatabase(path), /Native session schema is invalid/, label)
      const unchanged = new DatabaseSync(path)
      try {
        assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, version)
        assert.deepEqual(schema(unchanged), before.schema, label)
        assert.deepEqual(unchanged.prepare('SELECT * FROM users').all(), before.users, label)
        assert.deepEqual(unchanged.prepare('SELECT * FROM sessions').all(), before.sessions, label)
      } finally { unchanged.close() }
    }
  })
}
