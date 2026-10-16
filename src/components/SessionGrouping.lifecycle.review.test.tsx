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
const setup = () => { const state = freshState(); state.activeSession = startSession({ ...state.workouts[0], exercises: state.workouts[0].exercises.slice(0, 3).map(exercise => ({ ...exercise, sets: 3 })) }); state.activeSession.runningSince = null; state.activeSession.sets.forEach(row => { row.reps = 8 }); return state }
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
const mount = () => render(<StrictMode><MemoryRouter initialEntries={['/workouts/upper-power']}><Host initial={setup()} /></MemoryRouter></StrictMode>)
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const openReview = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Create session group' }))
  edit('Group name', 'Lifecycle group'); edit('Round count (1–50)', '1'); edit('Rest after each round (seconds, 0–900)', '41')
  live.activeSession!.workout.exercises.slice(0, 2).forEach((exercise, i) => edit(`Movement ${i + 1}`, exercise.id))
  live.activeSession!.workout.exercises.slice(0, 2).forEach((exercise, i) => edit(`Round 1 movement ${i + 1} row`, live.activeSession!.sets.find(row => row.exerciseId === exercise.id)!.id))
  fireEvent.click(screen.getByRole('button', { name: 'Review session group' }))
}
const confirm = () => screen.getByRole('button', { name: 'Confirm session group' })
const retained = (element: HTMLElement, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { revision = 0; captureWithoutInvocation = false; rejectAfterInvocation = false; commits = 0; vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('independent StrictMode grouping callback lifetime', { timeout: 30000 }, () => {
  it('accepts immediate grouping before any timer tick and synchronously revokes successful confirmation', () => {
    vi.useFakeTimers(); mount(); openReview(); const callback = retained(confirm(), 'onClick')
    act(() => { callback(); callback() }); expect(commits).toBe(1); expect(live.activeSession!.grouping!.groups).toHaveLength(1)
    expect(() => captured(live)).toThrow(/current|changed/)
  })
  it('does not let an old Cancel erase a newer group-form edit', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Create session group' }))
    const cancel = retained(screen.getByRole('button', { name: 'Cancel grouping' }), 'onClick')
    edit('Group name', 'New exact draft'); act(() => cancel())
    expect(screen.getByLabelText('Group name')).toHaveValue('New exact draft'); expect(commits).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel grouping' })); expect(screen.queryByRole('region', { name: 'Session grouping' })).not.toBeInTheDocument()
  })
  it('does not let a retained form submission resurrect changed-and-restored metadata in the same batch', () => {
    mount(); openReview(); fireEvent.click(screen.getByRole('button', { name: 'Back to group details' }))
    const form = screen.getByRole('region', { name: 'Session grouping' }).querySelector('form')!
    const submit = retained(form, 'onSubmit'); const name = retained(screen.getByLabelText('Group name'), 'onChange')
    act(() => { name({ target: { value: 'Other' } }); submit({ preventDefault() {} }) })
    expect(screen.queryByRole('button', { name: 'Confirm session group' })).not.toBeInTheDocument()
    edit('Group name', 'Lifecycle group'); act(() => submit({ preventDefault() {} }))
    expect(screen.queryByRole('button', { name: 'Confirm session group' })).not.toBeInTheDocument(); expect(commits).toBe(0)
  })
  it.each([false, true])('closes a failed synchronous attempt after reducer invocation=%s and supports a fresh exact retry', invoked => {
    mount(); openReview(); captureWithoutInvocation = !invoked; rejectAfterInvocation = invoked
    const original = live; fireEvent.click(confirm()); const failed = captured
    expect(() => failed(original)).toThrow(/current|changed/)
    captureWithoutInvocation = false; rejectAfterInvocation = false; fireEvent.click(confirm())
    expect(commits).toBe(1); expect(() => failed(original)).toThrow(/current|changed/); expect(() => captured(live)).toThrow(/current|changed/)
  })
  it('rejects account generation change before rerender and changed-restored current-session source', () => {
    mount(); openReview(); const callback = retained(confirm(), 'onClick'); revision++
    act(() => callback()); expect(commits).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel grouping' })); openReview()
    const second = retained(confirm(), 'onClick'); const original = live
    act(() => { replace({ ...live, activeSession: null }); replace(original); second() }); expect(commits).toBe(0)
  })
  it.each(['cancel', 'back', 'route', 'unmount'])('revokes retained confirm and deferred reducer after %s', boundary => {
    const view = mount(); openReview(); const callback = retained(confirm(), 'onClick')
    captureWithoutInvocation = true; fireEvent.click(confirm()); const reducer = captured; const original = live
    if (boundary === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel grouping' }))
    if (boundary === 'back') fireEvent.click(screen.getByRole('button', { name: 'Back to group details' }))
    if (boundary === 'route') { fireEvent.click(screen.getByRole('button', { name: 'Navigate query' })); fireEvent.click(screen.getByRole('button', { name: 'Navigate back' })) }
    if (boundary === 'unmount') view.unmount()
    captureWithoutInvocation = false; act(() => callback()); expect(commits).toBe(0); expect(() => reducer(original)).toThrow(/current|changed/)
  })
  it('invalidates a review after raw load text changes back to its original value', () => {
    mount(); openReview(); const callback = retained(confirm(), 'onClick')
    edit('Bench Press set 1 weight', '.'); edit('Bench Press set 1 weight', '')
    expect(confirm()).toBeDisabled(); act(() => callback()); expect(commits).toBe(0)
  })
  it.each([false, true])('revokes a failed completion attempt after reducer invocation=%s and retries without double rest', invoked => {
    mount(); openReview(); fireEvent.click(confirm()); fireEvent.click(screen.getByRole('button', { name: 'Complete Bench Press set 1' }))
    captureWithoutInvocation = !invoked; rejectAfterInvocation = invoked
    const before = live; fireEvent.click(screen.getByRole('button', { name: 'Complete Barbell Row set 1' })); const failed = captured
    expect(() => failed(before)).toThrow(/current|changed/); expect(live).toBe(before)
    captureWithoutInvocation = false; rejectAfterInvocation = false
    const callback = retained(screen.getByRole('button', { name: 'Complete Barbell Row set 1' }), 'onClick')
    act(() => { callback(); callback() }); expect(commits).toBe(3)
    expect(() => failed(before)).toThrow(/current|changed/); expect(() => captured(live)).toThrow(/current|changed/)
  })
  it.each([false, true])('revokes retained grouped-replacement reducers after failed invocation=%s, preserving exact references on retry', invoked => {
    mount(); openReview(); fireEvent.click(confirm()); fireEvent.click(screen.getByRole('button', { name: 'Complete Barbell Row set 1' }))
    const before = live; const oldGroup = structuredClone(live.activeSession!.grouping!)
    fireEvent.click(screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Front Plank' }))
    captureWithoutInvocation = !invoked; rejectAfterInvocation = invoked
    fireEvent.click(screen.getByRole('button', { name: /Confirm replacement and reset/ })); const failed = captured
    expect(live).toBe(before); expect(() => failed(before)).toThrow(/current|changed/)
    captureWithoutInvocation = false; rejectAfterInvocation = false
    const callback = retained(screen.getByRole('button', { name: /Confirm replacement and reset/ }), 'onClick')
    act(() => { callback(); callback() }); expect(commits).toBe(3)
    const nextGroup = live.activeSession!.grouping!.groups[0]
    expect(nextGroup.id).toBe(oldGroup.groups[0].id); expect(nextGroup.rounds[0].id).toBe(oldGroup.groups[0].rounds[0].id)
    expect(nextGroup.rounds[0].setIds[1]).toBe(oldGroup.groups[0].rounds[0].setIds[1]); expect(nextGroup.rounds[0].setIds[0]).not.toBe(oldGroup.groups[0].rounds[0].setIds[0])
    expect(() => failed(before)).toThrow(/current|changed/); expect(() => captured(live)).toThrow(/current|changed/)
  })
  it('rejects pre-group row edits, raw setter and completion callbacks after grouping commits', () => {
    mount(); const oldComplete = retained(screen.getByRole('button', { name: 'Complete Bench Press set 1' }), 'onClick')
    const oldLoad = retained(screen.getByLabelText('Bench Press set 1 weight'), 'onChange')
    const oldReps = retained(screen.getByLabelText('Bench Press set 1 reps'), 'onChange')
    openReview(); fireEvent.click(confirm()); const before = structuredClone(live)
    act(() => { oldComplete(); oldLoad({ target: { value: '999' } }); oldReps({ target: { value: '900' } }) })
    expect(live).toEqual(before); expect(screen.getByLabelText('Bench Press set 1 weight')).toHaveValue(''); expect(commits).toBe(1)
  })
})
