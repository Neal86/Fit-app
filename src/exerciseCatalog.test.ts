import { describe, expect, it } from 'vitest'
import { exerciseCatalog, filterCatalog } from './exerciseCatalog'
import { freshState } from './storage'

describe('reusable exercise entries', () => {
  it('deduplicates exact templates and never mutates saved exercises', () => {
    const state = freshState(); const catalog = exerciseCatalog(state.workouts)
    expect(catalog).toHaveLength(state.workouts.flatMap(workout => workout.exercises).length)
    expect(catalog.every(item => item.source === 'Your plan')).toBe(true)
    catalog[0].exercise.name = 'Changed'
    expect(state.workouts.flatMap(workout => workout.exercises).some(exercise => exercise.name === 'Changed')).toBe(false)
  })
  it('retains a user variation and its original starter values as distinct entries', () => {
    const state = freshState(); state.workouts[0].exercises[0].sets = 2
    const matching = filterCatalog(exerciseCatalog(state.workouts), 'bench', 'Chest')
    expect(matching).toHaveLength(2)
    expect(matching.map(item => item.exercise.sets).sort()).toEqual([2, 4])
  })
  it('filters by category and case-insensitive names or notes', () => {
    const catalog = exerciseCatalog([])
    expect(filterCatalog(catalog, 'SHOULDER BLADES', '')[0].exercise.name).toBe('Bench Press')
    expect(filterCatalog(catalog, 'bench', 'Back')).toEqual([])
  })
})
