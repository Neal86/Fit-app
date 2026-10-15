import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CloudClient, CloudError } from '../cloud'
import { COACHING_POLICY, COACHING_SCOPES, CoachingClient, SCOPE_LABELS, coachingEmail, coachingFeedbackText } from '../coaching'
import type { CoachingFeedback, CoachingFeedbackList, CoachingInvitation, CoachingOverview, CoachingRelationship, CoachingScope, CoachingSnapshot } from '../coaching'
import './Coaching.css'
import { formatMeasurement, measurementUnit } from '../units'
import type { UnitSystem } from '../units'

type Review =
  | { kind: 'invite' | 'cancelInvite'; email: string }
  | { kind: 'accept' | 'decline'; invitation: CoachingInvitation }
  | { kind: 'consent'; relationship: CoachingRelationship; scopes: CoachingScope[] }
  | { kind: 'revoke'; relationship: CoachingRelationship }
  | { kind: 'feedback'; relationship: CoachingRelationship; text: string }
  | { kind: 'deleteFeedback'; relationship: CoachingRelationship; feedback: CoachingFeedback }
type Detail = { relationship: CoachingRelationship; snapshot?: CoachingSnapshot; feedback?: CoachingFeedbackList }

/** Embed with the Account page's existing stable CloudClient. Mounting never makes a request. */
export default function Coaching({ client, unit = 'metric' }: { client: CloudClient; unit?: UnitSystem }) {
  const sessionKey = useSyncExternalStore(client.subscribeSession, () => client.sessionRevision, () => client.sessionRevision)
  // A new generation remounts the entire private view, even for a same-account re-login.
  return <CoachingSession key={sessionKey} client={client} sessionKey={sessionKey} unit={unit}/>
}
function CoachingSession({ client, sessionKey, unit }: { client: CloudClient; sessionKey: number; unit: UnitSystem }) {
  const [api] = useState(() => new CoachingClient(client))
  const [overview, setOverview] = useState<CoachingOverview | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [grantTarget, setGrantTarget] = useState<CoachingRelationship | null>(null)
  const [selected, setSelected] = useState<CoachingScope[]>([])
  const [email, setEmail] = useState('')
  const [feedbackTarget, setFeedbackTarget] = useState<CoachingRelationship | null>(null)
  const [feedbackText, setFeedbackText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const working = useRef(false)
  const viewGeneration = useRef(0)
  const session = client.session
  const expiresAt = session?.sessionExpiresAt
  const current = () => mounted.current && client.sessionRevision === sessionKey
  function clearPrivateView() {
    setOverview(null); setDetail(null); setReview(null); setGrantTarget(null); setSelected([]); setFeedbackTarget(null); setFeedbackText(''); setEmail('')
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
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
  }, [client, sessionKey, expiresAt]) // No session token is retained in effect dependencies.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') {
        viewGeneration.current += 1
        setDetail(null); setReview(null); setGrantTarget(null); setSelected([]); setFeedbackTarget(null); setFeedbackText('')
      }
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [])
  async function run(action: (isCurrent: () => boolean) => Promise<void>, clearAll = false) {
    if (working.current || !current()) return
    const generation = viewGeneration.current
    const isCurrent = () => current() && generation === viewGeneration.current && document.visibilityState !== 'hidden'
    working.current = true; setBusy(true); setError(''); setMessage(''); setDetail(null)
    if (clearAll) clearPrivateView()
    try { await action(isCurrent) }
    catch (cause) {
      if (!isCurrent()) return
      clearPrivateView()
      setError(cause instanceof CloudError && cause.status === 409 ? 'Collaboration access changed. Refresh and review the recipient and categories again. Nothing was confirmed.' : cause instanceof Error ? `${cause.message} Refresh before another collaboration action.` : 'This action was not confirmed. Refresh before trying again.')
    } finally {
      working.current = false
      if (current()) setBusy(false)
    }
  }
  function prepare(next: Review) {
    if (working.current || review || !current()) return
    setError(''); setMessage(''); setReview(next)
  }
  async function confirmReview() {
    if (!review || working.current) return
    const pending = review
    // Clear private records and drafts immediately; a failed mutation cannot leave stale access on screen.
    await run(async isCurrent => {
      let notice = ''
      switch (pending.kind) {
        case 'invite': await api.invite(pending.email, true); notice = 'Invitation request accepted. This does not confirm delivery or that an eligible account exists. No health data was shared.'; break
        case 'cancelInvite': await api.cancelInvite(pending.email, true); notice = 'Cancellation request accepted. No account or pending-invitation existence is disclosed. Refresh to check current relationships.'; break
        case 'accept': await api.accept(pending.invitation, true); notice = 'Invitation acceptance confirmed. The athlete must separately choose and confirm any data access. Refresh to inspect the relationship.'; break
        case 'decline': await api.decline(pending.invitation, true); notice = 'Invitation declined. No data access was granted.'; break
        case 'consent': await api.consent(pending.relationship, pending.scopes, true); notice = pending.scopes.length ? 'Category access saved for the reviewed account. It covers matching categories in the current and future saved cloud copies. No device data was uploaded by this action.' : 'Category access removed. Refresh before any further changes.'; break
        case 'revoke': await api.revoke(pending.relationship, true); notice = 'Collaboration revoked. Future server access through this relationship is closed. Previously seen or copied information cannot be recalled.'; break
        case 'feedback': await api.sendFeedback(pending.relationship, pending.text, true); notice = 'Plain-text feedback saved. Refresh and read feedback to inspect it.'; break
        case 'deleteFeedback': await api.removeFeedback(pending.relationship, pending.feedback, true); notice = 'Feedback removal confirmed. Refresh to inspect the remaining feedback.'; break
      }
      if (isCurrent()) setMessage(notice)
    }, true)
  }
  const eligible = client.configured && session?.user.emailVerified && Date.parse(session.sessionExpiresAt) > Date.now()
  const disabled = busy || !!review
  // Gate sensitive rendering synchronously, before effect cleanup, after any identity generation change.
  if (client.sessionRevision !== sessionKey) return null
  return <section className="panel coaching-card" aria-labelledby="coaching-title">
    <header><span className="coaching-eyebrow">Optional · manual sharing</span><h2 id="coaching-title">Coach collaboration</h2></header>
    <p>A coach is an unverified account identity. FitFlow does not verify professional qualifications. Feedback is not medical care.</p>
    <p>Invitation acceptance starts with zero category access. The athlete chooses the exact account and categories separately. No camera analysis, AI advice or automatic device uploads are used here.</p>
    {!client.configured ? <p className="notice">{client.nativeUnsupported ? 'Collaboration is unavailable in this native build. No collaboration requests are sent.' : 'Cloud collaboration is not configured in this build. No collaboration requests are sent.'}</p> : !eligible ? <p className="notice">Sign in with a verified email to check whether this optional service is enabled.</p> : <>
      <p className="coaching-identity">Service: {client.endpoint}<br/>Signed in as {session.user.email}</p>
      <p className="coaching-muted">The service is off by default. Availability and access are checked only when you use a control below. Refresh for changes made elsewhere; this view has no live updates.</p>
      {error && <p role="alert" className="error-message">{error}</p>}
      {message && <p role="status" className="notice">{message}</p>}
      {busy && <p role="status">Checking the service…</p>}
      <button className="secondary-button" disabled={disabled} onClick={() => void run(async isCurrent => { const result = await api.overview(); if (isCurrent()) { setOverview(result); setMessage('Collaboration availability checked. No health records were fetched.') } }, true)}>{overview ? 'Refresh collaboration' : 'Check collaboration availability'}</button>
      {overview && <>
        <form className="coaching-form" onSubmit={event => { event.preventDefault(); try { prepare({ kind: 'invite', email: coachingEmail(email) }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the email.') } }}>
          <h3>Invite someone you know</h3>
          <p>Invite the coach’s known account email. Your account identity will be shown to that recipient if eligible. This request does not send health records or grant access.</p>
          <label>Coach account email<input type="email" autoComplete="off" required maxLength={254} disabled={disabled} value={email} onChange={event => setEmail(event.target.value)}/></label>
          <div className="coaching-actions"><button type="submit" className="primary-button" disabled={disabled}>Review invitation</button><button type="button" className="secondary-button" disabled={disabled || !email.trim()} onClick={() => { try { prepare({ kind: 'cancelInvite', email: coachingEmail(email) }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the email.') } }}>Review cancellation for this email</button></div>
          <small>Pending outgoing requests are not listed, to protect account privacy. Cancellation targets only your own pending invitation to the entered email.</small>
        </form>
        <h3>Incoming invitations</h3>
        {!overview.invitations.length && <p>No pending invitations were returned.</p>}
        {overview.invitations.map(invitation => <article className="coaching-relationship" key={invitation.id}>
          <h4>{invitation.athlete.email}</h4><p className="coaching-identity">Account ID: {invitation.athlete.id}</p><p>Invited you as a coach · Expires {new Date(invitation.expiresAt).toLocaleString()}</p>
          <div className="coaching-actions"><button className="primary-button" disabled={disabled || Date.parse(invitation.expiresAt) <= Date.now()} onClick={() => prepare({ kind: 'accept', invitation })}>Review acceptance</button><button className="secondary-button" disabled={disabled} onClick={() => prepare({ kind: 'decline', invitation })}>Review decline</button></div>
        </article>)}
        <h3>Accepted relationships</h3>
        {!overview.relationships.length && <p>No accepted relationships were returned. Accepting an invitation never grants health-data access by itself.</p>}
        {overview.relationships.map(relationship => <article className="coaching-relationship" key={relationship.id} aria-label={`Relationship with ${relationship.counterpart.email}`}>
          <h4>{relationship.counterpart.email}</h4><p className="coaching-identity">Account ID: {relationship.counterpart.id}</p>
          <p>You are the {relationship.role} · {relationship.status} · Access version {relationship.version}</p>
          <p><strong>Saved access:</strong> {relationship.scopes.length ? relationship.scopes.map(scope => SCOPE_LABELS[scope]).join('; ') : 'No categories'}</p>
          <div className="coaching-actions">
            {relationship.role === 'athlete' && relationship.status === 'active' && <button className="primary-button" disabled={disabled} onClick={() => { setGrantTarget(relationship); setSelected([]); setDetail(null); setFeedbackTarget(null); setFeedbackText('') }}>Choose categories</button>}
            {relationship.role === 'coach' && relationship.status === 'active' && relationship.scopes.length > 0 && <button className="primary-button" disabled={disabled} onClick={() => void run(async isCurrent => { const snapshot = await api.snapshot(relationship); if (isCurrent()) setDetail({ relationship, snapshot }) })}>Read shared cloud snapshot</button>}
            {(relationship.role === 'athlete' || relationship.status === 'active' && relationship.scopes.includes('training')) && <button className="secondary-button" disabled={disabled} onClick={() => void run(async isCurrent => { const feedback = await api.feedback(relationship); if (isCurrent()) setDetail({ relationship, feedback }) })}>Read feedback</button>}
            {relationship.role === 'coach' && relationship.status === 'active' && relationship.scopes.includes('training') && <button className="secondary-button" disabled={disabled} onClick={() => { setFeedbackTarget(relationship); setFeedbackText(''); setGrantTarget(null); setSelected([]) }}>Write feedback</button>}
            {relationship.status === 'active' && <button className="secondary-button danger" disabled={disabled} onClick={() => prepare({ kind: 'revoke', relationship })}>{relationship.role === 'coach' ? 'Review leaving collaboration' : 'Review revoking collaboration'}</button>}
          </div>
        </article>)}
      </>}
      {grantTarget && <form className="coaching-form coaching-consent" onSubmit={event => { event.preventDefault(); prepare({ kind: 'consent', relationship: grantTarget, scopes: [...selected] }) }}>
        <h3>Choose access for {grantTarget.counterpart.email}</h3><p className="coaching-identity">Exact accepted account ID: {grantTarget.counterpart.id}</p>
        <p>All choices start unchecked. The confirmed selection replaces existing access. Selected categories include sensitive health information and private notes. Access covers matching data already saved in the cloud and future cloud uploads until changed or revoked.</p>
        <fieldset disabled={disabled}><legend>Categories this account may read</legend>{COACHING_SCOPES.map(scope => <label className="coaching-checkbox" key={scope}><input type="checkbox" checked={selected.includes(scope)} onChange={event => setSelected(previous => event.target.checked ? [...previous, scope] : previous.filter(item => item !== scope))}/><span>{SCOPE_LABELS[scope]}</span></label>)}</fieldset>
        <p>Device-only changes are never uploaded here. Active workout sessions, preferences, credentials, name and birth year are excluded. A recipient may copy information they see; revocation cannot recall those copies.</p>
        <div className="coaching-actions"><button type="submit" className="primary-button" disabled={disabled}>Review category access</button><button type="button" className="secondary-button" disabled={disabled} onClick={() => { setGrantTarget(null); setSelected([]) }}>Cancel category selection</button></div>
      </form>}
      {feedbackTarget && <form className="coaching-form" onSubmit={event => { event.preventDefault(); try { prepare({ kind: 'feedback', relationship: feedbackTarget, text: coachingFeedbackText(feedbackText) }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the text.') } }}>
        <h3>Feedback for {feedbackTarget.counterpart.email}</h3><p className="coaching-identity">Account ID: {feedbackTarget.counterpart.id}</p><p>Send plain-text training feedback only. Do not include medical advice or unrelated body or nutrition details. Active training access is checked by the server when sent.</p>
        <label>Plain-text feedback<textarea required maxLength={2000} rows={5} disabled={disabled} value={feedbackText} onChange={event => setFeedbackText(event.target.value)}/></label>
        <div className="coaching-actions"><button className="primary-button" disabled={disabled || !feedbackText.trim()}>Review feedback</button><button type="button" className="secondary-button" disabled={disabled} onClick={() => { setFeedbackTarget(null); setFeedbackText('') }}>Cancel feedback</button></div>
      </form>}
      {detail && <section className="coaching-detail" aria-label="Displayed collaborator data"><h3>Data from {detail.relationship.counterpart.email}</h3><p className="coaching-identity">Account ID: {detail.relationship.counterpart.id} · Reviewed access version {detail.relationship.version}</p>
        <button className="secondary-button" disabled={busy} onClick={() => setDetail(null)}>Close displayed data</button>
        {detail.snapshot && <SnapshotView snapshot={detail.snapshot} unit={unit}/>}
        {detail.feedback && <><h4>Plain-text feedback</h4>{!detail.feedback.feedback.length && <p>No feedback was returned.</p>}{detail.feedback.feedback.map(item => <article key={item.id} className="coaching-feedback"><p className="coaching-plaintext">{item.text}</p><small>{new Date(item.createdAt).toLocaleString()}</small>{detail.relationship.role === 'athlete' && <button className="secondary-button danger" disabled={disabled} onClick={() => prepare({ kind: 'deleteFeedback', relationship: detail.relationship, feedback: item })}>Review removing feedback</button>}</article>)}</>}
      </section>}
      {review && <section className="coaching-review" role="region" aria-labelledby="coaching-review-title" tabIndex={-1} ref={node => node?.focus()}>
        <h3 id="coaching-review-title">Review collaboration action</h3><ReviewDescription review={review} endpoint={client.endpoint!}/>
        <div className="coaching-actions"><button className="primary-button" disabled={busy} onClick={() => void confirmReview()}>Confirm collaboration action</button><button className="secondary-button" disabled={busy} onClick={() => setReview(null)}>Cancel</button></div>
      </section>}
    </>}
  </section>
}
function ReviewDescription({ review, endpoint }: { review: Review; endpoint: string }) {
  if (review.kind === 'invite' || review.kind === 'cancelInvite') return <><p>{review.kind === 'invite' ? 'Request an invitation to' : 'Cancel your pending invitation to'} <strong>{review.email}</strong> through {endpoint}?</p><p>{review.kind === 'invite' ? 'The service will receive this email. An eligible recipient may see your account ID and email. No health information or category access is included.' : 'Only your pending request to this exact email can be cancelled. Accepted relationships must be revoked separately.'}</p><p>A generic accepted response does not establish account existence or delivery.</p></>
  if (review.kind === 'accept' || review.kind === 'decline') return <><p>{review.kind === 'accept' ? 'Accept' : 'Decline'} the invitation from <strong>{review.invitation.athlete.email}</strong>?</p><p className="coaching-identity">Account ID: {review.invitation.athlete.id}</p><p>{review.kind === 'accept' ? 'Your account email and ID become visible to this athlete. Acceptance alone does not grant health-data access. Qualifications are not verified.' : 'This invitation will be removed without granting access.'}</p></>
  if (!('relationship' in review)) return null
  const person = review.relationship.counterpart
  return <><p>Exact recipient: <strong>{person.email}</strong><br/><span className="coaching-identity">Account ID: {person.id}</span></p><p>Service: {endpoint} · Reviewed access version {review.relationship.version}</p>
    {review.kind === 'consent' && <><p>Replace this account’s access with exactly these categories?</p>{review.scopes.length ? <ul>{review.scopes.map(scope => <li key={scope}>{SCOPE_LABELS[scope]}</li>)}</ul> : <p><strong>No categories. Remove all category access.</strong></p>}<p>Selected categories in the current and future saved cloud snapshots become readable by this account until revoked. Private notes are included only with their listed category. This action does not upload device data. Policy {COACHING_POLICY}.</p></>}
    {review.kind === 'revoke' && <p>End this collaboration and revoke all future access through it? The athlete retains their feedback history and may remove it. Previously seen or copied information cannot be recalled.</p>}
    {review.kind === 'feedback' && <><p>Send this exact plain-text feedback? Feedback is not medical care.</p><p className="coaching-plaintext">{review.text}</p></>}
    {review.kind === 'deleteFeedback' && <><p>Remove this feedback from your collaboration history?</p><p className="coaching-plaintext">{review.feedback.text}</p></>}
  </>
}
function SnapshotView({ snapshot, unit }: { snapshot: CoachingSnapshot; unit: UnitSystem }) {
  const { training, body, nutrition } = snapshot.categories
  return <div className="coaching-snapshot"><p>Saved cloud revision {snapshot.revision} · Updated {new Date(snapshot.updatedAt).toLocaleString()}. This is a read-only saved copy, not a live workout. Measurements use your viewing preference ({measurementUnit('weight', unit)}, {measurementUnit('height', unit)}).</p>
    {training && <section aria-label="Shared training category"><h4>Shared training</h4><p>{training.workouts.length} plans · {training.logs.length} saved workouts · {training.planHistory.length} saved plan versions</p>
      {training.workouts.map(workout => <details key={workout.id}><summary>{workout.title} · {workout.day}</summary><p>{workout.description}</p>{workout.exercises.map(exercise => <div key={exercise.id}><strong>{exercise.name}</strong><p>{exercise.sets} sets · {exercise.reps} reps · {exercise.restSeconds}s rest</p>{exercise.notes && <p className="coaching-plaintext">{exercise.notes}</p>}</div>)}</details>)}
      <details><summary>Workout history (up to 100 newest saved records)</summary>{[...training.logs].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 100).map(log => <article key={log.id}><h5>{log.title}</h5><p>{new Date(log.completedAt).toLocaleString()} · {log.duration} minutes</p>{log.notes && <p className="coaching-plaintext">{log.notes}</p>}{log.sets?.map(set => <p key={set.id}>Set {set.setNumber}: {set.reps ?? '—'} reps · {set.weightKg === null ? '—' : formatMeasurement(set.weightKg, 'load', unit)} {measurementUnit('load', unit)} · {set.seconds ?? '—'} seconds · RPE {set.rpe ?? '—'}{set.warmup ? ' · Warm-up' : ''} · {set.completed ? 'Completed' : 'Not completed'}</p>)}</article>)}</details>
      <details><summary>Saved plan versions</summary>{training.planHistory.map(plan => <div key={plan.id}><h5>{plan.label}</h5><p>{new Date(plan.savedAt).toLocaleString()} · {plan.workouts.map(workout => workout.title).join(', ')}</p></div>)}</details>
    </section>}
    {body && <section aria-label="Shared body category"><h4>Shared body measurements</h4><p>Saved weight: {formatMeasurement(body.measurements.weightKg, 'weight', unit)} {measurementUnit('weight', unit)} · Height: {formatMeasurement(body.measurements.heightCm, 'height', unit)} {measurementUnit('height', unit)}</p><details><summary>Weight diary ({body.weightHistory.length} entries, up to 100 shown)</summary>{[...body.weightHistory].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100).map(entry => <p key={entry.id}>{entry.date}: {formatMeasurement(entry.weightKg, 'weight', unit)} {measurementUnit('weight', unit)}</p>)}</details></section>}
    {nutrition && <section aria-label="Shared nutrition category"><h4>Shared nutrition diary</h4><p>Manually entered records and targets. These are not recommendations.</p><details><summary>Food ({nutrition.meals.length} entries, up to 100 shown)</summary>{[...nutrition.meals].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100).map(meal => <p key={meal.id}>{meal.date} · {meal.mealType} · {meal.foodName} · {meal.serving} · {meal.calories} kcal · Protein {meal.protein}g · Carbs {meal.carbs}g · Fat {meal.fat}g</p>)}</details><details><summary>Water ({nutrition.hydration.length} entries, up to 100 shown)</summary>{[...nutrition.hydration].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100).map(entry => <p key={entry.id}>{entry.date} · {entry.milliliters} ml · {entry.note}</p>)}</details><details><summary>Manual targets ({nutrition.targets.length} dates, up to 100 shown)</summary>{[...nutrition.targets].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100).map(target => <p key={target.date}>{target.date} · {target.calories} kcal · Protein {target.protein}g · Carbs {target.carbs}g · Fat {target.fat}g · Water {target.milliliters} ml</p>)}</details></section>}
  </div>
}
