import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNativeAccountChannel, NATIVE_ACCOUNT_CHANNEL_LIMITS, NativeAccountChannelError,
  type NativeAccountAndroidChannel, type NativeAccountChannel, type NativeAccountChannelWindow,
  type NativeAccountChannelErrorCode,
} from './nativeAccountChannel'
import { NATIVE_ACCOUNT_LIMITS, type NativeAccountContext, type NativeAccountMethod, type NativeAccountRequest } from './nativeAccountContract'

const now = Date.parse('2026-10-16T00:00:00.000Z')
const id = (number: number) => `${number.toString(16).padStart(8, '0')}-a192-42bf-8c12-b75575810302`
const context = (number = 100): NativeAccountContext => ({ version: 1, contextId: id(number) })
const command = (number = 200, path = 'sync', method: NativeAccountMethod = 'GET', body: unknown = {}, ctx = context()): NativeAccountRequest => ({ ...ctx, requestId: id(number), path, method, ...(method === 'GET' ? {} : { body }) }) as NativeAccountRequest
const session = () => ({ user: { id: 'user-a', email: 'user-a@example.test', emailVerified: true, createdAt: '2026-10-15T00:00:00.000Z' }, csrfToken: 'synthetic-csrf', sessionExpiresAt: '2026-10-16T08:00:00.000Z' })
const ports: NativeAccountChannel[] = []
type Kind = 'android' | 'ios'
type Wire = { version: number; callId: string; operation: string; payload: Record<string, unknown> }
type Call = { wire: Wire; raw: string; deliver(raw: unknown): void; reject(error?: unknown): void }
function harness(kind: Kind, clock: () => number = () => now) {
  const calls: Call[] = []
  let sync: ((wire: Wire) => unknown) | undefined
  const android: NativeAccountAndroidChannel = {
    onmessage: null,
    postMessage(raw) {
      const wire: Wire = JSON.parse(raw)
      const handler = android.onmessage
      const call: Call = { raw, wire, deliver: data => handler?.({ data }), reject: () => undefined }
      calls.push(call)
      if (sync) call.deliver(sync(wire))
    },
  }
  const ios = {
    postMessage(raw: string): Promise<string> {
      const wire: Wire = JSON.parse(raw)
      return new Promise<string>((resolve, reject) => {
        const call: Call = { raw, wire, deliver: data => resolve(data as string), reject }
        calls.push(call)
        if (sync) call.deliver(sync(wire))
      })
    },
  }
  const target: NativeAccountChannelWindow = kind === 'android' ? { FitflowNativeAccounts: android } : { webkit: { messageHandlers: { FitflowNativeAccounts: ios } } }
  const port = createNativeAccountChannel({ target, now: clock })
  ports.push(port)
  const respond = (index: number, value: unknown) => calls[index].deliver(JSON.stringify({ version: 1, callId: calls[index].wire.callId, ok: true, value }))
  const respondError = (index: number, error: unknown) => calls[index].deliver(JSON.stringify({ version: 1, callId: calls[index].wire.callId, ok: false, error }))
  const respondRequest = (index: number, body: unknown = {}, status = 200) => {
    const { contextId, requestId } = calls[index].wire.payload
    respond(index, { version: 1, contextId, requestId, status, ...(status === 204 ? {} : { body }) })
  }
  const start = async (ctx = context()) => {
    const result = port.startContext(ctx)
    respond(calls.length - 1, ctx)
    return result
  }
  return { port, calls, target, android, ios, respond, respondError, respondRequest, start, setSync: (reply: typeof sync) => { sync = reply } }
}
async function rejected(promise: Promise<unknown>, code: NativeAccountChannelErrorCode) {
  await expect(promise).rejects.toMatchObject({ name: 'NativeAccountChannelError', code, message: 'Native account channel operation failed.' })
}
beforeEach(() => {
  vi.useFakeTimers()
  let serial = 10000
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => id(serial++)) })
})
afterEach(() => {
  for (const port of ports.splice(0)) port.dispose()
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

const routes: [NativeAccountMethod, string, number][] = [
  ['POST', 'auth/login', 200], ['GET', 'auth/session', 200], ['POST', 'auth/register', 202], ['POST', 'auth/logout', 204],
  ['POST', 'auth/verification/request', 202], ['POST', 'auth/verification/confirm', 200],
  ['POST', 'auth/password-reset/request', 202], ['POST', 'auth/password-reset/confirm', 200],
  ['GET', 'consent', 200], ['PUT', 'consent', 200], ['GET', 'sync', 200], ['PUT', 'sync', 200],
  ['POST', 'account/export', 200], ['DELETE', 'account', 204], ['GET', 'coaching', 200],
  ['POST', 'coaching/invitations', 202], ['POST', 'coaching/invitations/cancel', 202],
  ['POST', `coaching/invitations/${id(300)}/accept`, 200], ['DELETE', `coaching/invitations/${id(300)}`, 204],
  ['PUT', `coaching/relationships/${id(300)}/consent`, 200], ['DELETE', `coaching/relationships/${id(300)}`, 200],
  ['GET', `coaching/relationships/${id(300)}/snapshot`, 200], ['GET', `coaching/relationships/${id(300)}/feedback`, 200],
  ['POST', `coaching/relationships/${id(300)}/feedback`, 200], ['POST', `coaching/relationships/${id(300)}/feedback`, 201],
  ['DELETE', `coaching/relationships/${id(300)}/feedback/${id(301)}`, 204], ['GET', 'challenges', 200],
  ['POST', 'challenges/invitations', 202], ['POST', `challenges/invitations/${id(300)}/accept`, 200],
  ['DELETE', `challenges/invitations/${id(300)}`, 204], ['PUT', `challenges/${id(300)}/consent`, 200],
  ['DELETE', `challenges/${id(300)}/consent`, 200], ['DELETE', `challenges/${id(300)}`, 200],
  ['POST', `challenges/${id(300)}/block`, 204], ['GET', `challenges/${id(300)}/counts`, 200],
]

for (const kind of ['android', 'ios'] as const) describe(`${kind} explicit native channel`, () => {
  it('uses exactly the fixed string wrapper for all four methods and never sends at construction', async () => {
    const h = harness(kind)
    expect(h.calls).toHaveLength(0)
    if (kind === 'android') expect(h.android.onmessage).toBeNull()
    const capability = h.port.capabilities({ version: 1 })
    expect(h.calls[0].wire).toEqual({ version: 1, callId: id(10000), operation: 'capabilities', payload: { version: 1 } })
    h.respond(0, { version: 1, available: false })
    expect(await capability).toEqual({ version: 1, available: false })
    await h.start()
    expect(h.calls[1].wire).toMatchObject({ operation: 'startContext', payload: context() })
    const result = h.port.request(command())
    expect(h.calls[2].wire).toMatchObject({ operation: 'request', payload: command() })
    h.respondRequest(2, { domainStillNeedsValidation: true })
    const response = await result
    expect(Object.isFrozen(response)).toBe(true)
    expect(Object.isFrozen(response.body)).toBe(true)
    const cleared = h.port.clearContext(context())
    expect(h.calls[3].wire).toMatchObject({ operation: 'clearContext', payload: context() })
    h.respond(3, context()); expect(await cleared).toEqual(context())
    await rejected(h.port.request(command(201)), 'cancelled')
    expect(h.calls).toHaveLength(4)
  })
  it.each(routes)('retains the contract/domain boundary for %s %s (%s)', async (method, path, status) => {
    const h = harness(kind); await h.start()
    const request = command(200, path, method, { recipient: { id: 'reviewed-counterpart' } })
    const response = h.port.request(request)
    expect(h.calls[1].wire.payload).toEqual(request)
    const body = path === 'auth/session' || path === 'auth/login' ? session() : { businessStillNeedsDomainValidation: true }
    h.respondRequest(1, body, status)
    expect(await response).toEqual({ ...context(), requestId: id(200), status, ...(status === 204 ? {} : { body }) })
  })
  it('accepts all transport error statuses and only their fixed safe bodies', async () => {
    const h = harness(kind); await h.start()
    const cases = [[400, undefined], [401, undefined], [403, { error: { code: 'csrf_failed' } }], [409, { error: { code: 'sync_conflict', details: { revision: 4 } } }], [500, { error: { code: 'service_error' } }], [599, undefined]] as const
    for (const [index, [status, body]] of cases.entries()) {
      const result = h.port.request(command(200 + index))
      h.respond(h.calls.length - 1, { ...context(), requestId: id(200 + index), status, ...(body ? { body } : {}) })
      expect((await result).status).toBe(status)
    }
  })
  it.each(['unavailable', 'invalid_request', 'invalid_response', 'cancelled', 'expired', 'network_error', 'busy', 'context_exhausted'] as const)('surfaces only fixed local failure %s', async error => {
    const h = harness(kind)
    const result = h.port.capabilities({ version: 1 })
    h.respondError(0, error)
    await rejected(result, error)
  })
  it.each([
    {}, { version: 2 }, { version: 1, endpoint: 'https://bad.example.test' }, { version: 1, headers: {} },
  ])('does not connect/send a malformed capabilities command %#', async value => {
    const h = harness(kind)
    await rejected(h.port.capabilities(value as { version: 1 }), 'invalid_request')
    expect(h.calls).toHaveLength(0); expect(h.android.onmessage).toBeNull()
  })
  it('rejects malformed context/request data before native calls or getter execution', async () => {
    const h = harness(kind); const getter = vi.fn(() => 'synthetic-password')
    const malformed = { ...context(), endpoint: 'https://bad.example.test' }
    await rejected(h.port.startContext(malformed), 'invalid_request')
    await rejected(h.port.clearContext({ ...context(), contextId: 'invalid' }), 'invalid_request')
    await h.start()
    const before = h.calls.length
    const requests = [
      { ...command(), method: 'PATCH' }, { ...command(), path: 'https://bad.example.test' },
      { ...command(), headers: {} }, { ...command(), nativeToken: 'synthetic' }, { ...command(), body: {} },
      command(201, 'auth/login', 'POST', Object.defineProperty({}, 'password', { get: getter, enumerable: true })),
      command(202, 'auth/login', 'POST', { password: 'x'.repeat(NATIVE_ACCOUNT_LIMITS.requestBytes) }),
    ]
    for (const request of requests) await rejected(h.port.request(request as NativeAccountRequest), 'invalid_request')
    expect(h.calls).toHaveLength(before); expect(getter).not.toHaveBeenCalled()
    const good = h.port.request(command())
    h.respondRequest(before); await good
  })
  it('sends a detached reviewed form payload, without storing it in context or reusing it for clear', async () => {
    const h = harness(kind); await h.start()
    const body = { email: 'test@example.test', password: 'synthetic-password' }
    const pending = h.port.request(command(200, 'auth/login', 'POST', body))
    body.password = 'mutated'
    expect(h.calls[1].wire.payload.body).toEqual({ email: 'test@example.test', password: 'synthetic-password' })
    h.respondRequest(1, session()); await pending
    h.port.dispose()
    expect(h.calls[2].wire).toMatchObject({ operation: 'clearContext', payload: context() })
    expect(h.calls[2].raw).not.toContain('password')
  })
  it.each([
    { nativeToken: 'SYNTHETIC_SECRET' }, { session: session(), nativeToken: 'SYNTHETIC_SECRET' },
    { token: 'SYNTHETIC_SECRET' }, { Authorization: 'Bearer SYNTHETIC_SECRET' }, { cookies: ['SYNTHETIC_SECRET'] },
    { headers: {} }, { password: 'SYNTHETIC_SECRET' }, 'SYNTHETIC_SECRET', ['SYNTHETIC_SECRET'], null,
  ])('rejects credential-shaped/scalar replies without echoing data %#', async body => {
    const h = harness(kind); await h.start()
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const result = h.port.request(command())
    h.respondRequest(1, body)
    await rejected(result, 'invalid_response')
    expect(logs.every(log => !log.mock.calls.length)).toBe(true)
    expect(h.calls[2].wire.operation).toBe('clearContext')
    await rejected(h.port.request(command(201)), 'cancelled')
  })
  it.each([0, 100, 201, 204, 300, 302, 600, 200.5, '200'])('rejects unexpected sync status %s', async status => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command())
    h.respond(1, { ...context(), requestId: id(200), status, body: {} })
    await rejected(result, 'invalid_response')
  })
  it('rejects wrong inner context/request correlation and never settles an unrelated request', async () => {
    const h = harness(kind); await h.start()
    const first = h.port.request(command(200)); const firstFailure = rejected(first, 'invalid_response')
    const second = h.port.request(command(201)); const secondFailure = rejected(second, 'cancelled')
    h.respond(1, { ...context(), requestId: id(201), status: 200, body: {} })
    await firstFailure; await secondFailure
  })
  it('validates sessions against the trusted response-time clock', async () => {
    let clock = now
    const h = harness(kind, () => clock); await h.start()
    const result = h.port.request(command(200, 'auth/session'))
    clock += NATIVE_ACCOUNT_LIMITS.absoluteSessionMs
    h.respondRequest(1, session())
    await rejected(result, 'invalid_response')
  })
  it.each([
    { ...session(), user: { ...session().user, password: 'synthetic' } },
    { ...session(), sessionExpiresAt: '2026-10-16T08:00:00.001Z' },
    { ...session(), sessionExpiresAt: '2026-10-15T00:00:00.000Z' },
  ])('rejects malformed or overlong sanitized sessions %#', async body => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command(200, 'auth/login', 'POST', {}))
    h.respondRequest(1, body); await rejected(result, 'invalid_response')
  })
  it('bounds two network requests separately from four local commands', async () => {
    const h = harness(kind); await h.start()
    const first = h.port.request(command(200)); const second = h.port.request(command(201))
    await rejected(h.port.request(command(202)), 'busy')
    const capabilities = Array.from({ length: 4 }, () => h.port.capabilities({ version: 1 }))
    await rejected(h.port.capabilities({ version: 1 }), 'busy')
    expect(h.calls).toHaveLength(7)
    h.respondRequest(1); h.respondRequest(2)
    for (let index = 3; index < 7; index++) h.respond(index, { version: 1, available: false })
    await Promise.all([first, second, ...capabilities])
    const third = h.port.request(command(202)); h.respondRequest(7); await third
  })
  it('rejects duplicate request IDs while pending and after terminal completion', async () => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command())
    await rejected(h.port.request(command()), 'invalid_request')
    h.respondRequest(1); await result
    await rejected(h.port.request(command()), 'invalid_request')
    expect(h.calls).toHaveLength(2)
  })
  it('requires an acknowledged current context and rejects reused contexts', async () => {
    const h = harness(kind)
    await rejected(h.port.request(command()), 'cancelled')
    const starting = h.port.startContext(context())
    await rejected(h.port.request(command()), 'cancelled')
    h.respond(0, context()); await starting
    await rejected(h.port.startContext(context()), 'invalid_request')
    const cleared = h.port.clearContext(context()); h.respond(1, context()); await cleared
    await rejected(h.port.startContext(context()), 'invalid_request')
  })
  it('makes timeout terminal, clears only matching context, and ignores late success', async () => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command(200, 'auth/login', 'POST', { password: 'synthetic' }))
    const failure = rejected(result, 'expired')
    await vi.advanceTimersByTimeAsync(NATIVE_ACCOUNT_LIMITS.requestTimeoutMs)
    await failure
    expect(h.calls[2].wire).toMatchObject({ operation: 'clearContext', payload: context() })
    await h.start(context(101))
    const count = h.calls.length
    h.respondRequest(1, session())
    await Promise.resolve()
    expect(h.calls).toHaveLength(count)
    const newer = h.port.request(command(201, 'sync', 'GET', {}, context(101)))
    h.respondRequest(count); await newer
  })
  it('expires local commands and does not make network fallback requests', async () => {
    const h = harness(kind)
    const result = h.port.capabilities({ version: 1 }); const failure = rejected(result, 'expired')
    await vi.advanceTimersByTimeAsync(NATIVE_ACCOUNT_LIMITS.requestTimeoutMs)
    await failure; expect(h.calls).toHaveLength(1)
    h.respond(0, { version: 1, available: true })
    expect(h.calls).toHaveLength(1)
  })
  it('cancels previous start and acknowledges only the newest generation', async () => {
    const h = harness(kind)
    const old = h.port.startContext(context()); const oldFailure = rejected(old, 'cancelled')
    const newer = h.port.startContext(context(101))
    h.respond(0, context()); await oldFailure
    await rejected(h.port.request(command()), 'cancelled')
    expect(h.calls[1].wire).toMatchObject({ operation: 'clearContext', payload: context() })
    h.respond(2, context(101)); await newer
    const result = h.port.request(command(201, 'sync', 'GET', {}, context(101)))
    h.respondRequest(3); await result
  })
  it('supersedes a pending login and ignores late old malformed/private replies', async () => {
    const h = harness(kind); await h.start()
    const old = h.port.request(command(200, 'auth/login', 'POST', { password: 'synthetic' })); const failure = rejected(old, 'cancelled')
    await h.start(context(101)); await failure
    const before = h.calls.length
    h.respondRequest(1, { nativeToken: 'synthetic' }); await Promise.resolve()
    expect(h.calls).toHaveLength(before)
    const result = h.port.request(command(201, 'sync', 'GET', {}, context(101)))
    h.respondRequest(before); await result
  })
  it('clear invalidates immediately; old clear acknowledgment cannot retire a newer context', async () => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command()); const failure = rejected(result, 'cancelled')
    const clearing = h.port.clearContext(context()); await failure
    await rejected(h.port.request(command(201)), 'cancelled')
    await h.start(context(101))
    h.respond(2, context()); await clearing
    h.respondRequest(1, { nativeToken: 'synthetic' }); await Promise.resolve()
    const oldClear = h.port.clearContext(context()); h.respond(4, context()); await oldClear
    const newer = h.port.request(command(201, 'sync', 'GET', {}, context(101)))
    h.respondRequest(5); await newer
  })
  it('invalid old clear replies do not clear newer state', async () => {
    const h = harness(kind); await h.start()
    const clearing = h.port.clearContext(context())
    await h.start(context(101))
    h.respond(1, context(102)); await rejected(clearing, 'invalid_response')
    const result = h.port.request(command(201, 'sync', 'GET', {}, context(101)))
    h.respondRequest(3); await result
  })
  it('disposes immediately, best-effort clears locally once, and ignores captured callbacks', async () => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command(200, 'auth/login', 'POST', { password: 'synthetic' })); const failure = rejected(result, 'cancelled')
    h.port.dispose(); h.port.dispose(); await failure
    expect(h.calls).toHaveLength(3)
    expect(h.calls[2].wire).toMatchObject({ operation: 'clearContext', payload: context() })
    if (kind === 'android') expect(h.android.onmessage).toBeNull()
    h.respondRequest(1, session()); h.respond(2, context()); await Promise.resolve()
    await rejected(h.port.request(command(201)), 'cancelled')
    await rejected(h.port.capabilities({ version: 1 }), 'cancelled')
    await rejected(h.port.startContext(context(101)), 'cancelled')
    await rejected(h.port.clearContext(context()), 'cancelled')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('disposes an unacknowledged context without allowing late start to restore it', async () => {
    const h = harness(kind)
    const result = h.port.startContext(context()); const failure = rejected(result, 'cancelled')
    h.port.dispose(); await failure
    expect(h.calls[1].wire.operation).toBe('clearContext')
    h.respond(0, context()); await Promise.resolve()
    await rejected(h.port.request(command()), 'cancelled')
  })
  it('does not retry a native busy failure or clear a healthy context', async () => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command()); h.respondError(1, 'busy'); await rejected(result, 'busy')
    expect(h.calls).toHaveLength(2)
    const newer = h.port.request(command(201)); h.respondRequest(2); await newer
  })
  it('handles synchronous dispatch replies without losing correlation', async () => {
    const h = harness(kind)
    h.setSync(wire => JSON.stringify({ version: 1, callId: wire.callId, ok: true, value: wire.operation === 'capabilities' ? { version: 1, available: false } : wire.payload }))
    expect(await h.port.capabilities({ version: 1 })).toEqual({ version: 1, available: false })
    expect(await h.port.startContext(context())).toEqual(context())
    expect(await h.port.clearContext(context())).toEqual(context())
    expect(vi.getTimerCount()).toBe(0)
  })
})

