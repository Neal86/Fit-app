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
let revision = 0
let captureWithoutInvocation = false
let rejectAfterInvocation = false
let captured: Parameters<UpdateState>[0]
let replace: (state: AppState) => void
let commits = 0
const setup = () => { const state = freshState(); state.activeSession = startSession(state.workouts[0]); state.activeSession.runningSince = null; state.activeSession.sets[0].completed = true; state.activeSession.sets[0].reps = 1; return state }
function Host({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const navigate = useNavigate(); live = state
  replace = next => { live = next; revision++; setState(next) }
  const update: UpdateState = change => {
    captured = change
    if (captureWithoutInvocation) return false
    try {
      const next = change(live)
      if (rejectAfterInvocation) return false
      live = next; revision++; commits++; setState(next); return true
    } catch { return false }
  }
  return <><button onClick={() => navigate('/workouts/upper-power?other=1')}>Navigate query</button><button onClick={() => navigate(-1)}>Navigate back</button><Routes><Route path="/workouts/:id" element={<WorkoutSession state={state} update={update} readGeneration={() => revision} />} /><Route path="/progress" element={<p>Finished</p>} /></Routes></>
}
const mount = () => render(<MemoryRouter initialEntries={['/workouts/upper-power']}><Host initial={setup()} /></MemoryRouter>)
const openReview = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add exercise to this session' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use Front Plank' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review session addition' }))
}
const confirm = () => screen.getByRole('button', { name: /Confirm addition of/ })
const retained = (element: HTMLElement, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { revision = 0; captureWithoutInvocation = false; rejectAfterInvocation = false; commits = 0; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('independent session addition callback lifetime', () => {
  it('accepts immediate library interaction inside StrictMode before any timer tick', () => {
    vi.useFakeTimers()
    try {
      render(<StrictMode><MemoryRouter initialEntries={['/workouts/upper-power']}><Host initial={setup()} /></MemoryRouter></StrictMode>)
      openReview(); expect(confirm()).toBeEnabled(); fireEvent.click(confirm()); expect(commits).toBe(1)
    } finally { vi.useRealTimers() }
  })
  it('does not let an old Cancel callback erase a newer custom form edit', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Add exercise to this session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create custom session exercise' }))
    const cancel = retained(screen.getByRole('button', { name: 'Cancel addition' }), 'onClick')
    fireEvent.change(screen.getByLabelText('Session exercise name'), { target: { value: 'New draft name' } })
    act(() => cancel())
    expect(screen.getByLabelText('Session exercise name')).toHaveValue('New draft name')
    expect(commits).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel addition' }))
    expect(screen.queryByRole('region', { name: 'Session exercise addition' })).not.toBeInTheDocument()
  })
  it.each([false, true])('closes failed synchronous attempt even when its reducer was invoked: %s', invoked => {
    mount(); openReview(); captureWithoutInvocation = !invoked; rejectAfterInvocation = invoked
    const original = live; fireEvent.click(confirm()); const failed = captured
    expect(() => failed(original)).toThrow(/current|changed/)
    captureWithoutInvocation = false; rejectAfterInvocation = false
    fireEvent.click(confirm()); expect(commits).toBe(1)
    expect(() => failed(original)).toThrow(/current|changed/)
    expect(() => captured(live)).toThrow(/current|changed/)
  })
  it('rejects account generation change before a rerender and prevents changed-restored source resurrection', () => {
    mount(); openReview(); const oldConfirm = retained(confirm(), 'onClick'); revision++
    act(() => oldConfirm()); expect(commits).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel addition' })); openReview()
    const second = retained(confirm(), 'onClick'); const original = live
    act(() => { replace({ ...live, activeSession: null }); replace(original); second() })
    expect(commits).toBe(0)
  })
  it.each(['cancel', 'back', 'route', 'unmount'])('revokes retained confirm and delayed reducer after %s', boundary => {
    const view = mount(); openReview(); const confirmOld = retained(confirm(), 'onClick')
    captureWithoutInvocation = true; fireEvent.click(confirm()); const oldReducer = captured; const original = live
    if (boundary === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel addition' }))
    if (boundary === 'back') fireEvent.click(screen.getByRole('button', { name: 'Back to exercise details' }))
    if (boundary === 'route') { fireEvent.click(screen.getByRole('button', { name: 'Navigate query' })); fireEvent.click(screen.getByRole('button', { name: 'Navigate back' })) }
    if (boundary === 'unmount') view.unmount()
    captureWithoutInvocation = false; act(() => confirmOld())
    expect(commits).toBe(0); expect(() => oldReducer(original)).toThrow(/current|changed/)
  })
  it('invalidates review after raw load changes back to its original value', () => {
    mount(); openReview(); const oldConfirm = retained(confirm(), 'onClick')
    const weight = screen.getByLabelText('Bench Press set 1 weight')
    fireEvent.change(weight, { target: { value: '.' } }); fireEvent.change(weight, { target: { value: '' } })
    expect(confirm()).toBeDisabled(); act(() => oldConfirm()); expect(commits).toBe(0)
  })
  it('rejects an older raw-load setter after addition without poisoning a fresh finish', () => {
    mount(); const oldEdit = retained(screen.getByLabelText('Bench Press set 1 weight'), 'onChange')
    openReview(); fireEvent.click(confirm()); act(() => oldEdit({ target: { value: '999' } }))
    expect(screen.getByLabelText('Bench Press set 1 weight')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    expect(live.logs[0].sets![0].weightKg).toBeNull(); expect(live.activeSession).toBeNull()
  })
  it('rejects an older finish transaction after addition', () => {
    mount(); captureWithoutInvocation = true; fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' })); const oldFinish = captured
    captureWithoutInvocation = false; openReview(); fireEvent.click(confirm()); const added = structuredClone(live)
    expect(() => oldFinish(live)).toThrow(/current|changed/); expect(live).toEqual(added)
  })
})
