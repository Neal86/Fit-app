import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createHttpServer } from '../http.mjs'
import { POLICY_VERSION } from '../config.mjs'
import { csrfFor, digest, token } from '../security.mjs'
import { MAX_STATE_BYTES } from '../state.mjs'
import { ORIGIN, PASSWORD, PASSWORD_HASH, setup, syncBody } from './fixtures.mjs'

const PREFIX = '/api/native/v1'
const NATIVE_HEADERS = { 'x-fitflow-client': 'native-v1', 'content-type': 'application/json' }
const BODY_LIMIT = MAX_STATE_BYTES + 1024

function fixture(t, config = {}) {
  const f = setup({ config: { nativeAccountsEnabled: true, ...config } })
  t.after(f.close)
  return f
}

function nativeSession(f, consent = true) {
  const user = f.seed(undefined, consent), raw = token()
  f.db.prepare('INSERT INTO native_sessions(token_hash,user_id,expires_at,last_seen,credential_binding) VALUES(?,?,?,?,?)')
    .run(digest(raw), user.id, f.now() + 8 * 60 * 60 * 1000, f.now(), digest(`fitflow-native-credential-v1:${PASSWORD_HASH}`))
  return { ...user, webRaw: user.raw, raw, csrf: csrfFor(raw) }
}

function nativeRequest(f, method, path, body, session, overrides = {}) {
  return f.app.handle({
    method, path: `${PREFIX}${path}`, body: body === undefined ? '' : JSON.stringify(body), ip: '127.0.0.1',
    ...overrides,
    headers: { ...NATIVE_HEADERS, ...(session ? { authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf } : {}), ...overrides.headers },
  })
}

function assertPrivateResponse(response) {
  for (const key of Object.keys(response.headers)) {
    assert.notEqual(key.toLowerCase(), 'set-cookie', 'Native responses must never set a cookie')
    assert.ok(!key.toLowerCase().startsWith('access-control-'), 'Native responses must never enable CORS')
  }
  assert.equal(response.headers['cache-control'], 'no-store')
}

function assertError(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body))
  assert.equal(response.body.error.code, code)
  assertPrivateResponse(response)
}

async function startServer(t, app) {
  const server = createHttpServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return server
}

function wireRequest(server, { method = 'GET', path = `${PREFIX}/auth/session`, headers = NATIVE_HEADERS, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    // Node treats a flat header array as complete and does not insert Host for us.
    if (Array.isArray(headers)) headers = ['Host', `127.0.0.1:${server.address().port}`, ...headers]
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, method, path, headers, agent: false }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('error', reject)
      res.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let parsed
        try { parsed = raw ? JSON.parse(raw) : undefined } catch { parsed = raw }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed })
      })
    })
    req.once('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('Synthetic loopback request timed out')))
    if (Array.isArray(body)) {
      for (const chunk of body) req.write(chunk)
      req.end()
    } else req.end(body)
  })
}

test('native accounts are disabled unless explicitly enabled with boolean true', async t => {
  for (const config of [{}, { nativeAccountsEnabled: false }, { nativeAccountsEnabled: 'true' }, { nativeAccountsEnabled: 1 }]) {
    const f = setup({ config }); t.after(f.close)
    for (const [method, path] of [['POST', '/auth/login'], ['GET', '/auth/session'], ['PUT', '/sync']]) {
      assertError(await nativeRequest(f, method, path, {}), 503, 'native_accounts_disabled')
    }
  }
})

