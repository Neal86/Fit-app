import { useEffect, useMemo, useRef, useState } from 'react'
import { exerciseCatalog, filterCatalog } from '../exerciseCatalog'
import type { EquipmentId } from '../equipment'
import type { Exercise, Workout } from '../types'
import type { SessionAdditionReview } from '../sessionAddition'
import { EquipmentRequirements, EquipmentStatus } from './EquipmentControls'
import './ExercisePicker.css'
import './SessionAddition.css'

type Draft = { id: string; name: string; category: string; sets: string; reps: string; rest: string; notes: string; equipment?: EquipmentId[]; listedEmpty: boolean }
type Props = {
  workouts: Workout[]; review: SessionAdditionReview | null; stale: boolean; error: string
  exerciseCount: number; rowCount: number
  onReview: (exercise: Exercise) => void; onBack: () => void; onCancel: () => void; onConfirm: () => void
}
const emptyDraft = (): Draft => ({ id: 'session-addition-draft', name: '', category: '', sets: '', reps: '', rest: '', notes: '', listedEmpty: false })

export default function SessionAddition({ workouts, review, stale, error, exerciseCount, rowCount, onReview, onBack, onCancel, onConfirm }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [draftError, setDraftError] = useState('')
  const mounted = useRef(true)
  const epoch = useRef(0)
  const renderEpoch = epoch.current
  const current = useRef({ onReview, onBack, onCancel, onConfirm, stale })
  current.current = { onReview, onBack, onCancel, onConfirm, stale }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const valid = () => mounted.current && epoch.current === renderEpoch && !stale && !current.current.stale && current.current.onReview === onReview && current.current.onConfirm === onConfirm
  const edit = (next: Draft | null) => { if (!valid()) return; epoch.current++; setDraft(next); setDraftError('') }
  const catalog = useMemo(() => exerciseCatalog(workouts), [workouts])
  const categories = [...new Set(catalog.map(item => item.exercise.category))].filter(Boolean).sort()
  const results = filterCatalog(catalog, query, category)
  const capacity = exerciseCount >= 50 ? 'This session already has 50 exercises. No exercises or rows will be removed to make room.' : rowCount >= 2500 ? 'This session already has 2,500 set rows. No rows will be removed to make room.' : ''
  const submit = () => {
    if (!valid() || !draft || capacity) return
    if (!draft.name.trim() || draft.name.length > 100 || draft.category.length > 100 || !draft.reps.trim() || draft.reps.length > 50 || draft.notes.length > 1000) { setDraftError('Enter an exercise name and a target in reps or seconds, within the displayed limits.'); return }
    if (!/^\d+$/.test(draft.sets) || Number(draft.sets) < 1 || Number(draft.sets) > 20) { setDraftError('Choose an exact whole-number set count from 1 to 20.'); return }
    if (!/^\d+$/.test(draft.rest) || Number(draft.rest) < 0 || Number(draft.rest) > 900) { setDraftError('Enter a whole-number rest time from 0 to 900 seconds.'); return }
    if (draft.listedEmpty) { setDraftError('Select at least one equipment category, or explicitly choose unknown or no equipment.'); return }
    if (rowCount + Number(draft.sets) > 2500) { setDraftError('These sets would exceed the 2,500-row session limit. Choose fewer sets; no rows will be truncated.'); return }
    epoch.current++
    onReview({ id: draft.id, name: draft.name, category: draft.category, sets: Number(draft.sets), reps: draft.reps, restSeconds: Number(draft.rest), notes: draft.notes, ...(draft.equipment === undefined ? {} : { equipment: [...draft.equipment] }) })
  }
  return <section className="panel exercise-picker session-addition" role="region" aria-label="Session exercise addition">
    <h2>{review ? 'Review session exercise addition' : 'Add an exercise to this session'}</h2>
    <p>Only the active session changes. Saved plans and previous workouts stay unchanged. Nothing is added until you review and confirm. This form is temporary and is not saved if you cancel or leave.</p>
    <p>Existing planned duration and calorie estimates are unchanged. Choose your own set count and targets; library values are editable starting values, not an intensity or safety recommendation.</p>
    {review ? <>
      <p>Add exactly <strong>{review.addedSetCount} fresh {review.exercise.name} sets</strong> to this session.</p>
      <dl className="addition-review"><dt>Name</dt><dd>{review.exercise.name}</dd><dt>Category</dt><dd>{review.exercise.category || 'Uncategorized'}</dd><dt>Set count</dt><dd>{review.addedSetCount}</dd><dt>Target reps or seconds</dt><dd>{review.exercise.reps}</dd><dt>Rest between sets</dt><dd>{review.exercise.restSeconds} seconds</dd><dt>Notes</dt><dd>{review.exercise.notes || 'No notes'}</dd></dl>
      <EquipmentStatus requirements={review.exercise.equipment} />
      <p>New rows have blank recorded reps, seconds, load and RPE, with warm-up and completion off. Existing rows, load entries and timer/rest state stay as they are. No previous-load reference is borrowed from the library entry.</p>
      <button type="button" className="secondary-button" disabled={stale} onClick={() => { if (valid()) { epoch.current++; onBack() } }}>Back to exercise details</button>
      <button type="button" className="primary-button" disabled={stale} onClick={() => { if (valid()) onConfirm() }}>Confirm addition of {review.addedSetCount} sets</button>
    </> : draft ? <form noValidate onSubmit={event => { event.preventDefault(); submit() }}>
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
      <button type="button" className="secondary-button" disabled={stale} onClick={() => edit(null)}>Back to library or custom choice</button>
      <button type="submit" className="primary-button" disabled={stale || !!capacity}>Review session addition</button>
    </form> : <>
      <button type="button" className="secondary-button" disabled={stale || !!capacity} onClick={() => edit(emptyDraft())}>Create custom session exercise</button>
      <div className="exercise-picker-filters"><label>Search session exercise library<input type="search" maxLength={100} value={query} onChange={event => { if (!valid()) return; epoch.current++; setQuery(event.target.value) }} /></label><label>Session library category<select value={category} onChange={event => { if (!valid()) return; epoch.current++; setCategory(event.target.value) }}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div>
      <p role="status">{results.length} matching entries</p>
      <ul>{results.map(({ key, exercise, source }) => <li key={key}><div><strong>{exercise.name}</strong><small>{exercise.category || 'Uncategorized'} · {source}</small><small>{exercise.sets} sets · {exercise.reps} · {exercise.restSeconds}s rest</small><EquipmentStatus requirements={exercise.equipment} /></div><button type="button" className="secondary-button" disabled={stale || !!capacity} onClick={() => edit({ id: exercise.id, name: exercise.name, category: exercise.category, sets: String(exercise.sets), reps: exercise.reps, rest: String(exercise.restSeconds), notes: exercise.notes ?? '', ...(exercise.equipment === undefined ? {} : { equipment: [...exercise.equipment] }), listedEmpty: false })}>Use {exercise.name}</button></li>)}</ul>
    </>}
    {capacity && <p role="alert" className="error-message">{capacity}</p>}
    {stale && <p role="alert" className="error-message">The session, page or load entries changed. Cancel and start a new addition review.</p>}
    {!stale && (draftError || error) && <p role="alert" className="error-message">{draftError || error}</p>}
    <button type="button" className="secondary-button" onClick={() => { if (mounted.current && epoch.current === renderEpoch && current.current.onCancel === onCancel) { epoch.current++; onCancel() } }}>Cancel addition</button>
  </section>
}
