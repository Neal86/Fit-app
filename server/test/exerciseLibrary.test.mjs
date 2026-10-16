import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSnapshot } from '../coaching.mjs'
import { recordedTrainingDays } from '../challenges.mjs'
import { validateState } from '../state.mjs'
import { POLICY_VERSION } from '../config.mjs'
import { fixtureState, setup, syncBody, PASSWORD } from './fixtures.mjs'

const stamp = '2026-10-15T09:00:00.000Z'
function libraryState() {
  const state = fixtureState()
  const content = { name: 'Private synthetic library entry', category: 'Manual', sets: 2, reps: '8', restSeconds: 25, notes: 'Private library-only note', equipment: [] }
  state.exerciseLibrary = { version: 1, entries: [
    { id: 'personal-entry', revision: 3, status: 'active', createdAt: stamp, updatedAt: stamp, exercise: content },
    { id: 'archived-entry', revision: 1, status: 'archived', createdAt: stamp, updatedAt: stamp, exercise: { ...content, name: 'Private archived entry' } },
  ] }
  const workout = state.workouts[0]
  workout.exercises[0].libraryOrigin = { version: 1, entryId: 'personal-entry', revision: 1 }
  state.planHistory = [{ id: 'prior-plan', savedAt: stamp, label: 'Synthetic prior plan', workouts: structuredClone(state.workouts) }]
  state.logs = [{ id: 'prior-log', workoutId: workout.id, title: 'Synthetic history', startedAt: stamp, completedAt: '2026-10-15T09:10:00.000Z', duration: 10, calories: 0,
    completedExerciseIds: [workout.exercises[0].id], sets: [{ id: 'completed-row', exerciseId: workout.exercises[0].id, setNumber: 1, reps: 8, weightKg: null, seconds: null, rpe: null, warmup: false, completed: true }], exerciseSnapshots: workout.exercises.map(({ id, name, category, libraryOrigin }) => ({ id, name, category, libraryOrigin })) }]
  return state
}
const malformed = [
  s => { s.exerciseLibrary = null },
  s => { s.exerciseLibrary.version = 2 },
  s => { s.exerciseLibrary.extra = true },
  s => { s.exerciseLibrary.entries[0].revision = 0 },
  s => { s.exerciseLibrary.entries[0].revision = Number.MAX_SAFE_INTEGER + 1 },
  s => { s.exerciseLibrary.entries[0].revision = 1.5 },
  s => { s.exerciseLibrary.entries[0].status = 'deleted' },
  s => { s.exerciseLibrary.entries[0].id = s.workouts[0].id },
  s => { s.exerciseLibrary.entries[0].id = s.weightHistory[0].id },
  s => { s.exerciseLibrary.entries[0].id = s.logs[0].id },
  s => { s.exerciseLibrary.entries[0].id = s.exerciseLibrary.entries[1].id },
  s => { s.exerciseLibrary.entries[0].createdAt = '2026-02-30T09:00:00.000Z' },
  s => { s.exerciseLibrary.entries[0].updatedAt = '2026-10-14T09:00:00.000Z' },
  s => { s.exerciseLibrary.entries[0].updatedAt = '2026-10-15T09:00:00Z' },
  s => { s.exerciseLibrary.entries[0].exercise.id = 'nested-id' },
  s => { s.exerciseLibrary.entries[0].exercise.libraryOrigin = { version: 1, entryId: 'private', revision: 1 } },
  s => { s.exerciseLibrary.entries[0].exercise.notes = 'x'.repeat(1001) },
  s => { s.exerciseLibrary.entries[0].exercise.equipment = ['unknown'] },
  s => { s.workouts[0].exercises[0].libraryOrigin.revision = 0 },
  s => { s.workouts[0].exercises[0].libraryOrigin.currentName = 'forbidden authority' },
  s => { s.planHistory[0].workouts[0].exercises[0].libraryOrigin = null },
  s => { s.logs[0].exerciseSnapshots[0].libraryOrigin.version = 2 },
  s => { s.profile.libraryOrigin = { version: 1, entryId: 'personal-entry', revision: 1 } },
  s => { s.workouts[0].exerciseLibrary = s.exerciseLibrary },
  s => { s.version = 3 },
  s => { s.version = 2 },
]