test('native login has an exact token envelope, no cookies, and no CORS', async t => {
  const f = fixture(t), user = f.seed()
  const response = await nativeRequest(f, 'POST', '/auth/login', { email: user.email, password: PASSWORD })
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(response.body).sort(), ['nativeToken', 'session'])
  assert.deepEqual(Object.keys(response.body.session).sort(), ['csrfToken', 'sessionExpiresAt', 'user'])
  assert.deepEqual(Object.keys(response.body.session.user).sort(), ['createdAt', 'email', 'emailVerified', 'id'])
  assert.equal(response.body.session.user.id, user.id)
  assert.match(response.body.nativeToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(response.body.session.csrfToken, csrfFor(response.body.nativeToken))
  assert.equal(response.body.session.sessionExpiresAt, new Date(f.now() + 8 * 60 * 60 * 1000).toISOString())
  assertPrivateResponse(response)
  const read = await nativeRequest(f, 'GET', '/auth/session', undefined, { raw: response.body.nativeToken, csrf: response.body.session.csrfToken })
  assert.equal(read.status, 200)
  assert.equal(read.body.user.id, user.id)
  assertPrivateResponse(read)
})

test('native transport rejects presence of all browser-origin and cookie headers, including empty values', async t => {
  const f = fixture(t), session = nativeSession(f)
  const forbidden = [
    ['origin', ''], ['origin', ORIGIN], ['origin', 'null'], ['origin', 'capacitor://localhost'],
    ['cookie', ''], ['cookie', `${f.app.cookieName}=${session.webRaw}`],
    ['sec-fetch-site', ''], ['sec-fetch-site', 'none'], ['sec-fetch-site', 'same-origin'],
    ['sec-fetch-mode', ''], ['sec-fetch-mode', 'cors'], ['sec-fetch-dest', ''],
    ['sec-fetch-user', '?1'], ['sec-fetch-synthetic', ''],
  ]
  for (const [name, value] of forbidden) {
    assertError(await nativeRequest(f, 'GET', '/auth/session', undefined, session, { headers: { [name]: value } }), 403, 'native_transport_required')
  }
  const read = await nativeRequest(f, 'GET', '/auth/session', undefined, session)
  assert.equal(read.status, 200)
  assertPrivateResponse(read)
})

test('native requests require the exact native-v1 client marker on reads and writes', async t => {
  const f = fixture(t), session = nativeSession(f)
  for (const marker of ['', 'web', 'native', 'Native-v1', ' native-v1', 'native-v1 ', 'native-v1,native-v1']) {
    for (const [method, path, body] of [['GET', '/auth/session'], ['POST', '/auth/logout', {}]]) {
      assertError(await nativeRequest(f, method, path, body, session, { headers: { 'x-fitflow-client': marker } }), 403, 'native_transport_required')
    }
  }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf }
  assertError(await f.app.handle({ method: 'GET', path: `${PREFIX}/auth/session`, headers }), 403, 'native_transport_required')
})

test('native methods and paths are exact and never support preflight, HEAD, aliases, or URL secrets', async t => {
  const f = fixture(t), session = nativeSession(f)
  for (const [method, path] of [
    ['OPTIONS', '/auth/login'], ['HEAD', '/auth/session'], ['TRACE', '/sync'], ['PATCH', '/consent'],
    ['GET', '/auth/login'], ['POST', '/auth/session'], ['POST', '/sync'], ['get', '/auth/session'],
    ['GET', ''], ['GET', '/'], ['GET', '/unknown'], ['GET', '/auth/session/'],
    ['GET', '/auth/Session'], ['GET', '/auth/%73ession'], ['GET', '//auth/session'],
    ['GET', '/auth/../auth/session'], ['GET', '/sync/'], ['GET', '/sync%2f'],
  ]) assertError(await nativeRequest(f, method, path, {}, session), 404, 'not_found')
  for (const path of ['/auth/session?', '/auth/session?token=synthetic', '/auth/session#fragment', '/sync?x=1', '/sync#']) {
    assertError(await nativeRequest(f, 'GET', path, undefined, session), 400, 'invalid_request')
  }
})

