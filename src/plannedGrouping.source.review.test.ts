import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { freshState } from './storage'
import { parseState as frozenReader } from './testFixtures/prePlannedGroupingStateValidation'

const digest = (path: string) => createHash('sha256').update(readFileSync(resolve(process.cwd(), path))).digest('hex')

describe('independent frozen pre-extension reader provenance', () => {
  it('retains the exact 34f1182 validator with only four relative import relocations', () => {
    expect(digest('src/testFixtures/prePlannedGroupingStateValidation.ts')).toBe('cbb0679f44b467e67d106235d173053de7b927ba2c2bef65429cc26d1dca67cf')
    expect(digest('src/testFixtures/preGroupingStateValidation.ts')).toBe('50809cdc68bf181c2dd589d5393f734cf2c28d9beb17034a9ac8e99972ddbc59')
    expect(digest('src/sessionGroupingValidation.ts')).toBe('e72d30fa15a37a93e7645258b13b3429d2759597abf6ca34fd44da468b1567a8')
  })
  it('shows old-reader rejection comes from previously shipped allowed fields, not a newly added rejection rule', () => {
    const state = freshState(); expect(frozenReader(state)).toEqual(state)
    const workout = state.workouts[0]
    workout.plannedGrouping = { version: 1, groups: [{ id: 'future-group', name: 'Future metadata', restSeconds: 7, rounds: [{ id: 'future-round', members: workout.exercises.slice(0, 2).map(exercise => ({ exerciseId: exercise.id, setNumber: 1 })) }] }] }
    const before = structuredClone(state); expect(() => frozenReader(state)).toThrow(/invalid|incomplete/i); expect(state).toEqual(before)
    state.planHistory = [{ id: 'revision', savedAt: '2026-10-16T12:00:00.000Z', label: 'Only history', workouts: structuredClone(state.workouts) }]
    delete state.workouts[0].plannedGrouping; const historic = structuredClone(state)
    expect(() => frozenReader(state)).toThrow(/history/i); expect(state).toEqual(historic)
  })
})
