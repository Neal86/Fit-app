import { describe, expect, it } from 'vitest'
import { freshState, parseBackup, parseState } from './storage'
import { finishSession, setSessionCompletion, startSession } from './session'
import { applySessionGrouping, applySessionGroupRemoval, reviewSessionGrouping, reviewSessionGroupRemoval } from './sessionGrouping'
import { applySessionReplacement, reviewSessionReplacement } from './sessionReplacement'
import { applySessionAddition, reviewSessionAddition } from './sessionAddition'
import { pausedCloudState } from './cloud'
import type { AppState } from './types'

const now = Date.parse('2026-10-01T10:00:00Z')
function setup() {
  const state = freshState()
  const sample = state.workouts[0]
  const workout = { ...sample, exercises: [4, 3, 2, 2].map((sets, index) => ({ ...sample.exercises[0], id: `ex-${index}`, name: 'Same name', sets, reps: index === 1 ? '30 sec' : '8', equipment: ['bench'] as ['bench'] })) }
  state.activeSession = startSession(workout, now)
  state.activeSession.sets.forEach((set, index) => { set.id = `row-${index}`; set.reps = set.exerciseId === 'ex-1' ? null : 8; set.seconds = set.exerciseId === 'ex-1' ? 30 : null; set.weightKg = 21.123456789 })
  state.activeSession.restUntil = now + 12_000
  state.activeSession.notes = 'Keep every value'
  return state
}
const selection = { name: '  My exact group  ', restSeconds: 40, rounds: [['row-0', 'row-4'], ['row-2', 'row-6']] }
const create = (state: AppState, restSeconds = 40) => applySessionGrouping(state, reviewSessionGrouping(state, { ...selection, restSeconds }))
const firstGroup = (state: AppState) => state.activeSession!.grouping!.groups[0]

