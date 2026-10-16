import { EQUIPMENT_OPTIONS, isEquipmentList } from './equipment.js'
import type { ExerciseLibrary, LibraryContent, LibraryOrigin } from './types.js'

export const LIBRARY_ENTRY_LIMIT = 500
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fields = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && 'value' in Object.getOwnPropertyDescriptor(value, key)!)
const text = (value: unknown, max: number, min = 0): value is string => typeof value === 'string' && value.length <= max && value.trim().length >= min
const id = (value: unknown): value is string => text(value, 150, 1)
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const dense = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

export function validLibraryContent(value: unknown): value is LibraryContent {
  return object(value) && fields(value, ['name', 'sets', 'reps', 'restSeconds', 'category'], ['notes', 'equipment']) && text(value.name, 100, 1) && integer(value.sets, 1, 20) && text(value.reps, 50, 1) && integer(value.restSeconds, 0, 900) && text(value.category, 100) && (!Object.hasOwn(value, 'notes') || text(value.notes, 1000)) && (!Object.hasOwn(value, 'equipment') || dense(value.equipment, EQUIPMENT_OPTIONS.length) && isEquipmentList(value.equipment))
}

export function validLibraryOrigin(value: unknown): value is LibraryOrigin {
  return object(value) && fields(value, ['version', 'entryId', 'revision']) && value.version === 1 && id(value.entryId) && integer(value.revision, 1, Number.MAX_SAFE_INTEGER)
}

export function validExerciseLibrary(value: unknown): value is ExerciseLibrary {
  if (!object(value) || !fields(value, ['version', 'entries']) || value.version !== 1 || !dense(value.entries, LIBRARY_ENTRY_LIMIT)) return false
  const ids = new Set<string>()
  return value.entries.every(entry => {
    if (!object(entry) || !fields(entry, ['id', 'revision', 'status', 'createdAt', 'updatedAt', 'exercise']) || !id(entry.id) || ids.has(entry.id) || !integer(entry.revision, 1, Number.MAX_SAFE_INTEGER) || !['active', 'archived'].includes(entry.status as string) || !timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || entry.createdAt > entry.updatedAt || !validLibraryContent(entry.exercise)) return false
    ids.add(entry.id); return true
  })
}

/** Inspect before migration so discarded v2 fields cannot hide unsupported metadata. */
export function containsLibraryMetadata(value: unknown): boolean {
  const pending = [value]; const seen = new WeakSet<object>()
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if ('exerciseLibrary' in item || 'libraryOrigin' in item) return true
    pending.push(...Object.values(item))
  }
  return false
}

/** Metadata is permitted only at the root and on exercise/snapshot records. */
export function validLibraryPlacement(state: Record<string, unknown>): boolean {
  const exercises = new WeakSet<object>()
  const addWorkout = (workout: unknown) => { if (object(workout) && Array.isArray(workout.exercises)) workout.exercises.forEach(exercise => { if (object(exercise)) exercises.add(exercise) }) }
  if (Array.isArray(state.workouts)) state.workouts.forEach(addWorkout)
  if (Array.isArray(state.planHistory)) state.planHistory.forEach(revision => { if (object(revision) && Array.isArray(revision.workouts)) revision.workouts.forEach(addWorkout) })
  if (object(state.activeSession)) addWorkout(state.activeSession.workout)
  if (Array.isArray(state.logs)) state.logs.forEach(log => { if (object(log) && Array.isArray(log.exerciseSnapshots)) log.exerciseSnapshots.forEach(exercise => { if (object(exercise)) exercises.add(exercise) }) })
  const libraryIds = new Set(validExerciseLibrary(state.exerciseLibrary) ? state.exerciseLibrary.entries.map(entry => entry.id) : [])
  const pending: unknown[] = [state]; const seen = new WeakSet<object>()
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    for (const key of ['exerciseLibrary', 'libraryOrigin']) if (key in item) {
      if (!Object.hasOwn(item, key)) return false
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!descriptor.enumerable || !('value' in descriptor) || key === 'exerciseLibrary' && item !== state || key === 'libraryOrigin' && !exercises.has(item)) return false
    }
    for (const [key, child] of Object.entries(item)) {
      if (item === state && key === 'exerciseLibrary') continue
      if (key === 'id' && typeof child === 'string' && libraryIds.has(child)) return false
      pending.push(child)
    }
  }
  return true
}
