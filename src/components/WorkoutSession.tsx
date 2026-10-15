import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, Pause, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { elapsedSeconds, finishSession, formatTime, previousSet, startSession, toggleSession, uid } from '../session'
import type { ActiveSession, AppState, ExerciseSet } from '../types'
import { nativeSuccessFeedback } from '../native'

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
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  if (!workout) return <Navigate to="/workouts" replace />
  const change = (edit: (session: ActiveSession) => ActiveSession) => update(current => { const draft = current.activeSession; return draft && draft.workout.id === id ? { ...current, activeSession: edit(draft) } : current })
  const changeSet = (setId: string, patch: Partial<ExerciseSet>) => change(current => ({ ...current, sets: current.sets.map(set => set.id === setId ? { ...set, ...patch } : set) }))
  const start = () => {
    if (active && !window.confirm('Starting this workout will discard your current unfinished session. Continue?')) return
    update(current => ({ ...current, activeSession: startSession(workout) }), 'Session started and saved on this device')
  }
  const finish = () => {
    if (!session || saving.current) return
    if (session.sets.some(set => !set.completed) && !window.confirm('Some sets are unfinished. Save this partial workout?')) return
    saving.current = true
    try {
      const log = finishSession(session)
      if (update(current => {
        if (current.activeSession?.id !== session.id || current.logs.some(item => item.id === log.id)) throw new Error('This session changed or was already saved. Reopen the active workout before saving.')
        return { ...current, activeSession: null, logs: [log, ...current.logs] }
      }, 'Workout saved')) navigate('/progress')
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
      <p className="session-note">Your session is saved after each change. You can leave this page or reopen the app to resume. Pause the timer during breaks you don’t want included.</p>
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
            <label>Weight (kg)<input aria-label={`${exercise.name} set ${index + 1} weight`} type="number" min="0" max="1000" step="0.1" placeholder="Bodyweight" value={set.weightKg ?? ''} onChange={event => {
              const value = event.target.value === '' ? null : Number(event.target.value)
              if (value === null || Number.isFinite(value) && value >= 0 && value <= 1000) changeSet(set.id, { weightKg: value })
            }} /></label>
            <label>RPE (optional)<input aria-label={`${exercise.name} set ${index + 1} RPE`} type="number" min="1" max="10" step="0.5" value={set.rpe ?? ''} onChange={event => {
              const value = event.target.value === '' ? null : Number(event.target.value)
              if (value === null || value >= 1 && value <= 10) changeSet(set.id, { rpe: value })
            }} /></label>
            <label className="warmup-label"><input type="checkbox" checked={set.warmup} onChange={event => changeSet(set.id, { warmup: event.target.checked })} />Warm-up</label>
            <button className={set.completed ? 'secondary-button' : 'primary-button'} aria-label={`${set.completed ? 'Undo' : 'Complete'} ${exercise.name} set ${index + 1}`} disabled={!set.completed && (timed ? set.seconds === null || set.seconds <= 0 : set.reps === null || set.reps <= 0)} onClick={() => {
              const saved = change(current => ({ ...current, restUntil: set.completed ? current.restUntil : Date.now() + exercise.restSeconds * 1000, sets: current.sets.map(item => item.id === set.id ? { ...item, completed: !item.completed } : item) }))
              if (saved && !set.completed && state.preferences.soundEnabled) void nativeSuccessFeedback()
            }}>{set.completed ? 'Done' : 'Complete'}</button>
            <button className="icon-button danger" aria-label={`Remove ${exercise.name} set ${index + 1}`} disabled={sets.length <= 1} onClick={() => {
              if (set.completed && !window.confirm('Remove this completed set from the unfinished session?')) return
              change(current => ({ ...current, sets: current.sets.filter(item => item.id !== set.id) }))
            }}><Trash2 /></button>
            {last && <small className="previous-set">Last: {last.reps ?? last.seconds ?? '—'}{last.seconds !== null ? ' sec' : ' reps'} · {last.weightKg ?? 0} kg</small>}
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
