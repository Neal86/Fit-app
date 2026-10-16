// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, parseBackup, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import type { AppState } from './types'
import { loadState as oldLoadState, saveState as oldSaveState } from './testFixtures/preGroupingStorage'

const setup = (unit: 'metric' | 'imperial' = 'imperial') => {
  const state = freshState(); state.profile.onboardingComplete = true; state.profile.unit = unit
  state.activeSession = startSession({ ...state.workouts[0], exercises: state.workouts[0].exercises.slice(0, 3).map(exercise => ({ ...exercise, sets: 3 })) }); state.activeSession.runningSince = null
  state.activeSession.elapsedSeconds = 124.123; state.activeSession.restUntil = Date.now() + 60000
  state.activeSession.sets.forEach(row => { row.reps = 8 })
  Object.assign(state.activeSession.sets[6], { completed: true, warmup: true, weightKg: 29.123456789, rpe: 7.5 })
  const prior = structuredClone(state.activeSession); prior.id = 'historical-session'; prior.sets[0].completed = true
  state.logs = [finishSession(prior)]; state.planHistory = [{ id: 'prior-plan', savedAt: prior.startedAt, label: 'Prior', workouts: structuredClone(state.workouts) }]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state
}
const saved = (): AppState => parseBackup(localStorage.getItem(STORAGE_KEY)!)
const mount = (path = '/workouts/upper-power') => render(<StrictMode><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></StrictMode>)
const region = () => screen.getByRole('region', { name: 'Session grouping' })
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const weight = (name = 'Bench Press', set = 1) => screen.getByLabelText(`${name} set ${set} weight`)
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Create session group' }))
const fill = (state: AppState) => {
  edit('Group name', 'My exact group'); edit('Round count (1–50)', '2'); edit('Rest after each round (seconds, 0–900)', '37')
  state.activeSession!.workout.exercises.slice(0, 2).forEach((exercise, movement) => edit(`Movement ${movement + 1}`, exercise.id))
  state.activeSession!.workout.exercises.slice(0, 2).forEach((exercise, movement) => {
    state.activeSession!.sets.filter(row => row.exerciseId === exercise.id).slice(0, 2).forEach((row, round) => edit(`Round ${round + 1} movement ${movement + 1} row`, row.id))
  })
}
const review = () => fireEvent.click(screen.getByRole('button', { name: 'Review session group' }))
const confirm = () => screen.getByRole('button', { name: 'Confirm session group' })
const retained = (element: HTMLElement, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('independent actual App grouping persistence and rest', { timeout: 30000 }, () => {
  it.each(['metric', 'imperial'] as const)('retains invalid/valid raw %s loads and exact reviewed selections on quota failure, retries once then reloads metadata', unit => {
    const original = setup(unit); mount(); edit('Bench Press set 1 weight', '.'); fireEvent.blur(weight())
    edit('Barbell Row set 1 weight', '0079.50'); open(); fill(original); review()
    const before = localStorage.getItem(STORAGE_KEY); const oldConfirm = retained(confirm(), 'onClick')
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError') })
    fireEvent.click(confirm())
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before); expect(weight()).toHaveValue('.'); expect(weight('Barbell Row')).toHaveValue('0079.50')
    expect(within(region()).getByRole('alert')).toHaveTextContent('not saved'); expect(confirm()).toBeEnabled()
    quota.mockRestore(); const retry = retained(confirm(), 'onClick'); act(() => { retry(); retry(); oldConfirm() })
    const next = saved(); expect(next.activeSession!.grouping!.groups).toHaveLength(1)
    expect(next.activeSession!.grouping!.groups[0]).toMatchObject({ name: 'My exact group', restSeconds: 37 })
    expect(next.activeSession!.grouping!.groups[0].rounds.map(round => round.setIds)).toEqual([0, 1].map(index => original.activeSession!.workout.exercises.slice(0, 2).map(exercise => original.activeSession!.sets.filter(row => row.exerciseId === exercise.id)[index].id)))
    expect(next.activeSession!.sets).toEqual(original.activeSession!.sets); expect(next.activeSession!.workout).toEqual(original.activeSession!.workout)
    expect(next.activeSession!.restUntil).toBe(original.activeSession!.restUntil); expect(next.activeSession!.elapsedSeconds).toBe(original.activeSession!.elapsedSeconds)
    expect(next.logs).toEqual(original.logs); expect(next.workouts).toEqual(original.workouts); expect(next.planHistory).toEqual(original.planHistory)
    expect(weight()).toHaveValue('.'); expect(weight('Barbell Row')).toHaveValue('0079.50')
    cleanup(); mount(); expect(saved()).toEqual(next); expect(weight()).toHaveValue(''); expect(weight('Barbell Row')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Review removal of My exact group' })).toBeInTheDocument()
  })
  it('preserves a concurrent saved snapshot through stale-tab retries and reload', () => {
    const state = setup(); mount(); edit('Bench Press set 1 weight', '.'); open(); fill(state); review()
    const external = saved(); external.activeSession!.notes = 'Concurrent save after review'; const externalRaw = JSON.stringify(external)
    localStorage.setItem(STORAGE_KEY, externalRaw); fireEvent.click(confirm()); fireEvent.click(confirm())
    expect(localStorage.getItem(STORAGE_KEY)).toBe(externalRaw); expect(weight()).toHaveValue('.'); expect(confirm()).toBeEnabled()
    cleanup(); mount(); expect(saved()).toEqual(external); expect(screen.getByLabelText('Session notes')).toHaveValue('Concurrent save after review')
    expect(screen.queryByRole('button', { name: 'Review removal of My exact group' })).not.toBeInTheDocument()
  })
  it.each(['metric', 'imperial'] as const)('keeps valid blurred %s load canonical while an invalid sibling draft survives grouping', unit => {
    const state = setup(unit); mount(); edit('Bench Press set 1 weight', '.'); fireEvent.blur(weight())
    edit('Barbell Row set 1 weight', '12.25'); fireEvent.blur(weight('Barbell Row'))
    const before = saved(); open(); fill(before); review(); fireEvent.click(confirm())
    expect(saved().activeSession!.sets).toEqual(before.activeSession!.sets); expect(weight()).toHaveValue('.')
    const barbell = state.activeSession!.workout.exercises.find(item => item.name === 'Barbell Row')!
    const kg = saved().activeSession!.sets.find(item => item.exerciseId === barbell.id)!.weightKg
    expect(kg).toBeCloseTo(unit === 'metric' ? 12.25 : 5.5565065325, 9)
  })
  it('never auto-selects rows and rejects partial grids', () => {
    const state = setup(); mount(); open(); edit('Group name', 'Explicit only'); edit('Round count (1–50)', '2')
    state.activeSession!.workout.exercises.slice(0, 2).forEach((exercise, movement) => edit(`Movement ${movement + 1}`, exercise.id))
    for (let round = 1; round <= 2; round++) for (let movement = 1; movement <= 2; movement++) expect(screen.getByLabelText(`Round ${round} movement ${movement} row`)).toHaveValue('')
    review(); expect(screen.queryByRole('button', { name: 'Confirm session group' })).not.toBeInTheDocument(); expect(saved()).toEqual(state)
  })
  it('completes out of order, rejects replay and keeps exact chosen countdown across StrictMode hydration', () => {
    vi.useFakeTimers(); const now = Date.parse('2026-10-16T12:00:00Z'); vi.setSystemTime(now)
    const state = setup(); mount(); open(); fill(state); review(); fireEvent.click(confirm())
    const existing = saved().activeSession!.restUntil
    fireEvent.click(screen.getByRole('button', { name: 'Complete Barbell Row set 2' })); expect(saved().activeSession!.restUntil).toBe(existing)
    const final = screen.getByRole('button', { name: 'Complete Bench Press set 2' }); const oldComplete = retained(final, 'onClick')
    act(() => { oldComplete(); oldComplete() }); const completed = saved(); expect(completed.activeSession!.restUntil).toBe(now + 37000)
    act(() => { vi.advanceTimersByTime(5000); oldComplete() }); expect(saved()).toEqual(completed)
    cleanup(); mount(); expect(saved()).toEqual(completed); expect(screen.getByText('Rest: 00:32')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo Bench Press set 2' })); expect(saved().activeSession!.restUntil).toBe(now + 37000)
    expect(screen.getByTestId('session-timer')).toHaveTextContent('02:04')
  })
  it('never starts round rest for invalid loads or failed final completion; exact retry starts it once', () => {
    vi.useFakeTimers(); const now = Date.parse('2026-10-16T12:00:00Z'); vi.setSystemTime(now)
    const state = setup(); mount(); open(); fill(state); review(); fireEvent.click(confirm())
    fireEvent.click(screen.getByRole('button', { name: 'Complete Bench Press set 1' }))
    const before = saved(); edit('Barbell Row set 1 weight', '.')
    fireEvent.click(screen.getByRole('button', { name: 'Complete Barbell Row set 1' })); expect(saved()).toEqual(before); expect(weight('Barbell Row')).toHaveValue('.')
    edit('Barbell Row set 1 weight', '0079.50')
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full') })
    fireEvent.click(screen.getByRole('button', { name: 'Complete Barbell Row set 1' })); expect(saved()).toEqual(before); expect(weight('Barbell Row')).toHaveValue('0079.50')
    quota.mockRestore(); const retry = retained(screen.getByRole('button', { name: 'Complete Barbell Row set 1' }), 'onClick')
    act(() => { vi.advanceTimersByTime(5000); retry(); retry() })
    expect(saved().activeSession!.restUntil).toBe(now + 42000)
    const row = saved().activeSession!.sets.find(row => row.id === before.activeSession!.grouping!.groups[0].rounds[0].setIds[1])!
    expect(row.weightKg).toBeCloseTo(36.060593415, 9); expect(row.completed).toBe(true)
  })
  it('blocks grouped-row removal and warmup, leaves added rows ungrouped and saves historical exact labels', () => {
    const state = setup(); mount(); open(); fill(state); review(); fireEvent.click(confirm())
    expect(screen.getByRole('button', { name: 'Remove Bench Press set 1' })).toBeDisabled()
    const panel = screen.getByRole('article', { name: 'Bench Press' }); expect(within(panel).getByRole('checkbox', { name: 'Bench Press set 1 warm-up' })).toBeDisabled()
    const before = saved(); fireEvent.click(within(panel).getByRole('button', { name: 'Add set' }))
    const added = saved(); expect(added.activeSession!.grouping).toEqual(before.activeSession!.grouping); expect(added.activeSession!.sets.length).toBe(before.activeSession!.sets.length + 1)
    fireEvent.click(screen.getByRole('button', { name: 'Complete Bench Press set 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' }))
    const finished = saved(); expect(finished.activeSession).toBeNull(); expect(finished.logs[0].grouping).toEqual(before.activeSession!.grouping)
    expect(finished.logs[0].sets).toHaveLength(added.activeSession!.sets.length)
    expect(finished.logs[0].exerciseSnapshots).toEqual(before.activeSession!.workout.exercises.map(({ id, name, category }) => ({ id, name, category })))
    expect(screen.getByText('My exact group')).toBeInTheDocument()
  })
  it('retains removal review on storage failure and removes only metadata after retry', () => {
    const state = setup(); mount(); open(); fill(state); review(); fireEvent.click(confirm())
    const grouped = saved(); fireEvent.click(screen.getByRole('button', { name: 'Review removal of My exact group' }))
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full') })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of grouping' })); expect(saved()).toEqual(grouped)
    quota.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of grouping' }))
    const next = saved(); expect(next.activeSession!.grouping).toBeUndefined(); expect(next.activeSession!.sets).toEqual(grouped.activeSession!.sets)
    expect(next.activeSession!.restUntil).toBe(grouped.activeSession!.restUntil)
  })
  it('the exact previous storage reader preserves grouped raw bytes and cannot overwrite them through an old save', () => {
    const state = setup(); mount(); open(); fill(state); review(); fireEvent.click(confirm())
    const next = saved(); const raw = localStorage.getItem(STORAGE_KEY)
    const old = oldLoadState()
    expect(old.error).toMatch(/invalid|incomplete/); expect(old.raw).toBe(raw)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
    expect(() => oldSaveState(next, raw)).toThrow(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })
  it('keeps invalid saved grouping bytes untouched in recovery and rejects an invalid backup import', async () => {
    const state = setup(); Object.assign(state.activeSession!, { grouping: { version: 1, groups: [] } }); const invalid = JSON.stringify(state)
    localStorage.setItem(STORAGE_KEY, invalid); mount(); expect(screen.getByText('Your saved data needs attention')).toBeInTheDocument(); expect(localStorage.getItem(STORAGE_KEY)).toBe(invalid)
    const input = screen.getByLabelText('Restore backup'); const file = new File(['bad'], 'invalid.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => invalid })
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(localStorage.getItem(STORAGE_KEY)).toBe(invalid); expect(window.confirm).not.toHaveBeenCalled()
    cleanup(); const valid = setup(); const before = localStorage.getItem(STORAGE_KEY); mount('/profile')
    const importInput = document.querySelector('input[type="file"]')!
    await act(async () => { fireEvent.change(importInput, { target: { files: [file] } }) })
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before); expect(saved()).toEqual(valid); expect(window.confirm).not.toHaveBeenCalled()
  })
})
