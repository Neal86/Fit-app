import { describe, expect, it, vi } from 'vitest'
import { applyLibraryChange, assertLibraryCopyCurrent, materializeLibraryCopy, reviewLibraryArchive, reviewLibraryCopy, reviewLibraryCreate, reviewLibraryEdit } from './exerciseLibrary'
import { freshState, parseState } from './storage'
import { finishSession, startSession } from './session'
import { applySessionAddition, reviewSessionAddition } from './sessionAddition'
import { applySessionReplacement, reviewSessionReplacement } from './sessionReplacement'
import { applyPlannedGrouping, reviewPlannedGrouping, reviewPlannedGroupRemoval } from './plannedGrouping'
import { applySessionGrouping, reviewSessionGrouping, reviewSessionGroupRemoval } from './sessionGrouping'
import { copyWorkout, prepareWorkoutForSave, savePlanRevision, schedulePreview } from './planning'
import { exerciseCatalog } from './exerciseCatalog'
import type { AppState, LibraryContent } from './types'

const now = Date.parse('2026-10-16T12:00:00.000Z')
const content = (): LibraryContent => ({ name: 'Personal exact movement', category: 'Manual', sets: 3, reps: '7–11', restSeconds: 37, notes: 'User-written starting values', equipment: ['dumbbells', 'bench'] })
function setup(): AppState {
  const state = freshState(); state.activeSession = startSession(state.workouts[0], now)
  state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 123.125; state.activeSession.restUntil = now + 30000
  state.activeSession.sets[0].completed = true; state.activeSession.sets[0].reps = 8; state.activeSession.sets[0].weightKg = 37.123456789
  state.planHistory = [{ id: 'previous-plan', label: 'Old plan', savedAt: new Date(now).toISOString(), workouts: structuredClone(state.workouts) }]
  const old = structuredClone(state.activeSession); old.id = 'previous-session'; state.logs = [finishSession(old, now + 1000)]
  return applyLibraryChange(state, reviewLibraryCreate(state, content()), { now, makeId: () => 'personal-entry' })
}
const first = (state: AppState) => state.exerciseLibrary!.entries[0]
const archive = (state: AppState, archived: boolean, at = now) => applyLibraryChange(state, reviewLibraryArchive(state, first(state).id, archived), { now: at })
const edit = (state: AppState, patch: Partial<LibraryContent>, at = now) => applyLibraryChange(state, reviewLibraryEdit(state, first(state).id, { ...first(state).exercise, ...patch }), { now: at })

