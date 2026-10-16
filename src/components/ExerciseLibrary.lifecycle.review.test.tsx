// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import ExerciseLibrary from './ExerciseLibrary'
import PlanEditor from './PlanEditor'
import WorkoutSession, { type UpdateState } from './WorkoutSession'
import { freshState } from '../storage'
import { startSession } from '../session'
import { readPlanDraft } from '../planDraft'
import type { AppState } from '../types'

const now = Date.parse('2026-10-16T00:00:00.000Z')
type Flow = 'library' | 'plan' | 'addition' | 'replacement'
let live: AppState, revision = 0, attempts = 0, commits = 0
let failure: 'before' | 'after' | null = null
let captured: Parameters<UpdateState>[0]
let replace: (state: AppState) => void
let reenter: (() => void) | undefined
let refresh: () => void
function setup() {
  const state = freshState(); state.profile.onboardingComplete = true
  state.exerciseLibrary = { version: 1, entries: [0, 1].map(index => ({ id: `personal-${index}`, revision: 1, status: 'active' as const, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), exercise: { name: 'Same personal content', category: 'Personal', sets: 2, reps: '9', restSeconds: 17, notes: 'Exact manual note', equipment: [] } })) }
  state.activeSession = startSession(state.workouts[0], now); state.activeSession.runningSince = null; state.activeSession.sets[0].completed = true; state.activeSession.sets[0].reps = 8
  return state
}
function Host({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const [, setTick] = useState(0); live = state; const navigate = useNavigate(); refresh = () => setTick(value => value + 1)
  replace = next => { live = next; revision++; setState(next) }
  const update: UpdateState = change => {
    attempts++; captured = change; if (failure === 'before') return false
    try { const next = change(live); reenter?.(); if (failure === 'after') return false; live = next; revision++; commits++; setState(next); return true } catch { return false }
  }
  return <><button onClick={() => navigate('?changed=1')}>Navigate query</button><button onClick={() => navigate(-1)}>Navigate back</button><Routes>
    <Route path="/exercise-library" element={<ExerciseLibrary state={state} update={update} readGeneration={() => revision} />} />
    <Route path="/plan" element={<PlanEditor state={state} update={update} readGeneration={() => revision} />} />
    <Route path="/workouts/:id" element={<WorkoutSession state={state} update={update} readGeneration={() => revision} />} />
  </Routes></>
}
const mount = (flow: Flow) => render(<StrictMode><MemoryRouter initialEntries={[flow === 'library' ? '/exercise-library' : flow === 'plan' ? '/plan' : '/workouts/upper-power']}><Host initial={setup()} /></MemoryRouter></StrictMode>)
const retained = (element: HTMLElement, event = 'onClick') => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
function open(flow: Flow) {
  if (flow === 'library') { fireEvent.click(screen.getAllByRole('button', { name: 'Edit Same personal content' })[0]); edit('Library exercise name', 'Reviewed content edit'); fireEvent.click(screen.getByRole('button', { name: 'Review library exercise' })) }
  if (flow === 'plan') { fireEvent.click(screen.getByText('Add from exercise library')); expect(screen.getAllByRole('button', { name: 'Add Same personal content' })).toHaveLength(2); fireEvent.click(screen.getAllByRole('button', { name: 'Add Same personal content' })[1]) }
  if (flow === 'addition') { fireEvent.click(screen.getByRole('button', { name: 'Add exercise to this session' })); expect(screen.getAllByRole('button', { name: 'Use Same personal content' })).toHaveLength(2); fireEvent.click(screen.getAllByRole('button', { name: 'Use Same personal content' })[1]); fireEvent.click(screen.getByRole('button', { name: 'Review session addition' })) }
  if (flow === 'replacement') { fireEvent.click(screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' })); expect(screen.getAllByRole('button', { name: 'Choose Same personal content' })).toHaveLength(2); fireEvent.click(screen.getAllByRole('button', { name: 'Choose Same personal content' })[1]) }
}
const confirm = (flow: Flow) => screen.getByRole('button', { name: flow === 'library' ? 'Confirm edit library exercise' : flow === 'plan' ? 'Confirm copy into plan draft' : flow === 'addition' ? 'Confirm addition of 2 sets' : /Confirm replacement and reset/ })
const cancel = (flow: Flow) => screen.getByRole('button', { name: flow === 'library' ? 'Cancel library edit' : flow === 'plan' ? 'Cancel library copy' : flow === 'addition' ? 'Cancel addition' : 'Cancel replacement' })
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); revision = 0; attempts = 0; commits = 0; failure = null; reenter = undefined; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('independent personal-copy and library callback lifetimes', { timeout: 30000 }, () => {
  it.each(['plan', 'addition', 'replacement'] as const)('selects the second equal-content distinct entry through the %s picker', flow => {
    mount(flow); open(flow); fireEvent.click(confirm(flow))
    const movement = flow === 'plan' ? readPlanDraft()!.exercises.at(-1)! : live.activeSession!.workout.exercises.find(exercise => exercise.libraryOrigin)!
    expect(movement.libraryOrigin).toEqual({ version: 1, entryId: 'personal-1', revision: 1 }); expect(movement.id).not.toBe('personal-1')
    expect(commits).toBe(flow === 'plan' ? 0 : 1)
  })
  for (const flow of ['library', 'plan', 'addition', 'replacement'] as const) {
    it.each(['library mutation', 'entry identity', 'library identity', 'account before render', 'identical restore', 'archive-restore', 'route', 'unmount', 'cancel'] as const)(`${flow} revokes retained confirmation on %s`, boundary => {
      const view = mount(flow); open(flow); const callback = retained(confirm(flow)); const original = live
      if (boundary === 'library mutation') live.exerciseLibrary!.entries[0].exercise.name = 'Changed in place before render'
      if (boundary === 'entry identity') { const selected = flow === 'library' ? 0 : 1; live.exerciseLibrary!.entries[selected] = structuredClone(live.exerciseLibrary!.entries[selected]) }
      if (boundary === 'library identity') live.exerciseLibrary = structuredClone(live.exerciseLibrary)
      if (boundary === 'account before render') revision++
      if (boundary === 'identical restore') act(() => { replace(structuredClone(live)); replace(original); callback() })
      if (boundary === 'archive-restore') {
        const changed = structuredClone(live); changed.exerciseLibrary!.entries[1].status = 'archived'; act(() => replace(changed)); act(() => replace(original))
      }
      if (boundary === 'route') { fireEvent.click(screen.getByRole('button', { name: 'Navigate query' })); fireEvent.click(screen.getByRole('button', { name: 'Navigate back' })) }
      if (boundary === 'unmount') view.unmount()
      if (boundary === 'cancel') fireEvent.click(cancel(flow))
      act(() => callback()); expect(commits).toBe(0)
      if (flow === 'plan') expect(readPlanDraft()).toBeNull()
    })
  }
  for (const flow of ['library', 'addition', 'replacement'] as const) {
    it.each(['before', 'after'] as const)(`${flow} closes a failed %s transaction and lets only a fresh retry succeed`, stage => {
      mount(flow); open(flow); failure = stage; const original = live; fireEvent.click(confirm(flow)); const failed = captured
      expect(commits).toBe(0); expect(() => failed(original)).toThrow(/changed|current/i)
      expect(confirm(flow)).toBeEnabled(); failure = null; fireEvent.click(confirm(flow)); expect(commits).toBe(1)
      expect(() => failed(original)).toThrow(/changed|current/i); expect(() => captured(live)).toThrow(/changed|current/i)
    })
    it(`${flow} blocks reentrant and duplicate confirms before a render`, () => {
      mount(flow); open(flow); const callback = retained(confirm(flow)); reenter = callback
      act(() => { callback(); callback() }); expect(attempts).toBe(1); expect(commits).toBe(1)
    })
  }
  it.each(['addition', 'replacement'] as const)('%s rejects a same-batch raw-load edit/restore, preserving the newer load draft', flow => {
    mount(flow); open(flow); const callback = retained(confirm(flow)); const load = screen.getByLabelText('Bench Press set 1 weight'); const change = retained(load, 'onChange')
    act(() => { change({ target: { value: '.' } }); callback() }); expect(commits).toBe(0); expect(load).toHaveValue('.')
    edit('Bench Press set 1 weight', ''); act(() => callback()); expect(commits).toBe(0); expect(confirm(flow)).toBeDisabled()
  })
  it('a retained library Cancel cannot erase newer edits or a newer review', () => {
    mount('library'); fireEvent.click(screen.getAllByRole('button', { name: 'Edit Same personal content' })[0]); const oldCancel = retained(cancel('library'))
    edit('Library exercise name', 'New unsaved edit'); act(() => oldCancel()); expect(screen.getByLabelText('Library exercise name')).toHaveValue('New unsaved edit')
    fireEvent.click(screen.getByRole('button', { name: 'Review library exercise' })); act(() => oldCancel()); expect(confirm('library')).toBeEnabled(); expect(commits).toBe(0)
  })
  it('keeps the edited personal addition draft and its ancestry on Back, and refuses stale library review', () => {
    mount('addition'); fireEvent.click(screen.getByRole('button', { name: 'Add exercise to this session' })); fireEvent.click(screen.getAllByRole('button', { name: 'Use Same personal content' })[1])
    const oldCancel = retained(cancel('addition')); edit('Session exercise name', 'My draft renamed value'); edit('Number of sets (1–20)', '4'); act(() => oldCancel())
    fireEvent.click(screen.getByRole('button', { name: 'Review session addition' })); fireEvent.click(screen.getByRole('button', { name: 'Back to exercise details' }))
    expect(screen.getByLabelText('Session exercise name')).toHaveValue('My draft renamed value'); expect(screen.getByLabelText('Number of sets (1–20)')).toHaveValue('4')
    const changed = { ...live, exerciseLibrary: structuredClone(live.exerciseLibrary) }; changed.exerciseLibrary!.entries[1].status = 'archived'; act(() => replace(changed))
    expect(screen.getByLabelText('Session exercise name')).toHaveValue('My draft renamed value'); expect(screen.getByRole('button', { name: 'Review session addition' })).toBeDisabled(); expect(commits).toBe(0)
  })
})


describe('independent freshly rendered session copy confirmations', () => {
  for (const flow of ['addition', 'replacement'] as const) {
    it.each(['archive/restore', 'content edit/revert'] as const)(`${flow} remains stale after an observed in-place %s cycle`, cycle => {
      mount(flow); open(flow); const entry = live.exerciseLibrary!.entries[1]
      if (cycle === 'archive/restore') entry.status = 'archived'
      else entry.exercise.name = 'Temporary source name'
      act(() => refresh())
      entry.status = 'active'; entry.exercise.name = 'Same personal content'; act(() => refresh())
      const currentConfirm = confirm(flow); expect(currentConfirm).toBeDisabled(); const callback = retained(currentConfirm); act(() => callback()); fireEvent.click(currentConfirm)
      expect(commits).toBe(0)
      fireEvent.click(cancel(flow)); open(flow); fireEvent.click(confirm(flow)); expect(commits).toBe(1)
    })
  }
})
