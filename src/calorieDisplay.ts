import { isUnknownCalories } from './calorieEstimates'
import type { CalorieEstimate } from './types'

// Preserve small positive values and stored precision instead of displaying them as zero.
const formatCalories = (value: number) => value > 0 && value < 0.000001 ? String(value) : value.toLocaleString(undefined, { maximumSignificantDigits: 21 })

export function calorieEstimateText(value: CalorieEstimate): string {
  return isUnknownCalories(value) ? 'Calorie estimate unavailable' : `${formatCalories(value)} estimated kcal`
}

type CalorieSummary = { knownTotal: number; knownCount: number; unknownCount: number }
export function calorieSummaryDisplay({ knownTotal, knownCount, unknownCount }: CalorieSummary): { value: string; detail: string } {
  if (!knownCount && !unknownCount) return { value: 'No sessions', detail: 'No workout calorie estimates to total' }
  const missing = `${unknownCount} ${unknownCount === 1 ? 'session' : 'sessions'} without calorie estimates`
  if (!knownCount) return { value: 'Unavailable', detail: missing }
  if (unknownCount) return { value: `${formatCalories(knownTotal)} estimated kcal known subtotal`, detail: `${missing}; total unavailable` }
  return { value: `${formatCalories(knownTotal)} estimated kcal`, detail: `${knownCount} ${knownCount === 1 ? 'session' : 'sessions'} with calorie estimates` }
}