test('mixed-case duplicate sensitive headers fail before normalization or JSON parsing', async t => {
  const f = fixture(t), session = nativeSession(f)
  const sensitive = {
    authorization: `Bearer ${session.raw}`, origin: '', cookie: '',
    'x-fitflow-client': 'native-v1', 'x-csrf-token': session.csrf,
    'content-type': 'application/json', 'content-length': '2', 'content-encoding': 'identity',
    'content-language': 'en', 'content-synthetic': 'value', 'sec-fetch-site': '', 'sec-fetch-synthetic': '',
  }
  for (const [name, value] of Object.entries(sensitive)) {
    const mixedCase = name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('-')
    const response = await nativeRequest(f, 'POST', '/auth/logout', undefined, session, { body: '{invalid', headers: { [name]: value, [mixedCase]: value } })
    assertError(response, 400, 'invalid_request')
  }
  assert.equal((await nativeRequest(f, 'GET', '/auth/session', undefined, session)).status, 200)
})

test('array-valued sensitive headers are rejected even when empty or singly valued', async t => {
  const f = fixture(t), session = nativeSession(f)
  const sensitive = {
    authorization: `Bearer ${session.raw}`, origin: '', cookie: '',
    'x-fitflow-client': 'native-v1', 'x-csrf-token': session.csrf,
    'content-type': 'application/json', 'content-length': '0', 'content-encoding': 'identity',
    'content-language': 'en', 'content-synthetic': 'value', 'sec-fetch-mode': '',
  }
  for (const [name, value] of Object.entries(sensitive)) {
    for (const array of [[], [value], [value, value]]) {
      assertError(await nativeRequest(f, 'GET', '/auth/session', undefined, session, { headers: { [name]: array } }), 400, 'invalid_request')
    }
  }
})

test('native JSON and content-encoding guards reject unsupported representations', async t => {
  const f = fixture(t), session = nativeSession(f)
  for (const encoding of ['gzip', 'br', 'deflate', 'identity, gzip']) {
    assertError(await nativeRequest(f, 'GET', '/auth/session', undefined, session, { headers: { 'content-encoding': encoding } }), 415, 'unsupported_encoding')
  }
  for (const contentType of ['', 'text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=latin1', 'application/json, application/json']) {
    assertError(await nativeRequest(f, 'POST', '/auth/logout', {}, session, { headers: { 'content-type': contentType } }), 415, 'unsupported_media_type')
  }
  assert.equal((await nativeRequest(f, 'GET', '/auth/session', undefined, session, { headers: { 'content-encoding': 'identity' } })).status, 200)
  assertError(await nativeRequest(f, 'POST', '/auth/logout', undefined, session, { body: '{invalid' }), 400, 'invalid_json')
})

test('native bearer grammar is one exact Bearer scheme and one 43-character base64url token', async t => {
  const f = fixture(t), session = nativeSession(f)
  const invalid = [
    '', session.raw, `bearer ${session.raw}`, `BEARER ${session.raw}`, `Basic ${session.raw}`,
    ` Bearer ${session.raw}`, `Bearer ${session.raw} `, `Bearer  ${session.raw}`, `Bearer\t${session.raw}`,
    `Bearer ${session.raw}, Bearer ${session.raw}`, `Bearer ${session.raw},${session.raw}`,
    `Bearer ${session.raw.slice(1)}`, `Bearer ${session.raw}x`, `Bearer ${session.raw.slice(0, -1)}=`,
    `Bearer ${session.raw.slice(0, -1)}+`, `Bearer ${session.raw.slice(0, -1)}/`, `Bearer ${token()}`,
  ]
  for (const authorization of invalid) {
    assertError(await nativeRequest(f, 'GET', '/auth/session', undefined, session, { headers: { authorization } }), 401, 'unauthenticated')
  }
  assertError(await nativeRequest(f, 'GET', '/auth/session', undefined, undefined, { headers: { 'x-csrf-token': session.csrf } }), 401, 'unauthenticated')
  assert.equal((await nativeRequest(f, 'GET', '/auth/session', undefined, session)).status, 200)
})

