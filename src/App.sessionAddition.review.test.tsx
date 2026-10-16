// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, parseBackup, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import type { AppState } from './types'

const setup = () => {
  const state = freshState(); state.profile.onboardingComplete = true; state.profile.unit = 'imperial'
  state.activeSession = startSession(state.workouts[0]); state.activeSession.runningSince = null
  state.activeSession.elapsedSeconds = 124.123; state.activeSession.restUntil = Date.now() + 60000
  state.activeSession.sets[1] = { ...state.activeSession.sets[1], completed: true, reps: 8, weightKg: 29.123456789, rpe: 7.5, warmup: true }
  const prior = structuredClone(state.activeSession); prior.id = 'historical-session'
  state.logs = [finishSession(prior)]; state.planHistory = [{ id: 'prior-plan', savedAt: prior.startedAt, label: 'Prior', workouts: structuredClone(state.workouts) }]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state
}
const saved = (): AppState => parseBackup(localStorage.getItem(STORAGE_KEY)!)
const mount = () => render(<MemoryRouter initialEntries={['/workouts/upper-power']}><App /></MemoryRouter>)
const region = () => screen.getByRole('region', { name: 'Session exercise addition' })
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Add exercise to this session' }))
const select = (name = 'Front Plank') => { open(); fireEvent.click(screen.getByRole('button', { name: `Use ${name}` })) }
const review = () => fireEvent.click(screen.getByRole('button', { name: 'Review session addition' }))
const confirm = () => fireEvent.click(screen.getByRole('button', { name: /Confirm addition of/ }))
const weight = (exercise = 'Bench Press', set = 1) => screen.getByLabelText(`${exercise} set ${set} weight`)
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const retained = (element: HTMLElement, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('independent real App session addition persistence', () => {
  it('keeps exact old rows and raw load text on storage failure, retries once, then reloads only the active addition', () => {
    const original = setup(); mount()
    fireEvent.change(weight(), { target: { value: '.' } })
    fireEvent.blur(weight())
    fireEvent.change(weight('Barbell Row'), { target: { value: '0079.50' } })
    select(); review()
    const before = localStorage.getItem(STORAGE_KEY)
    const oldConfirm = retained(screen.getByRole('button', { name: /Confirm addition of/ }), 'onClick')
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })
    confirm()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before); expect(saved()).toEqual(original)
    expect(weight()).toHaveValue('.'); expect(weight('Barbell Row')).toHaveValue('0079.50')
    expect(within(region()).getByRole('alert')).toHaveTextContent('not saved')
    expect(screen.getByRole('button', { name: /Confirm addition of/ })).toBeEnabled()
    failure.mockRestore(); const retry = retained(screen.getByRole('button', { name: /Confirm addition of/ }), 'onClick')
    act(() => { retry(); retry(); oldConfirm() })
    const next = saved()
    expect(next.activeSession!.workout.exercises).toHaveLength(original.activeSession!.workout.exercises.length + 1)
    expect(next.activeSession!.sets.slice(0, original.activeSession!.sets.length)).toEqual(original.activeSession!.sets)
    expect(next.activeSession!.restUntil).toBe(original.activeSession!.restUntil); expect(next.activeSession!.elapsedSeconds).toBe(original.activeSession!.elapsedSeconds)
    expect(next.workouts).toEqual(original.workouts); expect(next.logs).toEqual(original.logs); expect(next.planHistory).toEqual(original.planHistory)
    expect(weight()).toHaveValue('.'); expect(weight('Barbell Row')).toHaveValue('0079.50')
    expect(screen.queryByRole('region', { name: 'Session exercise addition' })).not.toBeInTheDocument()
    cleanup(); mount()
    expect(saved()).toEqual(next); expect(screen.getByLabelText('Front Plank set 1 seconds')).toHaveValue(null)
    expect(weight('Front Plank')).toHaveValue(''); expect(screen.getByLabelText('Bench Press set 2 reps')).toHaveValue(8)
  })
  it('preserves an external saved snapshot and raw inputs on stale-tab conflict, including a retry', () => {
    setup(); mount(); fireEvent.change(weight(), { target: { value: '.' } }); select(); review()
    const external = saved(); external.activeSession!.notes = 'Written in another tab after this review'
    const externalRaw = JSON.stringify(external); localStorage.setItem(STORAGE_KEY, externalRaw)
    confirm()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(externalRaw); expect(weight()).toHaveValue('.')
    expect(screen.getByRole('button', { name: /Confirm addition of/ })).toBeEnabled()
    confirm()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(externalRaw); expect(weight()).toHaveValue('.')
    expect(within(region()).getByRole('alert')).toHaveTextContent('not saved')
    cleanup(); mount(); expect(saved()).toEqual(external)
    expect(screen.queryByLabelText('Front Plank set 1 seconds')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Session notes')).toHaveValue(external.activeSession!.notes)
  })
  it('retains valid blur-save and invalid raw text before adding without overwriting either canonical value', () => {
    const original = setup(); mount()
    fireEvent.change(weight(), { target: { value: '.' } }); fireEvent.blur(weight())
    fireEvent.change(weight('Barbell Row'), { target: { value: '12.25' } }); fireEvent.blur(weight('Barbell Row'))
    const prior = saved(); const rowId = original.activeSession!.sets.find(row => row.exerciseId === original.activeSession!.workout.exercises.find(exercise => exercise.name === 'Barbell Row')!.id)!.id
    expect(prior.activeSession!.sets.find(row => row.id === rowId)!.weightKg).toBeCloseTo(5.5565065325, 9)
    select(); review(); confirm()
    expect(weight()).toHaveValue('.')
    expect(saved().activeSession!.sets.slice(0, original.activeSession!.sets.length)).toEqual(prior.activeSession!.sets)
  })
  it('renders distinguishable duplicate movement controls without copying historic load references', () => {
    const original = setup(); mount(); select('Bench Press'); review(); confirm()
    const next = saved(); const index = next.activeSession!.workout.exercises.length
    const newPanel = screen.getByRole('article', { name: `Bench Press (exercise ${index})` })
    const oldPanel = screen.getByRole('article', { name: 'Bench Press (exercise 1)' })
    expect(within(newPanel).queryByText(/Last:/)).not.toBeInTheDocument()
    expect(within(oldPanel).getAllByText(/Last:/).length).toBeGreaterThan(0)
    expect(screen.getByLabelText(`Bench Press (exercise ${index}) set 1 weight`)).toHaveValue('')
    expect(next.activeSession!.workout.exercises.at(-1)!.id).not.toBe(original.activeSession!.workout.exercises[0].id)
    expect(next.activeSession!.sets.slice(0, original.activeSession!.sets.length)).toEqual(original.activeSession!.sets)
  })
  it('rejects a retained custom submit after changed-and-restored edit even within the same batch', () => {
    setup(); mount(); open(); fireEvent.click(screen.getByRole('button', { name: 'Create custom session exercise' }))
    edit('Session exercise name', 'Manual movement'); edit('Number of sets (1–20)', '2'); edit('Target reps or seconds', '9'); edit('Rest between sets (seconds, 0–900)', '0')
    const form = region().querySelector('form')!; const submit = retained(form, 'onSubmit')
    const name = retained(screen.getByLabelText('Session exercise name'), 'onChange')
    act(() => { name({ target: { value: 'Different' } }); submit({ preventDefault() {} }) })
    expect(screen.queryByRole('button', { name: /Confirm addition of/ })).not.toBeInTheDocument()
    edit('Session exercise name', 'Manual movement'); act(() => submit({ preventDefault() {} }))
    expect(screen.queryByRole('button', { name: /Confirm addition of/ })).not.toBeInTheDocument()
    review(); expect(screen.getByRole('button', { name: 'Confirm addition of 2 sets' })).toBeEnabled()
  })
  it('does not reinterpret empty listed equipment as no equipment on review', () => {
    setup(); mount(); select()
    edit('Session exercise equipment requirements', 'listed'); review()
    expect(screen.queryByRole('button', { name: /Confirm addition of/ })).not.toBeInTheDocument()
    expect(within(region()).getAllByRole('alert').some(alert => /at least one equipment/.test(alert.textContent ?? ''))).toBe(true)
    edit('Session exercise equipment requirements', 'none'); review(); expect(within(region()).getByText('Equipment: No equipment')).toBeInTheDocument()
    confirm(); expect(saved().activeSession!.workout.exercises.at(-1)!.equipment).toEqual([])
  })
  it('keeps unknown requirements unknown and presents the exact chosen custom target before append', () => {
    setup(); mount(); open(); fireEvent.click(screen.getByRole('button', { name: 'Create custom session exercise' }))
    edit('Session exercise name', 'Own timer'); edit('Number of sets (1–20)', '1'); edit('Target reps or seconds', '17 sec'); edit('Rest between sets (seconds, 0–900)', '0'); edit('Exercise notes', 'Own note')
    review(); expect(within(region()).getByText('17 sec')).toBeInTheDocument(); expect(within(region()).getByText('Equipment: Equipment not specified')).toBeInTheDocument()
    confirm(); const addition = saved().activeSession!.workout.exercises.at(-1)!
    expect(addition).toMatchObject({ name: 'Own timer', sets: 1, reps: '17 sec', restSeconds: 0, notes: 'Own note' }); expect(addition.equipment).toBeUndefined()
    expect(screen.getByLabelText('Own timer set 1 seconds')).toHaveValue(null)
  })
})
