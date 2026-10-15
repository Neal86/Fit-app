// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { PLAN_DRAFT_KEY, readPlanDraft, savePlanDraft } from './planDraft'
import { freshState } from './storage'
import { EQUIPMENT_OPTIONS } from './equipment'

beforeEach(() => sessionStorage.clear())
describe('equipment metadata in recoverable plan drafts', () => {
  it.each([undefined, [], ['bench', 'barbell'], EQUIPMENT_OPTIONS.map(option => option.id)])('round trips valid requirements %j without filling legacy unknown metadata', equipment => {
    const workout = freshState().workouts[0]
    const value = equipment === undefined ? workout : { ...workout, exercises: workout.exercises.map(exercise => ({ ...exercise, equipment })) }
    sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(value))
    expect(readPlanDraft()).toEqual(value)
  })
  it('still permits incomplete form values and preserves equipment through its save path', () => {
    const workout = freshState().workouts[0]
    workout.title = ''; workout.exercises[0].sets = 0; workout.exercises[0].equipment = ['bench']
    savePlanDraft(workout)
    expect(readPlanDraft()).toEqual(workout)
  })
  it.each([null, 'barbell', ['other'], ['bench', 'bench'], [1], [undefined], new Array(1), Array(18).fill('bench')])('rejects malformed equipment %j and leaves the original recovery copy untouched', equipment => {
    const workout = freshState().workouts[0]
    const raw = JSON.stringify({ ...workout, exercises: [{ ...workout.exercises[0], equipment }] })
    sessionStorage.setItem(PLAN_DRAFT_KEY, raw)
    expect(readPlanDraft()).toBeNull()
    expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(raw)
  })
})
