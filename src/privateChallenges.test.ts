// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Capacitor } from '@capacitor/core'
import { CloudClient } from './cloud'
import { CHALLENGE_METRIC, CHALLENGE_POLICY, PrivateChallengeClient, challengeWindow, invitationWindow, readChallengeAccountExport, readChallengeCounts, readChallengeOverview, readPrivateChallenge } from './privateChallenges'
import type { PrivateChallenge } from './privateChallenges'

const endpoint = 'https://app.example.test/api/v1'
const stamp = '2026-10-15T12:00:00.000Z'
const auth = (id = 'self', verified = true) => ({ user: { id, email: `${id}@example.test`, emailVerified: verified, createdAt: stamp }, csrfToken: `csrf-${id}-synthetic`, sessionExpiresAt: '2100-01-01T00:00:00.000Z' })
const window = { startDate: '2026-10-15', endDate: '2026-10-21' }
const challenge = (overrides: Partial<PrivateChallenge> = {}): PrivateChallenge => ({ id: 'challenge-1', role: 'inviter', counterpart: { id: 'peer', email: 'peer@example.test' }, ...window, status: 'active', version: 2, ownConsent: false, peerConsent: false, policyVersion: CHALLENGE_POLICY, createdAt: stamp, acceptedAt: stamp, expiresAt: '2026-10-29T00:00:00.000Z', revokedAt: null, ...overrides })
const invitation = () => ({ id: 'challenge-1', inviter: { id: 'peer', email: 'peer@example.test' }, ...window, version: 1, createdAt: stamp, expiresAt: '2026-10-22T00:00:00.000Z' })
const overview = (challenges = [challenge()]) => ({ policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC, invitations: [], challenges })
const granted = () => challenge({ ownConsent: true, peerConsent: true })
const counts = () => ({ challengeId: 'challenge-1', challengeVersion: 2, metric: CHALLENGE_METRIC, selfReported: true, ownRecordedDays: 4, peerRecordedDays: null })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
async function setup(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(auth()))
  responses.forEach(response => fetcher.mockResolvedValueOnce(response))
  const cloud = new CloudClient(endpoint, fetcher)
  await cloud.login('self@example.test', 'synthetic-password')
  return { cloud, api: new PrivateChallengeClient(cloud), fetcher }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(stamp)); localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('private count-only challenge transport', () => {
  it('sends no request on construction, missing/unsafe configuration, signed-out or unverified contexts', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const config of ['', 'http://insecure.test/api', 'https://app.test/api?secret=x']) {
      const cloud = new CloudClient(config, fetcher)
      const api = new PrivateChallengeClient(cloud)
      await expect(api.overview()).rejects.toMatchObject({ code: 'session_expired' })
    }
    const cloud = new CloudClient(endpoint, fetcher)
    await expect(cloud.challengeRequest('challenges')).rejects.toMatchObject({ code: 'session_expired' })
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockResolvedValueOnce(json(auth('self', false))); await cloud.login('self@example.test', 'synthetic')
    await expect(new PrivateChallengeClient(cloud).overview()).rejects.toMatchObject({ code: 'email_unverified' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('keeps native access disabled even when configured', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    const fetcher = vi.fn<typeof fetch>(); const cloud = new CloudClient(endpoint, fetcher)
    expect(cloud.configured).toBe(false)
    await expect(cloud.login('self@example.test', 'synthetic')).rejects.toMatchObject({ code: 'not_configured' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('allowlists every route and method, uses current CSRF, no cache, no redirects or referrer', async () => {
    const { cloud, api, fetcher } = await setup(json(overview()), json({ status: 'accepted' }, 202))
    for (const path of ['auth/login', '/challenges', 'challenges?owner=other', 'challenges/../account', 'challenges/%2e%2e/counts', 'https://evil.test/challenges', 'challenges/challenge-1/snapshot']) await expect(cloud.challengeRequest(path)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(cloud.challengeRequest('challenges', 'POST')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(cloud.challengeRequest('challenges', 'GET', undefined, 201)).rejects.toMatchObject({ code: 'invalid_request' })
    await api.overview(); await api.invite(' PEER@Example.Test ', window, true)
    for (const [, options] of fetcher.mock.calls.slice(1)) expect(options).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'X-CSRF-Token': auth().csrfToken } })
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ email: 'peer@example.test', ...window })
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('requires explicit confirmation for each mutation, before transmitting any data', async () => {
    const { api, fetcher } = await setup()
    const actions = [() => api.invite('peer@example.test', window, false), () => api.accept(invitation(), false), () => api.decline(invitation(), false), () => api.consent(challenge(), false), () => api.revoke(challenge(), 'revoke', false), () => api.revoke(challenge(), 'leave', false), () => api.block(challenge(), false), () => api.block(invitation(), false)]
    for (const action of actions) await expect(action()).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('accepts a generic invitation response without returning an outgoing recipient receipt', async () => {
    const { api } = await setup(json({ status: 'accepted' }, 202))
    expect(await api.invite('unknown@example.test', window, true)).toBeUndefined()
  })
  it('binds acceptance to the invited ID, email, window and zero count access', async () => {
    const accepted = challenge({ role: 'invitee' })
    const { api, fetcher } = await setup(json({ challenge: accepted }))
    expect(await api.accept(invitation(), true)).toEqual(accepted)
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ baseVersion: 1 })
    for (const changed of [{ ...accepted, id: 'different' }, { ...accepted, counterpart: { id: 'other', email: 'other@example.test' } }, { ...accepted, counterpart: { id: 'peer', email: 'other@example.test' } }, { ...accepted, endDate: '2026-10-22' }, { ...accepted, ownConsent: true }, { ...accepted, peerConsent: true }, { ...accepted, version: 1 }, { ...accepted, role: 'inviter' }]) {
      const fixture = await setup(json({ challenge: changed }))
      await expect(fixture.api.accept(invitation(), true)).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })
  it('sends the exact reviewed recipient, metric, UTC window and positive version for consent', async () => {
    const next = challenge({ ownConsent: true, version: 3 })
    const { api, fetcher } = await setup(json({ challenge: next }))
    expect(await api.consent(challenge(), true)).toEqual(next)
    expect(fetcher.mock.calls[1][0]).toBe(`${endpoint}/challenges/challenge-1/consent`)
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ baseVersion: 2, policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC, ...window, shareTrainingDays: true, recipient: challenge().counterpart })
    expect(String(fetcher.mock.calls[1][1]?.body)).not.toMatch(/workouts|logs|nutrition|weightKg|snapshot|reps/)
  })
  it('rejects consent response identity, immutable metadata or version substitution', async () => {
    const next = challenge({ ownConsent: true, version: 3 })
    for (const result of [{ ...next, version: 2 }, { ...next, peerConsent: true }, { ...next, startDate: '2026-10-14' }, { ...next, createdAt: '2026-10-14T12:00:00.000Z' }, { ...next, acceptedAt: '2026-10-15T13:00:00.000Z' }, { ...next, expiresAt: '2026-10-30T00:00:00.000Z' }, { ...next, counterpart: { id: 'self', email: 'self@example.test' } }, { ...next, ownConsent: false }]) {
      const { api } = await setup(json({ challenge: result }))
      await expect(api.consent(challenge(), true)).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })
  it('declines, leaves, revokes and blocks only the reviewed positive version', async () => {
    const revoked = challenge({ status: 'revoked', version: 3, revokedAt: stamp })
    const { api, fetcher } = await setup(new Response(null, { status: 204 }), json({ challenge: revoked }), json({ challenge: revoked }), new Response(null, { status: 204 }), new Response(null, { status: 204 }))
    await api.decline(invitation(), true); await api.revoke(challenge(), 'leave', true); await api.revoke(challenge(), 'revoke', true); await api.block(challenge(), true); await api.block(invitation(), true)
    expect(fetcher.mock.calls.slice(1).map(([url]) => url)).toEqual([`${endpoint}/challenges/invitations/challenge-1`, `${endpoint}/challenges/challenge-1`, `${endpoint}/challenges/challenge-1/consent`, `${endpoint}/challenges/challenge-1/block`, `${endpoint}/challenges/challenge-1/block`])
    expect(fetcher.mock.calls.slice(1).map(([, options]) => JSON.parse(String(options?.body)))).toEqual([{ baseVersion: 1 }, { baseVersion: 2 }, { baseVersion: 2 }, { baseVersion: 2 }, { baseVersion: 1 }])
  })
  it('reads counts only for both grants and current active expiry', async () => {
    const { api, fetcher } = await setup(json(counts()))
    await expect(api.counts(challenge())).rejects.toMatchObject({ code: 'challenge_conflict' })
    await expect(api.counts(granted())).resolves.toEqual(counts())
    vi.setSystemTime(new Date('2026-10-29T00:00:00.000Z'))
    await expect(api.counts(granted())).rejects.toMatchObject({ code: 'challenge_conflict' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([409, 403, 503])('does not retry a %s error or disclose the server body', async status => {
    const { api, fetcher } = await setup(json({ error: { code: 'challenge_conflict', message: 'private-server-secret' } }, status))
    await expect(api.overview()).rejects.toMatchObject({ status })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([401, 403])('notifies all shared-session consumers on authentication invalidation (%s)', async status => {
    const { cloud, api } = await setup(json({ error: { code: status === 401 ? 'unauthenticated' : 'csrf_failed' } }, status))
    const callback = vi.fn(); cloud.subscribeSession(callback)
    await expect(api.overview()).rejects.toMatchObject({ status })
    expect(cloud.session).toBeNull(); expect(callback).toHaveBeenCalledTimes(1)
  })
  it.each(['overview', 'counts', 'consent'] as const)('rejects delayed %s after switching the shared account', async action => {
    const { cloud, api, fetcher } = await setup()
    let release!: (response: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = (action === 'overview' ? api.overview() : action === 'counts' ? api.counts(granted()) : api.consent(challenge(), true)).catch(error => error)
    fetcher.mockResolvedValueOnce(json(auth('other')))
    await cloud.login('other@example.test', 'synthetic')
    release(json(action === 'overview' ? overview() : action === 'counts' ? counts() : { challenge: challenge({ ownConsent: true, version: 3 }) }))
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(cloud.session?.user.id).toBe('other')
  })
  it.each(['overview', 'counts', 'consent'] as const)('rechecks the session at the %s adapter boundary after transport returns', async action => {
    const { cloud, api, fetcher } = await setup()
    const value = action === 'overview' ? overview() : action === 'counts' ? counts() : { challenge: challenge({ ownConsent: true, version: 3 }) }
    const response = json(value)
    vi.spyOn(response, 'text').mockImplementation(async () => { queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => cloud.clear()))); return JSON.stringify(value) })
    fetcher.mockResolvedValueOnce(response)
    await expect(action === 'overview' ? api.overview() : action === 'counts' ? api.counts(granted()) : api.consent(challenge(), true)).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('strict private challenge validators', () => {
  it('accepts real inclusive windows of one through 31 dates, rejects normalization and invalid ranges', () => {
    expect(challengeWindow('2028-02-29', '2028-02-29')).toEqual({ startDate: '2028-02-29', endDate: '2028-02-29' })
    expect(challengeWindow('2026-10-01', '2026-10-31')).toBeDefined()
    for (const [start, end] of [['2026-02-29', '2026-03-01'], ['2026-10-01', '2026-11-01'], ['2026-10-21', '2026-10-15'], ['2026-1-01', '2026-01-01'], ['2026-10-15Z', '2026-10-15']]) expect(() => challengeWindow(start, end)).toThrow()
    expect(() => invitationWindow('2026-10-01', '2026-10-14')).toThrow()
    expect(() => invitationWindow('9999-12-24', '9999-12-24')).toThrow()
  })
  it('rejects extra fields, duplicate IDs, self identities, unknown metrics and oversized lists', () => {
    for (const value of [{ ...overview(), count: 3 }, { ...overview(), metric: 'calories' }, overview([challenge(), challenge()]), overview([challenge({ counterpart: { id: 'self', email: 'self@example.test' } })]), overview(Array(51).fill(challenge())), { ...overview(), invitations: [invitation()] }]) expect(() => readChallengeOverview(value, 'self')).toThrow()
    expect(readChallengeOverview(overview(), 'self')).toEqual(overview())
  })
  it('rejects invalid versions, noncanonical timestamps, impossible terminal grants and extra identity fields', () => {
    for (const value of [challenge({ version: 0 }), challenge({ version: -1 }), challenge({ version: Number.MAX_SAFE_INTEGER + 1 }), challenge({ version: 2.5 }), challenge({ createdAt: '2026-02-30T12:00:00.000Z' }), challenge({ createdAt: '2026-10-15T12:00:00Z' }), challenge({ status: 'revoked' }), challenge({ status: 'expired', ownConsent: true }), challenge({ status: 'expired', peerConsent: true }), challenge({ status: 'expired', revokedAt: stamp }), { ...challenge(), counterpart: { ...challenge().counterpart, weight: 80 } }, { ...challenge(), snapshotRevision: 3 }]) expect(() => readPrivateChallenge(value, 'self')).toThrow()
  })
  it('rejects unexpected count fields, unverified claims, stale versions and numbers outside the immutable window', () => {
    for (const value of [{ ...counts(), selfReported: false }, { ...counts(), revision: 3 }, { ...counts(), dates: ['2026-10-15'] }, { ...counts(), challengeId: 'other' }, { ...counts(), challengeVersion: 3 }, { ...counts(), metric: 'weight_loss' }, { ...counts(), ownRecordedDays: -1 }, { ...counts(), ownRecordedDays: 8 }, { ...counts(), peerRecordedDays: 0.5 }, { ...counts(), ownRecordedDays: '1' }, { ...counts(), ownRecordedDays: undefined }]) expect(() => readChallengeCounts(value, granted())).toThrow()
    expect(readChallengeCounts({ ...counts(), ownRecordedDays: 0, peerRecordedDays: 7 }, granted())).toMatchObject({ ownRecordedDays: 0, peerRecordedDays: 7 })
  })
})

describe('own historical challenge account export', () => {
  function history() { const { counterpart: _counterpart, peerConsent: _peerConsent, policyVersion: _policyVersion, ...item } = challenge(); void _counterpart; void _peerConsent; void _policyVersion; return { policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC, challenges: [item] } }
  const exported = (challenges?: unknown) => ({ format: 'fitflow-account-export', version: 1, exportedAt: stamp, user: auth().user, consent: { healthSync: false, policyVersion: CHALLENGE_POLICY, updatedAt: stamp }, sync: { revision: 0, state: null, updatedAt: null }, ...(challenges === undefined ? {} : { challenges }) })
  it('supports optional own-only history and legacy exports with no challenge field', async () => {
    const { cloud } = await setup(json(exported(history())), json(exported()))
    expect((await cloud.exportAccount('synthetic')).challenges).toEqual(history())
    expect((await cloud.exportAccount('synthetic')).challenges).toBeUndefined()
  })
  it('rejects counterpart identities, peer consent, invitations, block lists, counts and snapshots in historical data', () => {
    const valid = history()
    for (const value of [{ ...valid, invitations: [] }, { ...valid, blocks: [] }, { ...valid, challenges: [challenge()] }, { ...valid, challenges: [{ ...valid.challenges[0], counterpart: challenge().counterpart }] }, { ...valid, challenges: [{ ...valid.challenges[0], peerConsent: false }] }, { ...valid, challenges: [{ ...valid.challenges[0], ownRecordedDays: 1 }] }, { ...valid, challenges: [{ ...valid.challenges[0], snapshot: {} }] }, { ...valid, challenges: [...valid.challenges, ...valid.challenges] }]) expect(() => readChallengeAccountExport(value)).toThrow()
  })
  it('rejects invalid optional historical envelopes instead of silently dropping them', async () => {
    const { cloud } = await setup(json(exported({ ...history(), metric: 'weight' })))
    await expect(cloud.exportAccount('synthetic')).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

it('requires the exact boolean true rather than a truthy runtime confirmation', async () => {
  const { api, fetcher } = await setup()
  for (const value of [1, 'true', {}, []]) await expect(api.consent(challenge(), value as unknown as boolean)).rejects.toMatchObject({ code: 'confirmation_required' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('accepts idempotent terminal expired deletion and ceiling-version privacy revocation', async () => {
  const expired = challenge({ status: 'expired' })
  const ceiling = challenge({ version: Number.MAX_SAFE_INTEGER, ownConsent: true, peerConsent: true })
  const revoked = { ...ceiling, status: 'revoked', ownConsent: false, peerConsent: false, revokedAt: stamp }
  const { api } = await setup(json({ challenge: expired }), json({ challenge: revoked }))
  await expect(api.revoke(expired, 'leave', true)).resolves.toBeUndefined()
  await expect(api.revoke(ceiling, 'revoke', true)).resolves.toBeUndefined()
})
