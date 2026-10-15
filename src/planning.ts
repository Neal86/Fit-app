import { uid } from './session'
import type { AppState, Workout } from './types'

export const PLAN_HISTORY_LIMIT = 20
export const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
export type ScheduleChoice = { day: string; workoutId: string }
export function savePlanRevision(state: AppState, workouts: Workout[], label: string, now = new Date()): AppState {
  if (JSON.stringify(state.workouts) === JSON.stringify(workouts)) return state
  return { ...state, workouts: structuredClone(workouts), planHistory: [{ id: uid(), savedAt: now.toISOString(), label: label.slice(0, 150), workouts: structuredClone(state.workouts) }, ...(state.planHistory ?? [])].slice(0, PLAN_HISTORY_LIMIT) }
}
export function restorePlanRevision(state: AppState, revisionId: string): AppState {
  const revision = state.planHistory?.find(item => item.id === revisionId)
  if (!revision) throw new Error('That plan version is no longer available. Refresh the list and choose another.')
  return savePlanRevision(state, revision.workouts, 'Before restoring a previous plan')
}
export function schedulePreview(workouts: Workout[], choices: ScheduleChoice[], maximumMinutes: number): Workout[] {
  if (!Number.isInteger(maximumMinutes) || maximumMinutes < 1 || maximumMinutes > 600) throw new Error('Choose a session time limit from 1 to 600 minutes.')
  if (!choices.length || choices.length > 7 || new Set(choices.map(choice => choice.day)).size !== choices.length) throw new Error('Choose one to seven distinct training days.')
  return choices.map(choice => {
    if (!(weekdays as readonly string[]).includes(choice.day)) throw new Error('Choose a valid training day.')
    const workout = workouts.find(item => item.id === choice.workoutId)
    if (!workout) throw new Error('A selected workout is no longer available.')
    if (workout.duration > maximumMinutes) throw new Error(`${workout.title} exceeds your session time limit. Edit it or choose a shorter session.`)
    // Preserve identity on the first occurrence, use new identities when copying a template to another day.
    const duplicate = choices.findIndex(item => item.workoutId === choice.workoutId) !== choices.indexOf(choice)
    return { ...structuredClone(workout), day: choice.day, ...(duplicate ? { id: uid(), exercises: workout.exercises.map(exercise => ({ ...exercise, id: uid() })) } : {}) }
  }).sort((a, b) => (weekdays as readonly string[]).indexOf(a.day) - (weekdays as readonly string[]).indexOf(b.day))
}
