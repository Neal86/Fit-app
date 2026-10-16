// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import PlanEditor from './PlanEditor'
import ScheduleBuilder from './ScheduleBuilder'
import type { UpdateState } from './WorkoutSession'
import type { AppState } from '../types'
import { freshState, parseState } from '../storage'
import { PLAN_DRAFT_KEY } from '../planDraft'

let live: AppState
let generation = 0
let saves = 0
let failed = false
let captured: Parameters<UpdateState>[0]
let replace: (state: AppState) => void
let beforeChange: (() => void) | undefined
function View({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial)
  live = state
  replace = next => { live = next; generation++; setState(next) }
  const navigate = useNavigate()
  const update: UpdateState = change => {
    captured = change
    try {
      beforeChange?.(); beforeChange = undefined
      const next = change(live)
      parseState(next)
      if (failed) return false
      live = next; generation++; saves++; setState(next); return true
    } catch { return false }
  }
  return <><button onClick={() => navigate('/away')}>Go away</button><button onClick={() => navigate(-1)}>Go back</button><Routes>
    <Route path="/plan" element={<PlanEditor state={state} update={update} readGeneration={() => generation} />} />
    <Route path="/schedule" element={<ScheduleBuilder state={state} update={update} readGeneration={() => generation} />} />
    <Route path="/away" element={<p>Away</p>} />
  </Routes></>
}
const mount = (path = '/schedule', initial = freshState()) => render(<MemoryRouter initialEntries={[path]}><View initial={initial} /></MemoryRouter>)
const retained = (element: Element, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
const preview = () => { fireEvent.click(screen.getByLabelText('Monday')); fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' })) }
const apply = () => screen.getByRole('button', { name: 'Apply this schedule' })
const save = () => screen.getByRole('button', { name: /Save workout plan/ })
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); generation = 0; saves = 0; failed = false; beforeChange = undefined; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('independent equipment UI lifetime review', () => {
  it.each(['time', 'keep editing', 'availability'])('rejects a retained apply after %s changed in the same batch', boundary => {
    mount(); preview()
    const oldApply = retained(apply(), 'onClick')
    const edit = boundary === 'time' ? retained(screen.getByLabelText('Maximum planned minutes per session'), 'onChange') : boundary === 'keep editing' ? retained(screen.getByRole('button', { name: 'Keep editing' }), 'onClick') : retained(screen.getByLabelText('Compare with equipment available now'), 'onChange')
    act(() => { edit({ target: { value: '45', checked: true } }); oldApply() })
    expect(saves).toBe(0)
    expect(screen.queryByRole('button', { name: 'Apply this schedule' })).not.toBeInTheDocument()
  })

  it('rejects a retained schedule handler and callback after route-away/back and identical restore', () => {
    mount(); preview(); const handler = retained(apply(), 'onClick')
    failed = true; fireEvent.click(apply()); const change = captured
    fireEvent.click(screen.getByRole('button', { name: 'Go away' })); fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    act(() => { replace(live); handler() })
    expect(() => change(live)).toThrow()
    expect(saves).toBe(0)
  })

  it('blocks a generation change arriving inside a schedule transaction, before rerender', () => {
    mount(); preview()
    beforeChange = () => { generation++ }
    fireEvent.click(apply())
    expect(saves).toBe(0)
    expect(live.workouts).toHaveLength(4)
  })

  it('keeps failed schedule draft and permits a fresh explicit retry exactly once', () => {
    mount(); preview(); failed = true
    fireEvent.click(apply()); const failedChange = captured
    expect(apply()).toBeInTheDocument(); expect(screen.getByLabelText('Monday')).toBeChecked()
    failed = false
    const handler = retained(apply(), 'onClick')
    act(() => { handler(); handler() })
    expect(saves).toBe(1); expect(live.workouts).toHaveLength(1)
    expect(() => failedChange(live)).toThrow()
  })

  it('requires every exercise to be known and all equipment present when matching complete sessions', () => {
    const state = freshState()
    state.workouts[0].exercises.forEach(exercise => { exercise.equipment = [] })
    state.workouts[1].exercises.forEach(exercise => { exercise.equipment = ['barbell'] })
    state.workouts[1].exercises[0].equipment = ['barbell', 'weight-plates']
    state.workouts[2].exercises.forEach(exercise => { exercise.equipment = [] })
    delete state.workouts[2].exercises[0].equipment
    mount('/schedule', state)
    fireEvent.click(screen.getByLabelText('Compare with equipment available now'))
    fireEvent.click(screen.getByLabelText('Barbell'))
    fireEvent.click(screen.getByLabelText('Only allow fully equipment-matched sessions'))
    fireEvent.click(screen.getByLabelText('Monday'))
    const select = screen.getByLabelText('Session for Monday')
    const options = within(select).getAllByRole('option')
    expect(options[0]).toBeEnabled()
    expect(options.slice(1).every(option => (option as HTMLOptionElement).disabled)).toBe(true)
    fireEvent.change(select, { target: { value: state.workouts[1].id } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' }))
    expect(screen.queryByRole('button', { name: 'Apply this schedule' })).not.toBeInTheDocument()
    expect(saves).toBe(0)
  })

  it('rejects retained plan save and history restore after raw equipment edits before rerender', () => {
    const state = freshState()
    state.planHistory = [{ id: 'revision', savedAt: '2026-10-15T12:00:00Z', label: 'Prior', workouts: structuredClone(state.workouts) }]
    mount('/plan', state)
    const saveHandler = retained(save().closest('form')!, 'onSubmit')
    const restoreHandler = retained(screen.getByRole('button', { name: 'Restore version' }), 'onClick')
    const change = retained(screen.getByLabelText('Exercise 1 equipment requirements'), 'onChange')
    act(() => { change({ target: { value: 'none' } }); saveHandler({ preventDefault() {} }); restoreHandler() })
    expect(saves).toBe(0)
    expect(screen.getByLabelText('Exercise 1 equipment requirements')).toHaveValue('none')
  })

  it('keeps failed equipment draft and rejects a fresh save after same-data account restore', () => {
    mount('/plan')
    fireEvent.change(screen.getByLabelText('Exercise 1 equipment requirements'), { target: { value: 'none' } })
    failed = true; fireEvent.click(save())
    expect(saves).toBe(0); expect(JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY)!).exercises[0].equipment).toEqual([])
    act(() => replace(structuredClone(live)))
    failed = false; fireEvent.click(save())
    expect(saves).toBe(0); expect(live.workouts[0].exercises[0]).not.toHaveProperty('equipment')
    expect(screen.getByLabelText('Exercise 1 equipment requirements')).toHaveValue('none')
  })

  it('rejects an old library add when search changes before rerender and keeps comparison ephemeral', () => {
    mount('/plan')
    const oldAdd = retained(screen.getByRole('button', { name: 'Add Front Plank' }), 'onClick')
    const search = retained(screen.getByLabelText('Search exercise library'), 'onChange')
    act(() => { search({ target: { value: 'bench' } }); oldAdd() })
    expect(screen.getAllByLabelText('Exercise name')).toHaveLength(5)
    fireEvent.click(screen.getByLabelText('Compare with equipment available now'))
    fireEvent.click(screen.getByLabelText('Barbell'))
    fireEvent.change(screen.getByLabelText('Exercise 1 equipment requirements'), { target: { value: 'none' } })
    fireEvent.click(save())
    expect(saves).toBe(1)
    expect(Object.keys(live).sort()).toEqual(Object.keys(freshState()).sort())
    fireEvent.click(screen.getByRole('button', { name: 'Go away' })); fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(screen.getByLabelText('Compare with equipment available now')).not.toBeChecked()
  })

  it.each(['/plan', '/schedule'])('does not traverse unrelated log history on raw %s edits', path => {
    const state = freshState()
    let historySerializations = 0
    state.logs = new Proxy(state.logs, { get(target, key, receiver) { if (key === 'toJSON') historySerializations++; return Reflect.get(target, key, receiver) } })
    mount(path, state)
    historySerializations = 0
    const input = screen.getByLabelText(path === '/plan' ? 'Workout title' : 'Maximum planned minutes per session')
    fireEvent.change(input, { target: { value: path === '/plan' ? 'Changed title' : '45' } })
    expect(historySerializations).toBe(0)
  })

  it('shows recovered overwrite risk against the current saved workout and preserves canceled or failed drafts', () => {
    const state = freshState()
    state.workouts[0].title = 'Current saved session'
    const recovered = { ...structuredClone(state.workouts[0]), title: 'Older tab draft' }
    recovered.exercises[0].equipment = []
    sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(recovered))
    mount('/plan', state)
    vi.mocked(window.confirm).mockReturnValue(false)
    fireEvent.click(save())
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Current saved session'))
    expect(saves).toBe(0); expect(live).toBe(state)
    expect(screen.getByLabelText('Workout title')).toHaveValue('Older tab draft')
    expect(JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY)!)).toEqual(recovered)
    vi.mocked(window.confirm).mockReturnValue(true); failed = true
    fireEvent.click(save())
    expect(saves).toBe(0); expect(JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY)!)).toEqual(recovered)
    failed = false; fireEvent.click(save())
    expect(saves).toBe(1); expect(live.workouts[0].title).toBe('Older tab draft')
    expect(live.planHistory[0].workouts[0].title).toBe('Current saved session')
    expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBeNull()
  })

  it.each(['generation', 'source'])('rejects recovered draft application if %s changes during confirmation', boundary => {
    const state = freshState()
    const recovered = { ...structuredClone(state.workouts[0]), title: 'Older tab draft' }
    recovered.exercises[0].equipment = []
    sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(recovered))
    mount('/plan', state)
    vi.mocked(window.confirm).mockImplementation(() => {
      if (boundary === 'generation') generation++
      else live.workouts[0].title = 'Changed while confirming'
      return true
    })
    fireEvent.click(save())
    expect(window.confirm).toHaveBeenCalled()
    expect(saves).toBe(0); expect(live.workouts[0].exercises[0]).not.toHaveProperty('equipment')
    expect(screen.getByLabelText('Workout title')).toHaveValue('Older tab draft')
    expect(JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY)!)).toEqual(recovered)
  })

  it.each(['equal', 'new identity'])('handles a recovered %s draft without overwriting unrelated sessions', boundary => {
    const state = freshState()
    const recovered = structuredClone(state.workouts[0])
    if (boundary === 'new identity') { recovered.id = 'recovered-new'; recovered.title = 'New recovered session' }
    sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(recovered))
    mount('/plan', state)
    fireEvent.click(save())
    expect(saves).toBe(1)
    expect(live.workouts.slice(0, state.workouts.length)).toEqual(state.workouts)
    expect(live.workouts).toHaveLength(boundary === 'equal' ? 4 : 5)
    if (boundary === 'new identity') expect(live.workouts[4]).toEqual(recovered)
    expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBeNull()
  })

  it('names the actual saved removal target and draft discard, retaining both on cancel or failure', () => {
    const state = freshState()
    state.workouts[0].title = 'Latest saved workout'
    const recovered = { ...structuredClone(state.workouts[0]), title: 'Older recovered name' }
    recovered.exercises[0].equipment = []
    sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(recovered))
    mount('/plan', state)
    const remove = () => fireEvent.click(screen.getByRole('button', { name: 'Remove workout from plan' }))
    vi.mocked(window.confirm).mockReturnValue(false); remove()
    const confirmation = vi.mocked(window.confirm).mock.calls.at(-1)![0]!
    expect(confirmation).toContain('Latest saved workout')
    expect(confirmation).toMatch(/draft.*discard|discard.*draft/i)
    expect(saves).toBe(0); expect(live).toBe(state)
    expect(JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY)!)).toEqual(recovered)
    vi.mocked(window.confirm).mockReturnValue(true); failed = true; remove()
    expect(saves).toBe(0); expect(live).toBe(state)
    expect(screen.getByLabelText('Workout title')).toHaveValue('Older recovered name')
    expect(JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY)!)).toEqual(recovered)
    failed = false; remove()
    expect(saves).toBe(1)
    expect(live.workouts.some(workout => workout.id === recovered.id)).toBe(false)
    expect(live.planHistory[0].workouts).toEqual(state.workouts)
    expect(live.planHistory[0].label).toContain('Latest saved workout')
    expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBeNull()
  })

  it.each(['generation', 'source'])('rejects recovered workout removal when %s changes during confirmation', boundary => {
    const state = freshState()
    const recovered = { ...structuredClone(state.workouts[0]), title: 'Older recovered name' }
    sessionStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify(recovered))
    mount('/plan', state)
    vi.mocked(window.confirm).mockImplementation(() => {
      if (boundary === 'generation') generation++
      else live.workouts[0].title = 'Different saved target'
      return true
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove workout from plan' }))
    expect(window.confirm).toHaveBeenCalled(); expect(saves).toBe(0)
    expect(live.workouts.some(workout => workout.id === recovered.id)).toBe(true)
    expect(JSON.parse(sessionStorage.getItem(PLAN_DRAFT_KEY)!)).toEqual(recovered)
  })
})
