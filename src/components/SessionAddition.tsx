import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { assertLibraryCopyCurrent, reviewLibraryCopy, type LibraryCopyReview } from '../exerciseLibrary'
import LibraryOrigin from './LibraryOrigin'
import { exerciseCatalog, filterCatalog } from '../exerciseCatalog'
import type { EquipmentId } from '../equipment'
import type { AppState, Exercise, Workout } from '../types'
import type { SessionAdditionReview } from '../sessionAddition'
import { EquipmentRequirements, EquipmentStatus } from './EquipmentControls'
import './ExercisePicker.css'
import './SessionAddition.css'

type Draft = { id: string; name: string; category: string; sets: string; reps: string; rest: string; notes: string; equipment?: EquipmentId[]; listedEmpty: boolean; libraryOrigin?: Exercise['libraryOrigin'] }
type Props = {
  state?: AppState; workouts: Workout[]; review: SessionAdditionReview | null; stale: boolean; error: string
  exerciseCount: number; rowCount: number
  onReview: (exercise: Exercise, libraryCopy?: LibraryCopyReview) => void; onBack: () => void; onCancel: () => void; onConfirm: () => void
}
const emptyDraft = (): Draft => ({ id: 'session-addition-draft', name: '', category: '', sets: '', reps: '', rest: '', notes: '', listedEmpty: false })

