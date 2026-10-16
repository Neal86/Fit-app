import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSnapshot } from '../coaching.mjs'
import { recordedTrainingDays } from '../challenges.mjs'
import { validateState } from '../state.mjs'
import { fixtureState, setup, syncBody, PASSWORD } from './fixtures.mjs'

const now = Date.parse('2026-10-15T12:00:00Z')
function plannedState() {
  const state = fixtureState(), workout = state.workouts[0]
  workout.exercises[0].sets = 3
  workout.exercises.push({ ...workout.exercises[0], id: 'exercise-2', name: 'Synthetic second movement' })
  workout.plannedGrouping = { version: 1, groups: [{ id: 'planned-group', name: 'Private future grouping', restSeconds: 35,
    rounds: [1, 3].map(setNumber => ({ id: `planned-round-${setNumber}`, members: workout.exercises.map(exercise => ({ exerciseId: exercise.id, setNumber })) })) }] }
  state.planHistory = [{ id: 'plan-revision', savedAt: '2026-10-14T09:00:00Z', label: 'Synthetic prior plan', workouts: structuredClone(state.workouts) }]
  const sets = workout.exercises.flatMap(exercise => [1, 2, 3].map(setNumber => ({ id: `${exercise.id}-row-${setNumber}`, exerciseId: exercise.id,
    setNumber, reps: 8, weightKg: 12.123456789, seconds: null, rpe: null, warmup: false, completed: setNumber === 1 })))
  const grouping = { version: 1, groups: [{ id: 'runtime-group', name: 'Private completed grouping', restSeconds: 35,
    rounds: [1, 3].map(setNumber => ({ id: `runtime-round-${setNumber}`, setIds: workout.exercises.map(exercise => `${exercise.id}-row-${setNumber}`) })) }] }
  state.logs = [{ id: 'log-1', workoutId: workout.id, title: 'Synthetic grouped history', startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:10:00Z',
    duration: 10, calories: 50, completedExerciseIds: [], sets: structuredClone(sets), exerciseSnapshots: workout.exercises.map(({ id, name, category }) => ({ id, name, category })), grouping }]
  return state
}
const mutations = [
  workout => { workout.plannedGrouping = null },
  workout => { workout.plannedGrouping.version = 2 },
  workout => { workout.plannedGrouping.extra = true },
  workout => { workout.plannedGrouping.groups = [] },
  workout => { workout.plannedGrouping.groups[0].name = ' ' },
  workout => { workout.plannedGrouping.groups[0].restSeconds = 901 },
  workout => { workout.plannedGrouping.groups[0].restSeconds = 1.5 },
  workout => { workout.plannedGrouping.groups[0].id = workout.id },
  workout => { workout.plannedGrouping.groups[0].rounds[0].id = workout.exercises[0].id },
  workout => { workout.plannedGrouping.groups[0].rounds[1].id = workout.plannedGrouping.groups[0].rounds[0].id },
  workout => { workout.plannedGrouping.groups[0].rounds[0].members[0].exerciseId = 'foreign-exercise' },
  workout => { workout.plannedGrouping.groups[0].rounds[0].members[0].setNumber = 0 },
  workout => { workout.plannedGrouping.groups[0].rounds[0].members[0].setNumber = 4 },
  workout => { workout.plannedGrouping.groups[0].rounds[0].members[0].setNumber = 1.1 },
  workout => { workout.plannedGrouping.groups[0].rounds[0].members[0].completed = true },
  workout => { workout.plannedGrouping.groups[0].rounds[0].members[1] = structuredClone(workout.plannedGrouping.groups[0].rounds[0].members[0]) },
  workout => { workout.plannedGrouping.groups[0].rounds[1].members[0].setNumber = 1 },
  workout => { workout.plannedGrouping.groups[0].rounds[1].members.reverse() },
  workout => { workout.plannedGrouping.groups[0].rounds[1].members.pop() },
  workout => { workout.exercises.splice(0, 1) },
  workout => { workout.exercises[0].sets = 2 },
]

