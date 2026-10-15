import { initialState } from './data'
import type { Exercise, Workout } from './types'
import { EQUIPMENT_OPTIONS } from './equipment'

export type CatalogExercise = { key: string; exercise: Exercise; source: string }
export function exerciseCatalog(workouts: Workout[]): CatalogExercise[] {
  const catalog = new Map<string, CatalogExercise>()
  // Include user-edited entries first; only identical descriptive content is deduplicated.
  for (const [source, entries] of [['Your plan', workouts], ['Starter template', initialState.workouts]] as const) {
    for (const workout of entries) for (const exercise of workout.exercises) {
      // Keep unspecified requirements distinct from an explicitly equipment-free entry.
      const equipment = exercise.equipment === undefined ? null : EQUIPMENT_OPTIONS.filter(option => exercise.equipment!.includes(option.id)).map(option => option.id)
      const key = JSON.stringify([exercise.name.trim().toLowerCase(), exercise.category.trim().toLowerCase(), exercise.notes ?? '', exercise.sets, exercise.reps, exercise.restSeconds, equipment])
      if (!catalog.has(key)) catalog.set(key, { key, exercise: structuredClone(exercise), source })
    }
  }
  return [...catalog.values()].sort((a, b) => a.exercise.name.localeCompare(b.exercise.name))
}
export function filterCatalog(catalog: CatalogExercise[], query: string, category: string) {
  const term = query.trim().toLowerCase()
  return catalog.filter(item => (!category || item.exercise.category === category) && `${item.exercise.name} ${item.exercise.category} ${item.exercise.notes ?? ''}`.toLowerCase().includes(term))
}
