import { describe, expect, it } from 'vitest'
import { unknownCalories } from './calorieEstimates'
import { freshState, parseState } from './storage'
import { finishSession, startSession, toggleSession } from './session'
import { copyWorkout, prepareWorkoutForSave, restorePlanRevision, savePlanRevision, schedulePreview } from './planning'

const now = Date.parse('2026-10-15T10:00:00.000Z')
describe('unknown estimate completion and independent snapshots', () => {
  it.each([0, 0.25, 1, 30, 1234.75])('finishes %s elapsed seconds with a new exact unknown marker', seconds => {
    const workout = freshState().workouts[0]; workout.calories = unknownCalories()
    const session = startSession(workout, now); session.sets[0].completed = true; session.sets[0].reps = 8
    const before = structuredClone(session); const log = finishSession(session, now + seconds * 1000)
    expect(log.calories).toStrictEqual({ version: 1, status: 'unknown' })
    expect(log.calories).not.toBe(session.workout.calories); expect(session.workout.calories).not.toBe(workout.calories)
    expect(log.durationSeconds).toBe(Math.floor(seconds)); expect(log.id).toBe(session.id)
    expect(session).toStrictEqual(before)
  })
  it.each([0, -0, Number.MIN_VALUE, 0.125, 123.456789012345, 10000])('keeps original completion arithmetic exactly for numeric estimate %s', calories => {
    for (const milliseconds of [0, 250, 1000, 30000, 1000123]) {
      const workout = freshState().workouts[0]; workout.calories = calories
      const session = startSession(workout, now); session.sets[0].completed = true
      const seconds = Math.floor(milliseconds / 1000)
      const expected = Math.round(calories * seconds / (workout.duration * 60))
      const log = finishSession(session, now + milliseconds)
      expect(Object.is(log.calories, expected)).toBe(true)
      expect(log.duration).toBe(Math.round(seconds / 60 * 100) / 100)
    }
  })
  it('retains paused actual duration and requires completion for unknown estimates', () => {
    const workout = freshState().workouts[0]; workout.calories = unknownCalories()
    const session = startSession(workout, now)
    expect(() => finishSession(session, now + 30000)).toThrow('Complete at least one set')
    session.sets[0].completed = true
    const paused = toggleSession(session, now + 10000); const log = finishSession(paused, now + 90000)
    expect(log.durationSeconds).toBe(10); expect(log.calories).toStrictEqual(unknownCalories())
  })
  it('does not change active or completed snapshots when editing, copying, scheduling or restoring plans', () => {
    const state = freshState(); state.workouts[0].calories = unknownCalories()
    state.activeSession = startSession(state.workouts[0], now)
    const prior = startSession(state.workouts[0], now - 60000); prior.sets[0].completed = true
    state.logs = [finishSession(prior, now)]; const before = structuredClone(state)
    const numericDraft = structuredClone(state.workouts[0]); numericDraft.calories = 0.125
    const saved = prepareWorkoutForSave(numericDraft, state.workouts[0])
    const changed = savePlanRevision(state, [saved, ...state.workouts.slice(1)], 'Add manual estimate', new Date(now))
    expect(changed.workouts[0].calories).toBe(0.125)
    expect(changed.planHistory[0].workouts[0].calories).toStrictEqual(unknownCalories())
    expect(changed.activeSession).toBe(state.activeSession); expect(changed.logs).toBe(state.logs)
    const restored = restorePlanRevision(changed, changed.planHistory[0].id)
    expect(restored.workouts[0].calories).toStrictEqual(unknownCalories())
    expect(restored.activeSession).toStrictEqual(before.activeSession); expect(restored.logs).toStrictEqual(before.logs)
    expect(restored.planHistory[0].workouts[0].calories).toBe(0.125)
    expect(restored.workouts[0].calories).not.toBe(restored.planHistory[1].workouts[0].calories)
    const copied = copyWorkout(state.workouts[0]); const scheduled = schedulePreview(state.workouts, [{ day: 'Monday', workoutId: state.workouts[0].id }, { day: 'Wednesday', workoutId: state.workouts[0].id }], 600)
    expect(copied.calories).toStrictEqual(unknownCalories()); expect(copied.calories).not.toBe(state.workouts[0].calories)
    expect(scheduled[0].calories).not.toBe(scheduled[1].calories)
    expect(scheduled.map(workout => workout.calories)).toStrictEqual([unknownCalories(), unknownCalories()])
    expect(parseState(restored)).toStrictEqual(restored); expect(state).toStrictEqual(before)
  })
  it('protects old known history when a saved plan switches to unknown', () => {
    const state = freshState(); state.workouts[0].calories = 123.456789012345
    state.activeSession = startSession(state.workouts[0], now)
    const past = startSession(state.workouts[0], now - 60000); past.sets[0].completed = true
    state.logs = [finishSession(past, now)]; const original = structuredClone(state)
    const workouts = structuredClone(state.workouts); workouts[0].calories = unknownCalories()
    const changed = savePlanRevision(state, workouts, 'Estimate unavailable', new Date(now))
    expect(changed.activeSession).toStrictEqual(original.activeSession); expect(changed.logs).toStrictEqual(original.logs)
    expect(changed.planHistory[0].workouts).toStrictEqual(original.workouts)
    expect(state).toStrictEqual(original)
  })
})
