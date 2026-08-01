import { describe, expect, it } from 'vitest'
import { initialState } from './data'

describe('initial application state', () => {
  it('ships a complete and valid starter plan', () => {
    expect(initialState.version).toBe(2)
    expect(initialState.workouts.length).toBeGreaterThanOrEqual(4)
    expect(initialState.workouts.every((workout) => workout.exercises.length >= 4)).toBe(true)
    expect(initialState.workouts.every((workout) => workout.duration > 0 && workout.calories > 0)).toBe(true)
  })

  it('uses unique workout and exercise ids', () => {
    const workoutIds = initialState.workouts.map((workout) => workout.id)
    const exerciseIds = initialState.workouts.flatMap((workout) => workout.exercises.map((exercise) => exercise.id))
    expect(new Set(workoutIds).size).toBe(workoutIds.length)
    expect(new Set(exerciseIds).size).toBe(exerciseIds.length)
  })

  it('contains profile values inside supported ranges', () => {
    expect(initialState.profile.weeklyTarget).toBeGreaterThanOrEqual(1)
    expect(initialState.profile.weeklyTarget).toBeLessThanOrEqual(7)
    expect(initialState.profile.heightCm).toBeGreaterThanOrEqual(120)
    expect(initialState.profile.weightKg).toBeGreaterThanOrEqual(30)
  })
})
