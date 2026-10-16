// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, parseBackup, STORAGE_KEY } from './storage'
import { readPlanDraft } from './planDraft'
import { finishSession, startSession } from './session'
import type { AppState } from './types'

const open = (path = '/plan') => render(<StrictMode><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></StrictMode>)
const saved = (): AppState => parseBackup(localStorage.getItem(STORAGE_KEY)!)
const setup = () => {
  const state = freshState(); state.profile.onboardingComplete = true
  state.workouts = state.workouts.slice(0, 2).map(workout => ({ ...workout, exercises: workout.exercises.slice(0, 1) }))
  state.workouts[0].exercises[0].equipment = ['dumbbells', 'bench']
  state.workouts[1].exercises[0].equipment = []
  state.activeSession = startSession(state.workouts[0]); state.activeSession.runningSince = null
  state.activeSession.sets[0] = { ...state.activeSession.sets[0], reps: 9, weightKg: 22.5, completed: true }
  state.logs = [finishSession({ ...state.activeSession, id: 'previous-completed', elapsedSeconds: 100 })]
  state.planHistory = [{ id: 'previous-plan', label: 'Previous plan', savedAt: new Date().toISOString(), workouts: structuredClone(state.workouts) }]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return state
}
const save = () => fireEvent.click(screen.getByRole('button', { name: /Save workout plan/ }))
const equipmentMode = (mode: string) => fireEvent.change(screen.getByLabelText('Exercise 1 equipment requirements'), { target: { value: mode } })
const retained = (element: HTMLElement, event: string) => {
  const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactProps'))!
  return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key][event]
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('persisted equipment-aware planning', () => {
  it('saves and reloads explicit requirements without saving availability or modifying active/completed history', () => {
    const original = setup(); open()
    fireEvent.click(screen.getByLabelText('Compare with equipment available now'))
    fireEvent.click(within(screen.getByRole('group', { name: 'Temporary available equipment' })).getByLabelText('Dumbbells'))
    fireEvent.click(screen.getByLabelText('Exercise 1 requires Bench')); save()
    const next = saved()
    expect(next.workouts[0].exercises[0].equipment).toEqual(['dumbbells'])
    expect(next.workouts[0].exercises[0].sets).toBe(original.workouts[0].exercises[0].sets)
    expect(next.logs).toEqual(original.logs); expect(next.activeSession).toEqual(original.activeSession)
    expect(next.planHistory[0].workouts).toEqual(original.workouts)
    expect(Object.keys(next)).toEqual(Object.keys(original)); expect(JSON.stringify(next)).not.toContain('available')
    cleanup(); open()
    expect(screen.getByLabelText('Exercise 1 requires Dumbbells')).toBeChecked()
    expect(screen.getByLabelText('Exercise 1 requires Bench')).not.toBeChecked()
    expect(screen.getByLabelText('Compare with equipment available now')).not.toBeChecked()
    fireEvent.click(screen.getByText(/Previous plan versions/))
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore version' })[0])
    expect(saved().workouts).toEqual(original.workouts)
    expect(screen.getByLabelText('Exercise 1 requires Bench')).toBeChecked()
  })
  it('keeps equipment/raw edits after real quota failure and saves exactly those entries on retry', () => {
    const original = setup(); open(); equipmentMode('none')
    fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Draft after equipment change' } })
    const real = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) throw new Error('Storage quota reached')
      return real.call(this, key, value)
    })
    save(); expect(saved()).toEqual(original)
    expect(screen.getByLabelText('Workout title')).toHaveValue('Draft after equipment change')
    expect(screen.getByLabelText('Exercise 1 equipment requirements')).toHaveValue('none')
    expect(readPlanDraft()!.exercises[0].equipment).toEqual([])
    failure.mockRestore(); save()
    expect(saved().workouts[0]).toMatchObject({ title: 'Draft after equipment change', exercises: [expect.objectContaining({ equipment: [] })] })
    expect(readPlanDraft()).toBeNull()
  })
  it('refuses a save when another tab changed storage and keeps the unsaved requirements', () => {
    const original = setup(); open(); equipmentMode('none')
    const newer = structuredClone(original); newer.workouts[0].title = 'Newer plan from another tab'
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newer)); save()
    expect(saved()).toEqual(newer); expect(readPlanDraft()!.exercises[0].equipment).toEqual([])
    expect(screen.getAllByRole('alert').some(element => /another tab|changed/i.test(element.textContent ?? ''))).toBe(true)
  })
  it('retains schedule review after actual storage failure and preserves exercise targets when applied', () => {
    const original = setup(); open('/schedule')
    fireEvent.click(screen.getByLabelText('Compare with equipment available now'))
    fireEvent.click(screen.getByLabelText('Only allow fully equipment-matched sessions'))
    fireEvent.click(screen.getByLabelText('Monday'))
    expect(screen.getByLabelText('Session for Monday')).toHaveValue(original.workouts[1].id)
    fireEvent.click(screen.getByRole('button', { name: 'Preview weekly schedule' }))
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    fireEvent.click(screen.getByRole('button', { name: 'Apply this schedule' }))
    expect(saved()).toEqual(original); expect(screen.getByRole('heading', { name: 'Review your schedule' })).toBeInTheDocument()
    failure.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Apply this schedule' }))
    const next = saved(); expect(next.workouts).toHaveLength(1); expect(next.workouts[0].exercises).toEqual(original.workouts[1].exercises)
    expect(next.logs).toEqual(original.logs); expect(next.activeSession).toEqual(original.activeSession)
    expect(screen.getByLabelText('Compare with equipment available now')).not.toBeChecked()
  })
  it('imports an equipment backup without reviving pre-import draft handlers', async () => {
    setup(); const view = open(); equipmentMode('none')
    const oldSubmit = retained(screen.getByLabelText('Workout title').closest('form')!, 'onSubmit')
    const restored = saved(); restored.workouts[0].exercises[0].equipment = ['kettlebell']; restored.workouts[0].title = 'Restored equipment plan'
    fireEvent.click(screen.getAllByRole('link', { name: 'Profile' })[0])
    const file = new File([JSON.stringify(restored)], 'equipment-backup.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(JSON.stringify(restored)) })
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText('Backup imported')).toBeInTheDocument())
    act(() => oldSubmit({ preventDefault() {} })); expect(saved()).toEqual(restored)
    fireEvent.click(screen.getAllByRole('link', { name: 'Plan' })[0])
    expect(screen.getByLabelText('Workout title')).toHaveValue('Restored equipment plan')
    expect(screen.getByLabelText('Exercise 1 requires Kettlebell')).toBeChecked()
    expect(screen.getByLabelText('Compare with equipment available now')).not.toBeChecked()
  })
  it('reviews a recovered older draft before applying over a newer saved plan, preserving cancel/failure/retry', () => {
    const original = setup(); open(); equipmentMode('none')
    fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Recovered draft title' } })
    cleanup()
    const newer = structuredClone(original); newer.workouts[0].title = 'Newer saved workout'; newer.workouts[0].exercises[0].equipment = ['kettlebell']
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newer)); open()
    expect(screen.getByText(/This recovered draft differs/)).toHaveTextContent('Newer saved workout')
    vi.mocked(window.confirm).mockReturnValue(false); save()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('currently saved “Newer saved workout”'))
    expect(saved()).toEqual(newer); expect(readPlanDraft()!.title).toBe('Recovered draft title')
    vi.mocked(window.confirm).mockReturnValue(true)
    const real = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) throw new Error('Storage full')
      return real.call(this, key, value)
    })
    save(); expect(saved()).toEqual(newer); expect(screen.getByText(/This recovered draft differs/)).toBeInTheDocument()
    failure.mockRestore(); vi.mocked(window.confirm).mockClear(); save()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Saved data may have changed'))
    expect(saved().workouts[0]).toMatchObject({ title: 'Recovered draft title', exercises: [expect.objectContaining({ equipment: [] })] })
    expect(saved().planHistory[0].workouts).toEqual(newer.workouts)
    expect(screen.queryByText(/This recovered draft differs/)).not.toBeInTheDocument(); expect(readPlanDraft()).toBeNull()
    vi.mocked(window.confirm).mockClear(); save(); expect(window.confirm).not.toHaveBeenCalled()
  })
  it.each(['renamed', 'recovered'])('names the saved removal target for a %s draft and preserves cancel/failure', kind => {
    const original = setup(); open(); equipmentMode('none')
    fireEvent.change(screen.getByLabelText('Workout title'), { target: { value: 'Draft-only title' } })
    if (kind === 'recovered') {
      cleanup()
      const newer = structuredClone(original); newer.workouts[0].title = 'Newer saved workout'
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newer)); open()
    }
    const before = saved()
    const remove = () => fireEvent.click(screen.getByRole('button', { name: 'Remove workout from plan' }))
    vi.mocked(window.confirm).mockReturnValue(false); remove()
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining(`saved workout “${before.workouts[0].title}”`))
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('draft for this workout will be discarded only if removal is saved successfully'))
    expect(window.confirm).not.toHaveBeenLastCalledWith(expect.stringContaining('Draft-only title'))
    expect(saved()).toEqual(before); expect(readPlanDraft()!.title).toBe('Draft-only title')
    vi.mocked(window.confirm).mockReturnValue(true)
    const real = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) throw new Error('Storage full')
      return real.call(this, key, value)
    })
    remove(); expect(saved()).toEqual(before); expect(readPlanDraft()!.title).toBe('Draft-only title')
    expect(screen.getByLabelText('Workout title')).toHaveValue('Draft-only title')
    failure.mockRestore(); remove()
    expect(saved().workouts).toEqual(before.workouts.slice(1))
    expect(saved().planHistory[0]).toMatchObject({ label: `Before removing ${before.workouts[0].title}`, workouts: before.workouts })
    expect(saved().activeSession).toEqual(before.activeSession); expect(saved().logs).toEqual(before.logs)
    expect(readPlanDraft()).toBeNull(); expect(screen.getByLabelText('Workout title')).toHaveValue(before.workouts[1].title)
  })
  it('shows the selected metadata during replacement without changing replacement semantics', () => {
    const original = setup(); open(`/workouts/${original.workouts[0].id}`)
    fireEvent.click(screen.getByRole('button', { name: 'Replace unfinished Bench Press sets' }))
    const choice = screen.getAllByRole('button', { name: 'Choose Back Squat' }).map(button => button.closest('li')!).find(row => within(row).queryByText('Equipment: No equipment'))!
    expect(within(choice).getByText('Equipment: No equipment')).toBeInTheDocument()
    fireEvent.click(within(choice).getByRole('button', { name: 'Choose Back Squat' }))
    expect(within(screen.getByRole('region', { name: 'Session exercise replacement' })).getByText('Equipment: No equipment')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Confirm replacement and reset/ }))
    const next = saved()
    expect(next.activeSession!.workout.exercises.find(exercise => exercise.name === 'Back Squat')!.equipment).toEqual([])
    expect(next.activeSession!.sets.find(set => set.id === original.activeSession!.sets[0].id)).toEqual(original.activeSession!.sets[0])
    expect(next.workouts).toEqual(original.workouts); expect(next.logs).toEqual(original.logs)
  })
})
