import { describe, expect, it, vi } from 'vitest'
import { freshState, parseBackup, parseState } from './storage'
import { finishSession, setSessionCompletion, startSession } from './session'
import { applyPlannedGrouping, applyPlannedGroupRemoval, assertPlannedGroupingEdit, reviewPlannedGrouping, reviewPlannedGroupRemoval } from './plannedGrouping'
import { copyWorkout, prepareWorkoutForSave, restorePlanRevision, savePlanRevision, schedulePreview } from './planning'
import { pausedCloudState } from './cloud'
import type { AppState, Workout } from './types'

const now = Date.parse('2026-10-16T12:00:00Z')
const plain = (): Workout => { const workout = structuredClone(freshState().workouts[0]); workout.exercises = workout.exercises.slice(0, 3).map(exercise => ({ ...exercise, sets: 3 })); return workout }
const setup = (): Workout => {
  const workout = plain()
  workout.plannedGrouping = { version: 1, groups: [{ id: 'planned-group', name: 'Reviewed circuit', restSeconds: 37, rounds: [2, 1].map((setNumber, i) => ({ id: `planned-round-${i}`, members: workout.exercises.slice(0, 2).map(exercise => ({ exerciseId: exercise.id, setNumber })) })) }] }
  return workout
}
const stateWith = (workout = setup()): AppState => ({ ...freshState(), workouts: [workout] })
const identities = (workout: Workout) => [workout.id, ...workout.exercises.map(exercise => exercise.id), ...workout.plannedGrouping?.groups.flatMap(group => [group.id, ...group.rounds.map(round => round.id)]) ?? []]
const metadata = (workout: Workout) => workout.plannedGrouping!

