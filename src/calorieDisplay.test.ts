import { describe, expect, it } from 'vitest'
import { calorieEstimateText, calorieSummaryDisplay } from './calorieDisplay'
import { summarizeCalories, unknownCalories } from './calorieEstimates'

describe('workout calorie display', () => {
  it('keeps unknown different from an explicit zero and labels numeric values as estimates', () => {
    expect(calorieEstimateText(unknownCalories())).toBe('Calorie estimate unavailable')
    expect(calorieEstimateText(0)).toBe('0 estimated kcal')
    expect(calorieEstimateText(420.123456789)).toBe('420.123456789 estimated kcal')
    expect(calorieEstimateText(1e-25)).toBe('1e-25 estimated kcal')
    expect(calorieEstimateText(Number.MIN_VALUE)).toBe('5e-324 estimated kcal')
  })
  it('distinguishes empty, all unknown, all known and partial totals', () => {
    expect(calorieSummaryDisplay(summarizeCalories([]))).toEqual({ value: 'No sessions', detail: 'No workout calorie estimates to total' })
    expect(calorieSummaryDisplay(summarizeCalories([unknownCalories(), unknownCalories()]))).toEqual({ value: 'Unavailable', detail: '2 sessions without calorie estimates' })
    expect(calorieSummaryDisplay(summarizeCalories([0]))).toEqual({ value: '0 estimated kcal', detail: '1 session with calorie estimates' })
    expect(calorieSummaryDisplay(summarizeCalories([0, 123.45, unknownCalories()]))).toEqual({ value: '123.45 estimated kcal known subtotal', detail: '1 session without calorie estimates; total unavailable' })
  })
})
