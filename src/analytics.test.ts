import { describe, expect, it } from 'vitest'
import { activityMonth, filteredLogs, rangeError, recordedBests, setVolume, summarizeLogs, validDay, weightTrend } from './analytics'
import { freshState } from './storage'
import { finishSession, startSession } from './session'
import type { ExerciseSet, WorkoutLog } from './types'

const set = (overrides: Partial<ExerciseSet> = {}): ExerciseSet => ({ id: 's', exerciseId: 'bench', setNumber: 1, reps: 8, weightKg: 20, seconds: null, rpe: null, completed: true, warmup: false, ...overrides })
const log = (overrides: Partial<WorkoutLog> = {}): WorkoutLog => ({ id: 'l', workoutId: 'w', title: 'Strength', startedAt: new Date(2026, 9, 15, 10).toISOString(), completedAt: new Date(2026, 9, 15, 11).toISOString(), duration: 60, calories: 300, completedExerciseIds: [], sets: [set()], ...overrides })

describe('transparent local progress calculations', () => {
  it('validates leap dates and rejects invalid ranges', () => {
    expect(validDay('2024-02-29')).toBe(true)
    expect(validDay('2026-02-29')).toBe(false)
    expect(validDay('2026-13-10')).toBe(false)
    expect(rangeError({ from: '2026-10-15', to: '2026-10-01' })).toContain('start date')
    expect(filteredLogs([log()], { from: 'bad', to: '' })).toEqual([])
  })
  it('filters inclusive local days and notes, and sorts without mutating source', () => {
    const logs = [log({ id: 'older', completedAt: new Date(2026, 9, 14, 23, 59).toISOString() }), log({ id: 'newer', notes: 'GOOD ENERGY' })]
    expect(filteredLogs(logs, { from: '2026-10-15', to: '2026-10-15' }, 'energy').map(item => item.id)).toEqual(['newer'])
    expect(filteredLogs(logs, { from: '', to: '' }).map(item => item.id)).toEqual(['newer', 'older'])
    expect(logs[0].id).toBe('older')
  })
  it('excludes warmups, incomplete sets and missing weight from loaded volume', () => {
    expect(setVolume([set(), set({ warmup: true, weightKg: 50 }), set({ completed: false, weightKg: 90 }), set({ weightKg: null }), set({ reps: null })])).toBe(160)
  })
  it('uses measured seconds when available and preserves older recorded minutes', () => {
    const result = summarizeLogs([log({ duration: 999, durationSeconds: 30 }), log({ id: 'old', duration: 2, sets: undefined })])
    expect(result.seconds).toBe(150)
    expect(result.trainingDays).toBe(1)
    expect(result.measuredSessions).toBe(1)
    expect(result.volumeKg).toBe(160)
  })
  it('sorts and deduplicates daily weights while respecting range', () => {
    const entries = [{ id: 'new', date: '2026-10-15', weightKg: 70 }, { id: 'old', date: '2026-10-10', weightKg: 72 }, { id: 'corrected', date: '2026-10-15', weightKg: 71 }]
    expect(weightTrend(entries, { from: '', to: '' }).map(entry => entry.weightKg)).toEqual([72, 71])
    expect(weightTrend(entries, { from: '2026-10-15', to: '' }).map(entry => entry.id)).toEqual(['corrected'])
  })
  it('creates leap-month cells and counts local calendar dates', () => {
    const cells = activityMonth([log({ completedAt: new Date(2024, 1, 29, 23, 59).toISOString() })], '2024-02')
    expect(cells).toHaveLength(29)
    expect(cells[28]).toEqual({ date: '2024-02-29', sessions: 1 })
    expect(activityMonth([], '2026-13')).toEqual([])
    expect(activityMonth([], '')).toEqual([])
  })
  it('compares recorded loads then reps, excluding warmups, without conflating exercise identities', () => {
    const logs = [log({ sets: [set({ weightKg: 30, reps: 5 }), set({ id: 'two', exerciseId: 'renamed', weightKg: 70, reps: 8 }), set({ id: 'warm', weightKg: 100, warmup: true })] }), log({ id: 'second', sets: [set({ weightKg: 30, reps: 8 })], exerciseSnapshots: [{ id: 'bench', name: 'Historical Bench', category: 'Chest' }] })]
    const result = recordedBests(logs, freshState().workouts)
    expect(result.find(best => best.exerciseId === 'bench')).toMatchObject({ name: 'Historical Bench', weightKg: 30, reps: 8 })
    expect(result.find(best => best.exerciseId === 'renamed')?.name).toBe('Archived exercise (renamed)')
    expect(result).toHaveLength(2)
  })
  it('preserves exercise labels in newly finished sessions', () => {
    const session = startSession(freshState().workouts[0]); session.sets[0] = set()
    const saved = finishSession(session)
    session.workout.exercises[0].name = 'Changed later'
    expect(saved.exerciseSnapshots?.[0].name).toBe('Bench Press')
  })
})
