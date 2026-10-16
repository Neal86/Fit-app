// @vitest-environment jsdom
import { StrictMode, useReducer, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { freshState } from '../storage'
import { parseState } from '../stateValidation'
import { startSession } from '../session'
import { readPlanDraft } from '../planDraft'
import type { AppState, LibraryEntry } from '../types'
import PlanEditor from './PlanEditor'
import WorkoutSession, { type UpdateState } from './WorkoutSession'

let live: AppState
let generation = 0
let fail = false
let captured: Parameters<UpdateState>[0]
let refresh: () => void
let commits = 0
const entry = (id = 'manual-source', name = 'Personal row', revision = 4): LibraryEntry => ({ id, revision, status: 'active', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', exercise: { name, category: 'My category', sets: 2, reps: '7–9', restSeconds: 40, notes: 'My note', equipment: ['dumbbells'] } })
const setup = () => {
  const state = freshState(); state.exerciseLibrary = { version: 1, entries: [entry(), { ...entry('archived-source', 'Archived movement'), status: 'archived' }] }
  state.activeSession = startSession(state.workouts[0]); state.activeSession.runningSince = null
  state.activeSession.sets[0] = { ...state.activeSession.sets[0], reps: 8, weightKg: 25, completed: true }
  return state
}
function Host({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const [, tick] = useReducer(value => value + 1, 0); live = state; refresh = tick
  const update: UpdateState = change => { captured = change; try { const next = change(live); parseState(next); if (fail) return false; commits++; generation++; live = next; setState(next); return true } catch { return false } }
  return <Routes><Route path="/plan" element={<PlanEditor state={state} update={update} readGeneration={() => generation} />} /><Route path="/workouts/:id" element={<WorkoutSession state={state} update={update} readGeneration={() => generation} />} /></Routes>
}
const mount = (route = '/plan', state = setup()) => render(<StrictMode><MemoryRouter initialEntries={[route]}><Host initial={state} /></MemoryRouter></StrictMode>)
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const click = (name: string | RegExp) => fireEvent.click(button(name))
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const planOpen = () => fireEvent.click(screen.getByText('Add from exercise library'))
const retained = (element: HTMLElement, name = 'onClick') => { const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!; return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][name] }
beforeEach(() => { generation = 0; fail = false; commits = 0; sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('personal library copies across all three picker paths', { timeout: 20000 }, () => {
  it('reviews the exact plan destination and only persists the fresh independent copy on Save plan', () => {
    mount(); const before = structuredClone(live); planOpen(); expect(screen.queryByRole('button', { name: 'Add Archived movement' })).not.toBeInTheDocument(); click('Add Personal row')
    const review = screen.getByRole('region', { name: 'Personal library plan copy review' }); expect(review).toHaveTextContent('Upper Body Power'); expect(review).toHaveTextContent('revision 4'); expect(review).toHaveTextContent('My note'); expect(review).toHaveTextContent('40 seconds')
    expect(readPlanDraft()).toBeNull(); expect(commits).toBe(0); click('Confirm copy into plan draft')
    const added = readPlanDraft()!.exercises.at(-1)!; expect(added.id).not.toBe('manual-source'); expect(added.libraryOrigin).toEqual({ version: 1, entryId: 'manual-source', revision: 4 }); expect(live).toEqual(before)
    click(/Save workout plan/); expect(commits).toBe(1); expect(live.workouts[0].exercises.at(-1)).toEqual(added); expect(live.activeSession).toEqual(before.activeSession); expect(live.logs).toEqual(before.logs); expect(live.exerciseLibrary).toEqual(before.exerciseLibrary)
  })
  it('keeps distinct same-name personal entries selectable with their own ancestry', () => {
    const state = setup(); state.exerciseLibrary!.entries.push(entry('second-manual', 'Personal row', 2)); mount('/plan', state); planOpen()
    const choices = screen.getAllByRole('button', { name: 'Add Personal row' }); expect(choices).toHaveLength(2)
    fireEvent.click(choices[1]); expect(screen.getByRole('region', { name: 'Personal library plan copy review' })).toHaveTextContent('revision 2'); click('Confirm copy into plan draft')
    expect(readPlanDraft()!.exercises.at(-1)!.libraryOrigin).toEqual({ version: 1, entryId: 'second-manual', revision: 2 })
  })
  it('revokes a personal plan confirmation when the destination changes, including change-and-back', () => {
    mount(); planOpen(); click('Add Personal row'); const oldConfirm = retained(button('Confirm copy into plan draft')); const title = live.workouts[0].title
    change('Workout title', 'Other draft'); change('Workout title', title); act(() => oldConfirm())
    expect(readPlanDraft()!.exercises).toHaveLength(live.workouts[0].exercises.length); expect(button('Confirm copy into plan draft')).toBeDisabled(); click('Confirm copy into plan draft'); expect(readPlanDraft()!.exercises).toHaveLength(live.workouts[0].exercises.length)
  })
  it('does not resurrect a plan token after an observed in-place archive-and-restore cycle', () => {
    mount(); planOpen(); click('Add Personal row'); const old = retained(button('Confirm copy into plan draft'))
    act(() => { live.exerciseLibrary!.entries[0].status = 'archived'; refresh() }); expect(screen.queryByRole('button', { name: 'Add Personal row' })).not.toBeInTheDocument()
    act(() => { live.exerciseLibrary!.entries[0].status = 'active'; refresh() }); act(() => old()); expect(readPlanDraft()).toBeNull(); expect(button('Confirm copy into plan draft')).toBeDisabled(); click('Confirm copy into plan draft'); expect(readPlanDraft()).toBeNull()
    click('Add Personal row'); click('Confirm copy into plan draft'); expect(readPlanDraft()!.exercises).toHaveLength(live.workouts[0].exercises.length + 1)
  })
  it('reserves orphan origin identities when copying a historical plan entry without a live token', () => {
    const state = setup(); const orphan = '10000000-0000-4000-8000-000000000001'; const fresh = '10000000-0000-4000-8000-000000000002'
    state.workouts[0].exercises[0].libraryOrigin = { version: 1, entryId: orphan, revision: 3 }; mount('/plan', state); planOpen()
    const id = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(orphan).mockReturnValueOnce(fresh)
    const choice = screen.getAllByRole('button', { name: 'Add Bench Press' }).find(item => item.closest('li')!.textContent!.includes('Your plan'))!; fireEvent.click(choice)
    const added = readPlanDraft()!.exercises.at(-1)!; expect(id).toHaveBeenCalledTimes(2); expect(added.id).toBe(fresh); expect(added.libraryOrigin).toEqual({ version: 1, entryId: orphan, revision: 3 }); expect(screen.queryByRole('button', { name: 'Confirm copy into plan draft' })).not.toBeInTheDocument()
  })
  it('preserves editable addition values, origin and raw load drafts through review, failure and retry', () => {
    mount('/workouts/upper-power'); const before = structuredClone(live); change('Bench Press set 2 weight', '.'); click('Add exercise to this session'); expect(screen.queryByRole('button', { name: 'Use Archived movement' })).not.toBeInTheDocument(); click('Use Personal row')
    change('Session exercise name', 'Edited copy'); change('Number of sets (1–20)', '3'); change('Target reps or seconds', '12'); change('Exercise notes', 'Destination note'); click('Review session addition')
    const panel = screen.getByRole('region', { name: 'Session exercise addition' }); expect(panel).toHaveTextContent('revision 4'); expect(panel).toHaveTextContent('Destination note'); expect(panel).toHaveTextContent('Values may differ')
    fail = true; click('Confirm addition of 3 sets'); const failed = captured; expect(live).toEqual(before); expect(screen.getByLabelText('Bench Press set 2 weight')).toHaveValue('.'); expect(() => failed(live)).toThrow(/current|changed/)
    fail = false; click('Confirm addition of 3 sets'); const added = live.activeSession!.workout.exercises.at(-1)!; expect(added).toMatchObject({ name: 'Edited copy', sets: 3, reps: '12', notes: 'Destination note', libraryOrigin: { version: 1, entryId: 'manual-source', revision: 4 } }); expect(added.id).not.toBe('manual-source')
    expect(live.activeSession!.sets.filter(row => row.exerciseId === added.id)).toHaveLength(3); expect(live.activeSession!.sets.slice(0, before.activeSession!.sets.length)).toEqual(before.activeSession!.sets); expect(screen.getByLabelText('Bench Press set 2 weight')).toHaveValue('.'); expect(live.exerciseLibrary).toEqual(before.exerciseLibrary); expect(live.workouts).toEqual(before.workouts)
  })
  it('uses actual unfinished replacement count while preserving completed values and the selected revision', () => {
    mount('/workouts/upper-power'); const before = structuredClone(live); change('Bench Press set 2 weight', '.'); click('Replace unfinished Bench Press sets'); expect(screen.queryByRole('button', { name: 'Choose Archived movement' })).not.toBeInTheDocument(); click('Choose Personal row')
    const panel = screen.getByRole('region', { name: 'Session exercise replacement' }); expect(panel).toHaveTextContent('3 unfinished Bench Press sets with exactly 3 fresh Personal row sets'); expect(panel).toHaveTextContent('revision 4'); expect(panel).toHaveTextContent('Load entry: “.” kg')
    click('Confirm replacement and reset 3 unfinished sets'); const added = live.activeSession!.workout.exercises.find(exercise => exercise.name === 'Personal row')!; expect(added.libraryOrigin).toEqual({ version: 1, entryId: 'manual-source', revision: 4 }); expect(added.id).not.toBe('manual-source')
    expect(live.activeSession!.sets[0]).toEqual(before.activeSession!.sets[0]); const rows = live.activeSession!.sets.filter(row => row.exerciseId === added.id); expect(rows).toHaveLength(3); rows.forEach(row => expect(row).toMatchObject({ reps: null, seconds: null, weightKg: null, rpe: null, warmup: false, completed: false })); expect(live.workouts).toEqual(before.workouts); expect(live.exerciseLibrary).toEqual(before.exerciseLibrary)
  })
  it.each(['addition', 'replacement'] as const)('permanently fences %s review across an in-place library edit-and-restore', flow => {
    mount('/workouts/upper-power')
    if (flow === 'addition') { click('Add exercise to this session'); click('Use Personal row'); click('Review session addition') } else { click('Replace unfinished Bench Press sets'); click('Choose Personal row') }
    const name = flow === 'addition' ? 'Confirm addition of 2 sets' : 'Confirm replacement and reset 3 unfinished sets'; const old = retained(button(name)); const original = live.exerciseLibrary!.entries[0].exercise.name
    act(() => { live.exerciseLibrary!.entries[0].exercise.name = 'Other'; refresh() }); act(() => { live.exerciseLibrary!.entries[0].exercise.name = original; refresh() })
    expect(button(name)).toBeDisabled(); act(() => old()); expect(commits).toBe(0)
  })
  it('allows an archived historical plan origin as an independent session addition', () => {
    const state = setup(); state.workouts[0].exercises[0].name = 'Historical copy'; state.workouts[0].exercises[0].libraryOrigin = { version: 1, entryId: 'archived-source', revision: 1 }; mount('/workouts/upper-power', state)
    click('Add exercise to this session'); click('Use Historical copy'); click('Review session addition'); expect(within(screen.getByRole('region', { name: 'Session exercise addition' })).getByText(/Copied from your library, revision 1/)).toBeInTheDocument(); click('Confirm addition of 4 sets')
    expect(live.activeSession!.workout.exercises.at(-1)!.libraryOrigin).toEqual({ version: 1, entryId: 'archived-source', revision: 1 }); expect(commits).toBe(1)
  })
})
