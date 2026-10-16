import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { AppState, LibraryEntry, LibraryContent } from '../types'
import type { EquipmentId } from '../equipment'
import { applyLibraryChange, reviewLibraryArchive, reviewLibraryCreate, reviewLibraryEdit, type LibraryChangeReview } from '../exerciseLibrary'
import type { UpdateState } from './WorkoutSession'
import { EquipmentRequirements } from './EquipmentControls'
import LibraryContentSummary from './LibraryContentSummary'
import { usePlanningGuard } from './usePlanningGuard'
import './ExerciseLibrary.css'

type Draft = { name: string; category: string; sets: string; reps: string; rest: string; notes: string; notesProvided: boolean; equipment?: EquipmentId[]; listedEmpty: boolean }
const blank = (): Draft => ({ name: '', category: '', sets: '', reps: '', rest: '', notes: '', notesProvided: false, listedEmpty: false })
const fromEntry = (entry: LibraryEntry): Draft => ({ ...blank(), ...entry.exercise, sets: String(entry.exercise.sets), rest: String(entry.exercise.restSeconds), notes: entry.exercise.notes ?? '', notesProvided: Object.hasOwn(entry.exercise, 'notes'), ...(entry.exercise.equipment === undefined ? {} : { equipment: [...entry.exercise.equipment] }) })
const content = (draft: Draft): LibraryContent => {
  if (!/^\d+$/.test(draft.sets) || Number(draft.sets) < 1 || Number(draft.sets) > 20) throw new Error('Enter a whole-number set count from 1 to 20.')
  if (!/^\d+$/.test(draft.rest) || Number(draft.rest) < 0 || Number(draft.rest) > 900) throw new Error('Enter a whole-number rest time from 0 to 900 seconds.')
  if (draft.listedEmpty) throw new Error('Select equipment categories, or explicitly choose unknown or no equipment.')
  return { name: draft.name, category: draft.category, sets: Number(draft.sets), reps: draft.reps, restSeconds: Number(draft.rest), ...(draft.notesProvided || draft.notes ? { notes: draft.notes } : {}), ...(draft.equipment === undefined ? {} : { equipment: [...draft.equipment] }) }
}

