import { useEffect, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { initialState } from '../data'
import { uid } from '../session'
import type { AppState, Workout } from '../types'
import type { UpdateState } from './WorkoutSession'
import { clearPlanDraft, readPlanDraft, savePlanDraft } from '../planDraft'
import ExercisePicker from './ExercisePicker'
import PlanHistory from './PlanHistory'
import { savePlanRevision } from '../planning'
import { Link } from 'react-router-dom'

export default function PlanEditor({ state, update }: { state: AppState; update: UpdateState }) {
  const [restored] = useState(readPlanDraft)
  const [selected, setSelected] = useState<Workout>(() => restored ?? structuredClone(state.workouts[0]))
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(!!restored)
  useEffect(() => {
    if (!dirty) return
    try { savePlanDraft(selected) } catch { setError('This tab cannot save draft edits. Save the workout before leaving this page.') }
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty, selected])
  const edit = (value: Workout) => { setSelected(value); setDirty(true) }
  const choose = (workout: Workout) => {
    if (dirty && !window.confirm('Discard unsaved plan edits?')) return false
    clearPlanDraft(); setSelected(structuredClone(workout)); setDirty(false); setError(''); return true
  }
  const save = () => {
    const previous = state.workouts.find(workout => workout.id === selected.id)
    const next = { ...selected, exercises: selected.exercises.map(exercise => previous?.exercises.some(old => old.id === exercise.id && old.name !== exercise.name) ? { ...exercise, id: uid() } : exercise) }
    if (update(current => savePlanRevision(current, current.workouts.some(workout => workout.id === selected.id) ? current.workouts.map(workout => workout.id === selected.id ? next : workout) : [...current.workouts, next], `Before editing ${selected.title}`), 'Workout plan saved')) {
      clearPlanDraft(); setSelected(next); setDirty(false); setError('')
    } else setError('Check the fields above. Your previous saved plan has been kept.')
  }
  return <section><header className="page-header"><span>Plan builder</span><h1>Make your plan yours</h1><p>Edit the starter templates, schedule sessions, and record the exercises you choose. These are editable templates, not an AI-generated prescription.</p></header>
    <Link className="secondary-button" to="/schedule">Build a weekly schedule</Link>
    {dirty && <div className="notice" role="status">Unsaved plan changes are kept in this browser tab. Save to apply them and include them in backups. Closing the tab can discard drafts.</div>}<div className="notice">Changes apply to future sessions. Workout history and an unfinished session’s saved exercise list stay intact.</div>
    <div className="plan-layout"><aside className="panel plan-picker"><h2>Your sessions</h2>{state.workouts.map(workout => <button className={selected.id === workout.id ? 'primary-button' : 'secondary-button'} key={workout.id} onClick={() => choose(workout)}>{workout.day}: {workout.title}</button>)}
      <h3>Add from template</h3>{initialState.workouts.map(workout => <button className="secondary-button" key={workout.id} disabled={state.workouts.length >= 100} onClick={() => { if (choose({ ...structuredClone(workout), id: uid(), title: `${workout.title} copy`, exercises: workout.exercises.map(exercise => ({ ...exercise, id: uid() })) })) setDirty(true) }}><Plus />{workout.title}</button>)}
    </aside><form className="panel form plan-form" onSubmit={event => { event.preventDefault(); save() }}>
      <label>Workout title<input required maxLength={150} value={selected.title} onChange={event => edit({ ...selected, title: event.target.value })} /></label>
      <label>Scheduled day<select value={selected.day} onChange={event => edit({ ...selected, day: event.target.value })}>{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','Any day'].map(day => <option key={day}>{day}</option>)}</select></label>
      <label>Experience<select value={selected.difficulty} onChange={event => edit({ ...selected, difficulty: event.target.value as Workout['difficulty'] })}>{['Beginner','Intermediate','Advanced'].map(level => <option key={level}>{level}</option>)}</select></label>
      <label>Planned minutes<input required type="number" min="1" max="600" value={selected.duration} onChange={event => edit({ ...selected, duration: Number(event.target.value) })} /></label>
      <label>Estimated calories (optional estimate)<input required type="number" min="0" max="10000" value={selected.calories} onChange={event => edit({ ...selected, calories: Number(event.target.value) })} /></label>
      <label>Description<textarea maxLength={2000} value={selected.description} onChange={event => edit({ ...selected, description: event.target.value })} /></label>
      {selected.exercises.map((exercise, index) => <fieldset key={exercise.id}><legend>Exercise {index + 1}</legend>
        <label>Exercise name<input required maxLength={100} value={exercise.name} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, name: event.target.value } : item) })} /></label>
        <div className="form-inline"><label>Sets<input required type="number" min="1" max="20" value={exercise.sets} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, sets: Number(event.target.value) } : item) })} /></label>
          <label>Target reps / seconds<input required maxLength={50} value={exercise.reps} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, reps: event.target.value } : item) })} /></label>
          <label>Rest seconds<input required type="number" min="0" max="900" value={exercise.restSeconds} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, restSeconds: Number(event.target.value) } : item) })} /></label></div>
        <label>Technique notes<textarea maxLength={1000} value={exercise.notes ?? ''} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, notes: event.target.value } : item) })} /></label>
        <button type="button" className="secondary-button danger" disabled={selected.exercises.length <= 1} onClick={() => edit({ ...selected, exercises: selected.exercises.filter(item => item.id !== exercise.id) })}><Trash2 />Remove exercise</button>
      </fieldset>)}
      <button type="button" className="secondary-button" disabled={selected.exercises.length >= 50} onClick={() => edit({ ...selected, exercises: [...selected.exercises, { id: uid(), name: 'Custom exercise', sets: 3, reps: '8–12', restSeconds: 60, category: 'Custom' }] })}><Plus />Add exercise</button>
      <ExercisePicker workouts={state.workouts} disabled={selected.exercises.length >= 50} onAdd={exercise => edit({ ...selected, exercises: [...selected.exercises, { ...exercise, id: uid() }] })} />
      {error && <p role="alert" className="error-message">{error}</p>}
      <button className="primary-button" type="submit"><Save />Save workout plan{dirty ? ' *' : ''}</button>
      <button type="button" className="secondary-button danger" disabled={state.workouts.length <= 1 || !state.workouts.some(workout => workout.id === selected.id)} onClick={() => {
        if (!window.confirm(`Remove ${selected.title} from your plan? History and the current session will be kept.`)) return
        if (update(current => savePlanRevision(current, current.workouts.filter(workout => workout.id !== selected.id), `Before removing ${selected.title}`), 'Workout removed from plan')) { clearPlanDraft(); setSelected(structuredClone(state.workouts.find(workout => workout.id !== selected.id)!)); setDirty(false) }
      }}><Trash2 />Remove workout from plan</button>
    </form></div>
    <PlanHistory state={state} update={update} onRestore={workout => { setDirty(false); setError(''); setSelected(structuredClone(workout)) }} />
  </section>
}
