import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, Pause, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { elapsedSeconds, finishSession, formatTime, previousSet, startSession, toggleSession, uid } from '../session'
import type { ActiveSession, AppState, ExerciseSet } from '../types'
import { nativeSuccessFeedback } from '../native'
import { formatMeasurement, measurementDraft, measurementRange, measurementUnit, readMeasurement, syncMeasurement } from '../units'
import type { MeasurementDraft } from '../units'

export type UpdateState = (change: (state: AppState) => AppState, message?: string) => boolean
export default function WorkoutSession({ state, update }: { state: AppState; update: UpdateState }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const saving = useRef(false)
  const active = state.activeSession
  const session = active?.workout.id === id ? active : null
  const workout = session?.workout ?? state.workouts.find(item => item.id === id)
  const unit = state.profile.unit
  const [draftSource, setDraftSource] = useState({ session, unit })
  const [loads, setLoads] = useState<Record<string, MeasurementDraft>>(() => Object.fromEntries((session?.sets ?? []).map(set => [set.id, measurementDraft(set.weightKg, 'load', unit)])))
  if (draftSource.session !== session || draftSource.unit !== unit) {
    const sameSession = draftSource.session?.id === session?.id
    setDraftSource({ session, unit })
    setLoads(Object.fromEntries((session?.sets ?? []).map(set => [set.id, sameSession && loads[set.id] ? syncMeasurement(loads[set.id], set.weightKg, 'load', unit) : measurementDraft(set.weightKg, 'load', unit)])))
  }
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  if (!workout) return <Navigate to="/workouts" replace />
  const change = (edit: (session: ActiveSession) => ActiveSession) => update(current => { const draft = current.activeSession; if (draft && session && draft.id !== session.id) throw new Error('This session changed. Reopen it before editing.'); return draft && draft.workout.id === id ? { ...current, activeSession: edit(draft) } : current })
  const changeSet = (setId: string, patch: Partial<ExerciseSet>) => change(current => ({ ...current, sets: current.sets.map(set => set.id === setId ? { ...set, ...patch } : set) }))
  const loadDraft = (set: ExerciseSet) => loads[set.id] ?? measurementDraft(set.weightKg, 'load', unit)
  const saveLoad = (set: ExerciseSet) => {
    try {
      const weightKg = readMeasurement(loadDraft(set), 'load')
      if (weightKg !== set.weightKg && !changeSet(set.id, { weightKg })) { setError('Load was not saved. Your entry is still here; retry before finishing.'); return false }
      setLoads(previous => ({ ...previous, [set.id]: measurementDraft(weightKg, 'load', unit) })); setError(''); return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the load.'); return false }
  }
  const start = () => {
    if (active && !window.confirm('Starting this workout will discard your current unfinished session. Continue?')) return
    update(current => ({ ...current, activeSession: startSession(workout) }), 'Session started and saved on this device')
  }
  const finish = () => {
    if (!session || saving.current) return
    if (session.sets.some(set => !set.completed) && !window.confirm('Some sets are unfinished. Save this partial workout?')) return
    saving.current = true
    try {
      const sets = session.sets.map(set => ({ ...set, weightKg: readMeasurement(loadDraft(set), 'load') }))
      const log = finishSession({ ...session, sets })
      if (update(current => {
        if (current.activeSession?.id !== session.id || current.logs.some(item => item.id === log.id)) throw new Error('This session changed or was already saved. Reopen the active workout before saving.')
        return { ...current, activeSession: null, logs: [log, ...current.logs] }
      }, 'Workout saved')) navigate('/progress')
      else setError('Workout was not saved. Your load entries are still here; retry when storage is available.')
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save workout.') }
    finally { saving.current = false }
  }
  const completed = session?.sets.filter(set => set.completed).length ?? 0
  const rest = session?.restUntil ? Math.max(0, Math.ceil((session.restUntil - now) / 1000)) : 0
  return <section>
    <Link className="back-link" to="/workouts"><ArrowLeft />All workouts</Link>
    <header className="page-header"><span>{workout.day} · {workout.difficulty}</span><h1>{workout.title}</h1><p>{workout.description}</p></header>
    <p className="safety-note">General fitness guidance only. Choose a comfortable load and range of motion. Stop if movement causes pain. This app does not diagnose injuries.</p>
    {active && !session && <div className="notice">An unfinished workout is saved: <Link to={`/workouts/${active.workout.id}`}>{active.workout.title}</Link></div>}
    {!session ? <button className="primary-button" onClick={start}><Play />Start workout</button> : <>
      <div className="session-bar">
        <div><span>Active training time</span><strong data-testid="session-timer">{formatTime(elapsedSeconds(session, now))}</strong></div>
        <button className="secondary-button" onClick={() => change(current => toggleSession(current))}>{session.runningSince === null ? <><Play />Resume timer</> : <><Pause />Pause timer</>}</button>
        <div><span>Sets completed</span><strong>{completed}/{session.sets.length}</strong></div>
      </div>
      <p className="session-note">Loads save when you leave the field, press Enter, complete a set or finish the workout. Other changes save immediately. Incomplete or failed load edits stay on this page; save them before leaving. Pause the timer during breaks you don’t want included.</p>
      <p id="workout-load-range" className="session-note">Load range: {measurementRange('load', unit)}. Leave blank for bodyweight; 0 records an explicit zero load.</p>
      {session.restUntil !== null && <div className="rest-timer" role="status"><strong>{rest > 0 ? `Rest: ${formatTime(rest)}` : 'Rest complete'}</strong><button className="secondary-button" onClick={() => change(current => ({ ...current, restUntil: null }))}>Dismiss rest timer</button></div>}
    </>}
    <div className="exercise-list">{workout.exercises.map(exercise => {
      const sets = session?.sets.filter(set => set.exerciseId === exercise.id) ?? []
      const timed = /sec/i.test(exercise.reps)
      return <article className="exercise-panel panel" key={exercise.id}>
        <header><div><h2>{exercise.name}</h2><p>{exercise.category} · {exercise.sets} × {exercise.reps} · {exercise.restSeconds}s rest</p></div></header>
        {exercise.notes && <p className="exercise-guidance">{exercise.notes}</p>}
        {session && <><div className="sets-list">{sets.map((set, index) => {
          const last = previousSet(state.logs, exercise.id, set.setNumber)
          return <div className={set.completed ? 'set-row set-complete' : 'set-row'} key={set.id}>
            <span className="set-number">Set {index + 1}</span>
            <label>{timed ? 'Seconds' : 'Reps'}<input aria-label={`${exercise.name} set ${index + 1} ${timed ? 'seconds' : 'reps'}`} type="number" min="0" max={timed ? '86400' : '999'} step="1" value={(timed ? set.seconds : set.reps) ?? ''} onChange={event => {
              const value = event.target.value === '' ? null : Number(event.target.value)
              if (value === null || Number.isInteger(value) && value >= 0 && value <= (timed ? 86400 : 999)) changeSet(set.id, { [timed ? 'seconds' : 'reps']: value, completed: false })
            }} /></label>
            <label>Weight ({measurementUnit('load', loadDraft(set).unit)})<input aria-label={`${exercise.name} set ${index + 1} weight`} type="text" inputMode="decimal" autoComplete="off" maxLength={40} placeholder="Bodyweight" value={loadDraft(set).text} aria-describedby={`load-range-${set.id}`} onChange={event => {
              const text = event.target.value
              setLoads(previous => ({ ...previous, [set.id]: { ...loadDraft(set), text } }))
            }} onBlur={() => saveLoad(set)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveLoad(set) } }} /><small id={`load-range-${set.id}`}>Load in {measurementUnit('load', loadDraft(set).unit)}; {measurementRange('load', loadDraft(set).unit)}. Blank means bodyweight.</small>{loadDraft(set).unit !== unit && <small>Finish this entry in {measurementUnit('load', loadDraft(set).unit)}; then it will display in {measurementUnit('load', unit)}.</small>}</label>
            <label>RPE (optional)<input aria-label={`${exercise.name} set ${index + 1} RPE`} type="number" min="1" max="10" step="0.5" value={set.rpe ?? ''} onChange={event => {
              const value = event.target.value === '' ? null : Number(event.target.value)
              if (value === null || value >= 1 && value <= 10) changeSet(set.id, { rpe: value })
            }} /></label>
            <label className="warmup-label"><input type="checkbox" checked={set.warmup} onChange={event => changeSet(set.id, { warmup: event.target.checked })} />Warm-up</label>
            <button className={set.completed ? 'secondary-button' : 'primary-button'} aria-label={`${set.completed ? 'Undo' : 'Complete'} ${exercise.name} set ${index + 1}`} disabled={!set.completed && (timed ? set.seconds === null || set.seconds <= 0 : set.reps === null || set.reps <= 0)} onClick={() => {
              try {
                const weightKg = readMeasurement(loadDraft(set), 'load')
                const saved = change(current => ({ ...current, restUntil: set.completed ? current.restUntil : Date.now() + exercise.restSeconds * 1000, sets: current.sets.map(item => item.id === set.id ? { ...item, weightKg, completed: !item.completed } : item) }))
                if (saved) { setLoads(previous => ({ ...previous, [set.id]: measurementDraft(weightKg, 'load', unit) })); setError(''); if (!set.completed && state.preferences.soundEnabled) void nativeSuccessFeedback() }
                else setError('Set was not saved. Your load entry is still here; retry when storage is available.')
              } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the load before completing this set.') }
            }}>{set.completed ? 'Done' : 'Complete'}</button>
            <button className="icon-button danger" aria-label={`Remove ${exercise.name} set ${index + 1}`} disabled={sets.length <= 1} onClick={() => {
              if (set.completed && !window.confirm('Remove this completed set from the unfinished session?')) return
              change(current => ({ ...current, sets: current.sets.filter(item => item.id !== set.id) }))
            }}><Trash2 /></button>
            {last && <small className="previous-set">Last: {last.reps ?? last.seconds ?? '—'}{last.seconds !== null ? ' sec' : ' reps'} · {last.weightKg === null ? 'Bodyweight' : `${formatMeasurement(last.weightKg, 'load', unit)} ${measurementUnit('load', unit)}`} </small>}
          </div>
        })}</div><button className="secondary-button" disabled={sets.length >= 50 || Math.max(...sets.map(set => set.setNumber)) >= 50} onClick={() => change(current => ({ ...current, sets: [...current.sets, { id: uid(), exerciseId: exercise.id, setNumber: Math.max(0, ...sets.map(set => set.setNumber)) + 1, reps: null, seconds: null, weightKg: null, rpe: null, warmup: false, completed: false }] }))}><Plus />Add set</button></>}
      </article>
    })}</div>
    {session && <><label className="notes-field">Session notes<textarea placeholder="How did this session feel?" value={session.notes} onChange={event => change(current => ({ ...current, notes: event.target.value }))} maxLength={2000} /></label>
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="session-actions"><button className="primary-button" disabled={completed === 0} onClick={finish}><CheckCircle2 />Finish and save workout</button>
        <button className="secondary-button danger" onClick={() => { if (window.confirm('Discard this unfinished session? Saved workout history will be kept.')) update(current => ({ ...current, activeSession: null }), 'Unfinished session discarded') }}><RotateCcw />Discard session</button></div>
    </>}
  </section>
}
