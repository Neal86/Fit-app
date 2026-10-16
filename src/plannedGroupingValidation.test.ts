// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { freshState, loadState, parseBackup, parseState, saveState, STORAGE_KEY } from './storage'
import { parseState as oldParseState } from './testFixtures/prePlannedGroupingStateValidation'
import { loadState as oldLoadState, saveState as oldSaveState } from './testFixtures/prePlannedGroupingStorage'
import { finishSession, startSession } from './session'
import { validPlannedGrouping } from './plannedGroupingValidation'
import { PLAN_DRAFT_KEY, readPlanDraft, savePlanDraft } from './planDraft'
import type { PlannedGrouping, Workout } from './types'

const metadata = (): PlannedGrouping => ({ version: 1, groups: [{ id: 'pair-group', name: 'Pair', restSeconds: 37, rounds: [{ id: 'pair-round1', members: [{ exerciseId: 'row', setNumber: 3 }, { exerciseId: 'bench', setNumber: 1 }] }, { id: 'pair-round2', members: [{ exerciseId: 'row', setNumber: 1 }, { exerciseId: 'bench', setNumber: 4 }] }] }] })
const setup = () => { const state = freshState(); state.workouts[0].plannedGrouping = metadata(); return state }
const record = (value: unknown) => value as Record<string, unknown>
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })

