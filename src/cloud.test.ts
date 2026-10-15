// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Capacitor } from '@capacitor/core'
import { CloudClient, cloudEndpoint, HEALTH_SYNC_POLICY, pausedCloudState } from './cloud'
import { freshState } from './storage'
import { startSession } from './session'

const endpoint = 'https://app.example.test/api/v1'
const now = new Date('2026-10-15T12:00:00.000Z')
const session = (id = 'user-a', verified = true) => ({ user: { id, email: `${id}@example.test`, emailVerified: verified, createdAt: now.toISOString() }, csrfToken: `csrf-${id}-secret`, sessionExpiresAt: '2026-10-16T12:00:00.000Z' })
const consent = (healthSync = true) => ({ healthSync, policyVersion: HEALTH_SYNC_POLICY, updatedAt: now.toISOString() })
const snapshot = (revision = 0, state: unknown = null) => ({ revision, state, updatedAt: state ? now.toISOString() : null })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function setup(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
  responses.forEach(response => fetcher.mockResolvedValueOnce(response))
  return { fetcher, client: new CloudClient(endpoint, fetcher) }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('explicit cloud client boundaries', () => {
  it('does not request anything when configuration is absent or unsafe', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const config of ['', 'http://example.test/api/v1', 'https://user:pass@app.test/api/v1', 'https://app.test/api/v1?token=x', '/api/v1', 'javascript:alert(1)']) {
      const client = new CloudClient(config, fetcher)
      expect(client.configured).toBe(false)
      await expect(client.login('user@example.test', 'password')).rejects.toMatchObject({ code: 'not_configured' })
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(cloudEndpoint('https://app.test/api/v1/')).toBe('https://app.test/api/v1')
    expect(cloudEndpoint('http://localhost:3001/api/v1')).toBe('http://localhost:3001/api/v1')
  })
  it('disables native cloud access even with a configured endpoint', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    const { client, fetcher } = setup()
    expect(client.nativeUnsupported).toBe(true)
    expect(client.configured).toBe(false)
    await expect(client.checkSession()).rejects.toMatchObject({ code: 'not_configured' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses guarded cookie requests and keeps CSRF/auth only in memory', async () => {
    const { client, fetcher } = setup(json(session()), json(consent(false)), json(consent()))
    expect(fetcher).not.toHaveBeenCalled()
    await client.login(' user-a@example.test ', 'super-secret-password')
    await client.getConsent(); await client.setConsent(true)
    const login = fetcher.mock.calls[0]
    expect(login[0]).toBe(`${endpoint}/auth/login`)
    expect(login[1]).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json', 'X-Fitflow-Client': 'web' } })
    expect(login[1]?.headers).not.toHaveProperty('X-CSRF-Token')
    expect(fetcher.mock.calls[1][1]?.headers).toHaveProperty('X-CSRF-Token', session().csrfToken)
    expect(fetcher.mock.calls[2][1]?.headers).toMatchObject({ 'X-CSRF-Token': session().csrfToken, 'X-Fitflow-Client': 'web' })
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('requires verification, explicit consent, inspection, and confirmation before transmitting health data', async () => {
    const unverified = setup(json(session('new', false)))
    await unverified.client.login('new@example.test', 'password')
    await expect(unverified.client.inspectSync()).rejects.toMatchObject({ code: 'email_unverified' })
    expect(unverified.fetcher).toHaveBeenCalledTimes(1)
    const { client, fetcher } = setup(json(session()), json(consent(false)))
    await client.login('user-a@example.test', 'password')
    await expect(client.upload(freshState(), 0, false)).rejects.toMatchObject({ code: 'confirmation_required' })
    await expect(client.upload(freshState(), 0, true)).rejects.toMatchObject({ code: 'inspection_required' })
    await expect(client.inspectSync()).rejects.toMatchObject({ code: 'consent_required' })
    expect(fetcher.mock.calls.every(([, options]) => !options?.body || !String(options.body).includes('"state":'))).toBe(true)
  })
  it('rechecks consent and sends a paused snapshot using CAS plus a UUID', async () => {
    const { client, fetcher } = setup(json(session()), json(consent()), json(snapshot(2)), json(consent()), json({ revision: 3, updatedAt: now.toISOString(), replayed: false }))
    await client.login('user-a@example.test', 'password'); await client.inspectSync()
    const state = freshState(); state.activeSession = startSession(state.workouts[0], now.getTime() - 30000)
    const result = await client.upload(state, 2, true)
    expect(result.revision).toBe(3)
    const put = fetcher.mock.calls[4]
    expect(put[0]).toBe(`${endpoint}/sync`)
    expect(put[1]).toMatchObject({ method: 'PUT', credentials: 'include', headers: { 'X-CSRF-Token': session().csrfToken, 'X-Fitflow-Client': 'web' } })
    const payload = JSON.parse(String(put[1]?.body))
    expect(payload.baseRevision).toBe(2)
    expect(payload.operationId).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i)
    expect(payload.state.activeSession).toMatchObject({ runningSince: null, restUntil: null, elapsedSeconds: 30 })
    expect(state.activeSession.runningSince).not.toBeNull()
    await expect(client.upload(state, 3, true)).rejects.toMatchObject({ code: 'inspection_required' })
  })
  it('blocks upload when consent was revoked after inspection', async () => {
    const { client, fetcher } = setup(json(session()), json(consent()), json(snapshot()), json(consent(false)))
    await client.login('user-a@example.test', 'password'); await client.inspectSync()
    await expect(client.upload(freshState(), 0, true)).rejects.toMatchObject({ code: 'consent_required' })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
  })
  it('invalidates a stale revision on conflict and never retries automatically', async () => {
    const { client, fetcher } = setup(json(session()), json(consent()), json(snapshot(2)), json(consent()), json({ error: { code: 'sync_conflict', message: 'ignored', details: { revision: 3 } } }, 409))
    await client.login('user-a@example.test', 'password'); await client.inspectSync()
    await expect(client.upload(freshState(), 2, true)).rejects.toMatchObject({ code: 'sync_conflict', revision: 3 })
    await expect(client.upload(freshState(), 3, true)).rejects.toMatchObject({ code: 'inspection_required' })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })
  it('rejects incomplete, invalid, unsupported and oversized server snapshots with the backup validator', async () => {
    for (const state of [{ version: 3 }, { ...freshState(), version: 99 }, { ...freshState(), profile: { ...freshState().profile, weightKg: -1 } }, { ...freshState(), padding: 'x'.repeat(10 * 1024 * 1024) }]) {
      const { client } = setup(json(session()), json(consent()), json(snapshot(1, state)))
      await client.login('user-a@example.test', 'password')
      await expect(client.inspectSync()).rejects.toThrow()
      await expect(client.upload(freshState(), 1, true)).rejects.toMatchObject({ code: 'inspection_required' })
    }
  }, 15_000) // The real 10 MiB boundary fixture allocates/validates several copies under shared CPU load.
  it('clears auth/revision on expiry, denial, failed account switching and logout', async () => {
    const { client, fetcher } = setup(json(session()), json(consent()), json(snapshot(4)), json({ error: { code: 'unauthenticated' } }, 401))
    await client.login('user-a@example.test', 'password'); await client.inspectSync()
    await expect(client.getConsent()).rejects.toMatchObject({ code: 'unauthorized' }); expect(client.session).toBeNull()
    fetcher.mockResolvedValueOnce(json(session())); await client.login('user-a@example.test', 'password')
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    await expect(client.upload(freshState(), 4, true)).rejects.toMatchObject({ code: 'session_expired' }); expect(client.session).toBeNull()
    vi.setSystemTime(now)
    fetcher.mockResolvedValueOnce(json(session())); await client.login('user-a@example.test', 'password')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(client.login('user-b@example.test', 'different-password')).rejects.toMatchObject({ code: 'network_error' }); expect(client.session).toBeNull()
    fetcher.mockResolvedValueOnce(json(session())); await client.login('user-a@example.test', 'password')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(client.logout()).rejects.toMatchObject({ code: 'network_error' }); expect(client.session).toBeNull()
  })
  it('does not reuse another account’s inspection and revocation invalidates it', async () => {
    const { client, fetcher } = setup(json(session()), json(consent()), json(snapshot(7)), json(session('user-b')))
    await client.login('user-a@example.test', 'password'); await client.inspectSync(); await client.login('user-b@example.test', 'password')
    await expect(client.upload(freshState(), 7, true)).rejects.toMatchObject({ code: 'inspection_required' })
    fetcher.mockResolvedValueOnce(json(consent())).mockResolvedValueOnce(json(snapshot(8))).mockResolvedValueOnce(json(consent(false)))
    await client.inspectSync(); await client.setConsent(false)
    expect(client.session?.user.id).toBe('user-b')
    await expect(client.upload(freshState(), 8, true)).rejects.toMatchObject({ code: 'inspection_required' })
  })
  it('reports disabled email adapter honestly and never echoes server secrets', async () => {
    const { client } = setup(json({ error: { code: 'email_unavailable', message: 'secret-token' } }, 503))
    await expect(client.requestPasswordReset('user@example.test')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('not enabled or is unavailable') })
  })
  it('requires exact deletion confirmation and validates account export identity', async () => {
    const { client, fetcher } = setup(json(session()))
    await client.login('user-a@example.test', 'password')
    await expect(client.deleteAccount('password', 'delete')).rejects.toMatchObject({ code: 'confirmation_required' })
    fetcher.mockResolvedValueOnce(json({ format: 'fitflow-account-export', version: 1, exportedAt: now.toISOString(), user: session('user-b').user, consent: consent(), sync: snapshot() }))
    await expect(client.exportAccount('password')).rejects.toMatchObject({ code: 'invalid_response' })
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await client.deleteAccount('password', 'DELETE')
    expect(client.session).toBeNull()
  })
  it('pauses an upload copy without modifying the active local session', () => {
    const state = freshState(); state.activeSession = startSession(state.workouts[0], now.getTime() - 5000); state.activeSession.restUntil = now.getTime() + 10000
    const paused = pausedCloudState(state)
    expect(paused.activeSession).toMatchObject({ elapsedSeconds: 5, runningSince: null, restUntil: null })
    expect(state.activeSession.runningSince).toBe(now.getTime() - 5000)
  })
  it('does not let an old delayed error clear a newly authenticated account', async () => {
    let release!: (value: unknown) => void
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    const oldResponse = json({}, 401)
    vi.spyOn(oldResponse, 'json').mockImplementation(() => { started(); return new Promise(resolve => { release = resolve }) })
    const { client } = setup(json(session()), oldResponse, json(session('user-b')))
    await client.login('user-a@example.test', 'password')
    const old = client.getConsent().catch(error => error)
    await reading
    await client.login('user-b@example.test', 'password')
    release({ error: { code: 'unauthenticated' } })
    expect(await old).toMatchObject({ code: 'cancelled' })
    expect(client.session?.user.id).toBe('user-b')
  })
  it('clears stale account identity when a read is rejected for session-bound CSRF', async () => {
    const { client } = setup(json(session()), json({ error: { code: 'csrf_failed' } }, 403))
    await client.login('user-a@example.test', 'password')
    await expect(client.getConsent()).rejects.toMatchObject({ code: 'account_changed' })
    expect(client.session).toBeNull()
  })

})

/** Resolve transport successfully, then clear at the microtask boundary before its consumer. */
function responseThen(value: unknown, action: () => void, hops = 2, status = 200): Response {
  const response = json(value, status)
  vi.spyOn(response, 'text').mockImplementation(async () => {
    const step = (remaining: number) => queueMicrotask(() => remaining > 1 ? step(remaining - 1) : action())
    step(hops)
    return JSON.stringify(value)
  })
  return response
}

describe('post-await account generation boundaries', () => {
  it.each(['login', 'checkSession'] as const)('does not resurrect a cleared session after %s transport resolution', async method => {
    const { client, fetcher } = setup()
    fetcher.mockResolvedValueOnce(responseThen(session(), () => client.clear()))
    const pending = method === 'login' ? client.login('user-a@example.test', 'synthetic') : client.checkSession()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(client.session).toBeNull()
  })
  it.each(['getConsent', 'setConsent'] as const)('does not cache or return stale %s data after transport resolution', async method => {
    const { client, fetcher } = setup(json(session()))
    await client.login('user-a@example.test', 'synthetic')
    fetcher.mockResolvedValueOnce(responseThen(consent(), () => client.clear()))
    await expect(method === 'getConsent' ? client.getConsent() : client.setConsent(true)).rejects.toMatchObject({ code: 'cancelled' })
    expect(client.session).toBeNull()
    expect(client).toHaveProperty('consent', null)
    expect(client).toHaveProperty('inspectedRevision', null)
  })
  it('does not cache or return an inspected snapshot after its request resolves into a cleared session', async () => {
    const { client, fetcher } = setup(json(session()), json(consent()))
    await client.login('user-a@example.test', 'synthetic')
    fetcher.mockResolvedValueOnce(responseThen(snapshot(7, freshState()), () => client.clear()))
    await expect(client.inspectSync()).rejects.toMatchObject({ code: 'cancelled' })
    expect(client).toHaveProperty('inspectedRevision', null)
    expect(client).toHaveProperty('consent', null)
  })
  it('rechecks identity after the nested consent await before requesting a snapshot', async () => {
    const { client, fetcher } = setup(json(session()))
    await client.login('user-a@example.test', 'synthetic')
    fetcher.mockResolvedValueOnce(responseThen(consent(), () => client.clear(), 3))
    await expect(client.inspectSync()).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(client).toHaveProperty('inspectedRevision', null)
  })
  it('rechecks identity after the nested consent await before uploading device health data', async () => {
    const { client, fetcher } = setup(json(session()), json(consent()), json(snapshot(7)))
    await client.login('user-a@example.test', 'synthetic'); await client.inspectSync()
    fetcher.mockResolvedValueOnce(responseThen(consent(), () => client.clear(), 3))
    await expect(client.upload(freshState(), 7, true)).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('does not confirm an upload after its response resolves into a cleared session', async () => {
    const { client, fetcher } = setup(json(session()), json(consent()), json(snapshot(7)), json(consent()))
    await client.login('user-a@example.test', 'synthetic'); await client.inspectSync()
    fetcher.mockResolvedValueOnce(responseThen({ revision: 8, updatedAt: now.toISOString(), replayed: false }, () => client.clear()))
    await expect(client.upload(freshState(), 7, true)).rejects.toMatchObject({ code: 'cancelled' })
    expect(client).toHaveProperty('inspectedRevision', null)
  })
  it('does not return collaboration or export data after transport resolution crosses an identity change', async () => {
    const { client, fetcher } = setup(json(session()))
    await client.login('user-a@example.test', 'synthetic')
    fetcher.mockResolvedValueOnce(responseThen({ privateData: 'synthetic' }, () => client.clear()))
    await expect(client.coachingRequest('coaching')).rejects.toMatchObject({ code: 'cancelled' })
    fetcher.mockResolvedValueOnce(json(session())); await client.login('user-a@example.test', 'synthetic')
    fetcher.mockResolvedValueOnce(responseThen({ format: 'fitflow-account-export', version: 1, exportedAt: now.toISOString(), user: session().user, consent: consent(), sync: snapshot(7, freshState()) }, () => client.clear()))
    await expect(client.exportAccount('synthetic')).rejects.toMatchObject({ code: 'cancelled' })
  })
  it.each(['register', 'requestVerification', 'confirmVerification', 'requestPasswordReset', 'confirmPasswordReset'] as const)('cancels a stale %s completion before confirming or clearing session state', async method => {
    const { client, fetcher } = setup()
    const status = method === 'register' || method === 'requestVerification' || method === 'requestPasswordReset' ? 202 : 200
    const outcome = method === 'register' ? 'verification_required' : method === 'confirmVerification' ? 'verified' : method === 'confirmPasswordReset' ? 'password_reset' : 'accepted'
    fetcher.mockResolvedValueOnce(responseThen({ status: outcome }, () => client.clear(), 2, status))
    const pending = method === 'register' ? client.register('user-a@example.test', 'synthetic') : method === 'requestVerification' ? client.requestVerification('user-a@example.test') : method === 'confirmVerification' ? client.confirmVerification('synthetic-token') : method === 'requestPasswordReset' ? client.requestPasswordReset('user-a@example.test') : client.confirmPasswordReset('synthetic-token', 'synthetic')
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(client.session).toBeNull()
  })
  it.each(['logout', 'deleteAccount'] as const)('prevents an old %s completion from clearing a newly signed-in account', async method => {
    const { client, fetcher } = setup(json(session()))
    await client.login('user-a@example.test', 'synthetic')
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = (method === 'logout' ? client.logout() : client.deleteAccount('synthetic', 'DELETE')).catch(error => error)
    fetcher.mockResolvedValueOnce(json(session('user-b')))
    await client.login('user-b@example.test', 'synthetic')
    release(new Response(null, { status: 204 }))
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(client.session?.user.id).toBe('user-b')
  })
  it.each(['logout', 'deleteAccount'] as const)('guards %s after a 204 request resolves and before its clearing continuation', async method => {
    const { client, fetcher } = setup(json(session()))
    await client.login('user-a@example.test', 'synthetic')
    let revisionAfterClear = 0
    fetcher.mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => { client.clear(); revisionAfterClear = client.sessionRevision }))
      return new Response(null, { status: 204 })
    })
    await expect(method === 'logout' ? client.logout() : client.deleteAccount('synthetic', 'DELETE')).rejects.toMatchObject({ code: 'cancelled' })
    expect(client.sessionRevision).toBe(revisionAfterClear)
  })
  it('invalidates requests started during login when that new session is established', async () => {
    const { client, fetcher } = setup()
    let finishLogin!: (value: Response) => void
    let finishVerification!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finishLogin = resolve }))
    const login = client.login('user-a@example.test', 'synthetic')
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finishVerification = resolve }))
    const verification = client.confirmVerification('synthetic-token').catch(error => error)
    finishLogin(json(session())); await login
    finishVerification(json({ status: 'verified' }))
    expect(await verification).toMatchObject({ code: 'cancelled' })
    expect(client.session?.user.id).toBe('user-a')
  })
})
