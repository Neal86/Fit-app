// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import WorkoutSession from './WorkoutSession'
import ProgressDashboard from './ProgressDashboard'
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
  const session = startSession(state.workouts[0]); state.activeSession = session
  session.runningSince = null; session.elapsedSeconds = 62; session.restUntil = Date.now() + 20000
  session.notes = 'Keep these notes'; session.sets = session.sets.map(row => ({ ...row, reps: 8, weightKg: 20.123456789, rpe: 7.5 }))
  const prior = { ...structuredClone(session), id: 'previous-session' }; prior.sets[0].completed = true
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
  return <><button onClick={() => navigate('/workouts/lower-strength')}>Other workout route</button><button onClick={() => navigate('/workouts/upper-power?view=other')}>Query route</button><button onClick={() => navigate(-1)}>Router back</button><Routes><Route path="/workouts/:id" element={<WorkoutSession state={state} update={update} readGeneration={() => generation} />} /><Route path="/progress" element={<ProgressDashboard state={state} onDelete={() => {}} onWeight={() => false} />} /></Routes></>
}
const mount = (state = setup()) => render(<MemoryRouter initialEntries={['/workouts/upper-power']}><View initial={state} /></MemoryRouter>)
const button = (name: string) => screen.getByRole('button', { name })
const input = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const open = () => fireEvent.click(button('Create session group'))
const reviewButton = () => button('Review session group')
const confirmButton = () => button('Confirm session group')
const weight = (name = 'Bench Press', number = 1) => screen.getByLabelText(`${name} set ${number} weight`)
function fill(count = 2, rest = 45) {
  input('Group name', 'My pair'); input('Round count (1–50)', String(count)); input('Rest after each round (seconds, 0–900)', String(rest))
  const exercises = live.activeSession!.workout.exercises.slice(0, 2)
  exercises.forEach((exercise, column) => input(`Movement ${column + 1}`, exercise.id))
  for (let round = 0; round < count; round++) exercises.forEach((exercise, column) => input(`Round ${round + 1} movement ${column + 1} row`, live.activeSession!.sets.filter(set => set.exerciseId === exercise.id && !set.completed && !set.warmup)[round].id))
}
const review = (count = 2, rest = 45) => { open(); fill(count, rest); fireEvent.click(reviewButton()) }
const create = (count = 2, rest = 45) => { review(count, rest); fireEvent.click(confirmButton()) }
const retained = (element: Element, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { generation = 0; commits = 0; failSave = false; captureOnly = false; beforeChange = undefined; localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('session-only explicit grouping', () => {
  it('uses blank ordered movements and exact blank row cells, never automatically pairing or adding work', () => {
    const state = setup(); mount(state); open(); input('Round count (1–50)', '2')
    expect(screen.getByLabelText('Movement 1')).toHaveValue(''); expect(screen.getByLabelText('Round 1 movement 1 row')).toHaveValue(''); fill()
    input('Round 2 movement 2 row', ''); fireEvent.click(reviewButton())
    expect(screen.getByRole('alert')).toHaveTextContent('Explicitly select'); expect(live).toBe(state); expect(commits).toBe(0)
  })

  it.each(['metric', 'imperial'] as const)('preserves exact existing data and valid/invalid raw %s text, timers and extra rows', unit => {
    const state = setup(unit); const old = structuredClone(state); mount(state)
    input('Bench Press set 1 weight', '100.'); input('Barbell Row set 1 weight', '.'); input('Overhead Press set 1 weight', '0')
    review(); const region = screen.getByRole('region', { name: 'Session grouping' })
    expect(within(region).getByText(/Older strict builds or APIs may reject/)).toBeInTheDocument(); expect(within(region).getByRole('list', { name: 'Rows remaining ungrouped' }).children.length).toBe(state.activeSession!.sets.length - 4)
    fireEvent.click(confirmButton()); const { grouping, ...rest } = live.activeSession!
    expect(rest).toEqual(old.activeSession); expect(grouping!.groups[0]).toMatchObject({ name: 'My pair', restSeconds: 45 }); expect(grouping!.groups[0].rounds).toHaveLength(2)
    expect(live.workouts).toEqual(old.workouts); expect(live.logs).toEqual(old.logs); expect(live.planHistory).toEqual(old.planHistory)
    expect(weight()).toHaveValue('100.'); expect(weight('Barbell Row')).toHaveValue('.'); expect(weight('Overhead Press')).toHaveValue('0'); expect(commits).toBe(1)
    expect(screen.getByTestId('session-timer')).toHaveTextContent('01:02'); expect(screen.getAllByText('Outside session groups')).toHaveLength(state.activeSession!.sets.length - 4)
  })

  it('accepts immediate interactions under StrictMode without waiting for a timer tick', () => {
    vi.useFakeTimers(); render(<StrictMode><MemoryRouter initialEntries={['/workouts/upper-power']}><View initial={setup()} /></MemoryRouter></StrictMode>); create(); expect(commits).toBe(1)
  })

  it.each([['Group name', ' '], ['Round count (1–50)', '0'], ['Round count (1–50)', '51'], ['Round count (1–50)', '1.5'], ['Round count (1–50)', '1e1'], ['Rest after each round (seconds, 0–900)', ''], ['Rest after each round (seconds, 0–900)', '901'], ['Rest after each round (seconds, 0–900)', '-1'], ['Rest after each round (seconds, 0–900)', '1.5']])('rejects invalid %s = %s', (label, value) => {
    mount(); open(); fill(); input(label, value); fireEvent.click(reviewButton()); expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Confirm session group' })).not.toBeInTheDocument(); expect(commits).toBe(0)
  })

  it('supports up to six ordered movements and clears only affected column when a movement changes', () => {
    mount(); open(); fill(); fireEvent.click(button('Add movement slot')); input('Movement 3', live.activeSession!.workout.exercises[2].id)
    expect(screen.getByLabelText('Round 1 movement 3 row')).toHaveValue(''); expect(screen.getByLabelText('Round 1 movement 1 row')).not.toHaveValue('')
    fireEvent.click(button('Remove last movement slot')); expect(screen.queryByLabelText('Movement 3')).not.toBeInTheDocument()
    input('Movement 1', live.activeSession!.workout.exercises[2].id); expect(screen.getByLabelText('Round 1 movement 1 row')).toHaveValue(''); expect(screen.getByLabelText('Round 1 movement 2 row')).not.toHaveValue('')
    for (let index = 0; index < 4; index++) fireEvent.click(button('Add movement slot')); expect(button('Add movement slot')).toBeDisabled()
  })

  it('rejects duplicate row selection even if a retained select event bypasses disabled options', () => {
    mount(); open(); fill(); const id = live.activeSession!.sets[0].id; input('Round 2 movement 1 row', id); fireEvent.click(reviewButton()); expect(screen.getByRole('alert')).toHaveTextContent('distinct existing row'); expect(commits).toBe(0)
  })

  it('shows distinct movement and source row labels for duplicate names/numbers and mixed timed/reps rows', () => {
    const state = setup(); const session = state.activeSession!; session.workout.exercises[1].name = session.workout.exercises[0].name; session.workout.exercises[1].reps = '30 sec'
    session.sets.filter(row => row.exerciseId === session.workout.exercises[1].id).forEach(row => { row.seconds = 30; row.reps = null })
    session.sets[1].setNumber = session.sets[0].setNumber; mount(state); review()
    const region = screen.getByRole('region', { name: 'Session grouping' }); expect(within(region).getByText('Bench Press (exercise 1) · set 1 · source row 1')).toBeInTheDocument(); expect(within(region).getByText('Bench Press (exercise 1) · set 1 · source row 2')).toBeInTheDocument()
    fireEvent.click(confirmButton()); expect(screen.getByLabelText('Bench Press (exercise 2) set 1 seconds')).toHaveValue(30); expect(screen.getByLabelText('Bench Press (exercise 1) set 1 (source row 1) reps')).toHaveValue(8)
  })

  it('excludes complete/warm-up/already grouped rows and leaves unequal extras outside', () => {
    const state = setup(); state.activeSession!.sets[0].completed = true; state.activeSession!.sets[1].warmup = true; mount(state); create(1)
    open(); fill(1); const choices = within(screen.getByLabelText('Round 1 movement 1 row')).getAllByRole('option').map(item => (item as HTMLOptionElement).value)
    const session = live.activeSession!; expect(choices).not.toContain(session.sets[0].id); expect(choices).not.toContain(session.sets[1].id); expect(choices).not.toContain(session.grouping!.groups[0].rounds[0].setIds[0]); expect(commits).toBe(1)
  })

  it('retains failed-save review, form and raw loads, revokes attempted callback, and retries exactly once', () => {
    const state = setup(); mount(state); input('Bench Press set 1 weight', '100.'); input('Barbell Row set 1 weight', '.'); review(); failSave = true; fireEvent.click(confirmButton()); const oldCallback = captured
    expect(live).toBe(state); expect(screen.getByRole('alert')).toHaveTextContent('not saved'); expect(() => oldCallback(state)).toThrow('no longer current'); expect(weight()).toHaveValue('100.')
    fireEvent.click(button('Back to group details')); expect(screen.getByLabelText('Group name')).toHaveValue('My pair'); expect(screen.getByLabelText('Round count (1–50)')).toHaveValue('2'); fireEvent.click(reviewButton()); failSave = false
    const confirm = retained(confirmButton(), 'onClick'); act(() => { confirm(); confirm() }); expect(commits).toBe(1); expect(weight('Barbell Row')).toHaveValue('.'); expect(() => captured(live)).toThrow('no longer current')
  })

  it('revokes an uninvoked update callback after a failed synchronous attempt', () => {
    mount(); review(); captureOnly = true; fireEvent.click(confirmButton()); const callback = captured; expect(() => callback(live)).toThrow('no longer current'); captureOnly = false; fireEvent.click(confirmButton()); expect(commits).toBe(1)
  })

  it.each(['notes', 'pause', 'rest', 'reps', 'add-set', 'remove-set', 'clone', 'generation', 'account-restore', 'plan-edit'])('invalidates grouping review after %s', boundary => {
    mount(); review(); const confirm = retained(confirmButton(), 'onClick'); const original = live
    if (boundary === 'notes') input('Session notes', 'Changed')
    if (boundary === 'pause') fireEvent.click(button('Resume timer'))
    if (boundary === 'rest') fireEvent.click(button('Dismiss rest timer'))
    if (boundary === 'reps') input('Bench Press set 1 reps', '9')
    if (boundary === 'add-set') fireEvent.click(screen.getAllByRole('button', { name: 'Add set' })[0])
    if (boundary === 'remove-set') fireEvent.click(button('Remove Bench Press set 3'))
    if (boundary === 'clone') act(() => replaceState(structuredClone(live)))
    if (boundary === 'generation') act(() => replaceState(live))
    if (boundary === 'account-restore') act(() => { replaceState({ ...live, activeSession: null }); replaceState(original) })
    if (boundary === 'plan-edit') act(() => replaceState({ ...live, workouts: structuredClone(live.workouts) }))
    const before = commits; act(() => confirm()); expect(commits).toBe(before); expect(live.activeSession!.grouping).toBeUndefined()
  })

  it.each([false, true])('rejects raw load edit and change-back even before rerender (%s)', batched => {
    mount(); review(); const confirm = retained(confirmButton(), 'onClick'); const edit = retained(weight(), 'onChange'); const original = (weight() as HTMLInputElement).value
    if (batched) act(() => { edit({ target: { value: '.' } }); confirm() })
    else { input('Bench Press set 1 weight', '.'); input('Bench Press set 1 weight', original); act(() => confirm()) }
    expect(commits).toBe(0); expect(confirmButton()).toBeDisabled()
  })

  it.each(['Other workout route', 'Query route'])('revokes grouping after %s and back', route => {
    mount(); review(); const confirm = retained(confirmButton(), 'onClick'); fireEvent.click(button(route)); fireEvent.click(button('Router back')); act(() => confirm()); expect(commits).toBe(0); expect(screen.queryByRole('region', { name: 'Session grouping' })).not.toBeInTheDocument()
  })

  it.each(['cancel', 'back', 'finish', 'discard', 'unmount'])('revokes retained confirmation and callback after %s', boundary => {
    const state = setup(); state.activeSession!.sets.at(-1)!.completed = true; const view = mount(state); review(); const confirm = retained(confirmButton(), 'onClick'); captureOnly = true; fireEvent.click(confirmButton()); const callback = captured; const original = live; captureOnly = false
    if (boundary === 'cancel') fireEvent.click(button('Cancel grouping'))
    if (boundary === 'back') { fireEvent.click(button('Back to group details')); input('Group name', 'New group'); fireEvent.click(reviewButton()) }
    if (boundary === 'finish') fireEvent.click(button('Finish and save workout'))
    if (boundary === 'discard') fireEvent.click(button('Discard session'))
    if (boundary === 'unmount') view.unmount()
    const before = commits; act(() => confirm()); expect(commits).toBe(before); expect(() => callback(original)).toThrow('no longer current')
  })

  it('guards retained submit, local edit and cancel after a newer local form edit or review', () => {
    mount(); open(); fill(); const submit = retained(reviewButton().closest('form')!, 'onSubmit'); const cancel = retained(button('Cancel grouping'), 'onClick'); const edit = retained(screen.getByLabelText('Group name'), 'onChange')
    act(() => { edit({ target: { value: 'New group' } }); submit({ preventDefault() {} }); cancel() }); expect(screen.getByLabelText('Group name')).toHaveValue('New group'); expect(screen.queryByRole('button', { name: 'Confirm session group' })).not.toBeInTheDocument()
    fireEvent.click(reviewButton()); act(() => edit({ target: { value: 'Old injected edit' } })); fireEvent.click(confirmButton()); expect(live.activeSession!.grouping!.groups[0].name).toBe('New group')
  })

  it.each(['generation', 'current-state', 'in-place-session'])('rejects transactional changes before rendering: %s', boundary => {
    mount(); review(); beforeChange = () => { if (boundary === 'generation') generation++; if (boundary === 'current-state') live = { ...live }; if (boundary === 'in-place-session') live.activeSession!.notes = 'Mutated' }
    fireEvent.click(confirmButton()); expect(commits).toBe(0); expect(live.activeSession!.grouping).toBeUndefined()
  })

  it('keeps all review flows mutually exclusive including retained opening handlers', () => {
    mount(); const add = retained(button('Add exercise to this session'), 'onClick'); const replace = retained(button('Replace unfinished Bench Press sets'), 'onClick'); const group = retained(button('Create session group'), 'onClick'); open(); act(() => { add(); replace() })
    expect(button('Add exercise to this session')).toBeDisabled(); expect(screen.queryByRole('region', { name: 'Session exercise replacement' })).not.toBeInTheDocument(); fireEvent.click(button('Cancel grouping')); fireEvent.click(button('Add exercise to this session')); act(() => group()); expect(screen.queryByRole('region', { name: 'Session grouping' })).not.toBeInTheDocument()
  })
})

describe('group round execution and history', () => {
  it('starts round rest only on actual last unfinished completion, supports out-of-order rounds, undo and reload', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T00:00:00Z')); mount(); create(); const originalRest = live.activeSession!.restUntil; const definition = structuredClone(live.activeSession!.grouping)
    fireEvent.click(button('Complete Barbell Row set 2')); expect(live.activeSession!.restUntil).toBe(originalRest)
    fireEvent.click(button('Complete Bench Press set 2')); expect(live.activeSession!.restUntil).toBe(Date.now() + 45000)
    expect(within(screen.getByRole('article', { name: 'Session group My pair' })).getByText('Round 1: Unfinished')).toBeInTheDocument(); expect(within(screen.getByRole('article', { name: 'Session group My pair' })).getByText('Round 2: All rows marked complete')).toBeInTheDocument()
    const savedRest = live.activeSession!.restUntil; act(() => vi.advanceTimersByTime(3000)); act(() => replaceState(parseState(structuredClone(live)))); expect(live.activeSession!.restUntil).toBe(savedRest)
    fireEvent.click(button('Undo Bench Press set 2')); expect(live.activeSession!.restUntil).toBe(savedRest); expect(live.activeSession!.grouping).toEqual(definition)
    fireEvent.click(button('Complete Bench Press set 2')); expect(live.activeSession!.restUntil).toBe(Date.now() + 45000)
  })

  it.each([0, 900])('honors exact %s group rest and leaves ungrouped exercise rest unchanged', rest => {
    vi.useFakeTimers(); mount(); create(1, rest); const initial = live.activeSession!.restUntil
    fireEvent.click(button('Complete Bench Press set 1')); fireEvent.click(button('Complete Barbell Row set 1')); expect(live.activeSession!.restUntil).toBe(rest ? Date.now() + rest * 1000 : initial)
    fireEvent.click(button('Complete Bench Press set 3')); expect(live.activeSession!.restUntil).toBe(Date.now() + live.activeSession!.workout.exercises[0].restSeconds * 1000)
  })

  it('rejects retained completion handlers/callbacks and preserves blank/invalid completion validation', () => {
    mount(); create(1); const completion = retained(button('Complete Bench Press set 1'), 'onClick'); captureOnly = true; fireEvent.click(button('Complete Bench Press set 1')); const callback = captured; expect(() => callback(live)).toThrow('session changed'); captureOnly = false
    fireEvent.click(button('Complete Bench Press set 1')); const rest = live.activeSession!.restUntil; const before = commits; act(() => completion()); expect(commits).toBe(before); expect(live.activeSession!.restUntil).toBe(rest)
    input('Barbell Row set 1 weight', '.'); fireEvent.click(button('Complete Barbell Row set 1')); expect(screen.getByRole('alert')).toBeInTheDocument(); expect(live.activeSession!.sets.find(set => set.exerciseId === live.activeSession!.workout.exercises[1].id)!.completed).toBe(false)
    input('Barbell Row set 1 reps', ''); expect(button('Complete Barbell Row set 1')).toBeDisabled()
  })

  it('protects grouped warm-up/removal controls and retained paths; allows reviewed metadata-only ungrouping after undo', () => {
    mount(); const oldRemove = retained(button('Remove Bench Press set 1'), 'onClick'); const oldWarm = retained(screen.getByLabelText('Bench Press set 1 warm-up'), 'onChange'); create(1); const before = structuredClone(live)
    expect(button('Remove Bench Press set 1')).toBeDisabled(); expect(screen.getByLabelText('Bench Press set 1 warm-up')).toBeDisabled(); act(() => { oldRemove(); oldWarm({ target: { checked: true } }) }); expect(live).toEqual(before)
    const currentRemove = retained(button('Remove Bench Press set 1'), 'onClick'); const currentWarm = retained(screen.getByLabelText('Bench Press set 1 warm-up'), 'onChange'); act(() => { currentRemove(); currentWarm({ target: { checked: true } }) }); expect(live).toEqual(before)
    fireEvent.click(button('Complete Bench Press set 1')); expect(button('Review removal of My pair')).toBeDisabled(); fireEvent.click(button('Undo Bench Press set 1')); input('Bench Press set 1 weight', '.')
    const rows = structuredClone(live.activeSession!.sets); const timer = live.activeSession!.restUntil; fireEvent.click(button('Review removal of My pair')); failSave = true; fireEvent.click(button('Confirm removal of grouping')); expect(live.activeSession!.grouping).toBeDefined(); expect(weight()).toHaveValue('.')
    failSave = false; fireEvent.click(button('Confirm removal of grouping')); expect(live.activeSession!.grouping).toBeUndefined(); expect(live.activeSession!.sets).toEqual(rows); expect(live.activeSession!.restUntil).toBe(timer); expect(weight()).toHaveValue('.')
  })

  it('leaves added rows ungrouped and reviews exact replacement impacts without changing group/round identities', () => {
    mount(); create(2); fireEvent.click(button('Complete Bench Press set 1')); const original = structuredClone(live.activeSession!.grouping!); const completedId = original.groups[0].rounds[0].setIds[0]
    fireEvent.click(screen.getAllByRole('button', { name: 'Add set' })[0]); const addedId = live.activeSession!.sets.at(-1)!.id; expect(live.activeSession!.grouping).toEqual(original)
    fireEvent.click(button('Replace unfinished Bench Press sets')); fireEvent.click(button('Choose Front Plank')); expect(screen.getByRole('list', { name: 'Grouping replacement impacts' })).toHaveTextContent('My pair · round 2'); expect(screen.getByText(/Completed references, group IDs, round IDs/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Confirm replacement and reset/ })); const group = live.activeSession!.grouping!.groups[0]
    expect(group.id).toBe(original.groups[0].id); expect(group.rounds.map(round => round.id)).toEqual(original.groups[0].rounds.map(round => round.id)); expect(group.rounds[0].setIds[0]).toBe(completedId); expect(group.rounds[1].setIds[0]).not.toBe(original.groups[0].rounds[1].setIds[0]); expect(live.activeSession!.sets.some(set => set.id === addedId)).toBe(false)
    expect(group.rounds.flatMap(round => round.setIds)).toHaveLength(4)
  })

  it('revokes a deferred replacement reducer before it can remap group references', () => {
    mount(); create(1); const grouping = structuredClone(live.activeSession!.grouping)
    fireEvent.click(button('Replace unfinished Bench Press sets')); fireEvent.click(button('Choose Front Plank')); captureOnly = true
    fireEvent.click(screen.getByRole('button', { name: /Confirm replacement and reset/ })); const callback = captured
    expect(() => callback(live)).toThrow('no longer current'); expect(live.activeSession!.grouping).toEqual(grouping)
    captureOnly = false; fireEvent.click(screen.getByRole('button', { name: /Confirm replacement and reset/ })); expect(live.activeSession!.grouping!.groups[0].rounds[0].setIds[0]).not.toBe(grouping!.groups[0].rounds[0].setIds[0])
  })

  it('stores partial rounds and displays exact historical snapshots after current plans change', () => {
    mount(); create(2); fireEvent.click(button('Complete Bench Press set 1')); const grouping = structuredClone(live.activeSession!.grouping); fireEvent.click(button('Finish and save workout')); expect(live.logs[0].grouping).toEqual(grouping)
    act(() => replaceState({ ...live, workouts: live.workouts.map(workout => ({ ...workout, exercises: workout.exercises.map(exercise => ({ ...exercise, name: 'Today renamed' })) })) }))
    const detail = screen.getByRole('region', { name: 'Recorded group My pair' }); expect(within(detail).getByText('Round 1: Unfinished')).toBeInTheDocument(); expect(within(detail).getByText(/Bench Press · set 1 · source row 1 · Marked complete/)).toBeInTheDocument(); expect(within(detail).queryByText(/Today renamed/)).not.toBeInTheDocument(); expect(live.logs[0].grouping).toEqual(grouping)
  })
})