describe('explicit frozen session grouping', () => {
  it('groups exact unequal mixed rows in user order without touching values, sparse numbers, extras or plans', () => {
    const state = setup(); state.activeSession!.sets[0].setNumber = 17; state.activeSession!.sets[2].setNumber = 17; state.activeSession!.sets.reverse()
    const before = structuredClone(state); const review = reviewSessionGrouping(state, selection)
    expect(review.name).toBe('My exact group'); expect(review.rounds.map(round => [...round.setIds])).toEqual(selection.rounds)
    expect(review.rounds[0].rows.map(row => row.exercise.id)).toEqual(['ex-0', 'ex-1'])
    expect(review.rounds[0].rows[0].set.setNumber).toBe(17)
    expect(review.remainingUngroupedSetCount).toBe(7)
    expect(Object.isFrozen(review.rounds[0].rows[0].exercise.equipment)).toBe(true)
    expect(() => (review.rounds[0].setIds as string[]).push('extra')).toThrow()
    const next = applySessionGrouping(state, review)
    expect(next.activeSession!.sets).toEqual(state.activeSession!.sets)
    expect(next.activeSession!.workout).toEqual(state.activeSession!.workout)
    expect(next.workouts).toBe(state.workouts); expect(next.logs).toBe(state.logs); expect(next.planHistory).toBe(state.planHistory)
    expect(next.activeSession).toMatchObject({ notes: state.activeSession!.notes, restUntil: state.activeSession!.restUntil, runningSince: now })
    expect(firstGroup(next).rounds.map(round => round.setIds)).toEqual(selection.rounds)
    next.activeSession!.sets[0].weightKg = 1; firstGroup(next).rounds[0].setIds.reverse(); next.activeSession!.workout.exercises[0].equipment!.push('barbell')
    expect(state).toEqual(before); expect(review.rounds[0].setIds).toEqual(selection.rounds[0])
  })
  it('freezes independent exact review snapshots and rejects mutation, forged/stale/replayed current-state reviews', () => {
    const state = setup(); const input = structuredClone(selection); const review = reviewSessionGrouping(state, input)
    input.rounds[0][0] = 'row-1'; input.name = 'Edited'
    expect(review.rounds[0].setIds[0]).toBe('row-0'); expect(review.name).toBe('My exact group')
    expect(() => applySessionGrouping(state, { ...review })).toThrow('changed')
    expect(() => applySessionGrouping(structuredClone(state), review)).toThrow('changed')
    expect(() => applySessionGrouping({ ...state, activeSession: null }, review)).toThrow('changed')
    const next = applySessionGrouping(state, review)
    expect(() => applySessionGrouping(next, review)).toThrow('changed')
    // A failed storage transaction leaves precisely this source current and must allow retry.
    expect(applySessionGrouping(state, review).activeSession!.sets).toEqual(state.activeSession!.sets)
    state.activeSession!.sets[0].reps = 9
    expect(() => applySessionGrouping(state, review)).toThrow('changed')
  })
  it.each([
    { ...selection, name: ' ' }, { ...selection, name: 'n'.repeat(81) }, { ...selection, restSeconds: -1 }, { ...selection, restSeconds: 901 }, { ...selection, restSeconds: 0.1 },
    { ...selection, rounds: [] }, { ...selection, rounds: [new Array(2)] }, { ...selection, rounds: [['row-0']] },
    { ...selection, rounds: [['row-0', 'row-1']] }, { ...selection, rounds: [['row-0', 'row-4'], ['row-6', 'row-2']] },
    { ...selection, rounds: [['row-0', 'row-4'], ['row-0', 'row-6']] }, { ...selection, rounds: [['missing', 'row-4']] },
    { ...selection, rounds: Array(51).fill(['row-0', 'row-4']) }, { ...selection, extra: true },
  ])('rejects malformed/ambiguous exact selection %# atomically', input => {
    const state = setup(); const before = structuredClone(state)
    expect(() => reviewSessionGrouping(state, input)).toThrow(); expect(state).toEqual(before)
  })
  it('rejects completed, warm-up and already grouped selected rows', () => {
    const state = setup(); state.activeSession!.sets[0].completed = true
    expect(() => reviewSessionGrouping(state, selection)).toThrow('unfinished')
    state.activeSession!.sets[0].completed = false; state.activeSession!.sets[0].warmup = true
    expect(() => reviewSessionGrouping(state, selection)).toThrow('non-warm-up')
    state.activeSession!.sets[0].warmup = false
    expect(() => reviewSessionGrouping(create(state), selection)).toThrow('ungrouped')
  })
  it('reserves all global identities/references and leaves failed allocation retryable', () => {
    const state = setup(); const old = structuredClone(state.activeSession!); old.id = 'past'; old.sets[0].completed = true
    const log = finishSession(old, now + 60_000); log.workoutId = 'orphan-workout'; log.completedExerciseIds = ['orphan-exercise']; state.logs = [log]
    state.planHistory = [{ id: 'revision-id', savedAt: old.startedAt, label: 'Old', workouts: structuredClone(state.workouts) }]
    const review = reviewSessionGrouping(state, selection); const before = structuredClone(state)
    let attempts = 0
    expect(() => applySessionGrouping(state, review, () => { attempts++; return 'past' })).toThrow('distinct grouping')
    expect(attempts).toBe(20); expect(state).toEqual(before)
    const ids = ['orphan-workout', 'orphan-exercise', 'revision-id', 'row-0', 'ex-0', 'g', 'g', 'r1', 'r1', 'r2']
    const next = applySessionGrouping(state, review, () => ids.shift()!)
    expect(firstGroup(next)).toMatchObject({ id: 'g', rounds: [{ id: 'r1' }, { id: 'r2' }] })
  })
  it('requires explicit removal after all current completions are undone, deletes last property, preserves everything else', () => {
    let state = create(setup()); const group = firstGroup(state); const before = structuredClone(state)
    state = setSessionCompletion(state, 'row-0', true, 55, now)
    expect(() => reviewSessionGroupRemoval(state, group.id)).toThrow('Undo every')
    state = setSessionCompletion(state, 'row-0', false, 55, now + 1)
    const review = reviewSessionGroupRemoval(state, group.id)
    expect(Object.isFrozen(review.group.rounds[0].setIds)).toBe(true)
    expect(() => applySessionGroupRemoval(state, { ...review })).toThrow('changed')
    const next = applySessionGroupRemoval(state, review)
    expect(Object.hasOwn(next.activeSession!, 'grouping')).toBe(false)
    expect(next.activeSession!.sets).toEqual(state.activeSession!.sets)
    expect(next.activeSession!.restUntil).toBe(before.activeSession!.restUntil)
    expect(() => applySessionGroupRemoval(next, review)).toThrow('changed')
    expect(applySessionGroupRemoval(state, review)).toEqual(next)
  })
  it('keeps newly added exercise and set rows ungrouped and schema rejects grouped removal/warm-up edits', () => {
    const state = create(setup()); const grouping = structuredClone(firstGroup(state))
    const next = applySessionAddition(state, reviewSessionAddition(state, state.workouts[0].exercises[0]))
    expect(firstGroup(next)).toEqual(grouping)
    next.activeSession!.sets.push({ ...next.activeSession!.sets[0], id: 'added-row', setNumber: 49 })
    expect(parseState(next).activeSession!.grouping!.groups[0]).toEqual(grouping)
    const removed = structuredClone(next); removed.activeSession!.sets = removed.activeSession!.sets.filter(set => set.id !== 'row-0')
    expect(() => parseState(removed)).toThrow()
    const warmup = structuredClone(next); warmup.activeSession!.sets.find(set => set.id === 'row-0')!.warmup = true
    expect(() => parseState(warmup)).toThrow()
  })
  it('retains exact partial finish metadata and snapshots through backup/reload/manual projection without aliases', () => {
    const state = setSessionCompletion(create(setup()), 'row-0', true, 23.123456789, now)
    const log = finishSession(state.activeSession!, now + 60_000)
    expect(log.grouping).toEqual(state.activeSession!.grouping); expect(log.completedExerciseIds).toEqual([])
    const historical = { ...state, activeSession: null, logs: [log] }
    expect(parseBackup(JSON.stringify(historical))).toEqual(historical)
    expect(parseState(state)).toEqual(state)
    const cloud = pausedCloudState(state)
    expect(cloud.activeSession!.grouping).toEqual(state.activeSession!.grouping)
    expect(cloud.activeSession!.restUntil).toBeNull(); expect(state.activeSession!.restUntil).toBe(now + 12_000)
    state.activeSession!.grouping!.groups[0].rounds[0].setIds.reverse()
    expect(log.grouping!.groups[0].rounds[0].setIds).toEqual(selection.rounds[0])
  })
})

