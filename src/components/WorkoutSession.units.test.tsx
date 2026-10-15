// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkoutSession from './WorkoutSession'
import type { UpdateState } from './WorkoutSession'
import { freshState } from '../storage'
import { finishSession, startSession } from '../session'
import { KG_PER_LB } from '../units'
import type { AppState } from '../types'

function setup() {
  const state = freshState(); state.profile.unit = 'imperial'
  state.activeSession = startSession(state.workouts[0]); state.activeSession.sets[0] = { ...state.activeSession.sets[0], weightKg: 20, reps: 8, completed: true }
  return state
}
const input = () => screen.getByLabelText('Bench Press set 1 weight')
let latest: AppState
let rejectSave = false
function Harness({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); latest = state
  const update: UpdateState = change => { if (rejectSave) return false; setState(previous => change(previous)); return true }
  return <MemoryRouter initialEntries={['/workouts/upper-power']}><Routes><Route path="/workouts/:id" element={<WorkoutSession state={state} update={update}/>}/><Route path="/progress" element={<p>Finished</p>}/></Routes></MemoryRouter>
}
beforeEach(() => { rejectSave = false; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('unit-aware workout load drafts', () => {
  it('preserves partial text through timer rerenders and persists Enter in canonical kilograms', () => {
    vi.useFakeTimers(); render(<Harness initial={setup()}/> )
    fireEvent.change(input(), { target: { value: '100.' } })
    act(() => vi.advanceTimersByTime(500))
    expect(input()).toHaveValue('100.'); expect(latest.activeSession!.sets[0].weightKg).toBe(20)
    fireEvent.change(input(), { target: { value: '100.5' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(latest.activeSession!.sets[0].weightKg).toBe(100.5 * KG_PER_LB)
    expect(input()).toHaveValue('100.5')
  })
  it('commits a focused pending load when finishing without relying on blur', () => {
    render(<Harness initial={setup()}/> )
    fireEvent.change(input(), { target: { value: '100.25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    expect(latest.logs[0].sets![0].weightKg).toBe(100.25 * KG_PER_LB)
    expect(latest.activeSession).toBeNull(); expect(screen.getByText('Finished')).toBeInTheDocument()
  })
  it.each(['.', '-1', 'Infinity', 'NaN', '2204.63'])('blocks completion and finish on invalid text %j instead of saving the old load', value => {
    render(<Harness initial={setup()}/> )
    fireEvent.change(input(), { target: { value } })
    fireEvent.blur(input())
    expect(input()).toHaveValue(value)
    fireEvent.click(screen.getByRole('button', { name: 'Undo Bench Press set 1' }))
    expect(latest.activeSession!.sets[0].completed).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    expect(latest.logs).toHaveLength(0); expect(latest.activeSession!.sets[0].weightKg).toBe(20)
    expect(screen.getByRole('alert')).toHaveTextContent('lb')
  })
  it('retains failed load text through blur and finish, and retries with the same entered value', () => {
    render(<Harness initial={setup()}/> ); rejectSave = true
    fireEvent.change(input(), { target: { value: '99.75' } }); fireEvent.blur(input())
    expect(input()).toHaveValue('99.75'); expect(latest.activeSession!.sets[0].weightKg).toBe(20)
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    expect(input()).toHaveValue('99.75'); expect(latest.logs).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('not saved')
    rejectSave = false; fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    expect(latest.logs[0].sets![0].weightKg).toBe(99.75 * KG_PER_LB)
  })
  it('records blank and zero distinctly and commits load atomically with set completion', () => {
    const state = setup(); state.activeSession!.sets[0].completed = false
    render(<Harness initial={state}/> )
    fireEvent.change(input(), { target: { value: '' } }); fireEvent.blur(input())
    expect(latest.activeSession!.sets[0].weightKg).toBeNull()
    fireEvent.change(input(), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Complete Bench Press set 1' }))
    expect(latest.activeSession!.sets[0]).toMatchObject({ weightKg: 0, completed: true })
  })
  it('converts untouched previous sets and active loads without changing their canonical values', () => {
    const state = setup(); state.activeSession!.sets[0].weightKg = 1000
    const previous = structuredClone(state.activeSession!); previous.id = 'prior'; previous.sets[0].weightKg = 100 * KG_PER_LB
    state.logs = [finishSession(previous)]
    render(<Harness initial={state}/> )
    expect(input()).toHaveValue('2204.62')
    expect(screen.getByText('Last: 8 reps · 100 lb')).toBeInTheDocument()
    fireEvent.blur(input()); expect(latest.activeSession!.sets[0].weightKg).toBe(1000)
  })
  it('preserves an invalid draft with its original-unit label on preference change, and resets on a new session', () => {
    const state = setup(); const update = vi.fn(() => true)
    const view = (next: AppState) => <MemoryRouter initialEntries={['/workouts/upper-power']}><Routes><Route path="/workouts/:id" element={<WorkoutSession state={next} update={update}/>}/></Routes></MemoryRouter>
    const rendered = render(view(state))
    fireEvent.change(input(), { target: { value: '.' } })
    const switched = { ...state, profile: { ...state.profile, unit: 'metric' as const } }
    rendered.rerender(view(switched))
    expect(input()).toHaveValue('.'); expect(input()).toHaveAccessibleDescription('Load in lb; about 0–2,204.62 lb (0–1000 kg). Blank means bodyweight.'); expect(screen.getByText('Finish this entry in lb; then it will display in kg.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' })); expect(update).not.toHaveBeenCalled()
    const replaced = { ...switched, activeSession: { ...state.activeSession!, id: 'replacement' } }
    rendered.rerender(view(replaced)); expect(input()).toHaveValue('20')
  })
  it('converts valid pending edits exactly once on external unit changes and invalidates replaced loads', () => {
    const state = setup(); const update = vi.fn<UpdateState>(() => false)
    const view = (next: AppState) => <MemoryRouter initialEntries={['/workouts/upper-power']}><Routes><Route path="/workouts/:id" element={<WorkoutSession state={next} update={update}/>}/></Routes></MemoryRouter>
    const rendered = render(view(state)); fireEvent.change(input(), { target: { value: '100.25' } })
    rendered.rerender(view({ ...state, profile: { ...state.profile, unit: 'metric' } })); expect(input()).toHaveValue('45.47')
    rendered.rerender(view(state)); expect(input()).toHaveValue('100.25')
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    expect(update.mock.calls).toHaveLength(1)
    const change = update.mock.calls[0][0]
    expect(change(state).logs[0].sets![0].weightKg).toBe(100.25 * KG_PER_LB)
    const replaced = structuredClone(state); replaced.activeSession!.sets[0].weightKg = 50
    rendered.rerender(view(replaced)); expect(input()).toHaveValue('110.23')
  })
})
