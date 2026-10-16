import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, Pause, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Link, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom'
import { elapsedSeconds, finishSession, formatTime, previousSet, setSessionCompletion, startSession, toggleSession, uid } from '../session'
import type { ActiveSession, AppState, Exercise, ExerciseSet } from '../types'
import { nativeSuccessFeedback } from '../native'
import { formatMeasurement, measurementDraft, measurementRange, measurementUnit, readMeasurement, syncMeasurement } from '../units'
import type { MeasurementDraft } from '../units'
import { applySessionReplacement, reviewSessionReplacement } from '../sessionReplacement'
import type { SessionReplacementReview } from '../sessionReplacement'
import SessionReplacement from './SessionReplacement'
import { applySessionAddition, reviewSessionAddition } from '../sessionAddition'
import type { SessionAdditionReview } from '../sessionAddition'
import SessionAddition from './SessionAddition'
import { applySessionGrouping, applySessionGroupRemoval, reviewSessionGrouping, reviewSessionGroupRemoval } from '../sessionGrouping'
import type { SessionGroupingReview, SessionGroupRemovalReview } from '../sessionGrouping'
import SessionGrouping from './SessionGrouping'
import { groupRowLabel } from './sessionGroupLabels'
import PlannedGroupSummary from './PlannedGroupSummary'
import type { LibraryCopyReview } from '../exerciseLibrary'
import LibraryOrigin from './LibraryOrigin'

export type UpdateState = (change: (state: AppState) => AppState, message?: string) => boolean
type ReplacementFlow = { libraryEpoch: number; librarySnapshot: string; state: AppState; routeEpoch: number; sourceId: string; sourceName: string; session: ActiveSession; snapshot: string; route: string; generation: number | undefined; review: SessionReplacementReview | null; drafts: Record<string, MeasurementDraft>; draftSnapshot: string; draftGeneration: number }

type AdditionFlow = { libraryEpoch: number; librarySnapshot: string; state: AppState; session: ActiveSession; snapshot: string; route: string; generation: number | undefined; review: SessionAdditionReview | null; draftSnapshot: string; draftGeneration: number }

type GroupingFlow = { state: AppState; session: ActiveSession; snapshot: string; route: string; routeEpoch: number; generation: number | undefined; review: SessionGroupingReview | null; removal: SessionGroupRemovalReview | null; drafts: Record<string, MeasurementDraft>; draftSnapshot: string; draftGeneration: number }

