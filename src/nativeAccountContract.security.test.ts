import { describe, expect, it } from 'vitest'
import {
  NATIVE_ACCOUNT_LIMITS, NativeAccountContractError,
  readNativeAccountReply, readNativeAccountRequest, type NativeAccountMethod,
} from './nativeAccountContract'

const contextId = '61e3b018-8dc6-4c06-a518-5da0a2f63197'
const requestId = '3daf23bf-150f-4c11-ac34-9bea4b33602d'
const id = '399ed4af-f297-4469-b787-49343e23f4a8'
const now = Date.parse('2026-10-16T00:00:00.000Z')
const rawToken = 'r'.repeat(43)
const session = {
  user: { id, email: 'review@example.test', emailVerified: true, createdAt: '2026-10-15T00:00:00.000Z' },
  csrfToken: 'c'.repeat(64), sessionExpiresAt: '2026-10-16T08:00:00.000Z',
}
const command = (method: NativeAccountMethod, path: string, body: unknown = {}) => readNativeAccountRequest({
  version: 1, contextId, requestId, method, path, ...(method === 'GET' ? {} : { body }),
})
const response = (status: number, body: unknown) => ({ version: 1, contextId, requestId, status, body })

const nonSessionReplies: [NativeAccountMethod, string, number][] = [
  ['POST', 'auth/register', 202], ['POST', 'auth/verification/request', 202],
  ['POST', 'auth/verification/confirm', 200], ['POST', 'auth/password-reset/request', 202],
  ['POST', 'auth/password-reset/confirm', 200], ['GET', 'consent', 200], ['PUT', 'consent', 200],
  ['GET', 'sync', 200], ['PUT', 'sync', 200], ['POST', 'account/export', 200],
  ['GET', 'coaching', 200], ['POST', 'coaching/invitations', 202],
  ['POST', `coaching/invitations/${id}/accept`, 200], ['GET', `coaching/relationships/${id}/snapshot`, 200],
  ['GET', `coaching/relationships/${id}/feedback`, 200], ['POST', `coaching/relationships/${id}/feedback`, 201],
  ['GET', 'challenges', 200], ['POST', 'challenges/invitations', 202],
  ['POST', `challenges/invitations/${id}/accept`, 200], ['GET', `challenges/${id}/counts`, 200],
]

describe('independent native reply credential-boundary probes', () => {
  it.each(nonSessionReplies)('%s %s cannot return a raw login or credential envelope', (method, path, status) => {
    const request = command(method, path)
    for (const body of [rawToken, JSON.stringify({ session, nativeToken: rawToken }), [rawToken], [{ session, nativeToken: rawToken }], null, 42]) {
      expect(() => readNativeAccountReply(response(status, body), request, now)).toThrow(NativeAccountContractError)
    }
    for (const field of ['nativeToken', 'NativeToken', 'authorization', 'Authorization', 'headers', 'cookies', 'password']) {
      const body = { session, [field]: rawToken }
      expect(() => readNativeAccountReply(response(status, body), request, now)).toThrow(NativeAccountContractError)
      try { readNativeAccountReply(response(status, body), request, now) } catch (error) {
        expect(String(error)).not.toContain(rawToken)
        expect(String(error)).not.toContain(session.user.email)
      }
    }
  })

  it('does not confuse harmless domain text with credential-envelope field names', () => {
    const request = command('GET', 'sync')
    const body = { revision: 2, state: { profile: { name: 'NativeToken is a synthetic label' }, notes: 'A password is never needed in workout notes' }, updatedAt: null }
    const result = readNativeAccountReply(response(200, body), request, now)
    expect(result.body).toEqual(body)
    expect(result.body).not.toBe(body)
    expect(Object.isFrozen(result.body)).toBe(true)
  })

  it('keeps command input isolated from mutation before validating the correlated reply', () => {
    const source = { version: 1, contextId, requestId, method: 'POST', path: 'auth/login', body: { email: 'review@example.test', password: 'synthetic-only-password' } }
    const captured = readNativeAccountRequest(source)
    source.contextId = '4f1f5732-53da-4802-9a83-1990ee0d05bb'
    source.requestId = '2d088ef8-3258-4570-bbdd-39b772671c3b'
    source.path = 'account/export'
    source.body.password = 'different synthetic input'
    const accepted = readNativeAccountReply(response(200, session), captured, now)
    expect(accepted.contextId).toBe(contextId)
    expect(accepted.requestId).toBe(requestId)
    expect(captured.path).toBe('auth/login')
    expect(captured.body).toEqual({ email: 'review@example.test', password: 'synthetic-only-password' })
    expect(() => readNativeAccountReply({ ...response(200, session), contextId: source.contextId }, captured, now)).toThrow(NativeAccountContractError)
  })

  it('matches the exact server request budgets and rejects one extra encoded byte', () => {
    expect(NATIVE_ACCOUNT_LIMITS.requestBytes).toBe(8192)
    expect(NATIVE_ACCOUNT_LIMITS.snapshotBytes).toBe(10 * 1024 * 1024 + 1024)
    const overhead = JSON.stringify({ data: '' }).length
    const exact = { data: 'x'.repeat(8192 - overhead) }
    expect(command('POST', 'auth/login', exact).body).toEqual(exact)
    expect(() => command('POST', 'auth/login', { data: `${exact.data}x` })).toThrow(NativeAccountContractError)
    // Multibyte UTF-8 and JSON-escaped characters must count against the same budget.
    expect(() => command('POST', 'auth/login', { data: 'é'.repeat(4096) })).toThrow(NativeAccountContractError)
    expect(() => command('POST', 'auth/login', { data: '\0'.repeat(1366) })).toThrow(NativeAccountContractError)
  })
})