describe('desired-state grouped rest', () => {
  it('only starts positive rest on a new last unfinished member; ordering and round identities stay stable', () => {
    let state = create(setup()); const grouping = structuredClone(state.activeSession!.grouping)
    state = setSessionCompletion(state, 'row-6', true, 7, now + 1000)
    expect(state.activeSession!.restUntil).toBe(now + 12_000)
    state = setSessionCompletion(state, 'row-2', true, 8, now + 2000)
    expect(state.activeSession!.restUntil).toBe(now + 42_000)
    expect(setSessionCompletion(state, 'row-2', true, 999, now + 9000)).toBe(state)
    expect(state.activeSession!.sets.find(set => set.id === 'row-2')!.weightKg).toBe(8)
    state = setSessionCompletion(state, 'row-0', true, 6, now + 3000)
    expect(state.activeSession!.restUntil).toBe(now + 42_000)
    state = setSessionCompletion(state, 'row-4', true, null, now + 5000)
    expect(state.activeSession!.restUntil).toBe(now + 45_000)
    state = setSessionCompletion(state, 'row-4', false, null, now + 100_000)
    expect(state.activeSession!.restUntil).toBe(now + 45_000)
    expect(setSessionCompletion(state, 'row-4', false, 999, now + 200_000)).toBe(state)
    state = setSessionCompletion(state, 'row-4', true, 3, now + 300_000)
    expect(state.activeSession!.restUntil).toBe(now + 340_000)
    expect(state.activeSession!.grouping).toEqual(grouping)
    const restored = parseBackup(JSON.stringify(state))
    expect(setSessionCompletion(restored, 'row-4', true, 999, now + 900_000)).toBe(restored)
    expect(restored.activeSession!.restUntil).toBe(now + 340_000)
  })
  it.each([null, now - 1000, now + 999_000])('zero grouped rest preserves existing %s timer even at round completion', restUntil => {
    let state = create(setup(), 0); state.activeSession!.restUntil = restUntil
    state = setSessionCompletion(state, 'row-0', true, null, now)
    state = setSessionCompletion(state, 'row-4', true, null, now + 1000)
    expect(state.activeSession!.restUntil).toBe(restUntil)
  })
  it('keeps ungrouped per-exercise behavior including zero, with retry/undo idempotence', () => {
    let state = create(setup()); state.activeSession!.workout.exercises[0].restSeconds = 0
    state = setSessionCompletion(state, 'row-1', true, 42, now)
    expect(state.activeSession!.restUntil).toBe(now)
    expect(setSessionCompletion(state, 'row-1', true, 13, now + 5000)).toBe(state)
    state = setSessionCompletion(state, 'row-1', false, 42, now + 6000)
    expect(state.activeSession!.restUntil).toBe(now)
  })
  it('rejects invalid desired transitions, load and state ranges atomically', () => {
    const state = create(setup()); const before = structuredClone(state)
    for (const weight of [-1, 1001, NaN, Infinity]) expect(() => setSessionCompletion(state, 'row-0', true, weight, now)).toThrow('Load')
    expect(() => setSessionCompletion(state, 'missing', true, null, now)).toThrow('changed')
    expect(state).toEqual(before)
    state.activeSession!.sets[0].reps = 0
    expect(() => setSessionCompletion(state, 'row-0', true, null, now)).toThrow('positive')
    state.activeSession!.sets[0].reps = 1.1
    expect(() => setSessionCompletion(state, 'row-0', true, null, now)).toThrow()
    state.activeSession!.sets[0].reps = 1; state.activeSession!.sets[4].seconds = null
    expect(() => setSessionCompletion(state, 'row-4', true, null, now)).toThrow('positive')
  })
})

