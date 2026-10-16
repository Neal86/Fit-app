import { describe, expect, it, vi } from 'vitest'
import { freshState, parseBackup, parseState } from './storage'
import { elapsedSeconds, finishSession, setSessionCompletion, startSession } from './session'
import { applySessionGrouping, applySessionGroupRemoval, reviewSessionGrouping, reviewSessionGroupRemoval } from './sessionGrouping'
import { applySessionReplacement, reviewSessionReplacement } from './sessionReplacement'
import { applySessionAddition, reviewSessionAddition } from './sessionAddition'
import { pausedCloudState } from './cloud'
import type { AppState, Exercise } from './types'

const at = Date.parse('2026-10-15T12:00:00Z')
const setup = () => {
  const state = freshState(); state.activeSession = startSession(state.workouts[0], at)
  Object.assign(state.activeSession, { runningSince: null, elapsedSeconds: 123.456, restUntil: at + 120000, notes: 'Exact note' })
  state.activeSession.sets.forEach(row => { row.reps = 8 })
  return state
}
const selection = (state: AppState, restSeconds = 37) => {
  const session = state.activeSession!
  const rows = session.workout.exercises.slice(0, 2).map(exercise => session.sets.filter(row => row.exerciseId === exercise.id))
  return { name: 'Exact grouping', restSeconds, rounds: [0, 1].map(index => rows.map(sets => sets[index].id)) }
}
const create = (state = setup(), rest = 37) => applySessionGrouping(state, reviewSessionGrouping(state, selection(state, rest)))
const selected: Exercise = { id: 'replacement-source', name: 'Replacement only', category: 'Custom', sets: 1, reps: '8', restSeconds: 12 }
const complete = (state: AppState, id: string, now = at, weight: number | null = null) => setSessionCompletion(state, id, true, weight, now)

