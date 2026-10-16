import { describe, expect, it } from 'vitest'
import { EQUIPMENT_OPTIONS } from './equipment'
import { freshState, parseState, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import type { AppState } from './types'

const stamp = Date.parse('2026-10-01T10:00:00Z')
function snapshots() {
  const state = freshState()
  state.activeSession = startSession(state.workouts[0], stamp)
  state.planHistory = [{ id: 'old-plan', savedAt: new Date(stamp).toISOString(), label: 'Previous plan', workouts: structuredClone(state.workouts) }]
  return state
}
const snapshotLocations = [
  { label: 'saved plan', exercises: (state: AppState) => state.workouts[0].exercises },
  { label: 'active session', exercises: (state: AppState) => state.activeSession!.workout.exercises },
  { label: 'previous plan', exercises: (state: AppState) => state.planHistory[0].workouts[0].exercises },
]

describe('shared optional equipment validation', () => {
  it.each([2, 3, 4])('loads version %i without inferring classifications or changing unrelated fields', version => {
    const state = snapshots()
    state.activeSession = null
    const source = { ...state, version }
    const original = structuredClone(source)
    expect(parseState(source)).toEqual(state)
    expect(source).toEqual(original)
    for (const workout of parseState(source).workouts) for (const exercise of workout.exercises) expect(Object.hasOwn(exercise, 'equipment')).toBe(false)
    expect(STORAGE_KEY).toBe('fit-app-state-v2')
  })
  for (const location of snapshotLocations) {
    it.each([undefined, [], ['bench', 'barbell'], EQUIPMENT_OPTIONS.map(option => option.id)])(`preserves valid metadata %j in ${location.label} without aliasing`, equipment => {
      const state = snapshots()
      Object.assign(location.exercises(state)[0], { equipment })
      const parsed = parseState(state)
      expect(parsed).toEqual(state)
      if (equipment !== undefined) {
        location.exercises(parsed)[0].equipment!.pop()
        expect(location.exercises(state)[0].equipment).toEqual(equipment)
      }
    })
    it.each([
      null, 'barbell', {}, ['unsupported'], ['bench', 'bench'], ['Barbell'], ['bench', null], [undefined], [1], new Array(1), Array(18).fill('bench'),
    ])(`rejects malformed metadata %j in ${location.label} without changing the source`, equipment => {
      const state = snapshots()
      Object.assign(location.exercises(state)[0], { equipment })
      const original = structuredClone(state)
      expect(() => parseState(state)).toThrow()
      expect(state).toEqual(original)
    })
  }
  it('keeps completed log snapshots limited to their historical identity fields', () => {
    const state = freshState(); state.workouts[0].exercises[0].equipment = ['barbell', 'bench']
    const active = startSession(state.workouts[0], stamp); active.sets[0].completed = true
    const log = finishSession(active, stamp + 60_000)
    expect(log.exerciseSnapshots).toEqual(state.workouts[0].exercises.map(({ id, name, category }) => ({ id, name, category })))
    expect(parseState({ ...state, logs: [log] }).logs).toEqual([log])
    Object.assign(log.exerciseSnapshots![0], { equipment: ['barbell'] })
    expect(() => parseState({ ...state, logs: [log] })).toThrow()
  })
  it('still rejects unknown exercise fields alongside supported equipment', () => {
    const state = freshState(); Object.assign(state.workouts[0].exercises[0], { equipment: [], equipmentNotes: 'Hidden extra data' })
    expect(() => parseState(state)).toThrow()
  })
})
