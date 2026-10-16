// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freshState, loadState, parseBackup, parseState, saveState } from './storage'
import { applySessionAddition, reviewSessionAddition } from './sessionAddition'
import { applySessionReplacement, reviewSessionReplacement } from './sessionReplacement'
import { finishSession, previousSet, startSession } from './session'
import { pausedCloudState } from './cloud'
import { exerciseCatalog } from './exerciseCatalog'
import type { AppState, Exercise } from './types'

const startedAt = Date.parse('2026-10-01T10:00:00Z')
const finishedAt = Date.parse('2026-10-01T11:00:00Z')
const setup = () => {
  const state = freshState()
  state.activeSession = startSession(state.workouts[0], startedAt)
  Object.assign(state.activeSession, { runningSince: null, elapsedSeconds: 123.456789, restUntil: startedAt + 120000, notes: 'Keep exact session notes.' })
  return state
}
const selected = (): Exercise => ({ id: 'custom-entry', name: 'Custom pause squat', sets: 3, reps: '5–7', restSeconds: 135, category: 'Legs', notes: 'User-entered note', equipment: ['barbell', 'weight-plates'] })
const add = (state: AppState, exercise = selected()) => applySessionAddition(state, reviewSessionAddition(state, exercise))
const lastExercise = (state: AppState) => state.activeSession!.workout.exercises.at(-1)!
const addedRows = (state: AppState) => state.activeSession!.sets.filter(set => set.exerciseId === lastExercise(state).id)
const expectBlank = (state: AppState, count: number) => {
  expect(addedRows(state)).toHaveLength(count)
  addedRows(state).forEach((set, index) => expect(set).toEqual({
    id: expect.any(String), exerciseId: lastExercise(state).id, setNumber: index + 1,
    reps: null, seconds: null, weightKg: null, rpe: null, completed: false, warmup: false,
  }))
}
function withHistory(state: AppState): AppState {
  const previous = startSession(state.workouts[0], startedAt - 86400000)
  previous.id = 'history-session'
  previous.sets.forEach((set, index) => Object.assign(set, { id: `history-row-${index}`, completed: true, reps: 8, weightKg: 82.123456789, seconds: 12.5, rpe: 8.5, warmup: index === 0 }))
  state.logs = [finishSession(previous, finishedAt - 86400000)]
  state.planHistory = [{ id: 'plan-revision', savedAt: previous.startedAt, label: 'Earlier plan', workouts: structuredClone(state.workouts) }]
  return state
}
function withCapacity(exerciseCount: number, rowCount: number): AppState {
  const state = setup(); const exercise = state.activeSession!.workout.exercises[0]; const row = state.activeSession!.sets[0]
  state.activeSession!.workout.exercises = Array.from({ length: exerciseCount }, (_, index) => ({ ...exercise, id: `existing-exercise-${index}` }))
  state.activeSession!.sets = Array.from({ length: rowCount }, (_, index) => ({ ...row, id: `existing-row-${index}`, exerciseId: state.activeSession!.workout.exercises[index % exerciseCount].id, setNumber: Math.floor(index / exerciseCount) % 50 + 1 }))
  return state
}

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('reviewed session-only exercise addition', () => {
  it('appends the exact reviewed metadata and blank rows without modifying any existing data', () => {
    const state = withHistory(setup()); const chosen = selected()
    state.activeSession!.sets.forEach((set, index) => Object.assign(set, { reps: index, seconds: index + 0.5, weightKg: 98.123456789, rpe: 7.5, warmup: index % 2 === 0, completed: index % 3 === 0 }))
    const original = structuredClone(state); const review = reviewSessionAddition(state, chosen)
    expect(review).toEqual({ exercise: chosen, addedSetCount: 3 })
    const next = applySessionAddition(state, review)
    expect(lastExercise(next)).toEqual({ ...chosen, id: expect.any(String) })
    expect(lastExercise(next).id).not.toBe(chosen.id)
    expect(next.activeSession!.workout.exercises.slice(0, -1)).toEqual(original.activeSession!.workout.exercises)
    expect(next.activeSession!.sets.slice(0, -3)).toEqual(original.activeSession!.sets)
    expectBlank(next, 3)
    expect(next.activeSession).toMatchObject({ ...original.activeSession, workout: expect.any(Object), sets: expect.any(Array) })
    expect(next.activeSession!.workout).toEqual({ ...original.activeSession!.workout, exercises: [...original.activeSession!.workout.exercises, lastExercise(next)] })
    expect(state).toEqual(original)
    for (const key of ['workouts', 'logs', 'planHistory', 'nutrition', 'weightHistory', 'profile', 'preferences'] as const) expect(next[key]).toBe(state[key])
    expect(parseState(next)).toEqual(next)
  })

  it.each([1, 2, 19, 20])('adds exactly %i planned sets without clamping or borrowing values', sets => {
    const state = setup(); const next = add(state, { ...selected(), sets })
    expect(next.activeSession!.sets).toHaveLength(state.activeSession!.sets.length + sets)
    expect(lastExercise(next).sets).toBe(sets)
    expectBlank(next, sets)
  })

  it.each(['5–7', '45 sec', 'AMRAP', '30 sec / side'])('preserves the selected target %s and starts with no measurements', reps => {
    const state = withHistory(setup()); const next = add(state, { ...state.workouts[0].exercises[0], reps })
    expect(lastExercise(next).reps).toBe(reps)
    expectBlank(next, lastExercise(next).sets)
    for (const set of addedRows(next)) expect(previousSet(next.logs, set.exerciseId, set.setNumber)).toBeUndefined()
    expect(previousSet(next.logs, state.workouts[0].exercises[0].id, 1)).toBeDefined()
  })

  it('accepts library entries and multiple additions with duplicate names as distinct identities', () => {
    const state = setup(); const entry = exerciseCatalog(state.workouts)[0].exercise
    const first = add(state, entry); const firstAdded = lastExercise(first)
    const second = add(first, entry); const secondAdded = lastExercise(second)
    expect(firstAdded.name).toBe(entry.name); expect(secondAdded.name).toBe(entry.name)
    expect(new Set([entry.id, firstAdded.id, secondAdded.id]).size).toBe(3)
    expect(second.activeSession!.workout.exercises.slice(0, -1)).toEqual(first.activeSession!.workout.exercises)
    expect(second.activeSession!.sets.slice(0, -entry.sets)).toEqual(first.activeSession!.sets)
    expectBlank(second, entry.sets)
  })

  it('keeps completed session records unchanged even when all original rows are complete', () => {
    const state = withHistory(setup())
    state.activeSession!.sets.forEach((row, index) => Object.assign(row, { completed: true, setNumber: index % 50 + 1, reps: 17, weightKg: 99.123456789, seconds: 12.3456, rpe: 9.5, warmup: true }))
    const before = structuredClone(state); const next = add(state)
    expect(next.activeSession!.sets.slice(0, before.activeSession!.sets.length)).toEqual(before.activeSession!.sets)
    expect(next.logs).toEqual(before.logs); expect(next.planHistory).toEqual(before.planHistory)
    expectBlank(next, 3)
    expect(state).toEqual(before)
  })

  it.each([undefined, [], ['bench', 'dumbbells'] as Exercise['equipment']])('keeps unknown versus explicit equipment without selection or state aliases: %j', equipment => {
    const state = setup(); const chosen = selected()
    if (equipment === undefined) delete chosen.equipment
    else chosen.equipment = equipment
    const review = reviewSessionAddition(state, chosen); const before = structuredClone(state)
    const next = applySessionAddition(state, review)
    expect(lastExercise(next).equipment).toEqual(equipment)
    expect(Object.hasOwn(lastExercise(next), 'equipment')).toBe(equipment !== undefined)
    next.activeSession!.workout.exercises[0].name = 'Changed only in returned state'
    next.activeSession!.sets[0].weightKg = 0
    if (equipment !== undefined) {
      lastExercise(next).equipment!.push('exercise-mat')
      expect(chosen.equipment).toEqual(equipment)
      expect(review.exercise.equipment).toEqual(equipment)
    }
    expect(state).toEqual(before)
  })

  it('deep-freezes the reviewed selection and isolates subsequent edits to the caller’s custom entry', () => {
    const state = setup(); const chosen = selected(); const original = structuredClone(chosen)
    const review = reviewSessionAddition(state, chosen)
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.exercise)).toBe(true); expect(Object.isFrozen(review.exercise.equipment)).toBe(true)
    expect(() => Object.assign(review, { addedSetCount: 20 })).toThrow()
    expect(() => Object.assign(review.exercise, { sets: 20, name: 'Changed' })).toThrow()
    expect(() => review.exercise.equipment!.push('bench')).toThrow()
    chosen.sets = 20; chosen.name = 'Changed after review'; chosen.equipment!.push('bench')
    const next = applySessionAddition(state, review)
    expect(lastExercise(next)).toEqual({ ...original, id: expect.any(String) }); expectBlank(next, original.sets)
  })
})

