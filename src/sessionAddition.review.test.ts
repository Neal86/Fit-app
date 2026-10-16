import { describe, expect, it, vi } from 'vitest'
import { freshState, parseBackup, parseState } from './storage'
import { startSession, finishSession, previousSet } from './session'
import { pausedCloudState } from './cloud'
import { applySessionAddition, reviewSessionAddition } from './sessionAddition'
import type { AppState, Exercise } from './types'

const at = Date.parse('2026-10-15T12:00:00Z')
const setup = () => {
  const state = freshState()
  state.activeSession = startSession(state.workouts[0], at)
  Object.assign(state.activeSession, { elapsedSeconds: 712.123, runningSince: at, restUntil: at + 30000, notes: 'Keep this exact session note' })
  Object.assign(state.activeSession.sets[0], { reps: 8, seconds: 27.25, weightKg: 99.123456789, rpe: 7.5, warmup: true, completed: true })
  Object.assign(state.activeSession.sets[1], { reps: 1, seconds: 12.5, weightKg: 0, rpe: 5.5, warmup: true })
  const historic = structuredClone(state.activeSession); historic.id = 'historic-session'
  state.logs = [finishSession(historic, at + 60000)]
  state.planHistory = [{ id: 'historic-plan', savedAt: new Date(at).toISOString(), label: 'Prior', workouts: structuredClone(state.workouts) }]
  return state
}
const selected = (sets = 3): Exercise => ({ id: 'selected-source', name: 'Independent session movement', category: 'Custom', sets, reps: '31 sec', restSeconds: 17, notes: 'User-selected exact target', equipment: ['exercise-mat'] })
const apply = (state: AppState, exercise = selected()) => applySessionAddition(state, reviewSessionAddition(state, exercise))

