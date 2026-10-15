import { useEffect, useMemo, useRef, useState } from 'react'
import { exerciseCatalog, filterCatalog } from '../exerciseCatalog'
import { equipmentMatch } from '../equipment'
import type { EquipmentId } from '../equipment'
import type { Exercise, Workout } from '../types'
import { EquipmentStatus } from './EquipmentControls'
import './ExercisePicker.css'

export default function ExercisePicker({ workouts, disabled, onAdd, availableEquipment }: { workouts: Workout[]; disabled: boolean; onAdd: (exercise: Exercise) => void; availableEquipment?: readonly EquipmentId[] }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [matchedOnly, setMatchedOnly] = useState(false)
  const mounted = useRef(true)
  const epoch = useRef(0)
  const current = useRef({ workouts, disabled, availableEquipment, onAdd })
  current.current = { workouts, disabled, availableEquipment, onAdd }
  const renderEpoch = epoch.current
  const source = JSON.stringify({ workouts, disabled, availableEquipment })
  const catalog = useMemo(() => exerciseCatalog(workouts), [workouts])
  const categories = [...new Set(catalog.map(item => item.exercise.category))].filter(Boolean).sort()
  const results = filterCatalog(catalog, query, category).filter(item => !matchedOnly || availableEquipment === undefined || equipmentMatch(item.exercise.equipment, availableEquipment).status === 'matched')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const valid = () => mounted.current && epoch.current === renderEpoch && current.current.workouts === workouts && current.current.onAdd === onAdd && JSON.stringify(current.current) === JSON.stringify({ workouts, disabled, availableEquipment }) && JSON.stringify({ workouts, disabled, availableEquipment }) === source
  return <details className="exercise-picker"><summary>Add from exercise library</summary><p>Reusable entries from starter templates and your saved plan. Set targets and notes are editable starting values. These entries have not been assessed for your needs and do not provide live technique analysis.</p>
    <div className="exercise-picker-filters"><label>Search exercise library<input type="search" maxLength={100} value={query} onChange={event => { if (!valid()) return; epoch.current += 1; setQuery(event.target.value) }} /></label><label>Exercise category<select value={category} onChange={event => { if (!valid()) return; epoch.current += 1; setCategory(event.target.value) }}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label></div>
    {availableEquipment !== undefined && <label className="equipment-check equipment-filter"><input type="checkbox" checked={matchedOnly} onChange={event => { if (!valid()) return; epoch.current += 1; setMatchedOnly(event.target.checked) }} />Only show equipment-matched exercises</label>}
    <p>{availableEquipment === undefined ? 'Enable the temporary equipment comparison to filter by available equipment.' : 'Unknown requirements do not count as matches. Turn off the matched-only filter to choose any library entry manually.'}</p>
    <p role="status">{results.length} matching entries</p><ul>{results.map(({ key, exercise, source }) => <li key={key}><div><strong>{exercise.name}</strong><small>{exercise.category || 'Uncategorized'} · {source}</small><small>{exercise.sets} sets · {exercise.reps} · {exercise.restSeconds}s rest</small><EquipmentStatus requirements={exercise.equipment} available={availableEquipment} />{exercise.notes && <p>{exercise.notes}</p>}</div><button type="button" className="secondary-button" disabled={disabled} onClick={() => { if (!disabled && valid()) { epoch.current += 1; onAdd(structuredClone(exercise)) } }}>Add {exercise.name}</button></li>)}</ul>{disabled && <p>A workout supports up to 50 exercises. Remove an exercise before adding another.</p>}</details>
}
