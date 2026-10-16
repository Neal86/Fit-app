import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudClient } from '../../src/cloud'
import { AiPlanClient } from '../../src/aiPlanClient'
import { applyAiPlanComposition, createAiPlanManifest, listAiPlanSources, projectAiPlanRequest, reviewAiPlanComposition } from '../../src/aiPlanComposition'
import { syntheticAiPolicy } from '../../src/testFixtures/aiPlan'
import { aiPlanPolicyDigest } from '../aiPlans.mjs'
import { setup, fixtureState } from './fixtures.mjs'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))
const fixtures = []
const tick = () => new Promise(resolve => setImmediate(resolve))
afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.close()); vi.restoreAllMocks() })
async function fixture(generate) {
  const requests = [], responses = [], providerCalls = []
  const adapter = {
    enabled: true,
    policyDigest: aiPlanPolicyDigest(syntheticAiPolicy),
    async generate(args) {
      providerCalls.push(args)
      return generate ? generate(args) : JSON.stringify({ version: 1, days: args.request.constraints.days.map(day => ({ day: day.day, candidateRefs: [args.request.candidates[0].ref] })) })
    },
  }
  const f = setup({ config: { aiPlansEnabled: true, aiPlanPolicy: syntheticAiPolicy }, aiAdapter: adapter })
  fixtures.push(f)
  vi.spyOn(Date, 'now').mockImplementation(f.now)
  const user = f.seed('independent-consent@example.test')
  // This is an in-process HTTP-shaped fixture, not a browser, native transport or network call.
  const fetcher = vi.fn(async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    headers.cookie = user.cookie
    headers['sec-fetch-site'] = 'same-origin'
    if (init.method !== 'GET') headers.origin = 'https://fitness.example.test'
    const path = new URL(url).pathname
    requests.push({ path, headers, body: init.body })
    const response = await f.app.handle({ method: init.method, path, headers, body: init.body ?? '', signal: init.signal })
    responses.push({ path, response })
    return new Response(response.status === 204 ? null : JSON.stringify(response.body), { status: response.status, headers: response.headers })
  })
  const cloud = new CloudClient('https://fitness.example.test/api/v1', fetcher)
  await cloud.checkSession()
  const client = new AiPlanClient(cloud)
  const state = fixtureState()
  state.workouts[0].exercises[0].notes = 'INDEPENDENT PRIVATE NOTE'
  state.workouts[0].exercises[0].libraryOrigin = { version: 1, entryId: 'private-orphan-entry', revision: 8 }
  state.profile.name = 'INDEPENDENT PRIVATE PROFILE'
  const manifest = createAiPlanManifest(state, [listAiPlanSources(state)[0]], {
    days: [{ day: 'Monday', plannedMinutes: 9 }], minMovementsPerDay: 1, maxMovementsPerDay: 1, maxSetsPerDay: 2, allowCrossDayRepeats: false,
  })
  const review = await client.reviewRequest(await client.inspectPolicy(), projectAiPlanRequest(manifest))
  return { ...f, requests, responses, providerCalls, client, cloud, state, manifest, review }
}

