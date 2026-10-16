import { containsLibraryMetadata, validExerciseLibrary, validLibraryOrigin, validLibraryPlacement } from './exerciseLibraryValidation.js'
import type { AppState, Workout } from './types.js'
import { isUnknownCalories, validCalorieEstimate } from './calorieEstimates.js'
import { parseNutritionState } from './nutrition.js'
import { isEquipmentList } from './equipment.js'
import { containsGrouping, validSessionGrouping } from './sessionGroupingValidation.js'
import { containsPlannedGrouping, validPlannedGrouping, validPlannedGroupingCollection } from './plannedGroupingValidation.js'
import type { PlannedGroupingOwner } from './plannedGroupingValidation.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const calories = (owner: Record<string, unknown>, max: number) => {
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'calories')
  return !!descriptor?.enumerable && 'value' in descriptor && validCalorieEstimate(descriptor.value, max)
}
const integer = (value: unknown, min: number, max: number) => number(value, min, max) && Number.isInteger(value)
const text = (value: unknown, max = 500, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min
const choice = (value: unknown, choices: string[]) => typeof value === 'string' && choices.includes(value)
const day = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
const dateTime = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && day(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
const id = (value: unknown) => text(value, 150, 1)
const list = (value: unknown, valid: (item: unknown) => boolean, max: number, min = 0): value is unknown[] => Array.isArray(value) && value.length >= min && value.length <= max && Array.from(value).every(valid)
const unique = (items: unknown[]) => new Set(items.map(item => object(item) ? item.id : item)).size === items.length
const levels = ['Beginner', 'Intermediate', 'Advanced']
const exercise = (value: unknown): boolean => object(value) && fields(value, ['id', 'name', 'sets', 'reps', 'restSeconds', 'category', 'notes', 'equipment', 'libraryOrigin']) && id(value.id) && text(value.name, 100, 1) && integer(value.sets, 1, 20) && text(value.reps, 50, 1) && integer(value.restSeconds, 0, 900) && text(value.category, 100) && (value.notes === undefined || text(value.notes, 1000)) && (value.equipment === undefined || isEquipmentList(value.equipment)) && (!Object.hasOwn(value, 'libraryOrigin') || validLibraryOrigin(value.libraryOrigin))
export const validWorkout = (value: unknown): boolean => object(value) && fields(value, ['id', 'title', 'day', 'duration', 'calories', 'difficulty', 'description', 'exercises', 'plannedGrouping']) && id(value.id) && text(value.title, 150, 1) && text(value.day, 30, 1) && number(value.duration, 1, 600) && calories(value, 10000) && choice(value.difficulty, levels) && text(value.description, 2000) && list(value.exercises, exercise, 50, 1) && unique(value.exercises) && (!Object.hasOwn(value, 'plannedGrouping') || validPlannedGrouping(value.plannedGrouping, value as PlannedGroupingOwner))
const nullableNumber = (value: unknown, min: number, max: number) => value === null || number(value, min, max)
const set = (value: unknown): boolean => object(value) && fields(value, ['id', 'exerciseId', 'setNumber', 'reps', 'weightKg', 'seconds', 'rpe', 'warmup', 'completed']) && id(value.id) && id(value.exerciseId) && integer(value.setNumber, 1, 50) && (value.reps === null || integer(value.reps, 0, 999)) && nullableNumber(value.weightKg, 0, 1000) && nullableNumber(value.seconds, 0, 86400) && nullableNumber(value.rpe, 1, 10) && typeof value.warmup === 'boolean' && typeof value.completed === 'boolean'
const log = (value: unknown): boolean => object(value) && fields(value, ['id', 'workoutId', 'title', 'startedAt', 'completedAt', 'duration', 'durationSeconds', 'calories', 'completedExerciseIds', 'notes', 'sets', 'exerciseSnapshots', 'grouping']) && id(value.id) && id(value.workoutId) && text(value.title, 150, 1) && dateTime(value.startedAt) && dateTime(value.completedAt) && Date.parse(value.startedAt as string) <= Date.parse(value.completedAt as string) && number(value.duration, 0, 525600) && calories(value, 10000000) && (value.durationSeconds === undefined || number(value.durationSeconds, 0, 31536000)) && list(value.completedExerciseIds, id, 50) && (value.notes === undefined || text(value.notes, 2000)) && (value.sets === undefined || list(value.sets, set, 2500) && unique(value.sets)) && (value.exerciseSnapshots === undefined || list(value.exerciseSnapshots, entry => object(entry) && fields(entry, ['id','name','category','libraryOrigin']) && id(entry.id) && text(entry.name, 100, 1) && text(entry.category, 100) && (!Object.hasOwn(entry, 'libraryOrigin') || validLibraryOrigin(entry.libraryOrigin)), 50) && unique(value.exerciseSnapshots)) && (!Object.hasOwn(value, 'grouping') || Array.isArray(value.sets) && Array.isArray(value.exerciseSnapshots) && validSessionGrouping(value.grouping, { id: value.id as string, workoutId: value.workoutId as string, sets: value.sets as { id: string; exerciseId: string; warmup: boolean }[], exerciseIds: (value.exerciseSnapshots as { id: string }[]).map(exercise => exercise.id), identityReferences: value.completedExerciseIds as string[] }))
function active(value: unknown): boolean {
  if (value === null) return true
  if (!object(value) || !fields(value, ['id','workout','startedAt','elapsedSeconds','runningSince','sets','notes','restUntil','grouping']) || !id(value.id) || (!validWorkout(value.workout) || Object.hasOwn(value.workout as object, 'plannedGrouping')) || !dateTime(value.startedAt) || !number(value.elapsedSeconds, 0, 31536000) || !nullableNumber(value.runningSince, 0, 8640000000000000) || !nullableNumber(value.restUntil, 0, 8640000000000000) || !text(value.notes, 2000) || !list(value.sets, set, 2500, 1) || !unique(value.sets)) return false
  const exercises = (value.workout as { exercises: { id: string }[] }).exercises
  if (Object.hasOwn(value, 'grouping') && !validSessionGrouping(value.grouping, { id: value.id as string, workoutId: (value.workout as { id: string }).id, sets: value.sets as { id: string; exerciseId: string; warmup: boolean }[], exerciseIds: exercises.map(exercise => exercise.id) })) return false
  return value.sets.every(item => object(item) && exercises.some(exercise => exercise.id === item.exerciseId)) && exercises.every(exercise => value.sets instanceof Array && value.sets.some(item => object(item) && item.exerciseId === exercise.id))
}
/** Check every supplied field before legacy migration can discard unsupported estimates. */
function validCaloriePlacement(state: Record<string, unknown>): boolean {
  type Context = 'state' | 'workouts' | 'history' | 'revision' | 'active' | 'logs' | 'owner' | 'other'
  const childContext = (item: object, context: Context, key: PropertyKey): Context => {
    if (context === 'state') {
      if (key === 'workouts' || key === 'logs') return key
      if (key === 'planHistory') return 'history'
      if (key === 'activeSession') return 'active'
    }
    if (context === 'active' && key === 'workout') return 'owner'
    if (context === 'revision' && key === 'workouts') return 'workouts'
    const index = Array.isArray(item) && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < item.length
    if (index && (context === 'workouts' || context === 'logs')) return 'owner'
    if (index && context === 'history') return 'revision'
    return 'other'
  }
  const pending: { value: object; context: Context; markerAllowed: boolean }[] = [{ value: state, context: 'state', markerAllowed: false }]
  const seen = new WeakMap<object, Set<Context>>()
  while (pending.length) {
    const { value: item, context, markerAllowed } = pending.pop()!
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== null && prototype !== (Array.isArray(item) ? Array.prototype : Object.prototype)) return false
    // Check every incoming edge, including aliases in a forbidden location.
    const status = Object.getOwnPropertyDescriptor(item, 'status')
    if (status && (Object.hasOwn(item, 'version') || 'value' in status && status.value === 'unknown') && (!markerAllowed || !isUnknownCalories(item))) return false
    const contexts = seen.get(item) ?? new Set<Context>()
    if (contexts.has(context)) continue
    contexts.add(context); seen.set(item, contexts)
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!('value' in descriptor)) return false
      const child: unknown = descriptor.value
      const allowed = state.version === 4 && key === 'calories' && descriptor.enumerable === true && context === 'owner'
      if (key === 'calories' && typeof child !== 'number' && (!allowed || !isUnknownCalories(child))) return false
      if (child && typeof child === 'object') pending.push({ value: child, context: descriptor.enumerable ? childContext(item, context, key) : 'other', markerAllowed: allowed })
    }
  }
  return true
}
export function parseState(value: unknown): AppState {
  if (!object(value) || (value.version !== 2 && value.version !== 3 && value.version !== 4)) throw new Error('Unsupported backup format or version.')
  if (!validCaloriePlacement(value)) throw new Error('Workout calorie estimates are invalid or require version 4. Original data has been preserved.')
  if (value.version !== 4 && containsLibraryMetadata(value)) throw new Error('Exercise library metadata requires version 4. Original data has been preserved.')
  if (value.version !== 4 && (containsGrouping(value) || containsPlannedGrouping(value))) throw new Error('Grouping requires version 4. Original data has been preserved.')
  if (!fields(value, ['version','profile','preferences','workouts','logs','weightHistory','activeSession','nutrition','planHistory','exerciseLibrary'])) throw new Error('Backup contains unsupported data fields. Original data has been preserved.')
  if (value.version === 4 && (value.nutrition === undefined || value.planHistory === undefined)) throw new Error('Nutrition data and plan history are required in version 4 backups.')
  if (Object.hasOwn(value, 'exerciseLibrary') && !validExerciseLibrary(value.exerciseLibrary) || !validLibraryPlacement(value)) throw new Error('Exercise library metadata is invalid. Original data has been preserved.')
  const nutrition = parseNutritionState(value.nutrition)
  const profile = value.profile
  const preferences = value.preferences
  const valid = object(profile) && fields(profile, ['name','goal','level','weeklyTarget','weightKg','heightCm','birthYear','unit','onboardingComplete']) && text(profile.name, 40, 1) && choice(profile.goal, ['Build muscle', 'Lose fat', 'Improve endurance', 'Stay active']) && choice(profile.level, levels) && integer(profile.weeklyTarget, 1, 7) && number(profile.weightKg, 30, 300) && number(profile.heightCm, 120, 230) && integer(profile.birthYear, 1900, 2200) && choice(profile.unit, ['metric', 'imperial']) && typeof profile.onboardingComplete === 'boolean' && object(preferences) && fields(preferences, ['reducedMotion','soundEnabled','remindersEnabled']) && typeof preferences.reducedMotion === 'boolean' && typeof preferences.soundEnabled === 'boolean' && typeof preferences.remindersEnabled === 'boolean' && list(value.workouts, validWorkout, 100, 1) && unique(value.workouts) && validPlannedGroupingCollection(value.workouts as Workout[]) && list(value.logs, log, 20000) && unique(value.logs) && list(value.weightHistory, entry => object(entry) && fields(entry, ['id','date','weightKg']) && id(entry.id) && day(entry.date) && number(entry.weightKg, 30, 300), 20000) && unique(value.weightHistory)
  if (value.planHistory !== undefined && (!list(value.planHistory, revision => object(revision) && fields(revision, ['id','savedAt','label','workouts']) && id(revision.id) && dateTime(revision.savedAt) && text(revision.label, 150, 1) && list(revision.workouts, validWorkout, 100, 1) && unique(revision.workouts) && validPlannedGroupingCollection(revision.workouts as Workout[]), 20) || !unique(value.planHistory))) throw new Error('Plan history is invalid.')
  if (!valid || value.version !== 2 && !active(value.activeSession)) throw new Error('Backup data is incomplete or contains invalid values.')
  if (object(value.activeSession) && Array.isArray(value.logs) && value.logs.some(log => object(log) && log.id === (value.activeSession as Record<string, unknown>).id)) throw new Error('The active session ID conflicts with saved workout history.')
  return structuredClone({ ...value, version: 4, nutrition, planHistory: value.planHistory ?? [], activeSession: value.version === 2 ? null : value.activeSession }) as AppState
}
