import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { exerciseCatalog, filterCatalog } from '../exerciseCatalog'
import { equipmentMatch } from '../equipment'
import type { EquipmentId } from '../equipment'
import type { AppState, Exercise, Workout } from '../types'
import { assertLibraryCopyCurrent, reviewLibraryCopy, type LibraryCopyReview } from '../exerciseLibrary'
import { EquipmentStatus } from './EquipmentControls'
import LibraryContentSummary from './LibraryContentSummary'
import LibraryOrigin from './LibraryOrigin'
import './ExercisePicker.css'

type Props = { workouts: Workout[]; state?: AppState; disabled: boolean; onAdd: (exercise: Exercise, libraryCopy?: LibraryCopyReview) => void | boolean; availableEquipment?: readonly EquipmentId[]; destination?: string; destinationSnapshot?: string; isCurrent?: () => boolean }
export default function ExercisePicker({ workouts, state, disabled, onAdd, availableEquipment, destination = 'the selected plan draft', destinationSnapshot, isCurrent }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [matchedOnly, setMatchedOnly] = useState(false)
  const [review, setReview] = useState<LibraryCopyReview | null>(null)
  const [reviewSourceEpoch, setReviewSourceEpoch] = useState(0)
  const [reviewDestination, setReviewDestination] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const epoch = useRef(0)
  const sourceEpoch = useRef(0)
  const snapshot = JSON.stringify({ workouts, library: state?.exerciseLibrary, disabled, availableEquipment, destination, destinationSnapshot })
  const current = useRef({ workouts, state, library: state?.exerciseLibrary, disabled, availableEquipment, onAdd, snapshot, review, isCurrent })
  if (current.current.workouts !== workouts || current.current.state !== state || current.current.library !== state?.exerciseLibrary || current.current.snapshot !== snapshot) { epoch.current++; sourceEpoch.current++ }
  current.current = { workouts, state, library: state?.exerciseLibrary, disabled, availableEquipment, onAdd, snapshot, review, isCurrent }
  const renderEpoch = epoch.current
  const reviewStale = !!review && reviewSourceEpoch !== sourceEpoch.current
  // Recompute from content, including deliberately mutated library objects.
  const catalog = exerciseCatalog(workouts, state?.exerciseLibrary)
  const categories = [...new Set(catalog.map(item => item.exercise.category))].filter(Boolean).sort()
  const results = filterCatalog(catalog, query, category).filter(item => !matchedOnly || availableEquipment === undefined || equipmentMatch(item.exercise.equipment, availableEquipment).status === 'matched')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const valid = () => mounted.current && epoch.current === renderEpoch && current.current.workouts === workouts && current.current.state === state && current.current.library === state?.exerciseLibrary && current.current.onAdd === onAdd && current.current.review === review && (current.current.isCurrent?.() ?? true) && JSON.stringify({ workouts: current.current.workouts, library: current.current.state?.exerciseLibrary, disabled: current.current.disabled, availableEquipment: current.current.availableEquipment, destination, destinationSnapshot }) === snapshot
  const filter = (change: () => void) => { if (!valid()) return; epoch.current++; setReview(null); setError(''); change() }
  const select = (exercise: Exercise, libraryEntryId?: string) => {
    if (disabled || !valid()) return
    try {
      if (libraryEntryId) {
        if (!state) return
        const next = reviewLibraryCopy(state, libraryEntryId)
        epoch.current++; setReviewSourceEpoch(sourceEpoch.current); setReviewDestination(destination); setReview(next); setError('')
      } else { epoch.current++; onAdd(structuredClone(exercise)) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This entry changed. Select it again.') }
  }
  const confirm = () => {
    if (disabled || reviewStale || !valid() || !state || !review) return
    try {
      assertLibraryCopyCurrent(state, review)
      if (onAdd(structuredClone(review.exercise), review) === false) { setError('The copy was not added. Review the current plan draft and try again.'); return }
      epoch.current++; setReview(null); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This entry changed. Select it again.') }
  }
  return <details className="exercise-picker"><summary>Add from exercise library</summary><p>Reusable entries from starter templates, your saved plan and your manual exercise library. Set targets and notes are editable starting values. These entries have not been assessed for your needs and do not provide live technique analysis.</p>
    {state && <Link to="/exercise-library">Manage your manual exercise library</Link>}
    <div className="exercise-picker-filters"><label>Search exercise library<input type="search" maxLength={100} value={query} onChange={event => filter(() => setQuery(event.target.value))} /></label><label>Exercise category<select value={category} onChange={event => filter(() => setCategory(event.target.value))}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div>
    {availableEquipment !== undefined && <label className="equipment-check equipment-filter"><input type="checkbox" checked={matchedOnly} onChange={event => filter(() => setMatchedOnly(event.target.checked))} />Only show equipment-matched exercises</label>}
    <p>{availableEquipment === undefined ? 'Enable the temporary equipment comparison to filter by available equipment.' : 'Unknown requirements do not count as matches. Turn off the matched-only filter to choose any library entry manually.'}</p>
    {review && <section className="library-review" aria-label="Personal library plan copy review"><h3>Review personal library copy</h3><p>Copy this exact manual entry, revision {review.revision}, into {reviewDestination}. This adds an editable copy to the temporary plan draft. Use Save workout plan to persist it.</p><LibraryContentSummary exercise={review.exercise} /><LibraryOrigin origin={review.exercise.libraryOrigin} /><p>Copied values may differ after you edit the destination. This is ancestry only, not expert approval. Existing sessions and history stay unchanged.</p><button type="button" className="secondary-button" onClick={() => { if (!valid()) return; epoch.current++; setReview(null); setError('') }}>Cancel library copy</button><button type="button" className="primary-button" disabled={disabled || reviewStale} onClick={confirm}>Confirm copy into plan draft</button></section>}
    {reviewStale && <p role="alert" className="error-message">The library source or destination draft changed. Cancel this review and select the current entry again.</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
    <p role="status">{results.length} matching entries</p><ul>{results.map(({ key, exercise, source, libraryEntryId }, index) => <li key={key}><div><strong>{exercise.name}</strong><small>{exercise.category || 'Uncategorized'} · {source}{libraryEntryId && ` · manual entry ${index + 1} · revision ${exercise.libraryOrigin?.revision}`}</small><small>{exercise.sets} sets · {exercise.reps} · {exercise.restSeconds}s rest</small>{!libraryEntryId && <LibraryOrigin origin={exercise.libraryOrigin} />}<EquipmentStatus requirements={exercise.equipment} available={availableEquipment} />{exercise.notes && <p>{exercise.notes}</p>}</div><button type="button" className="secondary-button" disabled={disabled} onClick={() => select(exercise, libraryEntryId)}>Add {exercise.name}</button></li>)}</ul>{disabled && <p>A workout supports up to 50 exercises. Remove an exercise before adding another.</p>}</details>
}
