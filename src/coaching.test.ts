// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudClient } from './cloud'
import { COACHING_POLICY, CoachingClient, coachingFeedbackText, readCoachingSnapshot, readOverview, readRelationship } from './coaching'
import type { CoachingRelationship } from './coaching'
import { freshState, parseBackup } from './storage'
import { finishSession, startSession } from './session'

const endpoint = 'https://app.example.test/api/v1'
const stamp = '2026-10-15T12:00:00.000Z'
const auth = (id = 'athlete', verified = true) => ({ user: { id, email: `${id}@example.test`, emailVerified: verified, createdAt: stamp }, csrfToken: `csrf-${id}-secret`, sessionExpiresAt: '2100-01-01T00:00:00.000Z' })
const relation = (overrides: Partial<CoachingRelationship> = {}): CoachingRelationship => ({ id: 'relation-1', role: 'athlete', counterpart: { id: 'coach', email: 'coach@example.test' }, status: 'active', version: 1, scopes: [], policyVersion: null, consentUpdatedAt: null, createdAt: stamp, acceptedAt: stamp, revokedAt: null, ...overrides })
const granted = (scopes: CoachingRelationship['scopes'] = ['training']) => relation({ role: 'coach', counterpart: { id: 'athlete', email: 'athlete@example.test' }, scopes, policyVersion: COACHING_POLICY, consentUpdatedAt: stamp })
const overview = (relationships = [relation()]) => ({ policyVersion: COACHING_POLICY, coachQualificationsVerified: false, invitations: [], relationships })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const response = (relationship = granted(), categories: unknown = { training: { workouts: freshState().workouts, logs: [], planHistory: [] } }) => ({ relationshipId: relationship.id, relationshipVersion: relationship.version, revision: 4, updatedAt: stamp, categories })
async function setup(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(auth()))
  responses.forEach(value => fetcher.mockResolvedValueOnce(value))
  const cloud = new CloudClient(endpoint, fetcher); await cloud.login('athlete@example.test', 'synthetic-password')
  return { cloud, api: new CoachingClient(cloud), fetcher }
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => vi.restoreAllMocks())

