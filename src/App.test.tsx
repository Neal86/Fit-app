// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, STORAGE_KEY } from './storage'

const open = (path = '/') => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)
const ready = () => { const state = freshState(); state.profile.onboardingComplete = true; localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state }
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('critical user journeys', () => {
  it('onboards with the actual starting weight and persists across reload', () => {
    open()
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '65' } })
    fireEvent.click(screen.getByRole('button', { name: /Start training/ }))
    expect(screen.getByRole('heading', { name: 'Ready, Alex?' })).toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(saved.weightHistory[0].weightKg).toBe(65)
    cleanup(); open()
    expect(screen.getByRole('heading', { name: 'Ready, Alex?' })).toBeInTheDocument()
  })
  it('restores a session after navigation and reload, saves actual time and prevents duplicate save', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z'))
    ready(); open('/workouts/upper-power')
    fireEvent.click(screen.getByRole('button', { name: 'Start workout' }))
    fireEvent.change(screen.getByLabelText('Bench Press set 1 reps'), { target: { value: '8' } })
    fireEvent.change(screen.getByLabelText('Bench Press set 1 weight'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Complete Bench Press set 1' }))
    act(() => vi.advanceTimersByTime(30000))
    expect(screen.getByTestId('session-timer')).toHaveTextContent('00:30')
    cleanup(); open('/workouts/upper-power')
    expect(screen.getByLabelText('Bench Press set 1 weight')).toHaveValue(20)
    expect(screen.getByRole('button', { name: 'Undo Bench Press set 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pause timer' }))
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByTestId('session-timer')).toHaveTextContent('00:30')
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(saved.logs).toHaveLength(1); expect(saved.logs[0].durationSeconds).toBe(30)
    expect(saved.activeSession).toBeNull()
    expect(screen.getByRole('heading', { name: 'Your progress' })).toBeInTheDocument()
  })
  it('keeps saved data untouched on corrupt imports and requires recovery on corrupt local storage', () => {
    localStorage.setItem(STORAGE_KEY, '{broken')
    open()
    expect(screen.getByRole('heading', { name: 'Your saved data needs attention' })).toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{broken')
  })
  it('shows a storage error instead of a false success when quota is exceeded', () => {
    ready(); open('/workouts/upper-power')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    fireEvent.click(screen.getByRole('button', { name: 'Start workout' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Changes were not saved')
    expect(screen.queryByTestId('session-timer')).not.toBeInTheDocument()
  })
  it('edits a workout template without rewriting workout history', () => {
    ready(); open('/plan')
    fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'My custom strength session' } })
    fireEvent.click(screen.getByRole('button', { name: /Save workout plan/ }))
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(saved.workouts[0].title).toBe('My custom strength session')
    expect(saved.logs).toEqual([])
  })
  it('retains unsaved plan edits across navigation and reload', () => {
    ready(); open('/plan')
    fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Unsaved custom title' } })
    fireEvent.click(screen.getAllByRole('link', { name: 'Home' })[0])
    fireEvent.click(screen.getAllByRole('link', { name: 'Plan' })[0])
    expect(screen.getByLabelText('Workout title')).toHaveValue('Unsaved custom title')
    cleanup(); open('/plan')
    expect(screen.getByLabelText('Workout title')).toHaveValue('Unsaved custom title')
  })
  it('assigns a new exercise identity when its name is changed', () => {
    const state = ready(); const oldId = state.workouts[0].exercises[0].id; open('/plan')
    fireEvent.change(screen.getAllByLabelText('Exercise name')[0], { target: { value: 'Different movement' } })
    fireEvent.click(screen.getByRole('button', { name: /Save workout plan/ }))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).workouts[0].exercises[0].id).not.toBe(oldId)
  })
  it('requires confirmation before deleting a saved workout', () => {
    const state = ready()
    state.logs = [{ id: 'one', workoutId: 'upper-power', title: 'Test workout', startedAt: '2026-10-15T10:00:00Z', completedAt: '2026-10-15T10:01:00Z', duration: 1, calories: 10, completedExerciseIds: [] }]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    vi.mocked(window.confirm).mockReturnValue(false)
    open('/progress')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Test workout' }))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).logs).toHaveLength(1)
  })
  it('searches workouts and shows an accessible empty result', () => {
    ready(); open('/workouts')
    fireEvent.change(screen.getByLabelText('Search workouts'), { target: { value: 'nothing matches' } })
    expect(screen.getByText('No workouts found')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).queryByRole('link', { name: /Upper Body Power/ })).not.toBeInTheDocument()
  })
})

