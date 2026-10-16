import type { Workout } from '../types'

type Member = { exerciseId: string; setNumber: number }
export function plannedRowLabel(workout: Workout, member: Member) {
  const index = workout.exercises.findIndex(exercise => exercise.id === member.exerciseId)
  const exercise = workout.exercises[index]
  return `${exercise?.name || 'Unnamed movement'} (exercise ${index + 1}) · planned set ${member.setNumber}`
}

export function plannedSlots(workout: Workout): Member[] {
  return workout.exercises.flatMap(exercise => Array.from({ length: Number.isInteger(exercise.sets) && exercise.sets > 0 && exercise.sets <= 20 ? exercise.sets : 0 }, (_, index) => ({ exerciseId: exercise.id, setNumber: index + 1 })))
}
export const plannedSlotKey = (member: Member) => JSON.stringify([member.exerciseId, member.setNumber])
export const plannedCompatibility = 'Saved groups travel in plan history, backups and manual cloud copies. Older strict builds or APIs may reject them. Keep a pre-feature backup for a deliberate rollback and preserve your newer full backup; restoring an older backup omits later changes. Groups are never automatically flattened or removed.'
export const plannedRest = 'Complete session rows in any order. A round reflects recorded completion marks only. Newly completing its last unfinished row starts or replaces a positive chosen round rest. Intermediate completions, zero rest and undo keep the current countdown. Reloading does not restart it.'

