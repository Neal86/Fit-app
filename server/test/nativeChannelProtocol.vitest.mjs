import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativeAccountChannel } from '../../src/nativeAccountChannel'
import { readNativeAccountRequest, readNativeAccountSession } from '../../src/nativeAccountContract'
import { HEALTH_SYNC_POLICY, pausedCloudState } from '../../src/cloud'
import { freshState, parseBackup } from '../../src/storage'
import { startSession } from '../../src/session'
import { setup, PASSWORD } from './fixtures.mjs'

// The adapter and API are production code. This peer is deliberately synthetic:
// it is not an Android/iOS implementation or evidence of platform isolation.
const fixtures = [], channels = []
afterEach(() => {
  channels.splice(0).forEach(channel => channel.dispose())
  fixtures.splice(0).forEach(fixture => fixture.close())
})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function service() {
  const f = setup({ config: { nativeAccountsEnabled: true } })
  f.advance(Date.now() - f.now()); fixtures.push(f); return f
}
class SyntheticWirePeer {
  context = null
  credential = null
  session = null
  calls = 0
  returned = []
  hold = null
  observed = null
  constructor(fixture) { this.fixture = fixture }
  async dispatch(raw) {
    const command = JSON.parse(raw)
    const wrap = value => {
      const output = JSON.stringify({ version: 1, callId: command.callId, ok: true, value })
      if (this.credential) expect(output).not.toContain(this.credential)
      this.returned.push(output); return output
    }
    const fail = error => JSON.stringify({ version: 1, callId: command.callId, ok: false, error })
    if (command.operation === 'capabilities') return wrap({ version: 1, available: true })
    if (command.operation === 'startContext') {
      this.context = command.payload.contextId; this.credential = null; this.session = null
      return wrap(command.payload)
    }
    if (command.operation === 'clearContext') {
      if (this.context === command.payload.contextId) { this.context = null; this.credential = null; this.session = null }
      return wrap(command.payload)
    }
    const request = readNativeAccountRequest(command.payload)
    if (request.contextId !== this.context) return fail('cancelled')
    this.calls++
    const result = await this.fixture.app.handle({
      method: request.method, path: `/api/native/v1/${request.path}`, ip: '127.0.0.1',
      body: request.body === undefined ? '' : JSON.stringify(request.body),
      headers: { 'x-fitflow-client': 'native-v1', ...(request.method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...(this.credential ? { authorization: `Bearer ${this.credential}`, 'x-csrf-token': this.session.csrfToken } : {}) },
    })
    expect(result.headers).not.toHaveProperty('set-cookie')
    expect(result.headers).not.toHaveProperty('access-control-allow-origin')
    let body = result.body
    if (request.path === 'auth/login' && result.status === 200) {
      if (this.context !== request.contextId) return fail('cancelled')
      this.session = readNativeAccountSession(body.session, this.fixture.now())
      this.credential = body.nativeToken
      expect(this.credential).toMatch(/^[A-Za-z0-9_-]{43}$/)
      body = this.session
    } else if (result.status >= 400) {
      const code = result.status === 409 && body.error.code === 'sync_conflict' ? 'sync_conflict'
        : result.status === 403 && body.error.code === 'csrf_failed' ? 'csrf_failed' : 'service_error'
      body = { error: { code, ...(code === 'sync_conflict' && Number.isSafeInteger(result.body.error.details?.revision)
        ? { details: { revision: result.body.error.details.revision } } : {}) } }
    }
    const reply = { version: 1, contextId: request.contextId, requestId: request.requestId, status: result.status,
      ...(body === undefined ? {} : { body }) }
    if (this.hold) {
      const hold = this.hold; this.hold = null; this.observed?.resolve(); await hold.promise
      // Intentionally emit this late stale result to exercise the JS adapter fence.
      // A real native implementation must independently suppress it as well.
    }
    return wrap(reply)
  }
}
function adapter(platform, peer) {
  const endpoint = platform === 'ios'
    ? { postMessage: message => peer.dispatch(message) }
    : { onmessage: null, postMessage(message) {
      void peer.dispatch(message).then(data => endpoint.onmessage?.({ data }))
    } }
  const target = platform === 'ios' ? { webkit: { messageHandlers: { FitflowNativeAccounts: endpoint } } } : { FitflowNativeAccounts: endpoint }
  const channel = createNativeAccountChannel({ target, now: () => peer.fixture.now() })
  channels.push(channel); return channel
}
const request = (context, method, path, body) => ({ version: 1, contextId: context.contextId, requestId: randomUUID(), method, path,
  ...(body === undefined ? {} : { body }) })

describe.each(['android', 'ios'])('%s-shaped synthetic message channel and real API', platform => {
  it('keeps local operations offline and preserves manually consented snapshots through the actual adapter', async () => {
    const f = service(), seeded = f.seed(`channel-${platform}@example.test`), peer = new SyntheticWirePeer(f), channel = adapter(platform, peer)
    expect(await channel.capabilities({ version: 1 })).toEqual({ version: 1, available: true })
    const context = { version: 1, contextId: randomUUID() }
    expect(await channel.startContext(context)).toEqual(context)
    expect(peer.calls).toBe(0)
    const login = await channel.request(request(context, 'POST', 'auth/login', { email: seeded.email, password: PASSWORD }))
    expect(login.body.user.id).toBe(seeded.id)
    expect(Object.keys(login.body).sort()).toEqual(['csrfToken', 'sessionExpiresAt', 'user'])
    expect((await channel.request(request(context, 'GET', 'consent'))).body.healthSync).toBe(false)
    expect((await channel.request(request(context, 'GET', 'sync'))).status).toBe(403)
    await channel.request(request(context, 'PUT', 'consent', { healthSync: true, policyVersion: HEALTH_SYNC_POLICY }))
    expect((await channel.request(request(context, 'GET', 'sync'))).body.revision).toBe(0)
    const state = freshState()
    state.workouts[0].exercises[0].equipment = ['dumbbells']
    state.activeSession = startSession(state.workouts[0], f.now())
    const paused = pausedCloudState(state, f.now())
    const saved = await channel.request(request(context, 'PUT', 'sync', { state: paused, baseRevision: 0, operationId: randomUUID() }))
    expect(saved.body).toMatchObject({ revision: 1, replayed: false })
    const read = await channel.request(request(context, 'GET', 'sync'))
    expect(parseBackup(JSON.stringify(read.body.state))).toEqual(paused)
    const exported = await channel.request(request(context, 'POST', 'account/export', { password: PASSWORD }))
    expect(exported.body.sync.state).toEqual(paused)
    const token = peer.credential, calls = peer.calls
    await channel.clearContext(context)
    expect(peer.calls).toBe(calls)
    expect(peer.credential).toBeNull()
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM native_sessions WHERE user_id=?').get(seeded.id).count).toBe(1)
    expect(peer.returned.join('')).not.toContain(token)
    await expect(channel.request(request(context, 'GET', 'sync'))).rejects.toMatchObject({ code: 'cancelled' })
    expect(peer.calls).toBe(calls)
  })

  it('rejects a delayed previous-account response after a new local context and keeps the new account usable', async () => {
    const f = service(), first = f.seed(`channel-first-${platform}@example.test`), second = f.seed(`channel-second-${platform}@example.test`)
    const peer = new SyntheticWirePeer(f), channel = adapter(platform, peer)
    const a = { version: 1, contextId: randomUUID() }, b = { version: 1, contextId: randomUUID() }
    await channel.startContext(a)
    await channel.request(request(a, 'POST', 'auth/login', { email: first.email, password: PASSWORD }))
    await channel.request(request(a, 'PUT', 'consent', { healthSync: true, policyVersion: HEALTH_SYNC_POLICY }))
    const hold = deferred(); peer.hold = hold; peer.observed = deferred()
    const pending = channel.request(request(a, 'GET', 'sync'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await peer.observed.promise
    await channel.startContext(b)
    await rejected
    const login = await channel.request(request(b, 'POST', 'auth/login', { email: second.email, password: PASSWORD }))
    expect(login.body.user.id).toBe(second.id)
    hold.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await channel.request(request(b, 'GET', 'consent'))).body.healthSync).toBe(false)
    const calls = peer.calls
    await channel.clearContext(a)
    expect(peer.context).toBe(b.contextId)
    expect(peer.calls).toBe(calls)
    expect((await channel.request(request(b, 'GET', 'auth/session'))).body.user.id).toBe(second.id)
  })
})
