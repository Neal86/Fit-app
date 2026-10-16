import { describe, expect, it } from 'vitest'
import { freshState, parseState, parseBackup } from './storage'
import { startSession, finishSession } from './session'
import type { LibraryEntry } from './types'

const timestamp = '2026-10-16T12:00:00.000Z'
const entry = (id = 'personal-unique-entry'): LibraryEntry => ({ id, revision: 1, status: 'active', createdAt: timestamp, updatedAt: timestamp, exercise: { name: 'Personal value', category: 'Custom', sets: 3, reps: '7–11', restSeconds: 29, notes: 'My exact note', equipment: ['dumbbells'] } })
const library = () => ({ version: 1, entries: [entry()] })
const stateWithLibrary = () => Object.assign(freshState(), { exerciseLibrary: library() })
const origin = () => ({ version: 1, entryId: 'personal-unique-entry', revision: 1 })

// Independent schema probes deliberately avoid fixtures supplied by the implementation author.
describe('independent personal-library schema contract', () => {
  it('preserves absence, an explicit empty library, archived entries and independent origin-only snapshots', () => {
    const absent = freshState(); expect(Object.hasOwn(parseState(absent), 'exerciseLibrary')).toBe(false)
    const empty = Object.assign(freshState(), { exerciseLibrary: { version: 1, entries: [] } }); expect(parseState(empty)).toEqual(empty)
    const state = stateWithLibrary(); state.exerciseLibrary.entries[0].status = 'archived'; expect(parseState(state)).toEqual(state)
    const historic = freshState(); Object.assign(historic.workouts[0].exercises[0], { libraryOrigin: origin() })
    historic.activeSession = startSession(historic.workouts[0], Date.parse(timestamp)); historic.activeSession.sets[0].reps = 8; historic.activeSession.sets[0].completed = true
    historic.logs = [finishSession(historic.activeSession, Date.parse(timestamp) + 1000)]; historic.activeSession = null
    historic.planHistory = [{ id: 'previous-plan', savedAt: timestamp, label: 'Before', workouts: structuredClone(historic.workouts) }]
    expect(parseBackup(JSON.stringify(historic))).toEqual(historic)
    expect(Object.hasOwn(parseState(historic), 'exerciseLibrary')).toBe(false)
  })
  it.each([undefined, null, [], {}, { version: 2, entries: [] }, { version: 1, entries: null }, { version: 1, entries: [], extra: true }])('rejects present malformed wrapper %j', value => {
    expect(() => parseState(Object.assign(freshState(), { exerciseLibrary: value }))).toThrow()
  })
  it('allows 500 entries including archived, rejects 501 and duplicate identities', () => {
    const state = stateWithLibrary(); state.exerciseLibrary.entries = Array.from({ length: 500 }, (_, i) => ({ ...entry(`entry-${i}`), status: i % 2 ? 'active' : 'archived' }))
    expect(parseState(state)).toEqual(state)
    state.exerciseLibrary.entries.push(entry('entry-500')); expect(() => parseState(state)).toThrow()
    state.exerciseLibrary.entries.pop(); state.exerciseLibrary.entries[499].id = 'entry-0'; expect(() => parseState(state)).toThrow()
  })
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined])('rejects unsafe entry content revision %s', revision => {
    const state = stateWithLibrary(); Object.assign(state.exerciseLibrary.entries[0], { revision }); expect(() => parseState(state)).toThrow()
  })
  it('allows the largest safe content revision without numeric coercion', () => {
    const state = stateWithLibrary(); state.exerciseLibrary.entries[0].revision = Number.MAX_SAFE_INTEGER; expect(parseState(state)).toEqual(state)
  })
  it.each(['2026-10-16', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00.000+01:00', '2026-02-30T12:00:00.000Z', '+010000-01-01T00:00:00.000Z', '', null, undefined])('rejects noncanonical entry timestamp %s', createdAt => {
    const state = stateWithLibrary(); Object.assign(state.exerciseLibrary.entries[0], { createdAt }); expect(() => parseState(state)).toThrow()
  })
  it('rejects updated-before-created, missing fields and unknown fields at every metadata depth', () => {
    const backwards = stateWithLibrary(); backwards.exerciseLibrary.entries[0].updatedAt = '2026-10-16T11:59:59.999Z'; expect(() => parseState(backwards)).toThrow()
    for (const key of ['id', 'revision', 'status', 'createdAt', 'updatedAt', 'exercise']) {
      const state = stateWithLibrary(); Reflect.deleteProperty(state.exerciseLibrary.entries[0], key); expect(() => parseState(state), key).toThrow()
    }
    for (const target of ['wrapper', 'entry', 'exercise']) {
      const state = stateWithLibrary(); const value = target === 'wrapper' ? state.exerciseLibrary : target === 'entry' ? state.exerciseLibrary.entries[0] : state.exerciseLibrary.entries[0].exercise
      Object.assign(value, { unrelated: true }); expect(() => parseState(state), target).toThrow()
    }
    const nested = stateWithLibrary(); Object.assign(nested.exerciseLibrary.entries[0].exercise, { libraryOrigin: origin() }); expect(() => parseState(nested)).toThrow()
    const direct = stateWithLibrary(); Object.assign(direct.exerciseLibrary.entries[0], { libraryOrigin: origin() }); expect(() => parseState(direct)).toThrow()
  })
  it.each([{ sets: 0 }, { sets: 21 }, { sets: 1.1 }, { restSeconds: 901 }, { restSeconds: -1 }, { name: '' }, { name: 'x'.repeat(101) }, { category: 'x'.repeat(101) }, { reps: '' }, { reps: 'x'.repeat(51) }, { notes: null }, { notes: undefined }, { notes: 'x'.repeat(1001) }, { equipment: null }, { equipment: undefined }, { equipment: ['bench', 'bench'] }, { equipment: ['invisible-rack'] }, { id: 'nested-id' }])('rejects invalid library content %j', patch => {
    const state = stateWithLibrary(); Object.assign(state.exerciseLibrary.entries[0].exercise, patch); expect(() => parseState(state)).toThrow()
  })
  it('requires dense metadata arrays without extra own keys and exact own metadata fields', () => {
    const sparse = stateWithLibrary(); sparse.exerciseLibrary.entries = new Array(1); expect(() => parseState(sparse)).toThrow()
    const extra = stateWithLibrary(); Object.assign(extra.exerciseLibrary.entries, { extra: true }); expect(() => parseState(extra)).toThrow()
    const sparseEquipment = stateWithLibrary(); sparseEquipment.exerciseLibrary.entries[0].exercise.equipment = new Array(1); expect(() => parseState(sparseEquipment)).toThrow()
    const inherited = stateWithLibrary(); const inheritedEntry = { ...inherited.exerciseLibrary.entries[0] }; Reflect.deleteProperty(inheritedEntry, 'revision'); Object.setPrototypeOf(inheritedEntry, { revision: 1 }); inherited.exerciseLibrary.entries[0] = inheritedEntry
    expect(() => parseState(inherited)).toThrow()
    const hidden = stateWithLibrary(); Object.defineProperty(hidden.exerciseLibrary.entries[0], 'unknown', { value: true, enumerable: false }); expect(() => parseState(hidden)).toThrow()
    const symbol = stateWithLibrary(); Object.assign(symbol.exerciseLibrary.entries[0].exercise, { [Symbol('extra')]: true }); expect(() => parseState(symbol)).toThrow()
  })
  it.each([undefined, null, {}, { version: 2, entryId: 'source', revision: 1 }, { version: 1, entryId: '', revision: 1 }, { version: 1, entryId: 'source', revision: 0 }, { version: 1, entryId: 'source', revision: Number.MAX_SAFE_INTEGER + 1 }, { version: 1, entryId: 'source', revision: 1, sourceName: 'Invented live lookup' }])('rejects malformed origin %j in both exercises and historical snapshots', value => {
    const state = freshState(); Object.assign(state.workouts[0].exercises[0], { libraryOrigin: value }); expect(() => parseState(state)).toThrow()
    const history = freshState(); const active = startSession(history.workouts[0], Date.parse(timestamp)); active.sets[0].completed = true; active.sets[0].reps = 8
    history.logs = [finishSession(active, Date.parse(timestamp) + 1000)]; Object.assign(history.logs[0].exerciseSnapshots![0], { libraryOrigin: value }); expect(() => parseState(history)).toThrow()
  })
  it('does not require current content or revision to match immutable ancestry', () => {
    const state = stateWithLibrary(); const source = state.exerciseLibrary.entries[0]; source.revision = 9; source.status = 'archived'; source.exercise.name = 'Current library name'
    Object.assign(state.workouts[0].exercises[0], { libraryOrigin: origin(), name: 'Independently edited copy', reps: '31 sec' })
    expect(parseState(state)).toEqual(state)
  })
  it('rejects library identity aliases with current, active, historical and unrelated identity definitions', () => {
    const state = stateWithLibrary(); state.activeSession = startSession(state.workouts[0], Date.parse(timestamp)); state.activeSession.sets[0].completed = true
    const previous = structuredClone(state.activeSession); previous.id = 'old-session'; state.logs = [finishSession(previous, Date.parse(timestamp) + 1000)]
    state.weightHistory = [{ id: 'weight-definition', date: '2026-10-16', weightKg: 75 }]
    state.planHistory = [{ id: 'old-plan', savedAt: timestamp, label: 'Before', workouts: structuredClone(state.workouts) }]
    const aliases = [state.workouts[0].id, state.workouts[0].exercises[0].id, state.activeSession.id, state.activeSession.sets[0].id, state.logs[0].id, state.planHistory[0].id, state.weightHistory[0].id]
    for (const alias of aliases) { const next = structuredClone(state); next.exerciseLibrary.entries[0].id = alias; expect(() => parseState(next), alias).toThrow() }
  })
  it.each([2, 3])('rejects version %i metadata anywhere before migration can discard it', version => {
    for (const key of ['exerciseLibrary', 'libraryOrigin']) {
      const atRoot = { ...freshState(), version, [key]: undefined }; expect(() => parseState(atRoot), `${version} root ${key}`).toThrow()
      const discarded = { ...freshState(), version, activeSession: { ignoredLegacy: { [key]: undefined } } }; expect(() => parseState(discarded), `${version} discarded ${key}`).toThrow()
      const nested = { ...freshState(), version }; Object.assign(nested.workouts[0].exercises[0], { [key]: undefined }); expect(() => parseState(nested), `${version} exercise ${key}`).toThrow()
    }
  })
})