for (const kind of ['android', 'ios'] as const) describe(`${kind} wrapper and resource boundary`, () => {
  it.each([
    { version: 2 }, { ok: 1 }, { ok: 'true' }, { headers: {} }, { nativeToken: 'SYNTHETIC_SECRET' },
    { error: 'invalid_response' }, { value: { version: 1, available: 'false' } },
  ])('rejects an attributable invalid outer/local reply %#', async changes => {
    const h = harness(kind)
    const result = h.port.capabilities({ version: 1 })
    h.calls[0].deliver(JSON.stringify({ version: 1, callId: h.calls[0].wire.callId, ok: true, value: { version: 1, available: false }, ...changes }))
    await rejected(result, 'invalid_response')
  })
  it.each(['upstream-secret-error', {}, { code: 'invalid_request' }, null, 0, 'SYNTHETIC_SECRET'])('rejects unknown/untyped local error %#', async error => {
    const h = harness(kind)
    const result = h.port.capabilities({ version: 1 }); h.respondError(0, error)
    await rejected(result, 'invalid_response')
  })
  it.each([undefined, null, {}, ['not a string'], 5, '', '{', 'null', '[]', 'true', '"token"', '{"version":1,}', ' {"x":"\\uZZZZ"} ', '{"version":01}', '{"version":NaN}'])('never accepts non-string or malformed JSON %#', async raw => {
    const h = harness(kind)
    const result = h.port.capabilities({ version: 1 })
    h.calls[0].deliver(raw)
    if (kind === 'ios') await rejected(result, 'invalid_response')
    else {
      h.respond(0, { version: 1, available: false })
      expect(await result).toEqual({ version: 1, available: false })
    }
  })
  it.each(['version', 'callId', 'ok', 'value', 'error'])('rejects duplicate wrapper key %s before materializing the response', async key => {
    const h = harness(kind)
    const result = h.port.capabilities({ version: 1 })
    const fields: Record<string, unknown> = { version: 1, callId: h.calls[0].wire.callId, ok: true, value: { version: 1, available: false } }
    const raw = `{${JSON.stringify(key)}:${JSON.stringify(fields[key] ?? 'unavailable')},${JSON.stringify({ ...fields, ...(key === 'error' ? { error: 'unavailable' } : {}) }).slice(1)}`
    const parse = vi.spyOn(JSON, 'parse')
    h.calls[0].deliver(raw); await Promise.resolve()
    expect(parse.mock.calls.some(call => call[0] === raw)).toBe(false)
    if (kind === 'ios') await rejected(result, 'invalid_response')
    else { h.respond(0, { version: 1, available: false }); await result }
  })
  it('rejects escaped duplicate keys and duplicated nested business keys', async () => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command())
    const raw = `{"version":1,"callId":"${h.calls[1].wire.callId}","ok":true,"value":{"version":1,"contextId":"${context().contextId}","requestId":"${id(200)}","status":200,"body":{"note":1,"no\\u0074e":2}}}`
    h.calls[1].deliver(raw)
    if (kind === 'ios') await rejected(result, 'invalid_response')
    else { h.respondRequest(1, { note: 3 }); expect((await result).body).toEqual({ note: 3 }) }
  })
  it.each(['x'.repeat(1025), '界'.repeat(500)])('checks character and UTF-8 byte limits before any JSON parse %#', async large => {
    const h = harness(kind)
    const result = h.port.capabilities({ version: 1 })
    const raw = JSON.stringify({ version: 1, callId: h.calls[0].wire.callId, ok: true, value: { text: large } })
    const parse = vi.spyOn(JSON, 'parse')
    h.calls[0].deliver(raw); await Promise.resolve()
    expect(parse).not.toHaveBeenCalled()
    if (kind === 'ios') await rejected(result, 'invalid_response')
    else { h.respond(0, { version: 1, available: false }); await result }
  })
  it('bounds route-specific raw strings before parsing even when an export allows a larger simultaneous reply', async () => {
    const h = harness(kind); await h.start()
    const challenge = h.port.request(command(200, 'challenges')); const challengeFailure = kind === 'ios' ? rejected(challenge, 'invalid_response') : undefined
    const exported = h.port.request(command(201, 'account/export', 'POST')); const exportFailure = rejected(exported, 'cancelled')
    const raw = JSON.stringify({ version: 1, callId: h.calls[1].wire.callId, ok: true, value: { ...context(), requestId: id(200), status: 200, body: { text: 'x'.repeat(NATIVE_ACCOUNT_LIMITS.challengeResponseBytes + 1024) } } })
    const parse = vi.spyOn(JSON, 'parse')
    h.calls[1].deliver(raw); await Promise.resolve()
    expect(parse.mock.calls.some(call => call[0] === raw)).toBe(false)
    // The syntactically attributable message is rejected on Android too, after the per-ID bound.
    if (kind === 'android') await rejected(challenge, 'invalid_response')
    else await challengeFailure
    await exportFailure
  })
  it('allows the contract depth boundary and rejects excess depth before materializing data', async () => {
    const h = harness(kind); await h.start()
    let body: unknown = {}
    for (let count = 0; count < 31; count++) body = { nested: body }
    const allowed = h.port.request(command(200)); h.respondRequest(1, body); await allowed
    const result = h.port.request(command(201))
    const raw = JSON.stringify({ version: 1, callId: h.calls[2].wire.callId, ok: true, value: { ...context(), requestId: id(201), status: 200, body: { nested: body } } })
    const parse = vi.spyOn(JSON, 'parse'); h.calls[2].deliver(raw); await Promise.resolve()
    expect(parse.mock.calls.some(call => call[0] === raw)).toBe(false)
    if (kind === 'ios') await rejected(result, 'invalid_response')
    else { h.respondRequest(2); await result }
  })
  it('bounds expanded JSON nodes before materializing a response', async () => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command())
    const raw = `{"version":1,"callId":"${h.calls[1].wire.callId}","ok":true,"value":{"version":1,"contextId":"${context().contextId}","requestId":"${id(200)}","status":200,"body":{"values":[${'0,'.repeat(NATIVE_ACCOUNT_LIMITS.nodes)}0]}}}`
    const parse = vi.spyOn(JSON, 'parse'); h.calls[1].deliver(raw); await Promise.resolve()
    expect(parse.mock.calls.some(call => call[0] === raw)).toBe(false)
    if (kind === 'ios') await rejected(result, 'invalid_response')
    else { h.respondRequest(1); await result }
  })
  it('keeps reviewed business strings and prototype-named data rather than scanning them for tokens', async () => {
    const h = harness(kind); await h.start()
    const result = h.port.request(command())
    const body: unknown = JSON.parse('{"__proto__":{"polluted":true},"notes":"Bearer is my dog; nativeToken is a user note","nested":{"token":"user data"}}')
    h.respondRequest(1, body)
    expect((await result).body).toEqual(body); expect({}).not.toHaveProperty('polluted')
  })
  it('does not retry after a transport rejection or echo its diagnostics', async () => {
    const h = harness(kind)
    if (kind === 'android') {
      const send = h.android.postMessage
      h.android.postMessage = raw => {
        if ((JSON.parse(raw) as Wire).operation === 'request') throw new Error('SYNTHETIC_SECRET')
        return send(raw)
      }
    }
    await h.start()
    const result = h.port.request(command())
    if (kind === 'ios') h.calls[1].reject(new Error('SYNTHETIC_SECRET'))
    await rejected(result, 'network_error')
    expect(h.calls.filter(call => call.wire.operation === 'request')).toHaveLength(kind === 'ios' ? 1 : 0)
    expect(h.calls.at(-1)?.wire.operation).toBe('clearContext')
    await rejected(h.port.request(command(201)), 'cancelled')
  })
})