test('private server state preserves current and historical planned definitions without changing executed rows', () => {
  const state = plannedState(), before = structuredClone(state)
  assert.deepEqual(validateState(state), before); assert.deepEqual(state, before)
  state.workouts[0].plannedGrouping.groups[0].name = 'Changed future plan only'
  assert.equal(state.planHistory[0].workouts[0].plannedGrouping.groups[0].name, 'Private future grouping')
  assert.equal(state.logs[0].grouping.groups[0].name, 'Private completed grouping')
})

test('shared server validator rejects malformed definitions, misplaced fields and legacy migration loss without repair', () => {
  for (const previous of [false, true]) for (const mutate of mutations) {
    const state = plannedState(), workout = (previous ? state.planHistory[0].workouts : state.workouts)[0]
    mutate(workout); const before = structuredClone(state)
    assert.throws(() => validateState(state), `${previous}: ${mutate}`); assert.deepEqual(state, before)
  }
  for (const version of [2, 3]) {
    const state = plannedState(); state.version = version
    assert.throws(() => validateState(state))
  }
  for (const place of ['active', 'log', 'root']) {
    const state = plannedState(), definition = structuredClone(state.workouts[0].plannedGrouping)
    if (place === 'root') state.plannedGrouping = definition
    if (place === 'log') state.logs[0].plannedGrouping = definition
    if (place === 'active') state.activeSession = { id: 'active-other', workout: structuredClone(state.workouts[0]), startedAt: '2026-10-15T10:00:00Z', elapsedSeconds: 0,
      runningSince: null, sets: structuredClone(state.logs[0].sets), notes: '', restUntil: null }
    assert.throws(() => validateState(state), place)
  }
})

test('crafted planned-definition uploads cannot advance the saved revision or damage the prior snapshot', async t => {
  const f = setup(); t.after(f.close)
  const user = f.seed('planned-validation@example.test', true), state = plannedState()
  assert.equal((await f.request('PUT', '/sync', syncBody(state), user)).status, 200)
  for (const previous of [false, true]) for (const mutate of mutations) {
    const invalid = structuredClone(state)
    mutate((previous ? invalid.planHistory[0].workouts : invalid.workouts)[0])
    const rejected = await f.request('PUT', '/sync', syncBody(invalid, 1), user)
    assert.equal(rejected.status, 400); assert.equal(rejected.body.error.code, 'invalid_state')
  }
  const saved = await f.request('GET', '/sync', undefined, user)
  assert.equal(saved.body.revision, 1); assert.deepEqual(saved.body.state, state)
})

test('own account export preserves planned snapshots and keeps a second account isolated', async t => {
  const f = setup(); t.after(f.close)
  const user = f.seed('planned-owner@example.test', true), other = f.seed('planned-other@example.test', true), state = plannedState()
  assert.equal((await f.request('PUT', '/sync', syncBody(state), user)).status, 200)
  const exported = await f.request('POST', '/account/export', { password: PASSWORD }, user)
  assert.equal(exported.status, 200); assert.deepEqual(exported.body.sync.state, state)
  const unrelated = await f.request('GET', '/sync', undefined, other)
  assert.equal(unrelated.body.state, null); assert.equal(unrelated.body.revision, 0)
})

test('planned names and rounds never broaden coach fields or add private challenge days', () => {
  const state = plannedState(), plain = structuredClone(state)
  delete plain.workouts[0].plannedGrouping
  delete plain.planHistory[0].workouts[0].plannedGrouping
  const scopes = ['training', 'body', 'nutrition'], projected = projectSnapshot(validateState(state), scopes)
  assert.deepEqual(projected, projectSnapshot(validateState(plain), scopes))
  assert.ok(!JSON.stringify(projected).includes('plannedGrouping'))
  assert.ok(!JSON.stringify(projected).includes('Private future grouping'))
  const count = value => recordedTrainingDays(validateState(value), '2026-10-01', '2026-10-31', now)
  assert.equal(count(state), 1); assert.equal(count(state), count(plain))
  assert.equal(count({ ...state, logs: [] }), 0)
})
