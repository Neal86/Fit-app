// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import WorkoutSession from './WorkoutSession'
import type { UpdateState } from './WorkoutSession'
import { freshState } from '../storage'
import { startSession } from '../session'
import type { AppState } from '../types'

let live: AppState
let revision = 0
let failSave = false
let captureOnly = false
let lastChange: Parameters<UpdateState>[0]
let commitCount = 0
let replaceState: (state: AppState) => void
let beforeChange: (() => void) | null = null
const setup = (completed = true) => {
  const state = freshState(); state.profile.unit = 'imperial'
  state.activeSession = startSession(state.workouts[0]); state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 62; state.activeSession.restUntil = Date.now() + 20000
  state.activeSession.sets[1] = { ...state.activeSession.sets[1], reps: 8, weightKg: 20.123456789, completed }
  return state
}
function View({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const navigate = useNavigate()
  live = state
  replaceState = next => { live = next; revision++; setState(next) }
  const update: UpdateState = change => {
    lastChange = change
    if (captureOnly) return false
    try {
      beforeChange?.(); beforeChange = null
      const next = change(live)
      if (failSave) return false
      commitCount++; live = next; revision++; setState(next); return true
    } catch { return false }
  }
  return <><button onClick={() => navigate('/workouts/lower-strength')}>Other workout route</button><button onClick={() => navigate(-1)}>Router back</button><button onClick={() => navigate('/workouts/upper-power?view=other')}>Query route</button><Routes><Route path="/workouts/:id" element={<WorkoutSession state={state} update={update} readGeneration={() => revision}/>}/><Route path="/progress" element={<p>Finished</p>}/></Routes></>
}
const mount = (state = setup()) => render(<MemoryRouter initialEntries={['/workouts/upper-power']}><View initial={state}/></MemoryRouter>)
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' }))
const choose = (name = 'Front Plank') => fireEvent.click(screen.getByRole('button', { name: `Choose ${name}` }))
const confirmButton = () => screen.getByRole('button', { name: /Confirm replacement and reset/ })
const review = () => { open(); choose() }
const weight = (name = 'Bench Press', number = 1) => screen.getByLabelText(`${name} set ${number} weight`)
// Synthetic retained-handler tests exercise lifetime fences; they are not browser acceptance tests.
const retainedHandler = (element: HTMLElement, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { revision = 0; failSave = false; captureOnly = false; commitCount = 0; beforeChange = null; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('session replacement review and application', () => {
  it('requires explicit selection and confirmation; cancel/back/search never mutate data', () => {
    const state = setup(); mount(state); open()
    fireEvent.change(screen.getByLabelText('Search replacement exercises'), { target: { value: 'plank' } })
    expect(screen.queryByRole('button', { name: 'Choose Back Squat' })).not.toBeInTheDocument()
    choose(); expect(confirmButton()).toHaveTextContent('reset 3 unfinished sets'); expect(live).toBe(state); expect(commitCount).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Back to exercise selection' })); expect(screen.getByLabelText('Search replacement exercises')).toHaveValue('plank')
    choose(); fireEvent.click(screen.getByRole('button', { name: 'Cancel replacement' }))
    expect(screen.queryByRole('region', { name: 'Session exercise replacement' })).not.toBeInTheDocument(); expect(live).toBe(state)
  })
  it.each([false, true])('replaces before/after completed work (%s), resets only chosen rows and preserves all other drafts/timers', completed => {
    const state = setup(completed); const old = structuredClone(state); mount(state)
    fireEvent.change(weight(), { target: { value: '.' } })
    fireEvent.change(weight('Barbell Row'), { target: { value: '100.' } })
    fireEvent.change(weight('Overhead Press'), { target: { value: '.' } })
    fireEvent.change(weight('Bench Press', 2), { target: { value: '123.' } })
    review(); expect(screen.getByText(/Load entry: “\.” lb/)).toBeInTheDocument()
    expect(screen.getByText(/actual replacement sets, regardless/)).toHaveTextContent(`${completed ? 3 : 4} actual replacement sets`)
    expect(weight()).toHaveValue('.')
    fireEvent.click(confirmButton())
    expect(screen.getByLabelText('Front Plank set 1 seconds')).toHaveValue(null)
    expect(weight('Front Plank')).toHaveValue('')
    expect(weight('Barbell Row')).toHaveValue('100.'); expect(weight('Overhead Press')).toHaveValue('.')
    if (completed) {
      expect(weight('Bench Press', 2)).toHaveValue('123.')
      expect(screen.getByLabelText('Bench Press set 2 reps')).toHaveValue(8)
      expect(live.activeSession!.sets.find(set => set.id === old.activeSession!.sets[1].id)).toEqual(old.activeSession!.sets[1])
    } else expect(screen.queryByLabelText('Bench Press set 2 weight')).not.toBeInTheDocument()
    expect(live.activeSession).toMatchObject({ runningSince: old.activeSession!.runningSince, elapsedSeconds: 62, restUntil: old.activeSession!.restUntil })
    expect(live.workouts).toEqual(old.workouts); expect(live.logs).toEqual(old.logs)
  })
  it('keeps an unchanged review valid across timer ticks', () => {
    vi.useFakeTimers(); const state = setup(); state.activeSession!.runningSince = Date.now(); mount(state); review()
    act(() => vi.advanceTimersByTime(2000)); expect(confirmButton()).toBeEnabled()
    fireEvent.click(confirmButton()); expect(commitCount).toBe(1)
  })
  it('retains failed-save review and every source entry, then successfully retries exactly once', () => {
    const state = setup(); const old = structuredClone(state); mount(state)
    fireEvent.change(weight(), { target: { value: '88.' } }); review(); failSave = true
    fireEvent.click(confirmButton()); expect(screen.getByRole('alert')).toHaveTextContent('not saved')
    expect(live).toEqual(old); expect(weight()).toHaveValue('88.'); expect(confirmButton()).toBeEnabled()
    const failedCallback = lastChange
    failSave = false; const confirm = confirmButton()
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
    expect(commitCount).toBe(1); expect(screen.queryByRole('region', { name: 'Session exercise replacement' })).not.toBeInTheDocument()
    expect(() => lastChange(live)).toThrow('no longer current'); expect(() => failedCallback(state)).toThrow('no longer current')
  })
  it('rejects load edits even when text is reverted to the reviewed value', () => {
    mount(); review()
    fireEvent.change(weight('Barbell Row'), { target: { value: '.' } }); fireEvent.change(weight('Barbell Row'), { target: { value: '' } })
    expect(confirmButton()).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('entries changed')
    fireEvent.click(confirmButton()); expect(commitCount).toBe(0)
  })
  it('preserves invalid imperial draft labels when unit changes before review', () => {
    mount(); fireEvent.change(weight('Barbell Row'), { target: { value: '.' } })
    act(() => replaceState({ ...live, profile: { ...live.profile, unit: 'metric' } }))
    review(); fireEvent.click(confirmButton())
    expect(weight('Barbell Row')).toHaveValue('.'); expect(weight('Barbell Row')).toHaveAccessibleDescription(/Load in lb/)
    expect(weight('Front Plank')).toHaveAccessibleDescription(/Load in kg/)
  })
  it.each(['notes', 'pause', 'rest', 'same-id-clone', 'restore-same-reference', 'discard', 'finish'])('rejects stale reviews after %s', action => {
    mount(); review(); const original = live
    if (action === 'notes') fireEvent.change(screen.getByLabelText('Session notes'), { target: { value: 'changed' } })
    if (action === 'pause') fireEvent.click(screen.getByRole('button', { name: 'Resume timer' }))
    if (action === 'rest') fireEvent.click(screen.getByRole('button', { name: 'Dismiss rest timer' }))
    if (action === 'same-id-clone') act(() => replaceState(structuredClone(live)))
    if (action === 'restore-same-reference') act(() => { replaceState({ ...live, activeSession: null }); replaceState(original) })
    if (action === 'discard') fireEvent.click(screen.getByRole('button', { name: 'Discard session' }))
    if (action === 'finish') fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    if (action === 'finish') expect(screen.getByText('Finished')).toBeInTheDocument()
    else { fireEvent.click(confirmButton()); expect(confirmButton()).toBeDisabled() }
    expect(live.activeSession?.workout.exercises.some(exercise => exercise.name === 'Front Plank') ?? false).toBe(false)
  })
  it.each(['Other workout route', 'Query route'])('cannot resurrect a review by navigating %s then Back', route => {
    mount(); review(); fireEvent.click(screen.getByRole('button', { name: route }))
    expect(screen.queryByRole('region', { name: 'Session exercise replacement' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Router back' }))
    expect(screen.queryByRole('region', { name: 'Session exercise replacement' })).not.toBeInTheDocument()
    expect(commitCount).toBe(0); expect(screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' })).toBeEnabled()
  })
  it.each(['cancel', 'back', 'route', 'unmount'])('rejects retained update callbacks after %s', boundary => {
    const view = mount(); review(); captureOnly = true; fireEvent.click(confirmButton())
    const callback = lastChange; const original = live
    if (boundary === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel replacement' }))
    if (boundary === 'back') fireEvent.click(screen.getByRole('button', { name: 'Back to exercise selection' }))
    if (boundary === 'route') { fireEvent.click(screen.getByRole('button', { name: 'Other workout route' })); fireEvent.click(screen.getByRole('button', { name: 'Router back' })) }
    if (boundary === 'unmount') view.unmount()
    expect(() => callback(original)).toThrow('no longer current'); expect(commitCount).toBe(0)
  })
  it.each(['finish', 'discard', 'notes', 'undo', 'remove'])('rejects a retained %s transaction after successful replacement', action => {
    mount(); captureOnly = true
    if (action === 'finish') fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    if (action === 'discard') fireEvent.click(screen.getByRole('button', { name: 'Discard session' }))
    if (action === 'notes') fireEvent.change(screen.getByLabelText('Session notes'), { target: { value: 'stale text' } })
    if (action === 'undo') fireEvent.click(screen.getByRole('button', { name: 'Undo Bench Press set 2' }))
    if (action === 'remove') fireEvent.click(screen.getByRole('button', { name: 'Remove Barbell Row set 1' }))
    const oldChange = lastChange; captureOnly = false; review(); fireEvent.click(confirmButton())
    const replaced = structuredClone(live)
    expect(() => oldChange(live)).toThrow('session changed'); expect(live).toEqual(replaced); expect(commitCount).toBe(1)
  })
  it.each(['clone', 'route', 'unmount'])('rejects retained start transactions after %s', boundary => {
    const state = setup(); state.activeSession = null; const view = mount(state); captureOnly = true
    fireEvent.click(screen.getByRole('button', { name: 'Start workout' })); const oldChange = lastChange
    if (boundary === 'clone') act(() => replaceState(structuredClone(live)))
    if (boundary === 'route') fireEvent.click(screen.getByRole('button', { name: 'Other workout route' }))
    if (boundary === 'unmount') view.unmount()
    expect(() => oldChange(live)).toThrow('session changed'); expect(live.activeSession).toBeNull()
  })
  it.each(['draft', 'draft-reverted', 'route-back'])('rejects retained Finish transactions after %s without a session write', boundary => {
    mount(); captureOnly = true; fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' })); const oldChange = lastChange
    if (boundary !== 'route-back') {
      fireEvent.change(weight(), { target: { value: '120' } })
      if (boundary === 'draft-reverted') fireEvent.change(weight(), { target: { value: '' } })
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Query route' })); fireEvent.click(screen.getByRole('button', { name: 'Router back' }))
    }
    expect(() => oldChange(live)).toThrow('session changed'); expect(live.logs).toHaveLength(0)
  })
  it('keeps separate identities and distinguishable controls when the selected movement already exists', () => {
    mount(); open(); choose('Barbell Row'); fireEvent.click(confirmButton())
    const rows = live.activeSession!.workout.exercises.filter(exercise => exercise.name === 'Barbell Row')
    expect(rows).toHaveLength(2); expect(rows[0].id).not.toBe(rows[1].id)
    expect(screen.getByLabelText('Barbell Row (exercise 2) set 1 weight')).toHaveValue('')
    expect(screen.getByLabelText('Barbell Row (exercise 3) set 1 weight')).toHaveValue('')
  })
  it('rejects an old raw-load setter after replacement before a fresh Finish', () => {
    const state = setup(); mount(state); const oldEdit = retainedHandler(weight('Bench Press', 2), 'onChange')
    review(); fireEvent.click(confirmButton()); const displayed = (weight('Bench Press', 2) as HTMLInputElement).value
    act(() => oldEdit({ target: { value: '999' } }))
    expect(weight('Bench Press', 2)).toHaveValue(displayed)
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    expect(live.logs[0].sets!.find(set => set.id === state.activeSession!.sets[1].id)?.weightKg).toBe(20.123456789)
  })
  it.each([false, true])('rejects retained Finish handlers after raw-only edits, including same batch (%s)', batched => {
    mount(); const oldFinish = retainedHandler(screen.getByRole('button', { name: 'Finish and save workout' }), 'onClick')
    const oldEdit = retainedHandler(weight('Bench Press', 2), 'onChange')
    if (batched) act(() => { oldEdit({ target: { value: '100.25' } }); oldFinish() })
    else { fireEvent.change(weight('Bench Press', 2), { target: { value: '100.25' } }); act(() => oldFinish()) }
    expect(live.logs).toHaveLength(0); expect(weight('Bench Press', 2)).toHaveValue('100.25')
  })
  it('checks the actual callback state even before a replacement dataset renders', () => {
    mount(); review(); const prior = live
    beforeChange = () => { live = structuredClone(live) }
    fireEvent.click(confirmButton()); expect(commitCount).toBe(0); expect(live).toEqual(prior)
    expect(screen.getByRole('alert')).toHaveTextContent('not saved')
  })
  it('reviews 21 actual rows without clamping to the selected three planned sets', () => {
    const state = setup(false); const source = state.activeSession!.workout.exercises[0]; const row = state.activeSession!.sets[0]
    state.activeSession!.workout.exercises = [source]
    state.activeSession!.sets = Array.from({ length: 21 }, (_, index) => ({ ...row, id: `row-${index}`, setNumber: index + 1 }))
    mount(state); review()
    const region = screen.getByRole('region', { name: 'Session exercise replacement' })
    expect(within(region).getByText(/Selected entry:/)).toHaveTextContent('3 planned sets'); expect(within(region).getByText(/Selected entry:/)).toHaveTextContent('21 actual replacement sets')
    fireEvent.click(confirmButton()); expect(live.activeSession!.sets).toHaveLength(21); expect(screen.getByLabelText('Front Plank set 21 seconds')).toBeInTheDocument()
  })
  it('shows capacity errors without offering a destructive confirmation', () => {
    const state = setup(); const sample = state.activeSession!.workout.exercises[1]; const row = state.activeSession!.sets[4]
    for (let index = state.activeSession!.workout.exercises.length; index < 50; index++) {
      state.activeSession!.workout.exercises.push({ ...sample, id: `extra-${index}`, name: `Extra ${index}` })
      state.activeSession!.sets.push({ ...row, id: `extra-set-${index}`, exerciseId: `extra-${index}` })
    }
    mount(state); review(); expect(screen.getByRole('alert')).toHaveTextContent('exceed 50 exercises')
    expect(screen.queryByRole('button', { name: /Confirm replacement/ })).not.toBeInTheDocument(); expect(live).toBe(state)
  })
})