describe('correlation and Android handler ownership', () => {
  it('ignores unknown/wrong-type call IDs without settling any pending Android call', async () => {
    const h = harness('android'); await h.start()
    const result = h.port.request(command())
    const settled = vi.fn(); void result.then(settled, settled)
    for (const callId of [id(999), id(999).toUpperCase(), 'bad', `${id(999)}\n`, 1, null]) {
      h.calls[1].deliver(JSON.stringify({ version: 1, callId, ok: true, value: { nativeToken: 'synthetic' } }))
    }
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(2)
    h.respondRequest(1); await result; await Promise.resolve(); expect(settled).toHaveBeenCalledTimes(1)
    h.respondRequest(1, { nativeToken: 'synthetic' }); await Promise.resolve()
    expect(settled).toHaveBeenCalledTimes(1); expect(h.calls).toHaveLength(2)
  })
  it('rejects an iOS reply with another pending call ID without delivering it to that call', async () => {
    const h = harness('ios')
    const first = h.port.capabilities({ version: 1 }); const second = h.port.capabilities({ version: 1 })
    h.calls[0].deliver(JSON.stringify({ version: 1, callId: h.calls[1].wire.callId, ok: true, value: { version: 1, available: true } }))
    await rejected(first, 'invalid_response')
    h.respond(1, { version: 1, available: false }); expect((await second).available).toBe(false)
  })
  it('never accepts an immediate iOS string/object instead of the specified Promise<string>', async () => {
    const h = harness('ios')
    h.ios.postMessage = (() => ({ version: 1, available: true })) as unknown as typeof h.ios.postMessage
    await rejected(h.port.capabilities({ version: 1 }), 'invalid_response')
  })
  it('prevents a second Android adapter from silently replacing the first; disposal releases ownership', async () => {
    const h = harness('android')
    const first = h.port.capabilities({ version: 1 })
    const original = h.android.onmessage
    const second = createNativeAccountChannel({ target: h.target }); ports.push(second)
    await rejected(second.capabilities({ version: 1 }), 'busy')
    expect(h.android.onmessage).toBe(original)
    h.respond(0, { version: 1, available: false }); await first
    h.port.dispose()
    const next = second.capabilities({ version: 1 })
    expect(h.android.onmessage).not.toBe(original)
    h.respond(0, { version: 1, available: true })
    h.respond(1, { version: 1, available: false }); expect((await next).available).toBe(false)
  })
  it('never overwrites preexisting foreign handlers and detaches only its own handler', async () => {
    const h = harness('android'); const other = vi.fn()
    h.android.onmessage = other
    await rejected(h.port.capabilities({ version: 1 }), 'busy')
    h.port.dispose(); expect(h.android.onmessage).toBe(other)
    const fresh = harness('android')
    const pending = fresh.port.capabilities({ version: 1 }); const failure = rejected(pending, 'unavailable')
    fresh.android.onmessage = other
    await rejected(fresh.port.capabilities({ version: 1 }), 'unavailable')
    await failure; fresh.port.dispose(); expect(fresh.android.onmessage).toBe(other)
  })
  it('does not let a captured callback deliver results after its Android handler is replaced', async () => {
    const h = harness('android'); await h.start()
    const result = h.port.request(command()); const failure = rejected(result, 'unavailable')
    const other = vi.fn(); h.android.onmessage = other
    h.respondRequest(1); await failure
    expect(h.android.onmessage).toBe(other)
    await rejected(h.port.request(command(201)), 'cancelled')
  })
  it('cleans up failed handler acquisition without taking ownership of another handler', async () => {
    let handler: NativeAccountAndroidChannel['onmessage'] = null
    let blocked = true
    const endpoint = { postMessage: vi.fn(), get onmessage() { return handler }, set onmessage(value) { if (blocked) throw new Error('synthetic'); handler = value } }
    const first = createNativeAccountChannel({ target: { FitflowNativeAccounts: endpoint } }); ports.push(first)
    await rejected(first.capabilities({ version: 1 }), 'unavailable')
    blocked = false
    const second = createNativeAccountChannel({ target: { FitflowNativeAccounts: endpoint } }); ports.push(second)
    const result = second.capabilities({ version: 1 }); const failure = rejected(result, 'cancelled')
    expect(endpoint.postMessage).toHaveBeenCalledTimes(1)
    second.dispose(); await failure
  })
  it('does not resurrect context when clear/dispose occurs between iOS fulfillment and its microtask', async () => {
    const h = harness('ios'); await h.start()
    const result = h.port.request(command()); const failure = rejected(result, 'cancelled')
    h.respondRequest(1)
    h.port.dispose()
    await failure; await rejected(h.port.request(command(201)), 'cancelled')
  })
})

