import test from 'node:test'
import assert from 'node:assert/strict'
import { validateState } from '../state.mjs'
import { projectSnapshot } from '../coaching.mjs'
import { recordedTrainingDays } from '../challenges.mjs'
import { POLICY_VERSION } from '../config.mjs'
import { fixtureState, setup, syncBody, PASSWORD } from './fixtures.mjs'

const unknown = () => ({ version: 1, status: 'unknown' })
const stamp = '2026-10-15T09:00:00.000Z'
function estimateState() {
  const state = fixtureState(), workout = state.workouts[0]
  workout.calories = unknown()
  workout.exercises[0].equipment = []
  workout.exercises[0].libraryOrigin = { version: 1, entryId: 'private-ancestry', revision: 2 }
  state.planHistory = [{ id: 'prior-plan', savedAt: stamp, label: 'Synthetic prior plan', workouts: structuredClone(state.workouts) }]
  state.planHistory[0].workouts[0].calories = 0.123456789012345
  const row = { id: 'completed-row', exerciseId: workout.exercises[0].id, setNumber: 1, reps: 8, weightKg: null, seconds: null, rpe: null, warmup: false, completed: true }
  state.logs = [{ id: 'prior-log', workoutId: workout.id, title: 'Synthetic history', startedAt: stamp, completedAt: '2026-10-15T09:10:00.000Z', duration: 10, calories: unknown(), completedExerciseIds: [row.exerciseId], sets: [row], exerciseSnapshots: workout.exercises.map(({ id, name, category, libraryOrigin }) => ({ id, name, category, libraryOrigin })) }]
  state.activeSession = { id: 'active-session', workout: structuredClone(workout), startedAt: stamp, elapsedSeconds: 11, runningSince: null, sets: [{ ...row, id: 'active-row', completed: false }], notes: 'Private synthetic active note', restUntil: null }
  state.nutrition.meals = [{ id: 'synthetic-meal', date: '2026-10-15', mealType: 'Lunch', foodName: 'Synthetic meal', serving: 'One', calories: 0, protein: 1, carbs: 2, fat: 3 }]
  return state
}
const malformed = [
  s => { s.workouts[0].calories = null },
  s => { delete s.workouts[0].calories },
  s => { s.workouts[0].calories = 'unknown' },
  s => { s.workouts[0].calories = { status: 'unknown' } },
  s => { s.workouts[0].calories.version = 2 },
  s => { s.workouts[0].calories.version = '1' },
  s => { s.workouts[0].calories.status = 'known' },
  s => { s.workouts[0].calories.value = 0 },
  s => { s.workouts[0].calories.privateNote = 'Never share this' },
  s => { s.workouts[0].calories = [unknown()] },
  s => { s.workouts[0].calories = -1 },
  s => { s.workouts[0].calories = 10000.01 },
  s => { s.logs[0].calories = { version: 1, status: 'unknown', count: 0 } },
  s => { s.logs[0].calories = 10000000.01 },
  s => { s.activeSession.workout.calories.version = 0 },
  s => { s.planHistory[0].workouts[0].calories = null },
  s => { s.nutrition.meals[0].calories = unknown() },
  s => { s.profile.calories = unknown() },
  s => { s.version = 2 },
  s => { s.version = 3 },
]

test('shared server schema preserves exact unknown, known zero and fractional estimates without mutation', () => {
  const state = estimateState(), before = structuredClone(state)
  assert.deepEqual(validateState(state), before); assert.deepEqual(state, before)
  for (const value of [0, 0.123456789012345, 10000]) {
    state.workouts[0].calories = value
    assert.equal(validateState(state).workouts[0].calories, value)
  }
  for (const value of [0, 0.123456789012345, 10000000]) {
    state.logs[0].calories = value
    assert.equal(validateState(state).logs[0].calories, value)
  }
  for (const mutate of malformed) {
    const invalid = estimateState(); mutate(invalid); const original = structuredClone(invalid)
    assert.throws(() => validateState(invalid), String(mutate)); assert.deepEqual(invalid, original)
  }
})

test('malformed estimate uploads leave the preceding unknown snapshot and revision intact', async t => {
  const f = setup(); t.after(f.close)
  const owner = f.seed('estimate-owner@example.test', true), state = estimateState()
  assert.equal((await f.request('PUT', '/sync', syncBody(state), owner)).status, 200)
  for (const mutate of malformed) {
    const invalid = structuredClone(state); mutate(invalid)
    const response = await f.request('PUT', '/sync', syncBody(invalid, 1), owner)
    assert.equal(response.status, 400, String(mutate)); assert.equal(response.body.error.code, 'invalid_state')
  }
  const saved = await f.request('GET', '/sync', undefined, owner)
  assert.equal(saved.body.revision, 1); assert.deepEqual(saved.body.state, state)
})

test('own sync and account export retain unknown estimates without cross-account access or consent expansion', async t => {
  const f = setup(); t.after(f.close)
  const owner = f.seed('estimate-export@example.test', true), other = f.seed('estimate-other@example.test', true), state = estimateState()
  assert.equal((await f.request('PUT', '/sync', syncBody(state), owner)).status, 200)
  const exported = await f.request('POST', '/account/export', { password: PASSWORD }, owner)
  assert.equal(exported.status, 200); assert.deepEqual(exported.body.sync.state, state)
  assert.equal((await f.request('GET', '/sync', undefined, other)).body.state, null)
  assert.equal((await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, owner)).status, 200)
  assert.equal((await f.request('GET', '/sync', undefined, owner)).status, 403)
  assert.equal((await f.request('POST', '/account/export', { password: PASSWORD }, owner)).body.sync.state, null)
})

test('coach projection keeps the existing calorie field exact, excludes private metadata and does not affect challenge counts', () => {
  const state = estimateState(), original = structuredClone(state)
  const projection = projectSnapshot(validateState(state), ['training', 'nutrition'])
  assert.deepEqual(projection.training.workouts[0].calories, unknown())
  assert.deepEqual(projection.training.logs[0].calories, unknown())
  assert.equal(projection.training.planHistory[0].workouts[0].calories, 0.123456789012345)
  assert.equal(projection.nutrition.meals[0].calories, 0)
  assert.ok(!/equipment|libraryOrigin|private-ancestry|activeSession|Private synthetic active/.test(JSON.stringify(projection)))
  const known = structuredClone(state); known.logs[0].calories = 0; known.workouts[0].calories = 0
  const count = value => recordedTrainingDays(validateState(value), '2026-10-01', '2026-10-31', Date.parse('2026-10-15T12:00:00Z'))
  assert.equal(count(state), 1); assert.equal(count(known), 1); assert.deepEqual(state, original)
})
