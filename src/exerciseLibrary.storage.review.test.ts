// @vitest-environment jsdom
// @vitest-environment-options {"storageQuota": 20000000}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshState, loadState, MAX_BACKUP_BYTES, parseBackup, saveState, STORAGE_KEY, StorageConflictError } from './storage'
import { pausedCloudState } from './cloud'
import { finishSession, startSession } from './session'
import type { AppState, WorkoutLog } from './types'

const at = Date.parse('2026-10-16T12:00:00.000Z')
function syntheticState(): AppState {
  const state = freshState()
  Object.assign(state, { exerciseLibrary: { version: 1, entries: [{ id: 'private-library', revision: 6, status: 'archived', createdAt: new Date(at - 1000).toISOString(), updatedAt: new Date(at).toISOString(), exercise: { name: 'Current personal name', category: 'Manual', sets: 2, reps: '10', restSeconds: 13, equipment: [] } }] } })
  Object.assign(state.workouts[0].exercises[0], { name: 'Historical copied value', libraryOrigin: { version: 1, entryId: 'private-library', revision: 1 } })
  state.activeSession = startSession(state.workouts[0], at)
  state.activeSession.sets[0].completed = true; state.activeSession.sets[0].reps = 9; state.activeSession.restUntil = at + 7000
  const old = structuredClone(state.activeSession); old.id = 'old-completed'
  state.logs = [finishSession(old, at + 1000)]
  state.planHistory = [{ id: 'prior-plan', savedAt: new Date(at).toISOString(), label: 'Earlier plan', workouts: structuredClone(state.workouts) }]
  return state
}
function boundaryState(): AppState {
  const state = syntheticState()
  const sample: WorkoutLog = { id: '', workoutId: 'only-reference', title: 'Synthetic size boundary', startedAt: new Date(at).toISOString(), completedAt: new Date(at).toISOString(), duration: 0, calories: 0, completedExerciseIds: [], notes: '' }
  state.logs = Array.from({ length: 2600 }, (_, index) => ({ ...sample, id: `size-log-${index}` }))
  let remaining = MAX_BACKUP_BYTES - new Blob([JSON.stringify(state)]).size
  for (const log of state.logs) {
    const emojiCount = Math.min(1000, Math.floor(remaining / 4))
    log.notes = '💪'.repeat(emojiCount); remaining -= emojiCount * 4
    if (remaining < 4 && log.notes.length + remaining <= 2000) { log.notes += 'x'.repeat(remaining); remaining = 0 }
  }
  expect(remaining).toBe(0)
  expect(new Blob([JSON.stringify(state)]).size).toBe(MAX_BACKUP_BYTES)
  return state
}
beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('independent personal-library byte limits and persistence', () => {
  it('saves and reloads exactly 10 MiB of UTF-8 with personal metadata intact', () => {
    const state = boundaryState(); const raw = saveState(state, null)
    expect(new Blob([raw]).size).toBe(MAX_BACKUP_BYTES); expect(raw.length).toBeLessThan(MAX_BACKUP_BYTES)
    expect(parseBackup(raw)).toEqual(state); expect(loadState()).toEqual({ state, error: '', raw })
  })
  it('rejects one UTF-8 byte over the reload ceiling before writing and preserves CAS bytes', () => {
    const previous = JSON.stringify(syntheticState()); localStorage.setItem(STORAGE_KEY, previous)
    const next = boundaryState(); next.logs.at(-1)!.notes += 'x'
    expect(new Blob([JSON.stringify(next)]).size).toBe(MAX_BACKUP_BYTES + 1)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(() => saveState(next, previous)).toThrow(/large|10 MB|size/i); expect(write).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(previous); expect(loadState().error).toBe('')
    expect(() => parseBackup(JSON.stringify(next))).toThrow(/large|10 MB|size/i)
    const valid = syntheticState(); valid.profile.name = 'Retry'; expect(() => saveState(valid, previous)).not.toThrow()
  })
  it('retains raw oversized input for recovery without replacing it with fresh defaults', () => {
    const state = boundaryState(); state.logs.at(-1)!.notes += 'é'
    const raw = JSON.stringify(state); localStorage.setItem(STORAGE_KEY, raw)
    const write = vi.spyOn(Storage.prototype, 'setItem'); const loaded = loadState()
    expect(loaded.raw).toBe(raw); expect(loaded.error).toMatch(/large|10 MB|size/i); expect(write).not.toHaveBeenCalled(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })
  it('keeps library/origins byte-for-byte under quota and stale-tab failures, permitting an exact valid retry', () => {
    const state = syntheticState(); const raw = saveState(state, null); const changed = structuredClone(state); changed.profile.name = 'Other tab'
    const otherRaw = JSON.stringify(changed); localStorage.setItem(STORAGE_KEY, otherRaw)
    expect(() => saveState(state, raw)).toThrow(StorageConflictError); expect(localStorage.getItem(STORAGE_KEY)).toBe(otherRaw)
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    expect(() => saveState(state, otherRaw)).toThrow('Full'); expect(localStorage.getItem(STORAGE_KEY)).toBe(otherRaw)
    failure.mockRestore(); expect(saveState(state, otherRaw)).toBe(raw); expect(loadState().state).toEqual(state)
  })
  it('preserves private metadata in own backup and paused manual-cloud state without any live lookup', () => {
    const state = syntheticState(); const before = structuredClone(state)
    const copy = pausedCloudState(state, at + 4000)
    expect({ ...copy, activeSession: state.activeSession }).toEqual(state)
    expect(copy.activeSession!.workout.exercises).toEqual(state.activeSession!.workout.exercises)
    expect(copy.activeSession!.sets).toEqual(state.activeSession!.sets); expect(copy.activeSession!.runningSince).toBeNull(); expect(copy.activeSession!.restUntil).toBeNull()
    expect(parseBackup(JSON.stringify(copy))).toEqual(copy); expect(state).toEqual(before)
    const log = finishSession(state.activeSession!, at + 5000)
    expect(log.exerciseSnapshots![0]).toMatchObject({ name: 'Historical copied value', libraryOrigin: { version: 1, entryId: 'private-library', revision: 1 } })
    expect(Object.hasOwn(log.exerciseSnapshots![0], 'equipment')).toBe(false)
  })
})
