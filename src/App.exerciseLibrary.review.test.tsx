// @vitest-environment jsdom
// @vitest-environment-options {"storageQuota": 20000000}
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, MAX_BACKUP_BYTES, parseBackup, STORAGE_KEY } from './storage'
import { finishSession, startSession } from './session'
import { PLAN_DRAFT_KEY, readPlanDraft } from './planDraft'
import type { AppState, WorkoutLog } from './types'

const now = Date.parse('2026-10-16T00:00:00.000Z')
const setup = () => {
  const state = freshState(); state.profile.onboardingComplete = true
  state.exerciseLibrary = { version: 1, entries: [{ id: 'manual-personal', revision: 1, status: 'active', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), exercise: { name: 'Review personal movement', category: 'Review only', sets: 2, reps: '11–13', restSeconds: 29, notes: 'Written by me', equipment: [] } }] }
  state.activeSession = startSession(state.workouts[0], now); state.activeSession.runningSince = null; state.activeSession.elapsedSeconds = 123.125; state.activeSession.restUntil = now + 30000
  state.activeSession.sets[0].completed = true; state.activeSession.sets[0].reps = 8; state.activeSession.sets[0].weightKg = 39.123456789
  const old = structuredClone(state.activeSession); old.id = 'historic-before'; state.logs = [finishSession(old, now + 1000)]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state
}
const mount = (path = '/exercise-library') => render(<StrictMode><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></StrictMode>)
const saved = (): AppState => parseBackup(localStorage.getItem(STORAGE_KEY)!)
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const retained = (element: HTMLElement, event = 'onClick') => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
const fill = () => { edit('Library exercise name', 'Created review entry'); edit('Library set count (1–20)', '2'); edit('Library target reps or seconds', '9'); edit('Library rest seconds (0–900)', '17') }
const createReview = () => { fireEvent.click(screen.getByRole('button', { name: 'Create library exercise' })); fill(); fireEvent.click(screen.getByRole('button', { name: 'Review library exercise' })) }
const blobText = (blob: Blob): Promise<string> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob) })
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('independent actual App personal-library persistence', { timeout: 30000 }, () => {
  it('does not turn an unchanged valid explicit empty note into a content edit', () => {
    const state = setup(); state.exerciseLibrary!.entries[0].exercise.notes = ''; localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); mount()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Review personal movement' })); fireEvent.click(screen.getByRole('button', { name: 'Review library exercise' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm edit library exercise' }))
    expect(saved().exerciseLibrary).toEqual(state.exerciseLibrary)
  })
  it('asks before sidebar navigation discards a dirty temporary library form and respects refusal', () => {
    setup(); mount(); fireEvent.click(screen.getByRole('button', { name: 'Create library exercise' })); fill(); vi.mocked(window.confirm).mockReturnValue(false)
    fireEvent.click(screen.getAllByRole('link', { name: 'Home' })[0])
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/discard.*library/i)); expect(screen.getByLabelText('Library exercise name')).toHaveValue('Created review entry')
  })
  it('retains an exact reviewed form under quota failure, retries once and reloads only committed data', () => {
    const state = setup(); mount(); createReview(); const before = localStorage.getItem(STORAGE_KEY); const setItem = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === STORAGE_KEY) throw new DOMException('Full', 'QuotaExceededError'); setItem.call(this, key, value) })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm create library exercise' })); expect(localStorage.getItem(STORAGE_KEY)).toBe(before); expect(screen.getByRole('button', { name: 'Confirm create library exercise' })).toBeEnabled()
    failure.mockRestore(); const callback = retained(screen.getByRole('button', { name: 'Confirm create library exercise' })); act(() => { callback(); callback() })
    const next = saved(); expect(next.exerciseLibrary!.entries).toHaveLength(2); expect(next.exerciseLibrary!.entries[1].exercise).toMatchObject({ name: 'Created review entry', sets: 2, reps: '9', restSeconds: 17 })
    expect(next.workouts).toEqual(state.workouts); expect(next.logs).toEqual(state.logs); expect(next.activeSession).toEqual(state.activeSession)
    cleanup(); mount(); expect(screen.getByRole('heading', { name: 'Created review entry' })).toBeInTheDocument(); expect(saved()).toEqual(next)
  })
  it('preserves external library bytes and local form after repeated stale-tab failures', () => {
    setup(); mount(); createReview(); const external = saved(); external.exerciseLibrary!.entries[0].exercise.name = 'Changed elsewhere'; external.exerciseLibrary!.entries[0].revision = 2
    const raw = JSON.stringify(external); localStorage.setItem(STORAGE_KEY, raw)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm create library exercise' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm create library exercise' }))
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw); expect(screen.getByRole('button', { name: 'Confirm create library exercise' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to library details' })); expect(screen.getByLabelText('Library exercise name')).toHaveValue('Created review entry')
    cleanup(); mount(); expect(saved()).toEqual(external); expect(screen.getByRole('heading', { name: 'Changed elsewhere' })).toBeInTheDocument()
  })
  it('copies a personal entry into the recoverable plan draft only after review and retains ancestry through failed Save and retry', () => {
    const state = setup(); mount('/plan'); fireEvent.click(screen.getByText('Add from exercise library'))
    fireEvent.click(screen.getByRole('button', { name: 'Add Review personal movement' })); expect(readPlanDraft()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm copy into plan draft' })); const draft = readPlanDraft()!; expect(saved()).toEqual(state)
    expect(draft.exercises.at(-1)!.libraryOrigin).toEqual({ version: 1, entryId: 'manual-personal', revision: 1 }); expect(draft.exercises.at(-1)!.id).not.toBe('manual-personal')
    const raw = localStorage.getItem(STORAGE_KEY); const rawDraft = sessionStorage.getItem(PLAN_DRAFT_KEY); const setItem = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === STORAGE_KEY) throw new Error('Full'); setItem.call(this, key, value) })
    fireEvent.submit(screen.getByLabelText('Workout title').closest('form')!); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw); expect(sessionStorage.getItem(PLAN_DRAFT_KEY)).toBe(rawDraft)
    failure.mockRestore(); fireEvent.submit(screen.getByLabelText('Workout title').closest('form')!)
    expect(saved().workouts[0]).toEqual(draft); expect(saved().activeSession).toEqual(state.activeSession); expect(saved().logs).toEqual(state.logs)
    cleanup(); mount('/plan'); expect(screen.getAllByLabelText('Exercise name').at(-1)).toHaveValue('Review personal movement')
  })
  it('copies edited personal values into an addition, then keeps exact ancestry in completed history', () => {
    const state = setup(); mount('/workouts/upper-power'); fireEvent.click(screen.getByRole('button', { name: 'Add exercise to this session' })); fireEvent.click(screen.getByRole('button', { name: 'Use Review personal movement' }))
    edit('Session exercise name', 'Independently edited addition'); edit('Number of sets (1–20)', '1'); fireEvent.click(screen.getByRole('button', { name: 'Review session addition' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm addition of 1 sets' }))
    const added = saved(); const movement = added.activeSession!.workout.exercises.at(-1)!; expect(movement).toMatchObject({ name: 'Independently edited addition', sets: 1, libraryOrigin: { version: 1, entryId: 'manual-personal', revision: 1 } })
    expect(added.activeSession!.sets.slice(0, state.activeSession!.sets.length)).toEqual(state.activeSession!.sets); expect(added.activeSession!.restUntil).toBe(state.activeSession!.restUntil)
    fireEvent.click(screen.getByRole('button', { name: 'Finish and save workout' })); const next = saved(); expect(next.activeSession).toBeNull()
    expect(next.logs[0].exerciseSnapshots!.at(-1)).toMatchObject({ id: movement.id, name: movement.name, libraryOrigin: movement.libraryOrigin }); expect(next.exerciseLibrary).toEqual(state.exerciseLibrary)
  })
  it('reviews and resets only exact unfinished replacement rows while preserving completed work and copied ancestry', () => {
    const state = setup(); mount('/workouts/upper-power'); fireEvent.click(screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' })); fireEvent.click(screen.getByRole('button', { name: 'Choose Review personal movement' }))
    const region = screen.getByRole('region', { name: 'Session exercise replacement' }); expect(within(region).getByText(/All values and unsaved load text/)).toBeInTheDocument()
    const originalRows = state.activeSession!.sets.filter(row => row.exerciseId === state.activeSession!.workout.exercises[0].id); const count = originalRows.filter(row => !row.completed).length
    fireEvent.click(screen.getByRole('button', { name: `Confirm replacement and reset ${count} unfinished sets` })); const next = saved(); const movement = next.activeSession!.workout.exercises.find(exercise => exercise.libraryOrigin)!
    expect(next.activeSession!.sets.filter(row => row.exerciseId === movement.id)).toHaveLength(count); expect(next.activeSession!.sets.find(row => row.id === originalRows[0].id)).toEqual(originalRows[0])
    expect(movement.libraryOrigin).toEqual({ version: 1, entryId: 'manual-personal', revision: 1 }); expect(next.workouts).toEqual(state.workouts); expect(next.logs).toEqual(state.logs); expect(next.activeSession!.restUntil).toBe(state.activeSession!.restUntil)
  })
  it('exports a valid boundary-sized own backup that can be reimported, without pretty-print inflation', async () => {
    const state = setup(); state.activeSession = null
    const sample: WorkoutLog = { id: '', workoutId: 'unresolved-reference', title: 'Size-only synthetic log', startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(), duration: 0, calories: 0, completedExerciseIds: [], notes: '' }
    state.logs = Array.from({ length: 2600 }, (_, i) => ({ ...sample, id: `only-size-${i}` })); let bytes = MAX_BACKUP_BYTES - new Blob([JSON.stringify(state)]).size
    for (const log of state.logs) { const n = Math.min(1000, Math.floor(bytes / 4)); log.notes = '💪'.repeat(n); bytes -= n * 4; if (bytes < 4 && log.notes.length + bytes <= 2000) { log.notes += 'x'.repeat(bytes); bytes = 0 } }
    expect(bytes).toBe(0); const raw = JSON.stringify(state); expect(new Blob([raw]).size).toBe(MAX_BACKUP_BYTES); localStorage.setItem(STORAGE_KEY, raw); mount('/profile')
    let exported: Blob | undefined; vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn((blob: Blob) => { exported = blob; return 'blob:boundary-export' }), revokeObjectURL: vi.fn() })); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const scheduled = vi.spyOn(window, 'setTimeout'); fireEvent.click(screen.getByRole('button', { name: 'Export backup' })); scheduled.mock.results.forEach(result => window.clearTimeout(result.value)); expect(exported).toBeDefined(); const result = await blobText(exported!)
    expect(new Blob([result]).size).toBe(MAX_BACKUP_BYTES); expect(parseBackup(result)).toEqual(state); expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })
})
