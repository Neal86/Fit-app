// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, STORAGE_KEY } from './storage'
import { readPlanDraft } from './planDraft'
import { unknownCalories } from './calorieEstimates'
import { startSession } from './session'
import type { AppState, CalorieEstimate, WorkoutLog } from './types'

const now = Date.parse('2026-10-15T12:00:00Z')
const open = (path = '/') => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)
const setup = (calories: CalorieEstimate = 420) => {
  const state = freshState(); state.profile.onboardingComplete = true; state.workouts[0].calories = calories
  return state
}
const write = (state: AppState) => localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
const saved = (): AppState => JSON.parse(localStorage.getItem(STORAGE_KEY)!)
const calorieInput = () => screen.getByLabelText('Estimated calories (kcal, optional)')
const enterCalories = (value: string) => fireEvent.change(calorieInput(), { target: { value } })
const save = () => fireEvent.click(screen.getByRole('button', { name: /Save workout plan/ }))
const log = (id: string, calories: CalorieEstimate): WorkoutLog => ({ id, workoutId: 'upper-power', title: id, startedAt: '2026-10-15T10:00:00Z', completedAt: '2026-10-15T10:05:00Z', duration: 5, calories, completedExerciseIds: [] })
const stat = () => screen.getByText('Estimated calories').parentElement!
const summary = () => screen.getByText(/completed working sets · Workout calories:/)

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(now)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('explicit optional plan calorie estimates', () => {
  it('saves a cleared numeric estimate as exact unknown and reloads it without treating it as zero', () => {
    write(setup()); open('/plan')
    expect(calorieInput()).not.toBeRequired()
    expect(calorieInput()).toHaveAttribute('step', 'any')
    expect(calorieInput()).toHaveAccessibleDescription(/Blank is saved as unknown, not 0/)
    enterCalories('')
    expect(readPlanDraft()?.calories).toEqual({ version: 1, status: 'unknown' })
    save()
    expect(saved().workouts[0].calories).toEqual({ version: 1, status: 'unknown' })
    expect(saved().planHistory[0].workouts[0].calories).toBe(420)
    expect(readPlanDraft()).toBeNull()
    cleanup(); open('/plan')
    expect(calorieInput()).toHaveValue(null)
    expect(document.body.textContent).not.toMatch(/NaN|\[object Object\]/)
  })
  it('moves from unknown to explicit zero, back to unknown, then to an exact decimal', () => {
    write(setup(unknownCalories())); open('/plan')
    enterCalories('0'); save()
    expect(saved().workouts[0].calories).toBe(0)
    expect(calorieInput()).toHaveValue(0)
    enterCalories(''); save()
    expect(saved().workouts[0].calories).toEqual(unknownCalories())
    enterCalories('123.456789012345'); save()
    expect(saved().workouts[0].calories).toBe(123.456789012345)
    cleanup(); open('/plan')
    expect(calorieInput()).toHaveValue(123.456789012345)
  })
  it.each([0, 0.00000000001, 420.1234567891234])('keeps untouched numeric %s exact when other plan fields change', calories => {
    const state = setup(calories)
    state.activeSession = startSession(state.workouts[0], now)
    state.logs = [log('Historical numeric estimate', 98.123456789)]
    write(state); open('/plan')
    expect(calorieInput()).toHaveValue(calories)
    fireEvent.change(screen.getAllByLabelText('Exercise name')[0], { target: { value: 'Edited movement' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add exercise' }))
    save()
    expect(saved().workouts[0].calories).toBe(calories)
    expect(saved().planHistory[0].workouts[0].calories).toBe(calories)
    expect(saved().activeSession).toEqual(state.activeSession)
    expect(saved().logs).toEqual(state.logs)
  })
  it('keeps unknown across exercise edits and previous-version restoration', () => {
    write(setup(unknownCalories())); open('/plan')
    fireEvent.change(screen.getAllByLabelText('Exercise name')[0], { target: { value: 'Changed exercise' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add exercise' })); save()
    expect(saved().workouts[0].calories).toEqual(unknownCalories())
    enterCalories('12.5'); save()
    fireEvent.click(screen.getByText(/Previous plan versions/))
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore version' })[0])
    expect(saved().workouts[0].calories).toEqual(unknownCalories())
    expect(calorieInput()).toHaveValue(null)
  })
  it('recovers the exact unknown draft across navigation and reload and respects declined recovery', () => {
    write(setup()); open('/plan'); enterCalories('')
    fireEvent.click(screen.getAllByRole('link', { name: 'Home' })[0])
    fireEvent.click(screen.getAllByRole('link', { name: 'Plan' })[0])
    expect(calorieInput()).toHaveValue(null)
    cleanup(); open('/plan')
    expect(calorieInput()).toHaveValue(null)
    vi.mocked(window.confirm).mockReturnValue(false); save()
    expect(saved().workouts[0].calories).toBe(420)
    expect(readPlanDraft()?.calories).toEqual(unknownCalories())
    vi.mocked(window.confirm).mockReturnValue(true); save()
    expect(saved().workouts[0].calories).toEqual(unknownCalories())
  })
  it('retains unknown drafts when storage fails and saves only after a successful retry', () => {
    write(setup()); open('/plan'); enterCalories('')
    const original = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) throw new Error('Synthetic storage full')
      original.call(this, key, value)
    })
    save()
    expect(screen.getByText('Workout was not saved. Your draft is kept; check the fields and retry when storage is available.')).toBeInTheDocument()
    expect(saved().workouts[0].calories).toBe(420)
    expect(readPlanDraft()?.calories).toEqual(unknownCalories())
    expect(calorieInput()).toHaveValue(null)
    failure.mockRestore(); save()
    expect(saved().workouts[0].calories).toEqual(unknownCalories())
  })
  it('rejects stale-tab saves without replacing the newer estimate or losing the unknown draft', () => {
    write(setup()); open('/plan'); enterCalories('')
    const newer = setup(75.25); write(newer); save()
    expect(saved().workouts[0].calories).toBe(75.25)
    expect(calorieInput()).toHaveValue(null)
    expect(readPlanDraft()?.calories).toEqual(unknownCalories())
    expect(screen.getAllByRole('alert').map(node => node.textContent).join(' ')).toMatch(/another tab|changed|newer/i)
    cleanup(); open('/plan'); save()
    expect(saved().workouts[0].calories).toEqual(unknownCalories())
    expect(saved().planHistory[0].workouts[0].calories).toBe(75.25)
  })
  it('retains the blank draft when switching plans is cancelled and loads exact numeric values when confirmed', () => {
    const state = setup(); state.workouts[1].calories = 50.123456789; write(state); open('/plan'); enterCalories('')
    vi.mocked(window.confirm).mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday: Lower Body Strength' }))
    expect(calorieInput()).toHaveValue(null)
    expect(readPlanDraft()?.calories).toEqual(unknownCalories())
    vi.mocked(window.confirm).mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday: Lower Body Strength' }))
    expect(calorieInput()).toHaveValue(50.123456789)
    expect(readPlanDraft()).toBeNull()
  })
})

describe('unknown, partial and numeric calorie readouts', () => {
  it.each([
    { values: [] as CalorieEstimate[], value: 'No sessions', detail: 'No workout calorie estimates to total' },
    { values: [unknownCalories(), unknownCalories()], value: 'Unavailable', detail: '2 sessions without calorie estimates' },
    { values: [unknownCalories(), 0, 12.5], value: '12.5 estimated kcal known subtotal', detail: '1 session without calorie estimates; total unavailable' },
    { values: [0], value: '0 estimated kcal', detail: '1 session with calorie estimates' },
  ])('renders dashboard and progress totals distinctly for $value', ({ values, value, detail }) => {
    const state = setup(unknownCalories()); state.logs = values.map((value, index) => log(`Log ${index}`, value)); write(state); open()
    expect(stat()).toHaveTextContent(value); expect(stat()).toHaveTextContent(detail)
    expect(document.body.textContent).not.toMatch(/NaN|\[object Object\]/)
    fireEvent.click(screen.getAllByRole('link', { name: 'Progress' })[0])
    expect(summary()).toHaveTextContent(`Workout calories: ${value}. ${detail}.`)
    expect(document.body.textContent).not.toMatch(/NaN|\[object Object\]/)
  })
  it('shows unavailable estimates on the recommendation and workout cards while zero stays a numeric estimate', () => {
    const state = setup(unknownCalories()); state.workouts[1].calories = 0; write(state); open()
    expect(screen.getAllByText('Calorie estimate unavailable')).toHaveLength(2)
    expect(screen.getByText('0 estimated kcal')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('link', { name: 'Workouts' })[0])
    expect(screen.getByRole('link', { name: /Upper Body Power/ })).toHaveTextContent('Calorie estimate unavailable')
    expect(screen.getByRole('link', { name: /Lower Body Strength/ })).toHaveTextContent('0 estimated kcal')
  })
  it('displays only historical calories, and recomputes partial summaries when history filters change', () => {
    const state = setup(999)
    state.logs = [log('Unknown historical session', unknownCalories()), log('Zero historical session', 0), log('Decimal historical session', 42.123456789)]
    write(state); open('/progress')
    expect(screen.getByRole('heading', { name: 'Unknown historical session' }).closest('li')).toHaveTextContent('Calorie estimate unavailable')
    expect(screen.getByRole('heading', { name: 'Zero historical session' }).closest('li')).toHaveTextContent('0 estimated kcal')
    expect(screen.getByRole('heading', { name: 'Decimal historical session' }).closest('li')).toHaveTextContent('42.123456789 estimated kcal')
    expect(summary()).toHaveTextContent('42.123456789 estimated kcal known subtotal')
    fireEvent.change(screen.getByLabelText('Search workout history'), { target: { value: 'Unknown historical' } })
    expect(summary()).toHaveTextContent('Workout calories: Unavailable. 1 session without calorie estimates.')
    fireEvent.change(screen.getByLabelText('Search workout history'), { target: { value: 'Zero historical' } })
    expect(summary()).toHaveTextContent('Workout calories: 0 estimated kcal.')
    fireEvent.change(screen.getByLabelText('Search workout history'), { target: { value: 'No matching session' } })
    expect(summary()).toHaveTextContent('Workout calories: No sessions.')
    expect(saved().logs).toEqual(state.logs)
  })
  it('retains unavailable session calories across start, pause, reload and partial completion despite later plan edits', () => {
    const state = setup(unknownCalories()); write(state); open('/workouts/upper-power')
    expect(screen.getByText(/Saved plan estimate:/)).toHaveTextContent('Calorie estimate unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Start workout' }))
    fireEvent.change(screen.getByLabelText('Bench Press set 1 reps'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Complete Bench Press set 1' }))
    act(() => vi.advanceTimersByTime(30000))
    fireEvent.click(screen.getByRole('button', { name: 'Pause timer' }))
    expect(saved().activeSession?.workout.calories).toEqual(unknownCalories())
    cleanup()
    const changed = saved(); changed.workouts[0].calories = 500; write(changed)
    open('/workouts/upper-power')
    expect(screen.getByText(/Saved plan estimate:/)).toHaveTextContent('Calorie estimate unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    expect(screen.queryAllByRole('alert').map(node => node.textContent)).toEqual([])
    expect(saved().logs[0].calories).toEqual(unknownCalories())
    expect(saved().workouts[0].calories).toBe(500)
    expect(summary()).toHaveTextContent('Workout calories: Unavailable.')
    expect(within(screen.getByRole('heading', { name: 'Upper Body Power' }).closest('li')!).getByText(/Calorie estimate unavailable/)).toBeInTheDocument()
  })
  it('shows previous-plan estimates from their own historical snapshots', () => {
    const state = setup(400)
    state.planHistory = [
      { id: 'unknown-plan', label: 'Unknown snapshot', savedAt: new Date(now).toISOString(), workouts: [{ ...state.workouts[0], calories: unknownCalories() }] },
      { id: 'zero-plan', label: 'Zero snapshot', savedAt: new Date(now).toISOString(), workouts: [{ ...state.workouts[0], calories: 0 }] },
    ]
    write(state); open('/plan')
    expect(screen.getByText('Unknown snapshot').closest('li')).toHaveTextContent('Calorie estimate unavailable')
    expect(screen.getByText('Zero snapshot').closest('li')).toHaveTextContent('0 estimated kcal')
    expect(saved().planHistory).toEqual(state.planHistory)
  })
})
