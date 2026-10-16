import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CloudClient, CloudError } from '../cloud'
import { CHALLENGE_POLICY, PrivateChallengeClient, challengeEmail, challengeWindowDays, invitationWindow } from '../privateChallenges'
import type { ChallengeCounts, ChallengeInvitation, ChallengeOverview, ChallengeWindow, PrivateChallenge } from '../privateChallenges'
import './PrivateChallenges.css'

type Action =
  | { kind: 'invite'; email: string; window: ChallengeWindow }
  | { kind: 'accept' | 'decline'; invitation: ChallengeInvitation }
  | { kind: 'consent' | 'revoke' | 'leave'; challenge: PrivateChallenge }
  | { kind: 'block'; target: PrivateChallenge | ChallengeInvitation }
type Review = { generation: number; action: Action }
type Detail = { challenge: PrivateChallenge; counts: ChallengeCounts }

/** Optional, collapsed, request-free on mount. Never pass device AppState into this view. */
export default function PrivateChallenges({ client }: { client: CloudClient }) {
  const sessionKey = useSyncExternalStore(client.subscribeSession, () => client.sessionRevision, () => client.sessionRevision)
  return <PrivateChallengesSession key={sessionKey} client={client} sessionKey={sessionKey}/>
}
function PrivateChallengesSession({ client, sessionKey }: { client: CloudClient; sessionKey: number }) {
  const [api] = useState(() => new PrivateChallengeClient(client))
  const [expanded, setExpanded] = useState(false)
  const [overview, setOverview] = useState<ChallengeOverview | null>(null)
  const [viewDeadline, setViewDeadline] = useState<number | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [grantTarget, setGrantTarget] = useState<PrivateChallenge | null>(null)
  const [consentChoice, setConsentChoice] = useState(false)
  const [email, setEmail] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const open = useRef(false)
  const working = useRef(false)
  const generation = useRef(0)
  const reviewed = useRef<Review | null>(null)
  const session = client.session
  const expiresAt = session?.sessionExpiresAt
  // Event handlers capture this render's epoch; retained old callbacks cannot repopulate a returned view.
  const renderGeneration = generation.current
  const validView = () => mounted.current && generation.current === renderGeneration && client.sessionRevision === sessionKey && document.visibilityState !== 'hidden' && (viewDeadline === null || Date.now() < viewDeadline)
  const current = () => validView() && open.current
  function clearPrivate() {
    reviewed.current = null
    setOverview(null); setDetail(null); setReview(null); setGrantTarget(null); setConsentChoice(false); setEmail(''); setStartDate(''); setEndDate('')
  }
  function invalidate() { generation.current += 1; clearPrivate(); setViewDeadline(null); setError(''); setMessage('') }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; open.current = false; generation.current += 1; reviewed.current = null } }, [])
  useEffect(() => {
    if (!expiresAt) return
    let timer: ReturnType<typeof setTimeout>
    const expire = () => {
      if (client.sessionRevision !== sessionKey) return
      const remaining = Date.parse(expiresAt) - Date.now()
      if (remaining > 0) timer = setTimeout(expire, Math.min(remaining, 2_147_000_000))
      else client.clear()
    }
    expire()
    return () => clearTimeout(timer)
  }, [client, sessionKey, expiresAt])
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') { generation.current += 1; reviewed.current = null; setOverview(null); setDetail(null); setReview(null); setGrantTarget(null); setConsentChoice(false); setEmail(''); setStartDate(''); setEndDate(''); setViewDeadline(null); setError(''); setMessage('') } }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [])
  useEffect(() => {
    if (viewDeadline === null) return
    let timer: ReturnType<typeof setTimeout>
    const expire = () => {
      if (!mounted.current || client.sessionRevision !== sessionKey) return
      const remaining = viewDeadline - Date.now()
      if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_000_000)); return }
      generation.current += 1; reviewed.current = null
      setOverview(null); setDetail(null); setReview(null); setGrantTarget(null); setConsentChoice(false); setEmail(''); setStartDate(''); setEndDate(''); setViewDeadline(null); setError('')
      setMessage('A reviewed invitation or challenge access window expired. Check availability again before another action.')
    }
    expire()
    return () => clearTimeout(timer)
  }, [viewDeadline, client, sessionKey])
  async function run(action: (isCurrent: () => boolean) => Promise<void>, clearAll = false) {
    if (working.current || !current()) return
    if (clearAll) generation.current += 1
    const view = generation.current
    const isCurrent = () => mounted.current && open.current && client.sessionRevision === sessionKey && generation.current === view && document.visibilityState !== 'hidden' && (viewDeadline === null || Date.now() < viewDeadline)
    working.current = true; setBusy(true); setError(''); setMessage(''); setDetail(null)
    if (clearAll) clearPrivate()
    try { await action(isCurrent) }
    catch (cause) {
      if (!isCurrent()) return
      generation.current += 1; clearPrivate(); setViewDeadline(null)
      setError(cause instanceof CloudError && cause.status === 409 ? 'Private challenge access changed. Refresh and review the person and UTC window again. Nothing was confirmed.' : cause instanceof Error ? `${cause.message} Refresh before another private challenge action.` : 'This action was not confirmed. Refresh before trying again.')
    } finally {
      working.current = false
      if (mounted.current && client.sessionRevision === sessionKey) setBusy(false)
    }
  }
  function prepare(action: Action) {
    if (!current() || working.current || reviewed.current) return
    const next = { generation: generation.current, action }
    reviewed.current = next; setReview(next); setDetail(null); setError(''); setMessage('')
  }
  function cancelReview() { generation.current += 1; reviewed.current = null; setReview(null); setConsentChoice(false); setGrantTarget(null) }
  async function confirmReview() {
    if (!review || reviewed.current !== review || review.generation !== generation.current || working.current || !current()) return
    const pending = review.action
    await run(async isCurrent => {
      let notice = ''
      switch (pending.kind) {
        case 'invite': await api.invite(pending.email, pending.window, true); notice = 'Invitation request accepted. This does not confirm delivery or that an eligible account exists. No training count was shared.'; break
        case 'accept': await api.accept(pending.invitation, true); notice = 'Invitation accepted with no count access. Each person must separately review and grant count sharing. Refresh to inspect the challenge.'; break
        case 'decline': await api.decline(pending.invitation, true); notice = 'Invitation declined. No count access was granted.'; break
        case 'consent': await api.consent(pending.challenge, true); notice = 'Your count-sharing consent was saved for the reviewed person and UTC window. Both people’s current consent is required to read counts. No device data was uploaded.'; break
        case 'revoke': await api.revoke(pending.challenge, 'revoke', true); notice = 'Count sharing revoked and this challenge ended. Previously viewed or copied information cannot be recalled.'; break
        case 'leave': await api.revoke(pending.challenge, 'leave', true); notice = 'You left this challenge. It is ended for both participants. Other challenges and invitation permissions are unchanged.'; break
        case 'block': await api.block(pending.target, true); notice = 'Blocking confirmed. All challenges between these two accounts are ended and neither can invite the other. There is no unblock control in this version.'; break
      }
      if (isCurrent()) { setMessage(notice); setViewDeadline(null) }
    }, true)
  }
  const eligible = client.configured && session?.user.emailVerified && Date.parse(session.sessionExpiresAt) > Date.now()
  const disabled = busy || !!review
  if (client.sessionRevision !== sessionKey) return null
  return <section className="panel challenge-card" aria-labelledby="private-challenges-title">
    <header><span className="challenge-eyebrow">Optional · two people · manual sharing</span><h2 id="private-challenges-title">Private consistency challenge</h2></header>
    <p>Compare only a count of self-recorded training days with one person you know. Records are unverified. There is no prize, ranking, medical advice or weight-loss competition.</p>
    {!client.configured ? <p className="notice">{client.nativeUnsupported ? 'Private challenges are unavailable in this native build. No challenge requests are sent.' : 'Cloud accounts are not configured in this build. No private challenge requests are sent.'}</p> : !eligible ? <p className="notice">Sign in with a verified email to use private challenge controls.</p> : <>
      <button className="secondary-button" aria-expanded={expanded} aria-controls="private-challenge-controls" onClick={() => { if (!validView()) return; open.current = !open.current; invalidate(); setExpanded(open.current) }}>{expanded ? 'Close private challenge controls' : 'Open private challenge controls'}</button>
      {expanded && <div id="private-challenge-controls">
        <p className="challenge-identity">Service: {client.endpoint}<br/>Signed in as {session.user.email}</p>
        <p className="challenge-muted">This separate service is off by default. Nothing is requested until you use a control below. Refresh for changes made elsewhere; there are no live updates.</p>
        {error && <p role="alert" className="error-message">{error}</p>}
        {message && <p role="status" className="notice">{message}</p>}
        {busy && <p role="status">Checking the private challenge service…</p>}
        <button className="secondary-button" disabled={disabled} onClick={() => void run(async isCurrent => { const result = await api.overview(); if (isCurrent()) { const deadlines = [...result.invitations.map(item => Date.parse(item.expiresAt)), ...result.challenges.filter(item => item.status === 'active').map(item => Date.parse(item.expiresAt))]; const deadline = deadlines.length ? Math.min(...deadlines) : null; if (deadline !== null && deadline <= Date.now()) throw new CloudError('challenge_conflict', 'A returned invitation or challenge expired. Refresh and review again.', 409); setViewDeadline(deadline); setOverview(result); setMessage('Private challenge availability checked. No training counts were read.') } }, true)}>{overview ? 'Refresh private challenges' : 'Check private challenge availability'}</button>
        {overview && <>
          <form className="challenge-form" onSubmit={event => { event.preventDefault(); if (!current()) return; try { prepare({ kind: 'invite', email: challengeEmail(email), window: invitationWindow(startDate, endDate) }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the email and dates.') } }}>
            <h3>Invite one person you know</h3><p>The invitation fixes a UTC window of 1–31 dates. Acceptance shares account identities, with no count access. Each person consents separately afterward.</p>
            <label>Counterpart account email<input type="email" autoComplete="off" required maxLength={254} disabled={disabled} value={email} onChange={event => { if (current()) { generation.current += 1; setEmail(event.target.value) } }}/></label>
            <label>UTC start date<input type="date" required disabled={disabled} value={startDate} onChange={event => { if (current()) { generation.current += 1; setStartDate(event.target.value) } }}/></label>
            <label>UTC end date<input type="date" required disabled={disabled} value={endDate} onChange={event => { if (current()) { generation.current += 1; setEndDate(event.target.value) } }}/></label>
            <button className="primary-button" disabled={disabled} type="submit">Review private invitation</button>
            <small>Outgoing pending requests are not listed, to protect account privacy. Generic acceptance does not prove delivery. The recipient may decline or block the invitation.</small>
          </form>
          <h3>Incoming private invitations</h3>{!overview.invitations.length && <p>No pending invitations were returned.</p>}
          {overview.invitations.map(invitation => <article className="challenge-entry" key={invitation.id}>
            <h4>{invitation.inviter.email}</h4><p className="challenge-identity">Account ID: {invitation.inviter.id}</p><WindowDescription window={invitation}/><p>Invitation expires {new Date(invitation.expiresAt).toLocaleString()}</p>
            <div className="challenge-actions"><button className="primary-button" disabled={disabled || Date.parse(invitation.expiresAt) <= Date.now()} onClick={() => prepare({ kind: 'accept', invitation })}>Review private acceptance</button><button className="secondary-button" disabled={disabled} onClick={() => prepare({ kind: 'decline', invitation })}>Review private decline</button><button className="secondary-button danger" disabled={disabled} onClick={() => prepare({ kind: 'block', target: invitation })}>Review blocking this inviter</button></div>
          </article>)}
          <h3>Accepted private challenges</h3>{!overview.challenges.length && <p>No accepted private challenges were returned.</p>}
          {overview.challenges.map(challenge => { const active = challenge.status === 'active' && Date.parse(challenge.expiresAt) > Date.now(); return <article className="challenge-entry" key={challenge.id} aria-label={`Private challenge with ${challenge.counterpart.email}`}>
            <h4>{challenge.counterpart.email}</h4><p className="challenge-identity">Account ID: {challenge.counterpart.id}</p><WindowDescription window={challenge}/><p>Status: {challenge.status} · Access expires {new Date(challenge.expiresAt).toLocaleString()}</p>
            <p>Your count consent: {challenge.ownConsent ? 'enabled' : 'off'} · Their count consent: {challenge.peerConsent ? 'enabled' : 'off'}</p>
            <div className="challenge-actions">
              {active && <button className="primary-button" disabled={disabled} onClick={() => { if (!current() || working.current) return; generation.current += 1; setGrantTarget(challenge); setConsentChoice(false); setDetail(null) }}>Choose private count sharing</button>}
              {active && challenge.ownConsent && challenge.peerConsent && <button className="primary-button" disabled={disabled} onClick={() => void run(async isCurrent => { const counts = await api.counts(challenge); if (isCurrent()) setDetail({ challenge, counts }) })}>Read private training-day counts</button>}
              {active && challenge.ownConsent && <button className="secondary-button danger" disabled={disabled} onClick={() => prepare({ kind: 'revoke', challenge })}>Review revoking count sharing</button>}
              {active && <button className="secondary-button danger" disabled={disabled} onClick={() => prepare({ kind: 'leave', challenge })}>Review leaving this challenge</button>}
              <button className="secondary-button danger" disabled={disabled} onClick={() => prepare({ kind: 'block', target: challenge })}>Review blocking this person</button>
            </div>
          </article> })}
        </>}
        {grantTarget && <form className="challenge-form" onSubmit={event => { event.preventDefault(); if (consentChoice) prepare({ kind: 'consent', challenge: grantTarget }) }}>
          <h3>Choose sharing for {grantTarget.counterpart.email}</h3><p className="challenge-identity">Exact account ID: {grantTarget.counterpart.id}</p><WindowDescription window={grantTarget}/><MetricDescription/>
          <p>Share only this count from your latest manually saved cloud snapshot, including changes in future manual uploads, with this exact person until revoked or expired. Both participants must have current cloud consent and separately grant challenge consent before either can read counts. This action uploads no device records.</p>
          <label className="challenge-checkbox"><input type="checkbox" checked={consentChoice} disabled={disabled} onChange={event => { if (current()) { generation.current += 1; setConsentChoice(event.target.checked) } }}/><span>I consent to sharing my self-recorded training-day count for this exact UTC window with {grantTarget.counterpart.email} ({grantTarget.counterpart.id}), including future manually saved cloud snapshots.</span></label>
          <p>Consent begins unchecked. Revoking cloud consent clears both grants; enabling it again does not restore challenge sharing. Previously seen or copied counts cannot be recalled.</p>
          <div className="challenge-actions"><button className="primary-button" disabled={disabled || !consentChoice}>Review private count consent</button><button className="secondary-button" type="button" disabled={disabled} onClick={() => { if (!current()) return; generation.current += 1; setGrantTarget(null); setConsentChoice(false) }}>Cancel private count selection</button></div>
        </form>}
        {detail && <section className="challenge-detail" aria-label="Displayed private counts">
          <h3>Self-recorded, unverified training-day counts</h3><p className="challenge-identity">Counterpart: {detail.challenge.counterpart.email} · Account ID: {detail.challenge.counterpart.id}</p><WindowDescription window={detail.challenge}/>
          <div className="challenge-counts"><Count label="Your recorded days" value={detail.counts.ownRecordedDays}/><Count label={`${detail.challenge.counterpart.email} recorded days`} value={detail.counts.peerRecordedDays}/></div>
          <MetricDescription/><p>A missing saved cloud snapshot is shown separately from zero days. Later manual cloud uploads can change these counts. This is a manually read saved result, not live activity.</p><button className="secondary-button" onClick={() => setDetail(null)}>Close displayed private counts</button>
        </section>}
        {review && <section className="challenge-review" role="region" aria-labelledby="private-challenge-review-title" tabIndex={-1} ref={node => node?.focus()}>
          <h3 id="private-challenge-review-title">Review private challenge action</h3><ReviewDescription action={review.action} endpoint={client.endpoint!}/>
          <div className="challenge-actions"><button className="primary-button" disabled={busy} onClick={() => void confirmReview()}>Confirm private challenge action</button><button className="secondary-button" disabled={busy} onClick={cancelReview}>Cancel private challenge action</button></div>
        </section>}
      </div>}
    </>}
  </section>
}
function WindowDescription({ window }: { window: ChallengeWindow }) {
  return <p>Fixed UTC window: <strong>{window.startDate} through {window.endDate}</strong>, inclusive ({challengeWindowDays(window)} {challengeWindowDays(window) === 1 ? 'date' : 'dates'}). This window cannot be edited.</p>
}
function MetricDescription() {
  return <><p><strong>Exact shared metric: self-recorded training-day count, unverified.</strong> At most one day per UTC date counts when a saved workout contains a completed non-warmup set with positive reps or seconds. Timer duration, completed flags alone, older logs without per-set evidence and future timestamps do not count.</p><p>No workout dates, movement names, logs, notes, body measurements, food records, loads or cloud snapshot revisions are shared by this challenge.</p></>
}
function Count({ label, value }: { label: string; value: number | null }) { return <div className="challenge-count"><span>{label}</span>{value === null ? <p>No saved cloud snapshot</p> : <strong>{value} {value === 1 ? 'day' : 'days'}</strong>}</div> }
function ReviewDescription({ action, endpoint }: { action: Action; endpoint: string }) {
  if (action.kind === 'invite') return <><p>Send a private invitation request to <strong>{action.email}</strong> through {endpoint}?</p><WindowDescription window={action.window}/><p>The service receives this email and window. An eligible recipient may see your account email and ID. Acceptance later shares both identities, with no training count access. Each person must then give separate count consent. An accepted request does not confirm account existence or delivery.</p></>
  const target = 'invitation' in action ? action.invitation : 'challenge' in action ? action.challenge : action.target
  const person = 'inviter' in target ? target.inviter : target.counterpart
  return <><p>Exact counterpart: <strong>{person.email}</strong><br/><span className="challenge-identity">Account ID: {person.id}</span></p><p>Service: {endpoint}</p><WindowDescription window={target}/>
    {action.kind === 'accept' && <p>Accept this private invitation? Your email and account ID become visible to this exact person. Acceptance alone shares no count and grants no health-data access. Each participant must separately review count consent afterward.</p>}
    {action.kind === 'decline' && <p>Decline this invitation without granting count access?</p>}
    {action.kind === 'consent' && <><MetricDescription/><p>Allow this exact person to read your count for this immutable UTC window from the latest manually saved cloud snapshot, including future manually uploaded changes until revoked or expired? Both participants must give their own separate consent. No device data is uploaded by this action. Policy {CHALLENGE_POLICY}.</p><p>Revoking cloud consent clears both grants. Previously seen or copied information cannot be recalled.</p></>}
    {action.kind === 'revoke' && <p>Revoke count access and permanently end this challenge for both participants? Other challenges are unchanged. Previously viewed or copied information cannot be recalled.</p>}
    {action.kind === 'leave' && <p>Leave and end only this challenge for both participants? This does not block future invitations or change other challenges. Previously viewed or copied information cannot be recalled.</p>}
    {action.kind === 'block' && <p>Block this exact person? This ends all challenges between these two accounts and prevents new invitations in either direction. There is no unblock control in this version. Previously viewed or copied information cannot be recalled.</p>}
  </>
}
