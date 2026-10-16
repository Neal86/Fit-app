// @vitest-environment jsdom
// @vitest-environment-options {"storageQuota": 20000000}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshState, loadState, MAX_BACKUP_BYTES, parseBackup, parseState, saveState, STORAGE_KEY, StorageConflictError } from './storage'
import { startSession, finishSession } from './session'
import { copyWorkout, prepareWorkoutForSave, restorePlanRevision, savePlanRevision, schedulePreview } from './planning'
import { pausedCloudState } from './cloud'
import { applyPlannedGrouping, reviewPlannedGrouping } from './plannedGrouping'
import { applySessionAddition, reviewSessionAddition } from './sessionAddition'
import { applySessionReplacement, reviewSessionReplacement } from './sessionReplacement'
import { applySessionGrouping, reviewSessionGrouping } from './sessionGrouping'
import { summarizeLogs } from './analytics'
import { PLAN_DRAFT_KEY, readPlanDraft, savePlanDraft } from './planDraft'
import type { AppState, WorkoutLog } from './types'

const now = Date.parse('2026-10-16T12:00:00.000Z')
const unknown = () => ({ version: 1, status: 'unknown' })
function syntheticState(): AppState {
  const state = freshState(); Object.assign(state.workouts[0], { calories: unknown() })
  state.workouts[1].calories = 0; state.workouts[2].calories = 218.123456789
  const workout = state.workouts[0]
  workout.exercises[0].equipment = ['bench', 'barbell']; workout.exercises[0].libraryOrigin = { version: 1, entryId: 'private-entry', revision: 3 }
  state.exerciseLibrary = { version: 1, entries: [{ id: 'private-entry', revision: 4, status: 'archived', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), exercise: { name: 'Current private content', category: 'Manual', sets: 2, reps: '10', restSeconds: 17, equipment: [] } }] }
  state.workouts[0] = applyPlannedGrouping(workout, reviewPlannedGrouping(workout, { name: 'Exact pair', restSeconds: 23, rounds: [[{ exerciseId: workout.exercises[0].id, setNumber: 1 }, { exerciseId: workout.exercises[1].id, setNumber: 1 }]] }), { reserved: state })
  state.activeSession = startSession(state.workouts[0], now, { reserved: state }); state.activeSession.elapsedSeconds = 20.25; state.activeSession.restUntil = now + 12000
  state.activeSession.sets[0].completed = true; state.activeSession.sets[0].reps = 8; state.activeSession.sets[0].weightKg = 19.123456789
  const past = structuredClone(state.activeSession); past.id = 'past-session'; state.logs = [finishSession(past, now + 1000)]
  state.planHistory = [{ id: 'prior-plan', savedAt: new Date(now).toISOString(), label: 'Earlier plan', workouts: structuredClone(state.workouts) }]
  return state
}
function boundaryState(): AppState {
  const state = syntheticState()
  const sample: WorkoutLog = { id: '', workoutId: 'size-only-reference', title: 'Synthetic calorie size boundary', startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), duration: 0, calories: 0, completedExerciseIds: [], notes: '' }
  Object.assign(sample, { calories: unknown() })
  state.logs = Array.from({ length: 2600 }, (_, index) => ({ ...sample, id: `size-log-${index}` }))
  let remaining = MAX_BACKUP_BYTES - new Blob([JSON.stringify(state)]).size
  for (const log of state.logs) {
    const emojis = Math.min(1000, Math.floor(remaining / 4)); log.notes = '💪'.repeat(emojis); remaining -= emojis * 4
    if (remaining < 4 && log.notes.length + remaining <= 2000) { log.notes += 'x'.repeat(remaining); remaining = 0 }
  }
  expect(remaining).toBe(0); expect(new Blob([JSON.stringify(state)]).size).toBe(MAX_BACKUP_BYTES); return state
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => vi.restoreAllMocks())

