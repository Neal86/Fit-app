// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import ExercisePicker from './ExercisePicker'
import PlanEditor from './PlanEditor'
import { readPlanDraft } from '../planDraft'
import { freshState } from '../storage'
import type { AppState } from '../types'

const setup = (): AppState => {
  const state = freshState()
  state.exerciseLibrary = { version: 1, entries: [{ id: 'independent-copy-source', revision: 1, status: 'active', createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', exercise: { name: 'Copy generation probe', category: 'Manual', sets: 2, reps: '8', restSeconds: 19 } }] }
  return state
}
const retained = (element: HTMLElement) => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, () => void>>)[key].onClick
}
beforeEach(() => { sessionStorage.clear(); localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('independent StrictMode freshly rendered personal-copy confirmation', () => {
  it.each(['destination edit/restore', 'archive/restore', 'content edit/revert', 'library identity restore', 'state identity restore'] as const)('never revives confirmation after observed %s', boundary => {
    const state = setup(); const add = vi.fn(); let current = state; let destination = 'Original draft'
    const tree = () => <StrictMode><MemoryRouter><ExercisePicker workouts={current.workouts} state={current} disabled={false} onAdd={add} destination={destination} /></MemoryRouter></StrictMode>
    const view = render(tree()); fireEvent.click(screen.getByText('Add from exercise library')); fireEvent.click(screen.getByRole('button', { name: 'Add Copy generation probe' }))
    expect(screen.getByRole('button', { name: 'Confirm copy into plan draft' })).toBeEnabled()
    const library = state.exerciseLibrary!; const entry = library.entries[0]
    if (boundary === 'destination edit/restore') destination = 'Changed draft'
    if (boundary === 'archive/restore') entry.status = 'archived'
    if (boundary === 'content edit/revert') entry.exercise.name = 'Changed personal content'
    if (boundary === 'library identity restore') state.exerciseLibrary = structuredClone(library)
    if (boundary === 'state identity restore') current = structuredClone(state)
    view.rerender(tree())
    destination = 'Original draft'; entry.status = 'active'; entry.exercise.name = 'Copy generation probe'; state.exerciseLibrary = library; current = state
    view.rerender(tree())
    // Assert the newly rendered control too. Revoking only an old callback is insufficient in StrictMode.
    const freshConfirm = screen.queryByRole('button', { name: 'Confirm copy into plan draft' })
    if (freshConfirm) {
      expect(freshConfirm).toBeDisabled()
      const callback = retained(freshConfirm); act(() => callback()); fireEvent.click(freshConfirm)
    }
    expect(add).not.toHaveBeenCalled()
    // A new explicit selection is still usable after cancelling any retained stale view.
    const cancel = screen.queryByRole('button', { name: 'Cancel library copy' }); if (cancel) fireEvent.click(cancel)
    fireEvent.click(screen.getByRole('button', { name: 'Add Copy generation probe' })); const fresh = screen.getByRole('button', { name: 'Confirm copy into plan draft' }); expect(fresh).toBeEnabled(); fireEvent.click(fresh)
    expect(add).toHaveBeenCalledTimes(1)
  })
})


describe('independent actual PlanEditor draft-copy scope', () => {
  it.each(['name', 'reps', 'set count'] as const)('does not revive a fresh confirmation after outer exercise %s changes and returns', field => {
    const state = setup(); const update = vi.fn(() => false)
    render(<StrictMode><MemoryRouter><PlanEditor state={state} update={update} /></MemoryRouter></StrictMode>)
    fireEvent.click(screen.getByText('Add from exercise library')); fireEvent.click(screen.getByRole('button', { name: 'Add Copy generation probe' }))
    const label = field === 'name' ? 'Exercise name' : field === 'reps' ? 'Target reps / seconds' : 'Sets'
    const input = screen.getAllByLabelText(label)[0] as HTMLInputElement; const original = input.value
    fireEvent.change(input, { target: { value: field === 'set count' ? String(Number(original) + 1) : 'Temporary changed value' } })
    fireEvent.change(input, { target: { value: original } })
    const freshConfirm = screen.queryByRole('button', { name: 'Confirm copy into plan draft' })
    if (freshConfirm) { expect(freshConfirm).toBeDisabled(); const callback = retained(freshConfirm); act(() => callback()); fireEvent.click(freshConfirm) }
    expect(readPlanDraft()!.exercises).toHaveLength(state.workouts[0].exercises.length); expect(update).not.toHaveBeenCalled()
  })
})
