import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_ACCOUNT_LIMITS, NativeAccountContractError, nativeAccountEndpoint,
  readNativeAccountCapabilities, readNativeAccountCapabilitiesQuery, readNativeAccountContext,
  readNativeAccountContextReply, readNativeAccountReply, readNativeAccountRequest, readNativeAccountSession,
  type NativeAccountMethod, type NativeAccountRequest,
} from './nativeAccountContract'

const contextId = '4f789fcc-a192-42bf-8c12-b75575810302'
const requestId = '5f789fcc-a192-42bf-8c12-b75575810302'
const otherId = '6f789fcc-a192-42bf-8c12-b75575810302'
const now = Date.parse('2026-10-16T00:00:00.000Z')
const endpoint = 'https://fit.example.test/api/native/v1'
const context = () => ({ version: 1, contextId })
const command = (path = 'auth/session', method: NativeAccountMethod = 'GET', body: unknown = {}) => ({ ...context(), requestId, method, path, ...(method === 'GET' ? {} : { body }) })
const session = () => ({ user: { id: 'user-a', email: 'user-a@example.test', emailVerified: true, createdAt: '2026-10-15T00:00:00.000Z' }, csrfToken: 'synthetic-csrf-context', sessionExpiresAt: '2026-10-16T08:00:00.000Z' })
const reply = (body: unknown = session(), status = 200) => ({ ...context(), requestId, status, ...(body === undefined ? {} : { body }) })
const reviewed = () => readNativeAccountRequest(command())
const rejected = (read: () => unknown) => expect(read).toThrow(NativeAccountContractError)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

// Mirrors actual CloudClient/CoachingClient/PrivateChallengeClient logical operations.
const routes: [NativeAccountMethod, string, number][] = [
  ['POST', 'auth/login', 200], ['GET', 'auth/session', 200], ['POST', 'auth/register', 202], ['POST', 'auth/logout', 204],
  ['POST', 'auth/verification/request', 202], ['POST', 'auth/verification/confirm', 200],
  ['POST', 'auth/password-reset/request', 202], ['POST', 'auth/password-reset/confirm', 200],
  ['GET', 'consent', 200], ['PUT', 'consent', 200], ['GET', 'sync', 200], ['PUT', 'sync', 200],
  ['POST', 'account/export', 200], ['DELETE', 'account', 204],
  ['GET', 'coaching', 200], ['POST', 'coaching/invitations', 202], ['POST', 'coaching/invitations/cancel', 202],
  ['POST', 'coaching/invitations/7f789fcc-a192-42bf-8c12-b75575810302/accept', 200], ['DELETE', 'coaching/invitations/7f789fcc-a192-42bf-8c12-b75575810302', 204],
  ['PUT', 'coaching/relationships/8f789fcc-a192-42bf-8c12-b75575810302/consent', 200], ['DELETE', 'coaching/relationships/8f789fcc-a192-42bf-8c12-b75575810302', 200],
  ['GET', 'coaching/relationships/8f789fcc-a192-42bf-8c12-b75575810302/snapshot', 200], ['GET', 'coaching/relationships/8f789fcc-a192-42bf-8c12-b75575810302/feedback', 200],
  ['POST', 'coaching/relationships/8f789fcc-a192-42bf-8c12-b75575810302/feedback', 201], ['DELETE', 'coaching/relationships/8f789fcc-a192-42bf-8c12-b75575810302/feedback/9f789fcc-a192-42bf-8c12-b75575810302', 204],
  ['GET', 'challenges', 200], ['POST', 'challenges/invitations', 202],
  ['POST', 'challenges/invitations/7f789fcc-a192-42bf-8c12-b75575810302/accept', 200], ['DELETE', 'challenges/invitations/7f789fcc-a192-42bf-8c12-b75575810302', 204],
  ['PUT', 'challenges/af789fcc-a192-42bf-8c12-b75575810302/consent', 200], ['DELETE', 'challenges/af789fcc-a192-42bf-8c12-b75575810302/consent', 200],
  ['DELETE', 'challenges/af789fcc-a192-42bf-8c12-b75575810302', 200], ['POST', 'challenges/af789fcc-a192-42bf-8c12-b75575810302/block', 204], ['GET', 'challenges/af789fcc-a192-42bf-8c12-b75575810302/counts', 200],
]

