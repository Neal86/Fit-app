import type { ActiveSession, ExerciseSet, WorkoutLog } from '../types'

/** Ordinals describe this exact owner snapshot; the row IDs, never labels, drive changes. */
export function groupRowLabel(owner: ActiveSession | WorkoutLog, set: ExerciseSet): string {
  const exercises = 'workout' in owner ? owner.workout.exercises : owner.exerciseSnapshots ?? []
  const exercise = exercises.find(item => item.id === set.exerciseId)
  const duplicate = exercises.filter(item => item.name === exercise?.name).length > 1
  const name = exercise ? `${exercise.name}${duplicate ? ` (exercise ${exercises.indexOf(exercise) + 1})` : ''}` : 'Recorded movement unavailable'
  return `${name} · set ${set.setNumber} · source row ${(owner.sets ?? []).findIndex(row => row.id === set.id) + 1}`
}
