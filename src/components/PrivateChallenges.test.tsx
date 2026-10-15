// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { CloudClient } from '../cloud'
import { CHALLENGE_METRIC, CHALLENGE_POLICY } from '../privateChallenges'
import type { PrivateChallenge } from '../privateChallenges'
import PrivateChallenges from './PrivateChallenges'

const endpoint = 'https://app.example.test/api/v1'
const stamp = '2026-10-15T12:00:00.000Z'
const dates = { startDate: '2099-10-15', endDate: '2099-10-21' }
const auth = (id = 'self') => ({ user: { id, email: `${id}@example.test`, emailVerified: true, createdAt: stamp }, csrfToken: `csrf-${id}-synthetic`, sessionExpiresAt: '2100-01-01T00:00:00.000Z' })
const challenge = (overrides: Partial<PrivateChallenge> = {}): PrivateChallenge => ({ id: 'challenge-1', role: 'inviter', counterpart: { id: 'peer', email: 'peer@example.test' }, ...dates, status: 'active', version: 2, ownConsent: false, peerConsent: false, policyVersion: CHALLENGE_POLICY, createdAt: stamp, acceptedAt: stamp, expiresAt: '2099-10-29T00:00:00.000Z', revokedAt: null, ...overrides })
const invitation = { id: 'challenge-1', inviter: { id: 'peer', email: 'peer@example.test' }, ...dates, version: 1, createdAt: stamp, expiresAt: '2099-10-22T00:00:00.000Z' }
const overview = (challenges = [challenge()], invitations: typeof invitation[] = []) => ({ policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC, invitations, challenges })
const granted = () => challenge({ ownConsent: true, peerConsent: true })
const counts = () => ({ challengeId: 'challenge-1', challengeVersion: 2, metric: CHALLENGE_METRIC, selfReported: true, ownRecordedDays: 4, peerRecordedDays: null })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
async function setup(responses: Response[] = []) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(auth()))
  responses.forEach(value => fetcher.mockResolvedValueOnce(value))
  const client = new CloudClient(endpoint, fetcher)
  await client.login('self@example.test', 'synthetic-password')
  const view = render(<PrivateChallenges client={client}/>)
  return { client, fetcher, ...view }
}
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open private challenge controls' }))
async function check() {
  open(); fireEvent.click(screen.getByRole('button', { name: 'Check private challenge availability' }))
  await screen.findByRole('heading', { name: 'Accepted private challenges' })
}
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirm private challenge action' }))
const review = () => screen.getByRole('region', { name: 'Review private challenge action' })
function invitationForm() {
  fireEvent.change(screen.getByLabelText('Counterpart account email'), { target: { value: 'known@example.test' } })
  fireEvent.change(screen.getByLabelText('UTC start date'), { target: { value: dates.startDate } })
  fireEvent.change(screen.getByLabelText('UTC end date'), { target: { value: dates.endDate } })
}
function consentForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose private count sharing' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Review private count consent' }))
}
function retainedClick(button: HTMLElement): () => void {
  const property = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
  const props = (button as unknown as Record<string, { onClick: () => void }>)[property]
  return props.onClick
}
function hideAndReturn(visibility: ReturnType<typeof vi.spyOn>) {
  act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
  act(() => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('private consistency challenge controls', () => {
  it('has zero requests on unconfigured, signed-out, collapsed and expanded mounts', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const disabled = render(<PrivateChallenges client={new CloudClient('', fetcher)}/>)
    expect(screen.getByText(/No private challenge requests are sent/)).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled(); disabled.unmount()
    const signedOut = render(<PrivateChallenges client={new CloudClient(endpoint, fetcher)}/>)
    expect(screen.getByText(/Sign in with a verified email/)).toBeInTheDocument(); expect(fetcher).not.toHaveBeenCalled(); signedOut.unmount()
    const ready = await setup(); expect(ready.fetcher).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Check private challenge availability' })).not.toBeInTheDocument()
    open(); expect(ready.fetcher).toHaveBeenCalledTimes(1)
  })
  it('shows a disabled-service error with no private controls or secret server body', async () => {
    await setup([json({ error: { code: 'challenges_disabled', message: 'private-server-secret' } }, 503)])
    open(); fireEvent.click(screen.getByRole('button', { name: 'Check private challenge availability' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not enabled or is unavailable/)
    expect(screen.queryByRole('button', { name: 'Review private invitation' })).not.toBeInTheDocument()
    expect(screen.queryByText('private-server-secret')).not.toBeInTheDocument()
  })
  it('reviews the exact email/window and Cancel sends nothing before a separately confirmed invitation', async () => {
    const { fetcher } = await setup([json(overview([])), json({ status: 'accepted' }, 202)])
    await check(); invitationForm(); fireEvent.click(screen.getByRole('button', { name: 'Review private invitation' }))
    expect(review()).toHaveTextContent('known@example.test'); expect(review()).toHaveTextContent(dates.startDate); expect(review()).toHaveTextContent(dates.endDate); expect(review()).toHaveTextContent(endpoint)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel private challenge action' }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Review private invitation' })); confirm()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/does not confirm delivery or that an eligible account exists/))
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ email: 'known@example.test', ...dates })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('requires acceptance review and shares no count or consent by acceptance', async () => {
    const { fetcher } = await setup([json(overview([], [invitation])), json({ challenge: challenge({ role: 'invitee' }) })])
    await check(); fireEvent.click(screen.getByRole('button', { name: 'Review private acceptance' }))
    expect(review()).toHaveTextContent('peer@example.test'); expect(review()).toHaveTextContent('Account ID: peer'); expect(review()).toHaveTextContent('Acceptance alone shares no count')
    confirm(); await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('accepted with no count access'))
    expect(fetcher.mock.calls[2][0]).toContain('/invitations/challenge-1/accept')
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/counts') || String(url).endsWith('/consent'))).toBe(false)
  })
  it('starts consent unchecked and reviews exact identity, immutable window, metric and future manually saved copies', async () => {
    const { fetcher } = await setup([json(overview([granted()])), json({ challenge: challenge({ ownConsent: true, peerConsent: true, version: 3 }) })])
    await check(); fireEvent.click(screen.getByRole('button', { name: 'Choose private count sharing' }))
    expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Review private count consent' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Review private count consent' }))
    expect(review()).toHaveTextContent('Account ID: peer'); expect(review()).toHaveTextContent(dates.startDate); expect(review()).toHaveTextContent(dates.endDate); expect(review()).toHaveTextContent('future manually uploaded changes'); expect(review()).toHaveTextContent('non-warmup'); expect(review()).toHaveTextContent('unverified')
    expect(fetcher).toHaveBeenCalledTimes(2); confirm()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('count-sharing consent was saved'))
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ baseVersion: 2, policyVersion: CHALLENGE_POLICY, metric: CHALLENGE_METRIC, ...dates, shareTrainingDays: true, recipient: { id: 'peer', email: 'peer@example.test' } })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('requires fresh unchecked consent after cancelling review', async () => {
    const { fetcher } = await setup([json(overview())]); await check(); consentForm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel private challenge action' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose private count sharing' }))
    expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('never offers count reads when either grant is off', async () => {
    await setup([json(overview([challenge({ ownConsent: true })]))]); await check()
    expect(screen.queryByRole('button', { name: 'Read private training-day counts' })).not.toBeInTheDocument()
  })
  it('renders only validated unverified counts, distinguishes null from zero and clears on close', async () => {
    const { fetcher } = await setup([json(overview([granted()])), json({ ...counts(), ownRecordedDays: 0 })]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' }))
    const detail = await screen.findByRole('region', { name: 'Displayed private counts' })
    expect(detail).toHaveTextContent('0 days'); expect(detail).toHaveTextContent('No saved cloud snapshot'); expect(detail).toHaveTextContent('unverified'); expect(detail).toHaveTextContent('At most one day per UTC date')
    expect(detail).not.toHaveTextContent('2099-10-16'); expect(detail).not.toHaveTextContent('snapshotRevision')
    fireEvent.click(screen.getByRole('button', { name: 'Close displayed private counts' })); expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('rejects leaked raw dates/count bounds before rendering any results', async () => {
    await setup([json(overview([granted()])), json({ ...counts(), dates: ['2099-10-16'], ownRecordedDays: 999 })]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be validated/)
    expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument(); expect(screen.queryByText('2099-10-16')).not.toBeInTheDocument()
  })
  it.each(['leave', 'revoke', 'block'] as const)('reviews %s consequences and clears counts before the mutation completes', async action => {
    const { fetcher } = await setup([json(overview([granted()])), json(counts())]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' })); await screen.findByRole('region', { name: 'Displayed private counts' })
    fireEvent.click(screen.getByRole('button', { name: action === 'leave' ? 'Review leaving this challenge' : action === 'revoke' ? 'Review revoking count sharing' : 'Review blocking this person' }))
    expect(review()).toHaveTextContent(action === 'block' ? 'There is no unblock control in this version' : action === 'leave' ? 'only this challenge' : 'permanently end this challenge')
    let release!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    confirm(); expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument(); expect(screen.queryByRole('heading', { name: 'Accepted private challenges' })).not.toBeInTheDocument()
    await act(async () => release(action === 'block' ? new Response(null, { status: 204 }) : json({ challenge: challenge({ version: 3, status: 'revoked', revokedAt: stamp }) })))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(action === 'block' ? 'Blocking confirmed' : action === 'leave' ? 'You left this challenge' : 'Count sharing revoked'))
  })
  it('declines or blocks an incoming invitation only after review', async () => {
    const { fetcher } = await setup([json(overview([], [invitation])), new Response(null, { status: 204 })]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Review blocking this inviter' })); expect(review()).toHaveTextContent('Account ID: peer'); expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel private challenge action' })); fireEvent.click(screen.getByRole('button', { name: 'Review private decline' })); confirm()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Invitation declined'))
    expect(fetcher.mock.calls[2][0]).toBe(`${endpoint}/challenges/invitations/challenge-1`)
  })
  it.each([409, 403, 401])('clears all private state after %s without claiming success', async status => {
    await setup([json(overview()), json({ error: { code: status === 409 ? 'challenge_conflict' : 'sharing_unavailable' } }, status)]); await check(); consentForm(); confirm()
    if (status === 401) await screen.findByText(/Sign in with a verified email/)
    else expect(await screen.findByRole('alert')).toHaveTextContent(status === 409 ? 'Refresh and review' : 'not allowed')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument(); expect(screen.queryByRole('heading', { name: 'Accepted private challenges' })).not.toBeInTheDocument(); expect(screen.queryByText(/consent was saved/)).not.toBeInTheDocument()
  })
  it('blocks duplicate confirmation and retained cancelled callbacks synchronously', async () => {
    const { fetcher } = await setup([json(overview())]); await check(); consentForm()
    const cancelled = retainedClick(screen.getByRole('button', { name: 'Confirm private challenge action' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel private challenge action' })); act(cancelled); expect(fetcher).toHaveBeenCalledTimes(2)
    consentForm(); let release!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const duplicated = retainedClick(screen.getByRole('button', { name: 'Confirm private challenge action' }))
    act(() => { duplicated(); duplicated() }); expect(fetcher).toHaveBeenCalledTimes(3)
    await act(async () => release(json({ challenge: challenge({ ownConsent: true, version: 3 }) })))
  })
  it.each(['overview', 'counts', 'mutation'] as const)('drops delayed %s after hiding and returning, requiring a fresh availability check', async kind => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const { fetcher } = await setup(kind === 'overview' ? [] : [json(overview([granted()]))])
    if (kind === 'overview') open(); else await check()
    let release!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    if (kind === 'overview') fireEvent.click(screen.getByRole('button', { name: 'Check private challenge availability' }))
    else if (kind === 'counts') fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' }))
    else { consentForm(); confirm() }
    hideAndReturn(visibility)
    await act(async () => release(json(kind === 'overview' ? overview([granted()]) : kind === 'counts' ? counts() : { challenge: challenge({ ownConsent: true, peerConsent: true, version: 3 }) })))
    expect(screen.queryByRole('heading', { name: 'Accepted private challenges' })).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument(); expect(screen.queryByText(/consent was saved/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check private challenge availability' })).toBeEnabled()
  })
  it.each(['hide', 'close', 'refresh'] as const)('rejects retained row, grant and confirm callbacks after %s in the same session', async transition => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const { fetcher } = await setup([json(overview()), json(overview([]))]); await check()
    const leave = retainedClick(screen.getByRole('button', { name: 'Review leaving this challenge' }))
    const choose = retainedClick(screen.getByRole('button', { name: 'Choose private count sharing' }))
    consentForm(); const oldConfirm = retainedClick(screen.getByRole('button', { name: 'Confirm private challenge action' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel private challenge action' }))
    if (transition === 'hide') hideAndReturn(visibility)
    if (transition === 'close') { fireEvent.click(screen.getByRole('button', { name: 'Close private challenge controls' })); open() }
    if (transition === 'refresh') { fireEvent.click(screen.getByRole('button', { name: 'Refresh private challenges' })); await screen.findByText('No accepted private challenges were returned.') }
    const calls = fetcher.mock.calls.length
    act(() => { leave(); choose(); oldConfirm() })
    expect(screen.queryByRole('region', { name: 'Review private challenge action' })).not.toBeInTheDocument(); expect(screen.queryByRole('checkbox')).not.toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(calls)
  })
  it('refuses a confirmation while hidden even before React removes the old review', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const { fetcher } = await setup([json(overview())]); await check(); consentForm()
    const oldConfirm = retainedClick(screen.getByRole('button', { name: 'Confirm private challenge action' }))
    act(() => { visibility.mockReturnValue('hidden'); oldConfirm(); document.dispatchEvent(new Event('visibilitychange')) })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each(['switch', 'same-account', 'logout', 'unmount'] as const)('cannot restore delayed counts after %s', async kind => {
    const { client, fetcher, unmount } = await setup([json(overview([granted()]))]); await check()
    let release!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' }))
    if (kind === 'unmount') unmount()
    else if (kind === 'logout') act(() => client.clear())
    else { fetcher.mockResolvedValueOnce(json(auth(kind === 'switch' ? 'other' : 'self'))); await act(async () => { await client.login('synthetic@example.test', 'synthetic') }) }
    await act(async () => release(json(counts())))
    expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument(); expect(screen.queryByText('4 days')).not.toBeInTheDocument()
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('clears displayed counts and old review callbacks when the session expires', async () => {
    const { client, fetcher } = await setup([json(overview([granted()])), json(counts())]); await check()
    fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' })); await screen.findByRole('region', { name: 'Displayed private counts' })
    const oldLeave = retainedClick(screen.getByRole('button', { name: 'Review leaving this challenge' }))
    vi.useFakeTimers(); vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    await act(async () => { await client.challengeRequest('challenges').catch(() => undefined) })
    act(oldLeave)
    expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Review private challenge action' })).not.toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('allows blocking terminal records but offers no consent or count read for them', async () => {
    await setup([json(overview([challenge({ status: 'expired' })]))]); await check()
    const entry = screen.getByRole('article', { name: 'Private challenge with peer@example.test' })
    expect(within(entry).queryByRole('button', { name: 'Choose private count sharing' })).not.toBeInTheDocument(); expect(within(entry).queryByRole('button', { name: 'Read private training-day counts' })).not.toBeInTheDocument(); expect(within(entry).getByRole('button', { name: 'Review blocking this person' })).toBeEnabled()
  })
})

it.each([403, 409, 503])('rejects retained row callbacks after a %s count failure requires refresh', async status => {
  const { fetcher } = await setup([json(overview([granted()])), json({ error: { code: 'sharing_unavailable' } }, status)]); await check()
  const choose = retainedClick(screen.getByRole('button', { name: 'Choose private count sharing' }))
  const leave = retainedClick(screen.getByRole('button', { name: 'Review leaving this challenge' }))
  fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' })); await screen.findByRole('alert')
  act(() => { choose(); leave() })
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Review private challenge action' })).not.toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(3)
})

it.each(['review', 'selection', 'unchecked'] as const)('rejects old checked consent form/checkbox callbacks after %s', async cancellation => {
  const { fetcher } = await setup([json(overview())]); await check()
  fireEvent.click(screen.getByRole('button', { name: 'Choose private count sharing' })); fireEvent.click(screen.getByRole('checkbox'))
  const checkbox = screen.getByRole('checkbox')
  const form = checkbox.closest('form')!
  const formProperty = Object.keys(form).find(key => key.startsWith('__reactProps$'))!
  const checkboxProperty = Object.keys(checkbox).find(key => key.startsWith('__reactProps$'))!
  const submit = (form as unknown as Record<string, { onSubmit: (event: { preventDefault: () => void }) => void }>)[formProperty].onSubmit
  const change = (checkbox as unknown as Record<string, { onChange: (event: { target: { checked: boolean } }) => void }>)[checkboxProperty].onChange
  if (cancellation === 'review') { fireEvent.click(screen.getByRole('button', { name: 'Review private count consent' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel private challenge action' })) }
  else if (cancellation === 'selection') fireEvent.click(screen.getByRole('button', { name: 'Cancel private count selection' }))
  else fireEvent.click(checkbox)
  act(() => { change({ target: { checked: true } }); submit({ preventDefault: () => undefined }) })
  expect(screen.queryByRole('region', { name: 'Review private challenge action' })).not.toBeInTheDocument()
  if (cancellation === 'unchecked') expect(screen.getByRole('checkbox')).not.toBeChecked()
  else expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

async function fakeTimeOverview(value = overview([granted()])) {
  const result = await setup([json(value)])
  open()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check private challenge availability' })) })
  expect(screen.getByRole('heading', { name: 'Accepted private challenges' })).toBeInTheDocument()
  return result
}

it.each(['counts', 'consent-review', 'invitation-review'] as const)('clears %s at its exact local access deadline without requests or reusable old callbacks', async kind => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(kind === 'invitation-review' ? '2099-10-21T23:59:59.000Z' : '2099-10-28T23:59:59.000Z'))
  const { fetcher } = await fakeTimeOverview(kind === 'invitation-review' ? overview([], [invitation]) : overview([granted()]))
  const oldAction = retainedClick(screen.getByRole('button', { name: kind === 'invitation-review' ? 'Review private acceptance' : 'Choose private count sharing' }))
  let oldConfirm: (() => void) | null = null
  if (kind === 'counts') { fetcher.mockResolvedValueOnce(json(counts())); await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' })) }); expect(screen.getByRole('region', { name: 'Displayed private counts' })).toBeInTheDocument() }
  else { if (kind === 'invitation-review') fireEvent.click(screen.getByRole('button', { name: 'Review private acceptance' })); else consentForm(); oldConfirm = retainedClick(screen.getByRole('button', { name: 'Confirm private challenge action' })) }
  const calls = fetcher.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  act(() => { oldAction(); oldConfirm?.() })
  expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Review private challenge action' })).not.toBeInTheDocument(); expect(screen.queryByRole('checkbox')).not.toBeInTheDocument(); expect(screen.queryByText('peer@example.test')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('access window expired'); expect(fetcher).toHaveBeenCalledTimes(calls)
})

it.each(['counts', 'mutation'] as const)('drops a pending %s response crossing local challenge expiry', async kind => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2099-10-28T23:59:59.000Z'))
  const { fetcher } = await fakeTimeOverview()
  let release!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  if (kind === 'counts') fireEvent.click(screen.getByRole('button', { name: 'Read private training-day counts' }))
  else { consentForm(); confirm() }
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => release(json(kind === 'counts' ? counts() : { challenge: challenge({ ownConsent: true, peerConsent: true, version: 3 }) })))
  expect(screen.queryByRole('region', { name: 'Displayed private counts' })).not.toBeInTheDocument(); expect(screen.queryByText(/consent was saved/)).not.toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent('access window expired'); expect(fetcher).toHaveBeenCalledTimes(3)
})

it('chunks long local deadlines and removes timers on unmount without any background request', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp))
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  const { fetcher, unmount } = await fakeTimeOverview()
  expect(timeout.mock.calls.filter(([, delay]) => delay === 2_147_000_000).length).toBeGreaterThanOrEqual(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(2_147_000_000) })
  expect(screen.getByRole('heading', { name: 'Accepted private challenges' })).toBeInTheDocument()
  expect(timeout.mock.calls.filter(([, delay]) => delay === 2_147_000_000).length).toBeGreaterThanOrEqual(4)
  expect(fetcher).toHaveBeenCalledTimes(2)
  unmount(); expect(vi.getTimerCount()).toBe(0)
})
