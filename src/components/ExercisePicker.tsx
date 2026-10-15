import { useMemo, useState } from 'react'
import { exerciseCatalog, filterCatalog } from '../exerciseCatalog'
import type { Exercise, Workout } from '../types'
import './ExercisePicker.css'

export default function ExercisePicker({ workouts, disabled, onAdd }: { workouts: Workout[]; disabled: boolean; onAdd: (exercise: Exercise) => void }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const catalog = useMemo(() => exerciseCatalog(workouts), [workouts])
  const categories = [...new Set(catalog.map(item => item.exercise.category))].filter(Boolean).sort()
  const results = filterCatalog(catalog, query, category)
  return <details className="exercise-picker"><summary>Add from exercise library</summary><p>Reusable entries from starter templates and your saved plan. Set targets and notes are editable starting values. These entries have not been assessed for your needs and do not provide live technique analysis.</p><div className="exercise-picker-filters"><label>Search exercise library<input type="search" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} /></label><label>Exercise category<select value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div><p role="status">{results.length} matching entries</p><ul>{results.map(({ key, exercise, source }) => <li key={key}><div><strong>{exercise.name}</strong><small>{exercise.category || 'Uncategorized'} · {source}</small><small>{exercise.sets} sets · {exercise.reps} · {exercise.restSeconds}s rest</small>{exercise.notes && <p>{exercise.notes}</p>}</div><button type="button" className="secondary-button" disabled={disabled} onClick={() => onAdd(structuredClone(exercise))}>Add {exercise.name}</button></li>)}</ul>{disabled && <p>A workout supports up to 50 exercises. Remove an exercise before adding another.</p>}</details>
}
