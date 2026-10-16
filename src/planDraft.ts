import type { Workout } from './types'
import { isEquipmentList } from './equipment'
import { validPlannedGrouping, type PlannedGroupingOwner } from './plannedGroupingValidation'
export const PLAN_DRAFT_KEY = 'fitflow-plan-draft-v1'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
// A draft may contain incomplete form values; validate its shape without pretending it is a saved plan.
export function readPlanDraft(): Workout | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY) || 'null')
    if (!object(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.day !== 'string' || typeof raw.description !== 'string' || !['Beginner','Intermediate','Advanced'].includes(String(raw.difficulty)) || !finite(raw.duration) || !finite(raw.calories) || !Array.isArray(raw.exercises) || !raw.exercises.length || raw.exercises.length > 50) return null
    if (!raw.exercises.every(exercise => object(exercise) && ['id','name','reps','category'].every(key => typeof exercise[key] === 'string') && ['sets','restSeconds'].every(key => finite(exercise[key])) && (exercise.notes === undefined || typeof exercise.notes === 'string') && (exercise.equipment === undefined || isEquipmentList(exercise.equipment)))) return null
    if (Object.hasOwn(raw, 'plannedGrouping') && !validPlannedGrouping(raw.plannedGrouping, raw as PlannedGroupingOwner, { allowIncompleteSets: true })) return null
    return raw as Workout
  } catch { return null }
}
export function savePlanDraft(workout: Workout) { sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(workout)) }
export function clearPlanDraft(): boolean { try { sessionStorage.removeItem(PLAN_DRAFT_KEY); return true } catch { return false } }