test('private library and historical origin-only snapshots remain exact without live referential authority', () => {
  const state = libraryState(), before = structuredClone(state)
  assert.deepEqual(validateState(state), before); assert.deepEqual(state, before)
  delete state.exerciseLibrary
  assert.deepEqual(validateState(state), state)
  state.workouts[0].exercises[0].libraryOrigin.entryId = 'orphaned-historical-source'
  assert.deepEqual(validateState(state), state)
})

test('server shared schema rejects malformed library metadata without changing input', () => {
  for (const mutate of malformed) {
    const state = libraryState(); mutate(state); const before = structuredClone(state)
    assert.throws(() => validateState(state), String(mutate)); assert.deepEqual(state, before)
  }
})

test('invalid library uploads preserve the preceding revision and archived entries', async t => {
  const f = setup(); t.after(f.close)
  const owner = f.seed('library-owner@example.test', true), state = libraryState()
  assert.equal((await f.request('PUT', '/sync', syncBody(state), owner)).status, 200)
  for (const mutate of malformed) {
    const invalid = structuredClone(state); mutate(invalid)
    const reply = await f.request('PUT', '/sync', syncBody(invalid, 1), owner)
    assert.equal(reply.status, 400, String(mutate)); assert.equal(reply.body.error.code, 'invalid_state')
  }
  const saved = await f.request('GET', '/sync', undefined, owner)
  assert.equal(saved.body.revision, 1); assert.deepEqual(saved.body.state, state)
})

test('own export includes the complete library while another account receives no copy', async t => {
  const f = setup(); t.after(f.close)
  const owner = f.seed('library-export@example.test', true), other = f.seed('library-unrelated@example.test', true), state = libraryState()
  assert.equal((await f.request('PUT', '/sync', syncBody(state), owner)).status, 200)
  const exported = await f.request('POST', '/account/export', { password: PASSWORD }, owner)
  assert.equal(exported.status, 200); assert.deepEqual(exported.body.sync.state, state)
  const unrelated = await f.request('GET', '/sync', undefined, other)
  assert.equal(unrelated.body.state, null); assert.equal(unrelated.body.revision, 0)
  assert.equal((await f.request('PUT', '/consent', { healthSync: false, policyVersion: POLICY_VERSION }, owner)).status, 200)
  assert.equal((await f.request('GET', '/sync', undefined, owner)).status, 403)
  const revokedExport = await f.request('POST', '/account/export', { password: PASSWORD }, owner)
  assert.equal(revokedExport.body.sync.state, null)
})

test('library records and ancestry never widen coach fields or create challenge activity', () => {
  const state = libraryState(), plain = structuredClone(state)
  delete plain.exerciseLibrary
  delete plain.workouts[0].exercises[0].libraryOrigin
  delete plain.planHistory[0].workouts[0].exercises[0].libraryOrigin
  delete plain.logs[0].exerciseSnapshots[0].libraryOrigin
  const scopes = ['training', 'body', 'nutrition'], projection = projectSnapshot(validateState(state), scopes)
  assert.deepEqual(projection, projectSnapshot(validateState(plain), scopes))
  assert.ok(!/exerciseLibrary|libraryOrigin|personal-entry|archived-entry|Private library-only/.test(JSON.stringify(projection)))
  const count = s => recordedTrainingDays(validateState(s), '2026-10-01', '2026-10-31', Date.parse('2026-10-15T12:00:00Z'))
  assert.equal(count(state), count(plain)); assert.equal(count(state), 1); assert.equal(count({ ...state, logs: [] }), 0)
})
