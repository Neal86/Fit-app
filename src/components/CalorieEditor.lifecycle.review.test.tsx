// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import PlanEditor from './PlanEditor'
import type { UpdateState } from './WorkoutSession'
import type { AppState } from '../types'
import { freshState, parseState } from '../storage'
import { PLAN_DRAFT_KEY, readPlanDraft } from '../planDraft'

let live: AppState
let generation = 0
let commits = 0
let fail = false
let deferred = false
let captured: Parameters<UpdateState>[0]
let replaceState: (state: AppState) => void
function View({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial); const navigate = useNavigate(); live = state
  replaceState = next => { live = next; generation++; setState(next) }
  const update: UpdateState = change => {
    captured = change
    if (deferred) return false
    try { const next = change(live); parseState(next); if (fail) return false; commits++; live = next; generation++; setState(next); return true } catch { return false }
  }
  return <><button onClick={() => navigate('/away')}>Away</button><button onClick={() => navigate('/plan?fresh=1')}>Query boundary</button><button onClick={() => navigate(-1)}>Back route</button><Routes><Route path="/plan" element={<PlanEditor state={state} update={update} readGeneration={() => generation} />} /><Route path="/away" element={<p>Other page</p>} /></Routes></>
}
const input = () => screen.getByLabelText('Estimated calories (kcal, optional)')
const change = (value: string) => fireEvent.change(input(), { target: { value } })
const save = () => fireEvent.submit(input().closest('form')!)
const retained = (element: Element, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
const unknown = () => ({ version: 1, status: 'unknown' })
const mount = (state = freshState()) => render(<StrictMode><MemoryRouter initialEntries={['/plan']}><View initial={state} /></MemoryRouter></StrictMode>)
beforeEach(() => { generation = 0; commits = 0; fail = false; deferred = false; localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('independent calorie editor source epochs and retries', () => {
  it.each(['known-unknown-known', 'unknown-known-unknown', 'normalization'] as const)('revokes a retained save even after %s restores identical displayed data', transition => {
    const state = freshState(); if (transition === 'unknown-known-unknown') Object.assign(state.workouts[0], { calories: unknown() })
    mount(state); const staleSave = retained(input().closest('form')!, 'onSubmit'); const original = state.workouts[0].calories
    if (transition === 'known-unknown-known') { change(''); change(String(original)) }
    if (transition === 'unknown-known-unknown') { change('0'); change('') }
    if (transition === 'normalization') act(() => retained(input(), 'onChange')({ target: { value: `0${String(original)}` } }))
    const recovery = sessionStorage.getItem(PLAN_DRAFT_KEY)
    act(() => staleSave({ preventDefault() {} })); expect(commits).toBe(0); expect(live).toBe(state); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(recovery)
    save(); expect(live.workouts[0].calories).toEqual(original); expect(commits).toBe(1)
  })
  it.each(['new draft edit', 'choose other plan', 'same-state restore', 'source change', 'generation', 'query', 'route', 'unmount'] as const)('revokes a retained calorie edit across %s', boundary => {
    const state = freshState(); mount(state); const oldChange = retained(input(), 'onChange')
    if (boundary === 'new draft edit') change('12.5')
    if (boundary === 'choose other plan') fireEvent.click(screen.getByRole('button', { name: 'Wednesday: Lower Body Strength' }))
    if (boundary === 'same-state restore') act(() => replaceState(structuredClone(live)))
    if (boundary === 'source change') act(() => { const next = structuredClone(live); next.workouts[0].calories = 99.125; replaceState(next) })
    if (boundary === 'generation') generation++
    if (boundary === 'query') fireEvent.click(screen.getByRole('button', { name: 'Query boundary' }))
    if (boundary === 'route') fireEvent.click(screen.getByRole('button', { name: 'Away' }))
    if (boundary === 'unmount') cleanup()
    const recovery = sessionStorage.getItem(PLAN_DRAFT_KEY); const saved = structuredClone(live)
    act(() => oldChange({ target: { value: '' } })); expect(live).toEqual(saved); expect(commits).toBe(0); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(recovery)
  })
  it.each([false, true])('revokes a failed or deferred updater and preserves exact unknown draft until a fresh retry (deferred=%s)', captureOnly => {
    const state = freshState(); mount(state); change(''); const raw = sessionStorage.getItem(PLAN_DRAFT_KEY)
    fail = true; deferred = captureOnly; save(); const stale = captured
    expect(live).toBe(state); expect(commits).toBe(0); expect(input()).toHaveValue(null); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(raw); expect(() => stale(state)).toThrow()
    fail = false; deferred = false; const retry = retained(input().closest('form')!, 'onSubmit')
    act(() => { retry({ preventDefault() {} }); retry({ preventDefault() {} }) })
    expect(commits).toBe(1); expect(live.workouts[0].calories).toEqual(unknown()); expect(live.planHistory).toHaveLength(1); expect(live.planHistory[0].workouts).toEqual(state.workouts); expect(readPlanDraft()).toBeNull()
    expect(() => captured(live)).toThrow()
  })
  it('requires selecting a current source after an identical-data restore, then retains the new exact input', () => {
    mount(); change(''); act(() => replaceState(structuredClone(live)))
    save(); expect(commits).toBe(0); expect(readPlanDraft()!.calories).toEqual(unknown()); expect(screen.getAllByRole('alert').map(item => item.textContent).join(' ')).toMatch(/changed/)
    fireEvent.click(screen.getByRole('button', { name: 'Monday: Upper Body Power' })); change('0.123456789012345'); save()
    expect(commits).toBe(1); expect(live.workouts[0].calories).toBe(0.123456789012345)
  })
})
