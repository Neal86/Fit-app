import { describe, expect, it } from 'vitest'
import { freshState } from './storage'
import { elapsedSeconds, finishSession, localDate, previousSet, startSession, toggleSession, weekStart } from './session'

const start = Date.parse('2026-10-15T10:00:00Z')
describe('durable workout sessions', () => {
  it('creates independent set rows and a stable workout snapshot', () => {
    const workout = freshState().workouts[0]
    const session = startSession(workout, start)
    expect(session.sets).toHaveLength(workout.exercises.reduce((sum, exercise) => sum + exercise.sets, 0))
    expect(new Set(session.sets.map(set => set.id)).size).toBe(session.sets.length)
    workout.title = 'Edited later'
    expect(session.workout.title).not.toBe('Edited later')
  })
  it('takes a deep equipment snapshot without changing set rows, logged values or past logs', () => {
    const workout = freshState().workouts[0]; workout.exercises[0].equipment = ['barbell', 'bench']
    const session = startSession(workout, start)
    const setRows = structuredClone(session.sets)
    workout.exercises[0].equipment.push('weight-plates')
    expect(session.workout.exercises[0].equipment).toEqual(['barbell', 'bench'])
    expect(session.sets).toEqual(setRows)
    session.sets[0] = { ...session.sets[0], completed: true, reps: 8, weightKg: 22.123456789 }
    const log = finishSession(session, start + 60_000); const historical = structuredClone(log)
    session.workout.exercises[0].equipment!.push('dumbbells')
    expect(log).toEqual(historical)
    expect(log.sets![0].weightKg).toBe(22.123456789)
    expect(log.exerciseSnapshots!.every(exercise => !Object.hasOwn(exercise, 'equipment'))).toBe(true)
  })
  it('uses wall-clock elapsed time across background throttling', () => {
    const session = startSession(freshState().workouts[0], start)
    expect(elapsedSeconds(session, start + 123000)).toBe(123)
  })
  it('excludes paused time and resumes without reset', () => {
    const session = startSession(freshState().workouts[0], start)
    const paused = toggleSession(session, start + 10000)
    expect(elapsedSeconds(paused, start + 90000)).toBe(10)
    const resumed = toggleSession(paused, start + 90000)
    expect(elapsedSeconds(resumed, start + 95000)).toBe(15)
  })
  it('never substitutes planned duration for actual duration', () => {
    const session = startSession(freshState().workouts[0], start)
    session.sets[0] = { ...session.sets[0], completed: true, reps: 8, weightKg: 20 }
    const log = finishSession(session, start + 30000)
    expect(log.durationSeconds).toBe(30)
    expect(log.duration).toBe(0.5)
    expect(log.calories).toBe(4)
    expect(log.completedExerciseIds).toEqual([])
    expect(log.id).toBe(session.id)
    expect(previousSet([log], session.sets[0].exerciseId, 1)?.weightKg).toBe(20)
  })
  it('requires a completed set to save and preserves actual start time', () => {
    const session = startSession(freshState().workouts[0], start)
    expect(() => finishSession(session, start + 30000)).toThrow('Complete at least one set')
    session.sets[0].completed = true
    expect(finishSession(toggleSession(session, start + 10000), start + 60000).startedAt).toBe(new Date(start).toISOString())
  })
  it('cannot go negative when the device clock moves backwards', () => {
    expect(elapsedSeconds(startSession(freshState().workouts[0], start), start - 1000)).toBe(0)
  })
  it('calculates Monday boundaries in the device timezone', () => {
    const date = new Date(2026, 9, 18, 15, 45)
    expect(new Date(weekStart(date)).getDay()).toBe(1)
    expect(new Date(weekStart(date)).getHours()).toBe(0)
    expect(localDate(new Date(2026, 0, 2, 0, 15))).toBe('2026-01-02')
  })
})

it('uses the most recent completion when imported history is not ordered', () => {
  const workout = freshState().workouts[0]
  const old = startSession(workout, Date.parse('2026-10-01T10:00:00Z'))
  old.sets[0].completed = true; old.sets[0].reps = 8; old.sets[0].weightKg = 20
  const recent = startSession(workout, Date.parse('2026-10-15T10:00:00Z'))
  recent.sets[0].completed = true; recent.sets[0].reps = 8; recent.sets[0].weightKg = 25
  const logs = [finishSession(old, Date.parse('2026-10-01T10:01:00Z')), finishSession(recent, Date.parse('2026-10-15T10:01:00Z'))]
  expect(previousSet(logs, workout.exercises[0].id, 1)?.weightKg).toBe(25)
  expect(logs[0].sets?.[0].weightKg).toBe(20)
})
