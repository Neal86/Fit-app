// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import Account from './Account'
import { CloudClient, HEALTH_SYNC_POLICY } from '../cloud'
import { freshState } from '../storage'
import * as storage from '../storage'
import { startSession } from '../session'

const endpoint = 'https://app.example.test/api/v1'
const stamp = '2026-10-15T12:00:00.000Z'
const auth = { user: { id: 'person-a', email: 'person-a@example.test', emailVerified: true, createdAt: stamp }, csrfToken: 'memory-only-csrf-token', sessionExpiresAt: '2100-01-01T00:00:00.000Z' }
const consent = (healthSync = true) => ({ healthSync, policyVersion: HEALTH_SYNC_POLICY, updatedAt: stamp })
const snapshot = (revision = 2, state: unknown = freshState()) => ({ revision, state, updatedAt: stamp })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function setup(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
  responses.forEach(response => fetcher.mockResolvedValueOnce(response))
  const client = new CloudClient(endpoint, fetcher)
  const onRestore = vi.fn(() => true)
  const state = freshState()
  const view = render(<Account state={state} onRestore={onRestore} client={client}/>)
  return { fetcher, client, onRestore, state, ...view }
}
async function login() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person-a@example.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-only-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in securely' }))
  await screen.findByRole('heading', { name: 'person-a@example.test' })
}
async function checkAndInspect() {
  fireEvent.click(screen.getByRole('button', { name: 'Check cloud consent' }))
  await screen.findByRole('button', { name: 'Inspect cloud copy' })
  fireEvent.click(screen.getByRole('button', { name: 'Inspect cloud copy' }))
  await screen.findByRole('button', { name: 'Review upload' })
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('account and manual sync UI', () => {
  it('is local-only without configuration and sends nothing on a configured page visit', () => {
    const fetcher = vi.fn<typeof fetch>()
    const view = render(<Account state={freshState()} onRestore={() => true} client={new CloudClient('', fetcher)}/>)
    expect(screen.getByText(/Cloud accounts are not configured/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in securely' })).not.toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
    view.unmount()
    const configured = setup()
    expect(screen.getByText(endpoint)).toBeInTheDocument()
    expect(configured.fetcher).not.toHaveBeenCalled()
  })
  it('requires a checked recipient-specific consent before enabling, and never auto-uploads', async () => {
    const { fetcher } = setup(json(auth), json(consent()))
    await login()
    expect(screen.queryByRole('button', { name: 'Inspect cloud copy' })).not.toBeInTheDocument()
    const enable = screen.getByRole('button', { name: 'Enable cloud consent' })
    expect(enable).toBeDisabled()
    expect(screen.getByRole('checkbox').textContent).toBe('')
    fireEvent.click(screen.getByRole('checkbox', { name: /I consent to sending these health-data categories to https:\/\/app.example.test\/api\/v1/ }))
    fireEvent.click(enable)
    await screen.findByText(/Cloud consent enabled. No health data has been uploaded/)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toBe(`${endpoint}/consent`)
    expect(String(fetcher.mock.calls[1][1]?.body)).not.toContain('"state"')
  })
  it('clears submitted passwords and requires explicit review confirmation before each upload', async () => {
    const { fetcher } = setup(json(auth), json(consent()), json(consent()), json(snapshot(2, null)), json(consent()), json({ revision: 3, updatedAt: stamp, replayed: false }))
    await login(); await checkAndInspect()
    fireEvent.click(screen.getByRole('button', { name: 'Review upload' }))
    expect(screen.getByRole('heading', { name: 'Confirm health-data upload' })).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(4)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fetcher).toHaveBeenCalledTimes(4)
    fireEvent.click(screen.getByRole('button', { name: 'Review upload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm upload to cloud' }))
    await screen.findByText(/Cloud upload confirmed at revision 3/)
    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(screen.queryByRole('button', { name: 'Review upload' })).not.toBeInTheDocument()
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('discloses active and archived library entries before an explicit manual upload', async () => {
    const current = setup(json(auth), json(consent()), json(consent()), json(snapshot(2, null)), json(consent()), json({ revision: 3, updatedAt: stamp, replayed: false }))
    const exercise = { name: 'Synthetic personal entry', category: '', sets: 2, reps: '8', restSeconds: 20, notes: 'Manual private note' }
    current.state.exerciseLibrary = { version: 1, entries: ['active', 'archived'].map((status, index) => ({ id: `private-library-${index}`, revision: 1, status: status as 'active' | 'archived', createdAt: stamp, updatedAt: stamp, exercise: { ...exercise } })) }
    current.rerender(<Account state={current.state} onRestore={current.onRestore} client={current.client}/>)
    await login(); await checkAndInspect()
    expect(screen.getByText(/Transfers include.*active and archived personal library entries with their notes and targets/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review upload' }))
    expect(screen.getAllByText(/1 active and 1 archived personal library entries/).length).toBeGreaterThan(0)
    expect(screen.getByText(/The personal library and copied ancestry are also omitted/)).toBeInTheDocument()
    expect(current.fetcher).toHaveBeenCalledTimes(4)
    expect(current.fetcher.mock.calls.every(([, init]) => !String(init?.body).includes('Manual private note'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm upload to cloud' }))
    await screen.findByText(/Cloud upload confirmed at revision 3/)
    const body = JSON.parse(String(current.fetcher.mock.calls[5][1]?.body))
    expect(body.state.exerciseLibrary).toEqual(current.state.exerciseLibrary)
  })
  it('drops stale review after a conflict and requires reinspection and a new choice', async () => {
    const { fetcher } = setup(json(auth), json(consent()), json(consent()), json(snapshot(2)), json(consent()), json({ error: { code: 'sync_conflict', details: { revision: 3 } } }, 409))
    await login(); await checkAndInspect()
    fireEvent.click(screen.getByRole('button', { name: 'Review upload' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm upload to cloud' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The cloud copy changed')
    expect(screen.queryByRole('button', { name: 'Confirm upload to cloud' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review upload' })).not.toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
  it('rejects malformed cloud state before offering restore or touching local data', async () => {
    const { onRestore } = setup(json(auth), json(consent()), json(consent()), json(snapshot(2, { version: 3 })))
    await login()
    fireEvent.click(screen.getByRole('button', { name: 'Check cloud consent' })); await screen.findByRole('button', { name: 'Inspect cloud copy' })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect cloud copy' }))
    await screen.findByRole('alert')
    expect(onRestore).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Review restore' })).not.toBeInTheDocument()
  })
  it('restores only after confirmation, revalidates the revision, and pauses the active timer', async () => {
    const cloudState = freshState(); cloudState.activeSession = startSession(cloudState.workouts[0], Date.now() - 60000); cloudState.activeSession.elapsedSeconds = 10
    const { onRestore, fetcher } = setup(json(auth), json(consent()), json(consent()), json(snapshot(2, cloudState)), json(consent()), json(snapshot(2, cloudState)))
    await login(); await checkAndInspect()
    fireEvent.click(screen.getByRole('button', { name: 'Review restore' }))
    expect(onRestore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRestore).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(4)
    fireEvent.click(screen.getByRole('button', { name: 'Review restore' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm replace device data' }))
    await screen.findByText('Cloud copy restored to this device. Any active workout is paused.')
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore.mock.calls[0]).toEqual([expect.objectContaining({ activeSession: expect.objectContaining({ elapsedSeconds: 10, runningSince: null, restUntil: null }) })])
  })
  it('never claims a successful restore if the atomic local transaction fails', async () => {
    const { onRestore } = setup(json(auth), json(consent()), json(consent()), json(snapshot()), json(consent()), json(snapshot()))
    onRestore.mockReturnValue(false)
    await login(); await checkAndInspect()
    fireEvent.click(screen.getByRole('button', { name: 'Review restore' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm replace device data' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not restored because device storage failed')
    expect(screen.queryByText('Cloud copy restored to this device. Any active workout is paused.')).not.toBeInTheDocument()
  })
  it('does not replace local data if the cloud revision changes during restore review', async () => {
    const { onRestore } = setup(json(auth), json(consent()), json(consent()), json(snapshot(2)), json(consent()), json(snapshot(3)))
    await login(); await checkAndInspect()
    fireEvent.click(screen.getByRole('button', { name: 'Review restore' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm replace device data' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('cloud copy changed during review')
    expect(onRestore).not.toHaveBeenCalled()
  })
  it('requires confirmation for revocation, clears cloud views, and keeps the account and local data', async () => {
    const { onRestore, client, fetcher } = setup(json(auth), json(consent()), json(consent()), json(snapshot()), json(consent(false)))
    await login(); await checkAndInspect()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke consent & delete cloud copy' }))
    expect(fetcher).toHaveBeenCalledTimes(4)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke and delete' }))
    await screen.findByText(/Cloud consent revoked and the server snapshot deleted/)
    expect(client.session?.user.id).toBe('person-a')
    expect(screen.queryByRole('button', { name: 'Review upload' })).not.toBeInTheDocument()
    expect(onRestore).not.toHaveBeenCalled()
  })
  it('clears account/review when the session expires and sends no pending upload', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(stamp))
    const expiring = { ...auth, sessionExpiresAt: new Date(Date.now() + 60000).toISOString() }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(expiring)).mockResolvedValueOnce(json(consent())).mockResolvedValueOnce(json(consent())).mockResolvedValueOnce(json(snapshot()))
    const client = new CloudClient(endpoint, fetcher)
    await client.login('person-a@example.test', 'synthetic-password')
    render(<Account state={freshState()} onRestore={() => true} client={client}/>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check cloud consent' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Inspect cloud copy' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Review upload' }))
    expect(screen.getByRole('heading', { name: 'Confirm health-data upload' })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(60001) })
    expect(screen.getByRole('alert')).toHaveTextContent('Your session has expired')
    expect(screen.queryByRole('button', { name: 'Confirm upload to cloud' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in securely' })).toBeInTheDocument()
    expect(client.session).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('clears cloud metadata on unauthorized requests and reports adapter-disabled honestly', async () => {
    const { client } = setup(json(auth), json({ error: { code: 'unauthenticated' } }, 401), json({ error: { code: 'email_unavailable', message: 'do not display this' } }, 503))
    await login(); fireEvent.click(screen.getByRole('button', { name: 'Check cloud consent' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('session has expired')
    expect(client.session).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person-a@example.test' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reset email' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not enabled or is unavailable')
    expect(screen.queryByText('do not display this')).not.toBeInTheDocument()
  })
  it('supports manual verification and reset tokens without reading or persisting URLs', async () => {
    const { fetcher } = setup(json({ status: 'verified' }), json({ status: 'password_reset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }))
    fireEvent.change(screen.getByLabelText('Verification token'), { target: { value: 'one-time-verification-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email verification' }))
    await screen.findByText('Email verified. Sign in to continue.')
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
    fireEvent.change(screen.getByLabelText('Reset token'), { target: { value: 'one-time-reset-token' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'synthetic-new-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new password' }))
    await screen.findByText('Password reset confirmed. Sign in with your new password.')
    expect(fetcher.mock.calls[1][0]).toBe(`${endpoint}/auth/password-reset/confirm`)
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
    expect(screen.getByLabelText('Password')).toHaveValue('')
  })
  it('clears password immediately on submit and blocks double submits while awaiting a result', async () => {
    let resolve!: (response: Response) => void
    const { fetcher } = setup()
    fetcher.mockReturnValueOnce(new Promise(done => { resolve = done }))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person-a@example.test' } }); fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'synthetic-password' } })
    const submit = screen.getByRole('button', { name: 'Sign in securely' })
    fireEvent.click(submit); fireEvent.click(submit)
    expect(screen.getByLabelText('Password')).toHaveValue(''); expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(json(auth)) })
    await screen.findByRole('heading', { name: 'person-a@example.test' })
  })
  it('prevents a pending restore from applying after leaving the account route', async () => {
    const { fetcher, onRestore, unmount } = setup(json(auth), json(consent()), json(consent()), json(snapshot()))
    await login(); await checkAndInspect()
    let resolve!: (response: Response) => void
    fetcher.mockReturnValueOnce(new Promise(done => { resolve = done }))
    fireEvent.click(screen.getByRole('button', { name: 'Review restore' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm replace device data' }))
    unmount()
    await act(async () => { resolve(json(consent())) })
    expect(onRestore).not.toHaveBeenCalled()
  })
  it('requires typed deletion and password, clears auth, and retains all device data', async () => {
    const { client, onRestore } = setup(json(auth), new Response(null, { status: 204 }))
    await login()
    const remove = screen.getByRole('button', { name: 'Permanently delete cloud account' })
    expect(remove).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } }); expect(remove).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Confirm account password'), { target: { value: 'synthetic-password' } }); fireEvent.click(remove)
    await screen.findByText('Cloud account deleted. Your device data is unchanged.')
    expect(client.session).toBeNull(); expect(onRestore).not.toHaveBeenCalled()
  })
  it('exports full sensitive data only after the export form is submitted', async () => {
    const download = vi.spyOn(storage, 'downloadText').mockImplementation(() => undefined)
    const exported = { format: 'fitflow-account-export', version: 1, exportedAt: stamp, user: auth.user, consent: consent(), sync: snapshot() }
    setup(json(auth), json(exported)); await login()
    expect(download).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Confirm account password'), { target: { value: 'synthetic-password' } }); fireEvent.click(screen.getByRole('button', { name: 'Download full account export' }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(JSON.parse(download.mock.calls[0][0])).toMatchObject(exported)
    expect(screen.getByLabelText('Confirm account password')).toHaveValue('')
  })
})

it('clears the account view when a collaborator request invalidates the shared session', async () => {
  const { client, fetcher } = setup(json(auth), json(consent()), json(consent()), json(snapshot()))
  await login(); await checkAndInspect()
  fireEvent.click(screen.getByRole('button', { name: 'Review restore' }))
  fireEvent.change(screen.getByLabelText('Confirm account password'), { target: { value: 'synthetic-secret' } })
  act(() => client.clear())
  expect(screen.getByRole('button', { name: 'Sign in securely' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Confirm device replacement' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Cloud revision 2/)).not.toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it('does not reuse health-data review after same-account reauthentication', async () => {
  const { client, fetcher } = setup(json(auth), json(consent()), json(consent()), json(snapshot()), json({ ...auth, csrfToken: 'new-session-csrf-token' }))
  await login(); await checkAndInspect()
  fireEvent.click(screen.getByRole('button', { name: 'Review upload' }))
  await act(async () => { await client.login(auth.user.email, 'synthetic-new-login') })
  expect(screen.getByRole('heading', { name: auth.user.email })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Confirm health-data upload' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Review upload' })).not.toBeInTheDocument()
  expect(screen.getByText('Consent: not checked')).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(5)
})

it('cancels local restore if the session clears between transport and consumer completion', async () => {
  const saved = snapshot()
  const { client, fetcher, onRestore } = setup(json(auth), json(consent()), json(consent()), json(saved))
  await login(); await checkAndInspect()
  fireEvent.click(screen.getByRole('button', { name: 'Review restore' }))
  const last = json(saved)
  vi.spyOn(last, 'text').mockImplementation(async () => {
    queueMicrotask(() => queueMicrotask(() => client.clear()))
    return JSON.stringify(saved)
  })
  fetcher.mockResolvedValueOnce(json(consent())).mockResolvedValueOnce(last)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm replace device data' }))
  await screen.findByRole('button', { name: 'Sign in securely' })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(client.session).toBeNull()
  expect(onRestore).not.toHaveBeenCalled()
})

it('does not download an account export after a consumer-boundary session invalidation', async () => {
  const download = vi.spyOn(storage, 'downloadText').mockImplementation(() => undefined)
  const exported = { format: 'fitflow-account-export', version: 1, exportedAt: stamp, user: auth.user, consent: consent(), sync: snapshot() }
  const { client, fetcher } = setup(json(auth)); await login()
  const last = json(exported)
  vi.spyOn(last, 'text').mockImplementation(async () => {
    queueMicrotask(() => queueMicrotask(() => client.clear()))
    return JSON.stringify(exported)
  })
  fetcher.mockResolvedValueOnce(last)
  fireEvent.change(screen.getByLabelText('Confirm account password'), { target: { value: 'synthetic-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Download full account export' }))
  await screen.findByRole('button', { name: 'Sign in securely' })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(download).not.toHaveBeenCalled()
})

const privateChallenge = () => ({ id: 'challenge-1', role: 'inviter', counterpart: { id: 'peer', email: 'peer@example.test' }, startDate: '2099-10-15', endDate: '2099-10-21', status: 'active', version: 2, ownConsent: true, peerConsent: true, policyVersion: HEALTH_SYNC_POLICY, createdAt: stamp, acceptedAt: stamp, expiresAt: '2099-10-29T00:00:00.000Z', revokedAt: null })
const privateOverview = () => ({ policyVersion: HEALTH_SYNC_POLICY, metric: 'recorded_training_days', invitations: [], challenges: [privateChallenge()] })
const privateCounts = () => ({ challengeId: 'challenge-1', challengeVersion: 2, metric: 'recorded_training_days', selfReported: true, ownRecordedDays: 4, peerRecordedDays: 3 })

it('keeps private challenge controls collapsed and request-free after account login', async () => {
  const { fetcher } = setup(json(auth)); await login()
  expect(screen.getByRole('button', { name: 'Open private challenge controls' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Check private challenge availability' })).not.toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([401, 403])('clears Account and Coaching private views when a challenge request invalidates the shared session (%s)', async status => {
  const relationship = { id: 'relation-1', role: 'athlete', counterpart: { id: 'coach', email: 'coach@example.test' }, status: 'active', version: 1, scopes: [], policyVersion: null, consentUpdatedAt: null, createdAt: stamp, acceptedAt: stamp, revokedAt: null }
  const coachingOverview = { policyVersion: HEALTH_SYNC_POLICY, coachQualificationsVerified: false, invitations: [], relationships: [relationship] }
  const feedback = { relationshipId: 'relation-1', relationshipVersion: 1, feedback: [{ id: 'feedback-1', text: 'Synthetic private coaching feedback', format: 'plain_text', createdAt: stamp }] }
  const { fetcher } = setup(json(auth), json(consent()), json(consent()), json(snapshot()), json(coachingOverview), json(feedback), json({ error: { code: status === 401 ? 'unauthenticated' : 'csrf_failed' } }, status))
  await login(); await checkAndInspect()
  fireEvent.click(screen.getByRole('button', { name: 'Check collaboration availability' })); await screen.findByRole('heading', { name: 'Accepted relationships' })
  fireEvent.click(screen.getByRole('button', { name: 'Read feedback' })); await screen.findByText('Synthetic private coaching feedback')
  fireEvent.click(screen.getByRole('button', { name: 'Review restore' }))
  fireEvent.change(screen.getByLabelText('Confirm account password'), { target: { value: 'synthetic-private-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open private challenge controls' }))
  fireEvent.click(screen.getByRole('button', { name: 'Check private challenge availability' }))
  await screen.findByRole('button', { name: 'Sign in securely' })
  expect(screen.queryByText('Synthetic private coaching feedback')).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Confirm device replacement' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Cloud revision 2/)).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Accepted private challenges' })).not.toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(7)
})

it('invalidates a pending private count read before cloud-consent revocation and never revives it', async () => {
  const { fetcher } = setup(json(auth), json(consent()), json(privateOverview()))
  await login(); fireEvent.click(screen.getByRole('button', { name: 'Check cloud consent' })); await screen.findByRole('button', { name: 'Inspect cloud copy' })
  fireEvent.click(screen.getByRole('button', { name: 'Open private challenge controls' })); fireEvent.click(screen.getByRole('button', { name: 'Check private challenge availability' })); await screen.findByRole('heading', { name: 'Accepted private challenges' })
  let releaseCounts!: (response: Response) => void
  let releaseRevoke!: (response: Response) => void
  fetcher.mockImplementationOnce(() => new Promise(resolve => { releaseCounts = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' }))
  fetcher.mockImplementationOnce(() => new Promise(resolve => { releaseRevoke = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Revoke consent & delete cloud copy' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke and delete' }))
  expect(screen.queryByRole('heading', { name: 'Accepted private challenges' })).not.toBeInTheDocument()
  await act(async () => releaseCounts(json(privateCounts())))
  expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument()
  await act(async () => releaseRevoke(json(consent(false))))
  expect(await screen.findByText('Cloud consent revoked and the server snapshot deleted. Your device data is unchanged.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open private challenge controls' })).toBeInTheDocument()
  expect(screen.queryByText('4 days')).not.toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(5)
})

it('discloses effects of a manual cloud upload on separately consented private challenge counts', async () => {
  setup(json(auth), json(consent()), json(consent()), json(snapshot()))
  await login(); await checkAndInspect(); fireEvent.click(screen.getByRole('button', { name: 'Review upload' }))
  expect(screen.getByRole('region', { name: 'Confirm health-data upload' })).toHaveTextContent('Private challenge partners with both current grants can read updated training-day counts for the reviewed UTC windows')
})

it('discloses saved equipment requirements in consent and upload while excluding temporary selections and coach views', async () => {
  setup(json(auth), json(consent()), json(consent()), json(snapshot()))
  await login()
  expect(screen.getByText(/Transfers include your training plans/)).toHaveTextContent('including saved exercise equipment requirements')
  await checkAndInspect(); fireEvent.click(screen.getByRole('button', { name: 'Review upload' }))
  const review = screen.getByRole('region', { name: 'Confirm health-data upload' })
  expect(review).toHaveTextContent('saved exercise equipment requirements')
  expect(review).toHaveTextContent('Temporary available-equipment selections are not uploaded')
  expect(review).toHaveTextContent('Equipment requirements are omitted from coach views')
})
