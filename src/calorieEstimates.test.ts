import { describe, expect, it, vi } from 'vitest'
import { isUnknownCalories, summarizeCalories, unknownCalories, validCalorieEstimate } from './calorieEstimates'
import { summarizeLogs } from './analytics'
import type { CalorieEstimate, WorkoutLog } from './types'

const log = (calories: CalorieEstimate, index: number): WorkoutLog => ({ id: `log-${index}`, workoutId: 'workout', title: 'Synthetic session', startedAt: '2026-10-15T10:00:00.000Z', completedAt: '2026-10-15T10:01:00.000Z', duration: 1, calories, completedExerciseIds: [] })

const malformedCalories: unknown[] = [
  null, undefined, '', 'unknown', '0', true, false, NaN, Infinity, -Infinity, -1,
  {}, [], [1], new Number(0), { status: 'unknown' }, { version: 1 },
  { version: 0, status: 'unknown' }, { version: 2, status: 'unknown' }, { version: '1', status: 'unknown' },
  { version: 1, status: 'Unknown' }, { version: 1, status: 'known' }, { version: 1, status: null },
  { version: 1, status: 'unknown', calories: 0 }, { version: 1, status: 'unknown', extra: undefined },
  Object.assign(Object.create({ inherited: true }), unknownCalories()), Object.create(unknownCalories()),
  Object.defineProperty(unknownCalories(), 'hidden', { value: true }),
  Object.assign(unknownCalories(), { [Symbol('extra')]: true }),
  Object.defineProperty({ status: 'unknown' }, 'version', { value: 1, enumerable: false }),
]

describe('exact versioned workout calorie estimates', () => {
  it('allocates fresh exact markers and keeps zero known', () => {
    const first = unknownCalories(); const second = unknownCalories()
    expect(first).toStrictEqual({ version: 1, status: 'unknown' }); expect(first).not.toBe(second)
    expect(Reflect.ownKeys(first)).toEqual(['version', 'status'])
    expect(isUnknownCalories(first)).toBe(true); expect(isUnknownCalories(Object.freeze(second))).toBe(true)
    expect(isUnknownCalories(0)).toBe(false); expect(validCalorieEstimate(0, 10000)).toBe(true)
    expect(isUnknownCalories(JSON.parse(JSON.stringify(first)))).toBe(true)
  })
  it.each(malformedCalories.map((value, index) => ({ value, index })))('rejects malformed estimate $index without coercion', ({ value }) => {
    expect(isUnknownCalories(value)).toBe(false)
    expect(validCalorieEstimate(value, 10000)).toBe(false)
  })
  it('does not run marker accessors or coercion hooks', () => {
    const get = vi.fn(() => 1); const valueOf = vi.fn(() => 0)
    const marker = Object.defineProperty({ status: 'unknown' }, 'version', { get, enumerable: true })
    expect(isUnknownCalories(marker)).toBe(false); expect(validCalorieEstimate(marker, 10000)).toBe(false)
    expect(validCalorieEstimate({ valueOf }, 10000)).toBe(false)
    expect(get).not.toHaveBeenCalled(); expect(valueOf).not.toHaveBeenCalled()
  })
  it.each([0, -0, Number.MIN_VALUE, 0.125, 123.456789012345, 10000])('preserves valid finite numeric input %s within the existing workout bound', value => {
    expect(validCalorieEstimate(value, 10000)).toBe(true)
    expect(isUnknownCalories(value)).toBe(false)
  })
  it('retains distinct workout and log upper bounds', () => {
    expect(validCalorieEstimate(10000.00001, 10000)).toBe(false)
    expect(validCalorieEstimate(10000000, 10000000)).toBe(true)
    expect(validCalorieEstimate(10000000.001, 10000000)).toBe(false)
    expect(validCalorieEstimate(unknownCalories(), 0)).toBe(true)
  })
})

describe('transparent totals with known and unknown coverage', () => {
  it.each([
    { values: [], result: { knownTotal: 0, knownCount: 0, unknownCount: 0, total: 0 } },
    { values: [0], result: { knownTotal: 0, knownCount: 1, unknownCount: 0, total: 0 } },
    { values: [0, 0.125, 3.25], result: { knownTotal: 3.375, knownCount: 3, unknownCount: 0, total: 3.375 } },
    { values: [unknownCalories()], result: { knownTotal: 0, knownCount: 0, unknownCount: 1, total: null } },
    { values: [unknownCalories(), unknownCalories()], result: { knownTotal: 0, knownCount: 0, unknownCount: 2, total: null } },
    { values: [0, 0.125, unknownCalories(), 3.25], result: { knownTotal: 3.375, knownCount: 3, unknownCount: 1, total: null } },
  ])('reports exact totals and coverage for $values', ({ values, result }) => {
    const before = structuredClone(values)
    expect(summarizeCalories(values)).toEqual(result); expect(values).toEqual(before)
    const logs = values.map(log); const summary = summarizeLogs(logs)
    expect(summary).toMatchObject({ sessions: values.length, calories: result.total, knownCalories: result.knownTotal, knownCalorieSessions: result.knownCount, unknownCalorieSessions: result.unknownCount })
  })
  it('does not round or reorder numeric accumulation', () => {
    const values = Object.freeze([10000, Number.MIN_VALUE, 0.1, 0.2, 0.3333333333333])
    const originalTotal = values.reduce((sum, value) => sum + value, 0)
    expect(Object.is(summarizeCalories(values).knownTotal, originalTotal)).toBe(true)
    expect(Object.is(summarizeLogs(values.map(log)).calories, originalTotal)).toBe(true)
  })
  it('fails closed instead of treating malformed runtime data as known zero or unknown', () => {
    for (const value of [null, undefined, '0', NaN, Infinity, -1, { version: 2, status: 'unknown' }]) expect(() => summarizeCalories([value as CalorieEstimate])).toThrow('invalid')
    expect(() => summarizeCalories([Number.MAX_VALUE, Number.MAX_VALUE])).toThrow('invalid')
  })
})
