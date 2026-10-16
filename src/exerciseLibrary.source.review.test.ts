// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { freshState, loadState, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import { loadState as oldLoad, parseBackup as oldParse, saveState as oldSave } from './testFixtures/preLibraryStorage'

const digest = (path: string) => createHash('sha256').update(readFileSync(resolve(process.cwd(), path))).digest('hex')
const now = Date.parse('2026-10-16T12:00:00.000Z')
const ancestry = { version: 1 as const, entryId: 'orphan-library', revision: 3 }
beforeEach(() => localStorage.clear())

describe('independent pre-library reader provenance and raw recovery', () => {
  it('freezes the exact befd1cf validator/storage after only necessary relative import relocations', () => {
    // Independently calculated from git show befd1cf5597b0c75d232f6676c6cf40e0a25c3f6, not the new fixtures.
    expect(digest('src/testFixtures/preLibraryStateValidation.ts')).toBe('43a5ee13978b2af976352522dcc44af65169267402366c79ec9034a730032d61')
    expect(digest('src/testFixtures/preLibraryStorage.ts')).toBe('866ea65bb27e595f7bd222c54cd9b57857a4756cdcab613834ff37f0d3bff8b0')
  })
  it('keeps old-reader validation dependencies and earlier frozen fixtures unchanged', () => {
    const expected = {
      'src/nutrition.ts': 'e6a234d8786df5ad84fb6446b02ffb3881465a2058cc865c385cd71644e67bc5',
      'src/equipment.ts': '34551c3e779e400546bec246074229d4e863c0463ef4c4beee914a1998075181',
      'src/sessionGroupingValidation.ts': 'e72d30fa15a37a93e7645258b13b3429d2759597abf6ca34fd44da468b1567a8',
      'src/plannedGroupingValidation.ts': 'd951a63111a96c9f5c0139aaed808ef1a42eacc1e9b9116e8c855aefaefdf0e8',
      'src/testFixtures/preGroupingStateValidation.ts': '50809cdc68bf181c2dd589d5393f734cf2c28d9beb17034a9ac8e99972ddbc59',
      'src/testFixtures/preGroupingStorage.ts': '3f3eefe21fb786056e82db225f4f9407ef95e80a74c511ce984f6119ca10a6fd',
      'src/testFixtures/prePlannedGroupingStateValidation.ts': 'cbb0679f44b467e67d106235d173053de7b927ba2c2bef65429cc26d1dca67cf',
      'src/testFixtures/prePlannedGroupingStorage.ts': 'f6bda30439455d05a2a2f6190e4b0f0b7c9af68d4f4aca523c032add3b75724d',
    }
    for (const [path, hash] of Object.entries(expected)) expect(digest(path), path).toBe(hash)
  })
  it.each(['library-only', 'saved-exercise', 'plan-history', 'active-exercise', 'completed-snapshot'] as const)('rejects %s on the shipped strict reader and preserves every original byte for upgrade recovery', location => {
    const state = freshState()
    if (location === 'library-only') state.exerciseLibrary = { version: 1, entries: [] }
    if (location === 'saved-exercise') state.workouts[0].exercises[0].libraryOrigin = ancestry
    if (location === 'plan-history') {
      state.planHistory = [{ id: 'prior', savedAt: new Date(now).toISOString(), label: 'Historic only', workouts: structuredClone(state.workouts) }]
      state.planHistory[0].workouts[0].exercises[0].libraryOrigin = ancestry
    }
    if (location === 'active-exercise' || location === 'completed-snapshot') {
      const active = startSession(state.workouts[0], now); active.workout.exercises[0].libraryOrigin = ancestry
      if (location === 'active-exercise') state.activeSession = active
      else { active.sets[0].completed = true; active.sets[0].reps = 8; state.logs = [finishSession(active, now + 1000)] }
    }
    const raw = ` \n${JSON.stringify(state, null, 2)}\n `; localStorage.setItem(STORAGE_KEY, raw)
    expect(() => oldParse(raw)).toThrow(); const loaded = oldLoad()
    expect(loaded.error).not.toBe(''); expect(loaded.raw).toBe(raw); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
    expect(() => oldSave(state, raw)).toThrow(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
    expect(loadState()).toEqual({ state, error: '', raw })
  })
  it('continues accepting byte-exact ordinary old state without synthesizing a library', () => {
    const state = freshState(); const raw = JSON.stringify(state); localStorage.setItem(STORAGE_KEY, raw)
    expect(oldParse(raw)).toEqual(state); expect(oldLoad()).toEqual({ state, error: '', raw })
    expect(Object.hasOwn(loadState().state, 'exerciseLibrary')).toBe(false)
  })
})
