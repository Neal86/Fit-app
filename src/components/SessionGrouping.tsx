import { useEffect, useRef, useState } from 'react'
import type { ActiveSession } from '../types'
import type { SessionGroupingReview, SessionGroupRemovalReview } from '../sessionGrouping'
import type { MeasurementDraft } from '../units'
import { formatMeasurement, measurementUnit } from '../units'
import './SessionGrouping.css'
import { groupRowLabel } from './sessionGroupLabels'

type Selection = { name: string; restSeconds: number; rounds: string[][] }
type Props = {
  session: ActiveSession; review: SessionGroupingReview | null; removal: SessionGroupRemovalReview | null
  drafts: Record<string, MeasurementDraft>; stale: boolean; error: string
  onReview: (selection: Selection) => void; onBack: () => void; onCancel: () => void; onConfirm: () => void
}


export default function SessionGrouping({ session, review, removal, drafts, stale, error, onReview, onBack, onCancel, onConfirm }: Props) {
  const [name, setName] = useState('')
  const [count, setCount] = useState('')
  const [rest, setRest] = useState('')
  const [movements, setMovements] = useState(['', ''])
  const [grid, setGrid] = useState<string[][]>([])
  const [draftError, setDraftError] = useState('')
  const mounted = useRef(true)
  const epoch = useRef(0)
  const renderEpoch = epoch.current
  const current = useRef({ onReview, onBack, onCancel, onConfirm, stale })
  current.current = { onReview, onBack, onCancel, onConfirm, stale }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const valid = () => mounted.current && epoch.current === renderEpoch && !stale && !current.current.stale && current.current.onReview === onReview && current.current.onConfirm === onConfirm
  const edit = (action: () => void) => { if (!valid() || review || removal) return; epoch.current++; action(); setDraftError('') }
  const groupedIds = new Set(session.grouping?.groups.flatMap(group => group.rounds.flatMap(round => round.setIds)) ?? [])
  const eligible = session.sets.filter(set => !set.completed && !set.warmup && !groupedIds.has(set.id))
  const exactCount = /^\d+$/.test(count) && Number(count) >= 1 && Number(count) <= 50 ? Number(count) : 0
  const selectedIds = new Set(grid.flat().filter(Boolean))
  const remaining = session.sets.filter(set => !groupedIds.has(set.id) && !(review?.rounds.some(round => round.setIds.includes(set.id)) ?? selectedIds.has(set.id)))
  const capacity = (session.grouping?.groups.length ?? 0) >= 25
  const submit = () => {
    if (!valid() || review || removal || capacity) return
    if (!name.trim() || name.trim().length > 80) { setDraftError('Enter a nonblank group name of up to 80 characters.'); return }
    if (!exactCount) { setDraftError('Choose an exact whole-number round count from 1 to 50.'); return }
    if (!/^\d+$/.test(rest) || Number(rest) < 0 || Number(rest) > 900) { setDraftError('Enter a whole-number round rest from 0 to 900 seconds, including an explicit 0 for no new countdown.'); return }
    if (movements.some(id => !id) || new Set(movements).size !== movements.length) { setDraftError('Choose 2–6 distinct movements in your preferred display order.'); return }
    if (grid.length !== exactCount || grid.some(row => row.length !== movements.length || row.some((id, index) => !eligible.some(set => set.id === id && set.exerciseId === movements[index]))) || selectedIds.size !== exactCount * movements.length) { setDraftError('Explicitly select one eligible, distinct existing row in every round cell. No rows are paired or added automatically.'); return }
    epoch.current++
    onReview({ name, restSeconds: Number(rest), rounds: grid.map(row => [...row]) })
  }
  const reviewedRounds = removal?.rounds ?? review?.rounds
  return <section className="panel session-grouping" role="region" aria-label="Session grouping">
    <h2>{removal ? 'Review removal of grouping' : review ? 'Review session group' : 'Create a session-only group'}</h2>
    <p>Only this session’s grouping changes. No work is added or paired automatically. Saved plans, history, recorded values, load entries and their units, notes, elapsed time and the current rest countdown stay unchanged. Existing duration and calorie estimates stay unchanged.</p>
    {reviewedRounds ? <>
      <h3>{removal?.group.name ?? review?.name}</h3>
      <p>{reviewedRounds.length} exact rounds · {removal?.group.restSeconds ?? review?.restSeconds} seconds rest after each newly completed round · {reviewedRounds[0].setIds.length === 2 ? 'Superset' : 'Circuit'}</p>
      <ol className="group-rounds" aria-label="Exact reviewed rounds">{reviewedRounds.map((round, roundIndex) => <li key={roundIndex}><strong>Round {roundIndex + 1}</strong><ol>{round.rows.map(({ set }) => <li key={set.id}><span>{groupRowLabel(session, set)}</span><small>Reps: {set.reps ?? 'blank'} · Seconds: {set.seconds ?? 'blank'} · RPE: {set.rpe ?? 'blank'} · {set.completed ? 'Marked complete' : 'Unfinished'}</small>{drafts[set.id] && <small>Saved load: {set.weightKg === null ? 'blank' : `${formatMeasurement(set.weightKg, 'load', drafts[set.id].unit)} ${measurementUnit('load', drafts[set.id].unit)}`} · Preserved load entry: {drafts[set.id].text === '' ? 'blank' : `“${drafts[set.id].text}” ${measurementUnit('load', drafts[set.id].unit)}`}</small>}</li>)}</ol></li>)}</ol>
      {removal ? <p>Remove only this grouping metadata. All its rows remain in the session with their current values. Removal is allowed only while no member is currently marked complete. No rows are undone automatically.</p> : <>
        <details open><summary>{remaining.length} rows remain ungrouped</summary><ul aria-label="Rows remaining ungrouped">{remaining.map(set => <li key={set.id}>{groupRowLabel(session, set)} · {set.completed ? 'Marked complete' : set.warmup ? 'Warm-up' : 'Unfinished'}</li>)}</ul></details>
        <p>Each row is used once. Grouped rows cannot be removed or marked as warm-ups. Saved groups cannot be edited or reordered here. You can review removal only when no member is currently marked complete, including after you independently undo all members.</p>
        <p>Grouping travels in your own backups and workout history. Older strict builds or APIs may reject these snapshots. Keep a pre-feature backup for a deliberate rollback. Restoring it omits all later changes, so also preserve your newer full backup. Grouping is never automatically flattened or removed.</p>
      </>}
      {!removal && <button type="button" className="secondary-button" disabled={stale} onClick={() => { if (valid()) { epoch.current++; onBack() } }}>Back to group details</button>}
      <button type="button" className="primary-button" disabled={stale} onClick={() => { if (valid()) onConfirm() }}>{removal ? 'Confirm removal of grouping' : 'Confirm session group'}</button>
    </> : <form noValidate onSubmit={event => { event.preventDefault(); submit() }}>
      <p>This temporary form is not saved if you cancel or leave. Choose 2–6 movements in display order, then explicitly select every row. Unequal extra rows stay outside the group.</p>
      <div className="group-fields"><label>Group name<input maxLength={80} value={name} onChange={event => edit(() => setName(event.target.value))} /></label><label>Round count (1–50)<input type="text" inputMode="numeric" maxLength={3} value={count} onChange={event => edit(() => { const value = event.target.value; setCount(value); const n = /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 50 ? Number(value) : 0; setGrid(Array.from({ length: n }, (_, row) => movements.map((_, column) => grid[row]?.[column] ?? ''))) })} /></label><label>Rest after each round (seconds, 0–900)<input type="text" inputMode="numeric" maxLength={4} value={rest} onChange={event => edit(() => setRest(event.target.value))} /></label></div>
      <div className="group-fields">{movements.map((movement, index) => <label key={index}>Movement {index + 1}<select value={movement} onChange={event => edit(() => { setMovements(movements.map((id, column) => column === index ? event.target.value : id)); setGrid(grid.map(row => row.map((id, column) => column === index ? '' : id))) })}><option value="">Choose a movement</option>{session.workout.exercises.map((exercise, exerciseIndex) => <option key={exercise.id} value={exercise.id} disabled={!eligible.some(set => set.exerciseId === exercise.id) || movements.some((id, column) => column !== index && id === exercise.id)}>{exercise.name} (session exercise {exerciseIndex + 1}) · {eligible.filter(set => set.exerciseId === exercise.id).length} eligible rows</option>)}</select></label>)}</div>
      <button type="button" className="secondary-button" disabled={stale || movements.length >= 6} onClick={() => edit(() => { setMovements([...movements, '']); setGrid(grid.map(row => [...row, ''])) })}>Add movement slot</button>
      <button type="button" className="secondary-button" disabled={stale || movements.length <= 2} onClick={() => edit(() => { setMovements(movements.slice(0, -1)); setGrid(grid.map(row => row.slice(0, -1))) })}>Remove last movement slot</button>
      <ol className="group-rounds" aria-label="Round row selection">{Array.from({ length: exactCount }, (_, rowIndex) => <li key={rowIndex}><strong>Round {rowIndex + 1}</strong><div className="group-fields">{movements.map((movement, column) => <label key={column}>Round {rowIndex + 1} movement {column + 1} row<select value={grid[rowIndex]?.[column] ?? ''} disabled={stale || !movement} onChange={event => edit(() => setGrid(grid.map((row, index) => index === rowIndex ? row.map((id, cell) => cell === column ? event.target.value : id) : row)))}><option value="">Choose an existing row</option>{eligible.filter(set => set.exerciseId === movement).map(set => <option key={set.id} value={set.id} disabled={selectedIds.has(set.id) && grid[rowIndex]?.[column] !== set.id}>{groupRowLabel(session, set)}</option>)}</select></label>)}</div></li>)}</ol>
      <p>{remaining.length} rows currently remain ungrouped outside this selection. Completed, warm-up and already grouped rows cannot be selected.</p>
      <button type="submit" className="primary-button" disabled={stale || capacity}>Review session group</button>
    </form>}
    <p>Complete rows in any order. A round means all its rows are marked complete, not verified exercise. Intermediate completions keep the current countdown. Only newly completing the last unfinished row starts or replaces a positive chosen round rest. Zero rest and undo leave the current countdown alone. Reloading never restarts it. No automatic focus, next movement or completion propagation.</p>
    {capacity && !removal && <p role="alert" className="error-message">This session has reached the 25-group limit.</p>}
    {stale && <p role="alert" className="error-message">The session, page or load entries changed. Cancel and start a new grouping review.</p>}
    {!stale && (draftError || error) && <p role="alert" className="error-message">{draftError || error}</p>}
    <button type="button" className="secondary-button" onClick={() => { if (mounted.current && epoch.current === renderEpoch && current.current.onCancel === onCancel) { epoch.current++; onCancel() } }}>Cancel grouping</button>
  </section>
}
