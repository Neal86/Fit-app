// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { freshState, parseState, STORAGE_KEY } from './storage'
import { loadState as oldLoad, parseState as oldParse, saveState as oldSave } from './testFixtures/preLibraryStorage'
import { finishSession, startSession } from './session'
import type { AppState } from './types'

const timestamp = '2026-10-15T12:00:00.000Z'
const origin = { version: 1, entryId: 'manual-entry', revision: 1 } as const
function setup(): AppState {
  const state = freshState()
  state.exerciseLibrary = { version: 1, entries: [{ id: 'manual-entry', revision: 1, status: 'active', createdAt: timestamp, updatedAt: timestamp, exercise: { name: 'User entry', category: '', sets: 1, reps: '1', restSeconds: 0 } }] }
  state.planHistory = [{ id: 'prior-plan', savedAt: timestamp, label: 'Earlier', workouts: structuredClone(state.workouts) }]
  state.activeSession = startSession(state.workouts[0], Date.parse(timestamp), { reserved: state }); state.activeSession.sets[0].completed = true
  state.logs = [finishSession(state.activeSession, Date.parse(timestamp))]; state.logs[0].id = 'old-log'
  return state
}

describe('strict optional library metadata', () => {
  it('keeps absent wrappers absent and accepts empty wrappers and unclassified versus explicitly empty equipment', () => {
    expect(Object.hasOwn(parseState(freshState()), 'exerciseLibrary')).toBe(false)
    expect(parseState({ ...freshState(), exerciseLibrary: { version: 1, entries: [] } }).exerciseLibrary).toEqual({ version: 1, entries: [] })
    const state = setup(); expect(Object.hasOwn(parseState(state).exerciseLibrary!.entries[0].exercise, 'equipment')).toBe(false)
    state.exerciseLibrary!.entries[0].exercise.equipment = []
    expect(parseState(state).exerciseLibrary!.entries[0].exercise.equipment).toEqual([])
  })

  it.each([null, undefined, {}, [], { version: 2, entries: [] }, { version: 1, entries: undefined }, { version: 1, entries: new Array(1) }, { version: 1, entries: [], extra: null }])('rejects malformed present wrapper %j', wrapper => {
    expect(() => parseState({ ...freshState(), exerciseLibrary: wrapper })).toThrow()
  })

  it.each([
    { id: '' }, { id: ' ' }, { id: 'x'.repeat(151) }, { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'deleted' }, { status: null }, { createdAt: '2026-10-15T12:00:00Z' }, { updatedAt: '2026-10-15T13:00:00.000+01:00' },
    { createdAt: '2026-02-30T12:00:00.000Z' }, { updatedAt: '2026-10-15T11:00:00.000Z' }, { exercise: null }, { extra: undefined },
  ])('rejects invalid entry field patch %j', patch => {
    const state = setup(); Object.assign(state.exerciseLibrary!.entries[0], patch)
    expect(() => parseState(state)).toThrow()
  })

  it.each([
    { id: 'not-content' }, { libraryOrigin: origin }, { name: '' }, { name: 'x'.repeat(101) }, { category: 'x'.repeat(101) },
    { sets: 0 }, { sets: 21 }, { sets: 1.1 }, { reps: '' }, { reps: 'x'.repeat(51) }, { restSeconds: -1 }, { restSeconds: 901 }, { restSeconds: 0.1 },
    { notes: undefined }, { notes: null }, { notes: 'x'.repeat(1001) }, { equipment: undefined }, { equipment: null }, { equipment: new Array(1) }, { equipment: ['bench', 'bench'] }, { equipment: ['unknown'] }, { extra: 1 },
  ])('rejects invalid content field patch %j', patch => {
    const state = setup(); Object.assign(state.exerciseLibrary!.entries[0].exercise, patch)
    expect(() => parseState(state)).toThrow()
  })

  it('requires dense exact arrays, exact own fields, unique IDs and at most 500 entries', () => {
    const state = setup(); const entry = state.exerciseLibrary!.entries[0]
    state.exerciseLibrary!.entries.push(structuredClone(entry)); expect(() => parseState(state)).toThrow()
    state.exerciseLibrary!.entries = Array.from({ length: 501 }, (_, index) => ({ ...entry, id: `entry-${index}` })); expect(() => parseState(state)).toThrow()
    state.exerciseLibrary!.entries = [entry]; Object.assign(state.exerciseLibrary!.entries, { stray: undefined }); expect(() => parseState(state)).toThrow()
    state.exerciseLibrary!.entries = [Object.assign(Object.create({ revision: 1 }), { ...entry, revision: undefined })]; expect(() => parseState(state)).toThrow()
    state.exerciseLibrary!.entries = [entry]; Object.defineProperty(entry.exercise, 'hidden', { value: true }); expect(() => parseState(state)).toThrow()
  })

  it('rejects aliases against every definition domain but permits matching origin references', () => {
    const sample = setup()
    const identities = [sample.workouts[0].id, sample.workouts[0].exercises[0].id, sample.activeSession!.id, sample.activeSession!.sets[0].id, sample.logs[0].id, sample.planHistory[0].id]
    for (const id of identities) { const state = structuredClone(sample); state.exerciseLibrary!.entries[0].id = id; expect(() => parseState(state)).toThrow() }
    sample.workouts[0].exercises[0].libraryOrigin = structuredClone(origin)
    expect(parseState(sample)).toEqual(sample)
  })

  const locations: { label: string; place: (state: AppState, origin: unknown) => void }[] = [
    { label: 'plan', place: (state, value) => Object.assign(state.workouts[0].exercises[0], { libraryOrigin: value }) },
    { label: 'active', place: (state, value) => Object.assign(state.activeSession!.workout.exercises[0], { libraryOrigin: value }) },
    { label: 'plan history', place: (state, value) => Object.assign(state.planHistory[0].workouts[0].exercises[0], { libraryOrigin: value }) },
    { label: 'log', place: (state, value) => Object.assign(state.logs[0].exerciseSnapshots![0], { libraryOrigin: value }) },
  ]
  for (const location of locations) {
    it(`preserves ${location.label} provenance without an existing library and makes old readers fail closed`, () => {
      const state = setup(); delete state.exerciseLibrary; location.place(state, structuredClone(origin))
      expect(parseState(state)).toEqual(state); expect(() => oldParse(state)).toThrow()
      const raw = JSON.stringify(state); localStorage.setItem(STORAGE_KEY, raw)
      expect(oldLoad().error).not.toBe(''); expect(oldLoad().raw).toBe(raw)
      expect(() => oldSave(state)).toThrow(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
    })
    it.each([undefined, null, {}, { ...origin, version: 2 }, { ...origin, entryId: '' }, { ...origin, revision: 0 }, { ...origin, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...origin, extra: true }])(`rejects invalid ${location.label} origin %j`, value => {
      const state = setup(); location.place(state, value); expect(() => parseState(state)).toThrow()
    })
  }

  it.each([2, 3])('rejects new metadata anywhere before version %s migration can discard it', version => {
    for (const metadata of ['exerciseLibrary', 'libraryOrigin']) {
      const state = freshState(); delete state.exerciseLibrary
      Object.assign(state, { version, activeSession: { discarded: { [metadata]: undefined } } })
      expect(() => parseState(state)).toThrow('requires version 4')
    }
  })

  it('rejects new metadata at unrecognized locations even when a nested parser would discard it', () => {
    for (const key of ['exerciseLibrary', 'libraryOrigin']) {
      const state = setup(); Object.assign(state.nutrition, { [key]: undefined }); expect(() => parseState(state)).toThrow()
    }
    const state = setup(); Object.defineProperty(state, 'exerciseLibrary', { value: state.exerciseLibrary, enumerable: false })
    expect(() => parseState(state)).toThrow()
  })

  it('requires the metadata properties themselves to be own enumerable data fields', () => {
    const state = setup(); const wrapper = state.exerciseLibrary; delete state.exerciseLibrary
    Object.setPrototypeOf(state, { exerciseLibrary: wrapper }); expect(() => parseState(state)).toThrow()
    const plan = setup(); Object.setPrototypeOf(plan.workouts[0].exercises[0], { libraryOrigin: origin }); expect(() => parseState(plan)).toThrow()
    const hidden = setup(); Object.defineProperty(hidden.workouts[0].exercises[0], 'libraryOrigin', { value: origin, enumerable: false }); expect(() => parseState(hidden)).toThrow()
  })
})