test('native protected reads and writes require a CSRF token bound to the bearer session', async t => {
  const f = fixture(t), session = nativeSession(f), other = nativeSession(f)
  const endpoints = [
    ['GET', '/auth/session'], ['GET', '/consent'], ['GET', '/sync'],
    ['PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }],
    ['PUT', '/sync', syncBody()], ['POST', '/auth/logout', {}],
    ['POST', '/account/export', { password: PASSWORD }],
    ['DELETE', '/account', { password: PASSWORD, confirmation: 'DELETE' }],
  ]
  for (const [method, path, body] of endpoints) {
    for (const csrf of ['', 'forged', other.csrf]) {
      assertError(await nativeRequest(f, method, path, body, session, { headers: { 'x-csrf-token': csrf } }), 403, 'csrf_failed')
    }
    assertError(await nativeRequest(f, method, path, body, undefined, { headers: { authorization: `Bearer ${session.raw}` } }), 403, 'csrf_failed')
  }
  assert.equal((await nativeRequest(f, 'GET', '/sync', undefined, session)).status, 200)
  assert.equal(f.db.prepare('SELECT consent,revision FROM users WHERE id = ?').get(session.id).consent, 1)
  assert.equal(f.db.prepare('SELECT revision FROM users WHERE id = ?').get(session.id).revision, 0)
})

test('native bearer tokens and web cookie sessions are separate authentication domains', async t => {
  const f = fixture(t), session = nativeSession(f)
  assertError(await nativeRequest(f, 'GET', '/auth/session', undefined, { raw: session.webRaw, csrf: csrfFor(session.webRaw) }), 401, 'unauthenticated')
  const nativeAsCookie = await f.request('GET', '/auth/session', undefined, undefined, { headers: { cookie: `${f.app.cookieName}=${session.raw}`, 'x-csrf-token': session.csrf } })
  assert.equal(nativeAsCookie.status, 401)
  assert.equal(nativeAsCookie.body.error.code, 'unauthenticated')
  const nativeAsWebBearer = await f.request('GET', '/auth/session', undefined, undefined, { headers: { authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf } })
  assert.equal(nativeAsWebBearer.status, 401)
  assert.equal((await f.request('GET', '/auth/session', undefined, { cookie: session.cookie, csrf: csrfFor(session.webRaw) })).status, 200)
  assert.equal((await nativeRequest(f, 'GET', '/auth/session', undefined, session)).status, 200)
})

test('native coaching and challenge paths retain the independent disabled feature gates', async t => {
  const f = fixture(t), session = nativeSession(f)
  const id = '00000000-0000-4000-8000-000000000001'
  for (const [feature, code] of [['coaching', 'coaching_disabled'], ['challenges', 'challenges_disabled']]) {
    for (const [method, suffix] of [['GET', ''], ['POST', '/invitations'], ['POST', `/invitations/${id}/accept`]]) {
      assertError(await nativeRequest(f, method, `/${feature}${suffix}`, {}, session), 503, code)
    }
  }
})

test('enabling native accounts preserves the existing web cookie, origin, CSRF, and preflight policies', async t => {
  for (const nativeAccountsEnabled of [false, true]) {
    const f = fixture(t, { nativeAccountsEnabled }), user = f.seed(undefined, true)
    const session = await f.request('GET', '/auth/session', undefined, user, { headers: { origin: '', 'x-csrf-token': '' } })
    assert.equal(session.status, 200)
    assert.equal(session.body.user.id, user.id)
    const blocked = await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, user, { headers: { origin: '' } })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.error.code, 'origin_forbidden')
    assert.equal((await f.request('GET', '/sync', undefined, user, { headers: { 'x-csrf-token': '' } })).status, 403)
    const preflight = await f.request('OPTIONS', '/auth/login', undefined, undefined, { headers: { 'access-control-request-method': 'POST' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN)
    assert.equal(preflight.headers['access-control-allow-credentials'], 'true')
    const login = await f.request('POST', '/auth/login', { email: user.email, password: PASSWORD })
    assert.equal(login.status, 200)
    assert.deepEqual(Object.keys(login.body).sort(), ['csrfToken', 'sessionExpiresAt', 'user'])
    assert.match(login.headers['set-cookie'], /^__Host-fitflow_session=/)
    assert.equal(login.headers['access-control-allow-origin'], ORIGIN)
  }
})

test('only exact web and native PUT sync endpoints accept the full state-plus-envelope body budget', async t => {
  const f = fixture(t), session = nativeSession(f)
  for (const path of ['/api/v1/sync', `${PREFIX}/sync`]) {
    const native = path.startsWith(PREFIX)
    const headers = native
      ? { ...NATIVE_HEADERS, authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf }
      : { origin: ORIGIN, 'content-type': 'application/json', 'x-fitflow-client': 'web', cookie: session.cookie, 'x-csrf-token': csrfFor(session.webRaw) }
    const revision = f.db.prepare('SELECT revision FROM users WHERE id = ?').get(session.id).revision
    const body = JSON.stringify(syncBody(undefined, revision)).padEnd(BODY_LIMIT, ' ')
    assert.equal(Buffer.byteLength(body), BODY_LIMIT)
    const accepted = await f.app.handle({ method: 'PUT', path, headers, body })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    const tooLarge = await f.app.handle({ method: 'PUT', path, headers, body: `${body} ` })
    assert.equal(tooLarge.status, 413)
    assert.equal(tooLarge.body.error.code, 'body_too_large')
    for (const alias of [`${path}/`, `${path}?x=1`, `${path}#fragment`, path.replace('/sync', '//sync'), path.replace('/sync', '/%73ync')]) {
      const rejected = await f.app.handle({ method: 'PUT', path: alias, headers, body })
      assert.ok([400, 404, 413].includes(rejected.status), `${alias}: ${JSON.stringify(rejected.body)}`)
    }
    assert.equal(f.db.prepare('SELECT revision FROM users WHERE id = ?').get(session.id).revision, revision + 1)
  }
  const oversizedLogin = await nativeRequest(f, 'POST', '/auth/login', undefined, undefined, { body: '{}'.padEnd(8193, ' ') })
  assertError(oversizedLogin, 413, 'body_too_large')
})

test('loopback HTTP rejects duplicate raw sensitive headers before lossy Node header normalization', async t => {
  const f = fixture(t), session = nativeSession(f), server = await startServer(t, f.app)
  const sensitive = {
    authorization: `Bearer ${session.raw}`, origin: '', cookie: '',
    'x-fitflow-client': 'native-v1', 'x-csrf-token': session.csrf,
    'content-type': 'application/json', 'content-encoding': 'identity',
    'content-language': 'en', 'content-synthetic': 'value', 'sec-fetch-site': '',
  }
  for (const [name, value] of Object.entries(sensitive)) {
    const headers = { ...NATIVE_HEADERS, authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf }
    delete headers[name]
    const rawHeaders = Object.entries(headers).flat()
    rawHeaders.push(name, value, name.toUpperCase(), value)
    assertError(await wireRequest(server, { headers: rawHeaders }), 400, 'invalid_request')
  }
  // Node itself may reject duplicate Content-Length framing before app.handle is called.
  const length = await wireRequest(server, { method: 'POST', path: `${PREFIX}/auth/logout`, headers: [...Object.entries(NATIVE_HEADERS).flat(), 'Content-Length', '2', 'content-length', '2'], body: '{}' })
  assert.equal(length.status, 400)
  const valid = await wireRequest(server, { headers: { ...NATIVE_HEADERS, authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf } })
  assert.equal(valid.status, 200)
  assertPrivateResponse(valid)
})

test('loopback HTTP enforces native browser exclusion, encodings, and strict UTF-8', async t => {
  const f = fixture(t), session = nativeSession(f), server = await startServer(t, f.app)
  const headers = { ...NATIVE_HEADERS, authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf }
  for (const extra of [{ Origin: '' }, { Cookie: '' }, { 'Sec-Fetch-Mode': '' }, { 'Sec-Fetch-Synthetic': '' }]) {
    assertError(await wireRequest(server, { headers: { ...headers, ...extra } }), 403, 'native_transport_required')
  }
  assertError(await wireRequest(server, { headers: { ...headers, 'Content-Encoding': 'gzip' } }), 415, 'unsupported_encoding')
  assertError(await wireRequest(server, { method: 'POST', path: `${PREFIX}/auth/logout`, headers, body: Buffer.from([0xff, 0xfe]) }), 400, 'invalid_request')
})

test('HTTP fixed and streaming body budgets apply only to the two exact PUT sync request targets', async t => {
  const reached = []
  const server = await startServer(t, { handle: async request => {
    reached.push({ method: request.method, path: request.path, bytes: Buffer.byteLength(request.body) })
    return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { status: 'synthetic' } }
  } })
  for (const path of ['/api/v1/sync', `${PREFIX}/sync`]) {
    const atLimit = '{}'.padEnd(BODY_LIMIT, ' ')
    const fixed = await wireRequest(server, { method: 'PUT', path, headers: { ...NATIVE_HEADERS, 'content-length': String(BODY_LIMIT) }, body: atLimit })
    assert.equal(fixed.status, 200)
    assert.deepEqual(reached.at(-1), { method: 'PUT', path, bytes: BODY_LIMIT })
    const streamed = await wireRequest(server, { method: 'PUT', path, body: [atLimit.slice(0, 8192), atLimit.slice(8192)] })
    assert.equal(streamed.status, 200)
    assert.equal(reached.at(-1).bytes, BODY_LIMIT)
    const previous = reached.length
    for (const headers of [NATIVE_HEADERS, { ...NATIVE_HEADERS, 'content-length': String(BODY_LIMIT + 1) }]) {
      const response = await wireRequest(server, { method: 'PUT', path, headers, body: [atLimit, ' '] })
      assert.equal(response.status, 413)
      assert.equal(response.body.error.code, 'body_too_large')
    }
    for (const alias of [`${path}/`, `${path}?x=1`, `${path}#fragment`, path.replace('/sync', '//sync'), path.replace('/sync', '/%73ync'), path.replace('/sync', '/auth/../sync')]) {
      const response = await wireRequest(server, { method: 'PUT', path: alias, body: ['{}'.padEnd(8192, ' '), ' '] })
      assert.equal(response.status, 413, alias)
      assert.equal(response.body.error.code, 'body_too_large')
    }
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      assert.equal((await wireRequest(server, { method, path, headers: { ...NATIVE_HEADERS, 'content-length': '8193' }, body: '{}'.padEnd(8193, ' ') })).status, 413)
    }
    assert.equal(reached.length, previous, 'Rejected bodies must never be handed to the application')
  }
})

