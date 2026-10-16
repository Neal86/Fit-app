// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshState, loadState, STORAGE_KEY } from './storage'
import { startSession } from './session'
import { loadState as oldLoad, parseBackup as oldParse, saveState as oldSave } from './testFixtures/preCalorieStorage'

const digest = (path: string) => createHash('sha256').update(readFileSync(resolve(process.cwd(), path))).digest('hex')
const now = Date.parse('2026-10-16T12:00:00.000Z')
const unknown = () => ({ version: 1, status: 'unknown' })
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('independent pre-calorie reader provenance and recovery', () => {
  it('freezes c549faa validator/storage after import relocation only and keeps runtime validators unchanged', () => {
    // Frozen from git show c549faa46ce35186a2fce2aa388d51c6aabb9d33:src/{stateValidation,storage}.ts.
    // Only relative imports moved one directory up, with storage redirecting to the frozen validator.
    const expected = {
      'src/testFixtures/preCalorieStateValidation.ts': '025d77d57cb08416fbada83c6bf3122c848623c488c3210958a19e780452c19c',
      'src/testFixtures/preCalorieStorage.ts': '38e1a856a49acbc07a5532f7ac340953ce82eff6c0f262aafdd07e1b7a91843d',
      'src/nutrition.ts': 'e6a234d8786df5ad84fb6446b02ffb3881465a2058cc865c385cd71644e67bc5',
      'src/equipment.ts': '34551c3e779e400546bec246074229d4e863c0463ef4c4beee914a1998075181',
      'src/sessionGroupingValidation.ts': 'e72d30fa15a37a93e7645258b13b3429d2759597abf6ca34fd44da468b1567a8',
      'src/plannedGroupingValidation.ts': 'd951a63111a96c9f5c0139aaed808ef1a42eacc1e9b9116e8c855aefaefdf0e8',
      'src/exerciseLibraryValidation.ts': 'abfb991a46f1fd6f577bf9aead94090f3a897b0e33e3a6261014307791fcc0aa',
    }
    for (const [path, hash] of Object.entries(expected)) expect(digest(path), path).toBe(hash)
  })
  it.each(['saved-workout', 'active-workout', 'completed-log', 'plan-history'] as const)('rejects %s only-unknown on the shipped reader without overwriting raw bytes', location => {
    const state = freshState()
    if (location === 'saved-workout') Object.assign(state.workouts[0], { calories: unknown() })
    if (location === 'active-workout') { state.activeSession = startSession(state.workouts[0], now); Object.assign(state.activeSession.workout, { calories: unknown() }) }
    if (location === 'completed-log') { state.logs = [{ id: 'past', workoutId: 'old', title: 'Past', startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), duration: 0, calories: 0, completedExerciseIds: [] }]; Object.assign(state.logs[0], { calories: unknown() }) }
    if (location === 'plan-history') { state.planHistory = [{ id: 'past-plan', savedAt: new Date(now).toISOString(), label: 'Prior plan', workouts: structuredClone(state.workouts) }]; Object.assign(state.planHistory[0].workouts[0], { calories: unknown() }) }
    const raw = ` \n${JSON.stringify(state, null, 2)}\n `; localStorage.setItem(STORAGE_KEY, raw)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(() => oldParse(raw)).toThrow(); const loaded = oldLoad()
    expect(loaded.error).not.toBe(''); expect(loaded.raw).toBe(raw); expect(write).not.toHaveBeenCalled()
    expect(() => oldSave(state, raw)).toThrow(); expect(write).not.toHaveBeenCalled(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
    expect(loadState()).toEqual({ state, error: '', raw }); write.mockRestore()
  })
  it('still accepts ordinary historical numeric values exactly', () => {
    const state = freshState(); state.workouts[0].calories = 0.125; const raw = JSON.stringify(state); localStorage.setItem(STORAGE_KEY, raw)
    expect(oldParse(raw)).toEqual(state); expect(oldLoad()).toEqual({ state, error: '', raw }); expect(oldSave(state, raw)).toBe(raw)
  })
})
