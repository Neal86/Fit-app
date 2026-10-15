// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { CloudClient } from '../cloud'
import { COACHING_POLICY } from '../coaching'
import type { CoachingRelationship } from '../coaching'
import { freshState } from '../storage'
import Coaching from './Coaching'

const endpoint = 'https://app.example.test/api/v1'
const stamp = '2026-10-15T12:00:00.000Z'
const auth = (id = 'athlete') => ({ user: { id, email: `${id}@example.test`, emailVerified: true, createdAt: stamp }, csrfToken: `csrf-${id}-synthetic`, sessionExpiresAt: '2100-01-01T00:00:00.000Z' })
const relation = (overrides: Partial<CoachingRelationship> = {}): CoachingRelationship => ({ id: 'relation-1', role: 'athlete', counterpart: { id: 'coach', email: 'coach@example.test' }, status: 'active', version: 1, scopes: [], policyVersion: null, consentUpdatedAt: null, createdAt: stamp, acceptedAt: stamp, revokedAt: null, ...overrides })
const coachRelation = (scopes: CoachingRelationship['scopes'] = ['training']) => relation({ role: 'coach', counterpart: { id: 'athlete', email: 'athlete@example.test' }, scopes, policyVersion: COACHING_POLICY, consentUpdatedAt: stamp })
const invite = { id: 'invitation-1', athlete: { id: 'athlete', email: 'athlete@example.test' }, createdAt: stamp, expiresAt: '2100-01-01T00:00:00.000Z' }
const overview = (relationships = [relation()], invitations: typeof invite[] = []) => ({ policyVersion: COACHING_POLICY, coachQualificationsVerified: false, relationships, invitations })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const feedback = (text = 'Synthetic feedback') => ({ id: 'feedback-1', text, format: 'plain_text' as const, createdAt: stamp })
const feedbackResponse = (text?: string) => ({ relationshipId: 'relation-1', relationshipVersion: 1, feedback: [feedback(text)] })
const trainingSnapshot = () => {
  const state = freshState()
  state.workouts[0].title = 'Synthetic shared plan'
  state.workouts[0].exercises[0].notes = 'Private training note shared only with training scope'
  return { relationshipId: 'relation-1', relationshipVersion: 1, revision: 3, updatedAt: stamp, categories: { training: { workouts: state.workouts, logs: [], planHistory: [] } } }
}
async function setup(responses: Response[] = [], id = 'athlete') {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(auth(id)))
  responses.forEach(response => fetcher.mockResolvedValueOnce(response))
  const client = new CloudClient(endpoint, fetcher)
  await client.login(`${id}@example.test`, 'synthetic-password')
  const view = render(<Coaching client={client}/>)
  return { client, fetcher, ...view }
}
async function check() {
  fireEvent.click(screen.getByRole('button', { name: 'Check collaboration availability' }))
  await screen.findByRole('heading', { name: 'Accepted relationships' })
}
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirm collaboration action' }))
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('manual coach collaboration UI', () => {
  it('does not fetch on unconfigured, signed-out, or authenticated mount', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const disabled = render(<Coaching client={new CloudClient('', fetcher)}/>)
    expect(screen.getByText(/Cloud collaboration is not configured/)).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled(); disabled.unmount()
    const signedOut = render(<Coaching client={new CloudClient(endpoint, fetcher)}/>)
    expect(screen.getByText(/Sign in with a verified email/)).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled(); signedOut.unmount()
    const ready = await setup()
    expect(ready.fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/unverified account identity/)).toBeInTheDocument()
  })
  it('shows service-disabled errors without exposing collaboration controls or claiming setup', async () => {
    const { fetcher } = await setup([json({ error: { code: 'coaching_disabled', message: 'secret-server-detail' } }, 503)])
    fireEvent.click(screen.getByRole('button', { name: 'Check collaboration availability' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not enabled or is unavailable/)
    expect(screen.queryByRole('button', { name: 'Review invitation' })).not.toBeInTheDocument()
    expect(screen.queryByText(/secret-server-detail/)).not.toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('reviews exact invitation email, cancellation does nothing, accepted is not delivery', async () => {
    const { fetcher } = await setup([json(overview([])), json({ status: 'accepted' }, 202)])
    await check()
    fireEvent.change(screen.getByLabelText('Coach account email'), { target: { value: 'known@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review invitation' }))
    const review = screen.getByRole('region', { name: 'Review collaboration action' })
    expect(review).toHaveTextContent('known@example.test'); expect(review).toHaveTextContent(endpoint)
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Review invitation' })); confirm()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/does not confirm delivery or that an eligible account exists/))
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ email: 'known@example.test' })
  })
  it('cancels only the explicitly reviewed pending recipient email', async () => {
    const { fetcher } = await setup([json(overview([])), json({ status: 'accepted' }, 202)])
    await check(); fireEvent.change(screen.getByLabelText('Coach account email'), { target: { value: 'coach@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review cancellation for this email' })); confirm()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cancellation request accepted'))
    expect(fetcher.mock.calls[2][0]).toBe(`${endpoint}/coaching/invitations/cancel`)
    expect(screen.queryByRole('heading', { name: 'Accepted relationships' })).not.toBeInTheDocument()
  })
  it('requires recipient acceptance review and does not auto-grant or auto-fetch a snapshot', async () => {
    const accepted = coachRelation([]); accepted.policyVersion = null; accepted.consentUpdatedAt = null
    const { fetcher } = await setup([json(overview([], [invite])), json({ relationship: accepted })], 'coach')
    await check(); fireEvent.click(screen.getByRole('button', { name: 'Review acceptance' }))
    expect(screen.getByRole('region', { name: 'Review collaboration action' })).toHaveTextContent('athlete@example.test')
    confirm()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('must separately choose and confirm any data access'))
    expect(fetcher.mock.calls[2][0]).toContain('/invitations/invitation-1/accept')
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/snapshot'))).toBe(false)
  })
  it('declines only after confirmation and clears incoming invitations', async () => {
    const { fetcher } = await setup([json(overview([], [invite])), new Response(null, { status: 204 })], 'coach')
    await check(); fireEvent.click(screen.getByRole('button', { name: 'Review decline' })); confirm()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Invitation declined'))
    expect(screen.queryByRole('button', { name: 'Review acceptance' })).not.toBeInTheDocument()
    expect(fetcher.mock.calls[2][1]?.method).toBe('DELETE')
  })
  it('starts choices clear, shows exact accepted recipient and future sharing, then saves only selected scope', async () => {
    const current = relation({ scopes: ['training'], policyVersion: COACHING_POLICY, consentUpdatedAt: stamp })
    const next = relation({ version: 2, scopes: ['body'], policyVersion: COACHING_POLICY, consentUpdatedAt: stamp })
    const { fetcher } = await setup([json(overview([current])), json({ relationship: next })])
    await check(); fireEvent.click(screen.getByRole('button', { name: 'Choose categories' }))
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: /Body measurements/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Review category access' }))
    const review = screen.getByRole('region', { name: 'Review collaboration action' })
    expect(review).toHaveTextContent('coach@example.test'); expect(review).toHaveTextContent('Account ID: coach')
    expect(review).toHaveTextContent('current and future saved cloud snapshots')
    expect(within(review).getAllByRole('listitem')).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    confirm(); await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Category access saved'))
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ baseVersion: 1, policyVersion: COACHING_POLICY, scopes: ['body'] })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('requires fresh review after category cancellation and never changes server state on Cancel', async () => {
    const { fetcher } = await setup([json(overview())]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Choose categories' })); fireEvent.click(screen.getByRole('checkbox', { name: /Training plans/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Review category access' })); fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel category selection' })); fireEvent.click(screen.getByRole('button', { name: 'Choose categories' }))
    expect(screen.getAllByRole('checkbox').every(checkbox => !(checkbox as HTMLInputElement).checked)).toBe(true)
  })
  it.each([409, 403, 401])('clears data/review/drafts after a %s response and never claims a failed save', async status => {
    const { fetcher } = await setup([json(overview()), json(feedbackResponse('Sensitive retained comment')), json({ error: { code: status === 409 ? 'coaching_conflict' : status === 403 ? 'sharing_unavailable' : 'unauthenticated' } }, status)])
    await check(); fireEvent.click(screen.getByRole('button', { name: 'Read feedback' })); await screen.findByText('Sensitive retained comment')
    fireEvent.click(screen.getByRole('button', { name: 'Review revoking collaboration' })); confirm()
    await waitFor(() => expect(screen.queryByText('Sensitive retained comment')).not.toBeInTheDocument())
    if (status === 401) expect(await screen.findByText(/Sign in with a verified email/)).toBeInTheDocument()
    else expect(await screen.findByRole('alert')).toHaveTextContent(status === 409 ? /Refresh and review/ : /not allowed/)
    expect(screen.queryByRole('button', { name: 'Confirm collaboration action' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Collaboration revoked\./)).not.toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('renders only validated allowed snapshot categories and clears immediately on revoked mutation', async () => {
    const relationship = coachRelation()
    const revoked = { ...relationship, status: 'revoked', version: 2, scopes: [], revokedAt: stamp }
    const { fetcher } = await setup([json(overview([relationship])), json(trainingSnapshot())], 'coach')
    await check(); fireEvent.click(screen.getByRole('button', { name: 'Read shared cloud snapshot' })); await screen.findByText(/Synthetic shared plan/)
    expect(screen.getByText('Private training note shared only with training scope')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Shared body category' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Shared nutrition category' })).not.toBeInTheDocument()
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Review leaving collaboration' })); confirm()
    expect(screen.queryByText(/Synthetic shared plan/)).not.toBeInTheDocument()
    await act(async () => release(json({ relationship: revoked })))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Collaboration revoked'))
  })
  it('rejects unexpected body data in a training-only snapshot instead of rendering it', async () => {
    const snapshot = trainingSnapshot()
    const leaked = { ...snapshot, categories: { ...snapshot.categories, body: { measurements: { weightKg: 76, heightCm: 176 }, weightHistory: [] } } }
    await setup([json(overview([coachRelation()])), json(leaked)], 'coach'); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Read shared cloud snapshot' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be validated')
    expect(screen.queryByText(/Synthetic shared plan/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Saved weight/)).not.toBeInTheDocument()
  })
  it('renders feedback as escaped plain text and confirms removal without markup or linkification', async () => {
    const text = '<img src=x onerror=alert(1)> [example](https://example.test)'
    const { container, fetcher } = await setup([json(overview()), json(feedbackResponse(text)), new Response(null, { status: 204 })])
    await check(); fireEvent.click(screen.getByRole('button', { name: 'Read feedback' })); expect(await screen.findByText(text)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull(); expect(container.querySelector('a')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review removing feedback' })); fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(fetcher).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: 'Review removing feedback' })); confirm()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Feedback removal confirmed'))
    expect(screen.queryByText(text)).not.toBeInTheDocument()
  })
  it('reviews exact feedback and suppresses duplicate confirmation while a save is pending', async () => {
    const { fetcher } = await setup([json(overview([coachRelation()]))], 'coach'); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Write feedback' }))
    fireEvent.change(screen.getByLabelText('Plain-text feedback'), { target: { value: 'Synthetic training comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review feedback' }))
    const review = screen.getByRole('region', { name: 'Review collaboration action' })
    expect(review).toHaveTextContent('athlete@example.test'); expect(review).toHaveTextContent('Synthetic training comment')
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const button = screen.getByRole('button', { name: 'Confirm collaboration action' }); fireEvent.click(button); fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(3)
    await act(async () => release(json({ relationshipVersion: 1, feedback: feedback('Synthetic training comment'), replayed: false }, 201)))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Plain-text feedback saved'))
    expect(screen.queryByLabelText('Plain-text feedback')).not.toBeInTheDocument()
    expect(fetcher.mock.calls[2][1]?.body).toContain('operationId')
  })
  it('offers no feedback sending without training scope and keeps revoke-era athlete feedback readable', async () => {
    const view = await setup([json(overview([coachRelation(['body'])]))], 'coach'); await check()
    expect(screen.queryByRole('button', { name: 'Write feedback' })).not.toBeInTheDocument(); view.unmount()
    const revoked = relation({ status: 'revoked', version: 2, revokedAt: stamp })
    await setup([json(overview([revoked])), json({ ...feedbackResponse(), relationshipVersion: 2 })]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Read feedback' })); await screen.findByText('Synthetic feedback')
    expect(screen.getByRole('button', { name: 'Review removing feedback' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Choose categories' })).not.toBeInTheDocument()
  })
  it('clears displayed records synchronously on logout and same-account reauthentication', async () => {
    const { client, fetcher } = await setup([json(overview()), json(feedbackResponse('Private displayed feedback'))]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Read feedback' })); await screen.findByText('Private displayed feedback')
    act(() => client.clear())
    expect(screen.queryByText('Private displayed feedback')).not.toBeInTheDocument()
    expect(screen.getByText(/Sign in with a verified email/)).toBeInTheDocument()
    fetcher.mockResolvedValueOnce(json(auth()))
    await act(async () => { await client.login('athlete@example.test', 'synthetic') })
    expect(screen.queryByRole('heading', { name: 'Accepted relationships' })).not.toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('ignores a late read after account switching or unmount and never persists health data', async () => {
    const { client, fetcher, unmount } = await setup([json(overview([coachRelation()]))], 'coach'); await check()
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Read shared cloud snapshot' }))
    fetcher.mockResolvedValueOnce(json(auth('other')))
    await act(async () => { await client.login('other@example.test', 'synthetic') })
    await act(async () => release(json(trainingSnapshot())))
    expect(screen.queryByText(/Synthetic shared plan/)).not.toBeInTheDocument()
    unmount(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('requires another refresh after an unconfirmed network write', async () => {
    const { fetcher } = await setup([json(overview())]); await check()
    fetcher.mockRejectedValueOnce(new Error('synthetic offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose categories' })); fireEvent.click(screen.getByRole('button', { name: 'Review category access' })); confirm()
    expect(await screen.findByRole('alert')).toHaveTextContent('outcome is not confirmed')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check collaboration availability' })).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('drops in-flight data after unmount and does not write or request on cleanup', async () => {
    const { fetcher, unmount } = await setup([json(overview([coachRelation()]))], 'coach'); await check()
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Read shared cloud snapshot' }))
    unmount()
    await act(async () => release(json(trainingSnapshot())))
    expect(screen.queryByText(/Synthetic shared plan/)).not.toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('clears private records at session expiry without any background request', async () => {
    const { client, fetcher } = await setup([json(overview()), json(feedbackResponse('Private expiring feedback'))]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Read feedback' })); await screen.findByText('Private expiring feedback')
    vi.useFakeTimers(); vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    // Any authenticated action also notices expiry and synchronously publishes the identity change.
    await act(async () => { await client.coachingRequest('coaching').catch(() => undefined) })
    expect(screen.queryByText('Private expiring feedback')).not.toBeInTheDocument()
    expect(screen.getByText(/Sign in with a verified email/)).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

})

it.each(['snapshot', 'feedback'] as const)('requires a fresh %s read after a hidden-and-returned tab, even if the old request completes later', async kind => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { fetcher } = await setup([json(overview([coachRelation()]))], 'coach'); await check()
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const button = kind === 'snapshot' ? 'Read shared cloud snapshot' : 'Read feedback'
  fireEvent.click(screen.getByRole('button', { name: button }))
  act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
  act(() => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
  const response = kind === 'snapshot' ? trainingSnapshot() : feedbackResponse('Private delayed feedback')
  await act(async () => release(json(response)))
  expect(screen.queryByRole('region', { name: 'Displayed collaborator data' })).not.toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(3)
  // A new explicit action can read again; returning to the tab itself sends nothing.
  fetcher.mockResolvedValueOnce(json(response))
  fireEvent.click(screen.getByRole('button', { name: button }))
  expect(await screen.findByRole('region', { name: 'Displayed collaborator data' })).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it('uses the viewer preference for read-only body and training data without widening shared data or changing nutrition units', async () => {
  const state = freshState(); const kgPerLb = 0.45359237
  const snapshot = {
    relationshipId: 'relation-1', relationshipVersion: 1, revision: 3, updatedAt: stamp,
    categories: {
      training: { workouts: state.workouts, planHistory: [], logs: [{ id: 'shared-log', workoutId: state.workouts[0].id, title: 'Shared workout', startedAt: stamp, completedAt: stamp, duration: 1, calories: 1, completedExerciseIds: [], sets: [{ id: 'shared-set', exerciseId: state.workouts[0].exercises[0].id, setNumber: 1, reps: 8, weightKg: 100 * kgPerLb, seconds: null, rpe: null, warmup: false, completed: true }] }] },
      body: { measurements: { weightKg: 150 * kgPerLb, heightCm: 70 * 2.54 }, weightHistory: [{ id: 'shared-weight', date: '2026-10-15', weightKg: 150 * kgPerLb }] },
      nutrition: { ...state.nutrition, hydration: [{ id: 'water', date: '2026-10-15', milliliters: 250, note: '' }] },
    },
  }
  const { client, fetcher, rerender } = await setup([json(overview([coachRelation(['training', 'body', 'nutrition'])])), json(snapshot)], 'coach')
  rerender(<Coaching client={client} unit="imperial"/>); await check()
  fireEvent.click(screen.getByRole('button', { name: 'Read shared cloud snapshot' }))
  expect(await screen.findByText('Saved weight: 150 lb · Height: 70 in')).toBeInTheDocument()
  expect(screen.getByText('2026-10-15: 150 lb')).toBeInTheDocument()
  expect(screen.getByText(/Set 1: 8 reps · 100 lb/)).toBeInTheDocument()
  expect(screen.getByText(/2026-10-15 · 250 ml/)).toBeInTheDocument()
  rerender(<Coaching client={client} unit="metric"/>)
  expect(screen.getByText('Saved weight: 68.04 kg · Height: 177.8 cm')).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(snapshot.categories.body.measurements.weightKg).toBe(150 * kgPerLb)
})
