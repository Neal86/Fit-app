import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { reviewLibraryCopy, type LibraryCopyReview } from '../exerciseLibrary'
import LibraryOrigin from './LibraryOrigin'
import { exerciseCatalog, filterCatalog } from '../exerciseCatalog'
import type { ActiveSession, AppState, Exercise, Workout } from '../types'
import type { SessionReplacementReview } from '../sessionReplacement'
import type { MeasurementDraft } from '../units'
import { formatMeasurement, measurementUnit } from '../units'
import './ExercisePicker.css'
import { EquipmentStatus } from './EquipmentControls'
import { groupRowLabel } from './sessionGroupLabels'

type Props = {
  state?: AppState
  session?: ActiveSession
  workouts: Workout[]
  sourceName: string
  review: SessionReplacementReview | null
  drafts: Record<string, MeasurementDraft>
  stale: boolean
  error: string
  onSelect: (exercise: Exercise, libraryCopy?: LibraryCopyReview) => void
  onCancel: () => void
  onBack: () => void
  onConfirm: () => void
}
export default function SessionReplacement({ state, session, workouts, sourceName, review, drafts, stale, error, onSelect, onCancel, onBack, onConfirm }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [selectionError, setSelectionError] = useState('')
  const mounted = useRef(true)
  const epoch = useRef(0)
  const sourceSnapshot = JSON.stringify({ workouts, library: state?.exerciseLibrary, review, stale })
  const current = useRef({ state, workouts, library: state?.exerciseLibrary, sourceSnapshot, onSelect, onCancel, onBack, onConfirm })
  if (current.current.state !== state || current.current.workouts !== workouts || current.current.library !== state?.exerciseLibrary || current.current.sourceSnapshot !== sourceSnapshot) epoch.current++
  current.current = { state, workouts, library: state?.exerciseLibrary, sourceSnapshot, onSelect, onCancel, onBack, onConfirm }
  const renderEpoch = epoch.current
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const valid = () => mounted.current && epoch.current === renderEpoch && current.current.library === state?.exerciseLibrary && current.current.onSelect === onSelect && current.current.onConfirm === onConfirm && JSON.stringify({ workouts, library: state?.exerciseLibrary, review, stale }) === sourceSnapshot
  const select = (exercise: Exercise, entryId?: string) => {
    if (stale || !valid()) return
    try {
      const copy = entryId && state ? reviewLibraryCopy(state, entryId) : undefined
      epoch.current++; setSelectionError(''); if (copy) onSelect(structuredClone(copy.exercise), copy); else onSelect(structuredClone(exercise))
    } catch (cause) { setSelectionError(cause instanceof Error ? cause.message : 'The library entry changed. Select it again.') }
  }
  const catalog = exerciseCatalog(workouts, state?.exerciseLibrary)
  const categories = [...new Set(catalog.map(item => item.exercise.category))].filter(Boolean).sort()
  const results = filterCatalog(catalog, query, category)
  return <section className="panel exercise-picker" role="region" aria-label="Session exercise replacement">
    <h2>{review ? 'Review exercise replacement' : `Replace unfinished ${sourceName} sets`}</h2>
    {state && <Link to="/exercise-library">Manage your manual exercise library</Link>}
    <p>Only this session changes. Saved plans and previous workouts stay unchanged. Library entries have not been assessed for your needs; selecting one is not a safety review.</p>
    {review ? <>
      <p>Replace {review.removedSets.length} unfinished {sourceName} sets with exactly {review.removedSets.length} fresh {review.replacement.name} sets. Keep {review.completedCount} completed {sourceName} sets with their original identity, numbers and values.</p>
      <p>Selected entry: {review.replacement.category || 'Uncategorized'} · {review.replacement.sets} planned sets × {review.replacement.reps} · {review.replacement.restSeconds}s rest. This session will have {review.removedSets.length} actual replacement sets, regardless of the entry’s planned count.</p>
      {review.groupImpacts.length > 0 && <div role="note"><p>This replacement affects the exact group members below. Only referenced unfinished rows remap to fresh blank replacement rows. Completed references, group IDs, round IDs, order and chosen round rest stay unchanged. The current countdown is unchanged.</p><ul aria-label="Grouping replacement impacts">{review.groupImpacts.map(impact => <li key={impact.setId}><div><strong>{impact.groupName} · round {impact.roundNumber}</strong><small>{session ? groupRowLabel(session, session.sets.find(set => set.id === impact.setId)!) : `Unfinished row ${impact.setId}`} → fresh blank {review.replacement.name} row</small></div></li>)}</ul></div>}
      <LibraryOrigin origin={review.replacement.libraryOrigin} />
      {review.replacement.libraryOrigin && <p>Values may differ from the source revision after edits. This is ancestry only, not expert approval.</p>}
      <EquipmentStatus requirements={review.replacement.equipment} />
      {review.replacement.notes && <p>{review.replacement.notes}</p>}
      <p>All values and unsaved load text in the unfinished rows below will be cleared after confirmation. New rows start with blank reps, seconds, load and RPE; warm-up and completion are off. No previous-load reference is borrowed from the selected entry. Completed rows and other exercises’ entries stay as they are.</p>
      <ul aria-label="Unfinished rows to reset">{review.removedSets.map(set => {
        const draft = drafts[set.id]
        return <li key={set.id}><div><strong>{session ? groupRowLabel(session, set) : `${sourceName} set ${set.setNumber}`}</strong><small>Reps: {set.reps ?? 'blank'} · Seconds: {set.seconds ?? 'blank'} · RPE: {set.rpe ?? 'blank'} · Warm-up: {set.warmup ? 'yes' : 'no'}</small><small>Saved load: {set.weightKg === null ? 'blank' : `${formatMeasurement(set.weightKg, 'load', draft.unit)} ${measurementUnit('load', draft.unit)}`} · Load entry: {draft.text === '' ? 'blank' : `“${draft.text}” ${measurementUnit('load', draft.unit)}`}</small></div></li>
      })}</ul>
      <button type="button" className="secondary-button" onClick={() => { if (valid() && !stale) { epoch.current++; onBack() } }}>Back to exercise selection</button>
      <button type="button" className="primary-button" disabled={stale} onClick={() => { if (valid() && !stale) onConfirm() }}>Confirm replacement and reset {review.removedSets.length} unfinished sets</button>
    </> : <>
      <p>Choose an active manual library entry, a saved-plan entry or a starter template. To create a reusable custom entry, cancel and open your exercise library.</p>
      <div className="exercise-picker-filters"><label>Search replacement exercises<input type="search" value={query} maxLength={100} onChange={event => { if (!valid()) return; epoch.current++; setQuery(event.target.value) }}/></label><label>Replacement category<select value={category} onChange={event => { if (!valid()) return; epoch.current++; setCategory(event.target.value) }}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div>
      <p role="status">{results.length} matching entries</p>
      <ul>{results.map(({ key, exercise, source, libraryEntryId }, index) => <li key={key}><div><strong>{exercise.name}</strong><small>{exercise.category || 'Uncategorized'} · {source}{libraryEntryId && ` · manual entry ${index + 1} · revision ${exercise.libraryOrigin?.revision}`}</small>{!libraryEntryId && <LibraryOrigin origin={exercise.libraryOrigin} />}<small>{exercise.sets} planned sets · {exercise.reps} · {exercise.restSeconds}s rest</small><EquipmentStatus requirements={exercise.equipment} /></div><button type="button" className="secondary-button" disabled={stale} onClick={() => select(exercise, libraryEntryId)}>Choose {exercise.name}</button></li>)}</ul>
    </>}
    {stale && <p role="alert" className="error-message">The session, page or entries changed. Cancel and start a new replacement review.</p>}
    {(error || selectionError) && !stale && <p role="alert" className="error-message">{error || selectionError}</p>}
    <button type="button" className="secondary-button" onClick={() => { if (valid() && current.current.onCancel === onCancel) { epoch.current++; onCancel() } }}>Cancel replacement</button>
  </section>
}