describe('independent unknown-calorie persistence and transfers', () => {
  it('preserves exact unknown, zero and fractional values through grouping, copy, draft, schedule, history and restore', () => {
    const state = syntheticState(); const source = state.workouts[0]; const before = structuredClone(state)
    const copy = copyWorkout(source, { reserved: state }); expect(copy.calories).toEqual(unknown()); expect(copy.calories).not.toBe(source.calories)
    const renamed = prepareWorkoutForSave({ ...source, title: 'Changed only title' }, source, { reserved: state }); expect(renamed.calories).toEqual(unknown())
    savePlanDraft(copy); expect(readPlanDraft()).toEqual(copy); expect(parseBackup(JSON.stringify(state))).toEqual(state)
    const schedule = schedulePreview(state.workouts, [{ workoutId: source.id, day: 'Monday' }, { workoutId: source.id, day: 'Friday' }], 600, { reserved: state })
    expect(schedule.map(workout => workout.calories)).toEqual([unknown(), unknown()]); expect(schedule[0].calories).not.toBe(schedule[1].calories)
    const next = savePlanRevision(state, [copy, ...state.workouts.slice(1)], 'Copy unknown', new Date(now)); expect(next.planHistory[0].workouts).toEqual(state.workouts)
    const restored = restorePlanRevision(next, next.planHistory[0].id); expect(restored.workouts).toEqual(state.workouts); expect(restored.activeSession).toEqual(state.activeSession); expect(restored.logs).toEqual(state.logs)
    expect(state).toEqual(before); expect(parseState(restored)).toEqual(restored)
  })
  it('preserves unknown through additions, unfinished replacements and exact session grouping without rewriting prior snapshots', () => {
    const initial = syntheticState(); const before = structuredClone(initial); const selected = { ...initial.workouts[1].exercises[0], sets: 2 }
    let state = applySessionAddition(initial, reviewSessionAddition(initial, selected))
    const replaceId = state.activeSession!.workout.exercises[1].id
    state = applySessionReplacement(state, reviewSessionReplacement(state, replaceId, selected))
    const active = state.activeSession!; const grouped = new Set(active.grouping!.groups.flatMap(group => group.rounds.flatMap(round => round.setIds)))
    const rows = active.sets.filter(row => !row.completed && !grouped.has(row.id))
    const a = rows[0]; const b = rows.find(row => row.exerciseId !== a.exerciseId)!
    state = applySessionGrouping(state, reviewSessionGrouping(state, { name: 'Session-only pair', restSeconds: 19, rounds: [[a.id, b.id]] }))
    expect(state.activeSession!.workout.calories).toEqual(unknown()); expect(finishSession(state.activeSession!, now + 2000).calories).toEqual(unknown())
    expect(state.workouts).toEqual(before.workouts); expect(state.logs).toEqual(before.logs); expect(state.planHistory).toEqual(before.planHistory); expect(state.exerciseLibrary).toEqual(before.exerciseLibrary)
    expect(initial).toEqual(before); expect(parseBackup(JSON.stringify(state))).toEqual(state)
  })
  it('counts known zero without turning all-unknown or mixed summaries into a complete numeric total', () => {
    const state = syntheticState(); const first = state.logs[0]
    const unknownOnly = summarizeLogs([first]); expect(unknownOnly.calories).toBeNull(); expect(unknownOnly.unknownCalorieSessions).toBe(1); expect(unknownOnly.knownCalorieSessions).toBe(0)
    const second = { ...first, id: 'zero', calories: 0 }; const third = { ...first, id: 'fraction', calories: 0.125 }
    const mixed = summarizeLogs([first, second, third]); expect(mixed.calories).toBeNull(); expect(mixed.knownCalories).toBe(0.125); expect(mixed.knownCalorieSessions).toBe(2); expect(mixed.unknownCalorieSessions).toBe(1)
    const known = summarizeLogs([second, third]); expect(known.calories).toBe(0.125); expect(known.unknownCalorieSessions).toBe(0)
    expect(summarizeLogs([second]).calories).toBe(0); expect(mixed.seconds).toBe(first.durationSeconds! * 3); expect(mixed.sessions).toBe(3)
  })
  it('unknown never becomes zero when finishing any duration, and known zero/fraction arithmetic stays unchanged', () => {
    for (const seconds of [0, 1, 59, 60, 123456]) {
      const state = syntheticState(); const session = state.activeSession!; session.elapsedSeconds = 0
      const log = finishSession(session, now + seconds * 1000); expect(log.calories).toEqual(unknown()); expect(log.calories).not.toBe(session.workout.calories)
      const numeric = structuredClone(session); numeric.workout.calories = 0; expect(finishSession(numeric, now + seconds * 1000).calories).toBe(0)
      numeric.workout.calories = 218.123456789; expect(finishSession(numeric, now + seconds * 1000).calories).toBe(Math.round(218.123456789 * seconds / (numeric.workout.duration * 60)))
    }
  })
  it('keeps all metadata and unknown values in paused manual-cloud candidates while preserving local timer bytes', () => {
    const state = syntheticState(); const before = structuredClone(state); const raw = saveState(state, null)
    const paused = pausedCloudState(state, now + 4000); expect(paused.activeSession!.workout.calories).toEqual(unknown()); expect(paused.activeSession!.runningSince).toBeNull(); expect(paused.activeSession!.restUntil).toBeNull()
    expect(paused.activeSession!.elapsedSeconds).toBe(24.25); expect({ ...paused, activeSession: state.activeSession }).toEqual(state)
    expect(paused.activeSession!.workout).toEqual(state.activeSession!.workout); expect(paused.activeSession!.sets).toEqual(state.activeSession!.sets); expect(paused.activeSession!.grouping).toEqual(state.activeSession!.grouping)
    expect(parseBackup(JSON.stringify(paused))).toEqual(paused); expect(state).toEqual(before); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })
  it('does not recover malformed calorie draft data through string, null, version or extra-field coercion', () => {
    const state = syntheticState(); const workout = state.workouts[0]
    for (const calories of [null, '', '0', 'unknown', {}, { version: 2, status: 'unknown' }, { version: 1, status: 'unknown', value: 0 }]) {
      const raw = JSON.stringify({ ...workout, calories }); sessionStorage.setItem(PLAN_DRAFT_KEY, raw)
      expect(readPlanDraft()).toBeNull(); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(raw)
    }
    for (const calories of [0, 0.125, unknown()]) { const draft = { ...workout, calories, title: '', exercises: workout.exercises.map(exercise => ({ ...exercise, sets: 0 })) }; sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(draft)); expect(readPlanDraft()).toEqual(draft) }
  })
  it('saves and reloads exactly 10 MiB of UTF-8 including unknown markers', () => {
    const state = boundaryState(); const raw = saveState(state, null)
    expect(new Blob([raw]).size).toBe(MAX_BACKUP_BYTES); expect(raw.length).toBeLessThan(MAX_BACKUP_BYTES)
    expect(parseBackup(raw)).toEqual(state); expect(loadState()).toEqual({ state, error: '', raw })
  })
  it('rejects one byte over the same ceiling before writing, preserving all prior raw data', () => {
    const before = JSON.stringify(syntheticState()); localStorage.setItem(STORAGE_KEY, before)
    const state = boundaryState(); state.logs.at(-1)!.notes += 'x'; const oversized = JSON.stringify(state)
    expect(new Blob([oversized]).size).toBe(MAX_BACKUP_BYTES + 1); const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(() => saveState(state, before)).toThrow(/large|10 MB|size/i); expect(write).not.toHaveBeenCalled(); expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
    expect(() => parseBackup(oversized)).toThrow(/large|10 MB|size/i); write.mockRestore()
    localStorage.setItem(STORAGE_KEY, oversized); const loaded = loadState(); expect(loaded.raw).toBe(oversized); expect(loaded.error).toMatch(/large|10 MB|size/i); expect(localStorage.getItem(STORAGE_KEY)).toBe(oversized)
  })
  it('keeps unknown markers recoverable through stale-tab and quota failures and succeeds on exact retry', () => {
    const state = syntheticState(); const raw = saveState(state, null); const next = structuredClone(state); next.profile.name = 'Other tab'; const newer = JSON.stringify(next); localStorage.setItem(STORAGE_KEY, newer)
    expect(() => saveState(state, raw)).toThrow(StorageConflictError); expect(localStorage.getItem(STORAGE_KEY)).toBe(newer)
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    expect(() => saveState(state, newer)).toThrow('Full'); expect(localStorage.getItem(STORAGE_KEY)).toBe(newer)
    fail.mockRestore(); expect(saveState(state, newer)).toBe(raw); expect(loadState().state).toEqual(state)
  })
})