describe('addition validation and review fences', () => {
  it.each([0, -1, 1.5, 20.5, 21, 50, NaN, Infinity])('rejects invalid planned-set count %s without changing state', sets => {
    const state = setup(); const before = structuredClone(state)
    expect(() => reviewSessionAddition(state, { ...selected(), sets })).toThrow()
    expect(state).toEqual(before)
  })

  it.each([
    { id: '' }, { id: ' ' }, { id: 'x'.repeat(151) }, { name: ' ' }, { name: 'x'.repeat(101) },
    { reps: '' }, { reps: 'x'.repeat(51) }, { restSeconds: -1 }, { restSeconds: 1.5 }, { restSeconds: 901 },
    { category: 'x'.repeat(101) }, { notes: 'x'.repeat(1001) }, { equipment: null }, { equipment: ['unknown'] },
    { equipment: ['bench', 'bench'] }, { equipment: new Array(1) }, { extra: 'unsupported' },
    { previousSet: { weightKg: 22 } }, { completed: true }, { sets: '3' },
  ])('rejects malformed or unsupported selected metadata: %j', fields => {
    const state = setup(); const before = structuredClone(state)
    expect(() => reviewSessionAddition(state, { ...selected(), ...fields } as Exercise)).toThrow()
    expect(state).toEqual(before)
  })

  it('requires a valid current active session and rejects forged or cloned reviews', () => {
    const state = setup(); const review = reviewSessionAddition(state, selected())
    expect(() => reviewSessionAddition(freshState(), selected())).toThrow('session changed')
    expect(() => applySessionAddition(state, { ...review })).toThrow('session changed')
    expect(() => applySessionAddition(state, structuredClone(review))).toThrow('session changed')
    expect(() => applySessionAddition(state, { exercise: selected(), addedSetCount: 3 })).toThrow('session changed')
    expect(() => reviewSessionAddition({ ...state, version: 2 } as unknown as AppState, selected())).toThrow('session changed')
    state.activeSession!.sets[0].exerciseId = 'orphan'
    expect(() => reviewSessionAddition(state, selected())).toThrow()
  })

  it.each([
    ['notes', (state: AppState) => { state.activeSession!.notes += ' changed' }],
    ['elapsed time', (state: AppState) => { state.activeSession!.elapsedSeconds += 1 }],
    ['start/pause', (state: AppState) => { state.activeSession!.runningSince = startedAt }],
    ['rest timer', (state: AppState) => { state.activeSession!.restUntil = null }],
    ['logged value', (state: AppState) => { state.activeSession!.sets[0].weightKg = 20 }],
    ['completion', (state: AppState) => { state.activeSession!.sets[0].completed = true }],
    ['exercise metadata', (state: AppState) => { state.activeSession!.workout.exercises[0].name = 'Changed' }],
    ['equipment', (state: AppState) => { state.activeSession!.workout.exercises[0].equipment = [] }],
    ['exercise order', (state: AppState) => { state.activeSession!.workout.exercises.reverse() }],
    ['row order', (state: AppState) => { state.activeSession!.sets.reverse() }],
  ] as const)('rejects an in-place %s change since review without overwriting newer work', (_label, change) => {
    const state = setup(); const review = reviewSessionAddition(state, selected()); change(state)
    const before = structuredClone(state)
    expect(() => applySessionAddition(state, review)).toThrow('session changed')
    expect(state).toEqual(before)
  })

  it('rejects reload, restore, discard, finish, a new session and replay against a successful result', () => {
    const state = setup(); state.activeSession!.sets[0].completed = true
    const review = reviewSessionAddition(state, selected())
    for (const changed of [
      structuredClone(state), parseBackup(JSON.stringify(state)), { ...state, activeSession: null },
      { ...state, activeSession: null, logs: [finishSession(state.activeSession!, finishedAt)] },
      { ...state, activeSession: startSession(state.workouts[0], startedAt) },
    ]) expect(() => applySessionAddition(changed, review)).toThrow('session changed')
    const next = applySessionAddition(state, review)
    const before = structuredClone(next)
    expect(() => applySessionAddition(next, review)).toThrow('session changed')
    expect(next).toEqual(before)
  })

  it('applies to the current state wrapper and preserves unrelated updates since review', () => {
    const state = setup(); const review = reviewSessionAddition(state, selected())
    const current = { ...state, profile: { ...state.profile, name: 'Updated profile' }, weightHistory: [{ id: 'newer-weight', date: '2026-10-01', weightKg: 75 }] }
    const ids = ['newer-weight', 'new-exercise', 'new-row-1', 'new-row-2', 'new-row-3']
    const next = applySessionAddition(current, review, () => ids.shift()!)
    expect(next.profile).toBe(current.profile); expect(next.weightHistory).toBe(current.weightHistory)
    expect(lastExercise(next).id).toBe('new-exercise')
  })

  it('revalidates the full current state at application and keeps a failed review retryable', () => {
    const state = setup(); const review = reviewSessionAddition(state, selected())
    const invalid = { ...state, profile: { ...state.profile, weightKg: Infinity } }
    const makeId = vi.fn(() => 'new-id')
    expect(() => applySessionAddition(invalid, review, makeId)).toThrow()
    expect(makeId).not.toHaveBeenCalled()
    expectBlank(applySessionAddition(state, review), 3)
  })

  it.each([[49, 2480, 20], [49, 2499, 1]] as const)('allows exact supported capacity from %i exercises and %i rows plus %i sets', (exerciseCount, rowCount, sets) => {
    const state = withCapacity(exerciseCount, rowCount); const before = structuredClone(state)
    const next = add(state, { ...selected(), sets })
    expect(next.activeSession!.workout.exercises).toHaveLength(50)
    expect(next.activeSession!.sets).toHaveLength(2500)
    expect(next.activeSession!.sets.slice(0, rowCount)).toEqual(before.activeSession!.sets)
    expectBlank(next, sets); expect(parseState(next)).toEqual(next); expect(state).toEqual(before)
  })

  it.each([[50, 50, 1, '50 exercises'], [49, 2500, 1, '2500 session sets'], [49, 2490, 20, '2500 session sets']] as const)('refuses excess capacity from %i exercises and %i rows plus %i sets', (exerciseCount, rowCount, sets, message) => {
    const state = withCapacity(exerciseCount, rowCount); const before = structuredClone(state)
    expect(() => reviewSessionAddition(state, { ...selected(), sets })).toThrow(message)
    expect(state).toEqual(before)
  })

  it('rejects already malformed session capacity without silently truncating it', () => {
    for (const state of [withCapacity(51, 51), withCapacity(49, 2501)]) {
      const before = structuredClone(state)
      expect(() => reviewSessionAddition(state, selected())).toThrow()
      expect(state).toEqual(before)
    }
  })
})

