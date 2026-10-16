// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import PlanEditor from './PlanEditor'
import ScheduleBuilder from './ScheduleBuilder'
import ExercisePicker from './ExercisePicker'
import type { UpdateState } from './WorkoutSession'
import { freshState } from '../storage'
import { parseState } from '../stateValidation'
import { readPlanDraft } from '../planDraft'
import { startSession, finishSession } from '../session'
import type { AppState } from '../types'

let live: AppState
let generation = 0
let fail = false
let capture = false
let commits = 0
let lastChange: Parameters<UpdateState>[0]
let replace: (state: AppState) => void
let beforeChange: (() => void) | null = null
const setup = () => {
  const state = freshState()
  state.workouts = state.workouts.slice(0, 3).map((workout, index) => ({ ...workout, title: ['Known equipment', 'Explicit no equipment', 'Unknown equipment'][index], exercises: [{ ...workout.exercises[0], name: ['Known lift', 'No equipment move', 'Unknown move'][index] }] }))
  state.workouts[0].exercises[0].equipment = ['dumbbells', 'bench']
  state.workouts[1].exercises[0].equipment = []
  state.activeSession = startSession(state.workouts[0])
  state.activeSession.sets[0] = { ...state.activeSession.sets[0], reps: 8, weightKg: 30, completed: true }
  state.logs = [finishSession({ ...state.activeSession, id: 'previous-completed-session', elapsedSeconds: 60 })]
  state.planHistory = [{ id: 'prior', label: 'Before equipment edit', savedAt: new Date().toISOString(), workouts: structuredClone(state.workouts) }]
  parseState(state)
  return state
}
function View({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial)
  const navigate = useNavigate()
  live = state
  replace = next => { generation++; live = next; setState(next) }
  const update: UpdateState = change => {
    lastChange = change
    if (capture) return false
    try {
      beforeChange?.(); beforeChange = null
      const next = change(live)
      parseState(next)
      if (fail) return false
      commits++; generation++; live = next; setState(next); return true
    } catch { return false }
  }
  return <><button onClick={() => navigate('/plan?changed')}>Change plan route</button><button onClick={() => navigate('/schedule?changed')}>Change schedule route</button><button onClick={() => navigate(-1)}>Router back</button><Routes>
    <Route path="/plan" element={<PlanEditor state={state} update={update} readGeneration={() => generation} />} />
    <Route path="/schedule" element={<ScheduleBuilder state={state} update={update} readGeneration={() => generation} />} />
  </Routes></>
}
const mount = (path = '/plan', state = setup()) => render(<StrictMode><MemoryRouter initialEntries={[path]}><View initial={state} /></MemoryRouter></StrictMode>)
const handler = (element: HTMLElement, name = 'onClick') => {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][name]
}
const save = () => fireEvent.click(screen.getByRole('button', { name: /Save workout plan/ }))
const enable = () => fireEvent.click(screen.getByLabelText('Compare with equipment available now'))
const temporary = () => screen.getByRole('group', { name: 'Temporary available equipment' })
const preview = () => { fireEvent.click(screen.getByLabelText('Monday')); fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' })) }
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply this schedule' }))
beforeEach(() => { sessionStorage.clear(); generation = 0; fail = false; capture = false; commits = 0; beforeChange = null; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('explicit equipment plan editing', () => {
  it('starts comparison off, distinguishes all requirement modes, and refuses an empty listed requirement', () => {
    mount()
    expect(screen.getByLabelText('Compare with equipment available now')).not.toBeChecked()
    expect(screen.getByLabelText('Exercise 1 equipment requirements')).toHaveValue('listed')
    fireEvent.change(screen.getByLabelText('Exercise 1 equipment requirements'), { target: { value: 'unknown' } })
    expect(within(screen.getByRole('group', { name: 'Exercise 1' })).getByText('Equipment: Equipment not specified')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Exercise 1 equipment requirements'), { target: { value: 'listed' } })
    save(); expect(commits).toBe(0); expect(readPlanDraft()!.exercises[0].equipment).toBeUndefined()
    expect(screen.getByText(/Select at least one category/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Exercise 1 requires Dumbbells')); save()
    expect(live.workouts[0].exercises[0].equipment).toEqual(['dumbbells'])
    fireEvent.click(screen.getByLabelText('Exercise 1 requires Dumbbells')); save(); expect(commits).toBe(1)
    fireEvent.change(screen.getByLabelText('Exercise 1 equipment requirements'), { target: { value: 'none' } }); save()
    expect(live.workouts[0].exercises[0].equipment).toEqual([])
  })
  it('shows missing and fully matched categories without changing targets or historical/active records', () => {
    const state = setup(); const old = structuredClone(state); mount('/plan', state); enable()
    expect(screen.getAllByText('Missing: Dumbbells, Bench')[0]).toBeInTheDocument()
    fireEvent.click(within(temporary()).getByLabelText('Dumbbells'))
    expect(screen.getAllByText('Missing: Bench')[0]).toBeInTheDocument()
    fireEvent.click(within(temporary()).getByLabelText('Bench'))
    expect(screen.getAllByText('Equipment matched')[0]).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Exercise 1 equipment requirements'), { target: { value: 'none' } }); save()
    expect(live.workouts[0].exercises[0]).toMatchObject({ sets: old.workouts[0].exercises[0].sets, reps: old.workouts[0].exercises[0].reps, equipment: [] })
    expect(live.activeSession).toEqual(old.activeSession); expect(live.logs).toEqual(old.logs)
    expect(live.planHistory[0].workouts).toEqual(old.workouts)
    expect(JSON.stringify(live)).not.toContain('available')
    fireEvent.click(screen.getByRole('link', { name: 'Build a weekly schedule' }))
    expect(screen.getByLabelText('Compare with equipment available now')).not.toBeChecked()
  })
  it('retains equipment and raw field drafts on failed storage, then retries once', () => {
    const state = setup(); mount('/plan', state)
    fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Unsaved equipment plan' } })
    fireEvent.change(screen.getByLabelText('Exercise 1 equipment requirements'), { target: { value: 'none' } })
    fail = true; save(); const failed = lastChange
    expect(screen.getByLabelText('Workout title')).toHaveValue('Unsaved equipment plan'); expect(readPlanDraft()!.exercises[0].equipment).toEqual([])
    expect(live).toBe(state); expect(() => failed(state)).toThrow()
    fail = false; save(); expect(commits).toBe(1); expect(readPlanDraft()).toBeNull()
    expect(live.workouts[0].title).toBe('Unsaved equipment plan')
  })
  it.each(['draft', 'availability', 'route', 'unmount', 'source', 'identical restore'])('rejects retained save handlers after %s', boundary => {
    const view = mount(); fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Draft' } })
    const submit = handler(screen.getByLabelText('Workout title').closest('form')!, 'onSubmit')
    if (boundary === 'draft') fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Newer draft' } })
    if (boundary === 'availability') enable()
    if (boundary === 'route') fireEvent.click(screen.getByRole('button', { name: 'Change plan route' }))
    if (boundary === 'unmount') view.unmount()
    if (boundary === 'source') act(() => replace(structuredClone(live)))
    if (boundary === 'identical restore') act(() => { replace(live) })
    act(() => submit({ preventDefault() {} })); expect(commits).toBe(0)
  })
  it('does not permit a new save handler to overwrite a changed source with an old draft', () => {
    mount(); fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Old draft' } })
    act(() => replace({ ...live, workouts: live.workouts.map(workout => ({ ...workout, title: `Restored ${workout.title}` })) }))
    save(); expect(commits).toBe(0); expect(screen.getByLabelText('Workout title')).toHaveValue('Old draft')
    fireEvent.click(screen.getByRole('button', { name: 'Monday: Restored Known equipment' })); save(); expect(commits).toBe(1)
  })
  it('rejects a retained restore handler after draft changes and uses current revision when fresh', () => {
    mount(); fireEvent.click(screen.getByText(/Previous plan versions/))
    const retained = handler(screen.getByRole('button', { name: 'Restore version' }))
    fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Newer draft' } })
    act(() => retained()); expect(commits).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Restore version' })); expect(commits).toBe(1)
    expect(screen.getByLabelText('Workout title')).toHaveValue('Known equipment')
  })
})

describe('equipment-aware library selection', () => {
  it('composes category and text with matched-only, excludes unknowns, and allows manual choices when off', () => {
    const state = setup(); const add = vi.fn()
    render(<ExercisePicker workouts={state.workouts} availableEquipment={[]} disabled={false} onAdd={add} />)
    fireEvent.click(screen.getByText('Add from exercise library'))
    fireEvent.click(screen.getByLabelText('Only show equipment-matched exercises'))
    expect(screen.getByRole('button', { name: 'Add No equipment move' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Unknown move' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Known lift' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search exercise library'), { target: { value: 'Unknown move' } })
    expect(screen.getByRole('status')).toHaveTextContent('0 matching entries')
    fireEvent.click(screen.getByLabelText('Only show equipment-matched exercises'))
    fireEvent.change(screen.getByLabelText('Exercise category'), { target: { value: state.workouts[2].exercises[0].category } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Unknown move' })); expect(add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Unknown move' }))
  })
  it.each(['query', 'category', 'filter', 'availability', 'source', 'disabled', 'unmount'])('rejects retained entry handlers after %s', boundary => {
    const state = setup(); const add = vi.fn()
    const view = render(<ExercisePicker workouts={state.workouts} availableEquipment={[]} disabled={false} onAdd={add} />)
    fireEvent.click(screen.getByText('Add from exercise library'))
    const select = handler(screen.getByRole('button', { name: 'Add Known lift' }))
    if (boundary === 'query') fireEvent.change(screen.getByLabelText('Search exercise library'), { target: { value: 'different' } })
    if (boundary === 'category') fireEvent.change(screen.getByLabelText('Exercise category'), { target: { value: 'Core' } })
    if (boundary === 'filter') fireEvent.click(screen.getByLabelText('Only show equipment-matched exercises'))
    if (boundary === 'availability') view.rerender(<ExercisePicker workouts={state.workouts} availableEquipment={['bench']} disabled={false} onAdd={add} />)
    if (boundary === 'source') view.rerender(<ExercisePicker workouts={structuredClone(state.workouts)} availableEquipment={[]} disabled={false} onAdd={add} />)
    if (boundary === 'disabled') view.rerender(<ExercisePicker workouts={state.workouts} availableEquipment={[]} disabled onAdd={add} />)
    if (boundary === 'unmount') view.unmount()
    act(() => select()); expect(add).not.toHaveBeenCalled()
  })
})

describe('equipment-aware weekly schedule review', () => {
  it('keeps selected sessions when restriction conflicts, explains unknown/missing, and makes no automatic substitutions', () => {
    const state = setup(); mount('/schedule', state)
    fireEvent.click(screen.getByLabelText('Monday')); enable()
    fireEvent.click(screen.getByLabelText('Only allow fully equipment-matched sessions'))
    expect(screen.getByLabelText('Session for Monday')).toHaveValue(state.workouts[0].id)
    expect(screen.getAllByText('Missing: Dumbbells, Bench')[0]).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' }))
    expect(screen.getByRole('alert')).toHaveTextContent('missing equipment or unknown requirements'); expect(commits).toBe(0)
    fireEvent.change(screen.getByLabelText('Session for Monday'), { target: { value: state.workouts[1].id } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' })); apply()
    expect(commits).toBe(1); expect(live.workouts).toHaveLength(1); expect(live.workouts[0].exercises).toEqual(state.workouts[1].exercises)
    expect(live.activeSession).toEqual(state.activeSession); expect(live.logs).toEqual(state.logs)
  })
  it.each(['equipment', 'restriction', 'time', 'day', 'session', 'keep editing', 'source', 'route', 'identical restore', 'unmount'])('revokes a retained schedule apply after %s', boundary => {
    const view = mount('/schedule'); preview()
    const retained = handler(screen.getByRole('button', { name: 'Apply this schedule' }))
    if (boundary === 'equipment') enable()
    if (boundary === 'restriction') { enable(); fireEvent.click(screen.getByLabelText('Only allow fully equipment-matched sessions')) }
    if (boundary === 'time') fireEvent.change(screen.getByLabelText('Maximum planned minutes per session'), { target: { value: '55' } })
    if (boundary === 'day') fireEvent.click(screen.getByLabelText('Tuesday'))
    if (boundary === 'session') fireEvent.change(screen.getByLabelText('Session for Monday'), { target: { value: live.workouts[1].id } })
    if (boundary === 'keep editing') fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    if (boundary === 'source') act(() => replace(structuredClone(live)))
    if (boundary === 'identical restore') act(() => { replace(live) })
    if (boundary === 'route') fireEvent.click(screen.getByRole('button', { name: 'Change schedule route' }))
    if (boundary === 'unmount') view.unmount()
    act(() => retained()); expect(commits).toBe(0)
    if (boundary !== 'unmount') expect(screen.queryByRole('button', { name: 'Apply this schedule' })).not.toBeInTheDocument()
  })
  it('rejects source changes during confirmation and retains an unchanged review after failed persistence', () => {
    mount('/schedule'); preview(); const initial = live
    fail = true; apply(); const failed = lastChange
    expect(live).toBe(initial); expect(screen.getByRole('alert')).toHaveTextContent('not saved'); expect(() => failed(initial)).toThrow()
    fail = false; beforeChange = () => { generation++ }; apply(); expect(commits).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' })); apply(); expect(commits).toBe(1)
  })
})