describe('explicit lifecycle and replay budgets', () => {
  it('requires cryptographic UUIDv4 generation and has no weaker randomness fallback', async () => {
    const random = vi.spyOn(Math, 'random')
    for (const crypto of [undefined, {}, { randomUUID: () => 'SYNTHETIC_SECRET' }, { randomUUID: () => id(999).replace('-42bf-', '-12bf-') }]) {
      vi.stubGlobal('crypto', crypto)
      const h = harness('android')
      await rejected(h.port.capabilities({ version: 1 }), 'unavailable')
      expect(h.calls).toHaveLength(0)
    }
    expect(random).not.toHaveBeenCalled()
  })
  it('never reuses a generated call ID, including after a completed call', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => id(900) })
    const h = harness('android')
    const first = h.port.capabilities({ version: 1 }); h.respond(0, { version: 1, available: false }); await first
    await rejected(h.port.capabilities({ version: 1 }), 'unavailable')
    expect(h.calls).toHaveLength(1)
  })
  it('does not retire current state if replacement cannot generate a call ID', async () => {
    const h = harness('android'); await h.start()
    vi.stubGlobal('crypto', undefined)
    await rejected(h.port.startContext(context(101)), 'unavailable')
    vi.stubGlobal('crypto', { randomUUID: () => id(19000) })
    const result = h.port.request(command()); h.respondRequest(1); await result
  })
  it('keeps a current context when local capacity prevents a replacement', async () => {
    const h = harness('android'); await h.start()
    const capabilities = Array.from({ length: 4 }, () => h.port.capabilities({ version: 1 }))
    await rejected(h.port.startContext(context(101)), 'busy')
    for (let index = 1; index < 5; index++) h.respond(index, { version: 1, available: false })
    await Promise.all(capabilities)
    const result = h.port.request(command()); h.respondRequest(5); await result
  })
  it('bounds context replay history instead of evicting old IDs', async () => {
    const h = harness('android')
    for (let index = 0; index < NATIVE_ACCOUNT_CHANNEL_LIMITS.contexts; index++) await h.start(context(100 + index))
    await rejected(h.port.startContext(context(999)), 'context_exhausted')
    await rejected(h.port.startContext(context()), 'invalid_request')
    expect(h.calls.filter(call => call.wire.operation === 'startContext')).toHaveLength(NATIVE_ACCOUNT_CHANNEL_LIMITS.contexts)
    expect(h.calls.filter(call => call.wire.operation === 'clearContext')).toHaveLength(NATIVE_ACCOUNT_CHANNEL_LIMITS.contexts - 1)
  })
  it('bounds per-context request history without allowing reused IDs after eviction', async () => {
    const h = harness('android'); await h.start()
    for (let index = 0; index < NATIVE_ACCOUNT_CHANNEL_LIMITS.requestsPerContext; index++) {
      const result = h.port.request(command(200 + index)); h.respondRequest(index + 1); await result
    }
    await rejected(h.port.request(command(9999)), 'context_exhausted')
    await rejected(h.port.request(command(200)), 'invalid_request')
    expect(h.calls).toHaveLength(NATIVE_ACCOUNT_CHANNEL_LIMITS.requestsPerContext + 1)
  }, 15000)
  it('bounds all call-ID history and never silently evicts the replay fence', async () => {
    const h = harness('android')
    h.setSync(wire => JSON.stringify({ version: 1, callId: wire.callId, ok: true, value: { version: 1, available: false } }))
    for (let index = 0; index < NATIVE_ACCOUNT_CHANNEL_LIMITS.calls; index++) await h.port.capabilities({ version: 1 })
    await rejected(h.port.capabilities({ version: 1 }), 'context_exhausted')
    expect(h.calls).toHaveLength(NATIVE_ACCOUNT_CHANNEL_LIMITS.calls)
  }, 15000)
  it('rejects an invalid trusted clock without returning private business data', async () => {
    const h = harness('android', () => NaN); await h.start()
    const result = h.port.request(command()); h.respondRequest(1)
    await rejected(result, 'invalid_response')
  })
  it('uses no discovery on import/construction and no network, storage, or generic plugin fallback', async () => {
    const forbidden = vi.fn(() => { throw new Error('Forbidden side effect') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('XMLHttpRequest', forbidden); vi.stubGlobal('WebSocket', forbidden)
    vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden }); vi.stubGlobal('sessionStorage', { getItem: forbidden, setItem: forbidden })
    vi.stubGlobal('Capacitor', { registerPlugin: forbidden, Plugins: { CapacitorHttp: { request: forbidden } } })
    const discovery = vi.fn(() => undefined)
    vi.stubGlobal('window', Object.defineProperty({}, 'FitflowNativeAccounts', { get: discovery }))
    vi.resetModules()
    const module = await import('./nativeAccountChannel')
    const port = module.createNativeAccountChannel(); ports.push(port)
    expect(discovery).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled()
    expect(await port.capabilities({ version: 1 })).toEqual({ version: 1, available: false })
    await expect(port.startContext(context())).rejects.toMatchObject({ code: 'unavailable' })
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('does not choose an arbitrary endpoint when both platform channels are present', async () => {
    const send = vi.fn()
    const port = createNativeAccountChannel({ target: { FitflowNativeAccounts: { postMessage: send }, webkit: { messageHandlers: { FitflowNativeAccounts: { postMessage: send } } } } }); ports.push(port)
    expect(await port.capabilities({ version: 1 })).toEqual({ version: 1, available: false })
    await rejected(port.startContext(context()), 'unavailable')
    expect(send).not.toHaveBeenCalled()
  })
  it('exports static errors with no arbitrary upstream text/cause', () => {
    const error = new NativeAccountChannelError('network_error')
    expect(String(error)).toBe('NativeAccountChannelError: Native account channel operation failed.')
    expect(error).not.toHaveProperty('cause')
  })
})

