import { describe, expect, it, vi } from 'vitest'
import { freshState, parseState } from './storage'
import { applyPlannedGrouping, applyPlannedGroupRemoval, assertPlannedGroupingEdit, reviewPlannedGrouping, reviewPlannedGroupRemoval } from './plannedGrouping'
import { copyWorkout, prepareWorkoutForSave, restorePlanRevision, savePlanRevision, schedulePreview } from './planning'
import { finishSession, setSessionCompletion, startSession } from './session'
import { applySessionReplacement, reviewSessionReplacement } from './sessionReplacement'
import type { Workout } from './types'

const now = Date.parse('2026-10-16T12:00:00Z')
const sequence = (prefix = 'fresh') => { let n = 0; return () => `${prefix}-${++n}` }
const base = () => freshState().workouts[0]
const selection = { name: ' My pair ', restSeconds: 37, rounds: [[{ exerciseId: 'row', setNumber: 3 }, { exerciseId: 'bench', setNumber: 1 }], [{ exerciseId: 'row', setNumber: 1 }, { exerciseId: 'bench', setNumber: 4 }]] }
const grouped = () => { const workout = base(); return applyPlannedGrouping(workout, reviewPlannedGrouping(workout, selection), { makeId: sequence('planned') }) }
const allIds = (workout: Workout) => [workout.id, ...workout.exercises.map(exercise => exercise.id), ...workout.plannedGrouping!.groups.flatMap(group => [group.id, ...group.rounds.map(round => round.id)])]

describe('saved plan grouping authoring', () => {
  it('reviews exact ordered slots with frozen independent labels and no mutation', () => {
    const workout = base(); workout.exercises[0].equipment = ['bench']; const before = structuredClone(workout)
    const review = reviewPlannedGrouping(workout, selection)
    expect(review.name).toBe('My pair'); expect(review.rounds.map(round => round.members)).toEqual(selection.rounds)
    expect(review.rounds[0].rows.map(row => row.exercise.name)).toEqual(['Barbell Row', 'Bench Press'])
    expect(review.remainingUngroupedSetCount).toBe(13)
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.rounds[0].members[0])).toBe(true)
    expect(Object.isFrozen(review.rounds[0].rows[1].exercise.equipment)).toBe(true)
    const next = applyPlannedGrouping(workout, review, { makeId: sequence() })
    expect(workout).toEqual(before); expect(next.plannedGrouping!.groups[0].rounds.map(round => round.members)).toEqual(selection.rounds)
    next.exercises[0].equipment!.push('barbell'); expect(workout).toEqual(before)
  })
  it('binds add and remove reviews to the exact draft object and full snapshot', () => {
    const workout = base(); const review = reviewPlannedGrouping(workout, selection)
    expect(() => applyPlannedGrouping(structuredClone(workout), review)).toThrow('draft changed')
    workout.description = 'Changed'; expect(() => applyPlannedGrouping(workout, review)).toThrow('draft changed')
    const next = grouped(); const removal = reviewPlannedGroupRemoval(next, next.plannedGrouping!.groups[0].id)
    expect(() => applyPlannedGroupRemoval(next, structuredClone(removal))).toThrow('draft changed')
    next.exercises[0].reps = '12'; expect(() => applyPlannedGroupRemoval(next, removal)).toThrow('draft changed')
  })
  it('allows unrelated incomplete drafts and exact removal even when numeric set counts are incomplete', () => {
    const workout = base(); workout.title = ''; workout.duration = 0
    const next = applyPlannedGrouping(workout, reviewPlannedGrouping(workout, selection))
    next.exercises[0].sets = 0
    const removal = reviewPlannedGroupRemoval(next, next.plannedGrouping!.groups[0].id)
    expect(removal.rounds[1].rows[1].member.setNumber).toBe(4)
    const removed = applyPlannedGroupRemoval(next, removal)
    expect(removed).not.toHaveProperty('plannedGrouping'); expect(removed.exercises[0].sets).toBe(0)
    expect(next.plannedGrouping!.groups).toHaveLength(1)
  })
  it('blocks referenced deletion/reduction rather than truncating and permits unrelated edits', () => {
    const workout = grouped(); const before = structuredClone(workout)
    const removed = { ...workout, exercises: workout.exercises.filter(exercise => exercise.id !== 'bench') }
    expect(() => assertPlannedGroupingEdit(workout, removed)).toThrow('Remove the planned group')
    for (const sets of [0, 3, -1, 1.5, NaN]) {
      const reduced = { ...workout, exercises: workout.exercises.map(exercise => exercise.id === 'bench' ? { ...exercise, sets } : exercise) }
      expect(() => assertPlannedGroupingEdit(workout, reduced)).toThrow('Remove the planned group')
    }
    const incomplete = { ...workout, title: '', exercises: workout.exercises.map(exercise => exercise.id === 'curl' ? { ...exercise, sets: 0 } : exercise) }
    expect(() => assertPlannedGroupingEdit(workout, incomplete)).not.toThrow()
    expect(workout).toEqual(before)
  })
  it('rejects repeated slots, differing movement order, dangling selections and unknown selection fields', () => {
    for (const change of [
      { rounds: [selection.rounds[0], selection.rounds[0]] },
      { rounds: [selection.rounds[0], [...selection.rounds[1]].reverse()] },
      { rounds: [[{ exerciseId: 'missing', setNumber: 1 }, selection.rounds[0][1]]] },
      { rounds: [[{ exerciseId: 'bench', setNumber: 5 }, selection.rounds[0][0]]] },
      { restSeconds: 901 }, { rounds: new Array(1) }, { extra: true },
    ]) expect(() => reviewPlannedGrouping(base(), { ...selection, ...change })).toThrow()
    const workout = grouped(); expect(() => reviewPlannedGrouping(workout, selection)).toThrow()
  })
  it('reserves all state identity references and fails atomically after bounded collision exhaustion', () => {
    const workout = base(); const review = reviewPlannedGrouping(workout, selection); const before = structuredClone(workout)
    const reserved = { id: 'old-log', exerciseId: 'old-movement', setIds: ['old-row'], deep: { id: 'old-round' } }
    const ids = ['old-log', 'old-movement', 'old-row', 'old-round', 'bench', 'upper-power', 'okay-group', 'okay-round1', 'okay-round2']
    const next = applyPlannedGrouping(workout, review, { reserved, makeId: () => ids.shift()! })
    expect(next.plannedGrouping!.groups[0].id).toBe('okay-group')
    const makeId = vi.fn(() => 'bench')
    expect(() => applyPlannedGrouping(workout, review, { makeId })).toThrow('distinct identities')
    expect(makeId).toHaveBeenCalledTimes(20); expect(workout).toEqual(before)
  })
})

