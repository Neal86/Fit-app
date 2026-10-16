// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { unknownCalories } from './calorieEstimates'
import { PLAN_DRAFT_KEY, readPlanDraft, savePlanDraft } from './planDraft'
import { freshState } from './storage'
import { validWorkout } from './stateValidation'

beforeEach(() => sessionStorage.clear())
describe('recoverable unknown-calorie plan drafts', () => {
  it('round trips an exact unknown estimate independently of incomplete form fields', () => {
    const workout = freshState().workouts[0]
    workout.calories = unknownCalories(); workout.title = ''; workout.duration = 0; workout.exercises[0].sets = 0
    savePlanDraft(workout)
    const draft = readPlanDraft()
    expect(draft).toStrictEqual(workout); expect(draft!.calories).not.toBe(workout.calories)
    expect(validWorkout(draft)).toBe(false)
    expect(JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY)!)).toStrictEqual(workout)
  })
  it.each(['workout', 'exercise'])('rejects calorie markers in an unsupported %s field without replacing draft recovery', destination => {
    const workout = freshState().workouts[0]
    Object.assign(destination === 'workout' ? workout : workout.exercises[0], { extra: unknownCalories() })
    const raw = JSON.stringify(workout); sessionStorage.setItem(PLAN_DRAFT_KEY, raw)
    expect(readPlanDraft()).toBeNull(); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(raw)
  })
  it.each([-3, 0, Number.MIN_VALUE, 0.125, 123.456789012345, 10000, 10000000, Number.MAX_VALUE])('preserves finite incomplete numeric calorie draft %s', calories => {
    const workout = freshState().workouts[0]; workout.calories = calories
    savePlanDraft(workout)
    expect(readPlanDraft()!.calories).toBe(calories)
  })
  it.each([null, undefined, '', 'unknown', '0', NaN, Infinity, false, [], {}, { version: 1 }, { status: 'unknown' }, { version: 2, status: 'unknown' }, { version: '1', status: 'unknown' }, { version: 1, status: 'known' }, { version: 1, status: 'unknown', extra: true }])('rejects invalid calorie draft %j and keeps recovery bytes untouched', calories => {
    const raw = JSON.stringify({ ...freshState().workouts[0], calories })
    sessionStorage.setItem(PLAN_DRAFT_KEY, raw)
    expect(readPlanDraft()).toBeNull(); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(raw)
  })
})