export default function SessionAddition({ state, workouts, review, stale, error, exerciseCount, rowCount, onReview, onBack, onCancel, onConfirm }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [draftError, setDraftError] = useState('')
  const [libraryCopy, setLibraryCopy] = useState<LibraryCopyReview | undefined>()
  const [copySourceEpoch, setCopySourceEpoch] = useState(0)
  const mounted = useRef(true)
  const epoch = useRef(0)
  const sourceEpoch = useRef(0)
  const sourceSnapshot = JSON.stringify({ workouts, library: state?.exerciseLibrary })
  const source = useRef({ state, workouts, library: state?.exerciseLibrary, snapshot: sourceSnapshot })
  if (source.current.state !== state || source.current.workouts !== workouts || source.current.library !== state?.exerciseLibrary || source.current.snapshot !== sourceSnapshot) {
    epoch.current++; sourceEpoch.current++
  }
  source.current = { state, workouts, library: state?.exerciseLibrary, snapshot: sourceSnapshot }
  const renderEpoch = epoch.current
  const libraryStale = !!libraryCopy && copySourceEpoch !== sourceEpoch.current
  const current = useRef({ onReview, onBack, onCancel, onConfirm, stale, draft, libraryCopy })
  current.current = { onReview, onBack, onCancel, onConfirm, stale, draft, libraryCopy }
  const draftSnapshot = JSON.stringify(draft)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const valid = () => mounted.current && epoch.current === renderEpoch && !stale && !current.current.stale && source.current.library === state?.exerciseLibrary && current.current.onReview === onReview && current.current.onConfirm === onConfirm && current.current.draft === draft && current.current.libraryCopy === libraryCopy && JSON.stringify(current.current.draft) === draftSnapshot && JSON.stringify({ workouts, library: state?.exerciseLibrary }) === sourceSnapshot
  const edit = (next: Draft | null) => { if (!valid()) return; epoch.current++; setDraft(next); setDraftError('') }
  const catalog = exerciseCatalog(workouts, state?.exerciseLibrary)
  const categories = [...new Set(catalog.map(item => item.exercise.category))].filter(Boolean).sort()
  const results = filterCatalog(catalog, query, category)
  const capacity = exerciseCount >= 50 ? 'This session already has 50 exercises. No exercises or rows will be removed to make room.' : rowCount >= 2500 ? 'This session already has 2,500 set rows. No rows will be removed to make room.' : ''
  const submit = () => {
    if (!valid() || !draft || capacity) return
    if (libraryStale) { setDraftError('The library source changed. Return to the library choice and select the current entry again.'); return }
    if (libraryCopy) { try { if (!state) return; assertLibraryCopyCurrent(state, libraryCopy) } catch (cause) { setDraftError(cause instanceof Error ? cause.message : 'The library source changed.'); return } }
    if (!draft.name.trim() || draft.name.length > 100 || draft.category.length > 100 || !draft.reps.trim() || draft.reps.length > 50 || draft.notes.length > 1000) { setDraftError('Enter an exercise name and a target in reps or seconds, within the displayed limits.'); return }
    if (!/^\d+$/.test(draft.sets) || Number(draft.sets) < 1 || Number(draft.sets) > 20) { setDraftError('Choose an exact whole-number set count from 1 to 20.'); return }
    if (!/^\d+$/.test(draft.rest) || Number(draft.rest) < 0 || Number(draft.rest) > 900) { setDraftError('Enter a whole-number rest time from 0 to 900 seconds.'); return }
    if (draft.listedEmpty) { setDraftError('Select at least one equipment category, or explicitly choose unknown or no equipment.'); return }
    if (rowCount + Number(draft.sets) > 2500) { setDraftError('These sets would exceed the 2,500-row session limit. Choose fewer sets; no rows will be truncated.'); return }
    epoch.current++
    const selected: Exercise = { id: draft.id, name: draft.name, category: draft.category, sets: Number(draft.sets), reps: draft.reps, restSeconds: Number(draft.rest), notes: draft.notes, ...(draft.equipment === undefined ? {} : { equipment: [...draft.equipment] }), ...(draft.libraryOrigin ? { libraryOrigin: { ...draft.libraryOrigin } } : {}) }
    if (libraryCopy) onReview(selected, libraryCopy)
    else onReview(selected)
  }
  const choose = (exercise?: Exercise, entryId?: string) => {
    if (!valid()) return
    try {
      const copy = entryId && state ? reviewLibraryCopy(state, entryId) : undefined
      const selected = copy?.exercise ?? exercise
      setLibraryCopy(copy); setCopySourceEpoch(sourceEpoch.current)
      edit(selected ? { id: selected.id, name: selected.name, category: selected.category, sets: String(selected.sets), reps: selected.reps, rest: String(selected.restSeconds), notes: selected.notes ?? '', ...(selected.equipment === undefined ? {} : { equipment: [...selected.equipment] }), ...(selected.libraryOrigin ? { libraryOrigin: { ...selected.libraryOrigin } } : {}), listedEmpty: false } : emptyDraft())
    } catch (cause) { setDraftError(cause instanceof Error ? cause.message : 'This library entry changed. Select it again.') }
  }
  return <section className="panel exercise-picker session-addition" role="region" aria-label="Session exercise addition">
    <h2>{review ? 'Review session exercise addition' : 'Add an exercise to this session'}</h2>
    {state && <Link to="/exercise-library">Manage your manual exercise library</Link>}
    <p>Only the active session changes. Saved plans and previous workouts stay unchanged. Nothing is added until you review and confirm. This form is temporary and is not saved if you cancel or leave.</p>
    <p>Existing planned duration and calorie estimates are unchanged. Choose your own set count and targets; library values are editable starting values, not an intensity or safety recommendation.</p>
    {review ? <>
      <p>Add exactly <strong>{review.addedSetCount} fresh {review.exercise.name} sets</strong> to this session.</p>
      <dl className="addition-review"><dt>Name</dt><dd>{review.exercise.name}</dd><dt>Category</dt><dd>{review.exercise.category || 'Uncategorized'}</dd><dt>Set count</dt><dd>{review.addedSetCount}</dd><dt>Target reps or seconds</dt><dd>{review.exercise.reps}</dd><dt>Rest between sets</dt><dd>{review.exercise.restSeconds} seconds</dd><dt>Notes</dt><dd>{review.exercise.notes || 'No notes'}</dd></dl>
      <LibraryOrigin origin={review.exercise.libraryOrigin} />
      {review.exercise.libraryOrigin && <p>Values may differ from the source revision after your edits. This label records ancestry only.</p>}
      <EquipmentStatus requirements={review.exercise.equipment} />
      <p>New rows have blank recorded reps, seconds, load and RPE, with warm-up and completion off. Existing rows, load entries and timer/rest state stay as they are. No previous-load reference is borrowed from the library entry.</p>
      <button type="button" className="secondary-button" disabled={stale} onClick={() => { if (valid()) { epoch.current++; onBack() } }}>Back to exercise details</button>
      <button type="button" className="primary-button" disabled={stale || libraryStale} onClick={() => { if (valid() && !libraryStale) onConfirm() }}>Confirm addition of {review.addedSetCount} sets</button>
    </> : draft ? <form noValidate onSubmit={event => { event.preventDefault(); submit() }}>
      <LibraryOrigin origin={draft.libraryOrigin} />
      <div className="exercise-picker-filters">
        <label>Session exercise name<input value={draft.name} maxLength={100} required onChange={event => edit({ ...draft, name: event.target.value })} /></label>
        <label>Session exercise category<input value={draft.category} maxLength={100} onChange={event => edit({ ...draft, category: event.target.value })} /></label>
        <label>Number of sets (1–20)<input type="text" inputMode="numeric" maxLength={3} value={draft.sets} required onChange={event => edit({ ...draft, sets: event.target.value })} /></label>
        <label>Target reps or seconds<input value={draft.reps} maxLength={50} required aria-describedby="addition-target-help" onChange={event => edit({ ...draft, reps: event.target.value })} /></label>
        <label>Rest between sets (seconds, 0–900)<input type="text" inputMode="numeric" maxLength={4} value={draft.rest} required onChange={event => edit({ ...draft, rest: event.target.value })} /></label>
      </div>
      <p id="addition-target-help">Enter your target, such as a rep count or range. Include “sec” for a timed exercise. These are targets; recorded set values start blank.</p>
      <label className="notes-field">Exercise notes<textarea value={draft.notes} maxLength={1000} onChange={event => edit({ ...draft, notes: event.target.value })} /></label>
      <EquipmentRequirements label="Session exercise" requirements={draft.equipment} listedEmpty={draft.listedEmpty} onChange={(equipment, listedEmpty) => edit({ ...draft, equipment, listedEmpty })} />
      <button type="button" className="secondary-button" disabled={stale} onClick={() => { if (!valid()) return; setLibraryCopy(undefined); setCopySourceEpoch(sourceEpoch.current); edit(null) }}>Back to library or custom choice</button>
      <button type="submit" className="primary-button" disabled={stale || libraryStale || !!capacity}>Review session addition</button>
    </form> : <>
      <button type="button" className="secondary-button" disabled={stale || !!capacity} onClick={() => choose()}>Create custom session exercise</button>
      <div className="exercise-picker-filters"><label>Search session exercise library<input type="search" maxLength={100} value={query} onChange={event => { if (!valid()) return; epoch.current++; setQuery(event.target.value) }} /></label><label>Session library category<select value={category} onChange={event => { if (!valid()) return; epoch.current++; setCategory(event.target.value) }}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div>
      <p role="status">{results.length} matching entries</p>
      <ul>{results.map(({ key, exercise, source, libraryEntryId }, index) => <li key={key}><div><strong>{exercise.name}</strong><small>{exercise.category || 'Uncategorized'} · {source}{libraryEntryId && ` · manual entry ${index + 1} · revision ${exercise.libraryOrigin?.revision}`}</small>{!libraryEntryId && <LibraryOrigin origin={exercise.libraryOrigin} />}<small>{exercise.sets} sets · {exercise.reps} · {exercise.restSeconds}s rest</small><EquipmentStatus requirements={exercise.equipment} /></div><button type="button" className="secondary-button" disabled={stale || !!capacity} onClick={() => choose(exercise, libraryEntryId)}>Use {exercise.name}</button></li>)}</ul>
    </>}
    {libraryStale && <p role="alert" className="error-message">The library source changed. Your draft is kept. Return to the library choice and select the current entry again.</p>}
    {capacity && <p role="alert" className="error-message">{capacity}</p>}
    {stale && <p role="alert" className="error-message">The session, page or load entries changed. Cancel and start a new addition review.</p>}
    {!stale && (draftError || error) && <p role="alert" className="error-message">{draftError || error}</p>}
    <button type="button" className="secondary-button" onClick={() => { if (mounted.current && epoch.current === renderEpoch && current.current.onCancel === onCancel) { epoch.current++; onCancel() } }}>Cancel addition</button>
  </section>
}