describe('strict planned grouping schema compatibility', () => {
  it.each([2, 3, 4])('leaves absent metadata unchanged for legacy v%i data', version => {
    const state = { ...freshState(), version }; const before = structuredClone(state)
    expect(parseState(state)).toEqual(oldParseState(state)); expect(state).toEqual(before)
    expect(parseState(state).workouts[0]).not.toHaveProperty('plannedGrouping')
  })
  it('round trips current and historical definitions exactly while the strict old reader refuses them non-destructively', () => {
    const state = setup(); state.planHistory = [{ id: 'revision', savedAt: '2026-10-15T12:00:00Z', label: 'Previous', workouts: structuredClone(state.workouts) }]
    const before = structuredClone(state); const raw = JSON.stringify(state)
    expect(parseBackup(raw)).toEqual(state); expect(parseState(state)).toEqual(state)
    expect(() => oldParseState(state)).toThrow(); expect(state).toEqual(before)
    localStorage.setItem(STORAGE_KEY, raw)
    expect(oldLoadState()).toMatchObject({ raw }); expect(oldLoadState().error).not.toBe('')
    expect(() => oldSaveState(state)).toThrow(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })
  it.each([2, 3])('rejects supplied plannedGrouping anywhere in v%i before old migration can discard it', version => {
    for (const location of ['root', 'plan', 'history', 'active', 'nested']) {
      const state = freshState(); const value = { ...state, version }
      if (location === 'root') Object.assign(value, { plannedGrouping: undefined })
      if (location === 'plan') value.workouts[0].plannedGrouping = metadata()
      if (location === 'history') value.planHistory = [{ id: 'revision', savedAt: '2026-10-15T12:00:00Z', label: 'Previous', workouts: [{ ...state.workouts[0], plannedGrouping: metadata() }] }]
      if (location === 'active') Object.assign(value, { activeSession: { plannedGrouping: null } })
      if (location === 'nested') Object.assign(value, { activeSession: { ignored: [{ child: { plannedGrouping: {} } }] } })
      const before = structuredClone(value); expect(() => parseState(value)).toThrow('requires version 4'); expect(value).toEqual(before)
    }
  })
  it('rejects plan wrappers on active snapshots, logs, exercises or runtime grouping', () => {
    for (const where of ['active', 'log', 'exercise', 'runtime']) {
      const state = setup(); state.activeSession = startSession(state.workouts[0])
      if (where === 'active') state.activeSession.workout.plannedGrouping = metadata()
      if (where === 'log') { state.activeSession.sets[0].completed = true; const log = finishSession(state.activeSession); Object.assign(log, { plannedGrouping: metadata() }); state.logs = [log]; state.activeSession = null }
      if (where === 'exercise') Object.assign(state.workouts[0].exercises[0], { plannedGrouping: metadata() })
      if (where === 'runtime') Object.assign(state.activeSession!, { grouping: metadata() })
      expect(() => parseState(state)).toThrow()
    }
  })
  it.each([
    ['wrapper extra', (g: PlannedGrouping) => { Object.assign(g, { enabled: true }) }],
    ['version', (g: PlannedGrouping) => { Object.assign(g, { version: 2 }) }],
    ['empty groups', (g: PlannedGrouping) => { g.groups = [] }],
    ['missing groups', (g: PlannedGrouping) => { delete record(g).groups }],
    ['sparse groups', (g: PlannedGrouping) => { g.groups.length++ }],
    ['array custom property', (g: PlannedGrouping) => { Object.assign(g.groups, { extra: true }) }],
    ['group extra', (g: PlannedGrouping) => { Object.assign(g.groups[0], { notes: '' }) }],
    ['missing rest', (g: PlannedGrouping) => { delete record(g.groups[0]).restSeconds }],
    ['empty name', (g: PlannedGrouping) => { g.groups[0].name = '  ' }],
    ['long name', (g: PlannedGrouping) => { g.groups[0].name = 'x'.repeat(81) }],
    ['negative rest', (g: PlannedGrouping) => { g.groups[0].restSeconds = -1 }],
    ['fractional rest', (g: PlannedGrouping) => { g.groups[0].restSeconds = 0.1 }],
    ['excess rest', (g: PlannedGrouping) => { g.groups[0].restSeconds = 901 }],
    ['nonfinite rest', (g: PlannedGrouping) => { g.groups[0].restSeconds = NaN }],
    ['empty rounds', (g: PlannedGrouping) => { g.groups[0].rounds = [] }],
    ['excess rounds', (g: PlannedGrouping) => { g.groups[0].rounds = Array.from({ length: 21 }, (_, i) => ({ id: `round${i}`, members: [{ exerciseId: 'bench', setNumber: 1 }, { exerciseId: 'row', setNumber: 1 }] })) }],
    ['sparse rounds', (g: PlannedGrouping) => { g.groups[0].rounds.length++ }],
    ['round extra', (g: PlannedGrouping) => { Object.assign(g.groups[0].rounds[0], { setIds: [] }) }],
    ['missing round ID', (g: PlannedGrouping) => { delete record(g.groups[0].rounds[0]).id }],
    ['sparse members', (g: PlannedGrouping) => { delete g.groups[0].rounds[0].members[0] }],
    ['member extra', (g: PlannedGrouping) => { Object.assign(g.groups[0].rounds[0].members[0], { id: 'bad' }) }],
    ['single member', (g: PlannedGrouping) => { g.groups[0].rounds[0].members.pop() }],
    ['missing set number', (g: PlannedGrouping) => { delete record(g.groups[0].rounds[0].members[0]).setNumber }],
    ['fractional set', (g: PlannedGrouping) => { g.groups[0].rounds[0].members[0].setNumber = 1.5 }],
    ['zero set', (g: PlannedGrouping) => { g.groups[0].rounds[0].members[0].setNumber = 0 }],
    ['excess set', (g: PlannedGrouping) => { g.groups[0].rounds[0].members[0].setNumber = 21 }],
    ['out of range set', (g: PlannedGrouping) => { g.groups[0].rounds[0].members[0].setNumber = 5 }],
    ['missing exercise', (g: PlannedGrouping) => { g.groups[0].rounds[0].members[0].exerciseId = 'missing' }],
    ['same movement', (g: PlannedGrouping) => { g.groups[0].rounds[0].members[0].exerciseId = 'bench' }],
    ['different movement order', (g: PlannedGrouping) => { g.groups[0].rounds[1].members.reverse() }],
    ['different movements', (g: PlannedGrouping) => { g.groups[0].rounds[1].members[0].exerciseId = 'curl' }],
    ['duplicate slot across rounds', (g: PlannedGrouping) => { g.groups[0].rounds[1].members[0].setNumber = 3 }],
    ['duplicate slot across groups', (g: PlannedGrouping) => { g.groups.push({ ...structuredClone(g.groups[0]), id: 'other-group', rounds: [{ id: 'other-round', members: structuredClone(g.groups[0].rounds[0].members) }] }) }],
    ['duplicate round ID', (g: PlannedGrouping) => { g.groups[0].rounds[1].id = g.groups[0].rounds[0].id }],
    ['group-round alias', (g: PlannedGrouping) => { g.groups[0].rounds[0].id = g.groups[0].id }],
    ['blank group ID', (g: PlannedGrouping) => { g.groups[0].id = ' ' }],
    ['long round ID', (g: PlannedGrouping) => { g.groups[0].rounds[0].id = 'x'.repeat(151) }],
  ] as const)('rejects %s without mutating original data', (_name, change) => {
    const state = setup(); change(state.workouts[0].plannedGrouping!); const before = structuredClone(state)
    expect(() => parseState(state)).toThrow(); expect(state).toEqual(before)
    expect(() => saveState(state)).toThrow(); expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
  it.each([undefined, null, [], {}, { version: 1, groups: null }])('rejects supplied invalid wrapper %j', plannedGrouping => {
    const state = freshState(); Object.assign(state.workouts[0], { plannedGrouping }); expect(() => parseState(state)).toThrow()
  })
  it('rejects identity aliases across owner and the current or historical plan while retaining independent snapshot identity domains', () => {
    for (const alias of ['upper-power', 'bench', 'lower-strength', 'squat']) for (const part of ['group', 'round']) {
      const state = setup(); const g = state.workouts[0].plannedGrouping!
      if (part === 'group') g.groups[0].id = alias; else g.groups[0].rounds[0].id = alias
      expect(() => parseState(state)).toThrow()
      const historic = freshState(); historic.planHistory = [{ id: 'revision', label: 'Previous', savedAt: '2026-10-15T12:00:00Z', workouts: state.workouts }]
      expect(() => parseState(historic)).toThrow()
    }
    const state = setup(); const other = state.workouts[1]
    other.plannedGrouping = { version: 1, groups: [{ ...metadata().groups[0], rounds: [{ id: 'other-round', members: other.exercises.slice(0, 2).map(exercise => ({ exerciseId: exercise.id, setNumber: 1 })) }] }] }
    expect(() => parseState(state)).toThrow()
    delete other.plannedGrouping
    state.planHistory = [1, 2].map(n => ({ id: `rev${n}`, label: 'Old plan', savedAt: '2026-10-15T12:00:00Z', workouts: structuredClone(state.workouts) }))
    expect(parseState(state)).toEqual(state)
  })
  it('does not reject legacy workout/exercise ID aliases when only new group IDs must be distinct', () => {
    const state = setup(); state.workouts[0].id = 'bench'
    expect(parseState(state)).toEqual(state)
    expect(parseState({ ...state, activeSession: startSession(state.workouts[0]) }).activeSession).not.toBeNull()
  })
  it('allows 20 exact rounds, 2–6 ordered movements, 25 groups, and endpoint name/rest bounds', () => {
    const workout = freshState().workouts[0]
    workout.exercises = Array.from({ length: 50 }, (_, index) => ({ ...workout.exercises[0], id: `ex${index}`, sets: 20 }))
    workout.plannedGrouping = { version: 1, groups: Array.from({ length: 25 }, (_, g) => ({ id: `group${g}`, name: g ? 'A' : 'x'.repeat(80), restSeconds: g ? 0 : 900, rounds: Array.from({ length: 20 }, (_, round) => ({ id: `round${g}-${round}`, members: [0, 1].map(i => ({ exerciseId: `ex${g * 2 + i}`, setNumber: round + 1 })) })) })) }
    expect(parseState({ ...freshState(), workouts: [workout] }).workouts[0]).toEqual(workout)
    const excess = structuredClone(workout); excess.plannedGrouping!.groups.push(structuredClone(excess.plannedGrouping!.groups[0])); expect(() => parseState({ ...freshState(), workouts: [excess] })).toThrow()
    const six = structuredClone(workout); six.plannedGrouping!.groups = [six.plannedGrouping!.groups[0]]
    six.plannedGrouping!.groups[0].rounds.forEach((round, i) => { round.members = six.exercises.slice(0, 6).map(exercise => ({ exerciseId: exercise.id, setNumber: i + 1 })) })
    expect(validPlannedGrouping(six.plannedGrouping, six)).toBe(true)
    six.plannedGrouping!.groups[0].rounds[0].members.push({ exerciseId: 'ex6', setNumber: 1 }); expect(validPlannedGrouping(six.plannedGrouping, six)).toBe(false)
  })
  it('preserves last-good bytes on invalid modern storage loads and attempted writes', () => {
    const valid = setup(); const raw = saveState(valid); const invalid = structuredClone(valid); invalid.workouts[0].plannedGrouping!.groups[0].rounds[0].members[0].setNumber = 99
    expect(() => saveState(invalid)).toThrow(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
    const corrupted = JSON.stringify(invalid); localStorage.setItem(STORAGE_KEY, corrupted)
    expect(loadState().raw).toBe(corrupted); expect(loadState().error).not.toBe(''); expect(localStorage.getItem(STORAGE_KEY)).toBe(corrupted)
  })
})

describe('plan draft grouping recovery', () => {
  it.each([0, -1, 1.5, 3, 21])('recovers exact metadata independently of incomplete set counts %s', sets => {
    const workout = setup().workouts[0]; workout.title = ''; workout.duration = 0; workout.exercises[0].sets = sets
    savePlanDraft(workout); expect(readPlanDraft()).toEqual(workout)
    expect(() => parseState({ ...freshState(), workouts: [workout] })).toThrow()
  })
  it('rejects malformed metadata and dangling references without erasing recovery bytes', () => {
    const malformed: Workout[] = []
    const missing = setup().workouts[0]; missing.exercises = missing.exercises.filter(exercise => exercise.id !== 'bench'); malformed.push(missing)
    const wrong = setup().workouts[0]; wrong.plannedGrouping!.groups[0].rounds[0].members[0].setNumber = 21; malformed.push(wrong)
    const alias = setup().workouts[0]; alias.plannedGrouping!.groups[0].id = alias.id; malformed.push(alias)
    const extra = setup().workouts[0]; Object.assign(extra.plannedGrouping!.groups[0].rounds[0], { extra: true }); malformed.push(extra)
    const duplicate = setup().workouts[0]; duplicate.exercises[1].id = duplicate.exercises[0].id; malformed.push(duplicate)
    for (const workout of malformed) { const raw = JSON.stringify(workout); sessionStorage.setItem(PLAN_DRAFT_KEY, raw); expect(readPlanDraft()).toBeNull(); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(raw) }
  })
})
