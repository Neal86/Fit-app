// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import PlanEditor from './PlanEditor'
import type { UpdateState } from './WorkoutSession'
import { freshState } from '../storage'
import { readPlanDraft } from '../planDraft'
import type { AppState } from '../types'

let live: AppState
let revision = 0
let commits = 0
let fail: 'before' | 'after' | null = null
let captured: Parameters<UpdateState>[0]
function Host() {
  const [state, setState] = useState(() => { const next = freshState(); next.workouts[0].exercises = next.workouts[0].exercises.slice(0, 3).map(exercise => ({ ...exercise, sets: 3 })); return next }); live = state
  const navigate = useNavigate()
  const update: UpdateState = change => {
    captured = change; if (fail === 'before') return false
    try { const next = change(live); if (fail === 'after') return false; live = next; revision++; commits++; setState(next); return true } catch { return false }
  }
  return <><button onClick={() => navigate('/plan?changed=1')}>Navigate query</button><button onClick={() => navigate(-1)}>Navigate back</button><Routes><Route path="/plan" element={<PlanEditor state={state} update={update} readGeneration={() => revision} />} /></Routes></>
}
const mount = () => render(<StrictMode><MemoryRouter initialEntries={['/plan']}><Host /></MemoryRouter></StrictMode>)
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Create saved plan group' }))
const fill = () => {
  edit('Planned group name', 'Exact future group'); edit('Planned round count (1–20)', '2'); edit('Planned round rest (seconds, 0–900)', '37')
  live.workouts[0].exercises.slice(0, 2).forEach((exercise, index) => edit(`Planned movement ${index + 1}`, exercise.id))
  live.workouts[0].exercises.slice(0, 2).forEach((exercise, index) => [2, 1].forEach((setNumber, round) => edit(`Planned round ${round + 1} movement ${index + 1} row`, JSON.stringify([exercise.id, setNumber]))))
}
const review = () => fireEvent.click(screen.getByRole('button', { name: 'Review planned group' }))
const openReview = () => { open(); fill(); review() }
const confirm = () => screen.getByRole('button', { name: 'Confirm group in draft' })
const save = () => fireEvent.submit(screen.getByLabelText('Workout title').closest('form')!)
const retained = (element: HTMLElement, event = 'onClick') => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); revision = 0; commits = 0; fail = null; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('independent StrictMode planned grouping form and transaction lifetimes', { timeout: 30000 }, () => {
  it('keeps every cell explicitly empty, refuses partial review, and confirms only to the local draft once', () => {
    mount(); open(); edit('Planned group name', 'Exact future group'); edit('Planned round count (1–20)', '2'); edit('Planned round rest (seconds, 0–900)', '37')
    live.workouts[0].exercises.slice(0, 2).forEach((exercise, index) => edit(`Planned movement ${index + 1}`, exercise.id))
    for (let round = 1; round <= 2; round++) for (let movement = 1; movement <= 2; movement++) expect(screen.getByLabelText(`Planned round ${round} movement ${movement} row`)).toHaveValue('')
    review(); expect(screen.queryByRole('button', { name: 'Confirm group in draft' })).not.toBeInTheDocument()
    fill(); review(); const callback = retained(confirm()); act(() => { callback(); callback() })
    expect(commits).toBe(0); expect(live.workouts[0].plannedGrouping).toBeUndefined(); expect(readPlanDraft()!.plannedGrouping!.groups).toHaveLength(1)
    save(); expect(commits).toBe(1); expect(live.workouts[0].plannedGrouping!.groups[0].rounds.map(round => round.members.map(member => member.setNumber))).toEqual([[2, 2], [1, 1]])
  })
  it('a retained Cancel cannot erase newer name or row edits', () => {
    mount(); open(); const cancel = retained(screen.getByRole('button', { name: 'Cancel planned grouping' }))
    fill(); act(() => cancel()); expect(screen.getByLabelText('Planned group name')).toHaveValue('Exact future group')
    expect(screen.getByLabelText('Planned round 1 movement 1 row')).toHaveValue(JSON.stringify([live.workouts[0].exercises[0].id, 2]))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel planned grouping' })); expect(screen.queryByLabelText('Planned group name')).not.toBeInTheDocument()
  })
  it('does not let an old Cancel erase grouping details in the same batch as an outer draft edit', () => {
    mount(); open(); fill(); const cancel = retained(screen.getByRole('button', { name: 'Cancel planned grouping' })); const title = retained(screen.getByLabelText('Workout title'), 'onChange')
    act(() => { title({ target: { value: 'New outer draft' } }); cancel() })
    expect(screen.getByLabelText('Planned group name')).toHaveValue('Exact future group'); expect(screen.getByLabelText('Workout title')).toHaveValue('New outer draft')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel planned grouping' })); expect(screen.queryByLabelText('Planned group name')).not.toBeInTheDocument()
  })
  it('revokes retained Review on a raw numeric edit that restores an equal parsed value', () => {
    mount(); open(); fill(); const submit = retained(screen.getByRole('button', { name: 'Review planned group' }))
    edit('Planned round count (1–20)', '02'); edit('Planned round count (1–20)', '2'); act(() => submit())
    expect(screen.queryByRole('button', { name: 'Confirm group in draft' })).not.toBeInTheDocument(); review(); expect(confirm()).toBeEnabled()
  })
  it('rejects old Review in the same batch as an edit and never resurrects it after restoring the old name', () => {
    mount(); open(); fill(); const submit = retained(screen.getByRole('button', { name: 'Review planned group' })); const change = retained(screen.getByLabelText('Planned group name'), 'onChange')
    act(() => { change({ target: { value: 'Changed draft' } }); submit() }); expect(screen.queryByRole('button', { name: 'Confirm group in draft' })).not.toBeInTheDocument()
    edit('Planned group name', 'Exact future group'); act(() => submit()); expect(screen.queryByRole('button', { name: 'Confirm group in draft' })).not.toBeInTheDocument()
  })
  it.each(['outer edit restore', 'account', 'source mutation', 'route', 'unmount', 'back', 'cancel'] as const)('revokes a retained confirmation after %s', boundary => {
    const view = mount(); openReview(); const callback = retained(confirm())
    if (boundary === 'outer edit restore') { const original = live.workouts[0].title; edit('Workout title', 'Temporary'); edit('Workout title', original) }
    if (boundary === 'account') revision++
    if (boundary === 'source mutation') live.workouts[0].title = 'Externally mutated before render'
    if (boundary === 'route') { fireEvent.click(screen.getByRole('button', { name: 'Navigate query' })); fireEvent.click(screen.getByRole('button', { name: 'Navigate back' })) }
    if (boundary === 'unmount') view.unmount()
    if (boundary === 'back') fireEvent.click(screen.getByRole('button', { name: 'Back to planned group details' }))
    if (boundary === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel planned grouping' }))
    act(() => callback()); expect(live.workouts[0].plannedGrouping).toBeUndefined(); expect(readPlanDraft()?.plannedGrouping).toBeUndefined(); expect(commits).toBe(0)
  })
  it.each(['before', 'after'] as const)('retains confirmed draft after failed %s save and revokes the deferred reducer while a fresh retry succeeds', failure => {
    mount(); openReview(); fireEvent.click(confirm()); const draft = readPlanDraft(); const original = live; fail = failure; save(); const stale = captured
    expect(live).toBe(original); expect(readPlanDraft()).toEqual(draft); expect(() => stale(original)).toThrow(/changed|current/i)
    fail = null; save(); expect(commits).toBe(1); expect(live.workouts[0].plannedGrouping).toEqual(draft!.plannedGrouping); expect(readPlanDraft()).toBeNull()
    expect(() => stale(original)).toThrow(/changed|current/i)
  })
  it('rejects member deletion and referenced set reduction until group removal is reviewed and confirmed', () => {
    mount(); openReview(); fireEvent.click(confirm()); const draft = readPlanDraft()!
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove exercise' })[0]); expect(readPlanDraft()).toEqual(draft)
    fireEvent.change(screen.getAllByLabelText('Sets')[0], { target: { value: '1' } }); expect(readPlanDraft()).toEqual(draft); expect(screen.getAllByLabelText('Sets')[0]).toHaveValue(3)
    fireEvent.click(screen.getByRole('button', { name: 'Review removal of Exact future group' })); const cancel = retained(screen.getByRole('button', { name: 'Cancel planned grouping' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm group removal in draft' })); act(() => cancel()); expect(readPlanDraft()!.plannedGrouping).toBeUndefined()
    fireEvent.change(screen.getAllByLabelText('Sets')[0], { target: { value: '1' } }); save(); expect(live.workouts[0].exercises[0].sets).toBe(1); expect(live.workouts[0].plannedGrouping).toBeUndefined()
  })
})
