/** The grouping schema is shared by local persistence, backups and the server. */
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const id = (value: unknown): value is string => typeof value === 'string' && value.length <= 150 && value.trim().length > 0
export const denseArray = (value: unknown, min: number, max: number): value is unknown[] => Array.isArray(value) && value.length >= min && value.length <= max && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)

type GroupingOwner = { id: string; workoutId: string; sets: { id: string; exerciseId: string; warmup: boolean }[]; exerciseIds: string[]; identityReferences?: string[] }
export function validSessionGrouping(value: unknown, owner: GroupingOwner): boolean {
  if (!object(value) || !exact(value, ['version', 'groups']) || value.version !== 1 || !denseArray(value.groups, 1, 25)) return false
  const identities = new Set([owner.id, owner.workoutId, ...owner.exerciseIds, ...owner.identityReferences ?? [], ...owner.sets.flatMap(set => [set.id, set.exerciseId])])
  const exercises = new Set(owner.exerciseIds)
  const rows = new Map(owner.sets.map(set => [set.id, set]))
  const references = new Set<string>()
  const addIdentity = (value: unknown) => {
    if (!id(value) || identities.has(value)) return false
    identities.add(value)
    return true
  }
  for (const group of value.groups) {
    if (!object(group) || !exact(group, ['id', 'name', 'restSeconds', 'rounds']) || !addIdentity(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 || !Number.isInteger(group.restSeconds) || (group.restSeconds as number) < 0 || (group.restSeconds as number) > 900 || !denseArray(group.rounds, 1, 50)) return false
    let width: number | undefined
    for (const round of group.rounds) {
      if (!object(round) || !exact(round, ['id', 'setIds']) || !addIdentity(round.id) || !denseArray(round.setIds, 2, 6) || width !== undefined && round.setIds.length !== width) return false
      width = round.setIds.length
      const roundExercises = new Set<string>()
      for (const setId of round.setIds) {
        if (!id(setId) || references.has(setId)) return false
        const row = rows.get(setId)
        if (!row || row.warmup || !exercises.has(row.exerciseId) || roundExercises.has(row.exerciseId)) return false
        references.add(setId); roundExercises.add(row.exerciseId)
        if (references.size > 2500) return false
      }
    }
  }
  return true
}

/** v2 used to discard activeSession: never discard newly supplied grouping that way. */
export function containsGrouping(value: unknown): boolean {
  const pending = [value]
  const seen = new WeakSet<object>()
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if (Object.hasOwn(item, 'grouping')) return true
    pending.push(...Object.values(item))
  }
  return false
}