describe('packaged endpoint binding', () => {
  it('accepts only the exact canonical HTTPS native prefix matching trusted packaging', () => {
    expect(nativeAccountEndpoint(endpoint, endpoint)).toBe(endpoint)
    const port = 'https://fit.example.test:8443/api/native/v1'
    expect(nativeAccountEndpoint(port, port)).toBe(port)
    expect(nativeAccountEndpoint(endpoint, 'https://other.example.test/api/native/v1')).toBeNull()
    expect(nativeAccountEndpoint(undefined, endpoint)).toBeNull()
    expect(nativeAccountEndpoint(endpoint, undefined)).toBeNull()
  })
  it.each([
    '', '/api/native/v1', '//fit.example.test/api/native/v1', 'http://fit.example.test/api/native/v1',
    'http://localhost:3001/api/native/v1', 'http://127.0.0.1/api/native/v1', 'http://[::1]/api/native/v1',
    'https://user:secret@fit.example.test/api/native/v1', 'https://user@fit.example.test/api/native/v1',
    `${endpoint}?token=synthetic`, `${endpoint}?`, `${endpoint}#fragment`, `${endpoint}#`, `${endpoint}/`,
    `${endpoint}/auth/login`, `${endpoint}/../v1`, 'https://fit.example.test/./api/native/v1',
    'https://fit.example.test/api/%6eative/v1', 'https://fit.example.test/api/%2e%2e/api/native/v1',
    'https://fit.example.test/api/%252e%252e/api/native/v1', 'https://fit.example.test/api/native%2fv1',
    String.raw`https:\fit.example.test\api\native\v1`, 'https://FIT.example.test/api/native/v1',
    'https://fit.example.test:443/api/native/v1', ` ${endpoint}`, `${endpoint}\n`,
    'https://fit.example.test/api/v1', 'https://fit.example.test/api/native/v2',
    'data:text/plain,synthetic', 'javascript:alert(1)',
  ])('rejects unsafe or normalized configuration %s', value => {
    expect(nativeAccountEndpoint(value, value)).toBeNull()
  })
})

describe('local-only capability and context shapes', () => {
  it('returns detached frozen local inputs and capabilities without enabling a runtime', () => {
    const input = { version: 1, available: true }
    const result = readNativeAccountCapabilities(input)
    input.available = false
    expect(result).toEqual({ version: 1, available: true })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(readNativeAccountCapabilitiesQuery({ version: 1 }))).toBe(true)
    expect(Object.isFrozen(readNativeAccountContext(context()))).toBe(true)
    expect(readNativeAccountContextReply(context(), readNativeAccountContext(context()))).toEqual(context())
    rejected(() => readNativeAccountContextReply({ ...context(), contextId: otherId }, readNativeAccountContext(context())))
  })
  it.each([{}, { version: 2 }, { version: 1, endpoint }, { version: 1, available: true }])('rejects extra/missing capability query fields %#', value => rejected(() => readNativeAccountCapabilitiesQuery(value)))
  it.each([{}, { version: 1, available: 'true' }, { version: 1, available: true, endpoint }, { version: 2, available: true }])('rejects malformed capabilities %#', value => rejected(() => readNativeAccountCapabilities(value)))
  it.each(['', 'user-a', contextId.toUpperCase(), `${contextId}\n`, '00000000-0000-0000-0000-000000000000', '4f789fcc-a192-42bf-7c12-b75575810302'])('rejects noncanonical context/request IDs %s', id => {
    rejected(() => readNativeAccountContext({ version: 1, contextId: id }))
    rejected(() => readNativeAccountRequest({ ...command(), requestId: id }))
    rejected(() => readNativeAccountRequest({ ...command(), contextId: id }))
  })
  it('rejects context overrides and unknown fields', () => {
    for (const extra of [{ endpoint }, { headers: {} }, { nativeToken: 'synthetic' }, { requestId }, { reason: 'logout' }]) rejected(() => readNativeAccountContext({ ...context(), ...extra }))
  })
})

