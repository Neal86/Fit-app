import { denseArray } from './sessionGroupingValidation.js'
import type { Workout } from './types.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const id = (value: unknown): value is string => typeof value === 'string' && value.length <= 150 && value.trim().length > 0
export type PlannedGroupingOwner = { id: string; exercises: { id: string; sets: number }[] }

/** Draft recovery checks metadata independently of incomplete numeric form values. */
export function validPlannedGrouping(value: unknown, owner: PlannedGroupingOwner, options: { allowIncompleteSets?: boolean } = {}): boolean {
  if (!object(value) || !exact(value, ['version', 'groups']) || value.version !== 1 || !denseArray(value.groups, 1, 25) || !id(owner.id) || !denseArray(owner.exercises, 1, 50)) return false
  const identities = new Set<string>([owner.id])
  const exercises = new Map<string, { id: string; sets: number }>()
  for (const exercise of owner.exercises) {
    if (!object(exercise) || !id(exercise.id) || exercises.has(exercise.id)) return false
    identities.add(exercise.id); exercises.set(exercise.id, exercise)
  }
  const addIdentity = (value: unknown) => {
    if (!id(value) || identities.has(value)) return false
    identities.add(value); return true
  }
  const references = new Map<string, Set<number>>()
  for (const group of value.groups) {
    if (!object(group) || !exact(group, ['id', 'name', 'restSeconds', 'rounds']) || !addIdentity(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 || !Number.isInteger(group.restSeconds) || (group.restSeconds as number) < 0 || (group.restSeconds as number) > 900 || !denseArray(group.rounds, 1, 20)) return false
    let movementOrder: string[] | undefined
    for (const round of group.rounds) {
      if (!object(round) || !exact(round, ['id', 'members']) || !addIdentity(round.id) || !denseArray(round.members, 2, 6)) return false
      const movements: string[] = []
      for (const member of round.members) {
        if (!object(member) || !exact(member, ['exerciseId', 'setNumber']) || !id(member.exerciseId) || !Number.isInteger(member.setNumber) || (member.setNumber as number) < 1 || (member.setNumber as number) > 20) return false
        const exercise = exercises.get(member.exerciseId)
        if (!exercise || !options.allowIncompleteSets && (!Number.isInteger(exercise.sets) || exercise.sets < 1 || exercise.sets > 20 || (member.setNumber as number) > exercise.sets)) return false
        const slots = references.get(member.exerciseId) ?? new Set<number>()
        if (slots.has(member.setNumber as number)) return false
        slots.add(member.setNumber as number); references.set(member.exerciseId, slots)
        movements.push(member.exerciseId)
      }
      if (new Set(movements).size !== movements.length || movementOrder && (movementOrder.length !== movements.length || movements.some((movement, index) => movementOrder![index] !== movement))) return false
      movementOrder = movements
    }
  }
  return true
}

/** Plan snapshots are separate identity domains; members always resolve in their own workout. */
export function validPlannedGroupingCollection(workouts: Workout[]): boolean {
  const identities = new Set(workouts.flatMap(workout => [workout.id, ...workout.exercises.map(exercise => exercise.id)]))
  for (const workout of workouts) for (const group of workout.plannedGrouping?.groups ?? []) {
    for (const identity of [group.id, ...group.rounds.map(round => round.id)]) {
      if (identities.has(identity)) return false
      identities.add(identity)
    }
  }
  return true
}

/** Check before migration, including data an older migration would otherwise discard. */
export function containsPlannedGrouping(value: unknown): boolean {
  const pending = [value]
  const seen = new WeakSet<object>()
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if (Object.hasOwn(item, 'plannedGrouping')) return true
    pending.push(...Object.values(item))
  }
  return false
}
