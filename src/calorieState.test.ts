// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unknownCalories } from './calorieEstimates'
import { freshState, loadState, parseBackup, parseState, saveState, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import { validWorkout } from './stateValidation'
import type { AppState, CalorieEstimate } from './types'

const now = Date.parse('2026-10-15T10:00:00.000Z')
function stateWithSnapshots(): AppState {
  const state = freshState(); state.workouts[0].calories = unknownCalories(); state.workouts[1].calories = 0
  state.planHistory = [{ id: 'previous-plan', savedAt: new Date(now).toISOString(), label: 'Previous plan', workouts: structuredClone(state.workouts) }]
  state.activeSession = startSession(state.workouts[0], now)
  const completed = startSession(state.workouts[0], now - 60000); completed.sets[0].completed = true
  state.logs = [finishSession(completed, now)]
  return state
}
beforeEach(() => localStorage.clear())

describe('unknown estimates in version 4 state and backups', () => {
  it('round trips exact markers in plans, previous plans, active snapshots and history', () => {
    const state = stateWithSnapshots(); const before = structuredClone(state)
    const raw = saveState(state); const parsed = parseState(state)
    expect(parsed).toStrictEqual(before); expect(parsed.version).toBe(4)
    expect(loadState()).toEqual({ state: before, error: '', raw })
    expect(parseBackup(raw)).toStrictEqual(before); expect(state).toStrictEqual(before)
    expect(parsed.workouts[0].calories).not.toBe(state.workouts[0].calories)
    expect(parsed.activeSession!.workout.calories).not.toBe(state.activeSession!.workout.calories)
    expect(parsed.logs[0].calories).not.toBe(state.logs[0].calories)
    expect(parsed.planHistory[0].workouts[0].calories).not.toBe(state.planHistory[0].workouts[0].calories)
    expect(parsed.workouts[1].calories).toBe(0)
  })
  it.each([null, undefined, '0', 'unknown', NaN, Infinity, -Infinity, -1, 10000.1, {}, [], { version: 1 }, { status: 'unknown' }, { version: 2, status: 'unknown' }, { version: 1, status: 'unknown', extra: 0 }])('rejects invalid workout estimates %j before overwriting storage', calories => {
    const saved = saveState(freshState()); const invalid = stateWithSnapshots()
    invalid.workouts[0].calories = calories as CalorieEstimate
    const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(validWorkout(invalid.workouts[0])).toBe(false); expect(() => saveState(invalid)).toThrow()
    expect(write).not.toHaveBeenCalled(); expect(localStorage.getItem(STORAGE_KEY)).toBe(saved)
    write.mockRestore()
  })
  it('retains the log numeric bound and accepts its exact upper limit', () => {
    const state = stateWithSnapshots(); state.logs[0].calories = 10000000
    expect(parseState(state).logs[0].calories).toBe(10000000)
    state.logs[0].calories = 10000000.1
    expect(() => parseState(state)).toThrow()
  })
  it.each(['workouts', 'active', 'history', 'logs'])('rejects invalid markers in %s without altering the input or stored recovery bytes', destination => {
    const state = stateWithSnapshots()
    const owner = destination === 'workouts' ? state.workouts[0] : destination === 'active' ? state.activeSession!.workout : destination === 'history' ? state.planHistory[0].workouts[0] : state.logs[0]
    Object.assign(owner, { calories: { version: 1, status: 'unknown', extra: true } })
    const source = JSON.stringify(state); localStorage.setItem(STORAGE_KEY, source)
    expect(() => parseBackup(source)).toThrow(); expect(loadState().error).not.toBe('')
    expect(loadState().raw).toBe(source); expect(localStorage.getItem(STORAGE_KEY)).toBe(source); expect(JSON.stringify(state)).toBe(source)
  })
  it.each(['profile', 'exercise', 'set', 'nutrition', 'root', 'array', 'alias', 'owner-alias', 'array-extra'])('rejects marker placement in %s', destination => {
    const state = stateWithSnapshots()
    if (destination === 'profile') Object.assign(state.profile, { calories: unknownCalories() })
    if (destination === 'exercise') Object.assign(state.workouts[0].exercises[0], { calories: unknownCalories() })
    if (destination === 'set') Object.assign(state.activeSession!.sets[0], { calories: unknownCalories() })
    if (destination === 'nutrition') state.nutrition.targets = [{ date: '2026-10-15', calories: unknownCalories() as unknown as number, protein: 0, carbs: 0, fat: 0, milliliters: 0 }]
    if (destination === 'root') Object.assign(state, { unknownCalories: unknownCalories() })
    if (destination === 'array') Object.defineProperty(state.logs, 'metadata', { value: unknownCalories() })
    if (destination === 'alias') Object.defineProperty(state.logs, 'metadata', { value: state.workouts[0].calories })
    if (destination === 'owner-alias') Object.defineProperty(state.logs, 'metadata', { value: state.workouts[0] })
    if (destination === 'array-extra') Object.assign(state.workouts, { metadata: { calories: unknownCalories() } })
    expect(() => parseState(state)).toThrow()
  })
  it.each(['workouts', 'logs', 'history', 'active', 'revision', 'workout-index', 'log-index', 'history-index'])('rejects a marker beneath a non-serializable %s ancestor', destination => {
    const state = stateWithSnapshots()
    if (destination === 'workouts') Object.defineProperty(state, 'workouts', { enumerable: false })
    if (destination === 'logs') Object.defineProperty(state, 'logs', { enumerable: false })
    if (destination === 'history') Object.defineProperty(state, 'planHistory', { enumerable: false })
    if (destination === 'active') Object.defineProperty(state.activeSession!, 'workout', { enumerable: false })
    if (destination === 'revision') Object.defineProperty(state.planHistory[0], 'workouts', { enumerable: false })
    if (destination === 'workout-index') Object.defineProperty(state.workouts, '0', { enumerable: false })
    if (destination === 'log-index') Object.defineProperty(state.logs, '0', { enumerable: false })
    if (destination === 'history-index') Object.defineProperty(state.planHistory, '0', { enumerable: false })
    expect(() => parseState(state)).toThrow()
  })
  it.each(['root', 'session', 'revision', 'array'])('rejects inherited marker-containing %s ancestry before cloning', destination => {
    const state = stateWithSnapshots()
    const owner = destination === 'root' ? state : destination === 'session' ? state.activeSession! : destination === 'revision' ? state.planHistory[0] : state.workouts
    const key = destination === 'root' || destination === 'revision' ? 'workouts' : destination === 'session' ? 'workout' : '0'
    const value = Object.getOwnPropertyDescriptor(owner, key)!.value
    Reflect.deleteProperty(owner, key); Object.setPrototypeOf(owner, { [key]: value })
    expect(() => parseState(state)).toThrow()
  })
  it('leaves nutrition values and zero semantics unchanged', () => {
    const state = stateWithSnapshots()
    state.nutrition.meals = [{ id: 'meal', date: '2026-10-15', mealType: 'Snack', foodName: 'Synthetic food', serving: 'One serving', calories: 0.125, protein: 1.25, carbs: 0, fat: 0 }]
    state.nutrition.targets = [{ date: '2026-10-15', calories: 0, protein: 0, carbs: 0, fat: 0, milliliters: 0 }]
    expect(parseState(state).nutrition).toStrictEqual(state.nutrition)
    state.nutrition.meals[0].calories = unknownCalories() as unknown as number
    expect(() => parseState(state)).toThrow()
  })
})

describe('migration never discards unsupported calorie metadata', () => {
  it.each([2, 3])('preserves every legacy numeric value and identity while migrating version %s', version => {
    const state = stateWithSnapshots(); state.workouts[0].calories = 123.456789012345
    state.activeSession!.workout.calories = 0.125; state.logs[0].calories = 9999999.125
    state.planHistory[0].workouts[0].calories = 0
    const legacy = { ...state, version }; const before = structuredClone(legacy); const parsed = parseState(legacy)
    expect(parsed).toStrictEqual({ ...before, version: 4, activeSession: version === 2 ? null : before.activeSession })
    expect(legacy).toStrictEqual(before)
  })
  it('keeps signed numeric zero unchanged in direct state validation', () => {
    const state = freshState(); state.workouts[0].calories = -0
    expect(Object.is(parseState(state).workouts[0].calories, -0)).toBe(true)
  })
  it.each([2, 3].flatMap(version => ['workouts', 'logs', 'history', 'active', 'ignored-nested', 'ignored-hidden'].map(destination => ({ version, destination }))))('rejects version $version markers in $destination before migration', ({ version, destination }) => {
    const state = freshState(); const legacy = { ...state, version } as Record<string, unknown>
    if (destination === 'workouts') state.workouts[0].calories = unknownCalories()
    if (destination === 'logs') legacy.logs = stateWithSnapshots().logs
    if (destination === 'history') legacy.planHistory = stateWithSnapshots().planHistory
    if (destination === 'active') legacy.activeSession = stateWithSnapshots().activeSession
    if (destination === 'ignored-nested') legacy.activeSession = { ignored: { nested: unknownCalories() } }
    if (destination === 'ignored-hidden') legacy.activeSession = Object.defineProperty({}, 'ignored', { value: unknownCalories() })
    const before = JSON.stringify(legacy)
    expect(() => parseState(legacy)).toThrow(/version 4/); expect(JSON.stringify(legacy)).toBe(before)
  })
  it.each([null, undefined, 'unknown', {}, { version: 1 }, { version: 2, status: 'unknown' }, { version: 1, status: 'unknown', extra: true }])('rejects malformed ignored legacy calorie values %j', calories => {
    const legacy = { ...freshState(), version: 2, activeSession: { workout: { calories } } }
    expect(() => parseState(legacy)).toThrow()
  })
  it('inspects legacy fields without invoking getter-based markers', () => {
    const get = vi.fn(() => unknownCalories())
    const ignored = Object.defineProperty({}, 'hidden', { get, enumerable: true })
    expect(() => parseState({ ...freshState(), version: 2, activeSession: ignored })).toThrow()
    expect(get).not.toHaveBeenCalled()
  })
})