describe('local cleanup priority', () => {
  it('does not let pending local commands starve an explicit matching clear', async () => {
    const h = harness('android'); await h.start()
    const locals = Array.from({ length: 4 }, () => h.port.capabilities({ version: 1 }))
    const cancelled = rejected(locals[0], 'cancelled')
    const clearing = h.port.clearContext(context())
    expect(h.calls[5].wire.operation).toBe('clearContext')
    await cancelled
    h.respond(1, { version: 1, available: true })
    for (let index = 2; index <= 4; index++) h.respond(index, { version: 1, available: false })
    h.respond(5, context())
    await Promise.all([clearing, ...locals.slice(1)])
    await rejected(h.port.request(command()), 'cancelled')
  })
  it('prioritizes cleanup after a malformed matching response even if local slots are full', async () => {
    const h = harness('ios'); await h.start()
    const result = h.port.request(command()); const failure = rejected(result, 'invalid_response')
    const locals = Array.from({ length: 4 }, () => h.port.capabilities({ version: 1 }))
    const cancelled = rejected(locals[0], 'cancelled')
    h.respondRequest(1, { nativeToken: 'synthetic' })
    await failure; await cancelled
    expect(h.calls[6].wire.operation).toBe('clearContext')
    for (let index = 3; index <= 5; index++) h.respond(index, { version: 1, available: false })
    h.respond(6, context()); await Promise.all(locals.slice(1))
  })
})

