import { describe, expect, it, vi } from 'vitest'
import { freshState, parseBackup, parseState } from './storage'
import { startSession } from './session'
import type { AppState } from './types'

const now = Date.parse('2026-10-16T12:00:00.000Z')
const marker = () => ({ version: 1, status: 'unknown' })
const locations = ['workout', 'active', 'log', 'revision'] as const
type Location = typeof locations[number]
function placed(location: Location, calories: unknown): AppState {
  const state = freshState()
  if (location === 'workout') Object.assign(state.workouts[0], { calories })
  if (location === 'active') { state.activeSession = startSession(state.workouts[0], now); Object.assign(state.activeSession.workout, { calories }) }
  if (location === 'log') { state.logs = [{ id: 'past-session', workoutId: 'historic-reference', title: 'Historical session', startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), duration: 0, calories: 0, completedExerciseIds: [] }]; Object.assign(state.logs[0], { calories }) }
  if (location === 'revision') { state.planHistory = [{ id: 'prior-plan', savedAt: new Date(now).toISOString(), label: 'Old plan', workouts: structuredClone(state.workouts) }]; Object.assign(state.planHistory[0].workouts[0], { calories }) }
  return state
}
function extracted(state: AppState, location: Location) {
  if (location === 'workout') return state.workouts[0].calories
  if (location === 'active') return state.activeSession!.workout.calories
  if (location === 'log') return state.logs[0].calories
  return state.planHistory[0].workouts[0].calories
}
const invalidJson: [string, unknown][] = [
  ['null', null], ['undefined', undefined], ['blank', ''], ['numeric string', '0'], ['unknown string', 'unknown'], ['false', false], ['array', []], ['empty object', {}],
  ['missing version', { status: 'unknown' }], ['missing status', { version: 1 }], ['future version', { version: 2, status: 'unknown' }], ['string version', { version: '1', status: 'unknown' }],
  ['null version', { version: null, status: 'unknown' }], ['unknown status spelling', { version: 1, status: 'Unknown' }], ['numeric status', { version: 1, status: 0 }],
  ['known status without number', { version: 1, status: 'known' }], ['extra value', { version: 1, status: 'unknown', value: 0 }], ['extra undefined', { version: 1, status: 'unknown', value: undefined }],
  ['negative', -Number.MIN_VALUE], ['NaN', NaN], ['Infinity', Infinity], ['boxed zero', new Number(0)],
]