describe('independent real AI client/server consent boundary', () => {
  it('round-trips exact consent without Origin on GET and applies only the explicit local review', async () => {
    const f = await fixture()
    const before = structuredClone(f.state)
    const prepared = await f.client.prepare(f.review, true)
    expect(f.providerCalls).toHaveLength(0)
    const generated = await f.client.generate(f.review, prepared, true)
    expect(generated.status).toBe('complete')
    expect(f.providerCalls).toHaveLength(1)
    expect(f.providerCalls[0].request).toEqual(f.review.request)
    expect(f.state).toEqual(before)
    const transmitted = f.requests.filter(request => request.path.includes('/ai-plans/'))
    expect(transmitted.find(request => request.path.endsWith('/policy')).headers).not.toHaveProperty('origin')
    const prepareBody = JSON.parse(transmitted.find(request => request.path.endsWith('/prepare')).body)
    expect(Object.keys(prepareBody).sort()).toEqual(['payloadBytes', 'payloadDigest', 'policyDigest', 'policyRevision'])
    for (const secret of ['INDEPENDENT PRIVATE', 'private-orphan-entry', 'workout-1', 'exercise-1', 'notes', 'profile', 'libraryOrigin']) expect(JSON.stringify(transmitted)).not.toContain(secret)
    const review = reviewAiPlanComposition(f.state, f.manifest, generated.result, [{ day: 'Monday', title: 'Explicit local title', description: 'Explicit local description', difficulty: 'Advanced' }])
    const next = applyAiPlanComposition(f.state, review)
    expect(next.workouts[0].calories).toEqual({ version: 1, status: 'unknown' })
    expect(next.workouts[0].exercises[0]).toMatchObject({ notes: 'INDEPENDENT PRIVATE NOTE', libraryOrigin: { version: 1, entryId: 'private-orphan-entry', revision: 8 } })
    expect(next.workouts[0].exercises[0].id).not.toBe(f.state.workouts[0].exercises[0].id)
    expect(next.planHistory[0].workouts).toEqual(before.workouts)
    expect(f.state).toEqual(before)
    for (const key of ['activeSession', 'logs', 'nutrition', 'profile', 'weightHistory', 'preferences']) expect(next[key]).toBe(f.state[key])
    expect((await f.client.inspect(f.review, generated)).status).toBe('complete')
    expect(f.providerCalls).toHaveLength(1)
  })

  it('rejects a result arriving beyond the dispatch deadline before the timer callback executes', async () => {
    let release
    const f = await fixture(() => new Promise(resolve => { release = resolve }))
    const prepared = await f.client.prepare(f.review, true)
    const pending = f.client.generate(f.review, prepared, true)
    await tick()
    f.advance(15001)
    release(JSON.stringify({ version: 1, days: [{ day: 'Monday', candidateRefs: [f.review.request.candidates[0].ref] }] }))
    const outcome = await pending
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'ai_timeout' } })
    expect(outcome).not.toHaveProperty('result')
  })

  it('does not expose results after absolute retention expires before the expiry timer executes', async () => {
    let release
    const f = await fixture(() => new Promise(resolve => { release = resolve }))
    const prepared = await f.client.prepare(f.review, true)
    const pending = f.client.generate(f.review, prepared, true).catch(error => error)
    await tick()
    f.advance(600001)
    release(JSON.stringify({ version: 1, days: [{ day: 'Monday', candidateRefs: [f.review.request.candidates[0].ref] }] }))
    await pending
    const response = f.responses.findLast(row => row.path.endsWith('/generate')).response
    expect(response.body.status).toBe('expired')
    expect(response.body).not.toHaveProperty('result')
  })

  it('cancels in-flight work and rejects a provider result arriving after explicit cancellation', async () => {
    let release
    const f = await fixture(() => new Promise(resolve => { release = resolve }))
    const prepared = await f.client.prepare(f.review, true)
    const pending = f.client.generate(f.review, prepared, true)
    await tick()
    expect(f.providerCalls).toHaveLength(1)
    expect((await f.client.cancel(f.review, prepared)).status).toBe('cancelled')
    expect((await pending).status).toBe('cancelled')
    expect(f.providerCalls[0].signal.aborted).toBe(true)
    release(JSON.stringify({ version: 1, days: [{ day: 'Monday', candidateRefs: [f.review.request.candidates[0].ref] }] }))
    await tick()
    const status = await f.client.inspect(f.review, prepared)
    expect(status.status).toBe('cancelled')
    expect(status).not.toHaveProperty('result')
    expect(f.providerCalls).toHaveLength(1)
    await expect(f.client.generate(f.review, prepared, true)).rejects.toThrow()
  })
})
