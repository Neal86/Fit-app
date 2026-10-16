import { localDate } from './session'
import { summarizeCalories } from './calorieEstimates'
import type { ExerciseSet, WeightEntry, Workout, WorkoutLog } from './types'

export type DateRange = { from: string; to: string }
export function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function rangeError(range: DateRange): string {
  if (range.from && !validDay(range.from) || range.to && !validDay(range.to)) return 'Choose valid calendar dates.'
  return range.from && range.to && range.from > range.to ? 'The start date must be on or before the end date.' : ''
}
const includesDay = (date: string, range: DateRange) => (!range.from || date >= range.from) && (!range.to || date <= range.to)
export function filteredLogs(logs: WorkoutLog[], range: DateRange, query = ''): WorkoutLog[] {
  if (rangeError(range)) return []
  return logs.filter(log => includesDay(localDate(new Date(log.completedAt)), range) && `${log.title} ${log.notes ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
}
export const completedWorkSets = (sets: ExerciseSet[] = []) => sets.filter(set => set.completed && !set.warmup)
export const setVolume = (sets: ExerciseSet[] = []) => completedWorkSets(sets).reduce((total, set) => total + (set.reps ?? 0) * (set.weightKg ?? 0), 0)
export function summarizeLogs(logs: WorkoutLog[]) {
  const calories = summarizeCalories(logs.map(log => log.calories))
  return {
    sessions: logs.length,
    seconds: logs.reduce((sum, log) => sum + (log.durationSeconds ?? log.duration * 60), 0),
    calories: calories.total,
    knownCalories: calories.knownTotal,
    knownCalorieSessions: calories.knownCount,
    unknownCalorieSessions: calories.unknownCount,
    volumeKg: logs.reduce((sum, log) => sum + setVolume(log.sets), 0),
    sets: logs.reduce((sum, log) => sum + completedWorkSets(log.sets).length, 0),
    trainingDays: new Set(logs.map(log => localDate(new Date(log.completedAt)))).size,
    measuredSessions: logs.filter(log => log.durationSeconds !== undefined).length,
  }
}
export function weightTrend(entries: WeightEntry[], range: DateRange) {
  if (rangeError(range)) return []
  // Imported older backups can contain several entries for a day; retain the last one.
  const daily = new Map<string, WeightEntry>()
  entries.filter(entry => includesDay(entry.date, range)).forEach(entry => daily.set(entry.date, entry))
  return [...daily.values()].sort((a, b) => a.date.localeCompare(b.date))
}
export function activityMonth(logs: WorkoutLog[], month: string) {
  if (!/^\d{4}-\d{2}$/.test(month) || !validDay(`${month}-01`)) return []
  const [year, monthNumber] = month.split('-').map(Number)
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  const daily = new Map<string, number>()
  logs.forEach(log => { const day = localDate(new Date(log.completedAt)); daily.set(day, (daily.get(day) ?? 0) + 1) })
  return Array.from({ length: count }, (_, index) => { const date = `${month}-${String(index + 1).padStart(2, '0')}`; return { date, sessions: daily.get(date) ?? 0 } })
}
export type RecordedBest = { exerciseId: string; name: string; weightKg: number; reps: number; completedAt: string }
export function recordedBests(logs: WorkoutLog[], workouts: Workout[]): RecordedBest[] {
  const names = new Map(workouts.flatMap(workout => workout.exercises.map(exercise => [exercise.id, exercise.name] as const)))
  const bests = new Map<string, RecordedBest>()
  logs.forEach(log => {
    completedWorkSets(log.sets).forEach(set => {
      if (!set.weightKg || !set.reps) return
      const prior = bests.get(set.exerciseId)
      if (prior && (prior.weightKg > set.weightKg || prior.weightKg === set.weightKg && (prior.reps > set.reps || prior.reps === set.reps && Date.parse(prior.completedAt) >= Date.parse(log.completedAt)))) return
      bests.set(set.exerciseId, { exerciseId: set.exerciseId, name: log.exerciseSnapshots?.find(exercise => exercise.id === set.exerciseId)?.name ?? names.get(set.exerciseId) ?? `Archived exercise (${set.exerciseId})`, weightKg: set.weightKg, reps: set.reps, completedAt: log.completedAt })
    })
  })
  return [...bests.values()].sort((a, b) => a.name.localeCompare(b.name))
}