describe('positive method and relative route allowlist', () => {
  it.each(routes)('accepts %s %s with success %s', (method, path, status) => {
    const input = command(path, method)
    const request = readNativeAccountRequest(input)
    expect(request).toEqual(input)
    expect(Object.isFrozen(request)).toBe(true)
    const body = path === 'auth/login' || path === 'auth/session' ? session() : {}
    expect(readNativeAccountReply({ ...context(), requestId, status, ...(status === 204 ? {} : { body }) }, request, now).status).toBe(status)
    rejected(() => readNativeAccountReply(reply(body, 203), request, now))
  })
  it.each(routes)('rejects scalar/array bodies for supported %s %s success %s', (method, path, status) => {
    const request = readNativeAccountRequest(command(path, method))
    for (const body of ['raw-synthetic-token', '', 42, true, false, null, [], ['raw-synthetic-token'], [{ nativeToken: 'raw-synthetic-token' }]]) rejected(() => readNativeAccountReply(reply(body, status), request, now))
    if (path.endsWith('/feedback') && method === 'POST') {
      for (const body of ['raw-synthetic-token', [], null]) rejected(() => readNativeAccountReply(reply(body, 200), request, now))
    }
  })
  it('permits feedback creation and replay statuses without retrying or approving domain replay semantics', () => {
    const request = readNativeAccountRequest(command('coaching/relationships/8f789fcc-a192-42bf-8c12-b75575810302/feedback', 'POST'))
    for (const status of [200, 201]) expect(readNativeAccountReply(reply({ replayed: status === 200 }, status), request, now).status).toBe(status)
  })
  it.each(['6', '7', '8', '0'])('rejects unsupported UUID version %s at all identity boundaries', version => {
    const id = `4f789fcc-a192-${version}2bf-8c12-b75575810302`
    rejected(() => readNativeAccountContext({ ...context(), contextId: id }))
    rejected(() => readNativeAccountRequest({ ...command(), requestId: id }))
    rejected(() => readNativeAccountRequest(command(`challenges/${id}/counts`)))
  })
  it.each([
    '', '/auth/session', '//evil.example.test/auth/session', 'https://evil.example.test/auth/session',
    'https://fit.example.test/api/native/v1/auth/session', '../auth/session', './auth/session',
    'auth/../auth/session', 'auth/./session', 'auth//session', 'auth/session/', 'auth/session?x=1',
    'auth/session#x', 'auth/session?', 'auth/session#', 'auth/session\n', 'auth/session\0',
    'auth\\session', 'AUTH/session', 'auth/%73ession', 'auth/%2e%2e/session', 'auth/%252e%252e/session',
    'auth/session;foo', 'auth/refresh', 'admin', 'account/other', 'sync/all',
    'coaching/relationships/_invalid/snapshot', 'coaching/relationships/a.b/snapshot',
    'coaching/relationships/a/b/snapshot', `coaching/relationships/${'a'.repeat(129)}/snapshot`,
    'coaching/relationships/a', 'coaching/invitations', 'challenges/a', 'challenges/a/snapshot',
  ])('rejects unsupported GET path %s', path => rejected(() => readNativeAccountRequest(command(path))))
  it.each(['PATCH', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'get', '', null])('rejects method %s', method => rejected(() => readNativeAccountRequest({ ...command(), method })))
  it('rejects unlisted method/path pairs without broadening dynamic ID routes', () => {
    for (const [method, path] of [['POST', 'sync'], ['PUT', 'auth/login'], ['DELETE', 'auth/session'], ['POST', 'coaching'], ['GET', 'account/export'], ['PUT', 'challenges'], ['DELETE', 'challenges/a/counts'], ['POST', 'coaching/relationships/a/snapshot']]) rejected(() => readNativeAccountRequest({ ...command(), method, path, body: {} }))
  })
  it.each(['headers', 'url', 'endpoint', 'origin', 'recipient', 'csrfToken', 'nativeToken', 'cookies', 'credentials', 'timeout', 'responseLimit', 'expectedStatus', 'signal'])('rejects caller transport override %s', key => rejected(() => readNativeAccountRequest({ ...command(), [key]: 'synthetic' })))
  it('requires exact command fields and one object body for writes, no GET body', () => {
    for (const key of ['version', 'contextId', 'requestId', 'method', 'path']) {
      const input: Record<string, unknown> = command()
      delete input[key]
      rejected(() => readNativeAccountRequest(input))
    }
    rejected(() => readNativeAccountRequest({ ...command(), version: 2 }))
    rejected(() => readNativeAccountRequest({ ...command(), body: {} }))
    for (const body of [undefined, null, [], 1, 'json']) rejected(() => readNativeAccountRequest({ ...command('auth/login', 'POST'), body }))
    rejected(() => readNativeAccountRequest({ ...context(), requestId, method: 'POST', path: 'auth/login' }))
  })
})