// Independent operations use complete synthetic AppState inputs, never author fixtures.
describe('independent personal-library changes and stale generations', () => {
  it('creates only the reviewed manual entry with no harvested data or unrelated mutations', () => {
    const state = freshState(); const original = structuredClone(state); const input = content(); const review = reviewLibraryCreate(state, input)
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.content)).toBe(true); expect(Object.isFrozen(review.content!.equipment)).toBe(true)
    input.name = 'Later mutation'; input.equipment!.reverse()
    const next = applyLibraryChange(state, review, { now, makeId: () => 'only-new-entry' })
    expect(next.exerciseLibrary!.entries).toEqual([{ id: 'only-new-entry', revision: 1, status: 'active', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), exercise: content() }])
    expect({ ...next, exerciseLibrary: undefined }).toEqual({ ...state, exerciseLibrary: undefined }); expect(state).toEqual(original)
    expect(next.workouts).toBe(state.workouts); expect(next.logs).toBe(state.logs); expect(next.planHistory).toBe(state.planHistory)
  })
  it('keeps semantic no-ops, changes only content revision for actual edits, and keeps identity across archive/restore', () => {
    const state = setup(); expect(edit(state, {})).toBe(state); expect(edit(state, { equipment: [...content().equipment!].reverse() })).toBe(state)
    const changed = edit(state, { name: 'Edited manual name' }, now + 1)
    expect(first(changed)).toMatchObject({ id: first(state).id, revision: 2, createdAt: first(state).createdAt, updatedAt: new Date(now + 1).toISOString(), status: 'active' })
    const archived = archive(changed, true, now + 2); expect(first(archived).revision).toBe(2); expect(archive(archived, true, now + 3)).toBe(archived)
    const restored = archive(archived, false, now + 4); expect(first(restored).id).toBe(first(state).id); expect(first(restored).revision).toBe(2)
    expect(restored.workouts).toEqual(state.workouts); expect(restored.logs).toEqual(state.logs)
  })
  it('treats absent and explicit no-equipment and absent versus empty notes as distinct content', () => {
    const state = setup(); const input = { ...first(state).exercise }; delete input.equipment; delete input.notes
    const absent = applyLibraryChange(state, reviewLibraryEdit(state, first(state).id, input), { now })
    const explicit = edit(absent, { equipment: [], notes: '' }); expect(first(explicit).revision).toBe(first(absent).revision + 1)
    expect(first(explicit).exercise.equipment).toEqual([]); expect(first(explicit).exercise.notes).toBe('')
  })
  it('never overflows safe revisions, but allows no-op edit and archive/restore at the limit', () => {
    const state = setup(); first(state).revision = Number.MAX_SAFE_INTEGER
    expect(() => reviewLibraryEdit(state, first(state).id, { ...content(), name: 'New' })).toThrow(/revision/i)
    expect(edit(state, {})).toBe(state); const next = archive(state, true); expect(first(next).revision).toBe(Number.MAX_SAFE_INTEGER)
    expect(first(archive(next, false)).revision).toBe(Number.MAX_SAFE_INTEGER)
  })
  it.each([NaN, Infinity, -1, 8640000000000001, Date.parse('10000-01-01')])('rejects invalid injected update time %s without allocating or mutating', time => {
    const state = setup(); const before = structuredClone(state); const allocate = vi.fn(() => 'new-entry')
    expect(() => applyLibraryChange(state, reviewLibraryCreate(state, content()), { now: time, makeId: allocate })).toThrow(); expect(allocate).not.toHaveBeenCalled(); expect(state).toEqual(before)
  })
  it('rejects backward time for edit/archive/restore and never lowers ordered timestamps', () => {
    const state = setup(); const before = structuredClone(state)
    expect(() => edit(state, { reps: '20' }, now - 1)).toThrow(); expect(() => archive(state, true, now - 1)).toThrow(); expect(state).toEqual(before)
    const later = archive(state, true, now + 2000); expect(() => archive(later, false, now + 1999)).toThrow()
  })
  it('reserves all current, historic, orphan-origin and external identities with bounded retry', () => {
    const state = setup(); state.workouts[0].exercises[0].libraryOrigin = { version: 1, entryId: 'orphan-ancestry', revision: 7 }
    const collisions = [first(state).id, state.workouts[0].id, state.workouts[0].exercises[0].id, state.activeSession!.sets[0].id, state.logs[0].id, state.planHistory[0].id, 'orphan-ancestry', 'external-reference']
    for (const collision of collisions) {
      const allocate = vi.fn().mockReturnValueOnce(collision).mockReturnValue('distinct-new-entry')
      const next = applyLibraryChange(state, reviewLibraryCreate(state, content()), { now, makeId: allocate, reserved: { entryId: 'external-reference' } })
      expect(next.exerciseLibrary!.entries.at(-1)!.id).toBe('distinct-new-entry'); expect(allocate).toHaveBeenCalledTimes(2)
    }
    const before = structuredClone(state); const review = reviewLibraryCreate(state, content()); const fail = vi.fn(() => first(state).id)
    expect(() => applyLibraryChange(state, review, { now, makeId: fail })).toThrow(); expect(fail.mock.calls.length).toBeLessThanOrEqual(100); expect(state).toEqual(before)
    expect(applyLibraryChange(state, review, { now }).exerciseLibrary!.entries).toHaveLength(2)
  })
  it('rejects forged reviews, exact deserialization, library swaps, entry swaps, and same-identity mutations', () => {
    const state = setup(); const review = reviewLibraryEdit(state, first(state).id, { ...content(), reps: '20' })
    expect(() => applyLibraryChange(state, { ...review }, { now })).toThrow(); expect(() => applyLibraryChange(structuredClone(state), review, { now })).toThrow()
    expect(() => applyLibraryChange({ ...state }, review, { now })).toThrow()
    const wrapper = state.exerciseLibrary; state.exerciseLibrary = structuredClone(wrapper); expect(() => applyLibraryChange(state, review, { now })).toThrow(); state.exerciseLibrary = wrapper
    const old = first(state); state.exerciseLibrary!.entries[0] = structuredClone(old); expect(() => applyLibraryChange(state, review, { now })).toThrow(); state.exerciseLibrary!.entries[0] = old
    state.profile.name = 'Same object mutated'; expect(() => applyLibraryChange(state, review, { now })).toThrow()
  })
  it('invalidates old copies on archive/restore and edit/revert even with identical final display values', () => {
    const state = setup(); const review = reviewLibraryCopy(state, first(state).id)
    const restored = archive(archive(state, true), false)
    expect(first(restored)).toEqual(first(state)); expect(() => assertLibraryCopyCurrent(restored, review)).toThrow()
    const reverted = edit(edit(state, { name: 'Temporary' }), { name: content().name })
    expect(first(reverted).exercise).toEqual(first(state).exercise); expect(first(reverted).revision).toBe(3); expect(() => assertLibraryCopyCurrent(reverted, review)).toThrow()
    expect(() => assertLibraryCopyCurrent(JSON.parse(JSON.stringify(state)), review)).toThrow()
    expect(() => reviewLibraryCopy(archive(state, true), first(state).id)).toThrow(/archiv/i)
  })
})

