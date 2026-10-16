import { describe, expect, it } from 'vitest'
import { freshState, parseState, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import type { AppState, SessionGrouping } from './types'

const stamp = Date.parse('2026-10-01T10:00:00Z')
function fixture(): AppState {
  const state = freshState(); state.activeSession = startSession(state.workouts[0], stamp)
  const session = state.activeSession
  session.sets.forEach((set, index) => { set.id = `row-${index}` })
  const first = session.workout.exercises[0].id
  const second = session.workout.exercises[1].id
  const a = session.sets.filter(set => set.exerciseId === first)
  const b = session.sets.filter(set => set.exerciseId === second)
  session.grouping = { version: 1, groups: [{ id: 'g1', name: 'Exact label', restSeconds: 0, rounds: [{ id: 'r1', setIds: [a[0].id, b[0].id] }, { id: 'r2', setIds: [a[1].id, b[1].id] }] }] }
  return state
}
const grouping = (state: AppState) => state.activeSession!.grouping!
const group = (state: AppState) => grouping(state).groups[0]
const round = (state: AppState) => group(state).rounds[0]
function rejects(mutate: (state: AppState) => void) {
  const state = fixture(); mutate(state); const before = structuredClone(state)
  expect(() => parseState(state)).toThrow(); expect(state).toEqual(before)
}

describe('strict bounded grouping persistence contract', () => {
  it('preserves valid v4 exact metadata, stable IDs, untrimmed imported labels and zero rest without changing storage version', () => {
    const state = fixture(); group(state).name = ' Exact label '; group(state).restSeconds = 900
    const next = parseState(state)
    expect(next).toEqual(state); expect(next.version).toBe(4); expect(STORAGE_KEY).toBe('fit-app-state-v2')
    round(next).setIds.reverse(); expect(round(state).setIds[0]).toBe('row-0')
  })
  it.each([2, 3])('rejects any grouping under legacy v%i before migration can drop it', version => {
    const state = fixture()
    expect(() => parseState({ ...state, version })).toThrow('requires version 4')
    state.activeSession!.sets[0].completed = true
    const log = finishSession(state.activeSession!, stamp + 60_000)
    expect(() => parseState({ ...state, version, activeSession: null, logs: [log] })).toThrow('requires version 4')
    expect(() => parseState({ ...state, version: 2, activeSession: { unexpected: { grouping: undefined } } })).toThrow('requires version 4')
  })
  it.each([2, 3, 4])('keeps legitimate legacy v%i input unchanged except established migration', version => {
    const state = fixture(); delete state.activeSession!.grouping
    const original = { ...state, version }; const before = structuredClone(original)
    const parsed = parseState(original)
    expect(parsed).toEqual({ ...state, activeSession: version === 2 ? null : state.activeSession })
    expect(original).toEqual(before); expect(parsed.activeSession?.grouping).toBeUndefined()
  })
  it.each([
    null, undefined, {}, { version: 2, groups: [] }, { version: 1, groups: [] },
    { version: 1, groups: new Array(1) }, { version: 1, groups: [null] },
  ])('rejects invalid explicit wrapper %j atomically', invalid => rejects(state => { Object.assign(state.activeSession!, { grouping: invalid }) }))
  it.each(['grouping', 'group', 'round'])('rejects unknown and missing fields at %s level', level => {
    const location = (state: AppState) => level === 'grouping' ? grouping(state) : level === 'group' ? group(state) : round(state)
    rejects(state => { Object.assign(location(state), { unsupported: true }) })
    rejects(state => { Reflect.deleteProperty(location(state), level === 'grouping' ? 'version' : 'id') })
  })
  it.each(['', ' ', 'x'.repeat(151), null, 1])('rejects invalid group and round identity %j', invalid => {
    rejects(state => { Object.assign(group(state), { id: invalid }) })
    rejects(state => { Object.assign(round(state), { id: invalid }) })
  })
  it.each(['', ' ', 'x'.repeat(81), null, 1])('rejects invalid name %j', name => rejects(state => { Object.assign(group(state), { name }) }))
  it.each([-1, 901, 0.5, null, '60', NaN, Infinity])('rejects invalid rest %s', restSeconds => rejects(state => { Object.assign(group(state), { restSeconds }) }))
  it.each([[], new Array(1), [null], Array(51).fill(null)])('rejects invalid rounds %j', rounds => rejects(state => { Object.assign(group(state), { rounds }) }))
  it.each([[], ['row-0'], new Array(2), ['row-0', undefined], ['row-0', null], Array(7).fill('row-0')])('rejects invalid dense round width %j', setIds => rejects(state => { Object.assign(round(state), { setIds }) }))
  it('rejects width mismatch, duplicate/cross-group refs, non-distinct movements, warm-ups, dangling and cross-owner refs', () => {
    rejects(state => { group(state).rounds[1].setIds.push(state.activeSession!.sets.find(set => set.exerciseId === state.activeSession!.workout.exercises[2].id)!.id) })
    rejects(state => { group(state).rounds[1].setIds[0] = round(state).setIds[0] })
    rejects(state => { grouping(state).groups.push({ ...structuredClone(group(state)), id: 'g2', rounds: [{ id: 'r3', setIds: [...round(state).setIds] }] }) })
    rejects(state => { round(state).setIds[1] = state.activeSession!.sets[1].id })
    rejects(state => { state.activeSession!.sets[0].warmup = true })
    rejects(state => { round(state).setIds[0] = 'not-a-local-row' })
    rejects(state => { const log = startSession(state.workouts[0], stamp); log.sets[0].completed = true; state.logs = [finishSession(log, stamp + 60_000)]; round(state).setIds[0] = log.sets[0].id })
  })
  it('rejects all owner-local identity aliases, duplicate group/round IDs and cross-kind collisions', () => {
    for (const getId of [(state: AppState) => state.activeSession!.id, (state: AppState) => state.activeSession!.workout.id, (state: AppState) => state.activeSession!.workout.exercises[0].id, (state: AppState) => state.activeSession!.sets[0].id]) {
      rejects(state => { group(state).id = getId(state) }); rejects(state => { round(state).id = getId(state) })
    }
    rejects(state => { group(state).id = 'r2' })
    rejects(state => { group(state).rounds[1].id = 'r1' })
    rejects(state => { grouping(state).groups.push({ ...group(state), rounds: [{ id: 'r3', setIds: [state.activeSession!.sets[2].id, state.activeSession!.sets[6].id] }] }) })
  })
  it('requires grouped logs to include local row and exercise snapshots, but unrelated history may reuse identities', () => {
    const state = fixture(); state.activeSession!.sets[0].completed = true
    const first = finishSession(state.activeSession!, stamp + 60_000); first.id = 'log-1'
    const second = structuredClone(first); second.id = 'log-2'
    state.logs = [first, second]
    expect(parseState(state)).toEqual(state)
    for (const field of ['sets', 'exerciseSnapshots'] as const) {
      const invalid = structuredClone(state); delete invalid.logs[0][field]
      expect(() => parseState(invalid)).toThrow()
    }
    const missing = structuredClone(state); missing.logs[0].exerciseSnapshots = missing.logs[0].exerciseSnapshots!.slice(1)
    expect(() => parseState(missing)).toThrow()
    const aliases = structuredClone(state); aliases.logs[0].grouping!.groups[0].id = 'log-1'
    expect(() => parseState(aliases)).toThrow()
    const referenceAlias = structuredClone(state); referenceAlias.logs[0].completedExerciseIds = ['orphan-completed']; referenceAlias.logs[0].grouping!.groups[0].id = 'orphan-completed'
    expect(() => parseState(referenceAlias)).toThrow()
    referenceAlias.logs[0].grouping!.groups[0].id = 'g1'; referenceAlias.logs[0].grouping!.groups[0].rounds[0].id = 'orphan-completed'
    expect(() => parseState(referenceAlias)).toThrow()
    const historical = structuredClone(state); historical.activeSession = null; historical.workouts = [historical.workouts[1]]
    expect(parseState(historical)).toEqual(historical)
  })
  it('accepts exactly 25 groups × 50 two-member rounds / 2500 rows without global identity restrictions', () => {
    const state = fixture(); const session = state.activeSession!; const sample = session.workout.exercises[0]; const row = session.sets[0]
    session.workout.exercises = Array.from({ length: 50 }, (_, index) => ({ ...sample, id: `exercise-${index}` }))
    session.sets = session.workout.exercises.flatMap(exercise => Array.from({ length: 50 }, (_, index) => ({ ...row, id: `${exercise.id}-${index}`, exerciseId: exercise.id, setNumber: index + 1 })))
    session.grouping = { version: 1, groups: Array.from({ length: 25 }, (_, group) => ({ id: `group-${group}`, name: 'n'.repeat(80), restSeconds: 900, rounds: Array.from({ length: 50 }, (_, index) => ({ id: `round-${group}-${index}`, setIds: [`exercise-${group * 2}-${index}`, `exercise-${group * 2 + 1}-${index}`] })) })) }
    expect(parseState(state)).toEqual(state)
    const tooMany = structuredClone(state); grouping(tooMany).groups.push(structuredClone(group(tooMany)))
    expect(() => parseState(tooMany)).toThrow()
  })
  it('accepts six distinct movements and rejects grouping on any plan, exercise, or row', () => {
    const state = fixture(); const session = state.activeSession!; const sample = session.workout.exercises[0]; const row = session.sets[0]
    session.workout.exercises = Array.from({ length: 6 }, (_, index) => ({ ...sample, id: `e-${index}` }))
    session.sets = session.workout.exercises.map((exercise, index) => ({ ...row, id: `s-${index}`, exerciseId: exercise.id }))
    session.grouping = { version: 1, groups: [{ id: 'six', name: 'Circuit', restSeconds: 0, rounds: [{ id: 'six-round', setIds: session.sets.map(set => set.id) }] }] }
    expect(parseState(state)).toEqual(state)
    for (const target of [state.workouts[0], session.workout, session.workout.exercises[0], session.sets[0]]) {
      Object.assign(target, { grouping: session.grouping }); expect(() => parseState(state)).toThrow(); Reflect.deleteProperty(target, 'grouping')
    }
  })
  it('rejects sparse groups, round references and custom array fields instead of normalizing them', () => {
    rejects(state => { delete (grouping(state).groups as (SessionGrouping['groups'][number] | undefined)[])[0] })
    rejects(state => { delete (round(state).setIds as (string | undefined)[])[0] })
    rejects(state => { Object.assign(group(state).rounds, { extra: true }) })
  })
})
