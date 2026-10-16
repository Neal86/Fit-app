import { describe, expect, it } from 'vitest'
import { freshState, parseBackup, parseState } from './storage'
import { applySessionReplacement, reviewSessionReplacement } from './sessionReplacement'
import { finishSession, previousSet, startSession } from './session'
import { pausedCloudState } from './cloud'
import type { AppState } from './types'

const setup = () => {
  const state = freshState()
  state.activeSession = startSession(state.workouts[0], Date.parse('2026-10-01T10:00:00Z'))
  state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 20; state.activeSession.restUntil = 12345
  return state
}
const sourceId = (state: AppState) => state.activeSession!.workout.exercises[0].id
const target = (state: AppState) => state.workouts.flatMap(workout => workout.exercises).find(exercise => /sec/.test(exercise.reps))!
const replace = (state: AppState) => applySessionReplacement(state, reviewSessionReplacement(state, sourceId(state), target(state)))

describe('explicit session exercise replacement', () => {
  it('replaces every unfinished row before completion with fresh identity and blank values', () => {
    const state = setup(); const original = structuredClone(state)
    const oldId = sourceId(state); const selected = target(state)
    for (const set of state.activeSession!.sets.filter(set => set.exerciseId === oldId)) Object.assign(set, { reps: 9, seconds: 30, weightKg: 22.123456789, rpe: 8, warmup: true })
    const before = structuredClone(state)
    const next = replace(state); const movement = next.activeSession!.workout.exercises[0]
    expect(movement).toEqual({ ...selected, id: expect.any(String) }); expect(movement.id).not.toBe(selected.id)
    expect(next.activeSession!.workout.exercises.some(exercise => exercise.id === oldId)).toBe(false)
    const rows = next.activeSession!.sets.filter(set => set.exerciseId === movement.id)
    expect(rows).toHaveLength(original.activeSession!.sets.filter(set => set.exerciseId === oldId).length)
    rows.forEach((set, index) => expect(set).toEqual({ id: expect.any(String), exerciseId: movement.id, setNumber: index + 1, reps: null, seconds: null, weightKg: null, rpe: null, completed: false, warmup: false }))
    expect(state).toEqual(before); expect(next.workouts).toBe(state.workouts); expect(next.logs).toBe(state.logs); expect(next.planHistory).toBe(state.planHistory)
    expect(next.activeSession).toMatchObject({ runningSince: null, elapsedSeconds: 20, restUntil: 12345 })
  })
  it('keeps sparse completed identities, numbers, exact values and ordering without object aliases', () => {
    const state = setup(); const oldId = sourceId(state)
    const rows = state.activeSession!.sets.filter(set => set.exerciseId === oldId)
    rows[1].completed = true; rows[1].weightKg = 98.123456789; rows[1].reps = 9
    rows[3].completed = true; rows[3].seconds = 45; rows[3].rpe = 7.5
    const before = structuredClone(state); const next = replace(state)
    expect(next.activeSession!.sets.filter(set => set.exerciseId === oldId)).toEqual([rows[1], rows[3]])
    expect(next.activeSession!.workout.exercises[0]).toEqual(state.activeSession!.workout.exercises[0])
    next.activeSession!.sets[0].weightKg = 0; next.activeSession!.workout.exercises[0].name = 'Changed'
    expect(state).toEqual(before)
  })
  it.each([1, 20, 21, 49, 50])('preserves exactly %i unfinished rows while keeping 1–20 planned metadata', count => {
    const state = setup(); const exerciseId = sourceId(state); const sample = state.activeSession!.sets[0]
    state.activeSession!.sets = Array.from({ length: count }, (_, index) => ({ ...sample, id: `row-${index}`, setNumber: index + 1 }))
    state.activeSession!.workout.exercises = [state.activeSession!.workout.exercises[0]]
    const next = replace(state); expect(next.activeSession!.sets).toHaveLength(count)
    expect(next.activeSession!.workout.exercises[0].sets).toBe(target(state).sets)
    expect(next.activeSession!.sets.every(set => set.exerciseId !== exerciseId)).toBe(true)
    expect(parseState(next)).toEqual(next)
  })
  it('refuses >50 imported actual rows and fully completed sources without dropping data', () => {
    const state = setup(); state.activeSession!.sets = Array.from({ length: 51 }, (_, index) => ({ ...state.activeSession!.sets[0], id: `row-${index}`, setNumber: index % 50 + 1 }))
    state.activeSession!.workout.exercises = [state.activeSession!.workout.exercises[0]]
    const before = structuredClone(state); expect(() => replace(state)).toThrow('50 session sets'); expect(state).toEqual(before)
    state.activeSession!.sets = state.activeSession!.sets.slice(0, 1); state.activeSession!.sets[0].completed = true
    expect(() => replace(state)).toThrow('no unfinished sets')
  })
  it('allows 50 exercises/2500 rows without completed source work, and blocks a 51st identity', () => {
    const state = setup(); const exercise = state.activeSession!.workout.exercises[0]; const row = state.activeSession!.sets[0]
    state.activeSession!.workout.exercises = Array.from({ length: 50 }, (_, index) => ({ ...exercise, id: `exercise-${index}` }))
    state.activeSession!.sets = state.activeSession!.workout.exercises.flatMap(exercise => Array.from({ length: 50 }, (_, index) => ({ ...row, id: `${exercise.id}-row-${index}`, exerciseId: exercise.id, setNumber: index + 1 })))
    const next = replace(state); expect(next.activeSession!.sets).toHaveLength(2500); expect(next.activeSession!.workout.exercises).toHaveLength(50)
    state.activeSession!.sets[0].completed = true
    expect(() => replace(state)).toThrow('exceed 50 exercises')
  })
  it('rejects invalid planned-set metadata without widening the shared schema', () => {
    const state = setup()
    for (const sets of [0, 21, 50]) expect(() => reviewSessionReplacement(state, sourceId(state), { ...target(state), sets })).toThrow()
  })
  it('avoids all source, selected, saved-plan, history and prior-plan IDs; collision failure is atomic', () => {
    const state = setup(); const old = structuredClone(state.activeSession!); old.id = 'previous'; old.sets[0].completed = true
    state.logs = [finishSession(old, Date.parse('2026-10-01T11:00:00Z'))]
    state.planHistory = [{ id: 'revision', savedAt: old.startedAt, label: 'Previous', workouts: structuredClone(state.workouts) }]
    const review = reviewSessionReplacement(state, sourceId(state), target(state)); const original = structuredClone(state)
    expect(() => applySessionReplacement(state, review, () => state.logs[0].sets![0].id)).toThrow('distinct replacement identities')
    expect(state).toEqual(original)
    const ids = [target(state).id, state.logs[0].sets![0].id, 'revision', 'new-exercise', 'new-exercise', 'new-set-1', 'new-set-2', 'new-set-3', 'new-set-4']
    const next = applySessionReplacement(state, review, () => ids.shift()!)
    expect(next.activeSession!.workout.exercises[0].id).toBe('new-exercise')
    expect(new Set(next.activeSession!.sets.map(set => set.id)).size).toBe(next.activeSession!.sets.length)
  })
  it('rejects clones/restores, changed content, discard, finish, forged review and replay on changed state', () => {
    const state = setup(); const review = reviewSessionReplacement(state, sourceId(state), target(state))
    expect(() => applySessionReplacement(structuredClone(state), review)).toThrow('changed')
    expect(() => applySessionReplacement({ ...state, activeSession: null }, review)).toThrow('changed')
    expect(() => applySessionReplacement(state, { ...review })).toThrow('changed')
    const next = applySessionReplacement(state, review)
    expect(() => applySessionReplacement(next, review)).toThrow('changed')
    state.activeSession!.notes = 'changed in place'
    expect(() => applySessionReplacement(state, review)).toThrow('changed')
  })
  it('supports timed-to-rep and repeated deliberate replacements without borrowing prior-set values', () => {
    let state = setup(); state = replace(state)
    const timed = state.activeSession!.workout.exercises[0]
    const row = state.activeSession!.sets.find(set => set.exerciseId === timed.id)!
    row.completed = true; row.seconds = 30
    const selected = state.workouts[0].exercises[0]
    state = applySessionReplacement(state, reviewSessionReplacement(state, timed.id, selected))
    const replacement = state.activeSession!.workout.exercises[1]
    expect(replacement.reps).toBe(selected.reps); expect(state.activeSession!.sets.find(set => set.id === row.id)).toEqual(row)
    expect(previousSet(state.logs, replacement.id, 1)).toBeUndefined()
    expect(parseState(state)).toEqual(state)
  })
  it('preserves replacements through JSON backup, shared parser, paused-cloud projection and saved logs', () => {
    const state = setup(); state.activeSession!.sets[1] = { ...state.activeSession!.sets[1], weightKg: 20.123456789, reps: 8, completed: true }
    const next = replace(state); expect(parseBackup(JSON.stringify(next))).toEqual(next)
    const cloud = pausedCloudState(next); expect(cloud.activeSession).toEqual({ ...next.activeSession, restUntil: null })
    const log = finishSession(next.activeSession!, Date.parse('2026-10-01T11:00:00Z'))
    expect(log.exerciseSnapshots).toEqual(next.activeSession!.workout.exercises.map(({ id, name, category }) => ({ id, name, category })))
    expect(log.sets).toEqual(next.activeSession!.sets)
    expect(parseState({ ...next, activeSession: null, logs: [log] }).logs[0]).toEqual(log)
  })
  it('carries reviewed requirements into only the active replacement and keeps completed source requirements', () => {
    const state = setup(); const selected = target(state)
    state.activeSession!.workout.exercises[0].equipment = ['barbell', 'bench']
    selected.equipment = ['exercise-mat']
    state.activeSession!.sets[0].completed = true
    const original = structuredClone(state)
    const review = reviewSessionReplacement(state, sourceId(state), selected)
    const next = applySessionReplacement(state, review)
    const [source, replacement] = next.activeSession!.workout.exercises
    expect(source.equipment).toEqual(['barbell', 'bench'])
    expect(replacement.equipment).toEqual(['exercise-mat'])
    expect(next.workouts).toBe(state.workouts); expect(next.logs).toBe(state.logs); expect(next.planHistory).toBe(state.planHistory)
    expect(parseBackup(JSON.stringify(next))).toEqual(next)
    replacement.equipment!.push('stability-ball')
    expect(review.replacement.equipment).toEqual(['exercise-mat'])
    expect(state).toEqual(original)
  })
  it('freezes nested reviewed requirements and keeps external selection edits out of the review', () => {
    const state = setup(); const selected = target(state)
    state.activeSession!.workout.exercises[0].equipment = []
    selected.equipment = ['exercise-mat']
    const review = reviewSessionReplacement(state, sourceId(state), selected)
    expect(Object.isFrozen(review.source.equipment)).toBe(true)
    expect(Object.isFrozen(review.replacement.equipment)).toBe(true)
    expect(() => review.source.equipment!.push('bench')).toThrow()
    expect(() => review.replacement.equipment!.push('dumbbells')).toThrow()
    selected.equipment.push('stability-ball')
    expect(review.replacement.equipment).toEqual(['exercise-mat'])
    const next = applySessionReplacement(state, review)
    expect(next.activeSession!.workout.exercises[0].equipment).toEqual(['exercise-mat'])
  })
  it('rejects a review after active requirements change and rejects malformed selected requirements', () => {
    const state = setup(); state.activeSession!.workout.exercises[0].equipment = ['bench']
    const review = reviewSessionReplacement(state, sourceId(state), target(state))
    state.activeSession!.workout.exercises[0].equipment!.push('barbell')
    expect(() => applySessionReplacement(state, review)).toThrow('changed')
    const selected = { ...target(state), equipment: ['bench', 'bench'] as ['bench', 'bench'] }
    const before = structuredClone(state)
    expect(() => reviewSessionReplacement(state, sourceId(state), selected)).toThrow()
    expect(state).toEqual(before)
  })
})
