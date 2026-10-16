// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import WorkoutSession from './WorkoutSession'
import SessionAddition from './SessionAddition'
import type { UpdateState } from './WorkoutSession'
import type { AppState } from '../types'
import { freshState, parseState } from '../storage'
import { finishSession, startSession } from '../session'

let live: AppState
let generation = 0
let commits = 0
let failSave = false
let captureOnly = false
let captured: Parameters<UpdateState>[0]
let replaceState: (state: AppState) => void
let beforeChange: (() => void) | undefined
function setup(unit: 'metric' | 'imperial' = 'imperial') {
  const state = freshState(); state.profile.unit = unit
  state.activeSession = startSession(state.workouts[0]); state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 62; state.activeSession.restUntil = Date.now() + 20000
  state.activeSession.sets[1] = { ...state.activeSession.sets[1], reps: 8, weightKg: 20.123456789, rpe: 7.5, warmup: true, completed: true }
  const prior = structuredClone(state.activeSession); prior.id = 'previous-session'
  state.logs = [finishSession(prior)]
  state.planHistory = [{ id: 'saved-plan', savedAt: new Date().toISOString(), label: 'Before', workouts: structuredClone(state.workouts) }]
  return state
}
function View({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const navigate = useNavigate(); live = state
  replaceState = next => { live = next; generation++; setState(next) }
  const update: UpdateState = change => {
    captured = change
    if (captureOnly) return false
    try {
      beforeChange?.(); beforeChange = undefined
      const next = change(live); parseState(next)
      if (failSave) return false
      commits++; live = next; generation++; setState(next); return true
    } catch { return false }
  }
  return <><button onClick={() => navigate('/workouts/lower-strength')}>Other workout route</button><button onClick={() => navigate('/workouts/upper-power?view=other')}>Query route</button><button onClick={() => navigate(-1)}>Router back</button><Routes><Route path="/workouts/:id" element={<WorkoutSession state={state} update={update} readGeneration={() => generation} />} /><Route path="/progress" element={<p>Finished</p>} /></Routes></>
}
const mount = (state = setup()) => render(<MemoryRouter initialEntries={['/workouts/upper-power']}><View initial={state} /></MemoryRouter>)
const openButton = () => screen.getByRole('button', { name: 'Add exercise to this session' })
const open = () => fireEvent.click(openButton())
const choose = (name = 'Front Plank') => fireEvent.click(screen.getByRole('button', { name: `Use ${name}` }))
const reviewButton = () => screen.getByRole('button', { name: 'Review session addition' })
const confirmButton = () => screen.getByRole('button', { name: /Confirm addition of/ })
const review = (name = 'Front Plank') => { open(); choose(name); fireEvent.click(reviewButton()) }
const input = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const weight = (name = 'Bench Press', number = 1) => screen.getByLabelText(`${name} set ${number} weight`)
const custom = () => { open(); fireEvent.click(screen.getByRole('button', { name: 'Create custom session exercise' })); input('Session exercise name', 'My movement'); input('Session exercise category', 'My category'); input('Number of sets (1–20)', '2'); input('Target reps or seconds', '7–9'); input('Rest between sets (seconds, 0–900)', '42'); input('Exercise notes', 'My chosen setup') }
// Synthetic lifecycle probes supplement jsdom interaction tests, not browser acceptance.
const retained = (element: Element, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { generation = 0; commits = 0; failSave = false; captureOnly = false; beforeChange = undefined; localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('reviewed session-only exercise addition', () => {
  it('accepts immediate form and confirm interactions under StrictMode without a timer tick', () => {
    vi.useFakeTimers()
    render(<StrictMode><MemoryRouter initialEntries={['/workouts/upper-power']}><View initial={setup()} /></MemoryRouter></StrictMode>)
    custom(); fireEvent.click(reviewButton()); expect(confirmButton()).toBeEnabled(); fireEvent.click(confirmButton())
    expect(commits).toBe(1); expect(live.activeSession!.workout.exercises.at(-1)!.name).toBe('My movement')
  })

  it('supports library search, editable details, review, back and cancel without insertion', () => {
    const initial = setup(); mount(initial); open()
    input('Search session exercise library', 'plank')
    expect(screen.queryByRole('button', { name: 'Use Back Squat' })).not.toBeInTheDocument()
    choose(); expect(screen.getByLabelText('Number of sets (1–20)')).toHaveValue('3')
    input('Number of sets (1–20)', '2'); input('Target reps or seconds', '25 sec'); input('Rest between sets (seconds, 0–900)', '75')
    fireEvent.click(reviewButton()); expect(confirmButton()).toHaveTextContent('2 sets')
    const region = screen.getByRole('region', { name: 'Session exercise addition' })
    expect(within(region).getByText('25 sec')).toBeInTheDocument(); expect(within(region).getByText('75 seconds')).toBeInTheDocument()
    expect(within(region).getByText(/duration and calorie estimates are unchanged/)).toBeInTheDocument()
    expect(commits).toBe(0); expect(live).toBe(initial)
    fireEvent.click(screen.getByRole('button', { name: 'Back to exercise details' })); expect(screen.getByLabelText('Number of sets (1–20)')).toHaveValue('2')
    fireEvent.click(reviewButton()); fireEvent.click(screen.getByRole('button', { name: 'Cancel addition' }))
    expect(live).toBe(initial); expect(screen.queryByRole('region', { name: 'Session exercise addition' })).not.toBeInTheDocument()
  })

  it.each(['metric', 'imperial'] as const)('adds the exact reviewed rows and preserves every existing value and raw %s draft', unit => {
    const state = setup(unit); const old = structuredClone(state); mount(state)
    fireEvent.change(weight(), { target: { value: '100.' } }); fireEvent.change(weight('Barbell Row'), { target: { value: '.' } }); fireEvent.change(weight('Overhead Press'), { target: { value: '0' } }); fireEvent.change(weight('Bench Press', 2), { target: { value: '88.25' } })
    open(); choose(); input('Number of sets (1–20)', '7'); input('Target reps or seconds', '23 sec'); fireEvent.click(reviewButton()); fireEvent.click(confirmButton())
    const added = live.activeSession!.workout.exercises.at(-1)!
    expect(added).toMatchObject({ name: 'Front Plank', sets: 7, reps: '23 sec' })
    const addedRows = live.activeSession!.sets.filter(row => row.exerciseId === added.id)
    expect(addedRows).toHaveLength(7)
    for (const [index, row] of addedRows.entries()) expect(row).toMatchObject({ setNumber: index + 1, reps: null, seconds: null, weightKg: null, rpe: null, warmup: false, completed: false })
    expect(live.activeSession!.sets.slice(0, old.activeSession!.sets.length)).toEqual(old.activeSession!.sets)
    expect(live.activeSession!.workout.exercises.slice(0, old.activeSession!.workout.exercises.length)).toEqual(old.activeSession!.workout.exercises)
    expect(live.activeSession).toMatchObject({ id: old.activeSession!.id, notes: old.activeSession!.notes, runningSince: null, elapsedSeconds: 62, restUntil: old.activeSession!.restUntil, startedAt: old.activeSession!.startedAt })
    expect(live.activeSession!.workout.duration).toBe(old.activeSession!.workout.duration); expect(live.activeSession!.workout.calories).toBe(old.activeSession!.workout.calories)
    expect(live.workouts).toEqual(old.workouts); expect(live.logs).toEqual(old.logs); expect(live.planHistory).toEqual(old.planHistory)
    expect(weight()).toHaveValue('100.'); expect(weight('Barbell Row')).toHaveValue('.'); expect(weight('Overhead Press')).toHaveValue('0'); expect(weight('Bench Press', 2)).toHaveValue('88.25')
    expect(weight('Front Plank', 7)).toHaveValue(''); expect(screen.getByLabelText('Front Plank set 7 seconds')).toHaveValue(null)
    expect(screen.getByTestId('session-timer')).toHaveTextContent('01:02'); expect(screen.getByText(/Rest: 00:/)).toBeInTheDocument(); expect(commits).toBe(1)
  })

  it.each(['unknown', 'none', 'listed'])('reviews and adds custom details with explicit %s equipment state', mode => {
    mount(); custom(); expect(screen.getByLabelText('Session exercise equipment requirements')).toHaveValue('unknown')
    if (mode !== 'unknown') input('Session exercise equipment requirements', mode)
    if (mode === 'listed') fireEvent.click(screen.getByLabelText('Session exercise requires Dumbbells'))
    fireEvent.click(reviewButton())
    const region = screen.getByRole('region', { name: 'Session exercise addition' })
    expect(within(region).getByText('My category')).toBeInTheDocument(); expect(within(region).getByText('7–9')).toBeInTheDocument(); expect(within(region).getByText('42 seconds')).toBeInTheDocument(); expect(within(region).getByText('My chosen setup')).toBeInTheDocument()
    fireEvent.click(confirmButton())
    const added = live.activeSession!.workout.exercises.at(-1)!
    expect(added).toMatchObject({ name: 'My movement', category: 'My category', sets: 2, reps: '7–9', restSeconds: 42, notes: 'My chosen setup' })
    expect(added.equipment).toEqual(mode === 'unknown' ? undefined : mode === 'none' ? [] : ['dumbbells'])
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })

  it.each([['Session exercise name', ''], ['Target reps or seconds', ' '], ['Number of sets (1–20)', '0'], ['Number of sets (1–20)', '21'], ['Number of sets (1–20)', '1.5'], ['Number of sets (1–20)', '1e1'], ['Rest between sets (seconds, 0–900)', ''], ['Rest between sets (seconds, 0–900)', '901'], ['Rest between sets (seconds, 0–900)', '1.5']])('rejects invalid %s = %s without creating a review', (label, value) => {
    mount(); custom(); input(label, value); fireEvent.click(reviewButton())
    expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Confirm addition/ })).not.toBeInTheDocument(); expect(commits).toBe(0)
  })

  it('does not equate an empty listed-equipment selection with no equipment', () => {
    mount(); custom(); input('Session exercise equipment requirements', 'listed'); fireEvent.click(reviewButton())
    expect(screen.getByRole('alert')).toHaveTextContent('Select at least one equipment category'); expect(commits).toBe(0)
    input('Session exercise equipment requirements', 'none'); fireEvent.click(reviewButton()); expect(confirmButton()).toBeEnabled()
  })

  it.each(['1', '20'])('honors the exact valid %s-set boundary', count => {
    mount(); custom(); input('Number of sets (1–20)', count); input('Rest between sets (seconds, 0–900)', count === '1' ? '0' : '900'); fireEvent.click(reviewButton()); fireEvent.click(confirmButton())
    expect(live.activeSession!.sets.filter(set => set.exerciseId === live.activeSession!.workout.exercises.at(-1)!.id)).toHaveLength(Number(count))
  })

  it('clears canceled custom draft and never restores or persists it automatically', () => {
    mount(); custom(); fireEvent.click(screen.getByRole('button', { name: 'Cancel addition' })); open(); fireEvent.click(screen.getByRole('button', { name: 'Create custom session exercise' }))
    expect(screen.getByLabelText('Session exercise name')).toHaveValue(''); expect(screen.getByLabelText('Number of sets (1–20)')).toHaveValue(''); expect(screen.getByLabelText('Target reps or seconds')).toHaveValue(''); expect(screen.getByLabelText('Rest between sets (seconds, 0–900)')).toHaveValue('')
    expect(commits).toBe(0); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })

  it('preserves a pending invalid imperial load label after units change before review', () => {
    mount(); fireEvent.change(weight(), { target: { value: '.' } }); act(() => replaceState({ ...live, profile: { ...live.profile, unit: 'metric' } })); review(); fireEvent.click(confirmButton())
    expect(weight()).toHaveValue('.'); expect(weight()).toHaveAccessibleDescription(/Load in lb/); expect(weight('Front Plank')).toHaveAccessibleDescription(/Load in kg/)
  })

  it('keeps an unchanged review valid across running timer ticks', () => {
    vi.useFakeTimers(); const state = setup(); state.activeSession!.runningSince = Date.now(); mount(state); review(); act(() => vi.advanceTimersByTime(2000)); expect(confirmButton()).toBeEnabled(); fireEvent.click(confirmButton())
    expect(live.activeSession!.runningSince).toBe(state.activeSession!.runningSince); expect(live.activeSession!.elapsedSeconds).toBe(62); expect(live.activeSession!.restUntil).toBe(state.activeSession!.restUntil); expect(commits).toBe(1)
  })

  it('retains failed-save review, form and every original raw draft, then retries exactly once', () => {
    const initial = setup(); mount(initial); fireEvent.change(weight(), { target: { value: '100.' } }); fireEvent.change(weight('Barbell Row'), { target: { value: '.' } }); custom(); fireEvent.click(reviewButton()); failSave = true; fireEvent.click(confirmButton())
    const failed = captured
    expect(screen.getByRole('alert')).toHaveTextContent('not saved'); expect(live).toBe(initial); expect(weight()).toHaveValue('100.'); expect(weight('Barbell Row')).toHaveValue('.'); expect(confirmButton()).toBeEnabled()
    expect(() => failed(initial)).toThrow('no longer current')
    fireEvent.click(screen.getByRole('button', { name: 'Back to exercise details' })); expect(screen.getByLabelText('Session exercise name')).toHaveValue('My movement'); expect(screen.getByLabelText('Number of sets (1–20)')).toHaveValue('2'); fireEvent.click(reviewButton())
    failSave = false; const handler = retained(confirmButton(), 'onClick'); act(() => { handler(); handler() })
    expect(commits).toBe(1); expect(() => captured(live)).toThrow('no longer current'); expect(() => failed(initial)).toThrow('no longer current'); expect(weight()).toHaveValue('100.'); expect(weight('Barbell Row')).toHaveValue('.')
  })

  it('rejects a callback retained without ever being invoked during the save attempt', () => {
    mount(); review(); captureOnly = true; fireEvent.click(confirmButton()); const callback = captured
    expect(() => callback(live)).toThrow('no longer current'); captureOnly = false; fireEvent.click(confirmButton()); expect(commits).toBe(1)
  })

  it.each(['notes', 'pause', 'rest', 'reps', 'add-set', 'remove-set', 'same-id-clone', 'identical-generation', 'account-restore', 'plan-edit'])('invalidates a reviewed addition after %s', boundary => {
    mount(); review(); const oldConfirm = retained(confirmButton(), 'onClick'); const original = live
    if (boundary === 'notes') input('Session notes', 'Changed')
    if (boundary === 'pause') fireEvent.click(screen.getByRole('button', { name: 'Resume timer' }))
    if (boundary === 'rest') fireEvent.click(screen.getByRole('button', { name: 'Dismiss rest timer' }))
    if (boundary === 'reps') input('Bench Press set 1 reps', '9')
    if (boundary === 'add-set') fireEvent.click(screen.getAllByRole('button', { name: 'Add set' })[0])
    if (boundary === 'remove-set') fireEvent.click(screen.getByRole('button', { name: 'Remove Barbell Row set 1' }))
    if (boundary === 'same-id-clone') act(() => replaceState(structuredClone(live)))
    if (boundary === 'identical-generation') act(() => { replaceState(live) })
    if (boundary === 'account-restore') act(() => { replaceState({ ...live, activeSession: null }); replaceState(original) })
    if (boundary === 'plan-edit') act(() => replaceState({ ...live, workouts: structuredClone(live.workouts) }))
    const before = commits; act(() => oldConfirm()); fireEvent.click(confirmButton()); expect(commits).toBe(before)
    expect(live.activeSession!.workout.exercises.some(exercise => exercise.name === 'Front Plank')).toBe(false)
  })

  it.each([false, true])('invalidates raw-load edits including change-and-back before rerender (%s)', batched => {
    mount(); review(); const oldConfirm = retained(confirmButton(), 'onClick'); const edit = retained(weight(), 'onChange')
    if (batched) act(() => { edit({ target: { value: '.' } }); oldConfirm() })
    else { fireEvent.change(weight(), { target: { value: '.' } }); fireEvent.change(weight(), { target: { value: '' } }); act(() => oldConfirm()) }
    expect(commits).toBe(0); expect(confirmButton()).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('load entries changed')
  })

  it.each(['Other workout route', 'Query route'])('cannot restore an addition after %s and Back', route => {
    mount(); review(); const handler = retained(confirmButton(), 'onClick'); fireEvent.click(screen.getByRole('button', { name: route })); fireEvent.click(screen.getByRole('button', { name: 'Router back' })); act(() => handler())
    expect(commits).toBe(0); expect(screen.queryByRole('region', { name: 'Session exercise addition' })).not.toBeInTheDocument(); expect(openButton()).toBeEnabled()
  })

  it.each(['cancel', 'back', 'finish', 'discard', 'unmount'])('revokes retained confirms and callbacks after %s', boundary => {
    const view = mount(); review(); const confirm = retained(confirmButton(), 'onClick'); captureOnly = true; fireEvent.click(confirmButton()); const callback = captured; const original = live; captureOnly = false
    if (boundary === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel addition' }))
    if (boundary === 'back') { fireEvent.click(screen.getByRole('button', { name: 'Back to exercise details' })); input('Number of sets (1–20)', '2'); fireEvent.click(reviewButton()) }
    if (boundary === 'finish') fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    if (boundary === 'discard') fireEvent.click(screen.getByRole('button', { name: 'Discard session' }))
    if (boundary === 'unmount') view.unmount()
    const before = commits; act(() => confirm()); expect(commits).toBe(before); expect(() => callback(original)).toThrow('no longer current')
  })

  it('guards a retained draft submit when a custom field changes before rerender', () => {
    mount(); custom(); const submit = retained(reviewButton().closest('form')!, 'onSubmit'); const edit = retained(screen.getByLabelText('Session exercise name'), 'onChange')
    act(() => { edit({ target: { value: 'New name' } }); submit({ preventDefault() {} }) })
    expect(screen.queryByRole('button', { name: /Confirm addition/ })).not.toBeInTheDocument(); expect(commits).toBe(0); fireEvent.click(reviewButton()); expect(screen.getByText('New name')).toBeInTheDocument()
  })

  it.each([false, true])('rejects an old cancel after a newer local draft edit, including before rerender (%s)', batched => {
    mount(); custom(); const cancel = retained(screen.getByRole('button', { name: 'Cancel addition' }), 'onClick'); const edit = retained(screen.getByLabelText('Session exercise name'), 'onChange')
    if (batched) act(() => { edit({ target: { value: 'Keep my new draft' } }); cancel() })
    else { input('Session exercise name', 'Keep my new draft'); act(() => cancel()) }
    expect(screen.getByLabelText('Session exercise name')).toHaveValue('Keep my new draft')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel addition' })); expect(screen.queryByRole('region', { name: 'Session exercise addition' })).not.toBeInTheDocument()
  })

  it('rejects retained library choice after search changes and old detail edits after review', () => {
    mount(); open(); const chooseOld = retained(screen.getByRole('button', { name: 'Use Front Plank' }), 'onClick'); const search = retained(screen.getByLabelText('Search session exercise library'), 'onChange')
    act(() => { search({ target: { value: 'bench' } }); chooseOld() }); expect(screen.queryByLabelText('Session exercise name')).not.toBeInTheDocument()
    choose('Bench Press'); const oldEdit = retained(screen.getByLabelText('Session exercise name'), 'onChange'); fireEvent.click(reviewButton()); act(() => oldEdit({ target: { value: 'Injected edit' } })); fireEvent.click(confirmButton())
    expect(live.activeSession!.workout.exercises.at(-1)!.name).toBe('Bench Press')
  })

  it.each(['generation', 'current-state', 'in-place-session'])('rejects changes inside the save callback before rendering: %s', boundary => {
    mount(); review()
    beforeChange = () => { if (boundary === 'generation') generation++; if (boundary === 'current-state') live = { ...live }; if (boundary === 'in-place-session') live.activeSession!.notes = 'Changed in place' }
    fireEvent.click(confirmButton()); expect(commits).toBe(0); expect(live.activeSession!.workout.exercises.some(exercise => exercise.name === 'Front Plank')).toBe(false)
  })

  it('adds a duplicate movement with distinct identity and no borrowed previous-load reference', () => {
    mount(); review('Bench Press'); fireEvent.click(confirmButton())
    const duplicates = live.activeSession!.workout.exercises.filter(exercise => exercise.name === 'Bench Press'); expect(duplicates).toHaveLength(2); expect(duplicates[0].id).not.toBe(duplicates[1].id)
    const index = live.activeSession!.workout.exercises.length
    expect(weight(`Bench Press (exercise ${index})`)).toHaveValue(''); expect(weight('Bench Press (exercise 1)', 2)).not.toHaveValue('')
    const region = screen.getByRole('article', { name: `Bench Press (exercise ${index})` }); expect(within(region).queryByText(/Last:/)).not.toBeInTheDocument()
  })

  it('makes addition and replacement mutually exclusive, including retained opening handlers', () => {
    mount(); const oldAdd = retained(openButton(), 'onClick'); const replacement = screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' }); const oldReplace = retained(replacement, 'onClick')
    open(); expect(replacement).toBeDisabled(); act(() => oldReplace()); expect(screen.queryByRole('region', { name: 'Session exercise replacement' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel addition' })); fireEvent.click(screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' })); expect(openButton()).toBeDisabled(); act(() => oldAdd())
    expect(screen.queryByRole('region', { name: 'Session exercise addition' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel replacement' })); expect(openButton()).toBeEnabled()
  })

  it('rejects older session edits after successful addition', () => {
    mount(); const oldLoad = retained(weight(), 'onChange'); captureOnly = true; input('Session notes', 'old notes'); const oldChange = captured; captureOnly = false; review(); fireEvent.click(confirmButton()); const saved = structuredClone(live)
    expect(() => oldChange(live)).toThrow('session changed'); act(() => oldLoad({ target: { value: '999' } })); expect(weight()).toHaveValue(''); expect(live).toEqual(saved)
  })

  it('offers addition only on the currently active session route', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Other workout route' })); expect(screen.queryByRole('button', { name: 'Add exercise to this session' })).not.toBeInTheDocument()
  })

  it('shows the 50-exercise limit without removing or truncating anything', () => {
    const state = setup(); const session = state.activeSession!; const sample = session.workout.exercises[0]; const row = session.sets[0]
    for (let index = session.workout.exercises.length; index < 50; index++) { session.workout.exercises.push({ ...sample, id: `extra-${index}`, name: `Extra ${index}` }); session.sets.push({ ...row, id: `extra-row-${index}`, exerciseId: `extra-${index}` }) }
    mount(state); expect(openButton()).toBeDisabled(); expect(screen.getByText(/reached the 50-exercise limit/)).toBeInTheDocument(); expect(live).toBe(state)
  })

  it.each([2500, 2499])('explains the 2,500-row limit and rejects excess sets at %s rows', rowCount => {
    const onReview = vi.fn(); render(<SessionAddition workouts={freshState().workouts} review={null} stale={false} error="" exerciseCount={4} rowCount={rowCount} onReview={onReview} onBack={() => {}} onCancel={() => {}} onConfirm={() => {}} />)
    if (rowCount === 2500) { expect(screen.getByRole('alert')).toHaveTextContent('2,500 set rows'); expect(screen.getByRole('button', { name: 'Create custom session exercise' })).toBeDisabled() }
    else { choose(); fireEvent.click(reviewButton()); expect(screen.getByRole('alert')).toHaveTextContent('no rows will be truncated'); input('Number of sets (1–20)', '1'); fireEvent.click(reviewButton()); expect(onReview).toHaveBeenCalledOnce() }
  })

  it('retains the library source identity for freshness checks even if absent from saved plans', () => {
    const state = freshState(); const source = state.workouts.flatMap(workout => workout.exercises).find(exercise => exercise.name === 'Front Plank')!; const onReview = vi.fn()
    render(<SessionAddition workouts={[state.workouts[0]]} review={null} stale={false} error="" exerciseCount={4} rowCount={16} onReview={onReview} onBack={() => {}} onCancel={() => {}} onConfirm={() => {}} />)
    choose(); input('Session exercise name', 'My plank target'); fireEvent.click(reviewButton())
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ id: source.id, name: 'My plank target' }))
  })
})