describe('coaching transport and strict contract', () => {
  it('sends nothing on construction or without configuration, session, or email verification', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const disabled = new CoachingClient(new CloudClient('', fetcher))
    await expect(disabled.overview()).rejects.toMatchObject({ code: 'session_expired' })
    const cloud = new CloudClient(endpoint, fetcher)
    new CoachingClient(cloud)
    await expect(cloud.coachingRequest('coaching')).rejects.toMatchObject({ code: 'session_expired' })
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockResolvedValueOnce(json(auth('athlete', false))); await cloud.login('athlete@example.test', 'synthetic')
    await expect(new CoachingClient(cloud).overview()).rejects.toMatchObject({ code: 'email_unverified' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects paths outside the allowlist and uses authenticated CSRF with no-store on reads and writes', async () => {
    const { cloud, api, fetcher } = await setup(json(overview()), json({ status: 'accepted' }, 202))
    for (const path of ['auth/login', '/coaching', 'coaching/../account', 'coaching?secret=x', 'coaching/relationships/%2e%2e/snapshot', 'https://evil.test/coaching']) await expect(cloud.coachingRequest(path)).rejects.toMatchObject({ code: 'invalid_request' })
    await api.overview(); await api.invite(' Coach@Example.Test ', true)
    expect(fetcher).toHaveBeenCalledTimes(3)
    for (const [, options] of fetcher.mock.calls.slice(1)) expect(options).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'X-CSRF-Token': auth().csrfToken } })
    expect(fetcher.mock.calls[2][1]?.body).toBe(JSON.stringify({ email: 'coach@example.test' }))
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('requires confirmation before every sharing or destructive mutation', async () => {
    const { api, fetcher } = await setup()
    const invitation = { id: 'invite-1', athlete: { id: 'athlete', email: 'athlete@example.test' }, createdAt: stamp, expiresAt: '2100-01-01T00:00:00.000Z' }
    const feedback = { id: 'feedback-1', text: 'Synthetic feedback', format: 'plain_text' as const, createdAt: stamp }
    const actions = [() => api.invite('coach@example.test', false), () => api.cancelInvite('coach@example.test', false), () => api.accept(invitation, false), () => api.decline(invitation, false), () => api.consent(relation(), ['body'], false), () => api.revoke(relation(), false), () => api.sendFeedback(granted(), 'Synthetic text', false), () => api.removeFeedback(relation(), feedback, false)]
    for (const action of actions) await expect(action()).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('sends recipient-bound reviewed categories with CAS but never device health state', async () => {
    const next = relation({ version: 2, scopes: ['body'], policyVersion: COACHING_POLICY, consentUpdatedAt: stamp })
    const { api, fetcher } = await setup(json({ relationship: next }))
    await expect(api.consent(relation(), ['body'], true)).resolves.toEqual(next)
    expect(fetcher.mock.calls[1][0]).toBe(`${endpoint}/coaching/relationships/relation-1/consent`)
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ baseVersion: 1, policyVersion: COACHING_POLICY, scopes: ['body'] })
    expect(String(fetcher.mock.calls[1][1]?.body)).not.toMatch(/workouts|weightKg|nutrition.*meals/)
  })
  it('rejects malformed relationships, qualified-coach claims and substituted counterparts', async () => {
    expect(() => readOverview({ ...overview(), coachQualificationsVerified: true }, 'athlete')).toThrow()
    expect(() => readOverview({ ...overview(), secret: 'not allowed' }, 'athlete')).toThrow()
    for (const broken of [relation({ scopes: ['training'] }), relation({ status: 'revoked', revokedAt: stamp, scopes: ['training'] }), relation({ version: -1 }), { ...relation(), activeSession: {} }, relation({ scopes: ['body', 'body'], policyVersion: COACHING_POLICY, consentUpdatedAt: stamp })]) expect(() => readRelationship(broken)).toThrow()
    const { api } = await setup(json({ relationship: relation({ counterpart: { id: 'other', email: 'other@example.test' }, version: 2 }) }))
    await expect(api.consent(relation(), [], true)).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('independently validates exact category projections and rejects private category leakage', () => {
    const base = freshState()
    const training = { workouts: base.workouts, logs: [], planHistory: [] }
    const body = { measurements: { weightKg: 70, heightCm: 170 }, weightHistory: [] }
    expect(readCoachingSnapshot(response(granted(), { training }), granted()).categories).toHaveProperty('training')
    expect(readCoachingSnapshot(response(granted(['body']), { body }), granted(['body'])).categories).toEqual({ body })
    expect(readCoachingSnapshot(response(granted(['nutrition']), { nutrition: base.nutrition }), granted(['nutrition'])).categories).toEqual({ nutrition: base.nutrition })
    for (const categories of [{ training, body }, { training, activeSession: null }, { training: { ...training, preferences: {} } }, { training: { ...training, workouts: [{ ...base.workouts[0], privateExtra: 'secret' }] } }, { training: { ...training, logs: [{ id: 'bad' }] } }, {}]) expect(() => readCoachingSnapshot(response(granted(), categories), granted())).toThrow()
    expect(() => readCoachingSnapshot(response(granted(['body']), { body: { ...body, measurements: { ...body.measurements, birthYear: 1990 } } }), granted(['body']))).toThrow()
    expect(() => readCoachingSnapshot(response(granted(['nutrition']), { nutrition: { ...base.nutrition, profile: {} } }), granted(['nutrition']))).toThrow()
  })
  it('rejects a different or stale relationship version in snapshot/feedback responses', async () => {
    expect(() => readCoachingSnapshot({ ...response(), relationshipVersion: 2 }, granted())).toThrow(/changed/)
    expect(() => readCoachingSnapshot({ ...response(), relationshipId: 'other' }, granted())).toThrow(/changed/)
    const { api } = await setup(json({ relationshipId: 'relation-1', relationshipVersion: 2, feedback: [] }))
    await expect(api.feedback(relation())).rejects.toMatchObject({ code: 'coaching_conflict' })
  })
  it.each([undefined, [], ['barbell', 'bench']])('rejects equipment %j in coach plan and previous-plan responses even though private state accepts it', equipment => {
    for (const previous of [false, true]) {
      const base = freshState()
      base.planHistory = [{ id: 'plan-1', label: 'Previous plan', savedAt: stamp, workouts: structuredClone(base.workouts) }]
      const workouts = previous ? base.planHistory[0].workouts : base.workouts
      Object.assign(workouts[0].exercises[0], { equipment })
      const categories = { training: { workouts: base.workouts, logs: base.logs, planHistory: base.planHistory } }
      expect(() => readCoachingSnapshot(response(granted(), categories), granted())).toThrow('could not be validated')
    }
  })
  it.each([undefined, null, { version: 1, groups: [] }, 'valid'])('rejects session grouping %j from coach training logs, including valid private metadata', grouping => {
    const base = freshState()
    const session = startSession(base.workouts[0], Date.parse(stamp) - 60_000)
    const rows = [session.sets[0], session.sets.find(row => row.exerciseId !== session.sets[0].exerciseId)!]
    rows[0].completed = true; rows[0].reps = 8
    const log = finishSession(session, Date.parse(stamp))
    Object.assign(log, { grouping: grouping === 'valid' ? { version: 1, groups: [{ id: 'private-group', name: 'Private grouping marker', restSeconds: 35, rounds: [{ id: 'private-round', setIds: rows.map(row => row.id) }] }] } : grouping })
    const categories = { training: { workouts: base.workouts, logs: [log], planHistory: [] } }
    expect(() => readCoachingSnapshot(response(granted(), categories), granted())).toThrow('could not be validated')
    delete (log as unknown as Record<string, unknown>).grouping
    expect(readCoachingSnapshot(response(granted(), categories), granted()).categories.training?.logs).toEqual([log])
  })
  it.each([undefined, null, { version: 1, groups: [] }, { version: 2, groups: [] }, 'valid'])('rejects planned grouping %j from current and historical coach plans', plannedGrouping => {
    for (const previous of [false, true]) {
      const base = freshState()
      base.planHistory = [{ id: 'plan-1', label: 'Previous plan', savedAt: stamp, workouts: structuredClone(base.workouts) }]
      const workout = (previous ? base.planHistory[0].workouts : base.workouts)[0]
      Object.assign(workout, { plannedGrouping: plannedGrouping === 'valid' ? {
        version: 1, groups: [{ id: 'private-planned-group', name: 'Private future-session label', restSeconds: 25,
          rounds: [{ id: 'private-planned-round', members: workout.exercises.slice(0, 2).map(exercise => ({ exerciseId: exercise.id, setNumber: 1 })) }] }],
      } : plannedGrouping })
      if (plannedGrouping === 'valid') expect(parseBackup(JSON.stringify(base))).toEqual(base)
      const categories = { training: { workouts: base.workouts, logs: [], planHistory: base.planHistory } }
      expect(() => readCoachingSnapshot(response(granted(), categories), granted())).toThrow('could not be validated')
      delete (workout as unknown as Record<string, unknown>).plannedGrouping
      expect(readCoachingSnapshot(response(granted(), categories), granted()).categories.training).toEqual(categories.training)
    }
  })
  it('does not retry conflicts or failed writes and reports disabled service truthfully', async () => {
    const { api, fetcher } = await setup(json({ error: { code: 'coaching_conflict' } }, 409), json({ error: { code: 'coaching_disabled' } }, 503))
    await expect(api.consent(relation(), [], true)).rejects.toMatchObject({ status: 409 })
    await expect(api.overview()).rejects.toMatchObject({ code: 'coaching_disabled', status: 503 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('accepts generic invitation/cancellation responses without claiming delivery', async () => {
    const { api, fetcher } = await setup(json({ status: 'accepted' }, 202), json({ status: 'accepted' }, 202))
    await api.invite('unknown@example.test', true); await api.cancelInvite('unknown@example.test', true)
    expect(fetcher.mock.calls[2][0]).toBe(`${endpoint}/coaching/invitations/cancel`)
  })
  it('limits plaintext feedback and refuses coach feedback without active training access', async () => {
    for (const text of [' ', '<script>oops</script>', 'https://example.test', '[link](example.test)', 'www.example.test', 'mailto:example@example.test', 'ftp://example.test', '[link] (example.test)', '\u202etext', 'x'.repeat(2001), '\u0000text', '界'.repeat(1500)]) expect(() => coachingFeedbackText(text)).toThrow()
    expect(coachingFeedbackText('  Synthetic comment\nSecond line  ')).toBe('Synthetic comment\nSecond line')
    const { api, fetcher } = await setup()
    await expect(api.sendFeedback(granted(['body']), 'Comment', true)).rejects.toMatchObject({ code: 'coaching_conflict' })
    await expect(api.feedback(granted([]))).rejects.toMatchObject({ code: 'coaching_conflict' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('notifies session identity changes including same-account login, and unsubscribes', async () => {
    const { cloud, fetcher } = await setup()
    const listener = vi.fn(); const unsubscribe = cloud.subscribeSession(listener)
    const before = cloud.sessionRevision
    cloud.clear(); expect(cloud.sessionRevision).toBeGreaterThan(before); expect(listener).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValueOnce(json(auth())); await cloud.login('athlete@example.test', 'synthetic')
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe(); cloud.clear(); expect(listener).toHaveBeenCalledTimes(3)
  })
  it('cancels delayed collaboration responses after logout/account switching', async () => {
    const { cloud, api, fetcher } = await setup()
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = api.overview().catch(error => error)
    cloud.clear(); release(json(overview()))
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(cloud.session).toBeNull()
  })
})

describe('coaching account export', () => {
  const item = { id: 'feedback-1', text: 'Own retained feedback', format: 'plain_text', createdAt: stamp }
  const envelope = () => ({ ...overview(), feedback: [{ relationshipId: 'relation-1', items: [item] }] })
  const exported = (coaching: unknown) => ({ format: 'fitflow-account-export', version: 1, exportedAt: stamp, user: auth().user, consent: { healthSync: false, policyVersion: COACHING_POLICY, updatedAt: stamp }, sync: { revision: 0, state: null, updatedAt: null }, coaching })
  it('preserves and validates optional own collaboration metadata and feedback', async () => {
    const { cloud } = await setup(json(exported(envelope())))
    expect((await cloud.exportAccount('synthetic-password')).coaching).toEqual(envelope())
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('rejects unrelated groups, duplicate records, shared snapshots and revoked coach feedback', async () => {
    const bad = [
      { ...envelope(), snapshot: freshState() },
      { ...envelope(), feedback: [{ relationshipId: 'unrelated', items: [item] }] },
      { ...envelope(), feedback: [{ relationshipId: 'relation-1', items: [item, item] }] },
      { ...envelope(), feedback: [...envelope().feedback, ...envelope().feedback] },
      { ...envelope(), relationships: [relation({ role: 'coach', counterpart: { id: 'another', email: 'another@example.test' }, status: 'revoked', revokedAt: stamp })] },
    ]
    for (const coaching of bad) {
      const { cloud } = await setup(json(exported(coaching)))
      await expect(cloud.exportAccount('synthetic-password')).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })
  it('retains athlete feedback after revocation without allowing a counterpart snapshot', async () => {
    const coaching = { ...envelope(), relationships: [relation({ status: 'revoked', revokedAt: stamp })] }
    const { cloud } = await setup(json(exported(coaching)))
    expect((await cloud.exportAccount('synthetic-password')).coaching?.feedback[0].items[0].text).toBe('Own retained feedback')
  })
})

it.each(['overview', 'snapshot', 'feedback'] as const)('checks identity again at the coaching %s adapter boundary after authenticated transport returns', async method => {
  const { cloud, api, fetcher } = await setup()
  const value = method === 'overview' ? overview() : method === 'snapshot' ? response() : { relationshipId: 'relation-1', relationshipVersion: 1, feedback: [] }
  const result = json(value)
  vi.spyOn(result, 'text').mockImplementation(async () => {
    // Third hop: request and CloudClient.coachingRequest have returned; the adapter has not.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => cloud.clear())))
    return JSON.stringify(value)
  })
  fetcher.mockResolvedValueOnce(result)
  const pending = method === 'overview' ? api.overview() : method === 'snapshot' ? api.snapshot(granted()) : api.feedback(relation())
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  expect(cloud.session).toBeNull()
})