describe('independent grouping review and identity safety', () => {
  it('only attaches exact selected rows in exact round order, leaves every metric and extra row unchanged', () => {
    const state = setup(); const before = structuredClone(state); const chosen = selection(state)
    chosen.rounds[0][0] = state.activeSession!.sets[2].id
    const next = applySessionGrouping(state, reviewSessionGrouping(state, chosen))
    const group = next.activeSession!.grouping!.groups[0]
    expect(group.rounds.map(round => round.setIds)).toEqual(chosen.rounds)
    expect({ ...next.activeSession, grouping: undefined }).toEqual({ ...state.activeSession, grouping: undefined })
    expect(next.workouts).toBe(state.workouts); expect(next.logs).toBe(state.logs); expect(next.planHistory).toBe(state.planHistory)
    expect(state).toEqual(before); expect(parseState(next)).toEqual(next)
  })
  it('deep-freezes review labels, row snapshots and source selection independent of later caller mutation', () => {
    const state = setup(); const chosen = selection(state); const expected = structuredClone(chosen)
    const review = reviewSessionGrouping(state, chosen)
    chosen.name = 'Late name'; chosen.rounds[0][0] = 'Late row'
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.rounds)).toBe(true)
    for (const round of review.rounds) {
      expect(Object.isFrozen(round)).toBe(true); expect(Object.isFrozen(round.setIds)).toBe(true); expect(Object.isFrozen(round.rows)).toBe(true)
      round.rows.forEach(row => { expect(Object.isFrozen(row)).toBe(true); expect(Object.isFrozen(row.set)).toBe(true); expect(Object.isFrozen(row.exercise)).toBe(true) })
    }
    const next = applySessionGrouping(state, review)
    expect(next.activeSession!.grouping!.groups[0].name).toBe(expected.name)
    expect(next.activeSession!.grouping!.groups[0].rounds.map(round => round.setIds)).toEqual(expected.rounds)
  })
  it.each(['completed', 'warmup', 'duplicate', 'missing', 'same exercise', 'reordered round', 'sparse round'])('rejects invalid explicit selection: %s', defect => {
    const state = setup(); const chosen = selection(state)
    if (defect === 'completed') state.activeSession!.sets[0].completed = true
    if (defect === 'warmup') state.activeSession!.sets[0].warmup = true
    if (defect === 'duplicate') chosen.rounds[1][0] = chosen.rounds[0][0]
    if (defect === 'missing') chosen.rounds[0][0] = 'missing'
    if (defect === 'same exercise') chosen.rounds[0][1] = state.activeSession!.sets[2].id
    if (defect === 'reordered round') chosen.rounds[1].reverse()
    if (defect === 'sparse round') delete chosen.rounds[0][0]
    const before = structuredClone(state); expect(() => reviewSessionGrouping(state, chosen)).toThrow(); expect(state).toEqual(before)
  })
  it('rejects already grouped rows, forged reviews, cloned source, and in-place changed source', () => {
    const state = setup(); const review = reviewSessionGrouping(state, selection(state))
    expect(() => applySessionGrouping(state, { ...review })).toThrow()
    expect(() => applySessionGrouping(structuredClone(state), review)).toThrow()
    const next = applySessionGrouping(state, review)
    expect(() => reviewSessionGrouping(next, selection(next))).toThrow()
    state.activeSession!.notes = 'Changed'; expect(() => applySessionGrouping(state, review)).toThrow()
  })
  it('reserves all state IDs, orphan references and historic group/round references when allocating', () => {
    const state = setup(); const historical = create(structuredClone(state)); historical.activeSession!.id = 'historical'
    historical.activeSession!.sets[0].completed = true
    state.logs = [finishSession(historical.activeSession!, at + 60000)]
    state.logs[0].workoutId = 'orphan-workout'; state.logs[0].completedExerciseIds.push('orphan-completed')
    state.planHistory = [{ id: 'prior-plan', label: 'Prior', savedAt: new Date(at).toISOString(), workouts: structuredClone(state.workouts) }]
    state.weightHistory = [{ id: 'prior-weight', date: '2026-10-15', weightKg: 75 }]
    const blocked = [state.activeSession!.id, state.activeSession!.workout.id, state.activeSession!.sets[0].id, state.activeSession!.sets[0].exerciseId, 'historical', 'orphan-workout', 'orphan-completed', 'prior-plan', 'prior-weight', state.logs[0].grouping!.groups[0].id, state.logs[0].grouping!.groups[0].rounds[0].id]
    for (const id of blocked) {
      let i = 0; const allocate = vi.fn(() => i++ === 0 ? id : `independent-${i}`)
      const result = applySessionGrouping(state, reviewSessionGrouping(state, selection(state)), allocate)
      expect(result.activeSession!.grouping!.groups[0].id, id).not.toBe(id); expect(allocate).toHaveBeenCalledTimes(4)
    }
  })
  it('bounds failed identity generation without partial output and permits exact retry of original review', () => {
    const state = setup(); const before = structuredClone(state); const review = reviewSessionGrouping(state, selection(state))
    for (const id of ['', ' ', 'x'.repeat(151), state.activeSession!.id]) {
      const allocate = vi.fn(() => id); expect(() => applySessionGrouping(state, review, allocate)).toThrow()
      expect(allocate.mock.calls.length).toBeLessThanOrEqual(100); expect(state).toEqual(before)
    }
    let i = 0; expect(() => applySessionGrouping(state, review, () => ++i === 1 ? 'fresh-group' : state.activeSession!.id)).toThrow()
    expect(state).toEqual(before); expect(applySessionGrouping(state, review).activeSession!.grouping!.groups).toHaveLength(1)
  })
  it('removes only reviewed metadata after every current completion is undone and deletes empty wrapper', () => {
    const state = create(); const group = state.activeSession!.grouping!.groups[0]
    const completed = complete(state, group.rounds[0].setIds[0])
    expect(() => reviewSessionGroupRemoval(completed, group.id)).toThrow()
    const undone = setSessionCompletion(completed, group.rounds[0].setIds[0], false, null, at + 5000)
    const review = reviewSessionGroupRemoval(undone, group.id); const before = structuredClone(undone)
    expect(Object.isFrozen(review.group.rounds[0].setIds)).toBe(true)
    const removed = applySessionGroupRemoval(undone, review)
    expect(removed.activeSession!.grouping).toBeUndefined()
    expect(removed.activeSession).toEqual({ ...undone.activeSession, grouping: undefined })
    expect(undone).toEqual(before)
    expect(() => applySessionGroupRemoval(complete(undone, group.rounds[0].setIds[0]), review)).toThrow()
  })
  it('replacement preserves exact old-to-new membership and all completed references after a partial round', () => {
    const state = create(); const session = state.activeSession!; const old = structuredClone(session.grouping!)
    const completedId = old.groups[0].rounds[0].setIds[0]
    const partial = complete(state, completedId, at + 1000, 51.234567)
    const sourceId = partial.activeSession!.sets.find(row => row.id === completedId)!.exerciseId
    const review = reviewSessionReplacement(partial, sourceId, selected)
    const result = applySessionReplacement(partial, review)
    const fresh = result.activeSession!.sets.filter(row => !partial.activeSession!.sets.some(oldRow => oldRow.id === row.id))
    const mapping = new Map(review.removedSets.map((row, index) => [row.id, fresh[index].id]))
    const expected = structuredClone(old); expected.groups.forEach(group => group.rounds.forEach(round => { round.setIds = round.setIds.map(id => mapping.get(id) ?? id) }))
    expect(result.activeSession!.grouping).toEqual(expected)
    expect(result.activeSession!.sets.find(row => row.id === completedId)).toEqual(partial.activeSession!.sets.find(row => row.id === completedId))
    fresh.forEach(row => expect(row).toMatchObject({ completed: false, reps: null, seconds: null, weightKg: null, rpe: null, warmup: false }))
    expect(result.activeSession!.restUntil).toBe(partial.activeSession!.restUntil)
    expect(result.workouts).toBe(state.workouts); expect(result.logs).toBe(state.logs)
    expect(parseState(result)).toEqual(result)
  })
  it('addition creates ungrouped rows and deep-copies grouping alongside finish and private cloud pause', () => {
    const state = create(); const next = applySessionAddition(state, reviewSessionAddition(state, selected))
    expect(next.activeSession!.grouping).toEqual(state.activeSession!.grouping)
    const members = next.activeSession!.grouping!.groups.flatMap(group => group.rounds.flatMap(round => round.setIds))
    next.activeSession!.sets.filter(row => !state.activeSession!.sets.some(old => old.id === row.id)).forEach(row => expect(members).not.toContain(row.id))
    const partial = complete(next, members[0]); const log = finishSession(partial.activeSession!, at + 60000)
    expect(log.grouping).toEqual(partial.activeSession!.grouping); expect(log.grouping).not.toBe(partial.activeSession!.grouping)
    expect(log.sets).toEqual(partial.activeSession!.sets)
    expect(log.exerciseSnapshots).toEqual(partial.activeSession!.workout.exercises.map(({ id, name, category }) => ({ id, name, category })))
    const paused = pausedCloudState(partial, at + 60000)
    expect(paused.activeSession!.grouping).toEqual(partial.activeSession!.grouping); expect(paused.activeSession!.restUntil).toBeNull()
    expect(parseBackup(JSON.stringify(partial))).toEqual(partial)
  })
})

