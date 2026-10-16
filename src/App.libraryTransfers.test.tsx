// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { freshState, parseBackup, STORAGE_KEY } from './storage'
import type { AppState } from './types'

const stamp = '2026-10-15T12:00:00.000Z'
function withLibrary(): AppState {
  const state = freshState(); state.profile.onboardingComplete = true
  state.exerciseLibrary = { version: 1, entries: ['active', 'archived'].map((status, index) => ({ id: `transfer-entry-${index}`, revision: index + 1, status: status as 'active' | 'archived', createdAt: stamp, updatedAt: stamp, exercise: { name: `Synthetic entry ${index}`, sets: 2, reps: '8', restSeconds: 30, category: 'Manual', notes: 'Private synthetic note' } })) }
  state.workouts[0].exercises[0].libraryOrigin = { version: 1, entryId: state.exerciseLibrary.entries[0].id, revision: 1 }
  return state
}
function mount(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  return render(<MemoryRouter initialEntries={['/profile']}><App /></MemoryRouter>)
}
function fileFor(state: AppState) {
  const text = JSON.stringify(state), file = new File([text], 'synthetic-backup.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: async () => text })
  return file
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(false) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('discloses active and archived library replacement before import and preserves bytes on refusal', async () => {
  const before = withLibrary(), view = mount(before), raw = localStorage.getItem(STORAGE_KEY)
  const incoming = withLibrary(); incoming.exerciseLibrary!.entries[0].exercise.name = 'Different imported manual entry'; incoming.exerciseLibrary!.entries[0].revision = 2
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')!
  fireEvent.change(input, { target: { files: [fileFor(incoming)] } })
  await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/1 active and 1 archived personal library entries/)))
  expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  vi.mocked(window.confirm).mockReturnValue(true)
  fireEvent.change(input, { target: { files: [fileFor(incoming)] } })
  await waitFor(() => expect(parseBackup(localStorage.getItem(STORAGE_KEY)!)).toEqual(incoming))
  expect(parseBackup(localStorage.getItem(STORAGE_KEY)!).workouts[0].exercises[0].libraryOrigin?.revision).toBe(1)
})

it('names the complete personal library before reset and does nothing when reset is declined', () => {
  const state = withLibrary(); mount(state); const raw = localStorage.getItem(STORAGE_KEY)
  expect(screen.getByText(/Backups include active and archived personal library entries/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reset app' }))
  expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/including active and archived personal library entries/))
  expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
})
