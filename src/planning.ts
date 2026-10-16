import { uid } from './session'
import { freshIdentityFactory, type IdentityOptions } from './identities'
import { parseState, validWorkout } from './stateValidation'
import { assertPlannedGroupingEdit } from './plannedGrouping'
import type { AppState, Workout } from './types'

export const PLAN_HISTORY_LIMIT = 20
export const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
export type ScheduleChoice = { day: string; workoutId: string }
export function savePlanRevision(state: AppState, workouts: Workout[], label: string, now = new Date(), options: IdentityOptions = {}): AppState {
  parseState(state)
  parseState({ ...state, workouts })
  if (JSON.stringify(state.workouts) === JSON.stringify(workouts)) return state
  const freshId = freshIdentityFactory([state, workouts, options.reserved], options.makeId ?? uid)
  const next = { ...state, workouts: structuredClone(workouts), planHistory: [{ id: freshId(), savedAt: now.toISOString(), label: label.slice(0, 150), workouts: structuredClone(state.workouts) }, ...(state.planHistory ?? [])].slice(0, PLAN_HISTORY_LIMIT) }
  parseState(next)
  return next
}
export function restorePlanRevision(state: AppState, revisionId: string): AppState {
  const revision = state.planHistory?.find(item => item.id === revisionId)
  if (!revision) throw new Error('That plan version is no longer available. Refresh the list and choose another.')
  return savePlanRevision(state, revision.workouts, 'Before restoring a previous plan')
}
function requireWorkout(workout: Workout): void {
  if (!validWorkout(workout)) throw new Error('The workout plan contains invalid fields or grouping. Review or remove the affected group before saving.')
}
function remapExercises(workout: Workout, mapping: Map<string, string>): void {
  for (const exercise of workout.exercises) exercise.id = mapping.get(exercise.id) ?? exercise.id
  for (const group of workout.plannedGrouping?.groups ?? []) for (const round of group.rounds) for (const member of round.members) member.exerciseId = mapping.get(member.exerciseId) ?? member.exerciseId
}
/** Renaming a movement creates a new identity and atomically updates its planned slots. */
export function prepareWorkoutForSave(draft: Workout, previous?: Workout, options: IdentityOptions = {}): Workout {
  if (previous) assertPlannedGroupingEdit(previous, draft)
  requireWorkout(draft)
  const freshId = freshIdentityFactory([draft, previous, options.reserved], options.makeId ?? uid)
  const mapping = new Map<string, string>()
  for (const exercise of draft.exercises) if (previous?.exercises.some(old => old.id === exercise.id && old.name !== exercise.name)) mapping.set(exercise.id, freshId())
  const next = structuredClone(draft)
  remapExercises(next, mapping)
  requireWorkout(next)
  return next
}
/** Copies have independent workout, movement, group and round identities. */
export function copyWorkout(workout: Workout, options: IdentityOptions = {}): Workout {
  requireWorkout(workout)
  const freshId = freshIdentityFactory([workout, options.reserved], options.makeId ?? uid)
  const next = structuredClone(workout)
  next.id = freshId()
  remapExercises(next, new Map(next.exercises.map(exercise => [exercise.id, freshId()])))
  for (const group of next.plannedGrouping?.groups ?? []) {
    group.id = freshId()
    for (const round of group.rounds) round.id = freshId()
  }
  requireWorkout(next)
  return next
}
export function schedulePreview(workouts: Workout[], choices: ScheduleChoice[], maximumMinutes: number, options: IdentityOptions = {}): Workout[] {
  if (!Number.isInteger(maximumMinutes) || maximumMinutes < 1 || maximumMinutes > 600) throw new Error('Choose a session time limit from 1 to 600 minutes.')
  if (!choices.length || choices.length > 7 || new Set(choices.map(choice => choice.day)).size !== choices.length) throw new Error('Choose one to seven distinct training days.')
  const freshId = freshIdentityFactory([workouts, options.reserved], options.makeId ?? uid)
  return choices.map((choice, index) => {
    if (!(weekdays as readonly string[]).includes(choice.day)) throw new Error('Choose a valid training day.')
    const workout = workouts.find(item => item.id === choice.workoutId)
    if (!workout) throw new Error('A selected workout is no longer available.')
    requireWorkout(workout)
    if (workout.duration > maximumMinutes) throw new Error(`${workout.title} exceeds your session time limit. Edit it or choose a shorter session.`)
    // Preserve identity on the first occurrence, use new identities when copying a template to another day.
    const duplicate = choices.findIndex(item => item.workoutId === choice.workoutId) !== index
    const snapshot = duplicate ? copyWorkout(workout, { reserved: [workouts, options.reserved], makeId: freshId }) : structuredClone(workout)
    return { ...snapshot, day: choice.day }
  }).sort((a, b) => (weekdays as readonly string[]).indexOf(a.day) - (weekdays as readonly string[]).indexOf(b.day))
}
