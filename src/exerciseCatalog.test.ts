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
  it('keeps unknown, no equipment and different requirements as distinct entries', () => {
    const workout = freshState().workouts[0]; const exercise = workout.exercises[0]
    workout.exercises = [exercise, { ...exercise, id: 'none', equipment: [] }, { ...exercise, id: 'bench-only', equipment: ['bench'] }, { ...exercise, id: 'barbell-only', equipment: ['barbell'] }]
    const matching = filterCatalog(exerciseCatalog([workout]), exercise.name, exercise.category)
    expect(matching).toHaveLength(4)
    expect(new Set(matching.map(item => item.key)).size).toBe(4)
  })
  it('canonicalizes equipment order only for deduplication and deep clones selected requirements', () => {
    const workout = freshState().workouts[0]; const exercise = workout.exercises[0]
    workout.exercises = [{ ...exercise, equipment: ['bench', 'barbell'] }, { ...exercise, id: 'same-requirements', equipment: ['barbell', 'bench'] }]
    const matching = filterCatalog(exerciseCatalog([workout]), exercise.name, exercise.category)
    expect(matching).toHaveLength(2) // One supplied variant and the unclassified starter entry.
    expect(matching.find(item => item.source === 'Your plan')!.exercise.equipment).toEqual(['bench', 'barbell'])
    matching.find(item => item.source === 'Your plan')!.exercise.equipment!.push('weight-plates')
    expect(workout.exercises[0].equipment).toEqual(['bench', 'barbell'])
  })
})
