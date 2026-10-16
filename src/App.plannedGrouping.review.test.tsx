// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, parseBackup, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import { PLAN_DRAFT_KEY, readPlanDraft, savePlanDraft } from './planDraft'
import type { AppState } from './types'

const now = Date.parse('2026-10-16T12:00:00Z')
const setup = () => {
  const state = freshState(); state.profile.onboardingComplete = true
  state.workouts[0].exercises = state.workouts[0].exercises.slice(0, 3).map(exercise => ({ ...exercise, sets: 3 }))
  const workout = state.workouts[0]
  workout.plannedGrouping = { version: 1, groups: [{ id: 'saved-group', name: 'Saved exact circuit', restSeconds: 37, rounds: [2, 1].map((setNumber, index) => ({ id: `saved-round-${index}`, members: workout.exercises.slice(0, 2).map(exercise => ({ exerciseId: exercise.id, setNumber })) })) }] }
  state.activeSession = startSession(workout, now); state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 123.125; state.activeSession.restUntil = now + 60000
  state.activeSession.sets.forEach(row => { row.reps = 8 }); state.activeSession.sets[0].weightKg = 19.123456789
  const previous = structuredClone(state.activeSession); previous.id = 'previous-session'; previous.sets[0].completed = true
  state.logs = [finishSession(previous, now + 60000)]
  state.planHistory = [{ id: 'earlier-plan', savedAt: new Date(now).toISOString(), label: 'Earlier exact plan', workouts: structuredClone(state.workouts) }]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state
}
const mount = (path = '/plan') => render(<StrictMode><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></StrictMode>)
const saved = (): AppState => parseBackup(localStorage.getItem(STORAGE_KEY)!)
const save = () => fireEvent.submit(screen.getByLabelText('Workout title').closest('form')!)
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const blobText = (blob: Blob): Promise<string> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('independent actual App planned-group persistence', { timeout: 30000 }, () => {
  it('keeps grouping and recovery draft through quota failure, retries a rename atomically and reloads it', () => {
    const original = setup(); mount(); fireEvent.change(screen.getAllByLabelText('Exercise name')[0], { target: { value: 'Reviewed renamed exercise' } })
    const draft = sessionStorage.getItem(PLAN_DRAFT_KEY); const raw = localStorage.getItem(STORAGE_KEY); const setItem = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === STORAGE_KEY) throw new DOMException('Quota exceeded', 'QuotaExceededError'); setItem.call(this, key, value) })
    save(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(draft)
    expect(screen.getAllByLabelText('Exercise name')[0]).toHaveValue('Reviewed renamed exercise')
    failure.mockRestore(); save(); const next = saved(); const renamed = next.workouts[0].exercises[0]
    expect(renamed.id).not.toBe(original.workouts[0].exercises[0].id)
    expect(next.workouts[0].plannedGrouping!.groups[0].rounds.map(round => round.members[0].exerciseId)).toEqual([renamed.id, renamed.id])
    expect(next.workouts[0].plannedGrouping!.groups[0].rounds.map(round => round.members[0].setNumber)).toEqual([2, 1])
    expect(next.activeSession).toEqual(original.activeSession); expect(next.logs).toEqual(original.logs); expect(next.planHistory[0].workouts).toEqual(original.workouts)
    expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBeNull(); cleanup(); mount(); expect(saved()).toEqual(next); expect(screen.getAllByLabelText('Exercise name')[0]).toHaveValue('Reviewed renamed exercise')
  })
  it('announces a failed Start once, keeps the inline explanation associated, and clears both errors on a successful retry', () => {
    const original = setup(); original.activeSession = null; localStorage.setItem(STORAGE_KEY, JSON.stringify(original)); mount('/workouts/upper-power')
    const raw = localStorage.getItem(STORAGE_KEY); const setItem = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === STORAGE_KEY) throw new Error('Storage full'); setItem.call(this, key, value) })
    fireEvent.click(screen.getByRole('button', { name: 'Start workout' }))
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw); expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('Storage full')
    const start = screen.getByRole('button', { name: 'Start workout' }); const description = start.getAttribute('aria-describedby')
    expect(description).toBeTruthy(); expect(document.getElementById(description!)).toHaveTextContent('Workout was not started')
    failure.mockRestore(); fireEvent.click(start)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByText(/Workout was not started/)).not.toBeInTheDocument()
    expect(saved().activeSession!.grouping!.groups[0].name).toBe('Saved exact circuit'); expect(saved().logs).toEqual(original.logs)
  })
  it('preserves external saved bytes across stale-tab save attempts and reload', () => {
    setup(); mount(); edit('Workout title', 'Uncommitted title'); const draft = sessionStorage.getItem(PLAN_DRAFT_KEY)
    const external = saved(); external.workouts[0].plannedGrouping!.groups[0].name = 'Changed elsewhere'; const raw = JSON.stringify(external); localStorage.setItem(STORAGE_KEY, raw)
    save(); save(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(draft)
    cleanup(); mount(); expect(saved()).toEqual(external); expect(screen.getByLabelText('Workout title')).toHaveValue('Uncommitted title')
    expect(screen.getByText(/This recovered draft differs/)).toBeInTheDocument()
  })
  it('recovers incomplete zero set-count input without dropping groups, rejects save, then repairs and saves', () => {
    const state = setup(); const draft = structuredClone(state.workouts[0]); draft.exercises[0].sets = 0; draft.title = 'Recovered draft'; savePlanDraft(draft)
    const raw = localStorage.getItem(STORAGE_KEY); expect(readPlanDraft()).toEqual(draft); mount()
    expect(screen.getAllByLabelText('Sets')[0]).toHaveValue(0); expect(readPlanDraft()!.plannedGrouping).toEqual(draft.plannedGrouping)
    save(); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw); expect(readPlanDraft()).toEqual(draft)
    fireEvent.change(screen.getAllByLabelText('Sets')[0], { target: { value: '3' } }); save()
    expect(saved().workouts[0]).toEqual({ ...draft, exercises: state.workouts[0].exercises }); expect(saved().activeSession).toEqual(state.activeSession)
  })
  it('restores exact historical planned groups only after persistence succeeds, retaining an unsaved recovery draft on failure', () => {
    const state = setup(); state.workouts[0].plannedGrouping!.groups[0].name = 'Current definition'; localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); mount(); edit('Workout title', 'Unsaved draft')
    const draft = sessionStorage.getItem(PLAN_DRAFT_KEY); const raw = localStorage.getItem(STORAGE_KEY); const setItem = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === STORAGE_KEY) throw new Error('Full'); setItem.call(this, key, value) })
    fireEvent.click(screen.getByRole('button', { name: 'Restore version' })); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(draft)
    failure.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Restore version' }))
    const restored = saved(); expect(restored.workouts).toEqual(state.planHistory[0].workouts); expect(restored.planHistory[0].workouts).toEqual(state.workouts)
    expect(restored.activeSession).toEqual(state.activeSession); expect(restored.logs).toEqual(state.logs); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBeNull()
  })
  it('exports both current and historic planned definitions without mutating the saved active countdown', async () => {
    const original = setup(); mount('/profile'); let exported: Blob | undefined
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn((blob: Blob) => { exported = blob; return 'blob:review-export' }), revokeObjectURL: vi.fn() }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' })); expect(exported).toBeDefined()
    const result = parseBackup(await blobText(exported!)); expect(result.workouts).toEqual(original.workouts); expect(result.planHistory).toEqual(original.planHistory)
    expect(result.logs).toEqual(original.logs); expect(result.activeSession!.grouping).toEqual(original.activeSession!.grouping)
    expect(result.activeSession!.runningSince).toBeNull(); expect(result.activeSession!.restUntil).toBeNull(); expect(saved()).toEqual(original)
  })
  it('leaves invalid planned data untouched in recovery and rejects invalid import before confirmation', async () => {
    const state = setup(); state.workouts[0].plannedGrouping!.groups[0].rounds[0].members[0].setNumber = 99
    const invalid = JSON.stringify(state); localStorage.setItem(STORAGE_KEY, invalid); mount()
    expect(screen.getByText('Your saved data needs attention')).toBeInTheDocument(); expect(localStorage.getItem(STORAGE_KEY)).toBe(invalid)
    const file = new File(['invalid'], 'invalid.json', { type: 'application/json' }); Object.defineProperty(file, 'text', { value: async () => invalid })
    await act(async () => { fireEvent.change(screen.getByLabelText('Restore backup'), { target: { files: [file] } }) })
    expect(localStorage.getItem(STORAGE_KEY)).toBe(invalid); expect(window.confirm).not.toHaveBeenCalled()
    cleanup(); const valid = setup(); mount('/profile')
    await act(async () => { fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } }) })
    expect(saved()).toEqual(valid); expect(window.confirm).not.toHaveBeenCalled()
  })
})
