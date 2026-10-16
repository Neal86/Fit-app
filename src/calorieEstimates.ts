import type { CalorieEstimate } from './types.js'

type UnknownCalories = Exclude<CalorieEstimate, number>

/** Allocate a separate marker for every snapshot; zero is always a known estimate. */
export const unknownCalories = (): UnknownCalories => ({ version: 1, status: 'unknown' })

/** Only the exact, serializable versioned marker is an unknown estimate. */
export function isUnknownCalories(value: unknown): value is UnknownCalories {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (Reflect.ownKeys(value).length !== 2) return false
  const version = Object.getOwnPropertyDescriptor(value, 'version')
  const status = Object.getOwnPropertyDescriptor(value, 'status')
  return !!version?.enumerable && 'value' in version && version.value === 1 && !!status?.enumerable && 'value' in status && status.value === 'unknown'
}

/** Retain each owner's existing numeric bounds without coercion or rounding. */
export function validCalorieEstimate(value: unknown, max: number): value is CalorieEstimate {
  return isUnknownCalories(value) || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
}

export function summarizeCalories(estimates: readonly CalorieEstimate[]): { knownTotal: number; knownCount: number; unknownCount: number; total: number | null } {
  let knownTotal = 0
  let knownCount = 0
  let unknownCount = 0
  for (const estimate of estimates) {
    if (isUnknownCalories(estimate)) unknownCount += 1
    else if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0) { knownTotal += estimate; knownCount += 1 }
    else throw new Error('The calorie estimate is invalid.')
    if (!Number.isFinite(knownTotal)) throw new Error('The calorie total is invalid.')
  }
  return { knownTotal, knownCount, unknownCount, total: unknownCount ? null : knownTotal }
}