describe('fresh addition identities and atomic failure', () => {
  it('reserves every full-state identity and historical reference, including orphan workout references', () => {
    const state = withHistory(setup()); const chosen = selected()
    state.workouts[0].id = 'saved-workout'; state.workouts[0].exercises[0].id = 'saved-exercise'
    state.planHistory[0].workouts[0].id = 'revision-workout'; state.planHistory[0].workouts[0].exercises[0].id = 'revision-exercise'
    state.logs[0].workoutId = 'orphan-history-workout'
    state.logs[0].completedExerciseIds.push('orphan-completed-exercise')
    state.logs[0].exerciseSnapshots!.push({ id: 'orphan-history-snapshot', name: 'Old movement', category: 'Other' })
    state.logs[0].sets![0].exerciseId = 'orphan-set-exercise'
    state.weightHistory = [{ id: 'body-weight-record', date: '2026-10-01', weightKg: 75 }]
    state.nutrition.meals = [{ id: 'meal-record', date: '2026-10-01', mealType: 'Lunch', foodName: 'Example', serving: 'One', calories: 100, protein: 5, carbs: 10, fat: 2 }]
    state.nutrition.hydration = [{ id: 'water-record', date: '2026-10-01', milliliters: 200, note: '' }]
    const reserved = [
      state.activeSession!.id, state.activeSession!.workout.id, state.activeSession!.workout.exercises[0].id, state.activeSession!.sets[0].id,
      'saved-workout', 'saved-exercise', 'history-session', 'orphan-history-workout', 'orphan-completed-exercise', 'orphan-history-snapshot', 'history-row-0', 'orphan-set-exercise',
      'plan-revision', 'revision-workout', 'revision-exercise', 'body-weight-record', 'meal-record', 'water-record', chosen.id,
    ]
    const review = reviewSessionAddition(state, chosen); const before = structuredClone(state)
    // Exactly 19 collisions followed by a fresh ID must still fit the per-ID retry bound.
    const ids = [...reserved, 'fresh-movement', 'fresh-movement', 'fresh-row-1', 'fresh-row-1', 'fresh-row-2', 'fresh-row-2', 'fresh-row-3']
    const next = applySessionAddition(state, review, () => ids.shift()!)
    expect(lastExercise(next).id).toBe('fresh-movement')
    expect(addedRows(next).map(row => row.id)).toEqual(['fresh-row-1', 'fresh-row-2', 'fresh-row-3'])
    expect(state).toEqual(before); expect(parseState(next)).toEqual(next)
  })

  it.each(['', '   ', 'x'.repeat(151), undefined, null, 123])('bounds and rejects malformed generated ID %j without modifying state', invalid => {
    const state = setup(); const review = reviewSessionAddition(state, selected()); const before = structuredClone(state)
    const makeId = vi.fn(() => invalid as string)
    expect(() => applySessionAddition(state, review, makeId)).toThrow('distinct addition identities')
    expect(makeId).toHaveBeenCalledTimes(20); expect(state).toEqual(before)
    expectBlank(applySessionAddition(state, review), 3)
  })

  it('can skip malformed candidates and collisions before allocating valid identities', () => {
    const state = setup(); const review = reviewSessionAddition(state, selected())
    const ids = ['', undefined, ' ', 'x'.repeat(151), selected().id, 'new-exercise', 'new-exercise', 'new-row-1', 'new-row-2', 'new-row-3']
    const next = applySessionAddition(state, review, () => ids.shift()!)
    expect(lastExercise(next).id).toBe('new-exercise'); expectBlank(next, 3)
  })

  it('bounds collision exhaustion separately for a row after earlier IDs were allocated', () => {
    const state = setup(); const review = reviewSessionAddition(state, selected()); const before = structuredClone(state)
    const makeId = vi.fn().mockReturnValueOnce('new-exercise').mockReturnValueOnce('new-row-1').mockReturnValue('new-row-1')
    expect(() => applySessionAddition(state, review, makeId)).toThrow('distinct addition identities')
    expect(makeId).toHaveBeenCalledTimes(22); expect(state).toEqual(before)
    expectBlank(applySessionAddition(state, review), 3)
  })

  it('returns no partial change if the generator throws after allocating some identities', () => {
    const state = setup(); const review = reviewSessionAddition(state, selected()); const before = structuredClone(state)
    const makeId = vi.fn().mockReturnValueOnce('new-exercise').mockReturnValueOnce('new-row-1').mockImplementation(() => { throw new Error('Generator failed') })
    expect(() => applySessionAddition(state, review, makeId)).toThrow('Generator failed')
    expect(state).toEqual(before); expectBlank(applySessionAddition(state, review), 3)
  })
})

