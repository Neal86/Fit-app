import { initialState } from './data'
import type { AppState } from './types'
import { parseState } from './stateValidation'
export { parseState } from './stateValidation'

// Keep the existing key so upgrading does not strand version 2 data.
export const STORAGE_KEY = 'fit-app-state-v2'
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024
export const freshState = (): AppState => structuredClone(initialState)
export function parseBackup(source: string): AppState {
  if (new Blob([source]).size > MAX_BACKUP_BYTES) throw new Error('Backup is too large (maximum 10 MB).')
  try { return parseState(JSON.parse(source)) } catch (error) { throw new Error(error instanceof SyntaxError ? 'This file is not valid JSON.' : error instanceof Error ? error.message : 'Invalid backup.') }
}
export function loadState(): { state: AppState; error: string; raw: string | null } {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
    return { state: raw ? parseBackup(raw) : freshState(), error: '', raw }
  } catch (error) {
    return { state: freshState(), raw, error: error instanceof Error ? error.message : 'Cannot access saved data.' }
  }
}
export class StorageConflictError extends Error {
  constructor() { super('Saved data changed in another browser tab. These edits were not saved. Reload this tab before making further changes.'); this.name = 'StorageConflictError' }
}
export function saveState(state: AppState, expectedRaw?: string | null): string {
  // Validate before touching existing user data, including programmatic callers.
  parseState(state)
  const serialized = JSON.stringify(state)
  if (expectedRaw !== undefined && localStorage.getItem(STORAGE_KEY) !== expectedRaw) throw new StorageConflictError()
  localStorage.setItem(STORAGE_KEY, serialized)
  return serialized
}
export function downloadText(source: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url; link.download = filename; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
