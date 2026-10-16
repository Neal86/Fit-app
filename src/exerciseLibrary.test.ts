// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { applyLibraryChange, assertLibraryCopyCurrent, materializeLibraryCopy, reviewLibraryArchive, reviewLibraryCopy, reviewLibraryCreate, reviewLibraryEdit } from './exerciseLibrary'
import { freshState, saveState } from './storage'
import { parseState } from './stateValidation'
import type { AppState, LibraryContent } from './types'

const now = Date.parse('2026-10-15T12:00:00.000Z')
const content = (): LibraryContent => ({ name: 'My manual movement', category: 'Personal', sets: 3, reps: '6–8', restSeconds: 120, notes: 'My own cue', equipment: ['bench', 'dumbbells'] })
const create = (state = freshState(), input = content(), id = 'personal-entry') => applyLibraryChange(state, reviewLibraryCreate(state, input), { now, makeId: () => id })
const first = (state: AppState) => state.exerciseLibrary!.entries[0]

describe('reviewed manual library changes', () => {
  it('creates only explicitly reviewed content, with exact timestamps and fresh identity', () => {
    const state = freshState(); const input = content(); const before = structuredClone(state)
    const review = reviewLibraryCreate(state, input)
    expect(review).toEqual({ kind: 'create', entry: null, content: input })
    expect(Object.isFrozen(review)).toBe(true); expect(Object.isFrozen(review.content)).toBe(true); expect(Object.isFrozen(review.content!.equipment)).toBe(true)
    input.name = 'Later draft'; input.equipment!.push('barbell')
    const next = applyLibraryChange(state, review, { now, makeId: () => 'personal-entry' })
    expect(first(next)).toEqual({ id: 'personal-entry', revision: 1, status: 'active', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), exercise: content() })
    expect(state).toEqual(before); expect(next.workouts).toBe(state.workouts); expect(next.logs).toBe(state.logs)
    expect(parseState(next)).toEqual(next)
    expect(first(next).exercise).not.toBe(review.content)
  })

  it('increments only actual content changes and preserves revision on archive/restore', () => {
    const state = create()
    const noOp = { ...content(), equipment: ['dumbbells', 'bench'] as LibraryContent['equipment'] }
    expect(applyLibraryChange(state, reviewLibraryEdit(state, first(state).id, noOp), { now })).toBe(state)
    expect(applyLibraryChange(state, reviewLibraryArchive(state, first(state).id, false), { now })).toBe(state)
    const edited = applyLibraryChange(state, reviewLibraryEdit(state, first(state).id, { ...content(), reps: '30 sec' }), { now: now + 1 })
    expect(first(edited)).toMatchObject({ revision: 2, createdAt: first(state).createdAt, updatedAt: new Date(now + 1).toISOString() })
    const archived = applyLibraryChange(edited, reviewLibraryArchive(edited, first(edited).id, true), { now: now + 2 })
    expect(first(archived)).toMatchObject({ revision: 2, status: 'archived', exercise: first(edited).exercise })
    expect(() => reviewLibraryCopy(archived, first(archived).id)).toThrow('archived')
    expect(applyLibraryChange(archived, reviewLibraryArchive(archived, first(archived).id, true), { now: now + 2 })).toBe(archived)
    const restored = applyLibraryChange(archived, reviewLibraryArchive(archived, first(archived).id, false), { now: now + 3 })
    expect(first(restored)).toMatchObject({ revision: 2, status: 'active' })
    expect(first(state).exercise.reps).toBe('6–8')
  })

  it('allows status changes and no-ops at the safe revision maximum but rejects content overflow', () => {
    const state = create(); first(state).revision = Number.MAX_SAFE_INTEGER
    expect(applyLibraryChange(state, reviewLibraryEdit(state, first(state).id, content()), { now })).toBe(state)
    expect(() => reviewLibraryEdit(state, first(state).id, { ...content(), name: 'Changed' })).toThrow('revision limit')
    const archived = applyLibraryChange(state, reviewLibraryArchive(state, first(state).id, true), { now })
    expect(first(archived).revision).toBe(Number.MAX_SAFE_INTEGER)
    const restored = applyLibraryChange(archived, reviewLibraryArchive(archived, first(state).id, false), { now })
    expect(first(restored).revision).toBe(Number.MAX_SAFE_INTEGER)
  })

  it.each([null as unknown as number, NaN, Infinity, -1, 8640000000000001, Date.parse('10000-01-01'), now - 1])('fails atomically at invalid/backward time %s', time => {
    const state = create(); const before = structuredClone(state); const review = reviewLibraryEdit(state, first(state).id, { ...content(), sets: 4 })
    expect(() => applyLibraryChange(state, review, { now: time })).toThrow('time')
    expect(state).toEqual(before)
    expect(first(applyLibraryChange(state, review, { now })).revision).toBe(2)
  })

  it('checks capacity against all entries including archived, while allowing edit and restore', () => {
    const state = create(); const entry = first(state)
    state.exerciseLibrary!.entries = Array.from({ length: 500 }, (_, index) => ({ ...structuredClone(entry), id: `personal-${index}`, status: 'archived' }))
    expect(parseState(state)).toEqual(state)
    expect(() => reviewLibraryCreate(state, content())).toThrow('500')
    expect(first(applyLibraryChange(state, reviewLibraryEdit(state, 'personal-0', { ...content(), sets: 1 }), { now })).revision).toBe(2)
    expect(first(applyLibraryChange(state, reviewLibraryArchive(state, 'personal-0', false), { now })).status).toBe('active')
  })

  it('rejects malformed custom data, forged/cloned reviews and changed source identities', () => {
    const state = create(); const review = reviewLibraryEdit(state, first(state).id, { ...content(), sets: 4 })
    expect(() => reviewLibraryCreate(state, { ...content(), id: 'must-not-harvest' } as LibraryContent)).toThrow('invalid')
    expect(() => applyLibraryChange(state, { ...review }, { now })).toThrow('changed')
    expect(() => applyLibraryChange(structuredClone(state), review, { now })).toThrow('changed')
    const entry = first(state); state.exerciseLibrary!.entries[0] = structuredClone(entry)
    expect(() => applyLibraryChange(state, review, { now })).toThrow('changed')
    state.exerciseLibrary!.entries[0] = entry; state.profile.name = 'New name'
    expect(() => applyLibraryChange(state, review, { now })).toThrow('changed')
  })

  it('rejects stale edit/revert and archive/restore cycles even at identical times/content', () => {
    const state = create(); const review = reviewLibraryEdit(state, first(state).id, { ...content(), sets: 4 }); const copy = reviewLibraryCopy(state, first(state).id)
    const edited = applyLibraryChange(state, review, { now }); const reverted = applyLibraryChange(edited, reviewLibraryEdit(edited, first(edited).id, content()), { now })
    expect(() => applyLibraryChange(reverted, review, { now })).toThrow('changed'); expect(() => assertLibraryCopyCurrent(reverted, copy)).toThrow('changed')
    const archived = applyLibraryChange(state, reviewLibraryArchive(state, first(state).id, true), { now }); const restored = applyLibraryChange(archived, reviewLibraryArchive(archived, first(state).id, false), { now })
    expect(restored).toEqual(state)
    expect(() => assertLibraryCopyCurrent(restored, copy)).toThrow('changed')
  })

  it('reserves all state/draft/source identities and orphan origin references with bounded exhaustion', () => {
    const state = freshState(); state.workouts[0].exercises[0].libraryOrigin = { version: 1, entryId: 'orphan-origin', revision: 8 }
    const ids = [state.workouts[0].id, state.workouts[0].exercises[0].id, 'orphan-origin', 'draft-id', 'fresh-entry']
    const reviewed = reviewLibraryCreate(state, content())
    const next = applyLibraryChange(state, reviewed, { now, reserved: { id: 'draft-id' }, makeId: () => ids.shift()! })
    expect(first(next).id).toBe('fresh-entry')
    const makeId = vi.fn(() => 'orphan-origin')
    expect(() => applyLibraryChange(state, reviewed, { now, makeId })).toThrow('distinct identities'); expect(makeId).toHaveBeenCalledTimes(20)
    expect(state.exerciseLibrary).toBeUndefined()
  })

  it('leaves a legitimate review usable after persistence fails', () => {
    const state = create(); const review = reviewLibraryEdit(state, first(state).id, { ...content(), sets: 4 }); const raw = saveState(state)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => saveState(applyLibraryChange(state, review, { now }), raw)).toThrow('quota'); setItem.mockRestore()
    expect(saveState(applyLibraryChange(state, review, { now }), raw)).toContain('"revision":2')
  })
})

