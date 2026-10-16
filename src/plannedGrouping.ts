import { uid } from './session'
import { freshIdentityFactory, type IdentityOptions } from './identities'
import { validPlannedGrouping } from './plannedGroupingValidation'
import { denseArray } from './sessionGroupingValidation'
import type { Exercise, PlannedGroup, PlannedGroupMember, Workout } from './types'

export type PlannedGroupingSelection = { name: string; restSeconds: number; rounds: PlannedGroupMember[][] }
export type PlannedGroupingReviewRow = Readonly<{ member: Readonly<PlannedGroupMember>; exercise: Readonly<Exercise> }>
export type PlannedGroupingReviewRound = Readonly<{ members: readonly Readonly<PlannedGroupMember>[]; rows: readonly PlannedGroupingReviewRow[] }>
export type PlannedGroupingReview = Readonly<{ name: string; restSeconds: number; rounds: readonly PlannedGroupingReviewRound[]; remainingUngroupedSetCount: number }>
export type FrozenPlannedGroup = Readonly<Omit<PlannedGroup, 'rounds'> & { rounds: readonly Readonly<{ id: string; members: readonly Readonly<PlannedGroupMember>[] }>[] }>
export type PlannedGroupRemovalReview = Readonly<{ group: FrozenPlannedGroup; rounds: readonly PlannedGroupingReviewRound[] }>
const sources = new WeakMap<object, { workout: Workout; snapshot: string }>()
const stale = () => new Error('This plan draft changed. Cancel and review the grouping again.')
const invalid = () => new Error('Choose a name of 1–80 characters, 0–900 seconds of rest and 1–20 exact rounds with the same 2–6 distinct movements in the same order. Use each existing ungrouped planned set only once.')
function assertMetadata(workout: Workout, allowIncompleteSets = false): void {
  if (Object.hasOwn(workout, 'plannedGrouping') && !validPlannedGrouping(workout.plannedGrouping, workout, { allowIncompleteSets })) throw new Error('The planned grouping contains invalid or missing references. Review or remove the affected group first.')
}
function freezeExercise(exercise: Exercise): Readonly<Exercise> {
  const copy = structuredClone(exercise)
  if (copy.equipment !== undefined) Object.freeze(copy.equipment)
  return Object.freeze(copy)
}
function snapshotRounds(workout: Workout, rounds: readonly { members: readonly PlannedGroupMember[] }[]): readonly PlannedGroupingReviewRound[] {
  return Object.freeze(rounds.map(round => Object.freeze({
    members: Object.freeze(round.members.map(member => Object.freeze({ ...member }))),
    rows: Object.freeze(round.members.map(member => Object.freeze({ member: Object.freeze({ ...member }), exercise: freezeExercise(workout.exercises.find(exercise => exercise.id === member.exerciseId)!) }))),
  })))
}
function bind<T extends object>(review: T, workout: Workout): T {
  sources.set(review, { workout, snapshot: JSON.stringify(workout) }); return review
}
function currentWorkout(workout: Workout, review: object): void {
  const source = sources.get(review)
  if (!source || source.workout !== workout || source.snapshot !== JSON.stringify(workout)) throw stale()
}
export function reviewPlannedGrouping(workout: Workout, selection: PlannedGroupingSelection): PlannedGroupingReview {
  assertMetadata(workout)
  if (!selection || typeof selection !== 'object' || Object.keys(selection).length !== 3 || !['name', 'restSeconds', 'rounds'].every(key => Object.hasOwn(selection, key)) || typeof selection.name !== 'string' || !selection.name.trim() || selection.name.length > 80 || !denseArray(selection.rounds, 1, 20)) throw invalid()
  let sequence = 0
  const freshId = freshIdentityFactory(workout, () => `planned-review-${++sequence}`)
  const group = { id: freshId(), name: selection.name.trim(), restSeconds: selection.restSeconds, rounds: selection.rounds.map(members => ({ id: freshId(), members })) }
  const groups = [...workout.plannedGrouping?.groups ?? [], group]
  if (!validPlannedGrouping({ version: 1, groups }, workout)) throw invalid()
  const used = groups.reduce((count, group) => count + group.rounds.reduce((count, round) => count + round.members.length, 0), 0)
  return bind(Object.freeze({ name: group.name, restSeconds: group.restSeconds, rounds: snapshotRounds(workout, group.rounds), remainingUngroupedSetCount: workout.exercises.reduce((count, exercise) => count + (Number.isInteger(exercise.sets) && exercise.sets > 0 && exercise.sets <= 20 ? exercise.sets : 0), 0) - used }), workout)
}
/** Pure candidate construction; callers persist only after their guarded transaction succeeds. */
export function applyPlannedGrouping(workout: Workout, review: PlannedGroupingReview, options: IdentityOptions = {}): Workout {
  currentWorkout(workout, review)
  reviewPlannedGrouping(workout, { name: review.name, restSeconds: review.restSeconds, rounds: review.rounds.map(round => round.members.map(member => ({ ...member }))) })
  const freshId = freshIdentityFactory([workout, options.reserved], options.makeId ?? uid)
  const group: PlannedGroup = { id: freshId(), name: review.name, restSeconds: review.restSeconds, rounds: review.rounds.map(round => ({ id: freshId(), members: round.members.map(member => ({ ...member })) })) }
  const next: Workout = structuredClone({ ...workout, plannedGrouping: { version: 1, groups: [...workout.plannedGrouping?.groups ?? [], group] } })
  assertMetadata(next)
  return next
}
export function reviewPlannedGroupRemoval(workout: Workout, groupId: string): PlannedGroupRemovalReview {
  assertMetadata(workout, true)
  const group = workout.plannedGrouping?.groups.find(group => group.id === groupId)
  if (!group) throw stale()
  const copy = structuredClone(group)
  for (const round of copy.rounds) { round.members.forEach(Object.freeze); Object.freeze(round.members); Object.freeze(round) }
  Object.freeze(copy.rounds); Object.freeze(copy)
  return bind(Object.freeze({ group: copy, rounds: snapshotRounds(workout, group.rounds) }), workout)
}
export function applyPlannedGroupRemoval(workout: Workout, review: PlannedGroupRemovalReview): Workout {
  currentWorkout(workout, review)
  reviewPlannedGroupRemoval(workout, review.group.id)
  const next = structuredClone(workout)
  const groups = next.plannedGrouping!.groups.filter(group => group.id !== review.group.id)
  if (groups.length) next.plannedGrouping = { version: 1, groups }
  else delete next.plannedGrouping
  return next
}
/** Form edits may be incomplete, but must never silently delete referenced planned slots. */
export function assertPlannedGroupingEdit(previous: Workout, next: Workout): void {
  assertMetadata(previous, true)
  for (const group of next.plannedGrouping?.groups ?? []) for (const round of group.rounds) for (const member of round.members) {
    const exercise = next.exercises.find(exercise => exercise.id === member.exerciseId)
    const before = previous.exercises.find(exercise => exercise.id === member.exerciseId)
    if (!exercise || exercise.sets !== before?.sets && (!Number.isInteger(exercise.sets) || exercise.sets < member.setNumber || exercise.sets > 20)) throw new Error(`Remove the planned group “${group.name}” first before deleting its exercise or reducing its referenced sets.`)
  }
  assertMetadata(next, true)
}
