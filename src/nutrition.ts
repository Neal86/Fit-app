/** Local, user-entered nutrition data. Limits are storage/input bounds, not recommendations. */
export const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Other'] as const
export type MealType = typeof MEAL_TYPES[number]
export type NutritionValues = { calories: number; protein: number; carbs: number; fat: number }
export type MealEntry = NutritionValues & {
  id: string; date: string; mealType: MealType; foodName: string; serving: string
}
export type HydrationEntry = { id: string; date: string; milliliters: number; note: string }
export type DailyNutritionTargets = NutritionValues & { date: string; milliliters: number }
export type NutritionState = {
  version: 1; meals: MealEntry[]; hydration: HydrationEntry[]; targets: DailyNutritionTargets[]
}
export type NutritionUpdate = (change: (current: NutritionState) => NutritionState) => boolean
export const NUTRITION_LIMITS = {
  calories: 50000, grams: 10000, milliliters: 20000, entries: 20000,
  foodName: 150, serving: 200, note: 200,
} as const
export const MIN_NUTRITION_DATE = '1900-01-01'
export const MAX_NUTRITION_DATE = '2200-12-31'
const numericKeys = ['calories', 'protein', 'carbs', 'fat'] as const
const mealKeys = ['id', 'date', 'mealType', 'foodName', 'serving', ...numericKeys]
const hydrationKeys = ['id', 'date', 'milliliters', 'note']
const targetKeys = ['date', ...numericKeys, 'milliliters']

export const createNutritionState = (): NutritionState => ({ version: 1, meals: [], hydration: [], targets: [] })
export const emptyDailyTargets = (date: string): DailyNutritionTargets => ({ date, calories: 0, protein: 0, carbs: 0, fat: 0, milliliters: 0 })
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const bounded = (value: unknown, max: number, min = 0): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const text = (value: unknown, max: number, required = true): value is string => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0)
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,149}$/.test(value)
export function isNutritionDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < MIN_NUTRITION_DATE || value > MAX_NUTRITION_DATE) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const nutrients = (value: Record<string, unknown>) => bounded(value.calories, NUTRITION_LIMITS.calories) && numericKeys.slice(1).every(key => bounded(value[key], NUTRITION_LIMITS.grams))
const isMeal = (value: unknown): value is MealEntry => record(value) && exactKeys(value, mealKeys) && id(value.id) && isNutritionDate(value.date) && typeof value.mealType === 'string' && MEAL_TYPES.some(type => type === value.mealType) && text(value.foodName, NUTRITION_LIMITS.foodName) && text(value.serving, NUTRITION_LIMITS.serving) && nutrients(value)
const isHydration = (value: unknown): value is HydrationEntry => record(value) && exactKeys(value, hydrationKeys) && id(value.id) && isNutritionDate(value.date) && bounded(value.milliliters, NUTRITION_LIMITS.milliliters, Number.MIN_VALUE) && text(value.note, NUTRITION_LIMITS.note, false)
const isTarget = (value: unknown): value is DailyNutritionTargets => record(value) && exactKeys(value, targetKeys) && isNutritionDate(value.date) && nutrients(value) && bounded(value.milliliters, NUTRITION_LIMITS.milliliters)
const list = <T>(value: unknown, valid: (item: unknown) => item is T): value is T[] => Array.isArray(value) && value.length <= NUTRITION_LIMITS.entries && Array.from(value).every(valid)

/** Only a missing legacy field gets a default. Supplied corrupt data is never silently discarded. */
export function parseNutritionState(value: unknown): NutritionState {
  if (value === undefined) return createNutritionState()
  if (!record(value) || !exactKeys(value, ['version', 'meals', 'hydration', 'targets']) || value.version !== 1 || !list(value.meals, isMeal) || !list(value.hydration, isHydration) || !list(value.targets, isTarget)) throw new Error('Nutrition data is incomplete or contains invalid values.')
  const ids = [...value.meals, ...value.hydration].map(entry => entry.id)
  if (new Set(ids).size !== ids.length) throw new Error('Nutrition entries must have unique IDs.')
  if (new Set(value.targets.map(target => target.date)).size !== value.targets.length) throw new Error('Only one set of nutrition targets is allowed per date.')
  return structuredClone({ version: 1, meals: value.meals, hydration: value.hydration, targets: value.targets })
}

