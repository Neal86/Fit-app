// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import PlanEditor from './PlanEditor'
import ScheduleBuilder from './ScheduleBuilder'
import WorkoutSession from './WorkoutSession'
import type { UpdateState } from './WorkoutSession'
import type { AppState, Workout } from '../types'
import { freshState, parseState } from '../storage'
import { PLAN_DRAFT_KEY, readPlanDraft } from '../planDraft'
import { applyPlannedGrouping, reviewPlannedGrouping } from '../plannedGrouping'
import { startSession } from '../session'
import { plannedSlotKey } from './plannedGroupLabels'

let live: AppState
let generation = 0
let commits = 0
let fail = false
let captureOnly = false
let captured: Parameters<UpdateState>[0]
let replaceState: (state: AppState) => void
let beforeChange: (() => void) | undefined
function View({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const navigate = useNavigate(); live = state
  replaceState = next => { live = next; generation++; setState(next) }
  const update: UpdateState = change => {
    captured = change
    if (captureOnly) return false
    try {
      beforeChange?.(); beforeChange = undefined
      const next = change(live); parseState(next)
      if (fail) return false
      commits++; live = next; generation++; setState(next); return true
    } catch { return false }
  }
  return <><button onClick={() => navigate('/away')}>Away</button><button onClick={() => navigate('/plan?other=1')}>Plan query</button><button onClick={() => navigate(-1)}>Back route</button><Routes><Route path="/plan" element={<PlanEditor state={state} update={update} readGeneration={() => generation} />} /><Route path="/schedule" element={<ScheduleBuilder state={state} update={update} readGeneration={() => generation} />} /><Route path="/workouts/:id" element={<WorkoutSession state={state} update={update} readGeneration={() => generation} />} /><Route path="/away" element={<p>Other page</p>} /></Routes></>
}
const button = (name: string) => screen.getByRole('button', { name })
const input = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
const mount = (state = freshState(), path = '/plan', strict = false) => render(strict ? <StrictMode><MemoryRouter initialEntries={[path]}><View initial={state} /></MemoryRouter></StrictMode> : <MemoryRouter initialEntries={[path]}><View initial={state} /></MemoryRouter>)
const retained = (element: Element, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
const save = () => screen.getByRole('button', { name: /Save workout plan/ })
const editField = (label: string, value: string, index = 0) => fireEvent.change(screen.getAllByLabelText(label)[index], { target: { value } })
function fill(workout = live.workouts[0], rounds = 2) {
  input('Planned group name', 'My exact pair'); input('Planned round count (1–20)', String(rounds)); input('Planned round rest (seconds, 0–900)', '45')
  const exercises = [workout.exercises[1], workout.exercises[0]]
  exercises.forEach((exercise, column) => input(`Planned movement ${column + 1}`, exercise.id))
  for (let round = 0; round < rounds; round++) exercises.forEach((exercise, column) => input(`Planned round ${round + 1} movement ${column + 1} row`, plannedSlotKey({ exerciseId: exercise.id, setNumber: round === 0 ? 3 : 1 })))
}
const review = () => { fireEvent.click(button('Create saved plan group')); fill(); fireEvent.click(button('Review planned group')) }
const create = () => { review(); fireEvent.click(button('Confirm group in draft')) }
function grouped() {
  const state = freshState(); const workout = state.workouts[0]
  state.workouts[0] = applyPlannedGrouping(workout, reviewPlannedGrouping(workout, { name: 'My exact pair', restSeconds: 45, rounds: [[{ exerciseId: workout.exercises[1].id, setNumber: 3 }, { exerciseId: workout.exercises[0].id, setNumber: 1 }]] }), { reserved: state })
  return state
}
beforeEach(() => { generation = 0; commits = 0; fail = false; captureOnly = false; beforeChange = undefined; sessionStorage.clear(); localStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('explicit planned grouping authoring', { timeout: 30000 }, () => {
  it('starts blank, requires every explicit cell, then reviews exact ordered nonconsecutive slots and unequal extras', () => {
    const state = freshState(); mount(state); fireEvent.click(button('Create saved plan group')); input('Planned round count (1–20)', '2')
    expect(screen.getByLabelText('Planned movement 1')).toHaveValue(''); expect(screen.getByLabelText('Planned round 1 movement 1 row')).toHaveValue('')
    fill(); input('Planned round 2 movement 2 row', ''); fireEvent.click(button('Review planned group')); expect(screen.getByRole('alert')).toHaveTextContent('Explicitly select')
    input('Planned round 2 movement 2 row', plannedSlotKey({ exerciseId: state.workouts[0].exercises[0].id, setNumber: 1 })); fireEvent.click(button('Review planned group'))
    const rounds = screen.getByRole('list', { name: 'Exact reviewed planned rounds' })
    expect(rounds.children[0]).toHaveTextContent('Barbell Row (exercise 2) · planned set 3Bench Press (exercise 1) · planned set 3')
    expect(rounds.children[1]).toHaveTextContent('Barbell Row (exercise 2) · planned set 1Bench Press (exercise 1) · planned set 1')
    expect(screen.getByRole('list', { name: 'Planned rows remaining ungrouped' }).children).toHaveLength(state.workouts[0].exercises.reduce((n, exercise) => n + exercise.sets, 0) - 4)
    expect(screen.getByText(/Older strict builds or APIs may reject/)).toBeInTheDocument(); expect(commits).toBe(0)
    fireEvent.click(button('Confirm group in draft')); expect(readPlanDraft()!.plannedGrouping!.groups[0].rounds).toHaveLength(2); expect(live).toBe(state)
    fireEvent.click(save()); expect(commits).toBe(1); expect(live.workouts[0].plannedGrouping!.groups[0].name).toBe('My exact pair'); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBeNull()
  })

  it('works immediately in StrictMode and preserves incomplete unrelated fields until a valid explicit save', () => {
    mount(freshState(), '/plan', true); input('Workout title', ''); input('Planned minutes', ''); create()
    expect(readPlanDraft()).toMatchObject({ title: '', duration: 0, plannedGrouping: { version: 1 } }); expect(commits).toBe(0)
    input('Workout title', 'My workout'); input('Planned minutes', '37'); fireEvent.click(save()); expect(commits).toBe(1); expect(live.workouts[0].duration).toBe(37)
  })

  it.each([['Planned round count (1–20)', '0'], ['Planned round count (1–20)', '21'], ['Planned round count (1–20)', '1e1'], ['Planned round rest (seconds, 0–900)', ''], ['Planned round rest (seconds, 0–900)', '-1'], ['Planned round rest (seconds, 0–900)', '901'], ['Planned group name', ' ']])('rejects incomplete or invalid %s = %s', (label, value) => {
    mount(); fireEvent.click(button('Create saved plan group')); fill(); input(label, value); fireEvent.click(button('Review planned group')); expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Confirm group in draft' })).not.toBeInTheDocument(); expect(commits).toBe(0)
  })

  it('preserves the entire saved draft after storage failure and revokes a failed updater before a fresh retry', () => {
    const state = freshState(); mount(state); create(); input('Description', 'Keep my exact draft'); const raw = sessionStorage.getItem(PLAN_DRAFT_KEY)
    fail = true; fireEvent.click(save()); const callback = captured
    expect(live).toBe(state); expect(screen.getByRole('alert')).toHaveTextContent('not saved'); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(raw); expect(() => callback(state)).toThrow()
    fail = false; const submit = retained(save().closest('form')!, 'onSubmit'); act(() => { submit({ preventDefault() {} }); submit({ preventDefault() {} }) })
    expect(commits).toBe(1); expect(live.workouts[0].description).toBe('Keep my exact draft'); expect(() => captured(live)).toThrow()
  })

  it('keeps a pending group review and exact raw form through a failed plan save', () => {
    mount(); review(); fail = true; fireEvent.click(save()); const callback = captured
    expect(button('Confirm group in draft')).toBeEnabled(); expect(screen.getByRole('list', { name: 'Exact reviewed planned rounds' })).toHaveTextContent('planned set 3'); expect(() => callback(live)).toThrow()
    fireEvent.click(button('Back to planned group details')); expect(screen.getByLabelText('Planned group name')).toHaveValue('My exact pair'); expect(screen.getByLabelText('Planned round count (1–20)')).toHaveValue('2'); expect(screen.getByLabelText('Planned round rest (seconds, 0–900)')).toHaveValue('45')
    expect(screen.getByLabelText('Planned round 1 movement 1 row')).toHaveValue(plannedSlotKey({ exerciseId: live.workouts[0].exercises[1].id, setNumber: 3 })); fireEvent.click(button('Review planned group')); fireEvent.click(button('Confirm group in draft')); fail = false; fireEvent.click(save()); expect(commits).toBe(1)
  })

  it('distinguishes duplicate movement labels and preserves cells outside a deliberately changed column', () => {
    const state = freshState(); state.workouts[0].exercises[1].name = state.workouts[0].exercises[0].name; state.workouts[0].exercises[1].reps = '30 sec'; mount(state); fireEvent.click(button('Create saved plan group')); fill()
    fireEvent.click(button('Add planned movement slot')); input('Planned movement 3', state.workouts[0].exercises[2].id)
    expect(screen.getByLabelText('Planned round 1 movement 3 row')).toHaveValue(''); expect(screen.getByLabelText('Planned round 1 movement 1 row')).not.toHaveValue(''); fireEvent.click(button('Remove last planned movement slot'))
    fireEvent.click(button('Review planned group')); const rounds = screen.getByRole('list', { name: 'Exact reviewed planned rounds' }); expect(within(rounds).getByText('Bench Press (exercise 1) · planned set 3')).toBeInTheDocument(); expect(within(rounds).getByText('Bench Press (exercise 2) · planned set 3')).toBeInTheDocument(); fireEvent.click(button('Confirm group in draft'))
    fireEvent.click(button('Create saved plan group')); input('Planned round count (1–20)', '1'); input('Planned movement 1', state.workouts[0].exercises[1].id)
    expect(within(screen.getByLabelText('Planned round 1 movement 1 row')).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).not.toContain(plannedSlotKey({ exerciseId: state.workouts[0].exercises[1].id, setNumber: 3 }))
  })

  it('recovers exact saved grouping with incomplete referenced counts and allows explicit reviewed removal', () => {
    const state = grouped(); const draft: Workout = structuredClone(state.workouts[0]); draft.title = ''; draft.duration = 0; draft.exercises[1].sets = 0
    sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(draft)); mount(state)
    expect(screen.getByLabelText('Workout title')).toHaveValue(''); expect(screen.getAllByLabelText('Sets')[1]).toHaveValue(0); expect(readPlanDraft()).toEqual(draft)
    fireEvent.click(button('Review removal of My exact pair')); expect(screen.getByRole('list', { name: 'Exact reviewed planned rounds' })).toHaveTextContent('planned set 3')
    fireEvent.click(button('Confirm group removal in draft')); expect(readPlanDraft()!.plannedGrouping).toBeUndefined(); expect(live.workouts[0].plannedGrouping).toBeDefined()
    input('Workout title', 'Recovered workout'); input('Planned minutes', '38'); editField('Sets', '3', 1); fireEvent.click(save()); expect(commits).toBe(1); expect(live.workouts[0].plannedGrouping).toBeUndefined()
  })

  it('blocks referenced deletion/reduction, permits added rows, and removes only after exact review', () => {
    const state = grouped(); mount(state); editField('Sets', '2', 1); expect(screen.getByRole('alert')).toHaveTextContent(/Remove.*group.*first/i); expect(screen.getAllByLabelText('Sets')[1]).toHaveValue(4)
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove exercise' })[1]); expect(screen.getByRole('alert')).toHaveTextContent(/Remove.*group.*first/i); expect(screen.getAllByLabelText('Exercise name')).toHaveLength(state.workouts[0].exercises.length)
    editField('Sets', '5', 1); expect(readPlanDraft()!.plannedGrouping).toEqual(state.workouts[0].plannedGrouping)
    fireEvent.click(button('Review removal of My exact pair')); fireEvent.click(button('Cancel planned grouping')); expect(readPlanDraft()!.plannedGrouping).toBeDefined()
    fireEvent.click(button('Review removal of My exact pair')); fireEvent.click(button('Confirm group removal in draft')); fireEvent.click(screen.getAllByRole('button', { name: 'Remove exercise' })[1]); fireEvent.click(save())
    expect(live.workouts[0].plannedGrouping).toBeUndefined(); expect(live.workouts[0].exercises).toHaveLength(state.workouts[0].exercises.length - 1)
  })

  it('atomically remaps a renamed movement and preserves duration, estimates, original history and active session', () => {
    const state = grouped(); state.activeSession = startSession(state.workouts[0]); const original = structuredClone(state); mount(state)
    editField('Exercise name', 'My row', 1); fireEvent.click(save()); const next = live.workouts[0]
    expect(next.exercises[1].id).not.toBe(original.workouts[0].exercises[1].id); expect(next.plannedGrouping!.groups[0].rounds[0].members[0].exerciseId).toBe(next.exercises[1].id)
    expect(next.duration).toBe(original.workouts[0].duration); expect(next.calories).toBe(original.workouts[0].calories); expect(live.planHistory[0].workouts).toEqual(original.workouts); expect(live.activeSession).toEqual(original.activeSession)
  })

  it('discloses copied saved groups in schedule review and preserves exact definitions with independent copied IDs', () => {
    const state = grouped(); mount(state, '/schedule'); fireEvent.click(screen.getByLabelText('Monday')); fireEvent.click(screen.getByLabelText('Tuesday')); fireEvent.click(button('Preview weekly schedule'))
    expect(screen.getAllByRole('region', { name: `Saved plan groups for ${state.workouts[0].title}` })).toHaveLength(2); expect(screen.getAllByText(/Older strict builds or APIs may reject/)).toHaveLength(2)
    fireEvent.click(button('Apply this schedule')); expect(commits).toBe(1); const [first, second] = live.workouts
    expect(first.plannedGrouping).toEqual(state.workouts[0].plannedGrouping); expect(second.plannedGrouping!.groups[0].id).not.toBe(first.plannedGrouping!.groups[0].id); expect(second.plannedGrouping!.groups[0].rounds[0].members[0].exerciseId).toBe(second.exercises[1].id)
    expect([first.duration, second.duration]).toEqual([state.workouts[0].duration, state.workouts[0].duration])
  })
})

describe('planned grouping UI lifetime', { timeout: 30000 }, () => {
  it('revokes retained review and cancel immediately after a new raw edit without discarding that edit', () => {
    mount(); fireEvent.click(button('Create saved plan group')); fill(); const submit = retained(button('Review planned group'), 'onClick'); const cancel = retained(button('Cancel planned grouping'), 'onClick'); const edit = retained(screen.getByLabelText('Planned group name'), 'onChange')
    act(() => { edit({ target: { value: 'New raw name' } }); submit(); cancel() }); expect(screen.getByLabelText('Planned group name')).toHaveValue('New raw name'); expect(screen.queryByRole('button', { name: 'Confirm group in draft' })).not.toBeInTheDocument()
  })

  it('rejects old Cancel in the same batch as an outer draft edit but allows the current stale-review Cancel', () => {
    mount(); review(); const cancel = retained(button('Cancel planned grouping'), 'onClick'); const edit = retained(screen.getByLabelText('Description'), 'onChange')
    act(() => { edit({ target: { value: 'new outer draft' } }); cancel() }); expect(button('Confirm group in draft')).toBeDisabled(); expect(screen.getByLabelText('Description')).toHaveValue('new outer draft')
    fireEvent.click(button('Cancel planned grouping')); expect(button('Create saved plan group')).toBeEnabled(); expect(screen.getByLabelText('Description')).toHaveValue('new outer draft')
  })

  it.each(['title', 'normalized-number', 'source', 'generation', 'route', 'query', 'back', 'cancel', 'unmount'])('revokes retained draft confirmation after %s', boundary => {
    const view = mount(); review(); const confirm = retained(button('Confirm group in draft'), 'onClick')
    if (boundary === 'title') { input('Workout title', 'Edited'); input('Workout title', live.workouts[0].title) }
    if (boundary === 'normalized-number') input('Planned minutes', `0${live.workouts[0].duration}`)
    if (boundary === 'source') act(() => replaceState(structuredClone(live)))
    if (boundary === 'generation') act(() => { generation++ })
    if (boundary === 'route') { fireEvent.click(button('Away')); fireEvent.click(button('Back route')) }
    if (boundary === 'query') { fireEvent.click(button('Plan query')); fireEvent.click(button('Back route')) }
    if (boundary === 'back') { fireEvent.click(button('Back to planned group details')); input('Planned group name', 'New review'); fireEvent.click(button('Review planned group')) }
    if (boundary === 'cancel') { fireEvent.click(button('Cancel planned grouping')); fireEvent.click(button('Create saved plan group')) }
    if (boundary === 'unmount') view.unmount()
    act(() => confirm()); expect(readPlanDraft()?.plannedGrouping).toBeUndefined(); expect(commits).toBe(0)
  })

  it('revokes review after same-batch outer input edit and rejects uninvoked Save callback after false', () => {
    mount(); review(); const confirm = retained(button('Confirm group in draft'), 'onClick'); const edit = retained(screen.getByLabelText('Description'), 'onChange')
    act(() => { edit({ target: { value: 'new draft' } }); confirm() }); expect(readPlanDraft()!.plannedGrouping).toBeUndefined()
    fireEvent.click(button('Cancel planned grouping')); create(); captureOnly = true; fireEvent.click(save()); const callback = captured; expect(() => callback(live)).toThrow(); captureOnly = false; fireEvent.click(save()); expect(commits).toBe(1)
  })
})

describe('saved-group start snapshot and lifetime', { timeout: 30000 }, () => {
  it('shows exact rows before start and instantiates fresh runtime grouping without changing plans or starting rest', () => {
    const state = grouped(); mount(state, '/workouts/upper-power'); const disclosure = screen.getByRole('region', { name: `Saved plan groups for ${state.workouts[0].title}` })
    expect(within(disclosure).getByText('Barbell Row (exercise 2) · planned set 3')).toBeInTheDocument(); const start = retained(button('Start workout'), 'onClick'); act(() => { start(); start() })
    expect(commits).toBe(1); expect(live.activeSession!.grouping!.groups[0].name).toBe('My exact pair'); expect(live.activeSession!.workout.plannedGrouping).toBeUndefined(); expect(live.activeSession!.restUntil).toBeNull(); expect(live.workouts).toEqual(state.workouts)
  })

  it.each(['in-place', 'replace-target', 'generation', 'state', 'route', 'unmount'])('rejects retained Start after %s change', boundary => {
    const state = grouped(); const view = mount(state, '/workouts/upper-power'); const start = retained(button('Start workout'), 'onClick')
    if (boundary === 'in-place') live.workouts[0].plannedGrouping!.groups[0].rounds[0].members[0].setNumber = 2
    if (boundary === 'replace-target') live.workouts[0] = structuredClone(live.workouts[0])
    if (boundary === 'generation') generation++
    if (boundary === 'state') act(() => replaceState(structuredClone(live)))
    if (boundary === 'route') { fireEvent.click(button('Away')); fireEvent.click(button('Back route')) }
    if (boundary === 'unmount') view.unmount()
    act(() => start()); expect(commits).toBe(0); expect(live.activeSession).toBeNull()
  })

  it.each([false, true])('rejects deferred updater after failed start and permits fresh explicit retry (capture-only %s)', capturedOnly => {
    mount(grouped(), '/workouts/upper-power'); captureOnly = capturedOnly; fail = true; fireEvent.click(button('Start workout')); const callback = captured
    expect(screen.getByRole('alert')).toHaveTextContent('not started'); expect(() => callback(live)).toThrow(); expect(live.activeSession).toBeNull()
    captureOnly = false; fail = false; fireEvent.click(button('Start workout')); expect(commits).toBe(1); expect(() => captured(live)).toThrow()
  })

  it.each(['confirmation', 'transaction'])('rejects changed target mapping during %s', boundary => {
    const state = grouped(); state.activeSession = startSession(state.workouts[1]); mount(state, '/workouts/upper-power')
    const mutate = () => { live.workouts[0].plannedGrouping!.groups[0].rounds[0].members[0].setNumber = 2 }
    if (boundary === 'confirmation') vi.mocked(window.confirm).mockImplementation(() => { mutate(); return true })
    else beforeChange = mutate
    fireEvent.click(button('Start workout')); expect(commits).toBe(0); expect(live.activeSession).toBe(state.activeSession)
  })
})
