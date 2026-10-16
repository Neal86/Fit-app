import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { clearPlanDraft, readPlanDraft } from '../planDraft'
import { savePlanRevision, schedulePreview, weekdays, type ScheduleChoice } from '../planning'
import { equipmentMatch } from '../equipment'
import type { AppState, Workout } from '../types'
import type { UpdateState } from './WorkoutSession'
import { AvailableEquipment, EquipmentOverview, type EquipmentSelection } from './EquipmentControls'
import { usePlanningGuard } from './usePlanningGuard'
import './ScheduleBuilder.css'
import PlannedGroupSummary from './PlannedGroupSummary'

type Inputs = { minutes: number; choices: ScheduleChoice[]; equipment: EquipmentSelection; matchedOnly: boolean }
type Review = { workouts: Workout[]; snapshot: string; inputs: string; source: AppState; sourceSnapshot: string; generation: number | undefined; route: string }

export default function ScheduleBuilder({ state, update, readGeneration }: { state: AppState; update: UpdateState; readGeneration?: () => number }) {
  const navigate = useNavigate()
  const guard = usePlanningGuard(state, readGeneration)
  const [inputs, setInputs] = useState<Inputs>({ minutes: 60, choices: [], equipment: { enabled: false, available: [] }, matchedOnly: false })
  const [preview, setPreview] = useState<Review | null>(null)
  const reviewRef = useRef<Review | null>(null)
  const inputRef = useRef(inputs)
  inputRef.current = inputs
  const inputSnapshot = JSON.stringify(inputs)
  const [error, setError] = useState('')
  const { minutes, choices, equipment, matchedOnly } = inputs
  const viewIsCurrent = () => guard.isCurrent() && inputRef.current === inputs && JSON.stringify(inputRef.current) === inputSnapshot
  const sourceIsCurrent = (review: Review) => review.source === state && review.sourceSnapshot === guard.snapshot && review.generation === readGeneration?.() && review.route === guard.route
  if (preview && !sourceIsCurrent(preview)) reviewRef.current = null
  const activePreview = preview && reviewRef.current === preview ? preview : null
  const edit = (next: Inputs) => {
    if (!viewIsCurrent()) return
    guard.invalidate(); reviewRef.current = null; setInputs(next); setPreview(null); setError('')
  }
  const comparison = equipment.enabled ? equipment.available : undefined
  const fullyMatches = (workout: Workout) => workout.exercises.every(exercise => equipmentMatch(exercise.equipment, equipment.available).status === 'matched')
  const restricted = equipment.enabled && matchedOnly
  const available = state.workouts.filter(workout => workout.duration <= minutes && (!restricted || fullyMatches(workout)))
  const validate = (workouts: Workout[]) => {
    const result = schedulePreview(workouts, choices, minutes, { reserved: state })
    if (restricted) {
      const unavailable = result.find(workout => !fullyMatches(workout))
      if (unavailable) throw new Error(`${unavailable.title} has missing equipment or unknown requirements. Choose an explicitly matching session, update requirements in the plan editor, or turn off the equipment restriction.`)
    }
    return result
  }
  const validReview = (review: Review) => viewIsCurrent() && reviewRef.current === review && sourceIsCurrent(review) && review.inputs === inputSnapshot && JSON.stringify(state.workouts) === review.sourceSnapshot && JSON.stringify(review.workouts) === review.snapshot
  const apply = (review: Review) => {
    if (!validReview(review)) { setError('Your plan, equipment or choices changed. Review a new preview before applying.'); return }
    if (!window.confirm(`Replace your plan with these ${review.workouts.length} scheduled sessions? Your current plan will be saved in previous versions.${readPlanDraft() ? ' Your unfinished editor draft will be discarded.' : ''}`)) return
    try {
      if (guard.commit(update, current => {
        validate(current.workouts)
        return savePlanRevision(current, review.workouts, 'Before applying a weekly schedule')
      }, 'Weekly schedule saved', () => validReview(review))) {
        guard.invalidate(); reviewRef.current = null; clearPlanDraft(); setPreview(null); navigate('/plan')
      } else setError('Schedule was not saved. Your choices and review are kept; retry when storage is available.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Schedule was not saved. Your choices are kept.') }
  }
  return <section className="schedule-builder"><header className="page-header"><span>Schedule builder</span><h1>Plan your training week</h1><p>Choose your days and saved sessions within your time limit. This arranges your choices; it does not generate an AI plan or adjust training intensity.</p></header><Link className="back-link" to="/plan">Back to plan editor</Link>
    <form className="panel" onSubmit={event => {
      event.preventDefault()
      if (!viewIsCurrent()) return
      try {
        const workouts = validate(state.workouts)
        const review = { workouts, snapshot: JSON.stringify(workouts), inputs: inputSnapshot, source: state, sourceSnapshot: guard.snapshot, generation: readGeneration?.(), route: guard.route }
        guard.invalidate(); reviewRef.current = review; setPreview(review); setError('')
      } catch (cause) { guard.invalidate(); reviewRef.current = null; setPreview(null); setError(cause instanceof Error ? cause.message : 'Check your schedule choices.') }
    }}>
      <label>Maximum planned minutes per session<input type="number" required min="1" max="600" value={minutes} onChange={event => edit({ ...inputs, minutes: Number(event.target.value) })} /></label>
      <AvailableEquipment value={equipment} onChange={value => edit({ ...inputs, equipment: value })} />
      {equipment.enabled && <label className="equipment-check equipment-filter"><input type="checkbox" checked={matchedOnly} onChange={event => edit({ ...inputs, matchedOnly: event.target.checked })} />Only allow fully equipment-matched sessions</label>}
      <p>Unknown requirements do not count as matches. Equipment or time changes keep your selected days and sessions so you can review conflicts yourself. Set targets are never adjusted.</p>
      <p>Your weekly goal is {state.profile.weeklyTarget} sessions. You choose how many days to schedule.</p>
      {!available.length && <p className="notice">None of your sessions fit these filters. Edit a workout’s requirements or duration, change the time limit, or turn off the equipment restriction.</p>}
      {weekdays.map(day => {
        const choice = choices.find(item => item.day === day)
        const selected = state.workouts.find(workout => workout.id === choice?.workoutId)
        return <div className="schedule-day" key={day}><label><input type="checkbox" checked={!!choice} disabled={!choice && !available.length} onChange={event => edit({ ...inputs, choices: event.target.checked ? [...choices, { day, workoutId: available[0]?.id ?? '' }] : choices.filter(item => item.day !== day) })} />{day}</label>{choice && <label>Session for {day}<select value={choice.workoutId} onChange={event => edit({ ...inputs, choices: choices.map(item => item.day === day ? { ...item, workoutId: event.target.value } : item) })}>
          {!selected && <option value={choice.workoutId}>Selected session is no longer available</option>}
          {state.workouts.map(workout => <option key={workout.id} value={workout.id} disabled={workout.duration > minutes || restricted && !fullyMatches(workout)}>{workout.title} ({workout.duration} min){workout.duration > minutes ? ' — over time limit' : ''}{restricted && !fullyMatches(workout) ? ' — equipment missing or unknown' : ''}</option>)}
        </select></label>}{selected && choice && <EquipmentOverview exercises={selected.exercises} available={comparison} details />}</div>
      })}
      <button className="primary-button" type="submit">Preview weekly schedule</button>
    </form>
    {error && <p role="alert" className="error-message">{error}</p>}
    {preview && !activePreview && !error && <p role="alert" className="error-message">Saved data or this page changed. Review a new preview before applying. Your choices are kept.</p>}
    {activePreview && <div className="panel"><h2>Review your schedule</h2><p>{activePreview.workouts.length} sessions, {activePreview.workouts.reduce((sum, workout) => sum + workout.duration, 0)} planned minutes. Set targets are unchanged. Applying this replaces your current plan and saves its previous version.</p><ol>{activePreview.workouts.map(workout => <li key={workout.id}><strong>{workout.day}: {workout.title}</strong><p>{workout.duration} minutes · {workout.exercises.length} exercises</p><EquipmentOverview exercises={workout.exercises} available={comparison} details /><PlannedGroupSummary workout={workout} /></li>)}</ol><button className="primary-button" onClick={() => apply(activePreview)}>Apply this schedule</button><button className="secondary-button" onClick={() => { if (!validReview(activePreview)) return; guard.invalidate(); reviewRef.current = null; setPreview(null); setError('') }}>Keep editing</button></div>}
  </section>
}
