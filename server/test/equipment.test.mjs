import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSnapshot } from '../coaching.mjs'
import { recordedTrainingDays } from '../challenges.mjs'
import { validateState } from '../state.mjs'
import { fixtureState, setup, syncBody } from './fixtures.mjs'

const now = Date.parse('2026-10-15T12:00:00Z')
function withSnapshots() {
  const state = fixtureState()
  state.logs = [{ id: 'log-1', workoutId: 'workout-1', title: 'Synthetic saved session', startedAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:10:00Z', duration: 10, calories: 50, completedExerciseIds: ['exercise-1'], sets: [{ id: 'set-1', exerciseId: 'exercise-1', setNumber: 1, reps: 10, weightKg: 0, seconds: null, rpe: null, warmup: false, completed: true }], exerciseSnapshots: [{ id: 'exercise-1', name: 'Walk', category: 'Cardio' }] }]
  state.planHistory = [{ id: 'plan-1', label: 'Synthetic prior plan', savedAt: '2026-10-15T11:00:00Z', workouts: structuredClone(state.workouts) }]
  state.activeSession = { id: 'active-1', workout: structuredClone(state.workouts[0]), startedAt: '2026-10-15T11:10:00Z', elapsedSeconds: 100, runningSince: null, sets: structuredClone(state.logs[0].sets), notes: '', restUntil: null }
  return state
}

test('shared server validation preserves valid equipment in full plan snapshots only', () => {
  const state = withSnapshots()
  state.workouts[0].exercises[0].equipment = ['barbell', 'weight-plates', 'bench']
  state.planHistory[0].workouts[0].exercises[0].equipment = []
  state.activeSession.workout.exercises[0].equipment = ['treadmill']
  assert.deepEqual(validateState(state), state)
  assert.equal(Object.hasOwn(state.logs[0].exerciseSnapshots[0], 'equipment'), false)
  state.logs[0].exerciseSnapshots[0].equipment = []
  assert.throws(() => validateState(state))
})

test('shared server validation rejects malformed requirements in current, previous and active plans', () => {
  for (const equipment of [null, 'barbell', ['unknown'], ['bench', 'bench'], [1], new Array(1), Array(18).fill('bench')]) {
    for (const location of ['current', 'previous', 'active']) {
      const state = withSnapshots()
      const exercise = location === 'current' ? state.workouts[0].exercises[0] : location === 'previous' ? state.planHistory[0].workouts[0].exercises[0] : state.activeSession.workout.exercises[0]
      exercise.equipment = equipment
      assert.throws(() => validateState(state), `${location}: ${JSON.stringify(equipment)}`)
    }
  }
})

test('crafted equipment uploads cannot revise or replace an existing valid cloud snapshot', async t => {
  const f = setup(); t.after(f.close)
  const user = f.seed('equipment-validation@example.test', true)
  const state = withSnapshots()
  state.workouts[0].exercises[0].equipment = ['barbell', 'weight-plates']
  state.planHistory[0].workouts[0].exercises[0].equipment = []
  state.activeSession.workout.exercises[0].equipment = ['treadmill']
  assert.equal((await f.request('PUT', '/sync', syncBody(state), user)).status, 200)
  for (const location of ['current', 'previous', 'active']) {
    for (const equipment of [null, ['unsupported'], ['bench', 'bench'], [null], Array(18).fill('bench')]) {
      const invalid = structuredClone(state)
      const exercise = location === 'current' ? invalid.workouts[0].exercises[0] : location === 'previous' ? invalid.planHistory[0].workouts[0].exercises[0] : invalid.activeSession.workout.exercises[0]
      exercise.equipment = equipment
      const rejected = await f.request('PUT', '/sync', syncBody(invalid, 1), user)
      assert.equal(rejected.status, 400)
      assert.equal(rejected.body.error.code, 'invalid_state')
    }
  }
  const saved = await f.request('GET', '/sync', undefined, user)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.revision, 1)
  assert.deepEqual(saved.body.state, state)
})

test('all coach scopes retain their existing allowlist and omit equipment from current and previous plans', () => {
  const state = withSnapshots()
  const scopes = ['training', 'body', 'nutrition']
  const originalProjection = projectSnapshot(state, scopes)
  state.workouts[0].exercises[0].equipment = ['barbell', 'weight-plates', 'bench']
  state.planHistory[0].workouts[0].exercises[0].equipment = []
  state.activeSession.workout.exercises[0].equipment = ['treadmill']
  const original = structuredClone(state)
  assert.deepEqual(projectSnapshot(validateState(state), scopes), originalProjection)
  assert.ok(!JSON.stringify(projectSnapshot(state, scopes)).includes('equipment'))
  assert.deepEqual(state, original)
})

test('equipment classifications do not affect count-only challenge evidence or add training days', () => {
  const state = withSnapshots(); const logs = structuredClone(state.logs)
  const count = value => recordedTrainingDays(validateState(value), '2026-10-01', '2026-10-31', now)
  assert.equal(count(state), 1)
  for (const equipment of [[], ['barbell', 'bench'], ['treadmill']]) {
    state.workouts[0].exercises[0].equipment = equipment
    state.planHistory[0].workouts[0].exercises[0].equipment = equipment
    state.activeSession.workout.exercises[0].equipment = equipment
    assert.equal(count(state), 1)
    assert.equal(count({ ...state, logs: [] }), 0)
    assert.deepEqual(state.logs, logs)
  }
})