export default function WorkoutSession({ state, update, readGeneration, persistenceErrorAnnounced = false }: { state: AppState; update: UpdateState; readGeneration?: () => number; persistenceErrorAnnounced?: boolean }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const route = `${location.key}:${location.pathname}:${location.search}:${location.hash}`
  const librarySnapshot = JSON.stringify(state.exerciseLibrary)
  const libraryEpoch = useRef(0)
  const librarySource = useRef({ library: state.exerciseLibrary, snapshot: librarySnapshot })
  if (librarySource.current.library !== state.exerciseLibrary || librarySource.current.snapshot !== librarySnapshot) libraryEpoch.current++
  librarySource.current = { library: state.exerciseLibrary, snapshot: librarySnapshot }
  const mounted = useRef(true)
  const replacementBusy = useRef(false)
  const loadEdits = useRef(0)
  const flowRef = useRef<ReplacementFlow | null>(null)
  const [replacement, setReplacement] = useState<ReplacementFlow | null>(null)
  const [replacementError, setReplacementError] = useState('')
  const additionRef = useRef<AdditionFlow | null>(null)
  const additionBusy = useRef(false)
  const [addition, setAddition] = useState<AdditionFlow | null>(null)
  const [additionError, setAdditionError] = useState('')
  const groupingRef = useRef<GroupingFlow | null>(null)
  const groupingBusy = useRef(false)
  const [grouping, setGrouping] = useState<GroupingFlow | null>(null)
  const [groupingError, setGroupingError] = useState('')
  const seenRoute = useRef(route)
  const routeEpoch = useRef(0)
  if (seenRoute.current !== route) {
    seenRoute.current = route
    routeEpoch.current += 1
    flowRef.current = null
    if (replacement) setReplacement(null)
    additionRef.current = null
    if (addition) setAddition(null)
    groupingRef.current = null
    if (grouping) setGrouping(null)
  }
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const saving = useRef(false)
  const starting = useRef(false)
  const startEpoch = useRef(0)
  const renderStartEpoch = startEpoch.current
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
  const renderGeneration = readGeneration?.()
  const renderRouteEpoch = routeEpoch.current
  const renderLoadEdits = loadEdits.current
  const sessionSnapshot = JSON.stringify(active)
  const workoutSnapshot = JSON.stringify(workout)
  const currentContext = useRef({ route, session, loads, readGeneration, state, workout })
  currentContext.current = { route, session, loads, readGeneration, state, workout }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; flowRef.current = null; additionRef.current = null; groupingRef.current = null }
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  if (!workout) return <Navigate to="/workouts" replace />
  const viewIsCurrent = () => mounted.current && routeEpoch.current === renderRouteEpoch && loadEdits.current === renderLoadEdits && currentContext.current.route === route && currentContext.current.state === state && currentContext.current.readGeneration?.() === renderGeneration && JSON.stringify(currentContext.current.state.activeSession) === sessionSnapshot
  const assertCurrentState = (current: AppState) => {
    if (!viewIsCurrent() || current !== state || current.activeSession !== active || JSON.stringify(current.activeSession) !== sessionSnapshot) throw new Error('This session changed. Reopen it before editing.')
  }
  const change = (edit: (session: ActiveSession) => ActiveSession) => update(current => {
    assertCurrentState(current)
    const draft = current.activeSession
    return draft && draft.workout.id === id ? { ...current, activeSession: edit(draft) } : current
  })
  const isGrouped = (current: ActiveSession, setId: string) => current.grouping?.groups.some(group => group.rounds.some(round => round.setIds.includes(setId))) ?? false
  const changeSet = (setId: string, patch: Partial<ExerciseSet>) => change(current => {
    if (patch.warmup && isGrouped(current, setId)) throw new Error('Remove grouping before marking this row as a warm-up.')
    return { ...current, sets: current.sets.map(set => set.id === setId ? { ...set, ...patch } : set) }
  })
  const loadDraft = (set: ExerciseSet) => loads[set.id] ?? measurementDraft(set.weightKg, 'load', unit)
  const saveLoad = (set: ExerciseSet) => {
    try {
      if (!viewIsCurrent()) throw new Error('This session changed. Reopen it before editing.')
      const weightKg = readMeasurement(loadDraft(set), 'load')
      if (weightKg !== set.weightKg && !changeSet(set.id, { weightKg })) { setError('Load was not saved. Your entry is still here; retry before finishing.'); return false }
      loadEdits.current += 1
      setLoads(previous => ({ ...previous, [set.id]: measurementDraft(weightKg, 'load', unit) })); setError(''); return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the load.'); return false }
  }
  const start = () => {
    const validTarget = () => viewIsCurrent() && startEpoch.current === renderStartEpoch && !session && currentContext.current.workout === workout && state.workouts.find(item => item.id === id) === workout && JSON.stringify(workout) === workoutSnapshot
    if (starting.current || !validTarget()) return
    starting.current = true
    let invoked = false
    let attempting = true
    try {
      if (active && !window.confirm('Starting this workout will discard your current unfinished session. Continue?')) return
      if (!validTarget()) throw new Error('This workout plan changed. Reopen it and review its exact planned rows before starting.')
      const saved = update(current => {
        if (!attempting || invoked || !validTarget() || current !== state || current.workouts.find(item => item.id === id) !== workout || JSON.stringify(current.workouts.find(item => item.id === id)) !== workoutSnapshot) throw new Error('This session changed, its workout plan changed, or this start attempt ended. Review the current plan before starting.')
        assertCurrentState(current)
        invoked = true
        return { ...current, activeSession: startSession(workout, undefined, { reserved: current }) }
      }, 'Session started and saved on this device')
      if (saved) { startEpoch.current++; setError('') }
      else setError('Workout was not started. Your saved plan is unchanged; retry when storage is available.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Workout was not started.') }
    finally { attempting = false; starting.current = false }
  }
  const finish = () => {
    if (!session || saving.current || !viewIsCurrent()) return
    if (session.sets.some(set => !set.completed) && !window.confirm('Some sets are unfinished. Save this partial workout?')) return
    setAdditionFlow(null)
    setGroupingFlow(null)
    saving.current = true
    try {
      const sets = session.sets.map(set => ({ ...set, weightKg: readMeasurement(loadDraft(set), 'load') }))
      const log = finishSession({ ...session, sets })
      if (update(current => {
        assertCurrentState(current)
        if (current.activeSession?.id !== session.id || current.logs.some(item => item.id === log.id)) throw new Error('This session changed or was already saved. Reopen the active workout before saving.')
        return { ...current, activeSession: null, logs: [log, ...current.logs] }
      }, 'Workout saved')) navigate('/progress')
      else setError('Workout was not saved. Your load entries are still here; retry when storage is available.')
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save workout.') }
    finally { saving.current = false }
  }
  const setFlow = (flow: ReplacementFlow | null) => { flowRef.current = flow; setReplacement(flow); setReplacementError('') }
  const validContext = (flow: ReplacementFlow) => {
    const current = currentContext.current
    return mounted.current && flowRef.current === flow && libraryEpoch.current === flow.libraryEpoch && JSON.stringify(current.state.exerciseLibrary) === flow.librarySnapshot && !groupingRef.current && !additionRef.current && routeEpoch.current === flow.routeEpoch && current.state === flow.state && current.route === flow.route && current.session === flow.session && JSON.stringify(current.session) === flow.snapshot && current.readGeneration?.() === flow.generation && (!flow.review || loadEdits.current === flow.draftGeneration && JSON.stringify(current.loads) === flow.draftSnapshot)
  }
  const openReplacement = (exercise: Exercise, label: string) => {
    if (!session || !viewIsCurrent() || additionRef.current || flowRef.current || groupingRef.current) return
    setFlow({ libraryEpoch: libraryEpoch.current, librarySnapshot, state, routeEpoch: routeEpoch.current, sourceId: exercise.id, sourceName: label, session, snapshot: JSON.stringify(session), route, generation: readGeneration?.(), review: null, drafts: {}, draftSnapshot: '', draftGeneration: loadEdits.current })
  }
  const selectReplacement = (flow: ReplacementFlow, exercise: Exercise, libraryCopy?: LibraryCopyReview) => {
    if (!validContext(flow)) { setReplacementError('This review is no longer current. Cancel and start again.'); return }
    try {
      const review = reviewSessionReplacement(state, flow.sourceId, exercise, libraryCopy)
      const drafts = Object.fromEntries(review.removedSets.map(set => [set.id, structuredClone(loadDraft(set))]))
      setFlow({ ...flow, review, drafts, draftSnapshot: JSON.stringify(currentContext.current.loads), draftGeneration: loadEdits.current })
    } catch (cause) { setReplacementError(cause instanceof Error ? cause.message : 'Unable to review replacement.') }
  }
  const confirmReplacement = (flow: ReplacementFlow) => {
    if (replacementBusy.current || !flow.review || flowRef.current !== flow) return
    if (!validContext(flow)) { setReplacementError('This review is no longer current. Cancel and start again.'); return }
    replacementBusy.current = true
    let invoked = false
    let attempting = true
    try {
      const saved = update(current => {
        // A retained callback cannot be replayed, including after a successful apply or unmount.
        if (!attempting || invoked || !validContext(flow) || current !== flow.state || current.activeSession !== flow.session) throw new Error('This review is no longer current. Cancel and start again.')
        invoked = true
        return applySessionReplacement(current, flow.review!)
      }, 'Unfinished exercise sets replaced in this session')
      if (saved) setFlow(null)
      else setReplacementError('Replacement was not saved. Your review and original entries are still here; retry when storage is available.')
    } catch (cause) { setReplacementError(cause instanceof Error ? cause.message : 'Unable to save replacement.') }
    finally { attempting = false; replacementBusy.current = false }
  }
  const setAdditionFlow = (flow: AdditionFlow | null) => { additionRef.current = flow; setAddition(flow); setAdditionError('') }
  const validAdditionContext = (flow: AdditionFlow) => {
    const current = currentContext.current
    return mounted.current && additionRef.current === flow && libraryEpoch.current === flow.libraryEpoch && JSON.stringify(current.state.exerciseLibrary) === flow.librarySnapshot && !flowRef.current && !groupingRef.current && current.state === flow.state && current.route === flow.route && current.session === flow.session && JSON.stringify(current.session) === flow.snapshot && current.readGeneration?.() === flow.generation && (!flow.review || loadEdits.current === flow.draftGeneration && JSON.stringify(current.loads) === flow.draftSnapshot)
  }
  const openAddition = () => {
    if (!session || !viewIsCurrent() || flowRef.current || additionRef.current || groupingRef.current) return
    setAdditionFlow({ libraryEpoch: libraryEpoch.current, librarySnapshot, state, session, snapshot: JSON.stringify(session), route, generation: readGeneration?.(), review: null, draftSnapshot: '', draftGeneration: loadEdits.current })
  }
  const selectAddition = (flow: AdditionFlow, exercise: Exercise, libraryCopy?: LibraryCopyReview) => {
    if (!validAdditionContext(flow)) { setAdditionError('This review is no longer current. Cancel and start again.'); return }
    try {
      const review = reviewSessionAddition(state, exercise, libraryCopy)
      setAdditionFlow({ ...flow, review, draftSnapshot: JSON.stringify(currentContext.current.loads), draftGeneration: loadEdits.current })
    } catch (cause) { setAdditionError(cause instanceof Error ? cause.message : 'Unable to review addition.') }
  }
  const confirmAddition = (flow: AdditionFlow) => {
    if (additionBusy.current || !flow.review || additionRef.current !== flow) return
    if (!validAdditionContext(flow)) { setAdditionError('This review is no longer current. Cancel and start again.'); return }
    additionBusy.current = true
    let invoked = false
    let attempting = true
    try {
      const saved = update(current => {
        // This callback belongs only to this synchronous attempt, never to a later replay.
        if (!attempting || invoked || !validAdditionContext(flow) || current !== flow.state || current.activeSession !== flow.session) throw new Error('This review is no longer current. Cancel and start again.')
        invoked = true
        return applySessionAddition(current, flow.review!)
      }, 'Exercise added only to this session')
      if (saved) setAdditionFlow(null)
      else setAdditionError('Addition was not saved. Your review, form and original load entries are still here; retry when storage is available.')
    } catch (cause) { setAdditionError(cause instanceof Error ? cause.message : 'Unable to save addition.') }
    finally { attempting = false; additionBusy.current = false }
  }
  const setGroupingFlow = (flow: GroupingFlow | null) => { groupingRef.current = flow; setGrouping(flow); setGroupingError('') }
  const validGroupingContext = (flow: GroupingFlow) => {
    const current = currentContext.current
    return mounted.current && groupingRef.current === flow && !flowRef.current && !additionRef.current && routeEpoch.current === flow.routeEpoch && current.state === flow.state && current.route === flow.route && current.session === flow.session && JSON.stringify(current.session) === flow.snapshot && current.readGeneration?.() === flow.generation && (!(flow.review || flow.removal) || loadEdits.current === flow.draftGeneration && JSON.stringify(current.loads) === flow.draftSnapshot)
  }
  const openGrouping = (groupId?: string) => {
    if (!session || !viewIsCurrent() || flowRef.current || additionRef.current || groupingRef.current) return
    try {
      const removal = groupId ? reviewSessionGroupRemoval(state, groupId) : null
      setGroupingFlow({ state, session, snapshot: JSON.stringify(session), route, routeEpoch: routeEpoch.current, generation: readGeneration?.(), review: null, removal, drafts: structuredClone(currentContext.current.loads), draftSnapshot: JSON.stringify(currentContext.current.loads), draftGeneration: loadEdits.current })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to review grouping.') }
  }
  const selectGrouping = (flow: GroupingFlow, selection: Parameters<typeof reviewSessionGrouping>[1]) => {
    if (!validGroupingContext(flow)) { setGroupingError('This review is no longer current. Cancel and start again.'); return }
    try {
      const review = reviewSessionGrouping(state, selection)
      setGroupingFlow({ ...flow, review, drafts: structuredClone(currentContext.current.loads), draftSnapshot: JSON.stringify(currentContext.current.loads), draftGeneration: loadEdits.current })
    } catch (cause) { setGroupingError(cause instanceof Error ? cause.message : 'Unable to review grouping.') }
  }
  const confirmGrouping = (flow: GroupingFlow) => {
    if (groupingBusy.current || !(flow.review || flow.removal) || groupingRef.current !== flow) return
    if (!validGroupingContext(flow)) { setGroupingError('This review is no longer current. Cancel and start again.'); return }
    groupingBusy.current = true
    let invoked = false
    let attempting = true
    try {
      const saved = update(current => {
        if (!attempting || invoked || !validGroupingContext(flow) || current !== flow.state || current.activeSession !== flow.session) throw new Error('This review is no longer current. Cancel and start again.')
        invoked = true
        return flow.removal ? applySessionGroupRemoval(current, flow.removal) : applySessionGrouping(current, flow.review!)
      }, flow.removal ? 'Grouping removed; session rows unchanged' : 'Session-only grouping saved')
      if (saved) setGroupingFlow(null)
      else setGroupingError('Grouping was not saved. Your review, form and original load entries are still here; retry when storage is available.')
    } catch (cause) { setGroupingError(cause instanceof Error ? cause.message : 'Unable to save grouping.') }
    finally { attempting = false; groupingBusy.current = false }
  }
  const completeSet = (set: ExerciseSet) => {
    if (!viewIsCurrent()) return
    let invoked = false
    let attempting = true
    try {
      const weightKg = readMeasurement(loadDraft(set), 'load')
      const saved = update(current => {
        if (!attempting || invoked) throw new Error('This session changed. Reopen it before editing.')
        assertCurrentState(current); invoked = true
        return setSessionCompletion(current, set.id, !set.completed, weightKg)
      })
      if (saved) { loadEdits.current++; setLoads(previous => ({ ...previous, [set.id]: measurementDraft(weightKg, 'load', unit) })); setError(''); if (!set.completed && state.preferences.soundEnabled) void nativeSuccessFeedback() }
      else setError('Set was not saved. Your load entry is still here; retry when storage is available.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the load before completing this set.') }
    finally { attempting = false }
  }
  const completed = session?.sets.filter(set => set.completed).length ?? 0
  const rest = session?.restUntil ? Math.max(0, Math.ceil((session.restUntil - now) / 1000)) : 0
  return <section>
    <Link className="back-link" to="/workouts"><ArrowLeft />All workouts</Link>
    <header className="page-header"><span>{workout.day} · {workout.difficulty}</span><h1>{workout.title}</h1><p>{workout.description}</p></header>
    <p className="safety-note">General fitness guidance only. Choose a comfortable load and range of motion. Stop if movement causes pain. This app does not diagnose injuries.</p>
    {active && !session && <div className="notice">An unfinished workout is saved: <Link to={`/workouts/${active.workout.id}`}>{active.workout.title}</Link></div>}
    {!session && <PlannedGroupSummary workout={workout} />}
    {!session && error && <p id="workout-start-error" role={persistenceErrorAnnounced ? undefined : 'alert'} className="error-message">{error}</p>}
    {!session ? <button className="primary-button" aria-describedby={error ? 'workout-start-error' : undefined} onClick={start}><Play />Start workout</button> : <>
      <div className="session-bar">
        <div><span>Active training time</span><strong data-testid="session-timer">{formatTime(elapsedSeconds(session, now))}</strong></div>
        <button className="secondary-button" onClick={() => change(current => toggleSession(current))}>{session.runningSince === null ? <><Play />Resume timer</> : <><Pause />Pause timer</>}</button>
        <div><span>Sets completed</span><strong>{completed}/{session.sets.length}</strong></div>
      </div>
      <p className="session-note">Loads save when you leave the field, press Enter, complete a set or finish the workout. Other changes save immediately. Incomplete or failed load edits stay on this page; save them before leaving. Pause the timer during breaks you don’t want included.</p>
      <p id="workout-load-range" className="session-note">Load range: {measurementRange('load', unit)}. Leave blank for bodyweight; 0 records an explicit zero load.</p>
      {session.restUntil !== null && <div className="rest-timer" role="status"><strong>{rest > 0 ? `Rest: ${formatTime(rest)}` : 'Rest complete'}</strong><button className="secondary-button" onClick={() => change(current => ({ ...current, restUntil: null }))}>Dismiss rest timer</button></div>}
    </>}
    {session && <><button type="button" className="secondary-button" disabled={!!replacement || !!addition || !!grouping || workout.exercises.length >= 50 || session.sets.length >= 2500} onClick={openAddition}><Plus />Add exercise to this session</button>
      {workout.exercises.length >= 50 && <p className="session-note">This session has reached the 50-exercise limit. No exercises will be removed to make room.</p>}
      {session.sets.length >= 2500 && <p className="session-note">This session has reached the 2,500-set-row limit. No rows will be truncated.</p>}
    </>}
    {session && <button type="button" className="secondary-button" disabled={!!replacement || !!addition || !!grouping || (session.grouping?.groups.length ?? 0) >= 25} onClick={() => openGrouping()}>Create session group</button>}
    {session && (session.grouping?.groups.length ?? 0) >= 25 && <p className="session-note">This session has reached the 25-group limit.</p>}
    {grouping && <SessionGrouping session={grouping.session} review={grouping.review} removal={grouping.removal} drafts={grouping.drafts} stale={!validGroupingContext(grouping)} error={groupingError}
      onReview={selection => selectGrouping(grouping, selection)} onCancel={() => { if (mounted.current && groupingRef.current === grouping) setGroupingFlow(null) }}
      onBack={() => { if (validGroupingContext(grouping)) setGroupingFlow({ ...grouping, review: null, drafts: {}, draftSnapshot: '', draftGeneration: loadEdits.current }) }}
      onConfirm={() => confirmGrouping(grouping)} />}
    {session?.grouping && <section className="session-groups" aria-label="Saved session groups"><h2>Session groups</h2><p>Complete rows in any order. Round status reflects recorded marks only. Positive round rest starts only when its last unfinished row is newly marked complete; intermediate rows, zero rest and undo keep the current countdown.</p>{session.grouping.groups.map(group => {
      const anyCompleted = group.rounds.some(round => round.setIds.some(setId => session.sets.find(set => set.id === setId)?.completed))
      return <article className="panel" key={group.id} aria-label={`Session group ${group.name}`}><h3>{group.name}</h3><p>{group.rounds[0].setIds.length === 2 ? 'Superset' : 'Circuit'} · {group.restSeconds}s round rest · {group.rounds.length} rounds</p><ol className="group-rounds">{group.rounds.map((round, index) => <li key={round.id}><strong>Round {index + 1}: {round.setIds.every(setId => session.sets.find(set => set.id === setId)?.completed) ? 'All rows marked complete' : 'Unfinished'}</strong><ol>{round.setIds.map(setId => { const set = session.sets.find(item => item.id === setId)!; return <li key={setId}>{groupRowLabel(session, set)} · {set.completed ? 'Marked complete' : 'Unfinished'}</li> })}</ol></li>)}</ol><button type="button" className="secondary-button" disabled={anyCompleted || !!replacement || !!addition || !!grouping} onClick={() => openGrouping(group.id)}>Review removal of {group.name}</button><p className="session-note">{anyCompleted ? 'Grouping cannot be removed while any member is currently marked complete. Undo members individually if you choose to remove grouping.' : 'Removal changes grouping metadata only. Existing rows and values remain.'} Saved membership, order, name and rest cannot be edited here.</p></article>
    })}</section>}
    {addition && <SessionAddition state={state} workouts={state.workouts} review={addition.review} stale={!validAdditionContext(addition)} error={additionError} exerciseCount={addition.session.workout.exercises.length} rowCount={addition.session.sets.length}
      onReview={(exercise, libraryCopy) => selectAddition(addition, exercise, libraryCopy)} onCancel={() => { if (mounted.current && additionRef.current === addition) setAdditionFlow(null) }}
      onBack={() => { if (validAdditionContext(addition)) setAdditionFlow({ ...addition, review: null, draftSnapshot: '', draftGeneration: loadEdits.current }) }}
      onConfirm={() => confirmAddition(addition)} />}
    {replacement && <SessionReplacement state={state} session={replacement.session} workouts={state.workouts} sourceName={replacement.sourceName} review={replacement.review} drafts={replacement.drafts} stale={!validContext(replacement)} error={replacementError}
      onSelect={(exercise, libraryCopy) => selectReplacement(replacement, exercise, libraryCopy)} onCancel={() => { if (mounted.current && flowRef.current === replacement) setFlow(null) }}
      onBack={() => { if (validContext(replacement)) setFlow({ ...replacement, review: null, drafts: {}, draftSnapshot: '', draftGeneration: loadEdits.current }) }}
      onConfirm={() => confirmReplacement(replacement)} />}
    <div className="exercise-list">{workout.exercises.map((exercise, exerciseIndex) => {
      const sets = session?.sets.filter(set => set.exerciseId === exercise.id) ?? []
      const timed = /sec/i.test(exercise.reps)
      const duplicateName = workout.exercises.filter(item => item.name === exercise.name).length > 1
      const exerciseLabel = duplicateName ? `${exercise.name} (exercise ${exerciseIndex + 1})` : exercise.name
      return <article className="exercise-panel panel" key={exercise.id} aria-label={exerciseLabel}>
        <header><div><h2>{exercise.name}</h2>{duplicateName && <small>Session exercise {exerciseIndex + 1}</small>}<p>{exercise.category} · {exercise.sets} planned × {exercise.reps} · {exercise.restSeconds}s rest{session && ` · ${sets.length} session sets`}</p></div></header>
        <LibraryOrigin origin={exercise.libraryOrigin} />
        {exercise.notes && <p className="exercise-guidance">{exercise.notes}</p>}
        {session && <><div className="sets-list">{sets.map(set => {
          const last = previousSet(state.logs, exercise.id, set.setNumber)
          const group = session.grouping?.groups.find(item => item.rounds.some(round => round.setIds.includes(set.id)))
          const roundIndex = group?.rounds.findIndex(round => round.setIds.includes(set.id)) ?? -1
          const duplicateNumber = sets.filter(item => item.setNumber === set.setNumber).length > 1
          const setLabel = `${exerciseLabel} set ${set.setNumber}${duplicateNumber ? ` (source row ${session.sets.findIndex(item => item.id === set.id) + 1})` : ''}`
          return <div className={set.completed ? 'set-row set-complete' : 'set-row'} key={set.id}>
            <small className="group-membership">{group ? `${group.name} · round ${roundIndex + 1} · ${set.completed ? 'Marked complete' : 'Unfinished'}. Grouped rows cannot be removed or marked as warm-ups; first review removal of grouping when no member is complete.` : 'Outside session groups'}</small>
            <span className="set-number">Set {set.setNumber}{duplicateNumber && <small>Source row {session.sets.findIndex(item => item.id === set.id) + 1}</small>}</span>
            <label>{timed ? 'Seconds' : 'Reps'}<input aria-label={`${setLabel} ${timed ? 'seconds' : 'reps'}`} type="number" min="0" max={timed ? '86400' : '999'} step="1" value={(timed ? set.seconds : set.reps) ?? ''} onChange={event => {
              const value = event.target.value === '' ? null : Number(event.target.value)
              if (value === null || Number.isInteger(value) && value >= 0 && value <= (timed ? 86400 : 999)) changeSet(set.id, { [timed ? 'seconds' : 'reps']: value, completed: false })
            }} /></label>
            <label>Weight ({measurementUnit('load', loadDraft(set).unit)})<input aria-label={`${setLabel} weight`} type="text" inputMode="decimal" autoComplete="off" maxLength={40} placeholder="Bodyweight" value={loadDraft(set).text} aria-describedby={`load-range-${set.id}`} onChange={event => {
              if (!viewIsCurrent()) return
              const text = event.target.value
              loadEdits.current += 1
              setLoads(previous => ({ ...previous, [set.id]: { ...loadDraft(set), text } }))
            }} onBlur={() => saveLoad(set)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveLoad(set) } }} /><small id={`load-range-${set.id}`}>Load in {measurementUnit('load', loadDraft(set).unit)}; {measurementRange('load', loadDraft(set).unit)}. Blank means bodyweight.</small>{loadDraft(set).unit !== unit && <small>Finish this entry in {measurementUnit('load', loadDraft(set).unit)}; then it will display in {measurementUnit('load', unit)}.</small>}</label>
            <label>RPE (optional)<input aria-label={`${setLabel} RPE`} type="number" min="1" max="10" step="0.5" value={set.rpe ?? ''} onChange={event => {
              const value = event.target.value === '' ? null : Number(event.target.value)
              if (value === null || value >= 1 && value <= 10) changeSet(set.id, { rpe: value })
            }} /></label>
            <label className="warmup-label"><input type="checkbox" aria-label={`${setLabel} warm-up`} checked={set.warmup} disabled={!!group} onChange={event => { if (!viewIsCurrent() || isGrouped(session, set.id)) return; changeSet(set.id, { warmup: event.target.checked }) }} />Warm-up</label>
            <button className={set.completed ? 'secondary-button' : 'primary-button'} aria-label={`${set.completed ? 'Undo' : 'Complete'} ${setLabel}`} disabled={!set.completed && (timed ? set.seconds === null || set.seconds <= 0 : set.reps === null || set.reps <= 0)} onClick={() => completeSet(set)}>{set.completed ? 'Done' : 'Complete'}</button>
            <button className="icon-button danger" aria-label={`Remove ${setLabel}`} disabled={!!group || sets.length <= 1} onClick={() => {
              if (!viewIsCurrent() || isGrouped(session, set.id)) return
              if (set.completed && !window.confirm('Remove this completed set from the unfinished session?')) return
              change(current => { if (isGrouped(current, set.id)) throw new Error('Remove grouping before removing this row.'); return { ...current, sets: current.sets.filter(item => item.id !== set.id) } })
            }}><Trash2 /></button>
            {last && <small className="previous-set">Last: {last.reps ?? last.seconds ?? '—'}{last.seconds !== null ? ' sec' : ' reps'} · {last.weightKg === null ? 'Bodyweight' : `${formatMeasurement(last.weightKg, 'load', unit)} ${measurementUnit('load', unit)}`} </small>}
          </div>
        })}</div><button type="button" className="secondary-button" disabled={!sets.some(set => !set.completed) || !!replacement || !!addition || !!grouping} onClick={() => openReplacement(exercise, exerciseLabel)}>Replace unfinished {exerciseLabel} sets</button><button className="secondary-button" disabled={sets.length >= 50 || session.sets.length >= 2500 || Math.max(...sets.map(set => set.setNumber)) >= 50} onClick={() => change(current => ({ ...current, sets: [...current.sets, { id: uid(), exerciseId: exercise.id, setNumber: Math.max(0, ...sets.map(set => set.setNumber)) + 1, reps: null, seconds: null, weightKg: null, rpe: null, warmup: false, completed: false }] }))}><Plus />Add set</button></>}
      </article>
    })}</div>
    {session && <><label className="notes-field">Session notes<textarea placeholder="How did this session feel?" value={session.notes} onChange={event => change(current => ({ ...current, notes: event.target.value }))} maxLength={2000} /></label>
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="session-actions"><button className="primary-button" disabled={completed === 0} onClick={finish}><CheckCircle2 />Finish and save workout</button>
        <button className="secondary-button danger" onClick={() => { if (!viewIsCurrent()) return; if (window.confirm('Discard this unfinished session? Saved workout history will be kept.')) { setAdditionFlow(null); setGroupingFlow(null); update(current => { assertCurrentState(current); return { ...current, activeSession: null } }, 'Unfinished session discarded') } }}><RotateCcw />Discard session</button></div>
    </>}
  </section>
}