// Independent adversarial probes: no production code is imported from author test fixtures.
describe('independent session addition boundaries', () => {
  it.each([1, 20])('appends exactly %i blank rows and preserves every existing field and identity', count => {
    const state = setup(); const original = structuredClone(state)
    const next = apply(state, selected(count))
    const active = next.activeSession!; const old = state.activeSession!
    const movement = active.workout.exercises.at(-1)!
    expect(movement).toEqual({ ...selected(count), id: expect.any(String) })
    expect(movement.id).not.toBe('selected-source')
    expect(active.workout.exercises.slice(0, -1)).toEqual(old.workout.exercises)
    expect(active.sets.slice(0, old.sets.length)).toEqual(old.sets)
    expect({ ...active, workout: old.workout, sets: old.sets }).toEqual(old)
    expect({ ...active.workout, exercises: old.workout.exercises }).toEqual(old.workout)
    active.sets.slice(old.sets.length).forEach((row, index) => expect(row).toEqual({ id: expect.any(String), exerciseId: movement.id, setNumber: index + 1, reps: null, seconds: null, weightKg: null, rpe: null, warmup: false, completed: false }))
    expect(active.sets).toHaveLength(old.sets.length + count)
    expect(previousSet(state.logs, movement.id, 1)).toBeUndefined()
    expect(next.workouts).toBe(state.workouts); expect(next.logs).toBe(state.logs); expect(next.planHistory).toBe(state.planHistory)
    expect(state).toEqual(original); expect(parseState(next)).toEqual(next)
  })
  it('isolates all active output objects from old state and the frozen review', () => {
    const state = setup(); const source = selected(); const review = reviewSessionAddition(state, source)
    const original = structuredClone(state)
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.exercise)).toBe(true); expect(Object.isFrozen(review.exercise.equipment)).toBe(true)
    source.name = 'Changed later'; source.equipment!.push('bench')
    const next = applySessionAddition(state, review)
    next.activeSession!.workout.exercises[0].name = 'Mutated next old movement'
    next.activeSession!.sets[0].weightKg = 123
    next.activeSession!.workout.exercises.at(-1)!.equipment!.push('dumbbells')
    expect(review.exercise).toEqual(selected()); expect(state).toEqual(original)
  })
  it.each([{ equipment: undefined }, { equipment: [] }, { equipment: ['exercise-mat', 'dumbbells'] }] as const)('round trips exact equipment mode $equipment through backup and own paused-cloud projection', ({ equipment }) => {
    const state = setup(); const source = { ...selected(), equipment: equipment === undefined ? undefined : [...equipment] }
    const next = apply(state, source)
    const restored = parseBackup(JSON.stringify(next)); const copied = pausedCloudState(restored, at + 10000)
    const addition = copied.activeSession!.workout.exercises.at(-1)!
    expect(addition.equipment).toEqual(equipment)
    expect(copied.activeSession!.sets).toEqual(next.activeSession!.sets)
    expect(copied.activeSession!.runningSince).toBeNull(); expect(copied.activeSession!.restUntil).toBeNull()
    expect(copied.workouts).toEqual(state.workouts); expect(copied.planHistory).toEqual(state.planHistory); expect(copied.logs).toEqual(state.logs)
    const finished = finishSession(restored.activeSession!, at + 60000)
    expect(finished.exerciseSnapshots!.at(-1)).toEqual({ id: addition.id, name: addition.name, category: addition.category })
    expect(finished.sets).toEqual(next.activeSession!.sets)
  })
  it('reserves orphan reference IDs across log, plan history and unrelated data', () => {
    const state = setup()
    state.weightHistory.push({ id: 'independent-weight-history', date: '2026-10-15', weightKg: 75 })
    state.logs[0].workoutId = 'orphan-workout-reference'
    state.logs[0].completedExerciseIds.push('orphan-completed-reference')
    state.logs[0].exerciseSnapshots!.push({ id: 'orphan-snapshot-reference', name: 'Historical only', category: '' })
    const blocked = [state.activeSession!.id, state.activeSession!.workout.id, state.activeSession!.sets[0].id, state.workouts[0].exercises[0].id, state.logs[0].id, state.logs[0].sets![0].exerciseId, state.planHistory[0].id, state.weightHistory[0].id, 'orphan-workout-reference', 'orphan-completed-reference', 'orphan-snapshot-reference', selected().id]
    for (const id of blocked) {
      let index = 0
      const makeId = vi.fn(() => index++ === 0 ? id : `fresh-${index}`)
      const next = applySessionAddition(state, reviewSessionAddition(state, selected(1)), makeId)
      expect(next.activeSession!.workout.exercises.at(-1)!.id, id).not.toBe(id)
      expect(makeId).toHaveBeenCalledTimes(3)
    }
  })
  it('bounds collision and invalid ID failures atomically, then permits a fresh retry', () => {
    for (const invalid of ['', ' ', 'x'.repeat(151), selected().id]) {
      const state = setup(); const original = structuredClone(state); const review = reviewSessionAddition(state, selected())
      const makeId = vi.fn(() => invalid)
      expect(() => applySessionAddition(state, review, makeId)).toThrow()
      expect(makeId.mock.calls.length).toBeGreaterThan(0); expect(makeId.mock.calls.length).toBeLessThanOrEqual(100)
      expect(state).toEqual(original)
      const next = applySessionAddition(state, review)
      expect(next.activeSession!.workout.exercises).toHaveLength(state.activeSession!.workout.exercises.length + 1)
    }
  })
  it('does not return a partial append when row identity generation fails after the movement succeeds', () => {
    const state = setup(); const before = structuredClone(state); let counter = 0
    const review = reviewSessionAddition(state, selected(20))
    expect(() => applySessionAddition(state, review, () => ++counter === 1 ? 'fresh-movement' : state.activeSession!.sets[0].id)).toThrow()
    expect(state).toEqual(before)
    expect(applySessionAddition(state, review).activeSession!.sets).toHaveLength(before.activeSession!.sets.length + 20)
  })
  it('handles independent exercise/row caps without clamping selected targets', () => {
    const state = setup(); const session = state.activeSession!; const sample = session.workout.exercises[0]; const row = session.sets[0]
    session.workout.exercises = Array.from({ length: 49 }, (_, index) => ({ ...sample, id: `movement-${index}` }))
    session.sets = Array.from({ length: 2480 }, (_, index) => ({ ...row, id: `row-${index}`, exerciseId: `movement-${index % 49}`, setNumber: index % 50 + 1 }))
    const next = apply(state, selected(20))
    expect(next.activeSession!.workout.exercises).toHaveLength(50); expect(next.activeSession!.sets).toHaveLength(2500)
    expect(() => apply(next, selected(1))).toThrow()
    session.sets.push({ ...row, id: 'row-extra', exerciseId: 'movement-0' })
    const before = structuredClone(state)
    expect(() => reviewSessionAddition(state, selected(20))).toThrow()
    expect(state).toEqual(before)
    expect(apply(state, selected(19)).activeSession!.sets).toHaveLength(2500)
  })
  it.each([0, 21, 1.5, NaN, Infinity])('rejects unsupported selected planned sets %s without changing schema', sets => {
    const state = setup(); const original = structuredClone(state)
    expect(() => reviewSessionAddition(state, selected(sets))).toThrow(); expect(state).toEqual(original)
  })
  it('rejects unexpected source fields, malformed equipment and invalid current data', () => {
    const state = setup()
    for (const source of [{ ...selected(), completed: true }, { ...selected(), equipment: null }, { ...selected(), equipment: ['bench', 'bench'] }, { ...selected(), equipment: ['unrecognized'] }]) {
      expect(() => reviewSessionAddition(state, source as Exercise)).toThrow()
    }
    state.activeSession!.sets[0].weightKg = NaN
    expect(() => reviewSessionAddition(state, selected())).toThrow()
  })
  it('rejects unreviewed copies, replaced sessions, in-place edits and capacity changes at apply time', () => {
    const state = setup(); const review = reviewSessionAddition(state, selected())
    expect(() => applySessionAddition(state, { ...review })).toThrow()
    expect(() => applySessionAddition(structuredClone(state), review)).toThrow()
    expect(() => applySessionAddition({ ...state, activeSession: null }, review)).toThrow()
    state.activeSession!.workout.exercises[0].equipment = []
    expect(() => applySessionAddition(state, review)).toThrow()
  })
})
