// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, parseBackup, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import { KG_PER_LB } from './units'
import type { AppState } from './types'

const open = (path = '/workouts/upper-power') => render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>)
const saved = (): AppState => parseBackup(localStorage.getItem(STORAGE_KEY)!)
const setup = () => {
  const state = freshState(); state.profile.onboardingComplete = true; state.profile.unit = 'imperial'
  state.activeSession = startSession(state.workouts[0]); state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 100
  state.activeSession.sets[1] = { ...state.activeSession.sets[1], weightKg: 99.123456789, reps: 7, completed: true }
  const previous = structuredClone(state.activeSession); previous.id = 'previous-session'; previous.sets[1].weightKg = 75.123456789
  state.logs = [finishSession(previous)]
  state.planHistory = [{ id: 'previous-plan', savedAt: new Date().toISOString(), label: 'Previous plan', workouts: structuredClone(state.workouts) }]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state
}
const review = () => { fireEvent.click(screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' })); fireEvent.click(screen.getByRole('button', { name: 'Choose Front Plank' })) }
const apply = () => fireEvent.click(screen.getByRole('button', { name: /Confirm replacement and reset/ }))
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('persisted session replacement', () => {
  it('reloads mixed completed/new exercise identities and saves timed data without changing previous logs or plans', () => {
    const original = setup(); open(); review(); apply()
    const replaced = saved(); expect(replaced.workouts).toEqual(original.workouts); expect(replaced.planHistory).toEqual(original.planHistory); expect(replaced.logs).toEqual(original.logs)
    expect(replaced.activeSession!.sets.find(set => set.id === original.activeSession!.sets[1].id)).toEqual(original.activeSession!.sets[1])
    cleanup(); open()
    expect(screen.getByLabelText('Bench Press set 2 reps')).toHaveValue(7)
    expect(screen.queryByLabelText('Bench Press set 1 reps')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Front Plank set 1 seconds')).toHaveValue(null)
    fireEvent.change(screen.getByLabelText('Front Plank set 1 seconds'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('Front Plank set 1 weight'), { target: { value: '12.25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Complete Front Plank set 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    const finished = saved(); expect(finished.activeSession).toBeNull(); expect(finished.logs).toHaveLength(2); expect(finished.logs[1]).toEqual(original.logs[0])
    const replacement = replaced.activeSession!.workout.exercises[1]
    expect(finished.logs[0].sets!.find(set => set.exerciseId === replacement.id && set.setNumber === 1)).toMatchObject({ reps: null, seconds: 30, weightKg: 12.25 * KG_PER_LB, completed: true })
    expect(finished.logs[0].exerciseSnapshots).toContainEqual({ id: replacement.id, name: 'Front Plank', category: 'Core' })
    expect(finished.workouts).toEqual(original.workouts); expect(finished.planHistory).toEqual(original.planHistory)
  })
  it('retains actual storage/source and pending load text on quota failure, then retries safely', () => {
    const original = setup(); open()
    fireEvent.change(screen.getByLabelText('Bench Press set 1 weight'), { target: { value: '.' } })
    fireEvent.change(screen.getByLabelText('Barbell Row set 1 weight'), { target: { value: '89.' } })
    review()
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    apply(); expect(saved()).toEqual(original); expect(screen.getByLabelText('Bench Press set 1 weight')).toHaveValue('.')
    expect(screen.getByRole('button', { name: /Confirm replacement/ })).toBeEnabled()
    failure.mockRestore(); apply()
    expect(screen.getByLabelText('Barbell Row set 1 weight')).toHaveValue('89.')
    const snapshot = saved(); cleanup(); open(); expect(saved()).toEqual(snapshot)
    expect(screen.getByLabelText('Front Plank set 1 weight')).toHaveValue('')
  })
  it('imports a replacement backup without reviving the previous review or losing mixed exercise snapshots', async () => {
    setup(); const view = open(); review(); apply(); const backup = saved()
    // An old, unconfirmed review must be gone after navigation/import, even with the same session ID.
    fireEvent.click(screen.getByRole('button', { name: 'Replace unfinished Front Plank sets' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Back Squat' }))
    fireEvent.click(screen.getAllByRole('link', { name: 'Profile' })[0])
    const file = new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(JSON.stringify(backup)) })
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText('Backup imported')).toBeInTheDocument())
    cleanup(); open()
    expect(screen.queryByRole('region', { name: 'Session exercise replacement' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Front Plank set 1 seconds')).toHaveValue(null)
    expect(screen.getByLabelText('Bench Press set 2 reps')).toHaveValue(7)
    expect(saved()).toEqual(backup)
  })
})