describe('addition persistence, history and later replacement', () => {
  it('round trips reload, JSON export/import and private manual-cloud projection without schema changes', () => {
    const state = withHistory(setup()); const review = reviewSessionAddition(state, selected()); const next = applySessionAddition(state, review)
    const original = structuredClone(next); const serialized = saveState(next)
    expect(JSON.parse(serialized).version).toBe(4)
    expect(loadState().state).toEqual(original); expect(loadState().error).toBe('')
    expect(parseBackup(serialized)).toEqual(original); expect(parseState(JSON.parse(serialized))).toEqual(original)
    expect(() => applySessionAddition(loadState().state, review)).toThrow('session changed')
    const paused = pausedCloudState(next, finishedAt)
    expect(paused).toEqual({ ...original, activeSession: { ...original.activeSession, restUntil: null } })
    expect(parseBackup(JSON.stringify(paused))).toEqual(paused)
    expect(paused.activeSession!.workout.exercises).toEqual(original.activeSession!.workout.exercises)
    expect(paused.activeSession!.sets).toEqual(original.activeSession!.sets)
    expect(next).toEqual(original)
  })

  it('pauses the running timer only in the manual-cloud copy and preserves the original calorie/duration estimates', () => {
    const state = setup(); state.activeSession!.runningSince = startedAt
    const next = add(state); const before = structuredClone(next)
    const paused = pausedCloudState(next, startedAt + 10000)
    expect(paused.activeSession).toMatchObject({ runningSince: null, restUntil: null, elapsedSeconds: state.activeSession!.elapsedSeconds + 10 })
    expect(paused.activeSession!.workout.duration).toBe(state.activeSession!.workout.duration)
    expect(paused.activeSession!.workout.calories).toBe(state.activeSession!.workout.calories)
    expect(paused.activeSession!.sets).toEqual(next.activeSession!.sets)
    expect(next).toEqual(before)
  })

  it('finishes with all original and added identities, exact rows and normal snapshot semantics', () => {
    const state = setup(); state.activeSession!.sets[0].completed = true
    const next = add(state); addedRows(next).forEach(row => Object.assign(row, { completed: true, reps: 6, weightKg: 10.123456789, rpe: 8.5, warmup: false }))
    const before = structuredClone(next); const log = finishSession(next.activeSession!, finishedAt)
    expect(log.exerciseSnapshots).toEqual(next.activeSession!.workout.exercises.map(({ id, name, category }) => ({ id, name, category })))
    expect(log.sets).toEqual(next.activeSession!.sets)
    expect(log.completedExerciseIds).toContain(lastExercise(next).id)
    expect(log.durationSeconds).toBe(Math.floor(state.activeSession!.elapsedSeconds))
    expect(log.calories).toBe(Math.round(state.activeSession!.workout.calories * log.durationSeconds! / (state.activeSession!.workout.duration * 60)))
    const completed = { ...next, activeSession: null, logs: [...next.logs, log] }
    expect(parseBackup(JSON.stringify(completed))).toEqual(completed)
    log.sets![0].weightKg = 0; log.exerciseSnapshots![0].name = 'History copy only'
    expect(next).toEqual(before)
  })

  it.each([false, true])('supports replacing a newly added movement while preserving completed work: %s', keepCompleted => {
    const original = withHistory(setup()); const state = add(original); const added = lastExercise(state)
    if (keepCompleted) Object.assign(addedRows(state)[0], { completed: true, reps: 7, weightKg: 88.123456789, warmup: true, rpe: 8 })
    const before = structuredClone(state); const target = { ...selected(), id: 'timed-replacement', sets: 1, reps: '45 sec', equipment: [] }
    const next = applySessionReplacement(state, reviewSessionReplacement(state, added.id, target))
    expect(next.activeSession!.workout.exercises.slice(0, original.activeSession!.workout.exercises.length)).toEqual(original.activeSession!.workout.exercises)
    expect(next.activeSession!.sets.slice(0, original.activeSession!.sets.length)).toEqual(original.activeSession!.sets)
    expect(next.activeSession!.sets.filter(row => row.exerciseId === added.id)).toEqual(keepCompleted ? [addedRows(state)[0]] : [])
    expect(lastExercise(next)).toEqual({ ...target, id: expect.any(String) })
    expectBlank(next, added.sets - Number(keepCompleted))
    expect(previousSet(next.logs, lastExercise(next).id, 1)).toBeUndefined()
    expect(next.workouts).toBe(original.workouts); expect(next.logs).toBe(original.logs); expect(next.planHistory).toBe(original.planHistory)
    expect(state).toEqual(before); expect(parseBackup(JSON.stringify(next))).toEqual(next)
  })
})
