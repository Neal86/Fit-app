// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { downloadText, freshState, loadState, MAX_BACKUP_BYTES, parseBackup } from './storage'
import { startSession } from './session'
import type { AppState } from './types'

vi.mock('./storage', async importOriginal => ({ ...await importOriginal<typeof import('./storage')>(), downloadText: vi.fn(), loadState: vi.fn() }))
const open = (state: AppState) => { vi.mocked(loadState).mockReturnValue({ state, error: '', raw: JSON.stringify(state) }); return render(<MemoryRouter initialEntries={['/profile']}><App /></MemoryRouter>) }
const ready = () => { const state = freshState(); state.profile.onboardingComplete = true; return state }
const exactLimit = (state: AppState) => {
  state.logs = Array.from({ length: 5000 }, (_, index) => ({ id: `log-${index}`, workoutId: state.workouts[0].id, title: 'Saved workout', startedAt: '2025-01-01T00:00:00.000Z', completedAt: '2025-01-01T00:01:00.000Z', duration: 1, calories: 0, completedExerciseIds: [], notes: '' }))
  let remaining = MAX_BACKUP_BYTES - new Blob([JSON.stringify(state)]).size
  for (const log of state.logs) { const count = Math.min(2000, remaining); log.notes = 'x'.repeat(count); remaining -= count }
  expect(remaining).toBe(0); expect(new Blob([JSON.stringify(state)]).size).toBe(MAX_BACKUP_BYTES); parseBackup(JSON.stringify(state)); return state
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.mocked(downloadText).mockClear() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('backup exports accepted by the same reader', { timeout: 20000 }, () => {
  it('exports compact full-library JSON at the exact import byte limit', () => {
    const state = ready(); state.exerciseLibrary = { version: 1, entries: [{ id: 'manual-identity', revision: 1, status: 'active', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', exercise: { name: 'My movement', category: '', sets: 2, reps: '8', restSeconds: 40 } }] }
    exactLimit(state); const before = JSON.stringify(state); open(state); fireEvent.click(screen.getByRole('button', { name: 'Export backup' }))
    expect(downloadText).toHaveBeenCalledOnce(); const source = vi.mocked(downloadText).mock.calls[0][0]; expect(source).toBe(before); expect(parseBackup(source)).toEqual(state); expect(JSON.stringify(state)).toBe(before)
  })
  it('rejects an oversized paused snapshot before download and leaves the original untouched', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const state = ready(); state.activeSession = startSession(state.workouts[0], 0); exactLimit(state); const before = JSON.stringify(state); open(state)
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }))
    expect(downloadText).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('Backup was not exported. Backup is too large'); expect(JSON.stringify(state)).toBe(before)
  })
  it('rejects an invalid elapsed snapshot before download and keeps the running session', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const state = ready(); state.activeSession = startSession(state.workouts[0], 0); const before = JSON.stringify(state); open(state)
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }))
    expect(downloadText).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('Backup was not exported'); expect(JSON.stringify(state)).toBe(before)
  })
})
