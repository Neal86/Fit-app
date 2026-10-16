import { useEffect, useRef, useState } from 'react'
import type { AppState, Workout } from '../types'
import { applyPlannedGrouping, applyPlannedGroupRemoval, reviewPlannedGrouping, reviewPlannedGroupRemoval } from '../plannedGrouping'
import type { PlannedGroupingReview, PlannedGroupRemovalReview } from '../plannedGrouping'
import PlannedGroupSummary from './PlannedGroupSummary'
import { plannedCompatibility, plannedRest, plannedRowLabel, plannedSlotKey, plannedSlots } from './plannedGroupLabels'

type Props = { workout: Workout; reserved: AppState; isCurrent: () => boolean; isViewCurrent: () => boolean; onChange: (workout: Workout) => boolean }
type Review = { workout: Workout; snapshot: string; validSource: () => boolean; addition: PlannedGroupingReview | null; removal: PlannedGroupRemovalReview | null }

export default function PlannedGroupingEditor({ workout, reserved, isCurrent, isViewCurrent, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [count, setCount] = useState('')
  const [rest, setRest] = useState('')
  const [movements, setMovements] = useState(['', ''])
  const [grid, setGrid] = useState<string[][]>([])
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const epoch = useRef(0)
  const reviewRef = useRef<Review | null>(null)
  const current = useRef({ workout, isCurrent, onChange })
  current.current = { workout, isCurrent, onChange }
  const renderEpoch = epoch.current
  const snapshot = JSON.stringify(workout)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reviewRef.current = null } }, [])
  const valid = () => mounted.current && epoch.current === renderEpoch && current.current.workout === workout && current.current.onChange === onChange && JSON.stringify(workout) === snapshot && isCurrent()
  const validReview = (value: Review) => valid() && reviewRef.current === value && value.workout === workout && value.snapshot === snapshot && value.validSource()
  const edit = (action: () => void) => { if (!valid() || reviewRef.current) return; epoch.current++; action(); setError('') }
  const publishReview = (value: Review | null) => { epoch.current++; reviewRef.current = value; setReview(value); setError('') }
  const reset = () => { setOpen(false); setName(''); setCount(''); setRest(''); setMovements(['', '']); setGrid([]); publishReview(null) }
  const grouped = new Set(workout.plannedGrouping?.groups.flatMap(group => group.rounds.flatMap(round => round.members.map(plannedSlotKey))) ?? [])
  const slots = plannedSlots(workout)
  const eligible = slots.filter(member => !grouped.has(plannedSlotKey(member)))
  const exactCount = /^\d+$/.test(count) && Number(count) >= 1 && Number(count) <= 20 ? Number(count) : 0
  const selected = new Set(grid.flat().filter(Boolean))
  const remaining = slots.filter(member => !grouped.has(plannedSlotKey(member)) && !(review?.addition?.rounds.some(round => round.members.some(item => plannedSlotKey(item) === plannedSlotKey(member))) ?? selected.has(plannedSlotKey(member))))
  const capacity = (workout.plannedGrouping?.groups.length ?? 0) >= 25
  const stale = !isCurrent() || !!review && !validReview(review)
  const submit = () => {
    if (!valid() || reviewRef.current || capacity) return
    if (!name.trim() || name.trim().length > 80) { setError('Enter a nonblank group name of up to 80 characters.'); return }
    if (!exactCount) { setError('Choose an exact whole-number round count from 1 to 20.'); return }
    if (!/^\d+$/.test(rest) || Number(rest) > 900) { setError('Enter a whole-number round rest from 0 to 900 seconds, including an explicit 0.'); return }
    if (movements.some(id => !id) || new Set(movements).size !== movements.length) { setError('Choose 2–6 distinct movements in display order.'); return }
    if (grid.length !== exactCount || grid.some(row => row.length !== movements.length || row.some((key, column) => !eligible.some(member => plannedSlotKey(member) === key && member.exerciseId === movements[column]))) || selected.size !== exactCount * movements.length) { setError('Explicitly select one distinct existing planned row in every round cell. Rows are never paired or added automatically.'); return }
    try {
      const addition = reviewPlannedGrouping(workout, { name, restSeconds: Number(rest), rounds: grid.map(row => row.map(key => ({ ...eligible.find(member => plannedSlotKey(member) === key)! }))) })
      publishReview({ workout, snapshot, validSource: isCurrent, addition, removal: null })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to review this planned group.') }
  }
  const remove = (id: string) => {
    if (!valid() || open || reviewRef.current) return
    try { publishReview({ workout, snapshot, validSource: isCurrent, addition: null, removal: reviewPlannedGroupRemoval(workout, id) }); setOpen(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to review removal.') }
  }
  const confirm = (value: Review) => {
    if (!validReview(value)) return
    try {
      const next = value.removal ? applyPlannedGroupRemoval(workout, value.removal) : applyPlannedGrouping(workout, value.addition!, { reserved })
      if (onChange(next)) reset()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update the draft. Your review is kept.') }
  }
  const reviewed = review?.removal?.rounds ?? review?.addition?.rounds
  return <section className="session-grouping" aria-label="Planned grouping editor" onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); submit() } }}>
    <PlannedGroupSummary workout={workout} draft onRemove={open ? undefined : remove} />
    {!open ? <button type="button" className="secondary-button" disabled={!isCurrent() || capacity} onClick={() => { if (!valid()) return; epoch.current++; setOpen(true); setError('') }}>Create saved plan group</button> : <div className="panel">
      <h2>{review?.removal ? 'Review removal of planned group' : review ? 'Review planned group' : 'Create a saved plan group'}</h2>
      <p>Only your editor draft changes here. Save the workout plan to apply groups to future sessions. An unfinished session and workout history stay intact.</p>
      {review && reviewed ? <>
        <h3>{review.removal?.group.name ?? review.addition?.name}</h3><p>{reviewed.length} exact rounds · {review.removal?.group.restSeconds ?? review.addition?.restSeconds} seconds rest after each newly completed round</p>
        <ol className="group-rounds" aria-label="Exact reviewed planned rounds">{reviewed.map((round, index) => <li key={index}><strong>Round {index + 1}</strong><ol>{round.members.map(member => <li key={plannedSlotKey(member)}>{plannedRowLabel(workout, member)}</li>)}</ol></li>)}</ol>
        {review.removal ? <p>Remove this group from the draft only. All its planned rows stay in the workout. Save the workout to apply this removal to future sessions.</p> : <><details open><summary>{remaining.length} planned rows remain ungrouped</summary><ul aria-label="Planned rows remaining ungrouped">{remaining.map(member => <li key={plannedSlotKey(member)}>{plannedRowLabel(workout, member)}</li>)}</ul></details><p>Each planned row is used once. Removing a member exercise or reducing a referenced set count requires reviewing and removing its groups first. To change a group, remove it and create a new one.</p></>}
        <p>{plannedRest}</p><p>Existing duration and calorie estimates stay unchanged. No rows are added automatically and grouping does not assess whether these movements are suitable together.</p><p>{plannedCompatibility}</p>
        {!review.removal && <button type="button" className="secondary-button" disabled={stale} onClick={() => { if (validReview(review)) publishReview(null) }}>Back to planned group details</button>}
        <button type="button" className="primary-button" disabled={stale} onClick={() => confirm(review)}>{review.removal ? 'Confirm group removal in draft' : 'Confirm group in draft'}</button>
      </> : <>
        <p>This temporary grouping form is not saved if you cancel or leave. Choose 2–6 movements in order, then explicitly choose every planned set. Unequal extra rows stay ungrouped.</p>
        <div className="group-fields"><label>Planned group name<input maxLength={80} value={name} onChange={event => edit(() => setName(event.target.value))} /></label><label>Planned round count (1–20)<input type="text" inputMode="numeric" maxLength={3} value={count} onChange={event => edit(() => { const value = event.target.value; setCount(value); const n = /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 20 ? Number(value) : 0; setGrid(Array.from({ length: n }, (_, row) => movements.map((_, column) => grid[row]?.[column] ?? ''))) })} /></label><label>Planned round rest (seconds, 0–900)<input type="text" inputMode="numeric" maxLength={4} value={rest} onChange={event => edit(() => setRest(event.target.value))} /></label></div>
        <div className="group-fields">{movements.map((movement, column) => <label key={column}>Planned movement {column + 1}<select value={movement} onChange={event => edit(() => { setMovements(movements.map((id, index) => index === column ? event.target.value : id)); setGrid(grid.map(row => row.map((key, index) => index === column ? '' : key))) })}><option value="">Choose a movement</option>{workout.exercises.map((exercise, index) => <option key={exercise.id} value={exercise.id} disabled={!eligible.some(member => member.exerciseId === exercise.id) || movements.some((id, other) => other !== column && id === exercise.id)}>{exercise.name || 'Unnamed movement'} (exercise {index + 1}) · {eligible.filter(member => member.exerciseId === exercise.id).length} eligible planned rows</option>)}</select></label>)}</div>
        <button type="button" className="secondary-button" disabled={stale || movements.length >= 6} onClick={() => edit(() => { setMovements([...movements, '']); setGrid(grid.map(row => [...row, ''])) })}>Add planned movement slot</button>
        <button type="button" className="secondary-button" disabled={stale || movements.length <= 2} onClick={() => edit(() => { setMovements(movements.slice(0, -1)); setGrid(grid.map(row => row.slice(0, -1))) })}>Remove last planned movement slot</button>
        <ol className="group-rounds" aria-label="Planned round row selection">{Array.from({ length: exactCount }, (_, rowIndex) => <li key={rowIndex}><strong>Round {rowIndex + 1}</strong><div className="group-fields">{movements.map((movement, column) => <label key={column}>Planned round {rowIndex + 1} movement {column + 1} row<select value={grid[rowIndex]?.[column] ?? ''} disabled={stale || !movement} onChange={event => edit(() => setGrid(grid.map((row, index) => index === rowIndex ? row.map((key, cell) => cell === column ? event.target.value : key) : row)))}><option value="">Choose an existing planned set</option>{eligible.filter(member => member.exerciseId === movement).map(member => { const key = plannedSlotKey(member); return <option key={key} value={key} disabled={selected.has(key) && grid[rowIndex]?.[column] !== key}>{plannedRowLabel(workout, member)}</option> })}</select></label>)}</div></li>)}</ol>
        <p>{remaining.length} planned rows currently remain ungrouped outside this selection.</p><button type="button" className="primary-button" disabled={stale || capacity} onClick={submit}>Review planned group</button>
      </>}
      {stale && <p role="alert" className="error-message">The workout draft, saved data or page changed. Cancel and start a new planned grouping review.</p>}
      <button type="button" className="secondary-button" onClick={() => { if (mounted.current && epoch.current === renderEpoch && current.current.onChange === onChange && isViewCurrent()) reset() }}>Cancel planned grouping</button>
    </div>}
    {capacity && <p className="notice">This workout has reached the 25-group limit.</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
  </section>
}