for (const kind of ['android', 'ios'] as const) describe(`${kind} failed replacement cleanup`, () => {
  it('clears the superseded native context even when the replacement dispatch never arrives', async () => {
    const h = harness(kind)
    const attempts: Wire[] = []
    if (kind === 'android') {
      const send = h.android.postMessage
      h.android.postMessage = raw => {
        const wire: Wire = JSON.parse(raw); attempts.push(wire)
        if (wire.operation === 'startContext' && wire.payload.contextId === context(101).contextId) throw new Error('synthetic-send-failure')
        send(raw)
      }
    } else {
      const send = h.ios.postMessage
      h.ios.postMessage = raw => {
        const wire: Wire = JSON.parse(raw); attempts.push(wire)
        if (wire.operation === 'startContext' && wire.payload.contextId === context(101).contextId) return Promise.reject(new Error('synthetic-send-failure'))
        return send(raw)
      }
    }
    await h.start()
    const old = h.port.request(command()); const cancelled = rejected(old, 'cancelled')
    await rejected(h.port.startContext(context(101)), 'unavailable'); await cancelled
    expect(attempts.map(wire => [wire.operation, wire.payload.contextId])).toEqual([
      ['startContext', context().contextId], ['request', context().contextId],
      ['clearContext', context().contextId], ['startContext', context(101).contextId],
      ['clearContext', context(101).contextId],
    ])
    h.respondRequest(1, { nativeToken: 'synthetic' }); await Promise.resolve()
    await rejected(h.port.request(command(201)), 'cancelled')
  })
  it('bounds local pending work when replacement clear needs a slot alongside capability calls', async () => {
    const h = harness(kind); await h.start()
    const locals = Array.from({ length: 3 }, () => h.port.capabilities({ version: 1 }))
    const cancelled = rejected(locals[0], 'cancelled')
    const starting = h.port.startContext(context(101))
    await cancelled
    expect(h.calls[4].wire).toMatchObject({ operation: 'clearContext', payload: context() })
    expect(h.calls[5].wire).toMatchObject({ operation: 'startContext', payload: context(101) })
    await rejected(h.port.capabilities({ version: 1 }), 'busy')
    h.respond(2, { version: 1, available: false }); h.respond(3, { version: 1, available: false })
    h.respond(4, context()); h.respond(5, context(101))
    await Promise.all([starting, ...locals.slice(1)])
  })
})