describe('bounded immutable JSON review', () => {
  it('retains business data exactly, without secret-looking string scans or recipient rewrites', () => {
    const body = { recipient: { id: 'peer', email: 'peer@example.test' }, state: { arbitrary: { nativeToken: 'a user-entered field, not transport metadata' }, notes: ['Bearer is my dog; Cookie is my cat', 'https://example.test/notes', 'Authorization: this is note text'] } }
    const input = command('sync', 'PUT', body)
    const result = readNativeAccountRequest(input)
    expect(result).toEqual(input)
    body.recipient.email = 'changed@example.test'; body.state.notes.push('changed')
    expect(result.body).not.toEqual(body)
    expect(Object.isFrozen(result.body)).toBe(true)
    const reviewBody = result.body as { recipient: object; state: { notes: readonly string[] } }
    expect(Object.isFrozen(reviewBody.recipient)).toBe(true)
    expect(Object.isFrozen(reviewBody.state.notes)).toBe(true)
    const response = readNativeAccountReply(reply(result.body), readNativeAccountRequest(command('sync')), now)
    expect(response.body).toEqual(result.body)
    expect(response.body).not.toBe(result.body)
  })
  it('preserves JSON prototype-named data without changing any prototype', () => {
    const body = JSON.parse('{"__proto__":{"polluted":true},"constructor":"user field"}')
    const result = readNativeAccountRequest(command('sync', 'PUT', body))
    expect(Object.hasOwn(result.body as object, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result.body)).toBe(Object.prototype)
    expect({}).not.toHaveProperty('polluted')
  })
  it('rejects non-JSON data atomically without calling getters or toJSON', () => {
    const getter = vi.fn(() => 'synthetic-secret')
    const toJSON = vi.fn(() => ({}))
    const accessor = Object.defineProperty({}, 'password', { get: getter, enumerable: true })
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const sparse = new Array(2)
    const extraArray = Object.assign([1], { secret: 'synthetic' })
    const hidden = Object.defineProperty({}, 'hidden', { value: 'synthetic' })
    for (const data of [undefined, NaN, Infinity, -Infinity, -0, BigInt(1), Symbol('synthetic'), () => null, new Date(), new Map(), new Set(), new Uint8Array([1]), accessor, { toJSON }, cyclic, sparse, extraArray, hidden, { [Symbol('synthetic')]: 1 }]) {
      rejected(() => readNativeAccountRequest(command('sync', 'PUT', { data })))
    }
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled()
  })
  it('bounds nesting and total UTF-8 JSON bytes, including JSON escaping', () => {
    let nested: unknown = null
    for (let depth = 0; depth <= NATIVE_ACCOUNT_LIMITS.depth; depth++) nested = { nested }
    rejected(() => readNativeAccountRequest(command('sync', 'PUT', { nested })))
    const overhead = JSON.stringify({ text: '' }).length
    const exact = { text: 'x'.repeat(NATIVE_ACCOUNT_LIMITS.requestBytes - overhead) }
    expect(readNativeAccountRequest(command('auth/login', 'POST', exact)).body).toEqual(exact)
    rejected(() => readNativeAccountRequest(command('auth/login', 'POST', { text: `${exact.text}x` })))
    rejected(() => readNativeAccountRequest(command('auth/login', 'POST', { text: '🧪'.repeat(20_000) })))
    rejected(() => readNativeAccountRequest(command('auth/login', 'POST', { text: '\0'.repeat(12_000) })))
    rejected(() => readNativeAccountRequest(command('sync', 'PUT', { text: 'x'.repeat(NATIVE_ACCOUNT_LIMITS.snapshotBytes) })))
  })
  it('bounds the total expanded node count even for compact shared input graphs', () => {
    const leaf = Array.from({ length: 1000 }, () => 0)
    const data = Array.from({ length: NATIVE_ACCOUNT_LIMITS.nodes / 1000 }, () => leaf)
    const input = command('sync', 'PUT', { data })
    rejected(() => readNativeAccountRequest(input))
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(data)).toBe(false)
    expect(Object.isFrozen(leaf)).toBe(false)
    expect(data[0]).toBe(leaf)
  })
  it('applies fixed route-specific reply limits and never caller-provided limits', () => {
    const large = { text: 'x'.repeat(NATIVE_ACCOUNT_LIMITS.challengeResponseBytes) }
    rejected(() => readNativeAccountReply(reply(large), readNativeAccountRequest(command('challenges')), now))
    expect(readNativeAccountReply(reply(large), readNativeAccountRequest(command('sync')), now).body).toEqual(large)
    const exportBody = { text: 'x'.repeat(NATIVE_ACCOUNT_LIMITS.responseBytes) }
    rejected(() => readNativeAccountReply(reply(exportBody), readNativeAccountRequest(command('sync')), now))
    expect(readNativeAccountReply(reply(exportBody), readNativeAccountRequest(command('account/export', 'POST')), now).body).toEqual(exportBody)
  })
})