describe('grouped replacement exact mapping', () => {
  it('remaps only unfinished references across multiple groups while completed earlier rounds stay original', () => {
    let state = create(setup())
    state = applySessionGrouping(state, reviewSessionGrouping(state, { name: 'Other group', restSeconds: 0, rounds: [['row-1', 'row-7']] }))
    state = setSessionCompletion(state, 'row-0', true, 18.123456789, now)
    state.activeSession!.sets.find(set => set.id === 'row-2')!.setNumber = 17
    state.activeSession!.sets.find(set => set.id === 'row-1')!.setNumber = 17
    state.activeSession!.sets.reverse()
    const before = structuredClone(state); const review = reviewSessionReplacement(state, 'ex-0', state.workouts[0].exercises[0])
    expect(review.groupImpacts.map(impact => impact.setId)).toEqual(['row-2', 'row-1'])
    expect(Object.isFrozen(review.groupImpacts[0])).toBe(true)
    const oldRows = review.removedSets.map(set => set.id); let index = 0
    const next = applySessionReplacement(state, review, () => `replacement-${index++}`)
    const map = new Map(oldRows.map((id, index) => [id, `replacement-${index + 1}`]))
    expect(next.activeSession!.grouping).toEqual({ version: 1, groups: before.activeSession!.grouping!.groups.map(group => ({ ...group, rounds: group.rounds.map(round => ({ ...round, setIds: round.setIds.map(id => map.get(id) ?? id) })) })) })
    expect(next.activeSession!.sets.find(set => set.id === 'row-0')).toEqual(before.activeSession!.sets.find(set => set.id === 'row-0'))
    expect(next.activeSession!.restUntil).toBe(before.activeSession!.restUntil)
    expect(next.activeSession!.sets.filter(set => set.exerciseId === 'replacement-0')).toHaveLength(3)
    expect(state).toEqual(before); expect(parseState(next)).toEqual(next)
    const log = finishSession(next.activeSession!, now + 60_000)
    expect(parseState({ ...next, activeSession: null, logs: [log] }).logs[0].grouping).toEqual(next.activeSession!.grouping)
  })
})
