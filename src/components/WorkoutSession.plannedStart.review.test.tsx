// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import WorkoutSession, { type UpdateState } from './WorkoutSession'
import { freshState } from '../storage'
import { startSession } from '../session'
import type { AppState } from '../types'

let live: AppState
let generation = 0
let commits = 0
let fail: 'before' | 'after' | null = null
let captured: Parameters<UpdateState>[0]
function Host({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const navigate = useNavigate(); live = state
  const update: UpdateState = change => {
    captured = change
    if (fail === 'before') return false
    try {
      const next = change(live)
      if (fail === 'after') return false
      live = next; commits++; generation++; setState(next); return true
    } catch { return false }
  }
  return <><button onClick={() => navigate('/workouts/upper-power?changed=1')}>Navigate query</button><button onClick={() => navigate(-1)}>Navigate back</button><Routes><Route path="/workouts/:id" element={<WorkoutSession state={state} update={update} readGeneration={() => generation} />} /></Routes></>
}
const mount = (state = freshState()) => render(<StrictMode><MemoryRouter initialEntries={['/workouts/upper-power']}><Host initial={state} /></MemoryRouter></StrictMode>)
const start = () => screen.getByRole('button', { name: 'Start workout' })
const retained = (element: HTMLElement) => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, { onClick: () => void }>)[key].onClick
}
beforeEach(() => { generation = 0; commits = 0; fail = null; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('independent exact saved-workout Start lifetime', { timeout: 30000 }, () => {
  it('starts once before timer tick in StrictMode and never replays its updater', () => {
    vi.useFakeTimers(); mount(); const oldState = live; const click = retained(start())
    act(() => { click(); click() })
    expect(commits).toBe(1); expect(live.activeSession).not.toBeNull()
    expect(() => captured(oldState)).toThrow(/current|changed|start/i)
  })
  it.each(['before', 'after'] as const)('revokes failed %s updater and allows one exact fresh retry', failure => {
    mount(); const oldState = live; fail = failure; fireEvent.click(start()); const stale = captured
    expect(commits).toBe(0); expect(live).toBe(oldState); expect(() => stale(oldState)).toThrow(/current|changed|start/i)
    expect(screen.getByRole('alert')).toHaveTextContent('Workout was not started')
    const description = start().getAttribute('aria-describedby'); expect(description).toBeTruthy(); expect(document.getElementById(description!)).toBe(screen.getByRole('alert'))
    fail = null; const retry = retained(start()); act(() => { retry(); retry() })
    expect(commits).toBe(1); expect(() => stale(oldState)).toThrow(/current|changed|start/i); expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it.each(['title', 'exercise', 'removed', 'replacement'] as const)('rejects saved-workout %s mutation before React renders', mutation => {
    mount(); const click = retained(start()); const workout = live.workouts[0]
    if (mutation === 'title') workout.title = 'Unreviewed title'
    if (mutation === 'exercise') workout.exercises[0].sets += 1
    if (mutation === 'removed') live.workouts = live.workouts.slice(1)
    if (mutation === 'replacement') live.workouts[0] = structuredClone(workout)
    act(() => click()); expect(commits).toBe(0); expect(live.activeSession).toBeNull()
  })
  it.each(['account', 'route', 'unmount'] as const)('rejects retained Start after %s', boundary => {
    const view = mount(); const click = retained(start()); const state = live
    fail = 'before'; fireEvent.click(start()); const stale = captured; fail = null
    if (boundary === 'account') generation++
    if (boundary === 'route') { fireEvent.click(screen.getByRole('button', { name: 'Navigate query' })); fireEvent.click(screen.getByRole('button', { name: 'Navigate back' })) }
    if (boundary === 'unmount') view.unmount()
    act(() => click()); expect(commits).toBe(0); expect(() => stale(state)).toThrow(/current|changed|start/i)
  })
  it('rechecks the selected plan after discard confirmation before replacing an active session', () => {
    const state = freshState(); state.activeSession = startSession(state.workouts[1]); state.activeSession.runningSince = null
    const original = structuredClone(state.activeSession)
    vi.mocked(window.confirm).mockImplementation(() => { state.workouts[0].exercises[0].sets = 20; return true })
    mount(state); fireEvent.click(start()); expect(commits).toBe(0); expect(live.activeSession).toEqual(original)
  })
})