describe('independent bounded planned grouping schema and lifetime', () => {
  it('round trips exact chosen set slots, repeat identities across history snapshots and private paused backups', () => {
    const state = stateWith(); state.planHistory = [0, 1].map(index => ({ id: `revision-${index}`, savedAt: new Date(now).toISOString(), label: 'Exact archived plan', workouts: structuredClone(state.workouts) }))
    const before = structuredClone(state); expect(parseState(state)).toEqual(state); expect(parseBackup(JSON.stringify(state))).toEqual(state)
    expect(pausedCloudState(state, now)).toEqual(state); expect(state).toEqual(before)
  })
  it.each(['owner id', 'exercise id', 'other workout', 'other exercise', 'other group', 'other round'] as const)('rejects current-plan group alias with %s without editing source', collision => {
    const state = stateWith(); const second = copyWorkout(setup()); state.workouts.push(second)
    const group = metadata(state.workouts[0]).groups[0]
    if (collision === 'owner id') group.id = state.workouts[0].id
    if (collision === 'exercise id') group.id = state.workouts[0].exercises[0].id
    if (collision === 'other workout') group.id = second.id
    if (collision === 'other exercise') group.id = second.exercises[0].id
    if (collision === 'other group') group.id = metadata(second).groups[0].id
    if (collision === 'other round') group.id = metadata(second).groups[0].rounds[0].id
    const before = structuredClone(state); expect(() => parseState(state)).toThrow(); expect(state).toEqual(before)
  })
  it.each(['sparse groups', 'sparse rounds', 'sparse members', 'unknown wrapper', 'unknown group', 'unknown round', 'unknown member', 'repeated slot', 'reversed movement order', 'duplicate movement', 'unknown exercise', 'out of range', 'zero set'] as const)('rejects %s atomically', defect => {
    const state = stateWith(); const grouping = metadata(state.workouts[0]); const group = grouping.groups[0]; const round = group.rounds[0]
    if (defect === 'sparse groups') delete grouping.groups[0]
    if (defect === 'sparse rounds') delete group.rounds[0]
    if (defect === 'sparse members') delete round.members[0]
    if (defect === 'unknown wrapper') Object.assign(grouping, { alias: true })
    if (defect === 'unknown group') Object.assign(group, { type: 'circuit' })
    if (defect === 'unknown round') Object.assign(round, { setIds: [] })
    if (defect === 'unknown member') Object.assign(round.members[0], { id: 'alias' })
    if (defect === 'repeated slot') group.rounds[1].members[0].setNumber = round.members[0].setNumber
    if (defect === 'reversed movement order') group.rounds[1].members.reverse()
    if (defect === 'duplicate movement') round.members[1].exerciseId = round.members[0].exerciseId
    if (defect === 'unknown exercise') round.members[0].exerciseId = 'missing-exercise'
    if (defect === 'out of range') round.members[0].setNumber = 4
    if (defect === 'zero set') round.members[0].setNumber = 0
    const before = structuredClone(state); expect(() => parseState(state)).toThrow(); expect(state).toEqual(before)
  })
  it('enforces 25 groups and twenty same-order rounds with six distinct movements at the inclusive boundaries', () => {
    const workout = plain(); workout.exercises = Array.from({ length: 50 }, (_, index) => ({ ...workout.exercises[0], id: `movement-${index}`, sets: 20 }))
    workout.plannedGrouping = { version: 1, groups: Array.from({ length: 25 }, (_, group) => ({ id: `group-${group}`, name: 'Bounded', restSeconds: 900, rounds: [{ id: `round-${group}`, members: [group * 2, group * 2 + 1].map(index => ({ exerciseId: workout.exercises[index].id, setNumber: 1 })) }] })) }
    expect(parseState(stateWith(workout)).workouts[0]).toEqual(workout)
    metadata(workout).groups.push({ id: 'extra-group', name: 'Over limit', restSeconds: 0, rounds: [{ id: 'extra-round', members: workout.exercises.slice(0, 2).map(exercise => ({ exerciseId: exercise.id, setNumber: 2 })) }] })
    expect(() => parseState(stateWith(workout))).toThrow()
    workout.plannedGrouping = { version: 1, groups: [{ id: 'six-group', name: 'Maximum rounds', restSeconds: 0, rounds: Array.from({ length: 20 }, (_, index) => ({ id: `six-round-${index}`, members: workout.exercises.slice(0, 6).map(exercise => ({ exerciseId: exercise.id, setNumber: index + 1 })) })) }] }
    expect(parseState(stateWith(workout)).workouts[0]).toEqual(workout)
    metadata(workout).groups[0].rounds.push({ id: 'extra-round', members: workout.exercises.slice(0, 6).map(exercise => ({ exerciseId: exercise.id, setNumber: 21 })) })
    expect(() => parseState(stateWith(workout))).toThrow()
  })
  it.each([2, 3])('never silently discards supplied planned metadata in old version %s', version => {
    const state = stateWith(); state.version = version as AppState['version']
    expect(() => parseState(state)).toThrow()
    const hidden = freshState(); Object.assign(hidden, { version, activeSession: { workout: setup() } }); expect(() => parseState(hidden)).toThrow()
  })
  it('rejects planned wrappers in active snapshots and workout logs', () => {
    const state = stateWith(); state.activeSession = startSession(setup(), now); Object.assign(state.activeSession.workout, { plannedGrouping: metadata(setup()) })
    expect(() => parseState(state)).toThrow()
    state.activeSession = startSession(setup(), now); state.activeSession.sets[0].completed = true
    state.logs = [finishSession(state.activeSession, now + 10000)]; state.activeSession = null
    Object.assign(state.logs[0], { plannedGrouping: metadata(setup()) }); expect(() => parseState(state)).toThrow()
  })
})