describe('correlated bounded replies and safe errors', () => {
  it.each([
    { version: 2 }, { contextId: otherId }, { requestId: otherId }, { status: 0 }, { status: 99 }, { status: 100 },
    { status: 199 }, { status: 201 }, { status: 204 }, { status: 299 }, { status: 300 }, { status: 302 }, { status: 399 },
    { status: 600 }, { status: 200.5 }, { status: NaN }, { status: '200' }, { headers: {} }, { cookies: [] },
    { nativeToken: 'synthetic-secret' }, { url: endpoint }, { message: 'synthetic-secret' },
  ])('rejects wrong envelope/correlation/status %#', changes => rejected(() => readNativeAccountReply({ ...reply(), ...changes }, reviewed(), now)))
  it('requires complete envelopes and revalidates the expected command', () => {
    for (const key of ['version', 'contextId', 'requestId', 'status', 'body']) {
      const input: Record<string, unknown> = reply()
      delete input[key]
      rejected(() => readNativeAccountReply(input, reviewed(), now))
    }
    rejected(() => readNativeAccountReply(reply(), { ...reviewed(), path: '../auth/session' }, now))
    rejected(() => readNativeAccountReply(reply(), { ...reviewed(), contextId: 'invalid' }, now))
  })
  it('allows empty 204 and errors, disallows any 204 body', () => {
    const logout = readNativeAccountRequest(command('auth/logout', 'POST'))
    expect(readNativeAccountReply({ ...context(), requestId, status: 204 }, logout, now).status).toBe(204)
    for (const body of [null, {}, '']) rejected(() => readNativeAccountReply(reply(body, 204), logout, now))
    for (const status of [400, 401, 403, 409, 413, 415, 422, 429, 500, 503, 599]) expect(readNativeAccountReply({ ...context(), requestId, status }, reviewed(), now).status).toBe(status)
  })
  it('allows only fixed error codes and conflict revisions, never upstream error messages', () => {
    for (const [status, error] of [[503, { code: 'service_error' }], [403, { code: 'csrf_failed' }], [409, { code: 'sync_conflict', details: { revision: 3 } }]] as const) expect(readNativeAccountReply(reply({ error }, status), reviewed(), now).body).toEqual({ error })
    for (const error of [{ code: 'synthetic-secret' }, { code: 'service_error', message: 'synthetic-secret' }, { code: 'service_error', nativeToken: 'synthetic-secret' }, { code: 'service_error', details: { revision: 1 } }, { code: 'sync_conflict', details: { revision: -1 } }, { code: 'sync_conflict', details: { revision: 1, token: 'synthetic-secret' } }]) rejected(() => readNativeAccountReply(reply({ error }, 409), reviewed(), now))
    rejected(() => readNativeAccountReply(reply({ error: { code: 'csrf_failed' } }, 500), reviewed(), now))
    rejected(() => readNativeAccountReply(reply({ error: { code: 'sync_conflict' } }, 403), reviewed(), now))
    rejected(() => readNativeAccountReply(reply({ error: { code: 'service_error' }, nativeToken: 'synthetic-secret' }, 500), reviewed(), now))
  })
  it.each(['auth/login', 'auth/session', 'consent', 'sync', 'coaching', 'challenges', 'account/export'])('rejects top-level credential envelopes on every route family: %s', path => {
    const request = readNativeAccountRequest(command(path, path === 'auth/login' || path === 'account/export' ? 'POST' : 'GET'))
    const bodies = [
      { session: session(), nativeToken: 'raw-synthetic-token' }, { NativeToken: 'raw-synthetic-token' },
      { accessToken: 'raw-synthetic-token' }, { refreshToken: 'raw-synthetic-token' }, { token: 'raw-synthetic-token' },
      { bearer: 'raw-synthetic-token' }, { Authorization: 'Bearer raw-synthetic-token' },
      { headers: { authorization: 'Bearer raw-synthetic-token' } }, { 'Set-Cookie': 'synthetic-cookie' },
      { cookies: ['synthetic-cookie'] }, { cookie: 'synthetic-cookie' },
      { credential: 'raw-synthetic-token' }, { credentials: { token: 'raw-synthetic-token' } }, { password: 'synthetic-password' },
    ]
    for (const body of bodies) rejected(() => readNativeAccountReply(reply(body), request, now))
  })
  it('throws only a static rejection message for malformed inputs', () => {
    try { readNativeAccountReply(reply({ session: session(), nativeToken: 'never-echo-this-synthetic-secret' }), reviewed(), now); throw new Error('Expected rejection') } catch (error) {
      expect(error).toBeInstanceOf(NativeAccountContractError)
      expect(String(error)).toBe('NativeAccountContractError: Native account protocol data was rejected.')
      expect(String(error)).not.toContain('never-echo')
    }
  })
})

