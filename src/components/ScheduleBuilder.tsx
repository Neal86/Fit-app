import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { clearPlanDraft, readPlanDraft } from '../planDraft'
import { savePlanRevision, schedulePreview, weekdays, type ScheduleChoice } from '../planning'
import type { AppState, Workout } from '../types'
import type { UpdateState } from './WorkoutSession'
import './ScheduleBuilder.css'

export default function ScheduleBuilder({ state, update }: { state: AppState; update: UpdateState }) {
  const navigate = useNavigate()
  const [minutes, setMinutes] = useState(60)
  const [choices, setChoices] = useState<ScheduleChoice[]>([])
  const [preview, setPreview] = useState<Workout[] | null>(null)
  const [error, setError] = useState('')
  const [source, setSource] = useState('')
  const edit = (next: ScheduleChoice[]) => { setChoices(next); setPreview(null); setError('') }
  const available = state.workouts.filter(workout => workout.duration <= minutes)
  return <section className="schedule-builder"><header className="page-header"><span>Schedule builder</span><h1>Plan your training week</h1><p>Choose your days and saved sessions within your time limit. This arranges your choices; it does not generate an AI plan or adjust training intensity.</p></header><Link className="back-link" to="/plan">Back to plan editor</Link><form className="panel" onSubmit={event => { event.preventDefault(); try { setPreview(schedulePreview(state.workouts, choices, minutes)); setSource(JSON.stringify(state.workouts)); setError('') } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : 'Check your schedule choices.') } }}><label>Maximum planned minutes per session<input type="number" required min="1" max="600" value={minutes} onChange={event => { setMinutes(Number(event.target.value)); setPreview(null) }} /></label><p>Your weekly goal is {state.profile.weeklyTarget} sessions. You choose how many days to schedule.</p>{!available.length && <p className="notice">None of your sessions fit this time limit. Edit a workout’s contents and duration first, or change the limit.</p>}{weekdays.map(day => {
    const choice = choices.find(item => item.day === day)
    return <div className="schedule-day" key={day}><label><input type="checkbox" checked={!!choice} disabled={!choice && !available.length} onChange={event => edit(event.target.checked ? [...choices, { day, workoutId: available[0]?.id ?? '' }] : choices.filter(item => item.day !== day))} />{day}</label>{choice && <label>Session for {day}<select value={choice.workoutId} onChange={event => edit(choices.map(item => item.day === day ? { ...item, workoutId: event.target.value } : item))}>{state.workouts.map(workout => <option key={workout.id} value={workout.id} disabled={workout.duration > minutes}>{workout.title} ({workout.duration} min){workout.duration > minutes ? ' — over limit' : ''}</option>)}</select></label>}</div>
  })}<button className="primary-button" type="submit">Preview weekly schedule</button></form>{error && <p role="alert" className="error-message">{error}</p>}{preview && <div className="panel"><h2>Review your schedule</h2><p>{preview.length} sessions, {preview.reduce((sum, workout) => sum + workout.duration, 0)} planned minutes. Set targets are unchanged. Applying this replaces your current plan and saves its previous version.</p><ol>{preview.map(workout => <li key={workout.id}><strong>{workout.day}: {workout.title}</strong><p>{workout.duration} minutes · {workout.exercises.length} exercises</p></li>)}</ol><button className="primary-button" onClick={() => {
    if (source !== JSON.stringify(state.workouts)) { setPreview(null); setError('Your plan changed since this preview. Review a new preview before applying.'); return }
    if (!window.confirm(`Replace your plan with these ${preview.length} scheduled sessions? Your current plan will be saved in previous versions.${readPlanDraft() ? ' Your unfinished editor draft will be discarded.' : ''}`)) return
    if (update(current => { if (JSON.stringify(current.workouts) !== source) throw new Error('Your plan changed. Generate a new preview.'); return savePlanRevision(current, preview, 'Before applying a weekly schedule') }, 'Weekly schedule saved')) { clearPlanDraft(); navigate('/plan') }
  }}>Apply this schedule</button><button className="secondary-button" onClick={() => setPreview(null)}>Keep editing</button></div>}</section>
}
