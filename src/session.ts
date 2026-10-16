import { parseState, validWorkout } from './stateValidation'
import { freshIdentityFactory, type IdentityOptions } from './identities'
import type { ActiveSession, AppState, ExerciseSet, Workout, WorkoutLog } from './types'

export const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
export const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
export const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
export function elapsedSeconds(session: ActiveSession, now = Date.now()): number {
  return Math.max(0, session.elapsedSeconds + (session.runningSince === null ? 0 : Math.max(0, now - session.runningSince) / 1000))
}
export function startSession(workout: Workout, now = Date.now(), options: IdentityOptions = {}): ActiveSession {
  if (!validWorkout(workout)) throw new Error('The workout plan contains invalid fields or grouping. Review the saved plan before starting.')
  if (!Number.isFinite(now) || now < 0 || now > 8640000000000000) throw new Error('The session start time is invalid.')
  const startedAt = new Date(now).toISOString()
  if (!/^\d{4}-/.test(startedAt)) throw new Error('The session start time is invalid.')
  const freshId = freshIdentityFactory([workout, options.reserved], options.makeId ?? uid)
  const snapshot = structuredClone(workout)
  delete snapshot.plannedGrouping
  const session: ActiveSession = {
    id: freshId(), workout: snapshot, startedAt, elapsedSeconds: 0,
    runningSince: now, notes: '', restUntil: null,
    sets: workout.exercises.flatMap(exercise => Array.from({ length: exercise.sets }, (_, index) => ({
      id: freshId(), exerciseId: exercise.id, setNumber: index + 1, reps: null, weightKg: null,
      seconds: null, rpe: null, warmup: false, completed: false,
    }))),
  }
  if (workout.plannedGrouping) session.grouping = { version: 1, groups: workout.plannedGrouping.groups.map(group => ({
    id: freshId(), name: group.name, restSeconds: group.restSeconds,
    rounds: group.rounds.map(round => ({ id: freshId(), setIds: round.members.map(member => session.sets.find(set => set.exerciseId === member.exerciseId && set.setNumber === member.setNumber)!.id) })),
  })) }
  return session
}
export function toggleSession(session: ActiveSession, now = Date.now()): ActiveSession {
  return { ...session, elapsedSeconds: elapsedSeconds(session, now), runningSince: session.runningSince === null ? now : null }
}
export function finishSession(session: ActiveSession, now = Date.now()): WorkoutLog {
  if (!session.sets.some(set => set.completed)) throw new Error('Complete at least one set before saving.')
  const seconds = Math.floor(elapsedSeconds(session, now))
  return {
    id: session.id, workoutId: session.workout.id, title: session.workout.title, startedAt: session.startedAt,
    completedAt: new Date(now).toISOString(), duration: Math.round(seconds / 60 * 100) / 100,
    durationSeconds: seconds, calories: Math.round(session.workout.calories * seconds / (session.workout.duration * 60)),
    completedExerciseIds: session.workout.exercises.filter(exercise => {
      const sets = session.sets.filter(set => set.exerciseId === exercise.id)
      return sets.length > 0 && sets.every(set => set.completed)
    }).map(exercise => exercise.id),
    sets: structuredClone(session.sets), notes: session.notes,
    ...(session.grouping === undefined ? {} : { grouping: structuredClone(session.grouping) }),
    exerciseSnapshots: session.workout.exercises.map(({ id, name, category, libraryOrigin }) => ({ id, name, category, ...(libraryOrigin === undefined ? {} : { libraryOrigin: structuredClone(libraryOrigin) }) })),
  }
}
export function previousSet(logs: WorkoutLog[], exerciseId: string, setNumber: number): ExerciseSet | undefined {
  // Backups may contain history in a different order; references follow actual completion time.
  let latest: ExerciseSet | undefined
  let latestAt = -Infinity
  for (const log of logs) {
    const at = Date.parse(log.completedAt)
    const matching = log.sets?.find(set => set.exerciseId === exerciseId && set.setNumber === setNumber && set.completed)
    if (matching && at > latestAt) { latest = matching; latestAt = at }
  }
  return latest
}
export function weekStart(now = new Date()): number {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  return start.getTime()
}

/** Desired-state completion is safe to retry and never derives timer events on hydration. */
export function setSessionCompletion(state: AppState, setId: string, completed: boolean, weightKg: number | null, now = Date.now()): AppState {
  parseState(state)
  const session = state.activeSession
  const row = session?.sets.find(set => set.id === setId)
  if (!session || !row || typeof completed !== 'boolean') throw new Error('This session changed. Review the set again.')
  if (row.completed === completed) return state
  if (weightKg !== null && (typeof weightKg !== 'number' || !Number.isFinite(weightKg) || weightKg < 0 || weightKg > 1000)) throw new Error('Load must be blank or between 0 and 1000 kg.')
  const exercise = session.workout.exercises.find(exercise => exercise.id === row.exerciseId)!
  if (completed && !((/sec/i.test(exercise.reps) ? row.seconds : row.reps) ?? 0)) throw new Error('Enter positive seconds or reps before completing this set.')
  let restUntil = session.restUntil
  if (completed) {
    const group = session.grouping?.groups.find(group => group.rounds.some(round => round.setIds.includes(setId)))
    const round = group?.rounds.find(round => round.setIds.includes(setId))
    const startsRest = !group || group.restSeconds > 0 && round!.setIds.every(id => id === setId || session.sets.find(set => set.id === id)!.completed)
    if (startsRest) {
      const seconds = group?.restSeconds ?? exercise.restSeconds
      if (!Number.isFinite(now) || now < 0 || now + seconds * 1000 > 8640000000000000) throw new Error('The rest start time is invalid.')
      restUntil = now + seconds * 1000
    }
  }
  const next: AppState = { ...state, activeSession: structuredClone({ ...session, restUntil, sets: session.sets.map(set => set.id === setId ? { ...set, completed, weightKg } : set) }) }
  parseState(next)
  return next
}
