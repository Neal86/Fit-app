import { describe, expect, it } from 'vitest'
import { restorePlanRevision, savePlanRevision, schedulePreview } from './planning'
import { freshState, parseState } from './storage'
import { startSession } from './session'

describe('versioned personal schedules', () => {
  it('retains immutable old plans and leaves active sessions and history intact', () => {
    const state = freshState(); state.activeSession = startSession(state.workouts[0])
    const nextWorkouts = structuredClone(state.workouts); nextWorkouts[0].title = 'Edited'
    const next = savePlanRevision(state, nextWorkouts, 'Before editing')
    expect(next.planHistory?.[0].workouts[0].title).toBe('Upper Body Power')
    expect(next.activeSession?.workout.title).toBe('Upper Body Power')
    nextWorkouts[0].title = 'Mutated'
    expect(next.workouts[0].title).toBe('Edited')
    expect(parseState(next).planHistory).toEqual(next.planHistory)
  })
  it('does not grow history for unchanged plans and retains only the latest 20 versions', () => {
    let state = freshState()
    expect(savePlanRevision(state, state.workouts, 'No change')).toBe(state)
    for (let i = 0; i < 25; i++) state = savePlanRevision(state, state.workouts.map((workout, index) => index ? workout : { ...workout, title: `Plan ${i}` }), `Change ${i}`)
    expect(state.planHistory).toHaveLength(20)
    expect(state.planHistory?.[0].label).toBe('Change 24')
    expect(state.planHistory?.[19].label).toBe('Change 5')
  })
  it('restores a version reversibly and rejects stale revision identities', () => {
    const state = freshState(); const changed = savePlanRevision(state, [{ ...state.workouts[0], title: 'New plan' }], 'Original')
    const restored = restorePlanRevision(changed, changed.planHistory![0].id)
    expect(restored.workouts).toEqual(state.workouts)
    expect(restored.planHistory?.[0].workouts[0].title).toBe('New plan')
    expect(() => restorePlanRevision(restored, 'missing')).toThrow('no longer available')
  })
  it('honors time limits without silently shortening workout contents', () => {
    const workouts = freshState().workouts
    expect(() => schedulePreview(workouts, [{ day: 'Monday', workoutId: workouts[0].id }], 20)).toThrow('exceeds')
    const schedule = schedulePreview(workouts, [{ day: 'Friday', workoutId: workouts[0].id }, { day: 'Monday', workoutId: workouts[1].id }], 60)
    expect(schedule.map(workout => workout.day)).toEqual(['Monday', 'Friday'])
    expect(schedule[1].exercises).toEqual(workouts[0].exercises)
    expect(workouts[0].day).toBe('Monday')
  })
  it('creates unique identities when a template is repeated on multiple days', () => {
    const workouts = freshState().workouts
    const schedule = schedulePreview(workouts, [{ day: 'Monday', workoutId: workouts[0].id }, { day: 'Thursday', workoutId: workouts[0].id }], 60)
    expect(schedule[0].id).not.toBe(schedule[1].id)
    expect(schedule[0].exercises[0].id).not.toBe(schedule[1].exercises[0].id)
    expect(parseState({ ...freshState(), workouts: schedule }).workouts).toHaveLength(2)
  })
  it('rejects empty, duplicate-day, missing-workout and invalid-time inputs', () => {
    const workouts = freshState().workouts
    expect(() => schedulePreview(workouts, [], 60)).toThrow()
    expect(() => schedulePreview(workouts, [{ day: 'Monday', workoutId: 'missing' }], 60)).toThrow()
    expect(() => schedulePreview(workouts, [{ day: 'No day', workoutId: workouts[0].id }], 60)).toThrow()
    expect(() => schedulePreview(workouts, [{ day: 'Monday', workoutId: workouts[0].id }, { day: 'Monday', workoutId: workouts[1].id }], 60)).toThrow()
    expect(() => schedulePreview(workouts, [{ day: 'Monday', workoutId: workouts[0].id }], NaN)).toThrow()
  })
})
