// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freshState, loadState, parseBackup, parseState, saveState, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })
describe('validated local persistence and backup migration', () => {
  it('loads a fresh profile without seeding fictitious weight history', () => {
    expect(loadState().state.weightHistory).toEqual([])
    expect(loadState().error).toBe('')
  })
  it('migrates existing version 2 data without losing records', () => {
    const state = freshState()
    const legacy = { ...state, version: 2, activeSession: undefined }
    const parsed = parseState(legacy)
    expect(parsed.version).toBe(4)
    expect(parsed.activeSession).toBeNull()
    expect(parsed.workouts).toEqual(state.workouts)
    expect(parsed.profile).toEqual(state.profile)
  })
  it('round trips an in-progress session', () => {
    const state = freshState(); state.activeSession = startSession(state.workouts[0])
    saveState(state)
    expect(loadState().state).toEqual(state)
  })
  it.each([
    ['unsupported version', { ...freshState(), version: 99 }],
    ['empty workouts', { ...freshState(), workouts: [] }],
    ['missing preferences', { ...freshState(), preferences: undefined }],
    ['malformed exercise', { ...freshState(), workouts: [{ ...freshState().workouts[0], exercises: [{}] }] }],
    ['infinite weight', { ...freshState(), profile: { ...freshState().profile, weightKg: Infinity } }],
    ['blank name', { ...freshState(), profile: { ...freshState().profile, name: ' ' } }],
    ['fractional target', { ...freshState(), profile: { ...freshState().profile, weeklyTarget: 2.5 } }],
    ['invalid calendar date', { ...freshState(), weightHistory: [{ id: 'x', date: '2026-02-31', weightKg: 70 }] }],
    ['duplicate workout IDs', { ...freshState(), workouts: [freshState().workouts[0], freshState().workouts[0]] }],
  ])('rejects %s before replacing stored data', (_label, invalid) => {
    saveState(freshState()); const original = localStorage.getItem(STORAGE_KEY)
    expect(() => parseState(invalid)).toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original)
  })
  it('preserves malformed original storage for recovery', () => {
    localStorage.setItem(STORAGE_KEY, '{broken')
    const result = loadState()
    expect(result.error).not.toBe('')
    expect(result.raw).toBe('{broken')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken')
  })
  it('rejects a set referencing an exercise outside the session snapshot', () => {
    const state = freshState(); state.activeSession = startSession(state.workouts[0]); state.activeSession.sets[0].exerciseId = 'unknown'
    expect(() => parseState(state)).toThrow()
  })
  it('rejects an active backup missing all set rows for a snapshot exercise', () => {
    const state = freshState(); state.activeSession = startSession(state.workouts[0]); state.activeSession.sets = state.activeSession.sets.filter(set => set.exerciseId !== state.workouts[0].exercises[0].id)
    expect(() => parseState(state)).toThrow()
  })
  it('rejects active session IDs that collide with saved history', () => {
    const state = freshState(); state.activeSession = startSession(state.workouts[0]); state.activeSession.sets[0].completed = true; state.activeSession.sets[0].reps = 8; state.logs = [finishSession(state.activeSession)]
    expect(() => parseState(state)).toThrow('conflicts')
  })
  it('reports storage quota failure rather than claiming a save', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    expect(() => saveState(freshState())).toThrow('Full')
  })
  it('rejects oversized backups', () => expect(() => parseBackup(' '.repeat(10 * 1024 * 1024 + 1))).toThrow('too large'))
  it('clones templates so one user cannot mutate defaults', () => {
    const state = freshState(); state.workouts[0].title = 'Changed'
    expect(freshState().workouts[0].title).not.toBe('Changed')
  })
})

describe('version 4 nutrition and plan-history migration', () => {
  it.each([2, 3])('upgrades a version %s backup without inventing nutrition or plan records', version => {
    const legacy = { ...freshState(), version, nutrition: undefined, planHistory: undefined }
    const migrated = parseState(legacy)
    expect(migrated.version).toBe(4)
    expect(migrated.nutrition).toEqual({ version: 1, meals: [], hydration: [], targets: [] })
    expect(migrated.planHistory).toEqual([])
    expect(migrated.workouts).toEqual(legacy.workouts)
  })
  it('rejects missing or corrupted new-format nutrition and history rather than losing it', () => {
    expect(() => parseState({ ...freshState(), nutrition: undefined })).toThrow('required')
    expect(() => parseState({ ...freshState(), planHistory: undefined })).toThrow('required')
    expect(() => parseState({ ...freshState(), nutrition: { version: 1, meals: [{}], hydration: [], targets: [] } })).toThrow('Nutrition')
    expect(() => parseState({ ...freshState(), planHistory: [{}] })).toThrow('Plan history')
  })
  it('round trips nutrition and previous plans in a full backup', () => {
    const state = freshState()
    state.nutrition.hydration = [{ id: 'water-1', date: '2026-10-15', milliliters: 250, note: 'Example' }]
    state.planHistory = [{ id: 'plan-1', label: 'Previous plan', savedAt: '2026-10-15T12:00:00Z', workouts: structuredClone(state.workouts) }]
    expect(parseBackup(JSON.stringify(state))).toEqual(state)
  })
})

describe('unsupported fields and stale-tab protection', () => {
  it('rejects unrecognized fields rather than copying hidden data into a cloud backup', () => {
    const state = freshState()
    expect(() => parseState({ ...state, privateAttachment: 'unrelated' })).toThrow('unsupported')
    expect(() => parseState({ ...state, profile: { ...state.profile, privateAttachment: 'unrelated' } })).toThrow()
    expect(() => parseState({ ...state, workouts: [{ ...state.workouts[0], privateAttachment: 'unrelated' }] })).toThrow()
  })
  it('rejects sparse programmatic arrays and impossible timestamp dates', () => {
    expect(() => parseState({ ...freshState(), workouts: new Array(1) })).toThrow()
    const state = freshState(); state.activeSession = startSession(state.workouts[0]); state.activeSession.startedAt = '2026-02-31T12:00:00Z'
    expect(() => parseState(state)).toThrow()
  })
  it('refuses to overwrite another tab’s newer snapshot', () => {
    const state = freshState(); const original = saveState(state)
    const other = { ...state, profile: { ...state.profile, name: 'Another tab' } }; saveState(other)
    expect(() => saveState({ ...state, profile: { ...state.profile, name: 'Stale tab' } }, original)).toThrow('another browser tab')
    expect(loadState().state.profile.name).toBe('Another tab')
  })
})
