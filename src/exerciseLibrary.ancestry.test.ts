// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { freshState, parseBackup, parseState, saveState } from './storage'
import { applyLibraryChange, materializeLibraryCopy, reviewLibraryArchive, reviewLibraryCopy, reviewLibraryCreate, reviewLibraryEdit } from './exerciseLibrary'
import { applySessionAddition, reviewSessionAddition } from './sessionAddition'
import { applySessionReplacement, reviewSessionReplacement } from './sessionReplacement'
import { copyWorkout, prepareWorkoutForSave, savePlanRevision, schedulePreview } from './planning'
import { finishSession, startSession } from './session'
import { reviewPlannedGrouping } from './plannedGrouping'
import { reviewSessionGrouping } from './sessionGrouping'
import { readPlanDraft, savePlanDraft } from './planDraft'
import { pausedCloudState } from './cloud'
import { exerciseCatalog } from './exerciseCatalog'
import type { AppState, Exercise, LibraryContent } from './types'

const now = Date.parse('2026-10-15T12:00:00.000Z')
const content: LibraryContent = { name: 'Personal carry', sets: 2, reps: '45 sec', restSeconds: 30, category: 'Custom', equipment: [] }
const setup = () => {
  const state = freshState()
  return applyLibraryChange(state, reviewLibraryCreate(state, content), { now, makeId: () => 'my-entry' })
}
function active() { const state = setup(); state.activeSession = startSession(state.workouts[0], now, { reserved: state }); return state }
const selected = (state: AppState) => reviewLibraryCopy(state, 'my-entry')
const origin = { version: 1, entryId: 'my-entry', revision: 1 } as const