/** Empty required values are errors; empty optional targets explicitly mean unset (zero). */
export function parseNutritionNumber(source: string, label: string, max: number, options: { optional?: boolean; positive?: boolean } = {}): number {
  if (source.trim() === '' && options.optional) return 0
  const value = Number(source)
  const decimal = /^\+?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(source.trim())
  if (!decimal || !Number.isFinite(value) || value < 0 || value > max || options.positive && value === 0) throw new Error(`${label} must be ${options.positive ? 'greater than 0' : '0 or more'} and no more than ${max}.`)
  return value
}

export function nutritionTotals(state: NutritionState, date: string): NutritionValues & { milliliters: number; mealCount: number; hydrationCount: number } {
  const meals = state.meals.filter(entry => entry.date === date)
  const hydration = state.hydration.filter(entry => entry.date === date)
  const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100
  return {
    calories: sum(meals.map(entry => entry.calories)), protein: sum(meals.map(entry => entry.protein)),
    carbs: sum(meals.map(entry => entry.carbs)), fat: sum(meals.map(entry => entry.fat)),
    milliliters: sum(hydration.map(entry => entry.milliliters)), mealCount: meals.length, hydrationCount: hydration.length,
  }
}
export const nutritionHistoryDates = (state: NutritionState): string[] => [...new Set([...state.meals, ...state.hydration, ...state.targets].map(entry => entry.date))].sort().reverse()
export function shiftNutritionDate(date: string, days: number): string {
  if (!isNutritionDate(date) || !Number.isInteger(days)) throw new Error('Choose a valid diary date.')
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  const result = Number.isFinite(next.getTime()) ? next.toISOString().slice(0, 10) : ''
  if (!isNutritionDate(result)) throw new Error('Diary dates must be between 1900 and 2200.')
  return result
}

/** Stable per-draft IDs, checked across both entry collections, including generator collisions. */
export function createNutritionId(state: NutritionState): string {
  const used = new Set([...state.meals, ...state.hydration].map(entry => entry.id))
  const base = `nutrition-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
  let result = base; let suffix = 0
  while (used.has(result)) result = `${base}-${++suffix}`
  return result
}
const equalRecord = (a: object, b: object, keys: readonly string[]) => keys.every(key => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key])
function checkExpected<T extends object>(actual: T | undefined, expected: T | null, keys: readonly string[]): void {
  if (expected === null ? !!actual : !actual || !equalRecord(actual, expected, keys)) throw new Error('This entry changed or was removed. Cancel and reopen it before saving.')
}
export function saveMealEntry(state: NutritionState, entry: MealEntry, expected: MealEntry | null = null): NutritionState {
  if (expected && expected.id !== entry.id) throw new Error('The food entry ID cannot be changed.')
  checkExpected(state.meals.find(item => item.id === entry.id), expected, mealKeys)
  return parseNutritionState({ ...state, meals: expected ? state.meals.map(item => item.id === entry.id ? entry : item) : [...state.meals, entry] })
}
export function saveHydrationEntry(state: NutritionState, entry: HydrationEntry, expected: HydrationEntry | null = null): NutritionState {
  if (expected && expected.id !== entry.id) throw new Error('The water entry ID cannot be changed.')
  checkExpected(state.hydration.find(item => item.id === entry.id), expected, hydrationKeys)
  return parseNutritionState({ ...state, hydration: expected ? state.hydration.map(item => item.id === entry.id ? entry : item) : [...state.hydration, entry] })
}
export function deleteMealEntry(state: NutritionState, expected: MealEntry): NutritionState {
  checkExpected(state.meals.find(item => item.id === expected.id), expected, mealKeys)
  return parseNutritionState({ ...state, meals: state.meals.filter(item => item.id !== expected.id) })
}
export function deleteHydrationEntry(state: NutritionState, expected: HydrationEntry): NutritionState {
  checkExpected(state.hydration.find(item => item.id === expected.id), expected, hydrationKeys)
  return parseNutritionState({ ...state, hydration: state.hydration.filter(item => item.id !== expected.id) })
}
export function saveDailyTargets(state: NutritionState, target: DailyNutritionTargets, expected: DailyNutritionTargets | null = null): NutritionState {
  if (!isTarget(target)) throw new Error('Daily targets contain invalid values.')
  if (expected && expected.date !== target.date) throw new Error('The target date cannot be changed.')
  checkExpected(state.targets.find(item => item.date === target.date), expected, targetKeys)
  const hasTarget = numericKeys.some(key => target[key] > 0) || target.milliliters > 0
  return parseNutritionState({ ...state, targets: [...state.targets.filter(item => item.date !== target.date), ...(hasTarget ? [target] : [])] })
}
