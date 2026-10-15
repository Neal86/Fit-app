import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Cloud, Download, LockKeyhole, ShieldCheck, Upload } from 'lucide-react'
import { CloudClient, CloudError, HEALTH_SYNC_POLICY, pausedCloudState } from '../cloud'
import type { CloudConsent, CloudSnapshot } from '../cloud'
import { downloadText, parseBackup } from '../storage'
import type { AppState } from '../types'
import Coaching from './Coaching'
import PrivateChallenges from './PrivateChallenges'
import './Account.css'

type AccountProps = {
  state: AppState
  /** Must persist atomically before returning true. False must leave existing state untouched. */
  onRestore: (state: AppState) => boolean
  /** Optional stable instance for tests/embedding. Never persist it. */
  client?: CloudClient
}
type Mode = 'login' | 'register' | 'verify' | 'reset'
type Review = { kind: 'upload'; state: AppState; revision: number } | { kind: 'restore'; snapshot: CloudSnapshot } | { kind: 'revoke' }

export default function Account({ state, onRestore, client: suppliedClient }: AccountProps) {
  const [client] = useState(() => suppliedClient ?? new CloudClient())
  const sessionRevision = useSyncExternalStore(client.subscribeSession, () => client.sessionRevision, () => client.sessionRevision)
  const session = useMemo(() => { void sessionRevision; return client.session }, [client, sessionRevision])
  const [viewRevision, setViewRevision] = useState(sessionRevision)
  const currentView = viewRevision === sessionRevision
  const [storedConsent, setConsent] = useState<CloudConsent | null>(null)
  const [storedRemote, setRemote] = useState<CloudSnapshot | null>(null)
  const [storedReview, setReview] = useState<Review | null>(null)
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [storedPassword, setPassword] = useState('')
  const [storedToken, setToken] = useState('')
  const [storedAccountPassword, setAccountPassword] = useState('')
  const [storedDeleteText, setDeleteText] = useState('')
  const [storedConsentChoice, setConsentChoice] = useState(false)
  const [sharingRefreshKey, setSharingRefreshKey] = useState(0)
  const consentChoice = currentView && storedConsentChoice
  const consent = currentView ? storedConsent : null
  const remote = currentView ? storedRemote : null
  const review = currentView ? storedReview : null
  const password = currentView ? storedPassword : ''
  const token = currentView ? storedToken : ''
  const accountPassword = currentView ? storedAccountPassword : ''
  const deleteText = currentView ? storedDeleteText : ''
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const working = useRef(false)
  const mounted = useRef(true)
  const latest = useRef(state); latest.current = state

  function clearCloudView() { setConsent(null); setRemote(null); setReview(null); setConsentChoice(false) }
  function clearSecrets() { setPassword(''); setToken(''); setAccountPassword(''); setDeleteText('') }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; client.clear() } }, [client])
  useEffect(() => {
    // A collaborator request can invalidate this shared account context. Hide stale data in render first.
    setConsent(null); setRemote(null); setReview(null); setConsentChoice(false)
    setPassword(''); setToken(''); setAccountPassword(''); setDeleteText('')
    setViewRevision(sessionRevision)
  }, [sessionRevision])
  useEffect(() => {
    if (!session) return
    let timer: ReturnType<typeof setTimeout>
    const expire = () => {
      const remaining = Date.parse(session.sessionExpiresAt) - Date.now()
      if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_000_000)); return }
      client.clear(); setConsent(null); setRemote(null); setReview(null); setConsentChoice(false)
      setPassword(''); setToken(''); setAccountPassword(''); setDeleteText('')
      setMessage(''); setError('Your session has expired. Sign in again; your device data is unchanged.')
    }
    expire()
    return () => clearTimeout(timer)
  }, [session, client])

  async function run(action: (assertCurrent: () => void) => Promise<void>) {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setMessage('')
    const revision = client.sessionRevision
    const assertCurrent = () => {
      if (!mounted.current || client.sessionRevision !== revision) throw new CloudError('cancelled', 'This account action was cancelled because the session changed. Device data is unchanged.')
    }
    try { await action(assertCurrent) }
    catch (cause) {
      if (!mounted.current) return
      setReview(null)
      // A failed action must never leave an upload based on stale account/consent/revision data.
      setRemote(null); setConsent(null); setConsentChoice(false)
      setError(cause instanceof Error ? cause.message : 'This action was not completed.')
    } finally {
      working.current = false
      if (mounted.current) {
        setBusy(false)
        if (!client.session) { clearCloudView(); clearSecrets() }
      }
    }
  }
  function changeMode(next: Mode) {
    clearSecrets(); setMode(next); setError(''); setMessage('')
  }
  async function authenticate() {
    const submitted = password; setPassword(''); clearCloudView()
    await run(async () => {
      if (mode === 'register') {
        await client.register(email, submitted)
        if (mounted.current) { setMode('verify'); setMessage('Registration accepted. Check your email for a verification token. Email delivery still depends on the configured provider.') }
      } else {
        await client.login(email, submitted)
        if (mounted.current) setMessage('Signed in. No health data has been uploaded or downloaded.')
      }
    })
  }
  async function inspect() {
    clearCloudView()
    await run(async assertCurrent => {
      const snapshot = await client.inspectSync()
      assertCurrent()
      setConsent({ healthSync: true, policyVersion: HEALTH_SYNC_POLICY, updatedAt: null }); setRemote(snapshot)
      setMessage('Cloud copy inspected. Choose whether to upload this device or restore the cloud copy.')
    })
  }
  function prepareUpload() {
    if (!remote || !consent?.healthSync || busy) return
    try { setError(''); setReview({ kind: 'upload', state: pausedCloudState(latest.current), revision: remote.revision }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Device data could not be validated.') }
  }
  async function confirmReview() {
    if (!review) return
    const pending = review; setReview(null)
    await run(async assertCurrent => {
      assertCurrent()
      if (pending.kind === 'upload') {
        const result = await client.upload(pending.state, pending.revision, true)
        assertCurrent()
        if (mounted.current) { setRemote(null); setMessage(`Cloud upload confirmed at revision ${result.revision}. Inspect again before another transfer.`) }
      } else if (pending.kind === 'restore') {
        // Re-inspect immediately before replacement. A changed revision requires another explicit choice.
        const current = await client.inspectSync()
        assertCurrent()
        if (current.revision !== pending.snapshot.revision) {
          if (mounted.current) setRemote(current)
          throw new CloudError('sync_conflict', 'The cloud copy changed during review. Inspect it again and choose whether to restore.')
        }
        if (!current.state) throw new CloudError('empty_snapshot', 'There is no cloud copy to restore.')
        const parsed = parseBackup(JSON.stringify(current.state))
        // Cross-device timers must never resume from an old wall-clock time.
        if (parsed.activeSession) parsed.activeSession = { ...parsed.activeSession, runningSince: null, restUntil: null }
        assertCurrent()
        if (!onRestore(parsed)) throw new CloudError('storage_failed', 'The cloud copy was not restored because device storage failed. Your previous device data is unchanged.')
        setRemote(null); setMessage('Cloud copy restored to this device. Any active workout is paused.')
      } else {
        // Clear all mounted sharing views before revocation can race a delayed private read.
        setSharingRefreshKey(value => value + 1)
        await client.setConsent(false)
        assertCurrent()
        if (mounted.current) { setSharingRefreshKey(value => value + 1); clearCloudView(); setConsent({ healthSync: false, policyVersion: HEALTH_SYNC_POLICY, updatedAt: null }); setMessage('Cloud consent revoked and the server snapshot deleted. Your device data is unchanged.') }
      }
    })
  }

  const recipient = client.endpoint ?? 'an unconfigured server'
  return <section className="account-page">
    <header className="page-header"><span>Optional cloud account</span><h1>Account & cloud data</h1><p>Your training works on this device. You choose each cloud transfer.</p></header>
    {!client.configured ? <div className="panel account-card"><ShieldCheck aria-hidden="true"/><h2>Local data stays with you</h2><p>{client.nativeUnsupported ? 'Cloud accounts are not supported in this native build. Use the local training, nutrition, and backup tools. Web cloud access needs a configured same-site HTTPS service.' : 'Cloud accounts are not configured in this build. No account or cloud requests will be sent. Local training and backup tools are still available.'}</p></div> : <>
      <div className="account-service"><LockKeyhole aria-hidden="true"/><div><strong>Configured cloud recipient</strong><p className="account-endpoint">{recipient}</p><small>Account actions send your email, password, or token only to this service. Cloud accounts require a same-site HTTPS web app and API.</small></div></div>
      {error && <p role="alert" className="error-message">{error}</p>}
      {message && <p role="status" className="notice">{message}</p>}
      {busy && <p role="status" className="account-working">Working… Keep this page open until the result is confirmed.</p>}
      {!session ? <div className="panel account-card">
        <div className="account-tabs" aria-label="Account actions">{([['login', 'Sign in'], ['register', 'Create account'], ['verify', 'Verify email'], ['reset', 'Reset password']] as const).map(([value, label]) => <button key={value} className={mode === value ? 'primary-button' : 'secondary-button'} aria-pressed={mode === value} disabled={busy} onClick={() => changeMode(value)}>{label}</button>)}</div>
        {(mode === 'login' || mode === 'register') && <form className="account-form" onSubmit={event => { event.preventDefault(); void authenticate() }}>
          <h2>{mode === 'login' ? 'Sign in to your account' : 'Create a cloud account'}</h2>
          <label>Email<input type="email" required maxLength={254} autoComplete="email" disabled={busy} value={email} onChange={event => setEmail(event.target.value)}/></label>
          <label>Password<input type="password" required minLength={mode === 'register' ? 12 : 1} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} disabled={busy} value={password} onChange={event => setPassword(event.target.value)}/></label>
          {mode === 'register' && <p>Use at least 12 characters. Creating an account does not enable health-data syncing.</p>}
          <button className="primary-button" type="submit" disabled={busy}>{mode === 'login' ? 'Sign in securely' : 'Register account'}</button>
        </form>}
        {(mode === 'verify' || mode === 'reset') && <>
          <form className="account-form" onSubmit={event => { event.preventDefault(); void run(async () => { if (mode === 'verify') await client.requestVerification(email); else await client.requestPasswordReset(email); if (mounted.current) setMessage('Request accepted. If an eligible account exists, check its email for the token.') }) }}>
            <h2>{mode === 'verify' ? 'Request a verification email' : 'Request a password reset'}</h2>
            <label>Email<input type="email" required maxLength={254} autoComplete="email" disabled={busy} value={email} onChange={event => setEmail(event.target.value)}/></label>
            <button className="secondary-button" type="submit" disabled={busy}>{mode === 'verify' ? 'Send verification email' : 'Send reset email'}</button>
          </form>
          <form className="account-form account-token" onSubmit={event => {
            event.preventDefault(); const submittedToken = token; const submittedPassword = password; setToken(''); setPassword('')
            void run(async () => { if (mode === 'verify') await client.confirmVerification(submittedToken); else await client.confirmPasswordReset(submittedToken, submittedPassword); if (mounted.current) { setMode('login'); setMessage(mode === 'verify' ? 'Email verified. Sign in to continue.' : 'Password reset confirmed. Sign in with your new password.') } })
          }}>
            <p>Paste only the token from your email below. Tokens are never read from the address bar or saved on this device.</p>
            <label>{mode === 'verify' ? 'Verification token' : 'Reset token'}<input type="password" required maxLength={512} autoComplete="off" spellCheck={false} disabled={busy} value={token} onChange={event => setToken(event.target.value)}/></label>
            {mode === 'reset' && <label>New password<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" disabled={busy} value={password} onChange={event => setPassword(event.target.value)}/></label>}
            <button className="primary-button" type="submit" disabled={busy}>{mode === 'verify' ? 'Confirm email verification' : 'Confirm new password'}</button>
          </form>
        </>}
        <button className="secondary-button account-check" disabled={busy} onClick={() => { clearCloudView(); clearSecrets(); void run(async () => { await client.checkSession(); if (mounted.current) setMessage('Existing session checked. No health data has been transferred.') }) }}>Check existing session</button>
      </div> : <>
        <div className="panel account-card account-session"><div><h2>{session.user.email}</h2><p>{session.user.emailVerified ? 'Email verified' : 'Email verification required'} · Session ends {new Date(session.sessionExpiresAt).toLocaleString()}</p></div><button className="secondary-button" disabled={busy} onClick={() => { clearSecrets(); clearCloudView(); void run(async () => { try { await client.logout(); if (mounted.current) setMessage('Signed out. Your device data is unchanged.') } catch { throw new CloudError('logout_unconfirmed', 'Signed out locally, but server sign-out was not confirmed. The server cookie may remain active; retry sign-in and sign-out when online.') } }) }}>Sign out</button></div>
        {!session.user.emailVerified ? <div className="notice"><p>Verify your email before using cloud health data. No health data has been sent.</p><button className="secondary-button" disabled={busy} onClick={() => { client.clear(); clearCloudView(); changeMode('verify'); setEmail(session.user.email) }}>Open email verification</button></div> : <div className="panel account-card">
          <h2><Cloud aria-hidden="true"/> Health-data consent</h2>
          <p>Cloud recipient: <strong className="account-endpoint">{recipient}</strong></p>
          <p>Transfers include your training plans and workout history, profile and weight records, nutrition entries and goals, preferences, and any active workout session. This can reveal sensitive health information.</p>
          <p>No background sync runs. Granting cloud consent enables the manual upload and restore controls below. If you separately grant categories to a coach, that coach can read those categories from later uploaded snapshots until you revoke access. Separately consented private challenges can reveal only the reviewed training-day count from later saved snapshots. Revoke it to delete the cloud snapshot; device data stays intact. Policy version: {HEALTH_SYNC_POLICY}.</p>
          <p><strong>Consent: {consent === null ? 'not checked' : consent.healthSync ? 'enabled' : 'off'}</strong></p>
          <div className="account-actions"><button className="secondary-button" disabled={busy || !!review} onClick={() => { setRemote(null); void run(async assertCurrent => { const value = await client.getConsent(); assertCurrent(); if (mounted.current) setConsent(value) }) }}>Check cloud consent</button>{consent?.healthSync && <button className="secondary-button danger" disabled={busy || !!review} onClick={() => { clearSecrets(); setReview({ kind: 'revoke' }) }}>Revoke consent & delete cloud copy</button>}</div>
          {!consent?.healthSync && <div className="account-consent"><label><input type="checkbox" checked={consentChoice} disabled={busy || !!review} onChange={event => setConsentChoice(event.target.checked)}/><span>I consent to sending these health-data categories to {recipient} when I manually confirm an upload.</span></label><button className="primary-button" disabled={!consentChoice || busy || !!review} onClick={() => void run(async assertCurrent => { const value = await client.setConsent(true); assertCurrent(); if (mounted.current) { setConsent(value); setConsentChoice(false); setRemote(null); setMessage('Cloud consent enabled. No health data has been uploaded. Inspect the cloud copy before choosing a transfer.') } })}>Enable cloud consent</button></div>}
        </div>}
        {session.user.emailVerified && consent?.healthSync && <div className="panel account-card">
          <h2>Choose a transfer</h2><p>Inspect the server first. Upload replaces its entire cloud copy. Restore replaces this device’s entire dataset; records are not merged.</p>
          <button className="secondary-button" disabled={busy || !!review} onClick={() => void inspect()}>Inspect cloud copy</button>
          {remote && <div className="account-snapshot"><h3>Cloud revision {remote.revision}</h3><p>{remote.state ? stateSummary(remote.state) : 'No cloud snapshot is stored.'}</p>{remote.updatedAt && <p>Updated {new Date(remote.updatedAt).toLocaleString()}</p>}<p>On this device: {stateSummary(state)}</p><div className="account-actions"><button className="primary-button" disabled={busy || !!review} onClick={prepareUpload}><Upload aria-hidden="true" size={18}/>Review upload</button><button className="secondary-button" disabled={busy || !!review || !remote.state} onClick={() => { if (remote.state) setReview({ kind: 'restore', snapshot: remote }) }}><Download aria-hidden="true" size={18}/>Review restore</button></div></div>}
        </div>}
        {review && <div className="account-review" role="region" aria-labelledby="account-review-title" tabIndex={-1} ref={node => node?.focus()}>
          <h2 id="account-review-title">{review.kind === 'upload' ? 'Confirm health-data upload' : review.kind === 'restore' ? 'Confirm device replacement' : 'Confirm cloud deletion'}</h2>
          {review.kind === 'upload' ? <><p>Send the reviewed snapshot to {recipient} for {session.user.email}, replacing cloud revision {review.revision}?</p><p>{stateSummary(review.state)}</p><p>Includes training, profile and weight, nutrition, preferences, and the active session. The uploaded timer is paused. Accepted coaches with your current explicit category grants can read the newly uploaded categories until you revoke their access. Private challenge partners with both current grants can read updated training-day counts for the reviewed UTC windows. Your current device data remains unchanged.</p></> : review.kind === 'restore' ? <><p>Replace all data on this device with cloud revision {review.snapshot.revision} from {session.user.email}?</p><p>{review.snapshot.state && stateSummary(review.snapshot.state)}</p><p>Export a local backup in Profile first if you want to keep this device’s current records. The active workout will be paused.</p></> : <p>Revoke health-data consent and permanently delete the cloud snapshot for {session.user.email} at {recipient}? This also clears all coach category grants and both participants’ private-challenge grants; enabling cloud consent again does not restore them. Your device records will stay intact.</p>}
          <div className="account-actions"><button className="primary-button" disabled={busy} onClick={() => void confirmReview()}>{review.kind === 'upload' ? 'Confirm upload to cloud' : review.kind === 'restore' ? 'Confirm replace device data' : 'Confirm revoke and delete'}</button><button className="secondary-button" disabled={busy} onClick={() => setReview(null)}>Cancel</button></div>
        </div>}
        {session.user.emailVerified && <><Coaching key={`coaching-${sharingRefreshKey}`} client={client} unit={state.profile.unit}/><PrivateChallenges key={`challenges-${sharingRefreshKey}`} client={client}/></>}
        <div className="panel account-card"><h2>Account export & deletion</h2><p>A full account export includes account details, consent, the cloud health-data snapshot, your coaching relationships, invitations and feedback, and your own historical private-challenge metadata when supported. Challenge exports do not include counterpart identities or counts. Keep the downloaded JSON private. It does not include unsynced device changes.</p>
          <form className="account-form" onSubmit={event => { event.preventDefault(); const submitted = accountPassword; setAccountPassword(''); setDeleteText(''); void run(async assertCurrent => { const exported = await client.exportAccount(submitted); assertCurrent(); downloadText(JSON.stringify(exported, null, 2), `fitflow-account-export-${new Date().toISOString().slice(0, 10)}.json`); setMessage('Account export download started. Check the saved file and keep it private.') }) }}>
            <label>Confirm account password<input type="password" required maxLength={128} autoComplete="current-password" disabled={busy || !!review} value={accountPassword} onChange={event => setAccountPassword(event.target.value)}/></label>
            <button className="secondary-button" type="submit" disabled={busy || !!review || !accountPassword}>Download full account export</button>
          </form>
          <div className="account-danger"><h3>Delete cloud account permanently</h3><p>This deletes your account, sessions, consent, server health-data snapshot, coaching relationships, invitations and feedback, and private-challenge records. It cannot be undone. Data on this device is kept; use Profile to reset it separately.</p><label>Type DELETE to confirm<input autoComplete="off" spellCheck={false} disabled={busy || !!review} value={deleteText} onChange={event => setDeleteText(event.target.value)}/></label><button className="secondary-button danger" disabled={busy || !!review || deleteText !== 'DELETE' || !accountPassword} onClick={() => { const submitted = accountPassword; const confirmation = deleteText; clearSecrets(); void run(async () => { await client.deleteAccount(submitted, confirmation); if (mounted.current) { clearCloudView(); setMessage('Cloud account deleted. Your device data is unchanged.') } }) }}>Permanently delete cloud account</button></div>
        </div>
      </>}
    </>}
  </section>
}

function stateSummary(state: AppState): string {
  // Optional until the centrally validated version-4 state is integrated.
  const extended = state as AppState & { nutrition?: { meals?: unknown[]; hydration?: unknown[]; targets?: unknown[] }; planHistory?: unknown[] }
  const nutrition = extended.nutrition
  const nutritionSummary = nutrition ? `, ${nutrition.meals?.length ?? 0} meals, ${nutrition.hydration?.length ?? 0} hydration entries, ${nutrition.targets?.length ?? 0} nutrition target records` : ''
  const planSummary = extended.planHistory ? `, ${extended.planHistory.length} saved plan versions` : ''
  return `${state.workouts.length} training plans, ${state.logs.length} completed workouts, ${state.weightHistory.length} weight entries${nutritionSummary}${planSummary}${state.activeSession ? ', and an active workout' : ''}`
}