describe('independent personal-copy ancestry and session contracts', () => {
  it('freezes copied ancestry and materializes distinct standalone exercises without requiring live library existence', () => {
    const state = setup(); const review = reviewLibraryCopy(state, first(state).id); const before = structuredClone(state)
    expect(Object.isFrozen(review.exercise.libraryOrigin)).toBe(true); expect(Object.isFrozen(review.exercise.equipment)).toBe(true)
    const one = materializeLibraryCopy(state, review); const two = materializeLibraryCopy(state, review, { reserved: one })
    expect(one.id).not.toBe(two.id); expect(one.id).not.toBe(first(state).id); expect(one.libraryOrigin).toEqual({ version: 1, entryId: first(state).id, revision: 1 })
    one.libraryOrigin!.revision = 99; one.equipment!.push('exercise-mat'); expect(review.exercise.libraryOrigin!.revision).toBe(1); expect(state).toEqual(before)
    const independent = { ...state, workouts: [{ ...state.workouts[0], exercises: [two] }] }; delete independent.exerciseLibrary; expect(parseState(independent)).toEqual(independent)
  })
  it('bounds copy allocation failure and keeps the same valid review retryable', () => {
    const state = setup(); const review = reviewLibraryCopy(state, first(state).id); const before = structuredClone(state)
    const fail = vi.fn(() => first(state).id); expect(() => materializeLibraryCopy(state, review, { makeId: fail })).toThrow(); expect(fail.mock.calls.length).toBeLessThanOrEqual(100); expect(state).toEqual(before)
    expect(materializeLibraryCopy(state, review).libraryOrigin).toEqual(review.exercise.libraryOrigin)
  })
  it('retains ancestry through rename, plan history, copy, schedule, start and completed history without live name lookup', () => {
    const state = setup(); const copied = materializeLibraryCopy(state, reviewLibraryCopy(state, first(state).id)); const draft = structuredClone(state.workouts[0]); draft.exercises.push(copied)
    const saved = savePlanRevision(state, [draft, ...state.workouts.slice(1)], 'Added personal copy', new Date(now)); const editedDraft = structuredClone(draft); editedDraft.exercises.at(-1)!.name = 'Independent copied name'
    const renamed = prepareWorkoutForSave(editedDraft, draft, { reserved: saved }); expect(renamed.exercises.at(-1)!.id).not.toBe(copied.id); expect(renamed.exercises.at(-1)!.libraryOrigin).toEqual(copied.libraryOrigin)
    const duplicate = copyWorkout(renamed, { reserved: saved }); expect(duplicate.exercises.at(-1)!.libraryOrigin).toEqual(copied.libraryOrigin)
    const scheduled = schedulePreview([renamed], [{ day: 'Monday', workoutId: renamed.id }, { day: 'Friday', workoutId: renamed.id }], 600, { reserved: saved })
    for (const workout of scheduled) expect(workout.exercises.at(-1)!.libraryOrigin).toEqual(copied.libraryOrigin)
    const active = startSession(scheduled[1], now); const row = active.sets.find(row => row.exerciseId === active.workout.exercises.at(-1)!.id)!; row.completed = true; row.reps = 8
    first(state).exercise.name = 'Unrelated current live name'; const log = finishSession(active, now + 5000)
    expect(log.exerciseSnapshots!.at(-1)).toMatchObject({ name: 'Independent copied name', libraryOrigin: copied.libraryOrigin })
    log.exerciseSnapshots!.at(-1)!.libraryOrigin!.revision = 22; expect(active.workout.exercises.at(-1)!.libraryOrigin!.revision).toBe(1)
  })
  it('preserves exact completed rows and timers when adding and replacing from a live personal review', () => {
    const state = setup(); const token = reviewLibraryCopy(state, first(state).id); const selected = { ...token.exercise, name: 'Edited addition draft', sets: 2, reps: '31 sec' }
    const addReview = reviewSessionAddition(state, selected, token); expect(Object.isFrozen(addReview.exercise.libraryOrigin)).toBe(true)
    const added = applySessionAddition(state, addReview); const newExercise = added.activeSession!.workout.exercises.at(-1)!
    expect(newExercise).toMatchObject({ name: selected.name, sets: 2, reps: '31 sec', libraryOrigin: token.exercise.libraryOrigin }); expect(added.activeSession!.sets.slice(0, state.activeSession!.sets.length)).toEqual(state.activeSession!.sets)
    const token2 = reviewLibraryCopy(added, first(added).id); const source = added.activeSession!.workout.exercises[0]; const replacementReview = reviewSessionReplacement(added, source.id, token2.exercise, token2)
    expect(Object.isFrozen(replacementReview.replacement.libraryOrigin)).toBe(true); const replaced = applySessionReplacement(added, replacementReview)
    expect(replaced.activeSession!.sets.find(row => row.id === state.activeSession!.sets[0].id)).toEqual(state.activeSession!.sets[0])
    expect(replaced.activeSession!.restUntil).toBe(state.activeSession!.restUntil); expect(replaced.activeSession!.elapsedSeconds).toBe(state.activeSession!.elapsedSeconds)
    expect(replaced.workouts).toBe(state.workouts); expect(replaced.logs).toBe(state.logs); expect(replaced.planHistory).toBe(state.planHistory)
    const replacement = replaced.activeSession!.workout.exercises.find(exercise => exercise.libraryOrigin && exercise.id !== newExercise.id)!
    const rows = replaced.activeSession!.sets.filter(row => row.exerciseId === replacement.id); expect(rows).toHaveLength(replacementReview.removedSets.length)
    rows.forEach(row => expect(row).toMatchObject({ reps: null, weightKg: null, seconds: null, rpe: null, warmup: false, completed: false }))
    expect(parseState(replaced)).toEqual(replaced)
  })
  it.each(['archive', 'edit', 'archive-restore', 'reload', 'state-mutation'] as const)('rejects live addition and replacement at both review and apply after %s', change => {
    const state = setup(); const token = reviewLibraryCopy(state, first(state).id); const add = reviewSessionAddition(state, token.exercise, token); const source = state.activeSession!.workout.exercises[0].id; const replace = reviewSessionReplacement(state, source, token.exercise, token)
    const next = change === 'archive' ? archive(state, true) : change === 'edit' ? edit(state, { reps: '19' }) : change === 'archive-restore' ? archive(archive(state, true), false) : change === 'reload' ? structuredClone(state) : state
    if (change === 'state-mutation') next.profile.name = 'Changed account state'
    expect(() => reviewSessionAddition(next, token.exercise, token)).toThrow(); expect(() => reviewSessionReplacement(next, source, token.exercise, token)).toThrow()
    expect(() => applySessionAddition(next, add)).toThrow(); expect(() => applySessionReplacement(next, replace)).toThrow()
  })
  it('allows historical origin snapshots without live tokens to remain independent of library archive/edit', () => {
    const state = setup(); const selected = materializeLibraryCopy(state, reviewLibraryCopy(state, first(state).id)); const add = reviewSessionAddition(state, selected); const replace = reviewSessionReplacement(state, state.activeSession!.workout.exercises[0].id, selected)
    const changed = archive(edit(state, { name: 'New live name' }), true)
    expect(applySessionAddition(changed, add).activeSession!.workout.exercises.at(-1)!.name).toBe(content().name)
    expect(applySessionReplacement(changed, replace).activeSession!.workout.exercises.some(exercise => exercise.name === content().name)).toBe(true)
  })
  it('freezes nested ancestry in planned/session group create and remove review paths', () => {
    const state = setup(); const copied = materializeLibraryCopy(state, reviewLibraryCopy(state, first(state).id)); const workout = structuredClone(state.workouts[0]); workout.exercises[0] = copied
    const planned = reviewPlannedGrouping(workout, { name: 'Planned pair', restSeconds: 17, rounds: [workout.exercises.slice(0, 2).map(exercise => ({ exerciseId: exercise.id, setNumber: 1 }))] })
    expect(Object.isFrozen(planned.rounds[0].rows[0].exercise.libraryOrigin)).toBe(true)
    const grouped = applyPlannedGrouping(workout, planned); const removed = reviewPlannedGroupRemoval(grouped, grouped.plannedGrouping!.groups[0].id); expect(Object.isFrozen(removed.rounds[0].rows[0].exercise.libraryOrigin)).toBe(true)
    state.activeSession = startSession(workout, now); const rows = workout.exercises.slice(0, 2).map(exercise => state.activeSession!.sets.find(row => row.exerciseId === exercise.id)!.id)
    const sessionReview = reviewSessionGrouping(state, { name: 'Session pair', restSeconds: 19, rounds: [rows] }); expect(Object.isFrozen(sessionReview.rounds[0].rows[0].exercise.libraryOrigin)).toBe(true)
    const runtime = applySessionGrouping(state, sessionReview); const runtimeRemoval = reviewSessionGroupRemoval(runtime, runtime.activeSession!.grouping!.groups[0].id); expect(Object.isFrozen(runtimeRemoval.rounds[0].rows[0].exercise.libraryOrigin)).toBe(true)
  })
  it('never collapses identical distinct personal entries or conflates them with saved-plan snapshots', () => {
    const state = setup(); const next = applyLibraryChange(state, reviewLibraryCreate(state, content()), { now, makeId: () => 'personal-second' })
    next.workouts[0].exercises.push(materializeLibraryCopy(next, reviewLibraryCopy(next, first(next).id)))
    const personal = exerciseCatalog(next.workouts, next.exerciseLibrary).filter(item => item.libraryEntryId)
    expect(personal).toHaveLength(2); expect(new Set(personal.map(item => item.key)).size).toBe(2); expect(personal.map(item => item.libraryEntryId).sort()).toEqual(['personal-entry', 'personal-second'])
    expect(exerciseCatalog(next.workouts, next.exerciseLibrary).filter(item => item.exercise.name === content().name)).toHaveLength(3)
    const archived = archive(next, true); expect(exerciseCatalog(archived.workouts, archived.exerciseLibrary).filter(item => item.libraryEntryId)).toHaveLength(1)
  })
})
