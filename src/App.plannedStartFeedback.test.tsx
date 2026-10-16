// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, STORAGE_KEY } from './storage'
import { applyPlannedGrouping, reviewPlannedGrouping } from './plannedGrouping'

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('grouped Start failure feedback', { timeout: 30000 }, () => {
  it('announces one global storage error, associates local retry guidance with Start, and recovers on explicit retry', () => {
    const state = freshState(); state.profile.onboardingComplete = true; const workout = state.workouts[0]
    state.workouts[0] = applyPlannedGrouping(workout, reviewPlannedGrouping(workout, { name: 'Exact pair', restSeconds: 40, rounds: [[{ exerciseId: workout.exercises[0].id, setNumber: 2 }, { exerciseId: workout.exercises[1].id, setNumber: 3 }]] }), { reserved: state })
    const raw = JSON.stringify(state); localStorage.setItem(STORAGE_KEY, raw)
    render(<MemoryRouter initialEntries={['/workouts/upper-power']}><App /></MemoryRouter>)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    fireEvent.click(screen.getByRole('button', { name: 'Start workout' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Changes were not saved')
    expect(screen.getByRole('button', { name: 'Start workout' })).toHaveAccessibleDescription('Workout was not started. Your saved plan is unchanged; retry when storage is available.')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw); expect(screen.queryByTestId('session-timer')).not.toBeInTheDocument()
    setItem.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Start workout' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByText(/Workout was not started/)).not.toBeInTheDocument(); expect(screen.getByTestId('session-timer')).toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(saved.activeSession.grouping.groups).toHaveLength(1); expect(saved.activeSession.grouping.groups[0].name).toBe('Exact pair'); expect(saved.activeSession.workout.plannedGrouping).toBeUndefined(); expect(saved.workouts).toEqual(state.workouts)
  })
})