describe('independent explicit unknown workout calorie contract', () => {
  it.each(locations)('preserves the exact marker in %s without changing AppState version', location => {
    const value = marker(); const state = placed(location, value); const parsed = parseState(state)
    expect(parsed).toEqual(state); expect(parsed.version).toBe(4); expect(extracted(parsed, location)).toEqual(value); expect(extracted(parsed, location)).not.toBe(value)
    expect(parseBackup(JSON.stringify(state))).toEqual(state)
  })
  for (const location of locations) {
    it.each(invalidJson)(`rejects ${location} %s without mutating input`, (_name, value) => {
      const state = placed(location, value); const before = JSON.stringify(state)
      expect(() => parseState(state)).toThrow(); expect(JSON.stringify(state)).toBe(before)
    })
    it(`preserves existing ${location} numeric precision, bounds, and explicit zero`, () => {
      const max = location === 'log' ? 10000000 : 10000
      for (const value of [0, Number.MIN_VALUE, 0.125, 217.123456789123, max]) {
        const state = placed(location, value); expect(extracted(parseState(state), location)).toBe(value); expect(extracted(parseBackup(JSON.stringify(state)), location)).toBe(value)
      }
      expect(() => parseState(placed(location, max + 0.0001))).toThrow()
    })
  }
  it('rejects exact-looking markers with inherited, hidden, symbolic, or accessor-owned data without invoking a marker getter', () => {
    const inheritedVersion = Object.assign(Object.create({ version: 1 }), { status: 'unknown' })
    const inheritedStatus = Object.assign(Object.create({ status: 'unknown' }), { version: 1 })
    const hiddenExtra = Object.defineProperty(marker(), 'extra', { value: 0 })
    const hiddenVersion = Object.defineProperty({ status: 'unknown' }, 'version', { value: 1 })
    const symbolExtra = Object.assign(marker(), { [Symbol('extra')]: 0 })
    const getter = vi.fn(() => 'unknown'); const accessor = Object.defineProperty({ version: 1 }, 'status', { enumerable: true, get: getter })
    const customPrototype = Object.setPrototypeOf(marker(), { covert: 'retained data' })
    for (const value of [inheritedVersion, inheritedStatus, hiddenExtra, hiddenVersion, symbolExtra, accessor, customPrototype]) expect(() => parseState(placed('workout', value))).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it('rejects unknown marker aliases and hidden placement outside the four calorie fields', () => {
    for (const container of ['root', 'profile', 'exercise', 'nutrition'] as const) {
      const state = placed('workout', marker()); const value = state.workouts[0].calories
      const owner = container === 'root' ? state : container === 'profile' ? state.profile : container === 'exercise' ? state.workouts[0].exercises[0] : state.nutrition
      Object.defineProperty(owner, 'hiddenMarker', { value, enumerable: false })
      expect(() => parseState(state), container).toThrow()
    }
  })
  it.each(locations)('rejects inherited owner calorie fields in %s instead of cloning away the marker', location => {
    const state = placed(location, marker()); const owner = location === 'workout' ? state.workouts[0] : location === 'active' ? state.activeSession!.workout : location === 'log' ? state.logs[0] : state.planHistory[0].workouts[0]
    Reflect.deleteProperty(owner, 'calories'); Object.setPrototypeOf(owner, { calories: marker() })
    expect(() => parseState(state)).toThrow()
    if (location === 'workout') expect(() => startSession(state.workouts[0], now)).toThrow()
  })
  it.each(['hidden-root', 'inherited-root', 'hidden-active-workout', 'inherited-active-workout', 'hidden-revision-workouts', 'hidden-workout-index'] as const)('rejects marker serialization-loss ancestry: %s', kind => {
    const state = placed('workout', marker())
    if (kind === 'hidden-root') Object.defineProperty(state, 'workouts', { enumerable: false })
    if (kind === 'inherited-root') { const workouts = state.workouts; Reflect.deleteProperty(state, 'workouts'); Object.setPrototypeOf(state, { workouts }) }
    if (kind === 'hidden-active-workout' || kind === 'inherited-active-workout') {
      state.activeSession = startSession(state.workouts[0], now); state.workouts[0].calories = 0
      if (kind === 'hidden-active-workout') Object.defineProperty(state.activeSession, 'workout', { enumerable: false })
      else { const workout = state.activeSession.workout; Reflect.deleteProperty(state.activeSession, 'workout'); Object.setPrototypeOf(state.activeSession, { workout }) }
    }
    if (kind === 'hidden-revision-workouts') {
      state.planHistory = [{ id: 'prior', savedAt: new Date(now).toISOString(), label: 'Before', workouts: structuredClone(state.workouts) }]; state.workouts[0].calories = 0
      Object.defineProperty(state.planHistory[0], 'workouts', { enumerable: false })
    }
    if (kind === 'hidden-workout-index') Object.defineProperty(state.workouts, '0', { enumerable: false })
    expect(() => parseState(state)).toThrow()
  })
  it.each([2, 3])('rejects unknown markers in every workout-calorie position in legacy version %i', version => {
    for (const location of locations) {
      const state = { ...placed(location, marker()), version }
      expect(() => parseState(state), location).toThrow()
    }
  })
  it.each([2, 3])('rejects exact markers anywhere in version %i before migration can ignore data', version => {
    for (const wrapper of [marker(), { ignored: marker() }, { ignored: [marker()] }, { ignored: { nested: marker() } }]) {
      expect(() => parseState({ ...freshState(), version, activeSession: wrapper })).toThrow()
    }
    // Version 2 otherwise ignores this whole object, so these probes cannot pass by ordinary active-session validation.
    const hidden = Object.defineProperty({}, 'ignored', { value: marker(), enumerable: false })
    const symbolic = { [Symbol('ignored')]: marker() }
    expect(() => parseState({ ...freshState(), version, activeSession: hidden })).toThrow()
    expect(() => parseState({ ...freshState(), version, activeSession: symbolic })).toThrow()
  })
  it('retains compatible old v2 migration and accepts v3/v4 numeric fractions without widening nutrition', () => {
    for (const version of [2, 3, 4]) {
      const state = { ...placed('workout', 0.125), version }; expect(parseState(state).workouts[0].calories).toBe(0.125)
    }
    const legacy = { ...freshState(), version: 2, activeSession: { ignored: 'numeric-era data' } }; expect(parseState(legacy).activeSession).toBeNull()
    for (const version of [2, 3, 4]) {
      const state = { ...freshState(), version }
      Object.assign(state.nutrition, { meals: [{ id: 'meal', date: '2026-10-16', mealType: 'Lunch', foodName: 'Food', serving: '', protein: 0, carbs: 0, fat: 0, calories: marker() }] })
      expect(() => parseState(state)).toThrow()
      state.nutrition.meals = []
      Object.assign(state.nutrition, { targets: [{ date: '2026-10-16', protein: 0, carbs: 0, fat: 0, milliliters: 0, calories: marker() }] })
      expect(() => parseState(state)).toThrow()
    }
  })
})