describe('captured library copy authority', () => {
  it('deep freezes an isolated snapshot and mints each destination independently', () => {
    const state = create(); const review = reviewLibraryCopy(state, first(state).id)
    expect(review).toEqual({ entryId: first(state).id, revision: 1, exercise: { ...content(), id: first(state).id, libraryOrigin: { version: 1, entryId: first(state).id, revision: 1 } } })
    expect(Object.isFrozen(review.exercise.libraryOrigin)).toBe(true); expect(Object.isFrozen(review.exercise.equipment)).toBe(true)
    const ids = [first(state).id, 'draft-movement', 'copy-one']
    const copy = materializeLibraryCopy(state, review, { reserved: { id: 'draft-movement' }, makeId: () => ids.shift()! })
    expect(copy.id).toBe('copy-one'); expect(copy.libraryOrigin).toEqual(review.exercise.libraryOrigin)
    copy.libraryOrigin!.revision = 9; copy.equipment!.push('barbell')
    expect(review.exercise.libraryOrigin!.revision).toBe(1); expect(first(state).exercise).toEqual(content())
    expect(materializeLibraryCopy(state, review).id).not.toBe(copy.id)
    expect(() => assertLibraryCopyCurrent(state, { ...review })).toThrow('changed')
    expect(() => materializeLibraryCopy(state, review, { makeId: () => first(state).id })).toThrow('distinct identities')
  })
})