describe('positive sanitized login/session response shape', () => {
  it('returns only an exact frozen CloudSession-compatible value', () => {
    const input = session()
    const result = readNativeAccountSession(input, now)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.user)).toBe(true)
    input.user.email = 'changed@example.test'
    expect(result.user.email).toBe('user-a@example.test')
  })
  it.each(['auth/login', 'auth/session'])('rejects raw native login envelopes and added secrets on %s', path => {
    const request = readNativeAccountRequest(command(path, path === 'auth/login' ? 'POST' : 'GET'))
    const bodies = [
      { session: session(), nativeToken: 'raw-synthetic-token' },
      { ...session(), nativeToken: 'raw-synthetic-token' }, { ...session(), token: 'raw-synthetic-token' },
      { ...session(), headers: { authorization: 'Bearer raw-synthetic-token' } }, { ...session(), cookies: [] },
      { ...session(), user: { ...session().user, nativeToken: 'raw-synthetic-token' } },
      { ...session(), user: { ...session().user, password: 'raw-synthetic-password' } },
    ]
    for (const body of bodies) {
      rejected(() => readNativeAccountSession(body, now))
      rejected(() => readNativeAccountReply(reply(body), request, now))
    }
  })
  it('rejects missing/malformed session fields and invalid or overlong lifetime', () => {
    for (const key of ['user', 'csrfToken', 'sessionExpiresAt']) {
      const input: Record<string, unknown> = session(); delete input[key]
      rejected(() => readNativeAccountSession(input, now))
    }
    for (const user of [null, {}, { ...session().user, email: 'invalid' }, { ...session().user, emailVerified: 1 }, { ...session().user, id: '' }, { ...session().user, createdAt: '2026-02-30T00:00:00.000Z' }]) rejected(() => readNativeAccountSession({ ...session(), user }, now))
    for (const csrfToken of ['', null, 'a'.repeat(513), 'synthetic\nsecret']) rejected(() => readNativeAccountSession({ ...session(), csrfToken }, now))
    for (const sessionExpiresAt of ['invalid', '2026-10-16T00:00:00.000Z', '2026-10-15T23:59:59.999Z', '2026-10-16T08:00:00.001Z', '2026-10-16T08:00:00Z', '2026-10-16T08:00:00.000+00:00']) rejected(() => readNativeAccountSession({ ...session(), sessionExpiresAt }, now))
    for (const clock of [NaN, Infinity, now + 0.5]) rejected(() => readNativeAccountSession(session(), clock))
  })
})

describe('no runtime side effects', () => {
  it('imports and validates without network, plugin registration or storage access', async () => {
    const fetcher = vi.fn(() => { throw new Error('Network forbidden') })
    const storageAccess = vi.fn(() => { throw new Error('Storage forbidden') })
    const pluginAccess = vi.fn(() => { throw new Error('Plugin access forbidden') })
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('XMLHttpRequest', fetcher)
    vi.stubGlobal('WebSocket', fetcher)
    vi.stubGlobal('localStorage', { getItem: storageAccess, setItem: storageAccess, removeItem: storageAccess })
    vi.stubGlobal('sessionStorage', { getItem: storageAccess, setItem: storageAccess, removeItem: storageAccess })
    vi.stubGlobal('Capacitor', { registerPlugin: pluginAccess, Plugins: {} })
    vi.resetModules()
    const contract = await import('./nativeAccountContract')
    const request: NativeAccountRequest = contract.readNativeAccountRequest(command())
    contract.nativeAccountEndpoint(endpoint, endpoint)
    contract.readNativeAccountCapabilities({ version: 1, available: true })
    contract.readNativeAccountContext(context())
    contract.readNativeAccountReply(reply(), request, now)
    expect(fetcher).not.toHaveBeenCalled(); expect(storageAccess).not.toHaveBeenCalled(); expect(pluginAccess).not.toHaveBeenCalled()
  })
})
