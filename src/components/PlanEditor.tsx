import { useEffect, useRef, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { initialState } from '../data'
import { uid } from '../session'
import { freshIdentityFactory } from '../identities'
import type { AppState, Workout } from '../types'
import type { UpdateState } from './WorkoutSession'
import { clearPlanDraft, readPlanDraft, savePlanDraft } from '../planDraft'
import ExercisePicker from './ExercisePicker'
import LibraryOrigin from './LibraryOrigin'
import { materializeLibraryCopy } from '../exerciseLibrary'
import PlanHistory from './PlanHistory'
import { copyWorkout, prepareWorkoutForSave, savePlanRevision } from '../planning'
import { assertPlannedGroupingEdit } from '../plannedGrouping'
import PlannedGroupingEditor from './PlannedGroupingEditor'
import { Link } from 'react-router-dom'
import { AvailableEquipment, EquipmentOverview, EquipmentRequirements, EquipmentStatus, type EquipmentSelection } from './EquipmentControls'
import { usePlanningGuard } from './usePlanningGuard'

export default function PlanEditor({ state, update, readGeneration }: { state: AppState; update: UpdateState; readGeneration?: () => number }) {
  const guard = usePlanningGuard(state, readGeneration)
  const [restored] = useState(readPlanDraft)
  const [selected, setSelected] = useState<Workout>(() => restored ?? structuredClone(state.workouts[0]))
  const [listedEmpty, setListedEmpty] = useState<string[]>([])
  const [equipment, setEquipment] = useState<EquipmentSelection>({ enabled: false, available: [] })
  const [source, setSource] = useState(() => ({ state, snapshot: guard.snapshot, generation: readGeneration?.() }))
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(!!restored)
  const [recoveryReview, setRecoveryReview] = useState(() => !!restored && state.workouts.some(workout => workout.id === restored.id && JSON.stringify(workout) !== JSON.stringify(restored)))
  const draft = useRef({ selected, listedEmpty, equipment })
  draft.current = { selected, listedEmpty, equipment }
  const draftSnapshot = JSON.stringify(draft.current)
  const viewIsCurrent = () => guard.isCurrent() && JSON.stringify(draft.current) === draftSnapshot
  const sourceIsCurrent = source.state === state && source.snapshot === guard.snapshot && source.generation === readGeneration?.()
  useEffect(() => {
    if (!dirty) return
    try { savePlanDraft(selected) } catch { setError('This tab cannot save draft edits. Save the workout before leaving this page.') }
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty, selected])
  const edit = (value: Workout, pending = listedEmpty) => {
    if (!viewIsCurrent()) return false
    try { assertPlannedGroupingEdit(selected, value) }
    catch (cause) { guard.invalidate(); setError(cause instanceof Error ? cause.message : 'Remove the affected planned groups before changing their rows.'); return false }
    guard.invalidate(); setSelected(value); setListedEmpty(pending); setDirty(true); setError(''); return true
  }
  const choose = (workout: Workout) => {
    if (!viewIsCurrent()) return false
    if (dirty && !window.confirm('Discard unsaved plan edits?')) return false
    if (!viewIsCurrent()) return false
    guard.invalidate(); clearPlanDraft(); setSelected(structuredClone(workout)); setListedEmpty([]); setDirty(false); setRecoveryReview(false); setError('')
    setSource({ state, snapshot: guard.snapshot, generation: readGeneration?.() }); return true
  }
  const save = () => {
    if (!viewIsCurrent()) return
    if (!sourceIsCurrent) { setError('Saved data changed while this draft was open. Your draft is kept. Choose a session to reload the current plan before saving.'); return }
    if (listedEmpty.length) { setError('Finish each listed equipment selection, or explicitly choose unknown or no equipment. Your draft is kept.'); return }
    const previous = state.workouts.find(workout => workout.id === selected.id)
    if (recoveryReview && previous && !window.confirm(`Apply this recovered draft to the currently saved “${previous.title}”? Saved data may have changed since this draft was created. Your current saved plan will be kept in previous versions.`)) return
    if (!viewIsCurrent()) return
    let savedState: AppState | undefined
    try {
      const next = prepareWorkoutForSave(selected, previous, { reserved: state })
      if (guard.commit(update, current => {
        savedState = savePlanRevision(current, current.workouts.some(workout => workout.id === selected.id) ? current.workouts.map(workout => workout.id === selected.id ? next : workout) : [...current.workouts, next], `Before editing ${selected.title}`)
        return savedState
      }, 'Workout plan saved', viewIsCurrent)) {
        guard.invalidate(); clearPlanDraft(); setSelected(next); setDirty(false); setRecoveryReview(false); setError('')
        setSource({ state: savedState ?? state, snapshot: JSON.stringify((savedState ?? state).workouts), generation: readGeneration?.() })
      } else setError('Workout was not saved. Your draft is kept; check the fields and retry when storage is available.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Workout was not saved. Your draft is kept.') }
  }
  const available = equipment.enabled ? equipment.available : undefined
  return <section><header className="page-header"><span>Plan builder</span><h1>Make your plan yours</h1><p>Edit the starter templates, schedule sessions, and record the exercises you choose. These are editable templates, not an AI-generated prescription.</p></header>
    <Link className="secondary-button" to="/schedule">Build a weekly schedule</Link>
    <Link className="secondary-button" to="/exercise-library">Manage your exercise library</Link>
    {dirty && <div className="notice" role="status">Unsaved plan changes are kept in this browser tab. Save to apply them and include them in backups. Closing the tab can discard drafts.</div>}<div className="notice">Changes apply to future sessions. Workout history and an unfinished session’s saved exercise list stay intact.</div>
    {recoveryReview && <div className="notice" role="status">This recovered draft differs from the currently saved workout, “{state.workouts.find(workout => workout.id === selected.id)?.title}”. Saved data may have changed since the draft was created. Review your edits before saving; you’ll be asked to confirm, and the current saved plan will be kept in previous versions. Choosing a saved session discards the draft after confirmation.</div>}
    {!sourceIsCurrent && <p role="alert" className="error-message">Saved data changed while this draft was open. Choose a session to reload the current plan before saving. Your draft has not been applied.</p>}
    <AvailableEquipment value={equipment} onChange={value => { if (!viewIsCurrent()) return; guard.invalidate(); setEquipment(value) }} />
    <div className="plan-layout"><aside className="panel plan-picker"><h2>Your sessions</h2>{state.workouts.map(workout => <button className={selected.id === workout.id ? 'primary-button' : 'secondary-button'} key={workout.id} onClick={() => choose(workout)}>{workout.day}: {workout.title}</button>)}
      <h3>Add from template</h3>{initialState.workouts.map(workout => <button className="secondary-button" key={workout.id} disabled={state.workouts.length >= 100} onClick={() => { try { if (choose({ ...copyWorkout(workout, { reserved: state }), title: `${workout.title} copy` })) setDirty(true) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to copy the template.') } }}><Plus />{workout.title}</button>)}
    </aside><form className="panel form plan-form" onSubmit={event => { event.preventDefault(); save() }}>
      <label>Workout title<input required maxLength={150} value={selected.title} onChange={event => edit({ ...selected, title: event.target.value })} /></label>
      <label>Scheduled day<select value={selected.day} onChange={event => edit({ ...selected, day: event.target.value })}>{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','Any day'].map(day => <option key={day}>{day}</option>)}</select></label>
      <label>Experience<select value={selected.difficulty} onChange={event => edit({ ...selected, difficulty: event.target.value as Workout['difficulty'] })}>{['Beginner','Intermediate','Advanced'].map(level => <option key={level}>{level}</option>)}</select></label>
      <label>Planned minutes<input required type="number" min="1" max="600" value={selected.duration} onChange={event => edit({ ...selected, duration: Number(event.target.value) })} /></label>
      <label>Estimated calories (optional estimate)<input required type="number" min="0" max="10000" value={selected.calories} onChange={event => edit({ ...selected, calories: Number(event.target.value) })} /></label>
      <label>Description<textarea maxLength={2000} value={selected.description} onChange={event => edit({ ...selected, description: event.target.value })} /></label>
      <EquipmentOverview exercises={selected.exercises} available={available} />
      <PlannedGroupingEditor workout={selected} reserved={state} isViewCurrent={viewIsCurrent} isCurrent={() => viewIsCurrent() && sourceIsCurrent} onChange={value => edit(value)} />
      {selected.exercises.map((exercise, index) => <fieldset key={exercise.id}><legend>Exercise {index + 1}</legend>
        <LibraryOrigin origin={exercise.libraryOrigin} />
        <label>Exercise name<input required maxLength={100} value={exercise.name} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, name: event.target.value } : item) })} /></label>
        <div className="form-inline"><label>Sets<input required type="number" min="1" max="20" value={exercise.sets} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, sets: Number(event.target.value) } : item) })} /></label>
          <label>Target reps / seconds<input required maxLength={50} value={exercise.reps} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, reps: event.target.value } : item) })} /></label>
          <label>Rest seconds<input required type="number" min="0" max="900" value={exercise.restSeconds} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, restSeconds: Number(event.target.value) } : item) })} /></label></div>
        <label>Technique notes<textarea maxLength={1000} value={exercise.notes ?? ''} onChange={event => edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? { ...item, notes: event.target.value } : item) })} /></label>
        <EquipmentRequirements label={`Exercise ${index + 1}`} requirements={exercise.equipment} listedEmpty={listedEmpty.includes(exercise.id)} onChange={(requirements, empty) => {
          const next = structuredClone(exercise)
          if (requirements === undefined) delete next.equipment
          else next.equipment = [...requirements]
          edit({ ...selected, exercises: selected.exercises.map(item => item.id === exercise.id ? next : item) }, empty ? [...listedEmpty.filter(id => id !== exercise.id), exercise.id] : listedEmpty.filter(id => id !== exercise.id))
        }} />
        <EquipmentStatus requirements={exercise.equipment} available={available} />
        <button type="button" className="secondary-button danger" disabled={selected.exercises.length <= 1} onClick={() => edit({ ...selected, exercises: selected.exercises.filter(item => item.id !== exercise.id) }, listedEmpty.filter(id => id !== exercise.id))}><Trash2 />Remove exercise</button>
      </fieldset>)}
      <button type="button" className="secondary-button" disabled={selected.exercises.length >= 50} onClick={() => edit({ ...selected, exercises: [...selected.exercises, { id: uid(), name: 'Custom exercise', sets: 3, reps: '8–12', restSeconds: 60, category: 'Custom' }] })}><Plus />Add exercise</button>
      <ExercisePicker workouts={state.workouts} state={state} destinationSnapshot={draftSnapshot} destination={`“${selected.title}” on ${selected.day}`} isCurrent={() => viewIsCurrent() && sourceIsCurrent} availableEquipment={available} disabled={selected.exercises.length >= 50} onAdd={(exercise, libraryCopy) => {
        if (!viewIsCurrent() || !sourceIsCurrent) return false
        try { const copied = libraryCopy ? materializeLibraryCopy(state, libraryCopy, { reserved: [state, selected] }) : { ...structuredClone(exercise), id: freshIdentityFactory([state, selected, exercise], uid)() }; return edit({ ...selected, exercises: [...selected.exercises, copied] }) }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to copy this exercise.'); return false }
      }} />
      {error && <p role="alert" className="error-message">{error}</p>}
      <button className="primary-button" type="submit"><Save />Save workout plan{dirty ? ' *' : ''}</button>
      <button type="button" className="secondary-button danger" disabled={state.workouts.length <= 1 || !state.workouts.some(workout => workout.id === selected.id)} onClick={() => {
        if (!viewIsCurrent() || !sourceIsCurrent) { setError('Your saved plan changed. Choose a current session before removing it.'); return }
        const savedWorkout = state.workouts.find(workout => workout.id === selected.id)
        if (!savedWorkout) { setError('This saved workout is no longer available. Choose a current session before removing it.'); return }
        if (!window.confirm(`Remove the saved workout “${savedWorkout.title}” from your plan? History and the current session will be kept. Any unsaved or recovered draft for this workout will be discarded only if removal is saved successfully.`)) return
        let nextState: AppState | undefined
        try {
          if (guard.commit(update, current => { nextState = savePlanRevision(current, current.workouts.filter(workout => workout.id !== selected.id), `Before removing ${savedWorkout.title}`); return nextState }, 'Workout removed from plan', viewIsCurrent)) {
            guard.invalidate(); clearPlanDraft(); setSelected(structuredClone((nextState ?? state).workouts[0])); setListedEmpty([]); setDirty(false); setRecoveryReview(false); setError('')
            setSource({ state: nextState ?? state, snapshot: JSON.stringify((nextState ?? state).workouts), generation: readGeneration?.() })
          } else setError('Workout was not removed. Your draft is kept; retry when storage is available.')
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Workout was not removed.') }
      }}><Trash2 />Remove workout from plan</button>
    </form></div>
    <PlanHistory state={state} update={(change, message) => guard.commit(update, change, message ?? 'Plan version restored', viewIsCurrent)} onRestore={(workout, nextState) => {
      guard.invalidate(); setDirty(false); setRecoveryReview(false); setError(''); setSelected(structuredClone(workout)); setListedEmpty([])
      setSource({ state: nextState, snapshot: JSON.stringify(nextState.workouts), generation: readGeneration?.() })
    }} />
  </section>
}