describe('ancestry is an isolated historic fact, not a live library binding', () => {
  it('survives materialization, rename, copy, schedule, plan revision, draft, start and finish', () => {
    let state = setup(); const copy = materializeLibraryCopy(state, selected(state))
    const original = state.workouts[0]; const draft = structuredClone(original); draft.exercises.push(copy)
    state = savePlanRevision(state, [draft, ...state.workouts.slice(1)], 'Add personal movement', new Date(now))
    const nextDraft = structuredClone(draft); nextDraft.exercises.at(-1)!.name = 'Renamed carry'
    const renamed = prepareWorkoutForSave(nextDraft, draft, { reserved: state })
    expect(renamed.exercises.at(-1)!.id).not.toBe(copy.id); expect(renamed.exercises.at(-1)!.libraryOrigin).toEqual(origin)
    const duplicated = copyWorkout(renamed, { reserved: state }); expect(duplicated.exercises.at(-1)!.libraryOrigin).toEqual(origin)
    const scheduled = schedulePreview([renamed], [{ workoutId: renamed.id, day: 'Monday' }, { workoutId: renamed.id, day: 'Friday' }], 600, { reserved: state })
    expect(scheduled.every(workout => JSON.stringify(workout.exercises.at(-1)!.libraryOrigin) === JSON.stringify(origin))).toBe(true)
    savePlanDraft(duplicated); expect(readPlanDraft()!.exercises.at(-1)!.libraryOrigin).toEqual(origin)
    const session = startSession(duplicated, now, { reserved: state }); session.sets[0].completed = true
    const log = finishSession(session, now + 60000)
    expect(log.exerciseSnapshots!.at(-1)!.libraryOrigin).toEqual(origin)
    expect(log.exerciseSnapshots!.at(-1)!.libraryOrigin).not.toBe(session.workout.exercises.at(-1)!.libraryOrigin)
    state.logs.push(log)
    state = applyLibraryChange(state, reviewLibraryEdit(state, 'my-entry', { ...content, name: 'New library content' }), { now: now + 60000 })
    state = applyLibraryChange(state, reviewLibraryArchive(state, 'my-entry', true), { now: now + 60000 })
    expect(state.workouts[0].exercises.at(-1)).toEqual(copy); expect(state.logs[0]).toEqual(log)
    expect(parseBackup(JSON.stringify(state))).toEqual(state)
    delete state.exerciseLibrary
    expect(parseState(state)).toEqual(state)
    expect(pausedCloudState(state).workouts[0].exercises.at(-1)!.libraryOrigin).toEqual(origin)
  })

  it('freezes nested ancestry in planned and session grouping reviews', () => {
    const state = setup(); state.workouts[0].exercises[0].libraryOrigin = structuredClone(origin)
    const workout = state.workouts[0]
    const planReview = reviewPlannedGrouping(workout, { name: 'My pair', restSeconds: 0, rounds: [[{ exerciseId: workout.exercises[0].id, setNumber: 1 }, { exerciseId: workout.exercises[1].id, setNumber: 1 }]] })
    expect(Object.isFrozen(planReview.rounds[0].rows[0].exercise.libraryOrigin)).toBe(true)
    state.activeSession = startSession(workout, now, { reserved: state })
    const sessionReview = reviewSessionGrouping(state, { name: 'My pair', restSeconds: 0, rounds: [[state.activeSession.sets[0].id, state.activeSession.sets.find(row => row.exerciseId === workout.exercises[1].id)!.id]] })
    expect(Object.isFrozen(sessionReview.rounds[0].rows[0].exercise.libraryOrigin)).toBe(true)
    expect(() => { sessionReview.rounds[0].rows[0].exercise.libraryOrigin!.revision = 2 }).toThrow()
  })

  it('copies live selections into additions with explicit target edits and keeps exact blank rows', () => {
    const state = active(); const token = selected(state); const chosen = { ...token.exercise, sets: 5, reps: '8–10', notes: 'My explicit session edit' }
    const review = reviewSessionAddition(state, chosen, token)
    expect(Object.isFrozen(review.exercise.libraryOrigin)).toBe(true)
    const next = applySessionAddition(state, review); const added = next.activeSession!.workout.exercises.at(-1)!
    expect(added).toEqual({ ...chosen, id: expect.any(String) }); expect(added.id).not.toBe('my-entry')
    expect(next.activeSession!.sets.filter(row => row.exerciseId === added.id)).toHaveLength(5)
    expect(next.activeSession!.sets.filter(row => row.exerciseId === added.id).every(row => row.reps === null && row.seconds === null && row.weightKg === null && !row.completed && !row.warmup)).toBe(true)
    expect(state.exerciseLibrary!.entries[0].exercise).toEqual(content)
    next.activeSession!.sets.at(-1)!.completed = true
    expect(finishSession(next.activeSession!, now + 1000).exerciseSnapshots!.at(-1)!.libraryOrigin).toEqual(origin)
  })

  it('replacements preserve exactly unfinished row count instead of library planned count', () => {
    const state = active(); const token = selected(state); const source = state.activeSession!.workout.exercises[0]
    state.activeSession!.sets[0].completed = true
    // A fresh token is needed after changing the source snapshot.
    const currentToken = selected(state)
    expect(() => reviewSessionReplacement(state, source.id, token.exercise, token)).toThrow('changed')
    const review = reviewSessionReplacement(state, source.id, { ...currentToken.exercise, sets: 20 }, currentToken)
    expect(Object.isFrozen(review.replacement.libraryOrigin)).toBe(true)
    const remaining = state.activeSession!.sets.filter(row => row.exerciseId === source.id && !row.completed).length
    const next = applySessionReplacement(state, review); const replacement = next.activeSession!.workout.exercises.find(exercise => exercise.name === content.name)!
    expect(next.activeSession!.sets.filter(row => row.exerciseId === replacement.id)).toHaveLength(remaining)
    expect(replacement.sets).toBe(20); expect(replacement.libraryOrigin).toEqual(origin)
    expect(next.activeSession!.sets.find(row => row.id === state.activeSession!.sets[0].id)).toEqual(state.activeSession!.sets[0])
  })

  it.each(['addition', 'replacement'] as const)('rejects stale/mismatched live %s tokens while historic ancestry stays usable', kind => {
    const state = active(); const token = selected(state); const sourceId = state.activeSession!.workout.exercises[0].id
    const bad = { ...token.exercise, libraryOrigin: { ...origin, revision: 2 } }
    const review = () => kind === 'addition' ? reviewSessionAddition(state, token.exercise, token) : reviewSessionReplacement(state, sourceId, token.exercise, token)
    expect(() => kind === 'addition' ? reviewSessionAddition(state, bad, token) : reviewSessionReplacement(state, sourceId, bad, token)).toThrow('changed')
    const reviewed = review()
    const archived = applyLibraryChange(state, reviewLibraryArchive(state, 'my-entry', true), { now })
    expect(() => kind === 'addition' ? applySessionAddition(archived, reviewed as ReturnType<typeof reviewSessionAddition>) : applySessionReplacement(archived, reviewed as ReturnType<typeof reviewSessionReplacement>)).toThrow('changed')
    // Explicit historic copying requires no current library existence or active status.
    const historical: Exercise = { ...structuredClone(token.exercise), id: 'historic-source' }
    expect(() => kind === 'addition' ? applySessionAddition(archived, reviewSessionAddition(archived, historical)) : applySessionReplacement(archived, reviewSessionReplacement(archived, sourceId, historical))).not.toThrow()
  })

  it.each(['addition', 'replacement'] as const)('keeps a live %s review retryable after storage failure and reserves orphan selected origin IDs', kind => {
    const state = active(); const token = selected(state); const sourceId = state.activeSession!.workout.exercises[0].id
    const addReview = reviewSessionAddition(state, token.exercise, token); const replaceReview = reviewSessionReplacement(state, sourceId, token.exercise, token)
    const apply = () => kind === 'addition' ? applySessionAddition(state, addReview) : applySessionReplacement(state, replaceReview)
    const raw = saveState(state); const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => saveState(apply(), raw)).toThrow('quota'); setItem.mockRestore()
    expect(() => saveState(apply(), raw)).not.toThrow()
    const historical = { ...token.exercise, id: 'historical-copy', libraryOrigin: { version: 1 as const, entryId: 'unresolved-origin', revision: 8 } }
    let sequence = 0; const makeId = () => sequence++ === 0 ? 'unresolved-origin' : `fresh-${sequence}`
    const next = kind === 'addition' ? applySessionAddition(state, reviewSessionAddition(state, historical), makeId) : applySessionReplacement(state, reviewSessionReplacement(state, sourceId, historical), makeId)
    expect(next.activeSession!.workout.exercises.some(exercise => exercise.id === 'unresolved-origin')).toBe(false)
  })

  it('keeps distinct personal identities and captured versions out of descriptive deduplication', () => {
    let state = setup(); state = applyLibraryChange(state, reviewLibraryCreate(state, content), { now, makeId: () => 'second-entry' })
    const old = materializeLibraryCopy(state, selected(state)); state.workouts[0].exercises.push(old)
    state = applyLibraryChange(state, reviewLibraryEdit(state, 'my-entry', { ...content, reps: '60 sec' }), { now })
    const catalog = exerciseCatalog(state.workouts, state.exerciseLibrary)
    const personal = catalog.filter(item => item.libraryEntryId)
    expect(personal).toHaveLength(2); expect(new Set(personal.map(item => item.key)).size).toBe(2)
    expect(personal.every(item => item.source.includes('manual'))).toBe(true)
    expect(catalog.find(item => item.source === 'Your plan' && item.exercise.id === old.id)!.exercise.libraryOrigin).toEqual(origin)
    expect(personal.find(item => item.libraryEntryId === 'my-entry')!.exercise.libraryOrigin!.revision).toBe(2)
    const archived = applyLibraryChange(state, reviewLibraryArchive(state, 'my-entry', true), { now })
    expect(exerciseCatalog(archived.workouts, archived.exerciseLibrary).filter(item => item.libraryEntryId)).toHaveLength(1)
    expect(catalog.find(item => item.exercise.id === old.id)!.exercise.name).toBe(content.name)
  })

  it('retains equal-content historical plan origins by entry/revision without relabeling them as live entries', () => {
    const state = setup(); const exercise = structuredClone(state.workouts[0].exercises[0])
    state.workouts[0].exercises = [exercise, ...[
      { entryId: 'one', revision: 1 }, { entryId: 'one', revision: 2 }, { entryId: 'two', revision: 1 },
    ].map((captured, index) => ({ ...structuredClone(exercise), id: `snapshot-${index}`, libraryOrigin: { version: 1 as const, ...captured } }))]
    const entries = exerciseCatalog(state.workouts, state.exerciseLibrary).filter(item => item.exercise.name === exercise.name)
    expect(entries).toHaveLength(4)
    expect(entries.every(item => item.source === 'Your plan' && item.libraryEntryId === undefined)).toBe(true)
    expect(entries.map(item => item.exercise.libraryOrigin)).toEqual([undefined, { version: 1, entryId: 'one', revision: 1 }, { version: 1, entryId: 'one', revision: 2 }, { version: 1, entryId: 'two', revision: 1 }])
  })
})
