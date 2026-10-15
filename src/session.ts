import type { ActiveSession, ExerciseSet, Workout, WorkoutLog } from './types'

export const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
export const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
export const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
export function elapsedSeconds(session: ActiveSession, now = Date.now()): number {
  return Math.max(0, session.elapsedSeconds + (session.runningSince === null ? 0 : Math.max(0, now - session.runningSince) / 1000))
}
export function startSession(workout: Workout, now = Date.now()): ActiveSession {
  return {
    id: uid(), workout: structuredClone(workout), startedAt: new Date(now).toISOString(), elapsedSeconds: 0,
    runningSince: now, notes: '', restUntil: null,
    sets: workout.exercises.flatMap(exercise => Array.from({ length: exercise.sets }, (_, index) => ({
      id: uid(), exerciseId: exercise.id, setNumber: index + 1, reps: null, weightKg: null,
      seconds: null, rpe: null, warmup: false, completed: false,
    }))),
  }
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
    exerciseSnapshots: session.workout.exercises.map(({ id, name, category }) => ({ id, name, category })),
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