describe('independent desired-state round rest transitions', () => {
  it.each([null, at - 1000, at + 120000])('preserves timer %s through intermediate, undo and repeat completion but replaces only final transition', timer => {
    let state = create(); state.activeSession!.restUntil = timer
    const rounds = state.activeSession!.grouping!.groups[0].rounds
    const originalElapsed = elapsedSeconds(state.activeSession!, at + 99999)
    // Finish the later round first and its second member first.
    state = complete(state, rounds[1].setIds[1], at + 1000)
    expect(state.activeSession!.restUntil).toBe(timer)
    state = complete(state, rounds[1].setIds[0], at + 2000)
    expect(state.activeSession!.restUntil).toBe(at + 39000)
    expect(setSessionCompletion(state, rounds[1].setIds[0], true, 999, at + 5000)).toBe(state)
    const restored = parseBackup(JSON.stringify(state)); expect(restored.activeSession!.restUntil).toBe(at + 39000)
    state = setSessionCompletion(state, rounds[1].setIds[1], false, null, at + 10000)
    expect(state.activeSession!.restUntil).toBe(at + 39000)
    state = complete(state, rounds[0].setIds[0], at + 11000); expect(state.activeSession!.restUntil).toBe(at + 39000)
    state = complete(state, rounds[1].setIds[1], at + 12000); expect(state.activeSession!.restUntil).toBe(at + 49000)
    state = complete(state, rounds[0].setIds[1], at + 13000); expect(state.activeSession!.restUntil).toBe(at + 50000)
    expect(elapsedSeconds(state.activeSession!, at + 99999)).toBe(originalElapsed); expect(state.activeSession!.runningSince).toBeNull()
  })
  it.each([null, at - 1000, at + 120000])('zero rest group never clears or replaces existing timer %s', timer => {
    let state = create(setup(), 0); state.activeSession!.restUntil = timer
    for (const id of state.activeSession!.grouping!.groups[0].rounds[0].setIds) state = complete(state, id, at + 5000)
    expect(state.activeSession!.restUntil).toBe(timer)
  })
  it.each(['missing row', 'null reps', 'zero reps', 'invalid load', 'invalid final time'])('rejects %s atomically', invalid => {
    let state = create(); const round = state.activeSession!.grouping!.groups[0].rounds[0]
    let id = round.setIds[0]; let weight: number | null = null; let now = at
    if (invalid === 'missing row') id = 'missing'
    if (invalid === 'null reps') state.activeSession!.sets.find(row => row.id === id)!.reps = null
    if (invalid === 'zero reps') state.activeSession!.sets.find(row => row.id === id)!.reps = 0
    if (invalid === 'invalid load') weight = NaN
    if (invalid === 'invalid final time') { state = complete(state, round.setIds[1]); now = 8640000000000000 }
    const before = structuredClone(state); expect(() => complete(state, id, now, weight)).toThrow(); expect(state).toEqual(before)
  })
  it('keeps ungrouped completion behavior including its zero-duration timer', () => {
    let state = create(); const members = new Set(state.activeSession!.grouping!.groups.flatMap(group => group.rounds.flatMap(round => round.setIds)))
    const row = state.activeSession!.sets.find(row => !members.has(row.id))!
    const exercise = state.activeSession!.workout.exercises.find(exercise => exercise.id === row.exerciseId)!
    state = complete(state, row.id, at + 6000); expect(state.activeSession!.restUntil).toBe(at + 6000 + exercise.restSeconds * 1000)
    state = setSessionCompletion(state, row.id, false, null); state.activeSession!.workout.exercises.find(item => item.id === exercise.id)!.restSeconds = 0
    state = complete(state, row.id, at + 7000); expect(state.activeSession!.restUntil).toBe(at + 7000)
  })
})