export default function ExerciseLibrary({ state, update, readGeneration }: { state: AppState; update: UpdateState; readGeneration?: () => number }) {
  const guard = usePlanningGuard(state, readGeneration)
  const location = useLocation()
  const [view, setView] = useState<'active' | 'archived'>('active')
  const [form, setForm] = useState<{ id?: string; draft: Draft; baseline: string; source: AppState; library: AppState['exerciseLibrary']; snapshot: string; generation: number | undefined; route: string; sourceEpoch: number } | null>(null)
  const [review, setReview] = useState<LibraryChangeReview | null>(null)
  const [reviewSourceEpoch, setReviewSourceEpoch] = useState(guard.sourceEpoch)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const busy = useRef(false)
  const current = useRef({ form, review, view })
  current.current = { form, review, view }
  const draftSnapshot = JSON.stringify({ form, review, view })
  const librarySnapshot = JSON.stringify(state.exerciseLibrary)
  const valid = () => !busy.current && guard.isCurrent() && current.current.form === form && current.current.review === review && current.current.view === view && JSON.stringify(current.current) === draftSnapshot
  const sourceCurrent = (!review || reviewSourceEpoch === guard.sourceEpoch) && (!form || form.source === state && form.library === state.exerciseLibrary && form.snapshot === librarySnapshot && form.generation === readGeneration?.() && form.route === guard.route && form.sourceEpoch === guard.sourceEpoch)
  const dirty = !!form && JSON.stringify(form.draft) !== form.baseline
  useEffect(() => {
    if (!dirty && !review) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty, review])
  const canDiscard = () => valid() && (!dirty || window.confirm('Discard unsaved exercise-library form edits?')) && valid()
  useEffect(() => {
    if (!dirty) return
    const preventDiscard = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (!anchor || anchor.hasAttribute('download') || anchor.target && anchor.target !== '_self') return
      const target = new URL(anchor.href, window.location.href)
      if (target.origin !== window.location.origin || `${target.pathname}${target.search}${target.hash}` === `${location.pathname}${location.search}${location.hash}`) return
      if (!canDiscard()) { event.preventDefault(); event.stopPropagation() }
    }
    document.addEventListener('click', preventDiscard, true)
    return () => document.removeEventListener('click', preventDiscard, true)
  })
  const reset = () => { guard.invalidate(); setForm(null); setReview(null); setError('') }
  const choose = (entry?: LibraryEntry) => {
    if (!canDiscard()) return
    const draft = entry ? fromEntry(entry) : blank()
    guard.invalidate(); setReview(null); setError(''); setMessage('')
    setForm({ ...(entry ? { id: entry.id } : {}), draft, baseline: JSON.stringify(draft), source: state, library: state.exerciseLibrary, snapshot: librarySnapshot, generation: readGeneration?.(), route: guard.route, sourceEpoch: guard.sourceEpoch })
  }
  const edit = (draft: Draft) => { if (!valid() || !form) return; guard.invalidate(); setForm({ ...form, draft }); setReview(null); setError('') }
  const reviewForm = () => {
    if (!valid() || !form) return
    if (!sourceCurrent) { setError('Saved data changed. Your temporary form is kept. Cancel and reopen the entry before reviewing.'); return }
    try { const next = form.id ? reviewLibraryEdit(state, form.id, content(form.draft)) : reviewLibraryCreate(state, content(form.draft)); guard.invalidate(); setReviewSourceEpoch(guard.sourceEpoch); setReview(next); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the exercise fields.') }
  }
  const reviewStatus = (entry: LibraryEntry) => {
    if (!canDiscard()) return
    try { const next = reviewLibraryArchive(state, entry.id, entry.status === 'active'); guard.invalidate(); setForm(null); setReviewSourceEpoch(guard.sourceEpoch); setReview(next); setError(''); setMessage('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to review this entry.') }
  }
  const confirm = () => {
    if (!valid() || !review || !sourceCurrent) return
    const currentDraft = () => current.current.form === form && current.current.review === review && JSON.stringify(current.current) === draftSnapshot
    busy.current = true
    try {
      const saved = guard.commit(update, value => applyLibraryChange(value, review), 'Exercise library saved', currentDraft)
      if (saved) { reset(); setMessage(review.kind === 'archive' ? 'Entry archived. Existing copies keep their saved values.' : review.kind === 'restore' ? 'Entry restored. It is available for new copies.' : 'Exercise library entry saved.') }
      else setError('The library was not saved. Your form and review are kept; retry when storage is available.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The library was not saved. Your form and review are kept.') }
    finally { busy.current = false }
  }
  const entries = state.exerciseLibrary?.entries ?? []
  const displayed = entries.filter(entry => entry.status === view)
  const capacity = entries.length >= 500
  return <section className="exercise-library"><header className="page-header"><span>Your manual entries</span><h1>Your exercise library</h1><p>Save exercises you write yourself, then explicitly copy them into a plan or session. Nothing is collected automatically. Targets and equipment are your entries and have not been assessed for your needs.</p></header>
    <Link className="secondary-button" to="/plan">Back to plan builder</Link>
    <div className="notice">Library edits never update existing plan, session or history copies. Archive hides an entry from new-copy choices; it keeps the entry and its revision and can be reversed. There is no permanent delete.</div>
    <div className="notice">Compatibility: older strict version-4 builds and APIs reject exercise-library and copy-origin metadata. Keep a private pre-feature backup and a separate newer full export. Deliberately restoring an older backup omits later work.</div>
    <p>{entries.length} of 500 saved entries, including archived entries. No entries are truncated to make room.</p>
    <div className="library-actions"><button type="button" className="primary-button" disabled={capacity} onClick={() => choose()}>Create library exercise</button><button type="button" className="secondary-button" aria-pressed={view === 'active'} onClick={() => { if (!valid()) return; guard.invalidate(); setView('active') }}>Active entries ({entries.filter(entry => entry.status === 'active').length})</button><button type="button" className="secondary-button" aria-pressed={view === 'archived'} onClick={() => { if (!valid()) return; guard.invalidate(); setView('archived') }}>Archived entries ({entries.filter(entry => entry.status === 'archived').length})</button></div>
    {capacity && <p role="status">Your library is full. You can still edit, archive and restore entries. Archiving does not free a slot.</p>}
    {message && <p role="status">{message}</p>}
    {(form || review) && <section className="panel" aria-label="Library exercise editor"><p>This unsaved form is temporary. It is not kept if you cancel or leave. Review and confirm before anything is saved.</p>
      {!sourceCurrent && <p role="alert" className="error-message">Saved data changed. Your temporary form is kept. Cancel and reopen the current entry before saving.</p>}
      {review ? <section className="library-review" aria-label="Library change review"><h2>Review {review.kind === 'create' ? 'new library exercise' : `${review.kind} library exercise`}</h2>
        <p>Destination: your saved exercise library only.</p>
        {review.entry && <><h3>Currently saved: revision {review.entry.revision} · {review.entry.status}</h3><LibraryContentSummary exercise={review.entry.exercise} /></>}
        {review.content && <><h3>{review.kind === 'create' ? 'New entry' : 'After saving'}</h3><LibraryContentSummary exercise={review.content} /></>}
        <p>{review.kind === 'archive' ? 'This entry will be archived and unavailable for new copies. Its content revision stays unchanged.' : review.kind === 'restore' ? 'This entry will be active and available for new copies. Its content revision stays unchanged.' : 'A real content edit increases the entry revision; saving identical content does not.'} All existing copies, completed rows, unfinished sessions and history stay unchanged.</p>
        {form && <button type="button" className="secondary-button" onClick={() => { if (!valid()) return; guard.invalidate(); setReview(null); setError('') }}>Back to library details</button>}
        <button type="button" className="primary-button" disabled={!sourceCurrent} onClick={confirm}>Confirm {review.kind === 'create' ? 'create' : review.kind} library exercise</button>
      </section> : form && <form className="form" noValidate onSubmit={event => { event.preventDefault(); reviewForm() }}><h2>{form.id ? 'Edit library exercise' : 'Create library exercise'}</h2>
        <label>Library exercise name<input required maxLength={100} value={form.draft.name} onChange={event => edit({ ...form.draft, name: event.target.value })} /></label>
        <label>Library exercise category<input maxLength={100} value={form.draft.category} onChange={event => edit({ ...form.draft, category: event.target.value })} /></label>
        <label>Library set count (1–20)<input required type="text" inputMode="numeric" maxLength={3} value={form.draft.sets} onChange={event => edit({ ...form.draft, sets: event.target.value })} /></label>
        <label>Library target reps or seconds<input required maxLength={50} value={form.draft.reps} onChange={event => edit({ ...form.draft, reps: event.target.value })} /></label>
        <label>Library rest seconds (0–900)<input required type="text" inputMode="numeric" maxLength={4} value={form.draft.rest} onChange={event => edit({ ...form.draft, rest: event.target.value })} /></label>
        <label>Library exercise notes<textarea maxLength={1000} value={form.draft.notes} onChange={event => edit({ ...form.draft, notes: event.target.value })} /></label>
        <EquipmentRequirements label="Library exercise" requirements={form.draft.equipment} listedEmpty={form.draft.listedEmpty} onChange={(equipment, listedEmpty) => edit({ ...form.draft, equipment, listedEmpty })} />
        <button type="submit" className="primary-button" disabled={!sourceCurrent || !form.id && capacity}>Review library exercise</button>
      </form>}
      <button type="button" className="secondary-button" onClick={() => { if (canDiscard()) reset() }}>Cancel library edit</button>
      {error && <p role="alert" className="error-message">{error}</p>}
    </section>}
    {!form && !review && error && <p role="alert" className="error-message">{error}</p>}
    <ul className="library-entries" aria-label={`${view === 'active' ? 'Active' : 'Archived'} library entries`}>{displayed.map((entry, index) => <li className="panel library-entry" key={entry.id}><h2>{entry.exercise.name}</h2><p>Manual library entry {index + 1} · revision {entry.revision} · {entry.status}</p><LibraryContentSummary exercise={entry.exercise} /><div className="library-actions"><button type="button" className="secondary-button" onClick={() => choose(entry)}>Edit {entry.exercise.name}</button><button type="button" className="secondary-button" onClick={() => reviewStatus(entry)}>{entry.status === 'active' ? 'Archive' : 'Restore'} {entry.exercise.name}</button></div></li>)}</ul>
    {!displayed.length && <p>No {view} library entries. Create an entry by filling in your own exercise details.</p>}
  </section>
}