describe('planned group lifecycle', () => {
  it('starts fresh runtime identities and preserves exact rows/order/rest while removing the plan wrapper', () => {
    const workout = grouped(); const before = structuredClone(workout); const reserved = { id: 'collision' }
    const fresh = sequence('runtime'); let first = true
    const session = startSession(workout, now, { reserved, makeId: () => { if (first) { first = false; return 'collision' } return fresh() } })
    expect(session.workout).not.toHaveProperty('plannedGrouping')
    const group = session.grouping!.groups[0]
    expect(group.name).toBe('My pair'); expect(group.restSeconds).toBe(37)
    expect(group.rounds.map(round => round.setIds.map(id => { const set = session.sets.find(set => set.id === id)!; return { exerciseId: set.exerciseId, setNumber: set.setNumber } }))).toEqual(selection.rounds)
    const runtimeIds = [session.id, ...session.sets.map(set => set.id), group.id, ...group.rounds.map(round => round.id)]
    expect(new Set(runtimeIds).size).toBe(runtimeIds.length); expect(runtimeIds.some(id => allIds(workout).includes(id))).toBe(false)
    const again = startSession(workout, now, { reserved: session }); expect(again.id).not.toBe(session.id)
    expect(workout).toEqual(before); expect(parseState({ ...freshState(), workouts: [workout], activeSession: session }).activeSession).toEqual(session)
  })
  it('rejects invalid saves/starts without modifying any source and bounds session/copy/rename exhaustion', () => {
    const workout = grouped(); workout.exercises[0].sets = 3; const before = structuredClone(workout)
    expect(() => startSession(workout, now)).toThrow(); expect(() => prepareWorkoutForSave(workout)).toThrow()
    expect(() => savePlanRevision(freshState(), [workout], 'Invalid')).toThrow(); expect(workout).toEqual(before)
    const valid = grouped(); const rename = structuredClone(valid); rename.exercises[0].name = 'New movement'
    for (const time of [NaN, Infinity, -1, 8640000000000000]) expect(() => startSession(valid, time)).toThrow('start time')
    for (const act of [(makeId: () => string) => startSession(valid, now, { makeId }), (makeId: () => string) => copyWorkout(valid, { makeId }), (makeId: () => string) => prepareWorkoutForSave(rename, valid, { makeId })]) {
      const makeId = vi.fn(() => valid.id); expect(() => act(makeId)).toThrow('distinct identities'); expect(makeId).toHaveBeenCalledTimes(20)
    }
  })
  it('atomically remaps renamed exercise references and independent copied group/round identities', () => {
    const workout = grouped(); const draft = structuredClone(workout); draft.exercises[0].name = 'Dumbbell Press'
    const before = structuredClone(workout); const next = prepareWorkoutForSave(draft, workout, { reserved: { id: 'fresh-1' }, makeId: sequence() })
    expect(next.exercises[0].id).toBe('fresh-2'); expect(next.plannedGrouping!.groups[0].id).toBe(workout.plannedGrouping!.groups[0].id)
    expect(next.plannedGrouping!.groups[0].rounds.map(round => round.members[1])).toEqual([{ exerciseId: 'fresh-2', setNumber: 1 }, { exerciseId: 'fresh-2', setNumber: 4 }])
    expect(workout).toEqual(before); expect(draft.exercises[0].id).toBe('bench')
    const copy = copyWorkout(workout, { makeId: sequence('copy') })
    expect(allIds(copy).some(id => allIds(workout).includes(id))).toBe(false)
    expect(copy.plannedGrouping!.groups[0].rounds.map(round => round.members[0].exerciseId)).toEqual([copy.exercises[1].id, copy.exercises[1].id])
    copy.plannedGrouping!.groups[0].name = 'Other'; expect(workout).toEqual(before)
  })
  it('copies repeated schedule days with collision-free identities and restores immutable exact revisions', () => {
    const state = freshState(); state.workouts = [grouped()]; state.activeSession = startSession(state.workouts[0], now)
    state.activeSession.sets[0].completed = true; state.logs = [finishSession({ ...state.activeSession, id: 'old-log' }, now + 1000)]
    const before = structuredClone(state)
    const choices = ['Friday', 'Monday', 'Wednesday'].map(day => ({ day, workoutId: state.workouts[0].id }))
    const workouts = schedulePreview(state.workouts, choices, 60, { reserved: state, makeId: sequence('copy') })
    expect(workouts.map(workout => workout.day)).toEqual(['Monday', 'Wednesday', 'Friday'])
    expect(workouts[2].id).toBe(state.workouts[0].id)
    const ids = workouts.flatMap(allIds); expect(new Set(ids).size).toBe(ids.length)
    const saved = savePlanRevision(state, workouts, 'Before schedule')
    expect(saved.activeSession).toBe(state.activeSession); expect(saved.logs).toBe(state.logs)
    const restored = restorePlanRevision(saved, saved.planHistory[0].id)
    expect(restored.workouts).toEqual(state.workouts); expect(state).toEqual(before); expect(parseState(restored)).toEqual(restored)
    restored.workouts[0].plannedGrouping!.groups[0].name = 'Changed'
    expect(saved.planHistory[0].workouts[0].plannedGrouping!.groups[0].name).toBe('My pair')
  })
  it('retains runtime rest, partial history and replacement behavior without stale plan references', () => {
    let state = freshState(); state.workouts = [grouped()]; state.activeSession = startSession(state.workouts[0], now)
    state.activeSession.sets.forEach(set => { set.reps = 8 }); const source = structuredClone(state.workouts)
    const round = state.activeSession.grouping!.groups[0].rounds[0]
    state = setSessionCompletion(state, round.setIds[0], true, 12, now); expect(state.activeSession!.restUntil).toBeNull()
    state = setSessionCompletion(state, round.setIds[1], true, 14, now); expect(state.activeSession!.restUntil).toBe(now + 37000)
    const log = finishSession(state.activeSession!, now + 5000); expect(log.grouping).toEqual(state.activeSession!.grouping)
    expect(log.sets!.filter(set => set.completed)).toHaveLength(2)
    const review = reviewSessionReplacement(state, 'bench', freshState().workouts[1].exercises[0])
    const replaced = applySessionReplacement(state, review, sequence('replacement'))
    expect(replaced.activeSession!.workout).not.toHaveProperty('plannedGrouping'); expect(replaced.workouts).toEqual(source)
    expect(parseState(replaced)).toEqual(replaced)
    expect(log.grouping!.groups[0].rounds[0].setIds).toEqual(round.setIds)
  })
})
