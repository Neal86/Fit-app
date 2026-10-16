// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import ExerciseLibrary from './ExerciseLibrary'
import { freshState } from '../storage'
import { finishSession, startSession } from '../session'
import { parseState } from '../stateValidation'
import type { AppState, LibraryEntry } from '../types'
import type { UpdateState } from './WorkoutSession'

let live: AppState
let generation = 0
let fail = false
let defer = false
let commits = 0
let captured: Parameters<UpdateState>[0]
let replace: (next: AppState) => void
const entry = (id = 'library-one'): LibraryEntry => ({ id, revision: 1, status: 'active', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', exercise: { name: 'Manual movement', category: 'Custom', sets: 2, reps: '6', restSeconds: 45, notes: '', equipment: [] } })
const setup = (entries = [entry()]): AppState => { const state = freshState(); state.exerciseLibrary = { version: 1, entries }; state.activeSession = startSession(state.workouts[0]); state.activeSession.runningSince = null; state.activeSession.sets[0].completed = true; state.activeSession.sets[0].reps = 8; state.logs = [finishSession({ ...state.activeSession, id: 'prior-session' })]; return state }
function Host({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const navigate = useNavigate(); live = state
  replace = next => { generation++; live = next; setState(next) }
  const update: UpdateState = change => {
    captured = change
    if (defer) return false
    try { const next = change(live); parseState(next); if (fail) return false; commits++; generation++; live = next; setState(next); return true } catch { return false }
  }
  return <><button onClick={() => navigate('/exercise-library?changed=1')}>Change route</button><button onClick={() => navigate(-1)}>Back route</button><Routes><Route path="/exercise-library" element={<ExerciseLibrary state={state} update={update} readGeneration={() => generation} />} /></Routes></>
}
const mount = (state = setup()) => render(<StrictMode><MemoryRouter initialEntries={['/exercise-library']}><Host initial={state} /></MemoryRouter></StrictMode>)
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const fill = () => { change('Library exercise name', 'My own row'); change('Library exercise category', 'My category'); change('Library set count (1–20)', '3'); change('Library target reps or seconds', '7–9'); change('Library rest seconds (0–900)', '60'); change('Library exercise notes', 'My chosen note') }
const openCreateReview = () => { fireEvent.click(button('Create library exercise')); fill(); fireEvent.click(button('Review library exercise')) }
const retained = (element: HTMLElement, name = 'onClick') => { const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!; return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][name] }
beforeEach(() => { generation = 0; fail = false; defer = false; commits = 0; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('manual exercise library management', { timeout: 20000 }, () => {
  it('starts with blank manual fields and saves only the exact reviewed content', () => {
    mount(); const before = structuredClone(live); fireEvent.click(button('Create library exercise'))
    for (const label of ['Library exercise name', 'Library exercise category', 'Library set count (1–20)', 'Library target reps or seconds', 'Library rest seconds (0–900)', 'Library exercise notes']) expect(screen.getByLabelText(label)).toHaveValue('')
    fill(); expect(commits).toBe(0); fireEvent.click(button('Review library exercise'))
    const review = screen.getByRole('region', { name: 'Library change review' }); expect(review).toHaveTextContent('My own row'); expect(review).toHaveTextContent('My chosen note'); expect(review).toHaveTextContent('your saved exercise library only')
    expect(live).toEqual(before); fireEvent.click(button('Confirm create library exercise'))
    expect(commits).toBe(1); expect(live.exerciseLibrary!.entries).toHaveLength(2)
    expect(live.exerciseLibrary!.entries[1].exercise).toEqual({ name: 'My own row', category: 'My category', sets: 3, reps: '7–9', restSeconds: 60, notes: 'My chosen note' })
    expect(live.activeSession).toEqual(before.activeSession); expect(live.logs).toEqual(before.logs); expect(live.workouts).toEqual(before.workouts)
  })
  it('keeps a no-op revision even when the original notes were explicitly empty', () => {
    mount(); const original = structuredClone(live.exerciseLibrary!.entries[0]); fireEvent.click(button('Edit Manual movement')); fireEvent.click(button('Review library exercise')); fireEvent.click(button('Confirm edit library exercise'))
    expect(live.exerciseLibrary!.entries[0]).toEqual(original)
    fireEvent.click(button('Edit Manual movement')); change('Library exercise name', 'Changed manual name'); fireEvent.click(button('Review library exercise')); fireEvent.click(button('Confirm edit library exercise'))
    expect(live.exerciseLibrary!.entries[0]).toMatchObject({ id: original.id, revision: 2, exercise: { name: 'Changed manual name' } })
  })
  it('archives and restores without changing revision or existing copies', () => {
    mount(); const before = structuredClone(live); fireEvent.click(button('Archive Manual movement')); expect(live).toEqual(before); fireEvent.click(button('Confirm archive library exercise'))
    expect(live.exerciseLibrary!.entries[0]).toMatchObject({ status: 'archived', revision: 1 }); expect(screen.queryByRole('button', { name: 'Edit Manual movement' })).not.toBeInTheDocument()
    fireEvent.click(button('Archived entries (1)')); fireEvent.click(button('Restore Manual movement')); fireEvent.click(button('Confirm restore library exercise'))
    expect(live.exerciseLibrary!.entries[0]).toMatchObject({ status: 'active', revision: 1 }); expect(live.activeSession).toEqual(before.activeSession); expect(live.logs).toEqual(before.logs)
  })
  it('never truncates at 500 entries and still allows editing, archive and restore', () => {
    mount(setup(Array.from({ length: 500 }, (_, index) => ({ ...entry(`entry-${index}`), status: index ? 'archived' : 'active' }))))
    expect(button('Create library exercise')).toBeDisabled(); expect(screen.getByText(/Your library is full/)).toBeInTheDocument()
    fireEvent.click(button('Edit Manual movement')); change('Library target reps or seconds', '9'); fireEvent.click(button('Review library exercise')); fireEvent.click(button('Confirm edit library exercise'))
    expect(live.exerciseLibrary!.entries).toHaveLength(500); expect(live.exerciseLibrary!.entries[0].revision).toBe(2)
    fireEvent.click(button('Archive Manual movement')); fireEvent.click(button('Confirm archive library exercise')); fireEvent.click(button('Archived entries (500)'))
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: 'Restore Manual movement' })); fireEvent.click(button('Confirm restore library exercise'))
    expect(live.exerciseLibrary!.entries).toHaveLength(500); expect(live.exerciseLibrary!.entries[0]).toMatchObject({ status: 'active', revision: 2 })
  })
  it.each([false, true])('retains a failed save and closes its delayed updater (invoked: %s)', invoked => {
    mount(); openCreateReview(); const before = live; defer = !invoked; fail = invoked; fireEvent.click(button('Confirm create library exercise')); const old = captured
    expect(live).toBe(before); expect(screen.getByRole('region', { name: 'Library change review' })).toHaveTextContent('My own row'); expect(screen.getByRole('alert')).toHaveTextContent('not saved')
    expect(() => old(before)).toThrow(/changed/); defer = false; fail = false; fireEvent.click(button('Confirm create library exercise')); expect(commits).toBe(1); expect(() => captured(live)).toThrow(/changed/)
  })
  it('requires discard confirmation and ignores old cancel and field handlers after newer edits', () => {
    mount(); fireEvent.click(button('Create library exercise')); const oldCancel = retained(button('Cancel library edit')); const oldName = retained(screen.getByLabelText('Library exercise name'), 'onChange'); change('Library exercise name', 'Newest draft')
    act(() => { oldCancel(); oldName({ target: { value: 'Old draft' } }) }); expect(screen.getByLabelText('Library exercise name')).toHaveValue('Newest draft')
    vi.mocked(window.confirm).mockReturnValue(false); fireEvent.click(button('Edit Manual movement')); expect(screen.getByLabelText('Library exercise name')).toHaveValue('Newest draft'); fireEvent.click(button('Cancel library edit')); expect(screen.getByLabelText('Library exercise name')).toHaveValue('Newest draft')
    vi.mocked(window.confirm).mockReturnValue(true); fireEvent.click(button('Cancel library edit')); expect(screen.queryByLabelText('Library exercise name')).not.toBeInTheDocument()
  })
  it('warns before unload for dirty temporary input', () => {
    mount(); fireEvent.click(button('Create library exercise')); change('Library exercise name', 'Temporary only'); const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true); expect(commits).toBe(0)
  })
  it.each(['generation', 'route', 'unmount', 'source'])('rejects a retained confirmation after %s', boundary => {
    const view = mount(); openCreateReview(); const oldConfirm = retained(button('Confirm create library exercise')); const before = live
    if (boundary === 'generation') generation++
    if (boundary === 'route') { fireEvent.click(button('Change route')); fireEvent.click(button('Back route')) }
    if (boundary === 'unmount') view.unmount()
    if (boundary === 'source') act(() => replace(structuredClone(live)))
    act(() => oldConfirm()); expect(commits).toBe(0); expect(live.exerciseLibrary).toEqual(before.exerciseLibrary)
  })
  it('rejects replay and double click after success', () => {
    mount(); openCreateReview(); const old = retained(button('Confirm create library exercise')); act(() => { old(); old() }); expect(commits).toBe(1); expect(live.exerciseLibrary!.entries).toHaveLength(2)
  })
})
