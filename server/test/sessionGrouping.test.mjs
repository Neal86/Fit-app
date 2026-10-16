import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSnapshot } from '../coaching.mjs'
import { recordedTrainingDays } from '../challenges.mjs'
import { validateState } from '../state.mjs'
import { fixtureState, setup, syncBody } from './fixtures.mjs'

const now = Date.parse('2026-10-15T12:00:00Z')
function groupedState() {
  const state = fixtureState()
  state.workouts[0].exercises.push({ ...state.workouts[0].exercises[0], id: 'exercise-2', name: 'Synthetic second movement' })
  const sets = [1, 2].flatMap(exercise => [1, 2].map(setNumber => ({ id: `set-${exercise}-${setNumber}`, exerciseId: `exercise-${exercise}`, setNumber, reps: 8, weightKg: 12.123456789, seconds: null, rpe: null, warmup: false, completed: setNumber === 1 })))
  const grouping = { version: 1, groups: [{ id: 'group-1', name: 'Synthetic private grouping', restSeconds: 35, rounds: [1, 2].map(round => ({ id: `round-${round}`, setIds: [`set-1-${round}`, `set-2-${round}`] })) }] }
  state.logs = [{ id: 'log-1', workoutId: 'workout-1', title: 'Synthetic grouped history', startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:10:00Z', duration: 10, calories: 50, completedExerciseIds: [], sets: structuredClone(sets), exerciseSnapshots: state.workouts[0].exercises.map(({ id, name, category }) => ({ id, name, category })), grouping: structuredClone(grouping) }]
  state.activeSession = { id: 'active-1', workout: structuredClone(state.workouts[0]), startedAt: '2026-10-15T11:10:00Z', elapsedSeconds: 100, runningSince: null, sets, notes: '', restUntil: null, grouping }
  return state
}
const mutations = [
  owner => { owner.grouping = null },
  owner => { owner.grouping.version = 2 },
  owner => { owner.grouping.extra = true },
  owner => { owner.grouping.groups = [] },
  owner => { owner.grouping.groups[0].name = ' ' },
  owner => { owner.grouping.groups[0].restSeconds = -1 },
  owner => { owner.grouping.groups[0].restSeconds = 901 },
  owner => { owner.grouping.groups[0].restSeconds = 1.5 },
  owner => { owner.grouping.groups[0].rounds[0].setIds[0] = 'foreign-set' },
  owner => { owner.grouping.groups[0].rounds[1].setIds[0] = 'set-1-1' },
  owner => { owner.grouping.groups[0].rounds[0].setIds = ['set-1-1', 'set-1-2'] },
  owner => { owner.grouping.groups[0].rounds[0].setIds.pop() },
  owner => { owner.grouping.groups[0].rounds[1].id = 'round-1' },
  owner => { owner.grouping.groups[0].id = 'set-1-1' },
  owner => { owner.grouping.groups[0].rounds[0].id = owner.id },
  owner => { owner.grouping.groups[0].rounds[0].completed = true },
  owner => { owner.sets[0].warmup = true },
  owner => { owner.sets.splice(0, 1) },
]

test('server validation preserves exact active and historical grouping without changing rows or targets', () => {
  const state = groupedState(), before = structuredClone(state)
  assert.deepEqual(validateState(state), before)
  assert.deepEqual(state, before)
  state.activeSession.grouping.groups[0].name = 'Changed active label'
  assert.equal(state.logs[0].grouping.groups[0].name, 'Synthetic private grouping')
  assert.ok(!JSON.stringify(state.workouts).includes('grouping'))
})

test('server rejects malformed grouping and unsupported old-version placement without repair', () => {
  for (const location of ['activeSession', 'log']) {
    for (const mutate of mutations) {
      const state = groupedState(), owner = location === 'log' ? state.logs[0] : state.activeSession
      mutate(owner)
      const before = structuredClone(state)
      assert.throws(() => validateState(state), `${location}: ${mutate}`)
      assert.deepEqual(state, before)
    }
  }
  for (const version of [2, 3]) {
    const state = groupedState(); state.version = version
    assert.throws(() => validateState(state))
  }
  for (const key of ['sets', 'exerciseSnapshots']) {
    const state = groupedState(); delete state.logs[0][key]
    assert.throws(() => validateState(state))
  }
  const state = groupedState(); state.logs[0].exerciseSnapshots.pop()
  assert.throws(() => validateState(state))
})

test('invalid grouped uploads cannot replace a saved valid state or advance its revision', async t => {
  const f = setup(); t.after(f.close)
  const user = f.seed('grouping-validation@example.test', true), state = groupedState()
  assert.equal((await f.request('PUT', '/sync', syncBody(state), user)).status, 200)
  for (const location of ['activeSession', 'log']) {
    for (const mutate of mutations) {
      const invalid = structuredClone(state)
      mutate(location === 'log' ? invalid.logs[0] : invalid.activeSession)
      const rejected = await f.request('PUT', '/sync', syncBody(invalid, 1), user)
      assert.equal(rejected.status, 400, `${location}: ${mutate}`)
      assert.equal(rejected.body.error.code, 'invalid_state')
    }
  }
  const saved = await f.request('GET', '/sync', undefined, user)
  assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1)
  assert.deepEqual(saved.body.state, state)
})

test('all coach scopes omit private grouping while preserving the existing saved-row projection', () => {
  const state = groupedState(), plain = structuredClone(state)
  delete plain.activeSession.grouping; delete plain.logs[0].grouping
  const scopes = ['training', 'body', 'nutrition']
  assert.deepEqual(projectSnapshot(validateState(state), scopes), projectSnapshot(plain, scopes))
  assert.ok(!JSON.stringify(projectSnapshot(state, scopes)).includes('grouping'))
  assert.equal(projectSnapshot(state, scopes).training.logs[0].sets.length, 4)
})

test('group names, rounds and partial completion do not grant additional self-recorded training days', () => {
  const state = groupedState(), plain = structuredClone(state)
  delete plain.activeSession.grouping; delete plain.logs[0].grouping
  const count = value => recordedTrainingDays(validateState(value), '2026-10-01', '2026-10-31', now)
  assert.equal(count(state), 1); assert.equal(count(state), count(plain))
  assert.equal(count({ ...state, logs: [] }), 0)
  state.logs[0].sets.forEach(row => { row.completed = false })
  assert.equal(count(state), 0)
  state.logs[0].sets[0].completed = true; state.logs[0].sets[0].reps = 0
  assert.equal(count(state), 0)
})