describe('integrated nutrition journeys', () => {
  it('persists a water entry across a full app reload', () => {
    ready(); open('/nutrition')
    fireEvent.click(screen.getByRole('button', { name: 'Add water' }))
    fireEvent.change(screen.getByLabelText('Water amount (ml)'), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save water entry' }))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).nutrition.hydration).toHaveLength(1)
    cleanup(); open('/nutrition')
    expect(screen.getByTestId('nutrition-total-water')).toHaveTextContent('250')
  })
  it('keeps an unsaved nutrition form when full-state persistence fails', () => {
    ready(); open('/nutrition')
    fireEvent.click(screen.getByRole('button', { name: 'Add water' }))
    fireEvent.change(screen.getByLabelText('Water amount (ml)'), { target: { value: '300' } })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    fireEvent.click(screen.getByRole('button', { name: 'Save water entry' }))
    expect(screen.getByLabelText('Water amount (ml)')).toHaveValue('300')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).nutrition.hydration).toHaveLength(0)
    expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('not saved'))).toBe(true)
  })
  it('keeps latest-date profile weight after a backdated correction', () => {
    const state = ready(); state.weightHistory = [{ id: 'latest', date: '2026-10-15', weightKg: 70 }]; state.profile.weightKg = 70
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); open('/progress')
    fireEvent.change(screen.getByLabelText('Weight entry date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).profile.weightKg).toBe(70)
  })
})

it('blocks stale tab updates without overwriting newer saved data', () => {
  const state = ready(); open('/profile')
  const other = { ...state, profile: { ...state.profile, name: 'Newer tab' } }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(other))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stale edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
  expect(screen.getByRole('alert')).toHaveTextContent('another browser tab')
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).profile.name).toBe('Newer tab')
})

it('exposes optional account settings without making unconfigured requests', () => {
  ready(); const fetcher = vi.spyOn(globalThis, 'fetch'); open('/profile')
  fireEvent.click(screen.getByRole('link', { name: 'Account & cloud data' }))
  expect(screen.getByRole('heading', { name: 'Local data stays with you' })).toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})

it('restores incomplete nutrition input after route navigation', () => {
  ready(); open('/nutrition')
  fireEvent.click(screen.getByRole('button', { name: 'Add food' }))
  fireEvent.change(screen.getByLabelText('Food name'), { target: { value: 'Unfinished food entry' } })
  fireEvent.click(screen.getAllByRole('link', { name: 'Home' })[0])
  fireEvent.click(screen.getAllByRole('link', { name: 'Nutrition' })[0])
  expect(screen.getByLabelText('Food name')).toHaveValue('Unfinished food entry')
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).nutrition.meals).toHaveLength(0)
})

it('clears both kinds of unsaved draft after a confirmed successful reset', () => {
  ready(); open('/nutrition')
  fireEvent.click(screen.getByRole('button', { name: 'Add food' }))
  fireEvent.change(screen.getByLabelText('Food name'), { target: { value: 'Old draft' } })
  fireEvent.click(screen.getAllByRole('link', { name: 'Plan' })[0])
  fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Old plan draft' } })
  fireEvent.click(screen.getAllByRole('link', { name: 'Profile' })[0])
  fireEvent.click(screen.getByRole('button', { name: 'Reset app' }))
  expect(sessionStorage.getItem('fitflow-nutrition-draft-v1')).toBeNull()
  expect(sessionStorage.getItem('fitflow-plan-draft-v1')).toBeNull()
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).profile.onboardingComplete).toBe(false)
})


it('does not count a future-dated imported workout toward this week', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z'))
  const state = ready()
  state.logs = [{ id: 'future', workoutId: state.workouts[0].id, title: 'Future imported workout', startedAt: '2026-10-16T10:00:00Z', completedAt: '2026-10-16T10:01:00Z', duration: 1, calories: 10, completedExerciseIds: [] }]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); open()
  const sessions = screen.getByText('Sessions').parentElement!
  expect(sessions).toHaveTextContent(`0/${state.profile.weeklyTarget}`)
  expect(screen.getByText('0%')).toBeInTheDocument()
})