describe('independent planned grouping transformations', () => {
  it('deep-freezes exact selection, binds reviews to source, and explicitly removes only requested metadata', () => {
    const workout = plain(); const selected = { name: 'Frozen choice', restSeconds: 19, rounds: [2, 1].map(setNumber => workout.exercises.slice(0, 2).map(exercise => ({ exerciseId: exercise.id, setNumber }))) }
    const expected = structuredClone(selected); const review = reviewPlannedGrouping(workout, selected)
    selected.name = 'Late'; selected.rounds[0][0].setNumber = 3
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.rounds[0])).toBe(true)
    expect(() => applyPlannedGrouping(structuredClone(workout), review)).toThrow(); expect(() => applyPlannedGrouping(workout, { ...review })).toThrow()
    const grouped = applyPlannedGrouping(workout, review); const group = metadata(grouped).groups[0]
    expect(group.name).toBe(expected.name); expect(group.rounds.map(round => round.members)).toEqual(expected.rounds)
    const removed = applyPlannedGroupRemoval(grouped, reviewPlannedGroupRemoval(grouped, group.id))
    expect(removed).toEqual(workout); expect(workout.plannedGrouping).toBeUndefined()
  })
  it('does not silently drop a group when a member or required planned set is removed', () => {
    const workout = setup(); const before = structuredClone(workout)
    const fewer = structuredClone(workout); fewer.exercises[0].sets = 1
    const missing = structuredClone(workout); missing.exercises.shift()
    for (const next of [fewer, missing]) {
      expect(() => assertPlannedGroupingEdit(workout, next)).toThrow()
      expect(() => prepareWorkoutForSave(next, workout)).toThrow()
      expect(() => startSession(next, now)).toThrow()
    }
    expect(workout).toEqual(before)
  })
  it('renames a grouped exercise with atomic identity and member remapping while retaining group/round IDs', () => {
    const workout = setup(); const draft = structuredClone(workout); draft.exercises[0].name = 'Renamed movement'
    const next = prepareWorkoutForSave(draft, workout); const oldId = workout.exercises[0].id; const newId = next.exercises[0].id
    expect(newId).not.toBe(oldId); expect(next.exercises[1].id).toBe(workout.exercises[1].id)
    expect(metadata(next).groups[0].id).toBe(metadata(workout).groups[0].id)
    metadata(next).groups[0].rounds.forEach((round, index) => {
      expect(round.id).toBe(metadata(workout).groups[0].rounds[index].id)
      expect(round.members[0].exerciseId).toBe(newId); expect(round.members[1]).toEqual(metadata(workout).groups[0].rounds[index].members[1])
    })
    expect(parseState(stateWith(next)).workouts[0]).toEqual(next); expect(workout.exercises[0].name).not.toBe('Renamed movement')
  })
  it('copies every identity and schedule duplicate exactly, retaining ordered set numbers and protecting input', () => {
    const workout = setup(); const before = structuredClone(workout); const copied = copyWorkout(workout)
    for (const id of identities(copied)) expect(identities(workout)).not.toContain(id)
    const choices = [{ day: 'Monday', workoutId: workout.id }, { day: 'Thursday', workoutId: workout.id }]
    const schedule = schedulePreview([workout], choices, 600)
    expect(schedule[0]).toEqual({ ...workout, day: 'Monday' })
    expect(identities(schedule[1]).every(id => !identities(schedule[0]).includes(id))).toBe(true)
    expect(metadata(schedule[1]).groups[0].rounds.map(round => round.members.map(member => member.setNumber))).toEqual([[2, 2], [1, 1]])
    expect(workout).toEqual(before); expect(parseState({ ...freshState(), workouts: schedule }).workouts).toEqual(schedule)
  })
  it.each(['copy', 'rename', 'start', 'schedule'] as const)('bounds %s collision exhaustion atomically, then allows a valid retry', operation => {
    const workout = setup(); const before = structuredClone(workout); const reserved = stateWith(workout)
    const draft = structuredClone(workout); draft.exercises[0].name = 'Renamed'
    const run = (makeId: () => string) => {
      const options = { reserved, makeId }
      if (operation === 'copy') return copyWorkout(workout, options)
      if (operation === 'rename') return prepareWorkoutForSave(draft, workout, options)
      if (operation === 'start') return startSession(workout, now, options)
      return schedulePreview([workout], [{ day: 'Monday', workoutId: workout.id }, { day: 'Friday', workoutId: workout.id }], 600, options)
    }
    for (const id of ['', ' ', 'x'.repeat(151), workout.id, metadata(workout).groups[0].rounds[0].id]) {
      const allocate = vi.fn(() => id); expect(() => run(allocate)).toThrow(); expect(allocate.mock.calls.length).toBeLessThanOrEqual(20)
    }
    let index = 0; expect(() => run(() => `fresh-${operation}-${index++}`)).not.toThrow(); expect(workout).toEqual(before)
  })
  it('reserves orphan, archived and active identities when copying and instantiating a future plan', () => {
    const workout = setup(); const state = stateWith(workout); state.activeSession = startSession(workout, now)
    state.activeSession.sets[0].completed = true; state.logs = [finishSession(state.activeSession, now + 1000)]; state.logs[0].id = 'historic-session'
    state.logs[0].workoutId = 'orphan-workout'; state.logs[0].completedExerciseIds = ['orphan-exercise']
    state.planHistory = [{ id: 'archived-revision', savedAt: new Date(now).toISOString(), label: 'Archived', workouts: [copyWorkout(workout)] }]
    const forbidden = ['orphan-workout', 'orphan-exercise', 'historic-session', 'archived-revision', metadata(state.planHistory[0].workouts[0]).groups[0].id, metadata(state.planHistory[0].workouts[0]).groups[0].rounds[0].id, state.activeSession.id, state.activeSession.sets[0].id, state.activeSession.grouping!.groups[0].id]
    for (const blocked of forbidden) for (const operation of ['copy', 'start']) {
      let index = 0; const allocate = () => index++ === 0 ? blocked : `fresh-${operation}-${index}`
      if (operation === 'copy') expect(identities(copyWorkout(workout, { reserved: state, makeId: allocate }))).not.toContain(blocked)
      else {
        const active = startSession(workout, now, { reserved: state, makeId: allocate })
        expect([active.id, ...active.sets.map(row => row.id), ...active.grouping!.groups.flatMap(group => [group.id, ...group.rounds.map(round => round.id)])]).not.toContain(blocked)
      }
    }
  })
  it('instantiates exact planned slots with fresh runtime IDs and keeps rest/history behavior independent of future plans', () => {
    const state = stateWith(); const source = structuredClone(state.workouts[0]); state.activeSession = startSession(state.workouts[0], now, { reserved: state }); state.activeSession.runningSince = null
    const active = state.activeSession; expect(Object.hasOwn(active.workout, 'plannedGrouping')).toBe(false)
    const occupied = identities(source); const runtime = [active.id, ...active.sets.map(row => row.id), ...active.grouping!.groups.flatMap(group => [group.id, ...group.rounds.map(round => round.id)])]
    expect(new Set(runtime).size).toBe(runtime.length); runtime.forEach(id => expect(occupied).not.toContain(id))
    active.grouping!.groups[0].rounds.forEach((round, index) => expect(round.setIds.map(id => { const row = active.sets.find(row => row.id === id)!; return { exerciseId: row.exerciseId, setNumber: row.setNumber } })).toEqual(metadata(source).groups[0].rounds[index].members))
    active.sets.forEach(row => { row.reps = 8 }); const round = active.grouping!.groups[0].rounds[0]
    const partial = setSessionCompletion(state, round.setIds[1], true, 20, now + 1000); expect(partial.activeSession!.restUntil).toBeNull()
    const complete = setSessionCompletion(partial, round.setIds[0], true, 40, now + 2000); expect(complete.activeSession!.restUntil).toBe(now + 39000)
    const changed = structuredClone(source); changed.title = 'Future version'; changed.plannedGrouping!.groups[0].name = 'Future group'
    const revised = savePlanRevision(complete, [changed], 'Previous'); expect(revised.activeSession).toBe(complete.activeSession); expect(revised.logs).toBe(complete.logs)
    expect(restorePlanRevision(revised, revised.planHistory[0].id).workouts).toEqual([source])
    const log = finishSession(revised.activeSession!, now + 60000); expect(log.grouping!.groups[0].name).toBe('Reviewed circuit'); expect(log.grouping).toEqual(revised.activeSession!.grouping)
    expect(log.sets).toHaveLength(active.sets.length); expect(parseState({ ...revised, activeSession: null, logs: [log] }).logs[0]).toEqual(log)
  })
})
