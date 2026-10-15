import {
  isNutritionDate, MEAL_TYPES, NUTRITION_LIMITS, parseNutritionState,
  type DailyNutritionTargets, type HydrationEntry, type MealEntry, type MealType,
} from './nutrition'

export type NutritionValuesForm = { calories: string; protein: string; carbs: string; fat: string }
export type NutritionMealForm = NutritionValuesForm & { date: string; mealType: MealType; foodName: string; serving: string }
export type NutritionWaterForm = { date: string; milliliters: string; note: string }
export type NutritionTargetForm = NutritionValuesForm & { milliliters: string }
export type NutritionEditor =
  | { kind: 'meal'; id: string; original: MealEntry | null; initial: NutritionMealForm; form: NutritionMealForm }
  | { kind: 'water'; id: string; original: HydrationEntry | null; initial: NutritionWaterForm; form: NutritionWaterForm }
  | { kind: 'targets'; original: DailyNutritionTargets | null; initial: NutritionTargetForm; form: NutritionTargetForm }
export type NutritionDraft = { version: 1; date: string; editor: NutritionEditor | null }
export const NUTRITION_DRAFT_KEY = 'fitflow-nutrition-draft-v1'
export const MAX_NUTRITION_DRAFT_BYTES = 32 * 1024
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const form = (value: unknown, kind: NutritionEditor['kind']): boolean => {
  if (!record(value)) return false
  const valueKeys = ['calories', 'protein', 'carbs', 'fat']
  const numericText = (keys: string[]) => keys.every(key => text(value[key], 100))
  // Draft numeric/date text may be blank, partial, negative, or otherwise invalid.
  // Validate shape/size only here; the saved-state parser still validates final values.
  if (kind === 'meal') return exact(value, [...valueKeys, 'date', 'mealType', 'foodName', 'serving']) && numericText(valueKeys) && text(value.date, 32) && MEAL_TYPES.some(type => type === value.mealType) && text(value.foodName, NUTRITION_LIMITS.foodName) && text(value.serving, NUTRITION_LIMITS.serving)
  if (kind === 'water') return exact(value, ['date', 'milliliters', 'note']) && text(value.date, 32) && text(value.milliliters, 100) && text(value.note, NUTRITION_LIMITS.note)
  return exact(value, [...valueKeys, 'milliliters']) && numericText([...valueKeys, 'milliliters'])
}
function validEditor(value: unknown, date: string): value is NutritionEditor | null {
  if (value === null) return true
  if (!record(value) || !['meal', 'water', 'targets'].includes(String(value.kind))) return false
  const kind = value.kind as NutritionEditor['kind']
  if (!exact(value, kind === 'targets' ? ['kind', 'original', 'initial', 'form'] : ['kind', 'id', 'original', 'initial', 'form']) || !form(value.form, kind) || !form(value.initial, kind)) return false
  if (kind !== 'targets' && (typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,149}$/.test(value.id))) return false
  if (value.original === null) return true
  try {
    const state = parseNutritionState({ version: 1, meals: kind === 'meal' ? [value.original] : [], hydration: kind === 'water' ? [value.original] : [], targets: kind === 'targets' ? [value.original] : [] })
    return kind === 'meal' ? state.meals[0].id === value.id : kind === 'water' ? state.hydration[0].id === value.id : state.targets[0].date === date
  } catch { return false }
}
export function parseNutritionDraft(value: unknown): NutritionDraft {
  if (!record(value) || !exact(value, ['version', 'date', 'editor']) || value.version !== 1 || !isNutritionDate(value.date) || !validEditor(value.editor, value.date)) throw new Error('The nutrition draft is invalid or unsupported.')
  return structuredClone(value) as NutritionDraft
}
/** An unreadable draft is left untouched until an explicit new edit/date selection replaces it. */
export function readNutritionDraft(): { draft: NutritionDraft | null; error: string } {
  try {
    const source = sessionStorage.getItem(NUTRITION_DRAFT_KEY)
    if (source === null) return { draft: null, error: '' }
    if (new Blob([source]).size > MAX_NUTRITION_DRAFT_BYTES) throw new Error('The nutrition draft exceeds the 32 KB limit.')
    return { draft: parseNutritionDraft(JSON.parse(source)), error: '' }
  } catch {
    return { draft: null, error: 'This tab could not restore its nutrition draft. Your saved diary is unchanged. Starting a new form or choosing another date will replace an unreadable draft if tab storage is available.' }
  }
}
export function saveNutritionDraft(value: NutritionDraft): void {
  const source = JSON.stringify(parseNutritionDraft(value))
  if (new Blob([source]).size > MAX_NUTRITION_DRAFT_BYTES) throw new Error('The nutrition draft exceeds the 32 KB limit.')
  sessionStorage.setItem(NUTRITION_DRAFT_KEY, source)
}
/** Call after successful import/reset/cloud restore; false means cleanup could not be verified. */
export function clearNutritionDraft(): boolean {
  try { sessionStorage.removeItem(NUTRITION_DRAFT_KEY); return true } catch { return false }
}
