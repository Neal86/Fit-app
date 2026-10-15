import { useMemo, useState } from 'react'
import { exerciseCatalog, filterCatalog } from '../exerciseCatalog'
import type { Exercise, Workout } from '../types'
import type { SessionReplacementReview } from '../sessionReplacement'
import type { MeasurementDraft } from '../units'
import { formatMeasurement, measurementUnit } from '../units'
import './ExercisePicker.css'

type Props = {
  workouts: Workout[]
  sourceName: string
  review: SessionReplacementReview | null
  drafts: Record<string, MeasurementDraft>
  stale: boolean
  error: string
  onSelect: (exercise: Exercise) => void
  onCancel: () => void
  onBack: () => void
  onConfirm: () => void
}
export default function SessionReplacement({ workouts, sourceName, review, drafts, stale, error, onSelect, onCancel, onBack, onConfirm }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const catalog = useMemo(() => exerciseCatalog(workouts), [workouts])
  const categories = [...new Set(catalog.map(item => item.exercise.category))].filter(Boolean).sort()
  const results = filterCatalog(catalog, query, category)
  return <section className="panel exercise-picker" role="region" aria-label="Session exercise replacement">
    <h2>{review ? 'Review exercise replacement' : `Replace unfinished ${sourceName} sets`}</h2>
    <p>Only this session changes. Saved plans and previous workouts stay unchanged. Library entries have not been assessed for your needs; selecting one is not a safety review.</p>
    {review ? <>
      <p>Replace {review.removedSets.length} unfinished {sourceName} sets with exactly {review.removedSets.length} fresh {review.replacement.name} sets. Keep {review.completedCount} completed {sourceName} sets with their original identity, numbers and values.</p>
      <p>Selected entry: {review.replacement.category || 'Uncategorized'} · {review.replacement.sets} planned sets × {review.replacement.reps} · {review.replacement.restSeconds}s rest. This session will have {review.removedSets.length} actual replacement sets, regardless of the entry’s planned count.</p>
      {review.replacement.notes && <p>{review.replacement.notes}</p>}
      <p>All values and unsaved load text in the unfinished rows below will be cleared after confirmation. New rows start with blank reps, seconds, load and RPE; warm-up and completion are off. No previous-load reference is borrowed from the selected entry. Completed rows and other exercises’ entries stay as they are.</p>
      <ul aria-label="Unfinished rows to reset">{review.removedSets.map(set => {
        const draft = drafts[set.id]
        return <li key={set.id}><div><strong>{sourceName} set {set.setNumber}</strong><small>Reps: {set.reps ?? 'blank'} · Seconds: {set.seconds ?? 'blank'} · RPE: {set.rpe ?? 'blank'} · Warm-up: {set.warmup ? 'yes' : 'no'}</small><small>Saved load: {set.weightKg === null ? 'blank' : `${formatMeasurement(set.weightKg, 'load', draft.unit)} ${measurementUnit('load', draft.unit)}`} · Load entry: {draft.text === '' ? 'blank' : `“${draft.text}” ${measurementUnit('load', draft.unit)}`}</small></div></li>
      })}</ul>
      <button type="button" className="secondary-button" onClick={onBack}>Back to exercise selection</button>
      <button type="button" className="primary-button" disabled={stale} onClick={onConfirm}>Confirm replacement and reset {review.removedSets.length} unfinished sets</button>
    </> : <>
      <p>Choose a reusable entry from your saved plan or starter templates. To create a new custom entry, cancel and add it in the plan editor first.</p>
      <div className="exercise-picker-filters"><label>Search replacement exercises<input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)}/></label><label>Replacement category<select value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div>
      <p role="status">{results.length} matching entries</p>
      <ul>{results.map(({ key, exercise, source }) => <li key={key}><div><strong>{exercise.name}</strong><small>{exercise.category || 'Uncategorized'} · {source}</small><small>{exercise.sets} planned sets · {exercise.reps} · {exercise.restSeconds}s rest</small></div><button type="button" className="secondary-button" disabled={stale} onClick={() => onSelect(exercise)}>Choose {exercise.name}</button></li>)}</ul>
    </>}
    {stale && <p role="alert" className="error-message">The session, page or entries changed. Cancel and start a new replacement review.</p>}
    {error && !stale && <p role="alert" className="error-message">{error}</p>}
    <button type="button" className="secondary-button" onClick={onCancel}>Cancel replacement</button>
  </section>
}