test('HTTP rejects declared and undeclared request trailers before account mutations', async t => {
  const f = fixture(t), session = nativeSession(f), server = await startServer(t, f.app)
  const payload = JSON.stringify({ healthSync: false, policyVersion: POLICY_VERSION })
  for (const name of ['Cookie', 'Origin', 'Sec-Fetch-Site', 'Authorization', 'X-CSRF-Token', 'X-Fitflow-Client', 'Content-Type', 'X-Synthetic']) {
    for (const declared of [false, true]) {
      const response = await new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: server.address().port, method: 'PUT', path: `${PREFIX}/consent`, agent: false,
          headers: { ...NATIVE_HEADERS, authorization: `Bearer ${session.raw}`, 'x-csrf-token': session.csrf, 'transfer-encoding': 'chunked', ...(declared ? { Trailer: name } : {}) },
        }, res => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
          res.once('error', reject)
        })
        req.once('error', reject)
        req.write(payload)
        req.addTrailers({ [name]: 'synthetic-value' })
        req.end()
      })
      assertError(response, 400, 'invalid_request')
      assert.equal(f.db.prepare('SELECT consent FROM users WHERE id = ?').get(session.id).consent, 1)
    }
  }
  assertError(await nativeRequest(f, 'PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, session, { headers: { trailer: '' } }), 400, 'invalid_request')
})
