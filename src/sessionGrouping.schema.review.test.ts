import { describe, expect, it } from 'vitest'
import { freshState, parseBackup, parseState, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import { parseState as parseBeforeGrouping } from './testFixtures/preGroupingStateValidation'
import type { AppState } from './types'

type TestGrouping = { version: 1; groups: { id: string; name: string; restSeconds: number; rounds: { id: string; setIds: string[] }[] }[] }
const setup = () => {
  const state = freshState(); state.activeSession = startSession(state.workouts[0], Date.parse('2026-10-15T12:00:00Z'))
  state.activeSession.runningSince = null
  return state
}
const grouping = (state: AppState): TestGrouping => {
  const session = state.activeSession!
  const rows = session.workout.exercises.slice(0, 2).map(exercise => session.sets.filter(row => row.exerciseId === exercise.id))
  return { version: 1, groups: [{ id: 'independent-group', name: 'Exact user label', restSeconds: 37, rounds: [0, 1].map(index => ({ id: `independent-round-${index}`, setIds: rows.map(sets => sets[index].id) })) }] }
}
const grouped = () => { const state = setup(); Object.assign(state.activeSession!, { grouping: grouping(state) }); return state }
const meta = (state: AppState): TestGrouping => (state.activeSession as unknown as { grouping: TestGrouping }).grouping
const raw = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

// Historical fixture is the exact 38e1b5b9 validator, with only import paths relocated.
describe('independent grouping private-schema compatibility', () => {
  it.each([2, 3, 4])('leaves legacy v%i migration equivalent to the old strict reader', version => {
    const state = setup(); const old = { ...state, version }
    expect(parseState(old)).toEqual(parseBeforeGrouping(old)); expect(STORAGE_KEY).toBe('fit-app-state-v2')
  })
  it.each([2, 3])('rejects grouping in a v%i active session instead of silently dropping it', version => {
    expect(() => parseState({ ...grouped(), version })).toThrow()
  })
  it.each([2, 3])('rejects grouping in a v%i log', version => {
    const state = grouped(); state.activeSession!.sets[0].completed = true
    const log = finishSession(state.activeSession!, Date.parse('2026-10-15T12:10:00Z'))
    Object.assign(log, { grouping: meta(state) })
    expect(() => parseState({ ...state, activeSession: null, logs: [log], version })).toThrow()
  })
  it('round trips private metadata exactly while the old reader rejects without mutating its input', () => {
    const state = grouped(); const before = structuredClone(state)
    expect(parseBackup(JSON.stringify(state))).toEqual(state)
    expect(() => parseBeforeGrouping(state)).toThrow(); expect(state).toEqual(before)
    state.activeSession!.sets[0].completed = true
    const log = finishSession(state.activeSession!, Date.parse('2026-10-15T12:10:00Z'))
    const finished = { ...state, activeSession: null, logs: [log] }; const oldInput = structuredClone(finished)
    expect(parseState(finished)).toEqual(finished); expect(() => parseBeforeGrouping(finished)).toThrow(); expect(finished).toEqual(oldInput)
  })
  it.each(['workout', 'exercise', 'plan-history', 'top-level'])('rejects plan-authored or misplaced grouping at %s', place => {
    const state = setup(); const value = grouping(state)
    if (place === 'workout') Object.assign(state.workouts[0], { grouping: value })
    if (place === 'exercise') Object.assign(state.workouts[0].exercises[0], { grouping: value })
    if (place === 'top-level') Object.assign(state, { grouping: value })
    if (place === 'plan-history') state.planHistory = [{ id: 'prior', label: 'Prior', savedAt: '2026-10-15T12:00:00Z', workouts: [{ ...state.workouts[0], grouping: value } as typeof state.workouts[0]] }]
    expect(() => parseState(state)).toThrow()
  })
  it.each([
    ['null wrapper', (g: TestGrouping) => { Object.assign(g, { version: null }) }],
    ['unsupported version', (g: TestGrouping) => { Object.assign(g, { version: 2 }) }],
    ['wrapper extra', (g: TestGrouping) => { Object.assign(g, { enabled: true }) }],
    ['missing groups', (g: TestGrouping) => { delete raw(g).groups }],
    ['group extra', (g: TestGrouping) => { Object.assign(g.groups[0], { exercises: [] }) }],
    ['round extra', (g: TestGrouping) => { Object.assign(g.groups[0].rounds[0], { completed: true }) }],
    ['missing rest', (g: TestGrouping) => { delete raw(g.groups[0]).restSeconds }],
    ['missing round id', (g: TestGrouping) => { delete raw(g.groups[0].rounds[0]).id }],
    ['null rounds', (g: TestGrouping) => { Object.assign(g.groups[0], { rounds: null }) }],
    ['sparse groups', (g: TestGrouping) => { g.groups.length = 2 }],
    ['sparse rounds', (g: TestGrouping) => { g.groups[0].rounds.length = 3 }],
    ['sparse cells', (g: TestGrouping) => { delete g.groups[0].rounds[0].setIds[0] }],
    ['blank name', (g: TestGrouping) => { g.groups[0].name = '  ' }],
    ['oversized name', (g: TestGrouping) => { g.groups[0].name = 'x'.repeat(81) }],
    ['fractional rest', (g: TestGrouping) => { g.groups[0].restSeconds = 0.1 }],
    ['negative rest', (g: TestGrouping) => { g.groups[0].restSeconds = -1 }],
    ['excess rest', (g: TestGrouping) => { g.groups[0].restSeconds = 901 }],
    ['nonfinite rest', (g: TestGrouping) => { g.groups[0].restSeconds = Infinity }],
    ['empty rounds', (g: TestGrouping) => { g.groups[0].rounds = [] }],
    ['one cell', (g: TestGrouping) => { g.groups[0].rounds[0].setIds.pop() }],
    ['empty cell', (g: TestGrouping) => { g.groups[0].rounds[0].setIds[0] = '' }],
    ['missing row', (g: TestGrouping) => { g.groups[0].rounds[0].setIds[0] = 'missing' }],
    ['duplicate within round', (g: TestGrouping) => { g.groups[0].rounds[0].setIds[1] = g.groups[0].rounds[0].setIds[0] }],
    ['duplicate across rounds', (g: TestGrouping) => { g.groups[0].rounds[1].setIds[0] = g.groups[0].rounds[0].setIds[0] }],
    ['duplicate round id', (g: TestGrouping) => { g.groups[0].rounds[1].id = g.groups[0].rounds[0].id }],
    ['group-round alias', (g: TestGrouping) => { g.groups[0].rounds[0].id = g.groups[0].id }],
  ] as const)('rejects %s without normalizing away the error', (_name, change) => {
    const state = grouped(); change(meta(state)); const before = structuredClone(state)
    expect(() => parseState(state)).toThrow(); expect(state).toEqual(before)
  })
  it.each(['owner', 'workout', 'exercise', 'set'])('rejects group and round IDs that alias the owner %s identity', place => {
    for (const field of ['group', 'round']) {
      const state = grouped(); const session = state.activeSession!
      const alias = place === 'owner' ? session.id : place === 'workout' ? session.workout.id : place === 'exercise' ? session.workout.exercises[0].id : session.sets[0].id
      if (field === 'group') meta(state).groups[0].id = alias
      else meta(state).groups[0].rounds[0].id = alias
      expect(() => parseState(state), `${field} aliases ${place}`).toThrow()
    }
  })
  it('rejects two rows from the same exercise and any warm-up member', () => {
    const same = grouped(); meta(same).groups[0].rounds[0].setIds[1] = same.activeSession!.sets[2].id
    expect(() => parseState(same)).toThrow()
    const warmup = grouped(); warmup.activeSession!.sets[0].warmup = true
    expect(() => parseState(warmup)).toThrow()
  })
  it('checks duplicates across groups and distinct round widths without requiring matched set numbers', () => {
    const duplicate = grouped(); meta(duplicate).groups.push({ ...structuredClone(meta(duplicate).groups[0]), id: 'other-group', rounds: [{ id: 'other-round', setIds: [...meta(duplicate).groups[0].rounds[0].setIds] }] })
    expect(() => parseState(duplicate)).toThrow()
    const width = grouped(); const third = width.activeSession!.sets.find(row => row.exerciseId === width.activeSession!.workout.exercises[2].id)!
    meta(width).groups[0].rounds[1].setIds.push(third.id); expect(() => parseState(width)).toThrow()
    const unordered = grouped(); meta(unordered).groups[0].rounds[1].setIds.reverse()
    expect(parseState(unordered)).toEqual(unordered)
  })
  it.each(['missing sets', 'missing snapshots', 'unresolved snapshot'])('rejects a grouped historical log with %s', problem => {
    const state = grouped(); state.activeSession!.sets[0].completed = true
    const log = finishSession(state.activeSession!, Date.parse('2026-10-15T12:10:00Z'))
    Object.assign(log, { grouping: meta(state) })
    if (problem === 'missing sets') delete log.sets
    if (problem === 'missing snapshots') delete log.exerciseSnapshots
    if (problem === 'unresolved snapshot') log.exerciseSnapshots = log.exerciseSnapshots!.slice(1)
    expect(() => parseState({ ...state, activeSession: null, logs: [log] })).toThrow()
  })
  it('keeps IDs owner-scoped but rejects aliases of orphan completed-exercise references in a grouped log', () => {
    const state = grouped(); state.activeSession!.sets[0].completed = true
    const log = finishSession(state.activeSession!, Date.parse('2026-10-15T12:10:00Z')); log.id = 'separate-historical-owner'
    const both = { ...state, logs: [log] }; expect(parseState(both)).toEqual(both)
    for (const target of ['group', 'round']) {
      const copy = structuredClone(both); copy.logs[0].completedExerciseIds.push('historical-orphan-exercise')
      if (target === 'group') copy.logs[0].grouping!.groups[0].id = 'historical-orphan-exercise'
      else copy.logs[0].grouping!.groups[0].rounds[0].id = 'historical-orphan-exercise'
      expect(() => parseState(copy)).toThrow()
    }
  })
  it('preserves completed members on import and uses snapshot labels independent of current plans', () => {
    const state = grouped(); state.activeSession!.sets[0].completed = true; state.activeSession!.sets[0].reps = 5
    expect(parseState(state)).toEqual(state)
    const log = finishSession(state.activeSession!, Date.parse('2026-10-15T12:10:00Z'))
    const historical = structuredClone(log); state.workouts[0].exercises[0].name = 'Current plan renamed'
    const finished = { ...state, activeSession: null, logs: [log] }
    expect(parseState(finished).logs[0]).toEqual(historical)
    expect(log.sets).not.toBe(state.activeSession!.sets); expect(raw(log).grouping).not.toBe(meta(state))
  })
  it('accepts exactly 25 groups, 50 rounds and width 6, rejects each independent excess atomically', () => {
    const state = setup(); const session = state.activeSession!; const sample = session.workout.exercises[0]; const row = session.sets[0]
    session.workout.exercises = Array.from({ length: 6 }, (_, i) => ({ ...sample, id: `move-${i}` }))
    session.sets = Array.from({ length: 300 }, (_, i) => ({ ...row, id: `row-${i}`, exerciseId: `move-${i % 6}`, setNumber: Math.floor(i / 6) + 1 }))
    Object.assign(session, { grouping: { version: 1, groups: [{ id: 'maximum-round-group', name: 'x'.repeat(80), restSeconds: 900, rounds: Array.from({ length: 50 }, (_, i) => ({ id: `round-${i}`, setIds: session.sets.slice(i * 6, i * 6 + 6).map(s => s.id) })) }] } })
    expect(parseState(state)).toEqual(state)
    const tooManyRounds = structuredClone(state); meta(tooManyRounds).groups[0].rounds.push({ id: '51st', setIds: ['row-0', 'row-1'] }); expect(() => parseState(tooManyRounds)).toThrow()
    const tooWide = structuredClone(state); meta(tooWide).groups[0].rounds[0].setIds.push('row-6'); expect(() => parseState(tooWide)).toThrow()
    meta(state).groups = Array.from({ length: 25 }, (_, i) => ({ id: `group-${i}`, name: `Group ${i}`, restSeconds: 0, rounds: [{ id: `round-${i}`, setIds: [`row-${i * 2}`, `row-${i * 2 + 1}`] }] }))
    expect(parseState(state)).toEqual(state)
    meta(state).groups.push({ id: 'group-26', name: 'Extra', restSeconds: 0, rounds: [{ id: 'extra-round', setIds: ['row-52', 'row-53'] }] })
    expect(() => parseState(state)).toThrow()
  })
})
